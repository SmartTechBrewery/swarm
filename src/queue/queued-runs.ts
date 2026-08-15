/**
 * The queued-runs read model — maps canonical *dispatch* records onto the
 * `runs.queued` API shape (issues #234, #284). Pure and connection-free: the
 * repository (`src/db/repositories/dispatchesRepository.ts`) owns the one
 * DB-touching `listWaitingDispatches()` query; everything here just derives,
 * maps, and orders from the already-loaded rows, so it's unit-testable on its
 * own.
 *
 * Before issue #284 this read an incomplete BullMQ snapshot, which could not
 * see capacity-blocked work and disagreed with the `runs` table about retries.
 * The dispatch table is the single source of truth for pending work, so every
 * pending or retry-scheduled unit of work is visible here — with its state,
 * wait reason, priority, and scheduled time — by construction.
 */

import { z } from 'zod';
import type { DispatchRow } from '../db/repositories/dispatchesRepository.js';
import { PmProviderIdSchema } from '../pm/events.js';
import { ScmProviderIdSchema } from '../scm/events.js';
import { normalizeStoredJobPayload, repositoryForJob, type SwarmJob } from './jobs.js';

/**
 * Best-effort phase the dispatch will likely run, derived from the resolved
 * phase when the worker recorded one, else from fields already on the parsed
 * event — never a GitHub lookup. `board` covers both Planning and
 * Implementation, which are only distinguished at authoritative dispatch (a
 * fresh GraphQL re-read of the card's Status).
 *
 * `unknown` means *undetermined* — an event kind this read model can't classify
 * — and nothing may use it for a case the server has decided (issue #570):
 * whether a board dispatch can start a phase at all is a *proven* fact once the
 * card has been read, and is reported as {@link QueuedBoardOutcomeSchema}.
 */
export const QueuedPhaseHintSchema = z.enum([
	'board',
	'planning',
	'implementation',
	'review',
	'respond-to-review',
	'respond-to-ci',
	'resolve-conflicts',
	'merge-automation',
	'unknown',
]);
export type QueuedPhaseHint = z.infer<typeof QueuedPhaseHintSchema>;

/**
 * What a live board read proved about a *fresh* board (`pm`) dispatch's ability
 * to start a pipeline phase (issue #570):
 *
 * - `starts-phase` — the card's current status maps to Planning or
 *   Implementation, so claiming this dispatch starts that phase.
 * - `no-trigger` — it maps to none. Every board status change SWARM itself makes
 *   produces such a dispatch (Implementation moves a card to `inProgress` as a
 *   status report and GitHub sends the `single_select` change straight back), as
 *   does every human board operation with no pipeline meaning (filing a card,
 *   reordering a column). The dispatch is still recorded, claimed, and settled as
 *   a no-trigger exactly as before — this only states what the server already
 *   knows about it.
 *
 * Resolved by the API's queued-work-item enrichment, the one place that performs
 * the board read, so a dispatch-derived row never carries it. Its *absence* is
 * the undetermined case — no read, a failed read, or a dispatch whose phase the
 * board no longer decides — which is why this is a separate field rather than a
 * {@link QueuedPhaseHintSchema} value: `unknown` is for what the server doesn't
 * know, and this is something it does.
 */
export const QueuedBoardOutcomeSchema = z.enum(['starts-phase', 'no-trigger']);
export type QueuedBoardOutcome = z.infer<typeof QueuedBoardOutcomeSchema>;

/**
 * The queue-facing view of a dispatch's state: `waiting`/`prioritized` for an
 * eligible-now pending dispatch (by queue priority), `blocked` for one an *event*
 * has to wake rather than a timer — a freed project slot, or the task's own
 * checkout freeing (issue #759) — and `delayed` for a scheduled retry.
 */
export const PendingJobStateSchema = z.enum(['waiting', 'prioritized', 'delayed', 'blocked']);
export type PendingJobState = z.infer<typeof PendingJobStateSchema>;

/** Why a waiting dispatch isn't running — mirrors `DispatchWaitReason`. */
export const QueuedWaitReasonSchema = z.enum([
	'project-capacity',
	'rate-limit',
	'agent-capacity',
	'timeout',
	'worker-shutdown',
	'delivery',
	'worktree-exists',
	'stalled',
	'recheck',
	'worker-eligibility',
	'worker-authorization',
	'preserved-worker',
	'task-in-flight',
	'manual-retry',
	'recovered',
]);
export type QueuedWaitReason = z.infer<typeof QueuedWaitReasonSchema>;

/** The normalized SCM lifecycle event kind a review-gate job's metadata was derived from. */
export const ReviewGateSourceEventSchema = z.enum(['pull-request', 'checks']);
export type ReviewGateSourceEvent = z.infer<typeof ReviewGateSourceEventSchema>;

