import { describe, expect, it } from 'vitest';
import {
	deriveCapacityPendingPayload,
	deriveRetryJobPayload,
	reconstructRetryJob,
} from '@/dispatch/retry-payload.js';
import type { SwarmJob } from '@/queue/jobs.js';
import { createMockPmWebhookJob, createMockScmWebhookJob } from '../../helpers/factories.js';

// The payload derivation previously lived inside the fire-and-forget re-enqueue
// handler (`src/worker/deferred-retry.ts`); issue #284 made it pure so the
// worker persists the derived intent on the dispatch record at settle time.
describe('deriveRetryJobPayload', () => {
	it('consumes one retry attempt and carries the run row forward', () => {
		const next = deriveRetryJobPayload(createMockScmWebhookJob({ rateLimitRetryAttempt: 1 }), {
			phase: 'review',
			runId: 'run-1',
			resumable: false,
		});

		expect(next.rateLimitRetryAttempt).toBe(2);
		expect(next.runId).toBe('run-1');
	});

	it('spends the dependency-recheck budget, not the rate-limit one, for a dependency deferral', () => {
		const next = deriveRetryJobPayload(
			createMockPmWebhookJob({ dependencyRecheckAttempt: 2, rateLimitRetryAttempt: 1 }),
			{
				phase: 'implementation',
				runId: 'run-1',
				resumable: false,
				pmPhaseStarted: true,
				dependencyRecheck: true,
			},
		);

		expect(next.dependencyRecheckAttempt).toBe(3);
		// The rate-limit budget is untouched, so a days-long wait never exhausts it.
		expect(next.rateLimitRetryAttempt).toBe(1);
		expect(next).toMatchObject({ resumePmPhase: 'implementation', runId: 'run-1' });
	});

	it('spends the worker-eligibility budget for a gate deferral, leaving the others alone', () => {
		const next = deriveRetryJobPayload(
			createMockPmWebhookJob({
				workerEligibilityRecheckAttempt: 4,
				dependencyRecheckAttempt: 2,
				rateLimitRetryAttempt: 1,
			}),
			{
				phase: 'implementation',
				resumable: false,
				pmPhaseStarted: true,
				workerEligibilityRecheck: true,
			},
		);

		expect(next.workerEligibilityRecheckAttempt).toBe(5);
		// Waiting for an eligible worker is not a failure and not a dependency wait:
		// neither of the other budgets moves.
		expect(next.dependencyRecheckAttempt).toBe(2);
		expect(next.rateLimitRetryAttempt).toBe(1);
	});

	// Issue #567. Both token-free gates refuse *before* anything is provisioned, so
	// their "retry" is the same attempt still waiting. Re-deriving recovery intent
	// there would turn the wait into the start-over it exists to prevent.
	describe('token-free re-check deferrals carry recovery intent through verbatim', () => {
		const SESSION = '92340ec7-709e-4ffa-9297-3899caca4830';

		it('keeps a checkpoint continuation a checkpoint continuation', () => {
			const next = deriveRetryJobPayload(
				createMockPmWebhookJob({
					recoveryMode: 'checkpoint',
					agentSessionId: SESSION,
					workerEligibilityRecheckAttempt: 1,
				}),
				{
					phase: 'implementation',
					runId: 'run-1',
					resumable: false,
					workerEligibilityRecheck: true,
				},
			);

			expect(next.recoveryMode).toBe('checkpoint');
			expect(next.agentSessionId).toBe(SESSION);
		});

		it('keeps a session resume resumable, with the id it means to resume', () => {
			const next = deriveRetryJobPayload(
				createMockPmWebhookJob({ resumeSession: true, agentSessionId: SESSION }),
				{
					phase: 'implementation',
					runId: 'run-1',
					resumable: false,
					workerEligibilityRecheck: true,
				},
			);

			expect(next.resumeSession).toBe(true);
			expect(next.agentSessionId).toBe(SESSION);
		});

		it('keeps a delivery resume across a dependency re-check too', () => {
			const next = deriveRetryJobPayload(createMockScmWebhookJob({ resumeDelivery: true }), {
				phase: 'review',
				runId: 'run-1',
				resumable: false,
				dependencyRecheck: true,
			});

			expect(next.resumeDelivery).toBe(true);
			expect(next.dependencyRecheckAttempt).toBe(1);
		});
	});

	it('keeps PM resume for an interrupted Implementation', () => {
		const next = deriveRetryJobPayload(createMockPmWebhookJob(), {
			phase: 'implementation',
			runId: 'run-1',
			resumable: true,
			pmPhaseStarted: true,
		});

		expect(next).toMatchObject({ resumePmPhase: 'implementation', resumeSession: true });
	});

	it('drops stale resume flags for a fresh (non-resumable) retry', () => {
		const next = deriveRetryJobPayload(
			createMockPmWebhookJob({
				resumePmPhase: 'implementation',
				resumeSession: true,
				resumeDelivery: true,
			}),
			{ phase: 'review', resumable: false },
		);

		// `resumePmPhase` only survives for board phases; resume flags are re-derived.
		expect(next.resumePmPhase).toBeUndefined();
		expect(next.resumeSession).toBeUndefined();
		expect(next.resumeDelivery).toBeUndefined();
	});

	// A non-resumable retry *assigns* `agentSessionId` as `claude --session-id`
	// rather than resuming it, so carrying the spent id forward made every such
	// retry of an already-started run exit 1 on `Session ID <id> is already in use`
	// before doing any work — the 529-capacity retry that surfaced this.
	it('mints a fresh session id for a non-resumable retry instead of re-assigning the spent one', () => {
		const spent = '1d1c134d-0a61-43bd-b4fe-8d95f6b7061c';

		const next = deriveRetryJobPayload(
			createMockPmWebhookJob({ runId: spent, agentSessionId: spent }),
			{ phase: 'implementation', runId: spent, resumable: false },
		);

		expect(next.resumeSession).toBeUndefined();
		expect(next.agentSessionId).toBeDefined();
		expect(next.agentSessionId).not.toBe(spent);
		// Still assigned up front, so Tier 1 can resume a run that died before it
		// emitted a parseable `session_id`.
		expect(next.agentSessionId).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
	});

	it('keeps the prior session id when the retry does resume it', () => {
		const prior = '92340ec7-709e-4ffa-9297-3899caca4830';

		const next = deriveRetryJobPayload(createMockPmWebhookJob({ agentSessionId: prior }), {
			phase: 'implementation',
			resumable: true,
			pmPhaseStarted: true,
		});

		expect(next).toMatchObject({ resumeSession: true, agentSessionId: prior });
	});

	// The id is destructured out of the rest spread, so the resumable branch has to
	// put it back — and must not invent one when the deferred run captured none
	// (the retry then starts a session the CLI names itself).
	it('invents no session id for a resumable retry that captured none', () => {
		const next = deriveRetryJobPayload(createMockPmWebhookJob(), {
			phase: 'implementation',
			resumable: true,
		});

		expect(next.resumeSession).toBe(true);
		expect(next.agentSessionId).toBeUndefined();
	});

	it('retries delivery with its own worktree-resume signal, not an agent session', () => {
		const next = deriveRetryJobPayload(createMockScmWebhookJob(), {
			phase: 'review',
			runId: 'run-1',
			resumable: false,
			resumeDelivery: true,
		});

		expect(next.resumeDelivery).toBe(true);
		expect(next.resumeSession).toBeUndefined();
	});

	it('preserves an explicit branch checkpoint and prior PM intent through a re-deferral', () => {
		const next = deriveRetryJobPayload(
			createMockPmWebhookJob({
				runId: 'run-1',
				resumePmPhase: 'implementation',
				implementationBranchProvisioned: true,
			}),
			{ phase: 'implementation', runId: 'run-1', resumable: false },
		);

		expect(next).toMatchObject({
			resumePmPhase: 'implementation',
			implementationBranchProvisioned: true,
			runId: 'run-1',
		});
	});

	it('threads the held dispatch dedup claim onto the retry', () => {
		const next = deriveRetryJobPayload(createMockScmWebhookJob(), {
			phase: 'review',
			resumable: false,
			continuationDispatchClaimed: true,
		});

		expect(next.continuationDispatchClaimed).toBe(true);
	});

	// Tier 2 (issue #503): the retry adopts the preserved checkout on the strength of
	// its checkpoint, so it must ask for the `'checkpoint'` recovery mode with a *fresh*
	// session — never carry the dead session id the stopped attempt was using.
	it('derives a checkpoint continuation: recovery mode, a fresh session, and no resume', () => {
		const next = deriveRetryJobPayload(
			createMockScmWebhookJob({
				runId: 'run-1',
				agentSessionId: '11111111-1111-4111-8111-111111111111',
				resumeSession: true,
			}),
			{ phase: 'respond-to-ci', runId: 'run-1', resumable: false, checkpointed: true },
		);

		expect(next.recoveryMode).toBe('checkpoint');
		expect(next.resumeSession).toBeUndefined();
		expect(next.resumeDelivery).toBeUndefined();
		expect(next.agentSessionId).toBeDefined();
		expect(next.agentSessionId).not.toBe('11111111-1111-4111-8111-111111111111');
		// A continuation is still a failure retry, so it spends a rate-limit attempt —
		// the second, coarser bound on the loop.
		expect(next.rateLimitRetryAttempt).toBe(1);
	});

	// A continuation that stops again *and* captures a resumable session this time goes
	// back to Tier 1, so the stale `'checkpoint'` mode must not survive and re-run the
	// gate's adopt-a-checkpoint branch.
	it('drops a stale checkpoint recovery mode when the next attempt resumes a session', () => {
		const next = deriveRetryJobPayload(
			createMockScmWebhookJob({ recoveryMode: 'checkpoint', runId: 'run-1' }),
			{ phase: 'respond-to-ci', runId: 'run-1', resumable: true },
		);

		expect(next.recoveryMode).toBeUndefined();
		expect(next.resumeSession).toBe(true);
	});

	it('leaves an operator-selected recovery mode alone', () => {
		const next = deriveRetryJobPayload(
			createMockScmWebhookJob({ recoveryMode: 'resume', runId: 'run-1' }),
			{ phase: 'review', runId: 'run-1', resumable: true },
		);

		expect(next.recoveryMode).toBe('resume');
	});
});

