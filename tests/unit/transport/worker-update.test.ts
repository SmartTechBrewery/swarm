import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerUpdate } from '@/transport/protocol.js';
import {
	createWorkerUpdateHandler,
	SELF_UPDATE_ENV,
	selfUpdateEnabled,
	type WorkerUpdateHandlerOptions,
	type WorkerUpdateReport,
} from '@/transport/worker-update.js';
import type { UpdateOutcome } from '@/worker/self-update.js';

/**
 * The daemon side of worker self-update (issue #933): who may act, when, and what
 * is reported.
 *
 * Every one of these drives {@link createWorkerUpdateHandler} with the real
 * mechanism (`applyUpdateTarget`) and the real POST replaced, because both are
 * already covered where they live — phase 1's own suite for the install root, the
 * delivery-client suite for the wire. What is under test here is the decision
 * layer between them, which is the whole of this module: the opt-in, the wait, the
 * exit, and the promise that *every* outcome is reported.
 */

const REQUEST_ID = '66666666-6666-4666-8666-666666666666';

const UPDATE: WorkerUpdate = { type: 'worker-update', requestId: REQUEST_ID, target: 'main' };

const APPLIED: UpdateOutcome = {
	status: 'applied',
	commit: 'abc1234',
	previousCommit: 'def5678',
};

function silentLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface Harness {
	handle: (update: WorkerUpdate) => void;
	apply: ReturnType<typeof vi.fn>;
	report: ReturnType<typeof vi.fn>;
	exit: ReturnType<typeof vi.fn>;
	shutdown: ReturnType<typeof vi.fn>;
	inFlight: Set<string>;
	shutdownSignal: AbortController;
	logger: ReturnType<typeof silentLogger>;
	/** The one report this handler sent, or `undefined` when it sent none. */
	reported: () => WorkerUpdateReport | undefined;
}

function harness(overrides: Partial<WorkerUpdateHandlerOptions> = {}): Harness {
	// Each collaborator is the override when one is given, so the assertions below
	// always read the function the handler actually called.
	const apply = (overrides.apply ??
		vi.fn<(target: string) => Promise<UpdateOutcome>>().mockResolvedValue(APPLIED)) as ReturnType<
		typeof vi.fn
	>;
	const report = (overrides.report ?? vi.fn().mockResolvedValue({ recorded: true })) as ReturnType<
		typeof vi.fn
	>;
	const exit = (overrides.exit ?? vi.fn()) as ReturnType<typeof vi.fn>;
	const shutdown = (overrides.shutdown ?? vi.fn().mockResolvedValue(undefined)) as ReturnType<
		typeof vi.fn
	>;
	const inFlight = new Set<string>();
	const shutdownSignal = new AbortController();
	const logger = silentLogger();
	const handle = createWorkerUpdateHandler({
		controlPlaneUrl: 'https://swarm.example',
		workerCredential: 'worker-credential',
		inFlight,
		shutdownSignal: shutdownSignal.signal,
		// Opted in unless a case says otherwise, so the default harness exercises the
		// path that actually does something.
		enabled: true,
		idlePollIntervalMs: 10,
		logger,
		...overrides,
		apply,
		report,
		exit,
		shutdown,
	});
	return {
		handle,
		apply,
		report,
		exit,
		shutdown,
		inFlight,
		shutdownSignal,
		logger,
		reported: () => report.mock.calls[0]?.[0] as WorkerUpdateReport | undefined,
	};
}