/**
 * Diagnostic metadata for a dispatch whose best-effort {@link QueuedPhaseHint}
 * is `review` (issue #275): a `pull-request`/`checks` lifecycle event
 * that *enters* the `pr-review` trigger handler as a gate input, not proof that
 * a Review agent is already queued — the handler's own PR+SHA dispatch dedup
 * (`review-dispatch-dedup.ts`) folds every such event for the same head SHA
 * into at most one Review run. The UI groups rows carrying the same
 * `(project, repo, PR, headSha)` using this field instead of rendering one
 * `Review queued` row per source event.
 */
export const QueuedReviewGateSchema = z.object({
	sourceEvent: ReviewGateSourceEventSchema,
	/** The normalized `action` on the source event (e.g. `opened`, `updated`, `completed`). */
	sourceAction: z.string().optional(),
	/** The PR head commit SHA this event evaluates — the review dispatch dedup key. */
	headSha: z.string(),
	/** Deferred aggregate-check recheck attempt count, when this job is a coalesced recheck. */
	recheckAttempt: z.number().int().nonnegative().optional(),
	/**
	 * Deferred *read-failure* recheck attempt count (issue #742) — the second,
	 * separate budget a defer can draw on (`SwarmJob.readFailureRecheckAttempt`,
	 * issue #720). Surfaced beside {@link recheckAttempt} rather than folded into
	 * it so a waiting recheck reads honestly while it is still waiting: a row
	 * showing `recheck #0 · provider retry #9` is a source-control outage being
	 * outlasted, not CI taking its time, and the two are told apart here instead
	 * of in the worker log.
	 */
	readFailureRecheckAttempt: z.number().int().nonnegative().optional(),
});
export type QueuedReviewGate = z.infer<typeof QueuedReviewGateSchema>;

/** The `runs.queued` API/UI contract — Zod is the source of truth for this shape. */
export const QueuedRunSchema = z.object({
	/** The canonical dispatch id — the handle Put back / cancel operate on. */
	jobId: z.string(),
	projectId: z.string(),
	/**
	 * What produced the dispatch: `scm` for an SCM job, `pm` for a board job (both
	 * carrying `providerId` separately), or `merge-automation`.
	 */
	type: z.enum(['scm', 'pm', 'merge-automation']),
	/** SCM and `pm` jobs only — the producing provider's id (`github`, `github-projects`). */
	providerId: z.union([ScmProviderIdSchema, PmProviderIdSchema]).optional(),
	state: PendingJobStateSchema,
	phaseHint: QueuedPhaseHintSchema,
	/** Why this dispatch is waiting, when it recorded a reason. */
	waitReason: QueuedWaitReasonSchema.optional(),
	/** The `runs` row this dispatch retries, when one exists (deferred runs). */
	runId: z.string().optional(),
	/** Deferred-retry attempt counter. */
	attempt: z.number().int().nonnegative().optional(),
	/**
	 * The repository this dispatch will run against (`owner/repo`) — `repositoryForJob`
	 * (`./jobs.js`), so it is the same value the worker scopes the project with. Absent
	 * only on a board job written before issue #686 phase 2 routed the card, which runs
	 * against the project's default entry.
	 */
	repo: z.string().optional(),
	/** SCM and `merge-automation` jobs only — the PR/issue number. */
	prNumber: z.string().optional(),
	/** `pm` jobs only — the opaque board item id. */
	workItemNodeId: z.string().optional(),
	/** `pm` jobs only — the provider's display-only content descriptor (`Issue`, `PullRequest`, …). */
	contentType: z.string().optional(),
	/**
	 * `pm` jobs only — what a live board read proved about this dispatch's trigger
	 * (issue #570). Absent unless the API's enrichment resolved it for a dispatch
	 * the card's current status still decides; see {@link QueuedBoardOutcomeSchema}.
	 */
	boardOutcome: QueuedBoardOutcomeSchema.optional(),
	/** Resolved backing Issue/PR title for a board job, when the PM provider can read it. */
	workItemTitle: z.string().optional(),
	/** Resolved backing Issue/PR URL for a board job, when the PM provider can read it. */
	workItemUrl: z.string().optional(),
	/** Effective queue priority; 0 is highest. */
	priority: z.number().int().nonnegative(),
	/**
	 * Whether this dispatch is a prioritized SCM continuation (Review /
	 * Respond-to-review / Respond-to-CI / Resolve-conflicts resumed after a
	 * capacity wait) — the primary key `selectNextCapacityDispatch` orders the
	 * `blocked` bucket by. Read-model only; mirrors `DispatchRow.continuation`.
	 */
	continuation: z.boolean(),
	/**
	 * Whether the project has SCM continuation prioritization active.
	 */
	prioritizeContinuations: z.boolean(),
	/** ISO 8601 — when the dispatch was created. */
	enqueuedAt: z.string(),
	/**
	 * ISO 8601 — when the dispatch became eligible (`DispatchRow.availableAt`).
	 * The capacity wake selector's secondary ordering key, distinct from
	 * `enqueuedAt`: a dispatch deferred to `pending` on a freed slot has its
	 * availability reset to that moment while its creation time stays fixed.
	 */
	availableAt: z.string(),
	/** ISO 8601 — `delayed` dispatches only, scheduled run time. */
	runsAt: z.string().optional(),
	/**
	 * Present only for a `review`-hinted SCM job carrying the PR number and
	 * head SHA needed to classify it safely (see {@link QueuedReviewGateSchema}).
	 */
	reviewGate: QueuedReviewGateSchema.optional(),
});
export type QueuedRun = z.infer<typeof QueuedRunSchema>;

