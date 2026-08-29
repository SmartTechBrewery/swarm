import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentRunError } from '@/harness/agent-failure.js';
import { logger } from '@/lib/logger.js';
import { DependencyBlockedError } from '@/pipeline/dependency-guard.js';
import { RUN_CANCELLED_MESSAGE } from '@/queue/cancellation.js';
import {
	awaitDispatchResult,
	failDispatchResultWait,
	type TransportInterruptions,
} from '@/router/dispatch-results.js';
import { adaptResultToPhaseRun, awaitResultWithGuards } from '@/router/dispatcher.js';
import { DeliveryDeferredError } from '@/scm/delivery.js';
import { buildTaskAssignment } from '@/transport/assignment.js';
import { deferrableOrFailedResult } from '@/transport/assignment-execution.js';
import type { TaskExecutionResult } from '@/transport/protocol.js';
import type { DispatchSelection } from '@/worker/eligibility-gate.js';
import { RunTerminatedError } from '@/worker/run-cancellation.js';
import { createMockTaskAssignmentInput, createMockWorkItem } from '../../helpers/factories.js';

const SELECTION: DispatchSelection = {
	workerId: 'w-1',
	workerName: 'ada-laptop',
	ownerUserId: 'user-1',
	target: { cli: 'claude' },
	targetIndex: 0,
	cli: 'claude',
	skippedClis: [],
};

const DISPATCH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** The still-open prerequisite a `dependency` deferral frame reports. */
const BLOCKER = {
	reference: '#319',
	url: 'https://github.com/SmartTechBrewery/swarm/issues/319',
	title: 'Session auth',
	open: true,
	source: 'dependency' as const,
};

function base(overrides: Partial<TaskExecutionResult>): TaskExecutionResult {
	return {
		type: 'task-execution-result',
		dispatchId: DISPATCH,
		status: 'succeeded',
		phase: 'implementation',
		taskId: '407',
		...overrides,
	} as TaskExecutionResult;
}

