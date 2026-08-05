/**
 * The router→worker job contract — the one shape both sides of the queue speak
 * (PROJECT.md §5 "Orchestration Input", trimmed to the MVP's local BullMQ).
 *
 * The router's producer (SWARM-35, at the `src/router/enqueue.ts` seam) turns an
 * authenticated, project-matched webhook event into one of these jobs; the
 * worker's consumer (`src/worker/consumer.ts`) validates it back through this
 * schema before acting. A job carries the already-normalized event — not the raw
 * webhook body — so the worker never re-does the router's parsing, plus the
 * project id (config is re-read from Postgres on the worker side, never
 * serialized into the job) and the provider's delivery id for idempotency/tracing.
 *
 * The `type` discriminator names the *category* of work, not a provider: one
 * `scm` variant covers every SCM provider and one `pm` variant covers every PM
 * provider (which one produced it is the `providerId` field, resolved through
 * `scmProviderRegistry` / `pmProviderRegistry`), so adding a provider never edits
 * this file (ai/RULES.md §2).
 */

import { z } from 'zod';
import { AgentCliSchema } from '../harness/agent-cli.js';
import { ReasoningLevelSchema } from '../harness/models.js';
import { PmEventSchema, PmProviderIdSchema } from '../pm/events.js';
import { ScmEventSchema, ScmProviderIdSchema } from '../scm/events.js';

/** The single BullMQ queue the router produces onto and the worker consumes. */
export const QUEUE_NAME = 'swarm-jobs';

/**
 * How a run recovers a preserved `task-<id>` checkout, enforced by the recovery
 * gate (`executeRecoveryGate`, `src/pipeline/resume.ts`):
 *
 * - `resume` — validate the checkout and re-enter the agent's own CLI session
 *   (Tier 1, `docs/CHECKPOINTS.md`). Requires a resumable session id.
 * - `fresh` — the checkout carries nothing worth keeping: remove it and start over.
 * - `checkpoint` — Tier 2. Adopt the checkout and continue from the checkpoint
 *   file the stopped run left in it, on a **fresh** session with no resume id, so
 *   the continuation may run on a different CLI than the deferred run did.
 *
 * Lives here because the job payload is the contract that carries the value; the
 * pipeline imports the type rather than restating the union.
 */
export const RecoveryModeSchema = z.enum(['resume', 'fresh', 'checkpoint']);
export type RecoveryMode = z.infer<typeof RecoveryModeSchema>;

