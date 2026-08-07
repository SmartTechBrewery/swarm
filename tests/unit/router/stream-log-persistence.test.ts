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

const { persistStreamLog } = await import('@/router/stream-log-persistence.js');

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
		persistStreamLog(frame(runId, 'Tool started: Bash', 'Tool completed: Bash'));
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

		persistStreamLog(frame(runId, 'first'));
		persistStreamLog(frame(runId, 'second'));
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

		persistStreamLog(frame(blocked, 'stuck'));
		persistStreamLog(frame(other, 'free'));
		await settle();

		expect(appendRunOutputEvents).toHaveBeenCalledTimes(2);
		expect(appendRunOutputEvents.mock.calls[1]?.[0]).toBe(other);
	});

	it('skips a frame with no run id — there is no run row to attach output to', async () => {
		persistStreamLog(frame(undefined, 'orphan'));
		await settle();

		expect(appendRunOutputEvents).not.toHaveBeenCalled();
	});

	it('swallows a failed write and keeps persisting the next batch for that run', async () => {
		const runId = nextRunId();
		appendRunOutputEvents.mockRejectedValueOnce(new Error('db down'));

		persistStreamLog(frame(runId, 'lost'));
		await settle();
		persistStreamLog(frame(runId, 'kept'));
		await settle();

		expect(appendRunOutputEvents).toHaveBeenCalledTimes(2);
		expect(appendRunOutputEvents.mock.calls[1]?.[1][0]?.content).toBe('kept\n');
	});

	it('falls back to a usable instant when the wire timestamp is unparseable', async () => {
		const runId = nextRunId();
		persistStreamLog({
			type: 'stream-log',
			dispatchId: DISPATCH,
			runId,
			lines: [{ stream: 'stderr', content: 'a warning\n', emittedAt: 'not-a-date' }],
		});
		await settle();

		const [, events] = appendRunOutputEvents.mock.calls[0] ?? [];
		expect(events?.[0]?.emittedAt).toBeInstanceOf(Date);
		expect(Number.isNaN(events?.[0]?.emittedAt.getTime())).toBe(false);
	});
});
