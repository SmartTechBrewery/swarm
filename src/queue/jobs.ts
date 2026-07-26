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
 * `scm` variant covers every SCM provider (which one produced it is the
 * `providerId` field, resolved through `scmProviderRegistry`), so adding a
 * provider never edits this file (ai/RULES.md §2). `github-projects` stays the PM
 * board's own variant until the PM ingress gets the same treatment.
 */

import { z } from 'zod';
import { AgentCliSchema } from '../harness/agent-cli.js';
import { ReasoningLevelSchema } from '../harness/models.js';
import { GitHubProjectsParsedEventSchema } from '../router/adapters/github-projects.js';
import { ScmEventSchema, ScmProviderIdSchema } from '../scm/events.js';

/** The single BullMQ queue the router produces onto and the worker consumes. */
export const QUEUE_NAME = 'swarm-jobs';

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
	 * Board-dispatch concern only (github-projects jobs) — session continuation is
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
	/**
	 * Mode for recovering a cancelled preserved worktree: 'resume' to validate and resume the
	 * session, or 'fresh' to clean it up and start fresh.
	 */
	recoveryMode: z.enum(['resume', 'fresh']).optional(),
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

/** A `projects_v2_item` board event (Status change / card added) bound for the worker. */
export const GitHubProjectsWebhookJobSchema = jobBase.extend({
	type: z.literal('github-projects'),
	event: GitHubProjectsParsedEventSchema,
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
	GitHubProjectsWebhookJobSchema,
	MergeAutomationJobSchema,
]);

/**
 * Upgrade the pre-#385 SCM envelope, when the discriminator *was* the provider id
 * (`type: 'github'`). Durable dispatch rows and historical `runs.jobPayload`
 * snapshots still carry it — a dependency recheck can wait days, and a "Retry now"
 * re-parses a run's stored payload indefinitely — so a deploy must read them
 * rather than fail their in-flight work. The event inside upgrades in
 * {@link ScmEventSchema}'s own preprocess.
 *
 * Frozen: this is the queue's serialization history, not provider logic. A second
 * provider is written by ingress as `{ type: 'scm', providerId }` from day one.
 */
function upgradeLegacyJobEnvelope(value: unknown): unknown {
	if (typeof value !== 'object' || value === null) return value;
	const raw = value as Record<string, unknown>;
	if (raw.type !== 'github') return value;
	return { ...raw, type: 'scm', providerId: 'github' };
}

export const SwarmJobSchema = z.preprocess(upgradeLegacyJobEnvelope, swarmJobVariants);

export type ScmWebhookJob = z.infer<typeof ScmWebhookJobSchema>;
export type GitHubProjectsWebhookJob = z.infer<typeof GitHubProjectsWebhookJobSchema>;
export type MergeAutomationJob = z.infer<typeof MergeAutomationJobSchema>;
export type SwarmJob = z.infer<typeof swarmJobVariants>;

/**
 * Normalize a payload read straight out of Postgres, where `jobPayload` is a
 * `jsonb` column typed (not validated) as {@link SwarmJob} — so a row written
 * before #385 is *typed* current while still carrying the legacy envelope. Read
 * models must funnel through this before switching on `type`/`kind`; a payload
 * that no longer validates at all is returned untouched, exactly as an unvalidated
 * cast behaved before.
 */
export function normalizeStoredJobPayload(payload: SwarmJob): SwarmJob {
	const parsed = SwarmJobSchema.safeParse(payload);
	return parsed.success ? parsed.data : payload;
}
