import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamLog } from '@/transport/protocol.js';

// The repository is mocked at the module boundary (ai/TESTING.md) so the rows
// this sink writes can be asserted without a Postgres connection.
const appendRunOutputEvents =
	vi.fn<
		(
			runId: string,
			events: Array<{ stream: string; content: string; emittedAt: Date }>,
		) => Promise<void>
	>();
vi.mock('@/db/repositories/runsRepository.js', () => ({
	appendRunOutputEvents: (runId: string, events: never) => appendRunOutputEvents(runId, events),
	MAX_RUN_OUTPUT_BYTES: 5_000_000,
}));

const { persistControlPlaneNote, persistStreamLog, TRANSPORT_LOST_NOTE, TRANSPORT_RESTORED_NOTE } =
	await import('@/router/stream-log-persistence.js');

const DISPATCH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

let runSeq = 0;
/** A fresh run id per test, so no test inherits another's append chain. */
function nextRunId(): string {
	runSeq += 1;
	return `55555555-5555-4555-8555-${String(runSeq).padStart(12, '0')}`;
}

function frame(runId: string | undefined, ...lines: string[]): StreamLog {
	return {
		type: 'stream-log',
		dispatchId: DISPATCH,
		runId,
		lines: lines.map((content) => ({
			stream: 'stdout' as const,
			content: `${content}\n`,
			emittedAt: '2026-07-24T10:00:00.000Z',
		})) as StreamLog['lines'],
	};
}

/** Let the fire-and-forget chain settle before asserting on it. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
	appendRunOutputEvents.mockReset();
	appendRunOutputEvents.mockResolvedValue(undefined);
});

describe('persistStreamLog', () => {
	it('appends every line of a batch, with the wire instant as a Date', async () => {
		const runId = nextRunId();
		persistStreamLog(frame(runId, 'Tool started: Bash', 'Tool completed: Bash'), runId);
		await settle();

		expect(appendRunOutputEvents).toHaveBeenCalledWith(runId, [
			{
				stream: 'stdout',
				content: 'Tool started: Bash\n',
				emittedAt: new Date('2026-07-24T10:00:00.000Z'),
			},
			{
				stream: 'stdout',
				content: 'Tool completed: Bash\n',
				emittedAt: new Date('2026-07-24T10:00:00.000Z'),
			},
		]);
	});

	it('serializes two batches for one run, so their rows cannot interleave', async () => {
		const runId = nextRunId();
		let releaseFirst: (() => void) | undefined;
		appendRunOutputEvents.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					releaseFirst = () => resolve();
				}),
		);

		persistStreamLog(frame(runId, 'first'), runId);
		persistStreamLog(frame(runId, 'second'), runId);
		await settle();

		// The second batch waits on the first — the whole point of the per-run chain.
		expect(appendRunOutputEvents).toHaveBeenCalledTimes(1);
		releaseFirst?.();
		await settle();
		expect(appendRunOutputEvents).toHaveBeenCalledTimes(2);
		expect(appendRunOutputEvents.mock.calls.map(([, events]) => events[0]?.content)).toEqual([
			'first\n',
			'second\n',
		]);
	});

	it('runs two different runs independently rather than behind one another', async () => {
		const blocked = nextRunId();
		const other = nextRunId();
		appendRunOutputEvents.mockImplementationOnce(() => new Promise<void>(() => {}));

		persistStreamLog(frame(blocked, 'stuck'), blocked);
		persistStreamLog(frame(other, 'free'), other);
		await settle();

		expect(appendRunOutputEvents).toHaveBeenCalledTimes(2);
		expect(appendRunOutputEvents.mock.calls[1]?.[0]).toBe(other);
	});

	it('skips a frame with no run id — there is no run row to attach output to', async () => {
		persistStreamLog(frame(undefined, 'orphan'), undefined);
		await settle();

		expect(appendRunOutputEvents).not.toHaveBeenCalled();
	});

	it('swallows a failed write and keeps persisting the next batch for that run', async () => {
		const runId = nextRunId();
		appendRunOutputEvents.mockRejectedValueOnce(new Error('db down'));

		persistStreamLog(frame(runId, 'lost'), runId);
		await settle();
		persistStreamLog(frame(runId, 'kept'), runId);
		await settle();

		expect(appendRunOutputEvents).toHaveBeenCalledTimes(2);
		expect(appendRunOutputEvents.mock.calls[1]?.[1][0]?.content).toBe('kept\n');
	});

	it('falls back to a usable instant when the wire timestamp is unparseable', async () => {
		const runId = nextRunId();
		persistStreamLog(
			{
				type: 'stream-log',
				dispatchId: DISPATCH,
				runId,
				lines: [{ stream: 'stderr', content: 'a warning\n', emittedAt: 'not-a-date' }],
			},
			runId,
		);
		await settle();

		const [, events] = appendRunOutputEvents.mock.calls[0] ?? [];
		expect(events?.[0]?.emittedAt).toBeInstanceOf(Date);
		expect(Number.isNaN(events?.[0]?.emittedAt.getTime())).toBe(false);
	});
});

/**
 * The control plane's own line in a run's output (issue #723). It annotates the gap
 * it cannot fill — output is still not replayed — so what has to hold is that the
 * note reaches the reader, in the right place relative to the real output, without
 * the socket handler that observed the disconnect ever waiting on Postgres.
 */