/**
 * Derive a best-effort phase hint purely from the job's already-parsed event —
 * no GitHub network call. Mirrors (but does not replace) the authoritative
 * trigger-handler rules in `src/triggers/handlers/*.ts`, which re-check state
 * at dispatch time.
 */
export function deriveQueuedPhaseHint(job: SwarmJob): QueuedPhaseHint {
	if (job.type === 'pm') return 'board';
	if (job.type === 'merge-automation') return 'merge-automation';

	const { event } = job;
	switch (event.kind) {
		case 'pull-request-review':
			return event.reviewState === 'approved' ? 'review' : 'respond-to-review';
		case 'checks':
			return event.checkConclusion === 'failure' ? 'respond-to-ci' : 'review';
		case 'pull-request':
			return event.action === 'closed' && event.merged === true ? 'resolve-conflicts' : 'review';
		default:
			return 'unknown';
	}
}

/**
 * Extract review-gate diagnostic metadata (see {@link QueuedReviewGateSchema})
 * for an SCM job whose best-effort phase hint is `review` — `undefined`
 * for every other job, and for a review-hinting event missing the PR number or
 * head SHA a safe grouping needs. Never calls the provider — derived purely from
 * the job's already-normalized event, same as {@link deriveQueuedPhaseHint}.
 */
export function deriveReviewGate(job: SwarmJob): QueuedReviewGate | undefined {
	if (job.type !== 'scm') return undefined;
	const { event } = job;
	if (event.kind !== 'pull-request' && event.kind !== 'checks') return undefined;
	if (deriveQueuedPhaseHint(job) !== 'review') return undefined;
	if (!event.workItemId || !event.headSha) return undefined;

	return QueuedReviewGateSchema.parse({
		sourceEvent: event.kind,
		sourceAction: event.action,
		headSha: event.headSha,
		recheckAttempt: job.recheckAttempt,
		readFailureRecheckAttempt: job.readFailureRecheckAttempt,
	});
}

/** The queue-facing state of a waiting dispatch (see {@link PendingJobStateSchema}). */
export function deriveQueuedState(dispatch: DispatchRow): PendingJobState {
	if (dispatch.state === 'retry-scheduled') return 'delayed';
	// The two event-woken pending waits read as `blocked` rather than `waiting`: both
	// are eligible *now* and neither will be picked up until something frees — a
	// project slot, or the task's own earlier phase settling (issues #759 and #761).
	if (dispatch.waitReason === 'project-capacity' || dispatch.waitReason === 'task-in-flight')
		return 'blocked';
	if (dispatch.availableAt.getTime() > Date.now()) return 'delayed';
	return dispatch.priority > 0 ? 'prioritized' : 'waiting';
}

/**
 * The queue-facing phase hint for a waiting dispatch, exactly as the read model
 * renders it: a worker-resolved phase (`dispatch.phase`) is authoritative; the
 * event-derived hint covers dispatches never claimed yet (for a `pm` job that is
 * always `board`). Shared so any caller deciding
 * whether a dispatch is still an unresolved `board` row agrees with the queue
 * view (issue #366).
 */
export function deriveDispatchPhaseHint(dispatch: DispatchRow): QueuedPhaseHint {
	const resolved = QueuedPhaseHintSchema.safeParse(dispatch.phase);
	return resolved.success
		? resolved.data
		: deriveQueuedPhaseHint(normalizeStoredJobPayload(dispatch.jobPayload));
}