describe('deriveCapacityPendingPayload', () => {
	it('does not consume a retry attempt while waiting for a slot', () => {
		const pending = deriveCapacityPendingPayload(
			createMockScmWebhookJob({ rateLimitRetryAttempt: 3 }),
			{ phase: 'review', runId: 'run-1', resumable: false },
		);

		expect(pending.rateLimitRetryAttempt).toBe(3);
		expect(pending.runId).toBe('run-1');
	});

	it('records exact PM dispatch intent so a stale board status cannot dedupe the wake-up', () => {
		const pending = deriveCapacityPendingPayload(createMockPmWebhookJob(), {
			phase: 'implementation',
			runId: 'run-1',
			resumable: false,
		});

		expect(pending.resumePmPhase).toBe('implementation');
	});

	it('keeps the held dedup claim for a blocked SCM continuation', () => {
		const pending = deriveCapacityPendingPayload(createMockScmWebhookJob(), {
			phase: 'review',
			resumable: false,
			continuationDispatchClaimed: true,
		});

		expect(pending.continuationDispatchClaimed).toBe(true);
	});
});

describe('reconstructRetryJob', () => {
	// Two of the three callers ("Retry now"'s reconstruct-from-run-row fallback and
	// "Reset & restart") pass a raw `run.jobPayload` straight out of `jsonb`, so a
	// pre-#385 row must be upgraded here — otherwise the rebuilt dispatch persists
	// the legacy envelope forward and the row never heals.
	it('upgrades a legacy pre-#385 envelope instead of rewriting it forward', () => {
		const legacy = {
			type: 'github',
			projectId: 'swarm',
			event: {
				eventType: 'issues',
				action: 'labeled',
				repoFullName: 'SmartTechBrewery/swarm',
				workItemId: '42',
				isCommentEvent: false,
				labelName: 'swarm-replan',
			},
		} as unknown as SwarmJob;

		const job = reconstructRetryJob(legacy, 'run-1', 'planning');

		expect(job).toMatchObject({
			type: 'scm',
			providerId: 'github',
			event: { kind: 'work-item' },
		});
		expect(job.runId).toBe('run-1');
		expect(job.rateLimitRetryAttempt).toBe(0);
	});

	it('leaves a current envelope untouched while carrying the run row forward', () => {
		const job = reconstructRetryJob(createMockScmWebhookJob(), 'run-2', 'review');

		expect(job).toMatchObject({ type: 'scm', providerId: 'github' });
		expect(job.runId).toBe('run-2');
	});

	// The operator path phase 4 drives (issue #503). Like `'fresh'`, a continuation runs
	// a brand-new session — it has none to re-enter — so an expected session id is
	// deliberately not honoured for it.
	it("rebuilds a 'checkpoint' continuation with a fresh session and no resume flag", () => {
		const job = reconstructRetryJob(
			createMockScmWebhookJob({ resumeSession: true }),
			'run-3',
			'implementation',
			undefined,
			undefined,
			undefined,
			false,
			'checkpoint',
			'11111111-1111-4111-8111-111111111111',
		);

		expect(job.recoveryMode).toBe('checkpoint');
		expect(job.resumeSession).toBeUndefined();
		expect(job.agentSessionId).toBeDefined();
		expect(job.agentSessionId).not.toBe('11111111-1111-4111-8111-111111111111');
	});
});