describe('persistControlPlaneNote', () => {
	it('appends exactly one stderr line for the run', async () => {
		const runId = nextRunId();

		persistControlPlaneNote(runId, TRANSPORT_LOST_NOTE);
		await settle();

		expect(appendRunOutputEvents).toHaveBeenCalledTimes(1);
		const [id, events] = appendRunOutputEvents.mock.calls[0] ?? [];
		expect(id).toBe(runId);
		expect(events).toHaveLength(1);
		expect(events?.[0]?.stream).toBe('stderr');
		// Newline-terminated like every streamed line, so it renders as its own line.
		expect(events?.[0]?.content).toBe(`${TRANSPORT_LOST_NOTE}\n`);
		expect(events?.[0]?.emittedAt).toBeInstanceOf(Date);
	});

	// The ordering half of the AC: a note goes on the *same* per-run chain the
	// streamed batches use, so it cannot land in the middle of a batch it did not
	// interrupt.
	it('queues behind an in-flight batch rather than racing it', async () => {
		const runId = nextRunId();
		let releaseBatch: (() => void) | undefined;
		appendRunOutputEvents.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					releaseBatch = () => resolve();
				}),
		);

		persistStreamLog(frame(runId, 'still working'), runId);
		persistControlPlaneNote(runId, TRANSPORT_LOST_NOTE);
		await settle();

		expect(appendRunOutputEvents).toHaveBeenCalledTimes(1);
		releaseBatch?.();
		await settle();
		expect(appendRunOutputEvents).toHaveBeenCalledTimes(2);
		expect(appendRunOutputEvents.mock.calls.map(([, events]) => events[0]?.content)).toEqual([
			'still working\n',
			`${TRANSPORT_LOST_NOTE}\n`,
		]);
	});

	it('is a no-op for a dispatch with no run row', async () => {
		persistControlPlaneNote(undefined, TRANSPORT_RESTORED_NOTE);
		await settle();

		expect(appendRunOutputEvents).not.toHaveBeenCalled();
	});

	it('swallows a failed write — a missing note must not take the socket down', async () => {
		const runId = nextRunId();
		appendRunOutputEvents.mockRejectedValueOnce(new Error('db down'));

		expect(() => persistControlPlaneNote(runId, TRANSPORT_LOST_NOTE)).not.toThrow();
		await settle();
		persistStreamLog(frame(runId, 'kept'), runId);
		await settle();

		expect(appendRunOutputEvents).toHaveBeenCalledTimes(2);
		expect(appendRunOutputEvents.mock.calls[1]?.[1][0]?.content).toBe('kept\n');
	});
});