const jobBase = z.object({
	/** The SWARM project (`ProjectConfig.id`) the event was matched to. */
	projectId: z.string().min(1),
	/** The provider's per-delivery id — stable per webhook delivery. */
	deliveryId: z.string().min(1).optional(),
	/**
	 * How many times this job has already been re-enqueued as a deferred
	 * incomplete-check recheck (`src/triggers/handlers/review.ts`). Absent on a
	 * fresh webhook; incremented each time the `pr-review` handler reschedules a
	 * coalesced recheck, so it can cap the loop when the Actions API stays stale.
	 */
	recheckAttempt: z.number().int().nonnegative().optional(),
	/**
	 * How many times this job has already been re-enqueued as a deferred retry
	 * (`src/worker/index.ts`, on a `phase-deferred` outcome) — either a rate-limit
	 * hit or a run the worker itself aborted mid-flight (e.g. a `--watch`
	 * restart). Absent on a fresh webhook; incremented on each deferral so the
	 * consumer can cap the retry loop (one shared budget for both reasons —
	 * `src/worker/consumer.ts`'s `MAX_RATE_LIMIT_RETRIES`) when either persists.
	 */
	rateLimitRetryAttempt: z.number().int().nonnegative().optional(),
	/**
	 * How many times this job has been re-checked while waiting on an unfinished
	 * dependency (issue #330): an Implementation whose work item is `blocked by` an
	 * open prerequisite is deferred as a token-free `recheck` dispatch — no worktree,
	 * no agent — and re-evaluated on {@link DEPENDENCY_RECHECK_INTERVAL_MS}. Absent
	 * on a fresh webhook; incremented on each dependency re-check so the consumer can
	 * cap the wait (`MAX_DEPENDENCY_RECHECKS`) and finally fail with an actionable
	 * "must be done first" message rather than polling forever.
	 */
	dependencyRecheckAttempt: z.number().int().nonnegative().optional(),
	/**
	 * How many times this job has been re-checked while no eligible worker could
	 * take it (issue #339): the federated dispatch gate
	 * (`src/worker/eligibility-gate.ts`) refused it — an assignee's worker is
	 * busy, consent was revoked, an enrollment is not active, or no enrolled
	 * worker can run any configured target — so it waits as a token-free
	 * `worker-eligibility` dispatch (no worktree, no agent) and is re-evaluated on
	 * the same cadence as a dependency re-check. Absent on a fresh webhook;
	 * incremented on each re-check so the wait is bounded and finally surfaces the
	 * actionable reason instead of polling forever. A separate budget from
	 * {@link dependencyRecheckAttempt} — an item can wait on both, one after the
	 * other, without either exhausting the other's.
	 */
	workerEligibilityRecheckAttempt: z.number().int().nonnegative().optional(),
	/**
	 * PM phase to resume after an agent failure. A retried implementation has
	 * already moved its card to In progress, which normally is deliberately not
	 * a phase-triggering status; this preserves the original dispatch intent.
	 * Board-dispatch concern only (`pm` jobs) — session continuation is
	 * the separate {@link resumeSession} flag, which spans every phase and CLI.
	 */
	resumePmPhase: z.enum(['planning', 'implementation']).optional(),
	/**
	 * Durable proof that Implementation successfully provisioned its task branch.
	 * A manual retry needs `resumePmPhase` to preserve dispatch intent after the
	 * card moved to In progress, but must not reuse a branch unless provisioning
	 * actually completed.
	 */
	implementationBranchProvisioned: z.boolean().optional(),
	/**
	 * Set on a deferred retry that should *continue the prior agent session*
	 * rather than start fresh (a `rate-limit`/`timeout` deferral, any phase, any
	 * CLI). When set, the consumer threads {@link agentSessionId} into the phase
	 * as a resume id (`claude --resume` / `agy --conversation` /
	 * `codex exec resume`) and the phase reuses the preserved worktree; when
	 * absent, the run starts a fresh session and, for claude, assigns
	 * `agentSessionId` as its new `--session-id`.
	 */
	resumeSession: z.boolean().optional(),
	/**
	 * Set on a deterministic-delivery retry. Unlike {@link resumeSession}, this
	 * resumes a preserved worktree and its delivery sidecar without requiring an
	 * agent CLI session to exist.
	 */
	resumeDelivery: z.boolean().optional(),
	/**
	 * The `runs` row this job re-runs (issue #136). Absent on a fresh webhook;
	 * set when a deferred run is re-enqueued (`reenqueueDeferred`
	 * `src/worker/index.ts`, or a manual "Retry now") so the worker resets that
	 * existing row to `running` instead of inserting a second one — a retry then
	 * shows as one run on the dashboard, not two. When absent, the consumer
	 * creates a fresh row as before.
	 */
	runId: z.string().min(1).optional(),
	/**
	 * Persisted agent session/thread id for a resumable deferred run — the value
	 * threaded back as the CLI's resume id on retry. UUID-shaped for every CLI:
	 * claude's assigned `--session-id`, codex's `thread_id`, and agy's conversation
	 * id are all UUIDs (verified live). Not claude-only anymore.
	 */
	agentSessionId: z.string().uuid().optional(),
	/** Optional overrides for retrying/running with a specific agent CLI and model. */
	cliOverride: AgentCliSchema.optional(),
	modelOverride: z.string().min(1).optional(),
	/**
	 * Optional per-run reasoning-level override (issue #180). Validated against the
	 * effective model when resolved (`resolveReasoning`, `src/worker/consumer.ts`),
	 * so a level incompatible with an overridden CLI/model is dropped rather than
	 * launched. Rides `...jobPayload` spreads through deferred/manual retries.
	 */
	reasoningOverride: ReasoningLevelSchema.optional(),
	/** How this run recovers a preserved worktree ({@link RecoveryModeSchema}). */
	recoveryMode: RecoveryModeSchema.optional(),
	/**
	 * Set on a concurrency-deferred continuation's retry (issue #214): its dispatch
	 * dedup slot was already claimed by the original dispatch attempt, so the
	 * re-dispatch must NOT re-claim it — a prioritized retry fires within the
	 * (refreshed) claim TTL, and re-claiming would drop the run as a duplicate. The
	 * `pr-review` handler reads it to reuse the held claim instead of calling
	 * `claimReviewDispatch`. Board jobs never set it.
	 */
	continuationDispatchClaimed: z.boolean().optional(),
	/**
	 * The durable dispatch record this job wakes up (issue #284, ADR-002). Every
	 * queue job produced by the dispatch layer carries it; the worker acts only
	 * after atomically claiming that record, so a cancelled/completed dispatch
	 * can never be resurrected by a late delivery. Absent only on legacy jobs
	 * enqueued before the dispatch layer existed (adopted at dequeue) and on the
	 * router's degraded fallback when the dispatch table is unavailable.
	 */
	dispatchId: z.string().uuid().optional(),
});