describe('adaptResultToPhaseRun', () => {
	it('maps a succeeded result to a PhaseRunResult carrying the settle context', () => {
		const run = adaptResultToPhaseRun(
			base({
				status: 'succeeded',
				exitCode: 0,
				durationMs: 1234,
				movedTo: 'todo',
				verdict: 'approve',
				reviewOrdinal: 1,
				reviewAutomationOutcome: 'manual-intervention-required',
			}),
			SELECTION,
		);
		expect(run.agent).toMatchObject({
			cli: 'claude',
			exitCode: 0,
			durationMs: 1234,
			timedOut: false,
		});
		expect(run.movedTo).toBe('todo');
		expect(run.verdict).toBe('approve');
		expect(run.reviewOrdinal).toBe(1);
		expect(run.automationOutcome).toBe('manual-intervention-required');
	});

	// The frame's enum still accepts the retired `comment` verdict so an older
	// worker's terminal result isn't rejected wholesale — losing the run's outcome
	// over one optional telemetry field — but it must not reach the run record
	// (issue #470). Dropping it changes no behaviour: `comment` never gated merge
	// automation, which is the only thing the verdict feeds.
	it('drops a retired comment verdict reported by an older worker', () => {
		const run = adaptResultToPhaseRun(
			base({ status: 'succeeded', exitCode: 0, verdict: 'comment', reviewOrdinal: 2 }),
			SELECTION,
		);
		expect(run.verdict).toBeUndefined();
		// The rest of the settle context still lands, so the run isn't lost.
		expect(run.reviewOrdinal).toBe(2);
	});

	it('maps the produced PR url so the control plane records the attribution (issue #398)', () => {
		const run = adaptResultToPhaseRun(
			base({ status: 'succeeded', exitCode: 0, prUrl: 'https://github.com/o/r/pull/7' }),
			SELECTION,
		);
		expect(run.prUrl).toBe('https://github.com/o/r/pull/7');
	});

	it('tolerates a result frame from an older worker that reports no produced PR', () => {
		const run = adaptResultToPhaseRun(base({ status: 'succeeded', exitCode: 0 }), SELECTION);
		expect(run.prUrl).toBeUndefined();
	});

	it('throws RunTerminatedError for a cancelled failure (never a deferral)', () => {
		expect(() =>
			adaptResultToPhaseRun(
				base({ status: 'failed', cancelled: true, error: 'Run cancelled by user' }),
				SELECTION,
			),
		).toThrow(RunTerminatedError);
	});

	it('throws a terminal error for a non-cancelled failure', () => {
		expect(() =>
			adaptResultToPhaseRun(base({ status: 'failed', error: 'agent exited 1' }), SELECTION),
		).toThrow('agent exited 1');
	});

	it('settles a superseded worker session terminally, on the reap’s own reason (issue #719)', async () => {
		const REASON =
			"The worker's session was superseded by a newer one while this phase was executing — settled from that signal, not from the lease window";
		// The frame the reap actually produces, not a hand-built one — the two halves of
		// the seam asserted against each other, as the dependency case below does.
		const awaiting = awaitDispatchResult(DISPATCH, {
			workerId: 'w-1',
			runId: 'run-719',
			phase: 'implementation',
			taskId: '719',
		});
		expect(failDispatchResultWait(DISPATCH, REASON)).toBe(true);
		const frame = await awaiting.result;

		try {
			adaptResultToPhaseRun(frame, SELECTION);
			throw new Error('expected a throw');
		} catch (err) {
			expect(err).toBeInstanceOf(AgentRunError);
			const failed = err as AgentRunError;
			// `error`, not one of the deferrable kinds: the reap already wrote the dispatch
			// and run rows terminally, and a deferral would flip that run back to
			// `deferred` with a retry date while the dispatch stayed `failed`.
			expect(failed.failure.kind).toBe('error');
			// The reason is what the run row and the dispatch's `last_error` record, so it
			// must survive the round trip — and must not read as the lease-window timeout.
			expect(failed.message).toBe(REASON);
			expect(failed.message).not.toContain('did not report a result within the lease window');
		}

		awaiting.dispose();
	});

	it('settles the router’s own undeliverable termination as a cancellation (issue #827)', async () => {
		// Again the frame the router actually produces, not a hand-built one: the
		// bounded offline wait ends through `failDispatchResultWait` with
		// `cancelled: true`, which must reach the user-terminated branch rather than
		// the terminal `AgentRunError` the superseded case above maps to.
		const awaiting = awaitDispatchResult(DISPATCH, {
			workerId: 'w-1',
			runId: 'run-827',
			phase: 'planning',
			taskId: '827',
		});
		expect(failDispatchResultWait(DISPATCH, RUN_CANCELLED_MESSAGE, { cancelled: true })).toBe(true);
		const frame = await awaiting.result;

		try {
			adaptResultToPhaseRun(frame, SELECTION);
			throw new Error('expected a throw');
		} catch (err) {
			expect(err).toBeInstanceOf(RunTerminatedError);
			// The neutral wording the run row records for every cancellation (issue #305) —
			// why it settled early is a log line, not the run's message.
			expect((err as Error).message).toBe(RUN_CANCELLED_MESSAGE);
		}

		awaiting.dispose();
	});

	it('rebuilds DependencyBlockedError for a dependency deferral (issue #438)', () => {
		const workItem = createMockWorkItem();
		// The frame the worker actually sends, not a hand-built one — so the two halves of
		// the seam are asserted against each other rather than against a fixture.
		const frame = deferrableOrFailedResult(
			new DependencyBlockedError(workItem, [BLOCKER]),
			buildTaskAssignment(createMockTaskAssignmentInput({ phase: 'implementation' })),
		);
		expect(frame).toMatchObject({ status: 'deferred', failureKind: 'dependency' });

		try {
			adaptResultToPhaseRun(frame, SELECTION, workItem);
			throw new Error('expected a throw');
		} catch (err) {
			expect(err).toBeInstanceOf(DependencyBlockedError);
			const blocked = err as DependencyBlockedError;
			expect(blocked.blockers).toEqual([BLOCKER]);
			// This message is what the board comment carries once the recheck budget runs
			// out, so it must name the prerequisite rather than a generic reason.
			expect(blocked.message).toContain('#319');
			expect(blocked.message).toMatch(/must be done first/i);
		}
	});

	it('keeps a dependency deferral with no blockers terminal (never on the rate-limit budget)', () => {
		try {
			adaptResultToPhaseRun(
				base({ status: 'deferred', failureKind: 'dependency', reason: 'blocked somehow' }),
				SELECTION,
				createMockWorkItem(),
			);
			throw new Error('expected a throw');
		} catch (err) {
			expect(err).not.toBeInstanceOf(DependencyBlockedError);
			expect(err).not.toBeInstanceOf(AgentRunError);
			expect((err as Error).message).toBe('blocked somehow');
		}
	});

	it('keeps a dependency deferral with no work item terminal', () => {
		try {
			adaptResultToPhaseRun(
				base({
					status: 'deferred',
					failureKind: 'dependency',
					reason: 'blocked',
					blockers: [BLOCKER],
				}),
				SELECTION,
			);
			throw new Error('expected a throw');
		} catch (err) {
			expect(err).not.toBeInstanceOf(DependencyBlockedError);
			expect(err).not.toBeInstanceOf(AgentRunError);
			expect((err as Error).message).toBe('blocked');
		}
	});

	it('throws DeliveryDeferredError for a delivery deferral', () => {
		expect(() =>
			adaptResultToPhaseRun(
				base({ status: 'deferred', failureKind: 'delivery', reason: 'push failed' }),
				SELECTION,
			),
		).toThrow(DeliveryDeferredError);
	});

	it('throws an AgentRunError carrying the reported failure kind for a deferral', () => {
		try {
			adaptResultToPhaseRun(
				base({ status: 'deferred', failureKind: 'rate-limit', reason: 'rate limited' }),
				SELECTION,
			);
			throw new Error('expected a throw');
		} catch (err) {
			expect(err).toBeInstanceOf(AgentRunError);
			expect((err as AgentRunError).failure.kind).toBe('rate-limit');
		}
	});

	// Tier 2 across the wire (issue #503). The worker parses the checkpoint on its own
	// host because only it holds that worktree; the wire status stays `deferred`, and the
	// checkpoint rides the rebuilt error so the control plane's shared deferral path
	// applies the identical policy and budget it applies in-process.
	it('carries a reported checkpoint onto the rebuilt AgentRunError', () => {
		const checkpoint = {
			phase: 'implementation' as const,
			completed: ['Wrote the schema'],
			remaining: ['Run the tests'],
			decisions: [],
			workingTree: { modified: ['src/config/schema.ts'], added: [], deleted: [] },
		};

		try {
			adaptResultToPhaseRun(
				base({ status: 'deferred', failureKind: 'rate-limit', reason: 'rate limited', checkpoint }),
				SELECTION,
			);
			throw new Error('expected a throw');
		} catch (err) {
			expect(err).toBeInstanceOf(AgentRunError);
			expect((err as AgentRunError).checkpoint).toEqual(checkpoint);
		}
	});

	it('leaves the checkpoint unset for a deferral frame that reports none', () => {
		try {
			adaptResultToPhaseRun(
				base({ status: 'deferred', failureKind: 'rate-limit', reason: 'rate limited' }),
				SELECTION,
			);
			throw new Error('expected a throw');
		} catch (err) {
			expect((err as AgentRunError).checkpoint).toBeUndefined();
		}
	});

	it('keeps a genuinely-interrupted timeout deferrable (non-zero synthetic exit)', () => {
		try {
			adaptResultToPhaseRun(
				base({ status: 'deferred', failureKind: 'timeout', exitCode: 143 }),
				SELECTION,
			);
			throw new Error('expected a throw');
		} catch (err) {
			expect(err).toBeInstanceOf(AgentRunError);
			const agentErr = err as AgentRunError;
			expect(agentErr.failure.kind).toBe('timeout');
			// A non-zero exit is what keeps a timeout deferrable in `handlePhaseFailure`.
			expect(agentErr.agent?.exitCode).toBe(143);
		}
	});
});