/** Let the fired-and-forgotten handler run to completion. */
async function settle(): Promise<void> {
	for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

beforeEach(() => {
	vi.useRealTimers();
});

describe('selfUpdateEnabled', () => {
	// Only the literal `true`, like `SWARM_SINGLE_USER_MODE`: opting a machine's
	// install root into being rewritten must be an explicit act.
	it.each([
		[undefined, false],
		['', false],
		['false', false],
		['1', false],
		['TRUE', false],
		['yes', false],
		['true', true],
	])('reads %s as %s', (raw, expected) => {
		expect(selfUpdateEnabled(raw)).toBe(expected);
	});

	it('names the env var it reads', () => {
		expect(SELF_UPDATE_ENV).toBe('SWARM_WORKER_SELF_UPDATE');
	});
});

describe('createWorkerUpdateHandler — the opt-in', () => {
	it('declines and never touches the install root when the machine has not opted in', async () => {
		const h = harness({ enabled: false });

		h.handle(UPDATE);
		await settle();

		expect(h.apply).not.toHaveBeenCalled();
		expect(h.exit).not.toHaveBeenCalled();
		expect(h.reported()).toMatchObject({
			requestId: REQUEST_ID,
			target: 'main',
			status: 'declined',
		});
	});

	// A declined machine is left working, so the operator has to be told *why* —
	// otherwise the only symptom is a build that never moves.
	it('names the flag to set in the declined report', async () => {
		const h = harness({ enabled: false });

		h.handle(UPDATE);
		await settle();

		expect(h.reported()?.message).toContain('SWARM_WORKER_SELF_UPDATE=true');
	});

	it('falls back to the process environment when the caller states nothing', async () => {
		const previous = process.env[SELF_UPDATE_ENV];
		process.env[SELF_UPDATE_ENV] = 'false';
		try {
			const h = harness({ enabled: undefined });

			h.handle(UPDATE);
			await settle();

			expect(h.apply).not.toHaveBeenCalled();
			expect(h.reported()?.status).toBe('declined');
		} finally {
			if (previous === undefined) delete process.env[SELF_UPDATE_ENV];
			else process.env[SELF_UPDATE_ENV] = previous;
		}
	});
});

describe('createWorkerUpdateHandler — waiting for the machine to go idle', () => {
	it('applies immediately when nothing is in flight', async () => {
		const h = harness();

		h.handle(UPDATE);
		await settle();

		expect(h.apply).toHaveBeenCalledWith('main');
	});

	// The promise the whole feature rests on: an update disturbs no run. It waits for
	// the phase to finish rather than cancelling, deferring, or failing it.
	it('waits for an in-flight phase instead of disturbing it', async () => {
		vi.useFakeTimers();
		const h = harness();
		h.inFlight.add('dispatch-1');

		h.handle(UPDATE);
		await vi.advanceTimersByTimeAsync(100);
		expect(h.apply).not.toHaveBeenCalled();
		// Nothing was removed from the set on its behalf — the executor owns it.
		expect(h.inFlight.has('dispatch-1')).toBe(true);

		h.inFlight.delete('dispatch-1');
		await vi.advanceTimersByTimeAsync(50);

		expect(h.apply).toHaveBeenCalledWith('main');
		vi.useRealTimers();
	});

	// A shutdown abandons the attempt *silently*: the request is durable on the
	// `workers` row, so reporting a refusal nobody asked for would leave an operator
	// reading a verdict for a machine that merely restarted.
	it('abandons the wait on shutdown, reporting nothing', async () => {
		vi.useFakeTimers();
		const h = harness();
		h.inFlight.add('dispatch-1');

		h.handle(UPDATE);
		await vi.advanceTimersByTimeAsync(50);
		h.shutdownSignal.abort();
		await vi.advanceTimersByTimeAsync(50);

		expect(h.apply).not.toHaveBeenCalled();
		expect(h.report).not.toHaveBeenCalled();
		expect(h.exit).not.toHaveBeenCalled();
		vi.useRealTimers();
	});

	// The re-check after the loop: a shutdown landing as the last phase settles must
	// not start an update the process is already leaving.
	it('does not start an update when shutdown arrives with the machine already idle', async () => {
		const h = harness();
		h.shutdownSignal.abort();

		h.handle(UPDATE);
		await settle();

		expect(h.apply).not.toHaveBeenCalled();
		expect(h.report).not.toHaveBeenCalled();
	});
});

describe('createWorkerUpdateHandler — restarting, or not', () => {
	it('reports and then releases the session and exits 0 on applied', async () => {
		const h = harness();

		h.handle(UPDATE);
		await settle();

		expect(h.reported()).toMatchObject({ status: 'applied', target: 'main' });
		expect(h.shutdown).toHaveBeenCalledTimes(1);
		expect(h.exit).toHaveBeenCalledWith(0);
		// Reported before the process is ended, so the control plane hears the outcome
		// rather than inferring it from the next handshake.
		expect(h.report.mock.invocationCallOrder[0]).toBeLessThan(
			h.exit.mock.invocationCallOrder[0] as number,
		);
	});

	// A machine already on the requested build has nothing to restart into, and one
	// that refused or failed is still running the code it was: in every case it keeps
	// taking work.
	it.each([
		[
			'already-current',
			{ status: 'already-current', commit: 'abc1234' } satisfies UpdateOutcome,
			'already-current',
		],
		[
			'refused',
			{ status: 'refused', reason: 'the install root has uncommitted changes' } as UpdateOutcome,
			'refused',
		],
		[
			'failed',
			{
				status: 'failed',
				stage: 'build',
				reason: "'npm run build' failed in the SWARM install root",
				rolledBack: true,
				previousCommit: 'def5678',
				outputTail: 'TS2304: Cannot find name',
			} satisfies UpdateOutcome,
			'failed',
		],
	])('reports %s and keeps the daemon running', async (_name, outcome, status) => {
		const h = harness({ apply: vi.fn().mockResolvedValue(outcome) });

		h.handle(UPDATE);
		await settle();

		expect(h.reported()?.status).toBe(status);
		expect(h.exit).not.toHaveBeenCalled();
		expect(h.shutdown).not.toHaveBeenCalled();
	});

	it("carries the mechanism's own words, including a failed step's output tail", async () => {
		const h = harness({
			apply: vi.fn().mockResolvedValue({
				status: 'failed',
				stage: 'install',
				reason: "'npm ci' failed in the SWARM install root '/srv/swarm'.",
				rolledBack: false,
				previousCommit: 'def5678',
				outputTail: 'npm ERR! code ERESOLVE',
			} satisfies UpdateOutcome),
		});

		h.handle(UPDATE);
		await settle();

		expect(h.reported()?.message).toContain("'npm ci' failed");
		expect(h.reported()?.message).toContain('npm ERR! code ERESOLVE');
	});

	// An install root that has already moved must restart into it whether or not the
	// control plane heard about it — the alternative is a daemon running code that no
	// longer matches the files under it.
	it('still restarts when the report could not be delivered', async () => {
		const h = harness({ report: vi.fn().mockRejectedValue(new Error('control plane is down')) });

		h.handle(UPDATE);
		await settle();

		expect(h.exit).toHaveBeenCalledWith(0);
	});

	it('exits even when releasing the session fails', async () => {
		const h = harness({ shutdown: vi.fn().mockRejectedValue(new Error('socket already gone')) });

		h.handle(UPDATE);
		await settle();

		expect(h.exit).toHaveBeenCalledWith(0);
	});

	// `applyUpdateTarget` is contracted never to throw, so this can only be a bug —
	// and a bug there must not take the daemon down through an unhandled rejection.
	it('reports a thrown apply as a failure rather than crashing', async () => {
		const h = harness({ apply: vi.fn().mockRejectedValue(new Error('spawn ENOMEM')) });

		h.handle(UPDATE);
		await settle();

		expect(h.reported()?.status).toBe('failed');
		expect(h.reported()?.message).toContain('spawn ENOMEM');
		expect(h.exit).not.toHaveBeenCalled();
	});
});

describe('createWorkerUpdateHandler — repeats', () => {
	// The reconnect re-push is the ordinary case, not an edge: the control plane
	// states a pending request again every time the machine's socket opens.
	it('ignores a re-push of the request it already handled', async () => {
		const h = harness({ apply: vi.fn().mockResolvedValue({ status: 'refused', reason: 'no' }) });

		h.handle(UPDATE);
		await settle();
		h.handle(UPDATE);
		await settle();

		expect(h.apply).toHaveBeenCalledTimes(1);
		expect(h.report).toHaveBeenCalledTimes(1);
	});

	// Two `applyUpdateTarget` calls on one install root would interleave a checkout
	// with a build, so a second request waits for the next connection instead.
	it('ignores a different request while one is being applied', async () => {
		vi.useFakeTimers();
		const h = harness();
		h.inFlight.add('dispatch-1');

		h.handle(UPDATE);
		await vi.advanceTimersByTimeAsync(20);
		h.handle({ ...UPDATE, requestId: '77777777-7777-4777-8777-777777777777', target: 'v2' });
		await vi.advanceTimersByTimeAsync(20);

		h.inFlight.delete('dispatch-1');
		await vi.advanceTimersByTimeAsync(50);

		expect(h.apply).toHaveBeenCalledTimes(1);
		expect(h.apply).toHaveBeenCalledWith('main');
		vi.useRealTimers();
	});
});

describe('createWorkerUpdateHandler — the target', () => {
	// The frame's schema already refuses this, so it is defence at a second seam:
	// the value is about to be handed to `git` on an unattended machine.
	it('refuses a target that is not a well-formed ref without running anything', async () => {
		const h = harness();

		h.handle({ ...UPDATE, target: 'main; rm -rf /' } as WorkerUpdate);
		await settle();

		expect(h.apply).not.toHaveBeenCalled();
		expect(h.reported()?.status).toBe('refused');
		expect(h.exit).not.toHaveBeenCalled();
	});
});