/** A normalized SCM webhook event (a pull request, a review, checks, …) bound for the worker. */
export const ScmWebhookJobSchema = jobBase.extend({
	type: z.literal('scm'),
	/**
	 * Which registered SCM provider produced (and therefore owns) this event — the
	 * key the worker resolves through `scmProviderRegistry` to get the
	 * `SCMProvider` it injects into the trigger context.
	 */
	providerId: ScmProviderIdSchema,
	event: ScmEventSchema,
});

/** A normalized PM board event (status change / card added) bound for the worker. */
export const PmWebhookJobSchema = jobBase.extend({
	type: z.literal('pm'),
	/**
	 * Which registered PM provider produced (and therefore owns) this event — the
	 * key the worker resolves through `pmProviderRegistry` to get the `PMProvider`
	 * it injects into the trigger context.
	 */
	providerId: PmProviderIdSchema,
	event: PmEventSchema,
});

/**
 * A durable merge-automation intent (issue #292): after the Review phase
 * submits an eligible `approve`, the worker persists one of these as a
 * dispatch (never a webhook — there is no `event`) and executes it through the
 * normal dispatch lifecycle: the provider-neutral `ScmMergeProvider` merges
 * the approved pull request directly under the project's implementer
 * credential, retrying transient `not-ready` outcomes on the dispatch's own
 * bounded schedule. Carries everything an attempt needs so no Review-run
 * context has to survive in memory; the reviewed head SHA is re-verified
 * against the PR's current state on every attempt.
 */
export const MergeAutomationJobSchema = jobBase.extend({
	type: z.literal('merge-automation'),
	/** The completed Review run whose approval this merge executes — outcomes persist onto its row. */
	reviewRunId: z.string().min(1),
	/** `owner/repo` — observability only; execution resolves the repo from project config. */
	repo: z.string().min(1),
	prNumber: z.string().min(1),
	/** The reviewed head SHA the approval covers; re-checked fresh on every attempt. */
	approvedHeadSha: z.string().min(1),
});

const swarmJobVariants = z.discriminatedUnion('type', [
	ScmWebhookJobSchema,
	PmWebhookJobSchema,
	MergeAutomationJobSchema,
]);

/**
 * The envelopes whose discriminator *was* the provider id, before each category
 * grew a `providerId` field: `github` (pre-#385, SCM) and `github-projects`
 * (pre-#297, PM). Durable dispatch rows and historical `runs.jobPayload` snapshots
 * still carry them — a dependency recheck can wait days, and a "Retry now"
 * re-parses a run's stored payload indefinitely — so a deploy must read them
 * rather than fail their in-flight work.
 *
 * Frozen: this is the *queue's own* serialization history, not provider logic. A
 * second provider in either category is written by ingress as
 * `{ type, providerId }` from day one.
 */
const LEGACY_ENVELOPE_BY_TYPE: Readonly<
	Record<string, { readonly type: string; readonly providerId: string }>
> = {
	github: { type: 'scm', providerId: 'github' },
	'github-projects': { type: 'pm', providerId: 'github-projects' },
};

/**
 * Upgrade a legacy job envelope (see {@link LEGACY_ENVELOPE_BY_TYPE}) in place.
 * The event inside upgrades in {@link ScmEventSchema} / {@link PmEventSchema}'s own
 * preprocess, so this only rewrites the envelope's two fields.
 */
function upgradeLegacyJobEnvelope(value: unknown): unknown {
	if (typeof value !== 'object' || value === null) return value;
	const raw = value as Record<string, unknown>;
	const upgraded = typeof raw.type === 'string' ? LEGACY_ENVELOPE_BY_TYPE[raw.type] : undefined;
	return upgraded ? { ...raw, ...upgraded } : value;
}

export const SwarmJobSchema = z.preprocess(upgradeLegacyJobEnvelope, swarmJobVariants);

export type ScmWebhookJob = z.infer<typeof ScmWebhookJobSchema>;
export type PmWebhookJob = z.infer<typeof PmWebhookJobSchema>;
export type MergeAutomationJob = z.infer<typeof MergeAutomationJobSchema>;
export type SwarmJob = z.infer<typeof swarmJobVariants>;

/**
 * Normalize a payload read straight out of Postgres, where `jobPayload` is a
 * `jsonb` column typed (not validated) as {@link SwarmJob} — so a row written
 * before #385/#297 is *typed* current while still carrying the legacy envelope. Read
 * models must funnel through this before switching on `type`/`kind`; a payload
 * that no longer validates at all is returned untouched, exactly as an unvalidated
 * cast behaved before.
 */
export function normalizeStoredJobPayload(payload: SwarmJob): SwarmJob {
	const parsed = SwarmJobSchema.safeParse(payload);
	return parsed.success ? parsed.data : payload;
}