/**
 * The seam asserted against itself (issue #596): the frames come from the worker's own
 * `deferrableOrFailedResult`, not a hand-built fixture, so "the worker sends it" and
 * "the control plane keeps it" are checked against each other rather than a guess.
 */
describe('adaptResultToPhaseRun exit metadata', () => {
	const ASSIGNMENT = () =>
		buildTaskAssignment(createMockTaskAssignmentInput({ phase: 'implementation' }));

	/** The stand-in `adaptResultToPhaseRun` rebuilt, for a frame it turns into a throw. */
	function thrownAgent(result: TaskExecutionResult): AgentRunError {
		try {
			adaptResultToPhaseRun(result, SELECTION);
		} catch (err) {
			expect(err).toBeInstanceOf(AgentRunError);
			return err as AgentRunError;
		}
		throw new Error('expected a throw');
	}

	it('carries a timeout deferral’s real metadata onto the rebuilt error', () => {
		const frame = deferrableOrFailedResult(
			new AgentRunError(
				'Implementation agent (claude) exited with code 143 (timed out)',
				{ kind: 'timeout' },
				{
					cli: 'claude',
					exitCode: 143,
					signal: 'SIGTERM',
					stdout: '',
					stderr: '',
					durationMs: 1_806_000,
					timedOut: true,
					aborted: false,
					outputTruncated: false,
				},
			),
			ASSIGNMENT(),
		);

		const err = thrownAgent(frame);
		expect(err.failure.kind).toBe('timeout');
		expect(err.agent).toMatchObject({
			exitCode: 143,
			signal: 'SIGTERM',
			timedOut: true,
			durationMs: 1_806_000,
		});
	});

	// An older worker omits the four fields entirely. Nothing may be invented in their
	// place — `exitCode` stays null and the two optional fields stay unset, so the settle
	// leaves the columns alone — and `exitCode !== 0` still keeps the timeout deferrable.
	it('leaves a metadata-less deferral frame unknown, and still deferrable', () => {
		const err = thrownAgent(base({ status: 'deferred', failureKind: 'timeout', reason: 'stop' }));

		expect(err.agent?.exitCode).toBeNull();
		expect(err.agent?.timedOut).toBeUndefined();
		expect(err.agent?.durationMs).toBeUndefined();
		expect(err.agent?.exitCode).not.toBe(0);
	});

	// A terminal `failed` used to throw a plain `Error`, so `finalizeFailedRun` — which
	// reads the columns off `AgentRunError.agent` — recorded nothing at all.
	it('rebuilds a terminal failed frame as an inert AgentRunError carrying its metadata', () => {
		const frame = deferrableOrFailedResult(
			new AgentRunError(
				'Review agent (claude) exited with code 1 (authentication failed)',
				{ kind: 'auth' },
				{
					cli: 'claude',
					exitCode: 1,
					signal: null,
					stdout: '',
					stderr: '',
					durationMs: 3_400,
					timedOut: false,
					aborted: false,
					outputTruncated: false,
				},
			),
			ASSIGNMENT(),
		);
		expect(frame.status).toBe('failed');

		const err = thrownAgent(frame);
		// `error`, not the frame's own `auth`: the worker already applied the
		// terminal/deferrable split, and re-deriving a kind here would re-enter the
		// shared deferral rule and retry a run the worker settled for good.
		expect(err.failure.kind).toBe('error');
		expect(err.message).toBe('Review agent (claude) exited with code 1 (authentication failed)');
		expect(err.agent).toMatchObject({ exitCode: 1, timedOut: false, durationMs: 3_400 });
	});

	it('records nothing for a terminal failure that ran no agent', () => {
		const err = thrownAgent(base({ status: 'failed', error: 'worktree setup failed' }));

		expect(err.agent?.exitCode).toBeNull();
		expect(err.agent?.timedOut).toBeUndefined();
		expect(err.agent?.durationMs).toBeUndefined();
	});

	it('still raises RunTerminatedError for a cancelled frame', () => {
		expect(() =>
			adaptResultToPhaseRun(
				base({ status: 'failed', cancelled: true, error: 'Run cancelled by user' }),
				SELECTION,
			),
		).toThrow(RunTerminatedError);
	});
});

