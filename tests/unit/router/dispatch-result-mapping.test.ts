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
import { TRANSPORT_LOST_ORPHAN_REASON } from '@/router/transport-loss-reaper.js';
import { DeliveryDeferredError } from '@/scm/delivery.js';
import { buildTaskAssignment } from '@/transport/assignment.js';
import { deferrableOrFailedResult } from '@/transport/assignment-execution.js';
import type { TaskExecutionResult } from '@/transport/protocol.js';
import { RETRY_BUFFER_MS, retryDelayForFailure } from '@/worker/consumer.js';
import type { DispatchSelection } from '@/worker/eligibility-gate.js';
import { RunTerminatedError } from '@/worker/run-cancellation.js';
import { BlockedRecoveryError } from '@/worktree/reclaim.js';
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

	it('maps the split children auto-advance took along, so each gets its own self-enqueue (issue #911)', () => {
		const run = adaptResultToPhaseRun(
			base({
				status: 'succeeded',
				exitCode: 0,
				movedTo: 'todo',
				advancedItemIds: ['PVTI_child-one', 'PVTI_child-two'],
			}),
			SELECTION,
		);
		expect(run.advancedItemIds).toEqual(['PVTI_child-one', 'PVTI_child-two']);
	});

	it('tolerates a result frame from an older worker that reports no advanced children', () => {
		const run = adaptResultToPhaseRun(base({ status: 'succeeded', exitCode: 0 }), SELECTION);
		expect(run.advancedItemIds).toBeUndefined();
	});

	it('maps a Review run’s fold-in declaration onto the run the settle writes (issue #953)', () => {
		const absorbed = [
			{
				url: 'https://github.com/SmartTechBrewery/swarm/issues/947',
				reference: '#947',
				evidence: 'Its criteria 1-3 are met by this diff.',
			},
		];
		const run = adaptResultToPhaseRun(
			base({ status: 'succeeded', exitCode: 0, verdict: 'approve', absorbed }),
			SELECTION,
		);
		expect(run.absorbed).toEqual(absorbed);
	});

	it('tolerates a result frame from an older worker that declares no absorbed scope', () => {
		const run = adaptResultToPhaseRun(base({ status: 'succeeded', exitCode: 0 }), SELECTION);
		expect(run.absorbed).toBeUndefined();
	});

	it('maps the reported CI outcome so the settle path can hand a no-fix back to Review (issue #841)', () => {
		const run = adaptResultToPhaseRun(
			base({ status: 'succeeded', exitCode: 0, ciOutcome: 'no-fix' }),
			SELECTION,
		);
		expect(run.ciOutcome).toBe('no-fix');
	});

	// Additive in both directions, so `TRANSPORT_PROTOCOL_VERSION` is not bumped:
	// an older worker omits the field and its `no-fix` runs behave as they did.
	it('tolerates a result frame from an older worker that reports no CI outcome', () => {
		const run = adaptResultToPhaseRun(base({ status: 'succeeded', exitCode: 0 }), SELECTION);
		expect(run.ciOutcome).toBeUndefined();
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

	it('settles a transport-lost orphan terminally, with no re-dispatch (issue #859)', async () => {
		// The frame the transport-loss reap actually produces: a plain `failed` with no
		// `cancelled` key, so it maps to the same non-deferrable terminal error the
		// supersede does rather than to a `RunTerminatedError` — which is what makes the
		// issue's Non-goal hold by construction: `error` is not a deferrable kind, so
		// nothing re-dispatches the phase the vanished worker was running.
		const awaiting = awaitDispatchResult(DISPATCH, {
			workerId: 'w-1',
			runId: 'run-859',
			phase: 'respond-to-review',
			taskId: '859',
		});
		expect(failDispatchResultWait(DISPATCH, TRANSPORT_LOST_ORPHAN_REASON)).toBe(true);
		const frame = await awaiting.result;
		// Both keys carry the reason (`failDispatchResultWait` emits `error` and
		// `reason`), and neither `cancelled` nor a retry hint is present.
		expect(frame).toMatchObject({
			status: 'failed',
			error: TRANSPORT_LOST_ORPHAN_REASON,
			reason: TRANSPORT_LOST_ORPHAN_REASON,
		});
		expect(frame).not.toHaveProperty('cancelled');

		try {
			adaptResultToPhaseRun(frame, SELECTION);
			throw new Error('expected a throw');
		} catch (err) {
			expect(err).toBeInstanceOf(AgentRunError);
			expect(err).not.toBeInstanceOf(RunTerminatedError);
			const failed = err as AgentRunError;
			expect(failed.failure.kind).toBe('error');
			// The run row records what actually happened, distinguishably from the lease
			// window's own reason and from an operator termination.
			expect(failed.message).toBe(TRANSPORT_LOST_ORPHAN_REASON);
			expect(failed.message).not.toContain('did not report a result within the lease window');
			expect(failed.message).not.toBe(RUN_CANCELLED_MESSAGE);
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

	/**
	 * The reported reset crossing the split (issue #980). The rebuilt failure used to
	 * carry the kind alone, so `retryDelayForFailure` found no `retryAfter` and returned
	 * the flat 30-minute default — retrying a Claude 5-hour window ~10 times against a
	 * limit that had not moved. Each case asserts the delay the *shared* policy produces,
	 * not just the rebuilt fields, because that delay is the behaviour the issue is about.
	 */
	describe('reported rate-limit reset', () => {
		const RESET_HINT = '1:40pm (Europe/Warsaw)';
		const MIN_RETRY_DELAY_MS = 6 * 60 * 1000;
		const DEFAULT_RETRY_DELAY_MS = 30 * 60 * 1000;
		// `SWARM_MAX_JOB_AGE_MS` (24 h by default) less the dequeue margin — the longest
		// wait a deferred wake-up survives the job-freshness gate for (issue #1013).
		const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1000 - 15 * 60 * 1000;

		/** The failure `adaptResultToPhaseRun` rebuilt from a deferral frame. */
		function rebuiltFailure(overrides: Partial<TaskExecutionResult>) {
			try {
				adaptResultToPhaseRun(
					base({
						status: 'deferred',
						failureKind: 'rate-limit',
						reason: 'rate limited',
						...overrides,
					}),
					SELECTION,
				);
			} catch (err) {
				expect(err).toBeInstanceOf(AgentRunError);
				return (err as AgentRunError).failure;
			}
			throw new Error('expected a throw');
		}

		it('carries the reported reset onto the rebuilt failure', () => {
			const reset = new Date(Date.now() + 90 * 60 * 1000).toISOString();

			const failure = rebuiltFailure({ retryAfter: reset, resetHint: RESET_HINT });

			expect(failure.retryAfter?.toISOString()).toBe(reset);
			// What the deferral log line names to the operator (`src/worker/consumer.ts`).
			expect(failure.resetHint).toBe(RESET_HINT);
		});

		it('schedules the retry from the reset rather than the default backoff', () => {
			const reset = new Date(Date.now() + 90 * 60 * 1000).toISOString();

			const delay = retryDelayForFailure(rebuiltFailure({ retryAfter: reset }), Date.now());

			expect(delay).toBeGreaterThan(90 * 60 * 1000);
			expect(delay).toBeLessThan(92 * 60 * 1000);
			expect(delay).not.toBe(DEFAULT_RETRY_DELAY_MS);
		});

		// An older worker reports neither field. Its own `retryDelayMs` — computed from
		// this same policy on its side — is re-expressed as an instant so the one shared
		// policy reproduces it, net of the milliseconds the settle spends in between.
		it('falls back to the frame’s own delay when it reports no instant', () => {
			const reported = 47 * 60 * 1000;

			const delay = retryDelayForFailure(rebuiltFailure({ retryDelayMs: reported }), Date.now());

			expect(delay).toBeGreaterThan(reported - 1_000);
			expect(delay).toBeLessThanOrEqual(reported);
		});

		it('keeps today’s default backoff when the frame reports neither field nor a delay', () => {
			expect(retryDelayForFailure(rebuiltFailure({}), Date.now())).toBe(DEFAULT_RETRY_DELAY_MS);
		});

		it('still defers on an unparseable reset instant, using the frame’s delay', () => {
			const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

			const failure = rebuiltFailure({ retryAfter: 'not a date', retryDelayMs: 47 * 60 * 1000 });

			expect(failure.retryAfter?.getTime()).not.toBeNaN();
			expect(retryDelayForFailure(failure, Date.now())).toBeLessThanOrEqual(47 * 60 * 1000);
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining('unparseable reset instant'),
				expect.objectContaining({ retryAfter: 'not a date' }),
			);
			warn.mockRestore();
		});

		// A reported reset inside the believed horizon is scheduled as reported — a
		// clamp here used to turn agy's observed `Resets in 16h39m20s` into a six-hour
		// wait, retrying the run (and lapsing the machine's cool-down, which is this
		// same policy's answer) ten hours before the account had anything left.
		it('schedules a reported reset well past the old six-hour ceiling as reported', () => {
			const observed = 16 * 60 * 60 * 1000 + 39 * 60 * 1000 + 20 * 1000;
			const reset = new Date(Date.now() + observed).toISOString();

			const delay = retryDelayForFailure(rebuiltFailure({ retryAfter: reset }), Date.now());

			expect(delay).toBeGreaterThan(observed);
			expect(delay).toBeLessThanOrEqual(observed + RETRY_BUFFER_MS);
		});

		it('keeps the MIN/MAX clamps bounding the delay', () => {
			// Further out than a deferred wake-up can be scheduled at all: the control
			// plane discards one it dequeues more than `SWARM_MAX_JOB_AGE_MS` (24 h)
			// after it was published, so the wait stops a dequeue margin short of that.
			const absurd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
			const near = new Date(Date.now() + 1_000).toISOString();

			expect(retryDelayForFailure(rebuiltFailure({ retryAfter: absurd }), Date.now())).toBe(
				MAX_RETRY_DELAY_MS,
			);
			expect(retryDelayForFailure(rebuiltFailure({ retryAfter: near }), Date.now())).toBe(
				MIN_RETRY_DELAY_MS,
			);
		});

		// `rate-limit` is the only kind whose delay is computed from an instant at all, so
		// no reset is synthesized for any other — that would invent one nothing reads.
		it('invents no reset for a non-rate-limit deferral carrying a delay', () => {
			const failure = rebuiltFailure({ failureKind: 'aborted', retryDelayMs: 47 * 60 * 1000 });

			expect(failure.kind).toBe('aborted');
			expect(failure.retryAfter).toBeUndefined();
			expect(retryDelayForFailure(failure, Date.now())).toBe(MIN_RETRY_DELAY_MS);
		});
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

	// Issue #1000: the frame's own `exitCode: 0` cannot tell a self-timed-out run apart
	// from a clean one, so without the notice crossing the wire the control plane
	// re-judges the worker's deferral into a terminal failure — the exact disposition
	// the issue is about — and the operator-facing message loses the cause too.
	it('keeps a self-timeout deferral deferrable across the wire, despite its exit 0', () => {
		const AGY_PRINT_TIMEOUT =
			'[agy] print timeout after 5m0s with turn in progress; returning partial output';
		const frame = deferrableOrFailedResult(
			new AgentRunError(
				`Implementation agent (antigravity) exited with code 0 (CLI timed out: ${AGY_PRINT_TIMEOUT})`,
				{ kind: 'timeout', cliSelfTimeout: AGY_PRINT_TIMEOUT },
				{
					cli: 'antigravity',
					exitCode: 0,
					signal: null,
					stdout: '',
					stderr: `${AGY_PRINT_TIMEOUT}\n`,
					durationMs: 300_000,
					timedOut: false,
					aborted: false,
					outputTruncated: false,
				},
			),
			ASSIGNMENT(),
		);
		expect(frame).toMatchObject({ status: 'deferred', cliSelfTimeout: AGY_PRINT_TIMEOUT });

		const err = thrownAgent(frame);
		expect(err.failure).toMatchObject({ kind: 'timeout', cliSelfTimeout: AGY_PRINT_TIMEOUT });
		expect(err.agent?.exitCode).toBe(0);
		expect(err.message).toContain(AGY_PRINT_TIMEOUT);
	});

	it('leaves an older worker’s exit-0 timeout frame terminal, field absent', () => {
		// Back-compat in the direction that matters: a worker that predates the field
		// omits it, and its frames behave exactly as they do today.
		const err = thrownAgent(
			base({ status: 'deferred', failureKind: 'timeout', reason: 'stop', exitCode: 0 }),
		);

		expect(err.failure.cliSelfTimeout).toBeUndefined();
		expect(err.agent?.exitCode).toBe(0);
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

	// The regression of issue #980 caught at its own seam: the worker sends the reset it
	// resolved, and the control plane must keep it. Asserted against the worker's real
	// frame rather than a fixture, which is what would have caught the loss in #407.
	it('keeps a rate-limit deferral’s reported reset across the split', () => {
		const retryAfter = new Date(Date.now() + 5 * 60 * 60 * 1000);
		const resetHint = '1:40pm (Europe/Warsaw)';
		const frame = deferrableOrFailedResult(
			new AgentRunError(
				'Implementation agent (claude) exited with code 1 (usage limit reached)',
				{ kind: 'rate-limit', resetHint, retryAfter },
				{
					cli: 'claude',
					exitCode: 1,
					signal: null,
					stdout: '',
					stderr: '',
					durationMs: 12_000,
					timedOut: false,
					aborted: false,
					outputTruncated: false,
				},
			),
			ASSIGNMENT(),
		);
		expect(frame).toMatchObject({ status: 'deferred', retryAfter: retryAfter.toISOString() });

		const err = thrownAgent(frame);
		expect(err.failure.retryAfter?.getTime()).toBe(retryAfter.getTime());
		expect(err.failure.resetHint).toBe(resetHint);
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
 * The refused adoption crossing the wire (issue #952). A federated terminal failure used
 * to rebuild as a plain `AgentRunError`, so the settle wrote `recovery: null` — the one
 * write that erases `runs.recovery.preservedWorkerId` and un-pins the retry from the
 * machine that still holds the checkout. As above, the frames come from the worker's own
 * `deferrableOrFailedResult` so both halves of the seam are asserted against each other.
 */
describe('adaptResultToPhaseRun blocked recovery', () => {
	const ASSIGNMENT = () =>
		buildTaskAssignment(createMockTaskAssignmentInput({ phase: 'implementation' }));

	it('re-raises the recovery gate’s refusal so the settle records a recovery state', () => {
		const frame = deferrableOrFailedResult(
			new BlockedRecoveryError(
				'checkpoint-divergent',
				'Checkpoint no longer matches the working tree',
			),
			ASSIGNMENT(),
		);
		expect(frame).toMatchObject({ status: 'failed', blockedReason: 'checkpoint-divergent' });

		try {
			adaptResultToPhaseRun(frame, SELECTION);
			throw new Error('expected a throw');
		} catch (err) {
			expect(err).toBeInstanceOf(BlockedRecoveryError);
			const blocked = err as BlockedRecoveryError;
			// This is what `finalizeFailedRun` persists as `recovery.blockedReason`, and
			// what the dashboard renders its recovery guidance from.
			expect(blocked.reason).toBe('checkpoint-divergent');
			expect(blocked.message).toBe('Checkpoint no longer matches the working tree');
			// Not an `AgentRunError`, so `isDeferrable` still leaves it terminal.
			expect(blocked).not.toBeInstanceOf(AgentRunError);
		}
	});

	// The wire carries a string precisely so a worker that learns a seventh reason first
	// does not lose its whole settle to a parse failure — and the pin survives either way.
	it('keeps a reason this control plane does not model', () => {
		try {
			adaptResultToPhaseRun(
				base({ status: 'failed', error: 'blocked', blockedReason: 'lease-contested' }),
				SELECTION,
			);
			throw new Error('expected a throw');
		} catch (err) {
			expect(err).toBeInstanceOf(BlockedRecoveryError);
			expect((err as BlockedRecoveryError).reason).toBe('lease-contested');
		}
	});

	// The #596 regression bar: a terminal failure naming no reason is untouched.
	it('still rebuilds a reason-less terminal failure as an inert AgentRunError', () => {
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
		expect(frame.blockedReason).toBeUndefined();

		try {
			adaptResultToPhaseRun(frame, SELECTION);
			throw new Error('expected a throw');
		} catch (err) {
			expect(err).toBeInstanceOf(AgentRunError);
			expect((err as AgentRunError).failure.kind).toBe('error');
			expect((err as AgentRunError).agent).toMatchObject({ exitCode: 1, durationMs: 3_400 });
		}
	});

	// Cancellation is checked first: a user termination cancels the dispatch rather than
	// recording a recovery state, whatever else the frame happens to carry.
	it('still raises RunTerminatedError for a cancelled frame naming a reason', () => {
		expect(() =>
			adaptResultToPhaseRun(
				base({
					status: 'failed',
					cancelled: true,
					error: 'Run cancelled by user',
					blockedReason: 'dirty',
				}),
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