function toQueuedRun(dispatch: DispatchRow, prioritizeContinuations: boolean): QueuedRun {
	// A row written before issue #385/#297 still carries the legacy envelope, and the
	// `jsonb` column is typed rather than validated — normalize before reading.
	const data = normalizeStoredJobPayload(dispatch.jobPayload);
	const state = deriveQueuedState(dispatch);
	const reviewGate = deriveReviewGate(data);
	// The repository this dispatch will run against, resolved through the *same*
	// helper the worker scopes its project with (issue #684 phase 2) rather than by
	// re-reading each variant's own field here — so the PR link this row renders and
	// the repository the phase actually runs in cannot drift apart. A board job written
	// before issue #686 phase 2 carries none and keeps the field absent: it runs against
	// the project's default entry and its link comes from `workItemUrl` instead.
	const repo = repositoryForJob(data);
	const shared = {
		jobId: dispatch.id,
		projectId: dispatch.projectId,
		type: data.type,
		...(repo ? { repo } : {}),
		...(data.type === 'scm' || data.type === 'pm' ? { providerId: data.providerId } : {}),
		state,
		phaseHint: deriveDispatchPhaseHint(dispatch),
		waitReason: dispatch.waitReason ?? undefined,
		runId: dispatch.runId ?? undefined,
		attempt: dispatch.attempt,
		priority: dispatch.priority,
		continuation: dispatch.continuation,
		prioritizeContinuations,
		enqueuedAt: dispatch.createdAt.toISOString(),
		availableAt: dispatch.availableAt.toISOString(),
		...(state === 'delayed' ? { runsAt: dispatch.availableAt.toISOString() } : {}),
		...(reviewGate ? { reviewGate } : {}),
	};

	return QueuedRunSchema.parse(
		data.type === 'scm'
			? { ...shared, prNumber: data.event.workItemId }
			: data.type === 'merge-automation'
				? { ...shared, prNumber: data.prNumber }
				: { ...shared, workItemNodeId: data.event.itemId, contentType: data.event.contentType },
	);
}

/**
 * Order to mirror dispatch intent: runnable (`waiting`/`prioritized`) first,
 * capacity-`blocked` next (eligible, waiting on a slot), `delayed` last.
 *
 * Runnable/delayed rows order by priority ascending (0 highest), then FIFO
 * within the same priority — enqueue time for runnable jobs, scheduled run time
 * for delayed ones.
 *
 * The `blocked` bucket deliberately does NOT use generic priority. When a
 * project slot frees, the scheduler picks the next blocked dispatch via
 * `selectNextCapacityDispatch` (`continuation desc, availableAt asc`), so a
 * prioritized SCM continuation wins the freed slot ahead of new work regardless
 * of queue priority. This mirrors that ordering exactly so the displayed order
 * matches the real wake order (issue #374). A `task-in-flight` row shares the
 * bucket (it is event-woken too) and is ordered on `availableAt` within it, which
 * is `listTaskInFlightWaits`' own order — its wake-up doesn't compete for a slot
 * with the capacity rows, it waits on one specific task.
 */
export function sortQueuedRuns(items: QueuedRun[]): QueuedRun[] {
	const stateRank = (state: PendingJobState): number =>
		state === 'delayed' ? 2 : state === 'blocked' ? 1 : 0;
	const timeRank = (item: QueuedRun): number =>
		Date.parse(item.state === 'delayed' ? (item.runsAt ?? item.enqueuedAt) : item.enqueuedAt);

	return [...items].sort((a, b) => {
		const byState = stateRank(a.state) - stateRank(b.state);
		if (byState !== 0) return byState;
		// Both rows are in the same bucket here. Within `blocked`, mirror
		// selectNextCapacityDispatch's wake order (continuation-first, then
		// availableAt) instead of priority/FIFO.
		if (a.state === 'blocked') {
			const aCont = a.prioritizeContinuations && a.continuation;
			const bCont = b.prioritizeContinuations && b.continuation;
			if (aCont !== bCont) return aCont ? -1 : 1;
			return Date.parse(a.availableAt) - Date.parse(b.availableAt);
		}
		if (a.priority !== b.priority) return a.priority - b.priority;
		return timeRank(a) - timeRank(b);
	});
}

/**
 * The read model's entry point: map waiting dispatch rows to the API shape and
 * order them to mirror dispatch. Rows whose stored payload no longer parses are
 * skipped (they can't run either — the worker fails them at claim time).
 */
export function toQueuedRuns(
	dispatches: DispatchRow[],
	projectPolicies: Record<string, boolean> = {},
): QueuedRun[] {
	const mapped: QueuedRun[] = [];
	for (const dispatch of dispatches) {
		try {
			const policy = projectPolicies[dispatch.projectId] ?? true;
			mapped.push(toQueuedRun(dispatch, policy));
		} catch {
			// Malformed payload — the claim path surfaces it; don't break the list.
		}
	}
	return sortQueuedRuns(mapped);
}