/**
 * How a result-wait timeout is attributed (issue #723). The message is the whole
 * point of this branch — it is what an operator reads on a run that failed without
 * the worker ever saying why — so it is asserted directly rather than through a live
 * BullMQ consumer. Since phase 1/3 (issue #718) makes a *recovered* interruption
 * deliver its result, an undelivered one now genuinely means the drop was not
 * recovered, which is what makes naming it honest rather than speculative.
 */
describe('awaitResultWithGuards timeout attribution', () => {
	const WAIT_MS = 60_000;
	const never = (): Promise<TaskExecutionResult> => new Promise<TaskExecutionResult>(() => {});

	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(logger, 'warn').mockImplementation(() => {});
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	/** Drive the wait to its timeout and hand back the error it rejected with. */
	async function timeOut(interruptions: TransportInterruptions): Promise<AgentRunError> {
		const pending = awaitResultWithGuards(
			never(),
			new AbortController().signal,
			SELECTION,
			WAIT_MS,
			DISPATCH,
			() => interruptions,
		);
		const caught = pending.catch((err: unknown) => err);
		await vi.advanceTimersByTimeAsync(WAIT_MS);
		const err = await caught;
		expect(err).toBeInstanceOf(AgentRunError);
		return err as AgentRunError;
	}

	it('keeps today’s wording when the transport was never interrupted', async () => {
		const err = await timeOut({ count: 0 });

		expect(err.message).toBe("Worker 'ada-laptop' did not report a result within the lease window");
		// The thrown shape is unchanged, so the shared deferral path behaves identically.
		expect(err.failure.kind).toBe('aborted');
	});

	it('names the interruption, its count, and where to confirm it', async () => {
		const err = await timeOut({ count: 2, lastAt: new Date('2026-08-13T12:00:00Z') });

		expect(err.message).toContain("Worker 'ada-laptop' lost its transport session 2×");
		expect(err.message).toContain('never delivered a result');
		// The pointer that settles "delivered and discarded" versus "never got there".
		expect(err.message).toContain('assignment phase finished — sending result');
		expect(err.message).not.toContain('did not report a result within the lease window');
		expect(err.failure.kind).toBe('aborted');
	});

	it('records the interruption on the warning that precedes the failure', async () => {
		await timeOut({ count: 1, lastAt: new Date('2026-08-13T12:00:00Z') });

		expect(logger.warn).toHaveBeenCalledWith(
			'dispatch back-channel: no result within the lease window — failing',
			expect.objectContaining({
				dispatchId: DISPATCH,
				interruptions: 1,
				lastInterruptedAt: '2026-08-13T12:00:00.000Z',
			}),
		);
	});

	it('still reports the shutdown, not the interruption, when the control plane aborts', async () => {
		const controller = new AbortController();
		const pending = awaitResultWithGuards(
			never(),
			controller.signal,
			SELECTION,
			WAIT_MS,
			DISPATCH,
			() => ({ count: 3 }),
		);
		const caught = pending.catch((err: unknown) => err);
		controller.abort();

		const err = (await caught) as AgentRunError;
		expect(err.message).toBe('Control plane is shutting down');
	});

	it('resolves with the result and never times out when the worker reports', async () => {
		const reported = base({ status: 'succeeded', exitCode: 0 });

		const settled = awaitResultWithGuards(
			Promise.resolve(reported),
			new AbortController().signal,
			SELECTION,
			WAIT_MS,
			DISPATCH,
			() => ({ count: 1, lastAt: new Date('2026-08-13T12:00:00Z') }),
		);

		await expect(settled).resolves.toEqual(reported);
		// The recovered interruption is bookkeeping only: it changes nothing for a
		// dispatch that reports normally.
		await vi.advanceTimersByTimeAsync(WAIT_MS);
		expect(logger.warn).not.toHaveBeenCalled();
	});
});
