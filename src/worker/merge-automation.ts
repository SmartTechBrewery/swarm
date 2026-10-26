/**
 * Durable merge automation (issue #292, superseding issue #278's standalone
 * follow-up queue): after the Review phase submits an eligible `approve`, the
 * merge intent is persisted as one ADR-002 dispatch (`merge-automation`
 * payload, dedup key `merge:<reviewRunId>`) and executed through the normal
 * dispatch lifecycle — claim, bounded `retry-scheduled` backoff for transient
 * outcomes, terminal completion, reconciler recovery, and cancellation via the
 * standard queue surfaces.
 *
 * **The backoff covers a failing forge too (issue #923).** A `provider-error`
 * used to fail the dispatch on its first occurrence, so a single 502 during a
 * forge incident stranded an approved, clean pull request permanently: this
 * dispatch is deduped on `merge:<reviewRunId>` and the review-verdict ledger
 * already holds a `submitted` slot for that head, so nothing re-created it and
 * a human had to merge by hand. It now shares the one bounded budget
 * `not-ready` already owned, and the two give-ups stay distinguishable by the
 * outcome recorded on the Review run — {@link MERGE_RETRY_EXHAUSTED} means the
 * pull request never became ready, {@link MERGE_PROVIDER_ERROR_EXHAUSTED} means
 * the provider kept failing. Both complete the dispatch as
 * `merge-retry-exhausted`: this executor no longer marks a dispatch `failed` at
 * all.
 *
 * A merge dispatch runs entirely outside the agent pipeline: it only invokes
 * the provider-neutral `ScmMergeProvider` (`src/scm/merge.ts`) under the
 * project's implementer credential — never provisioning a worktree, starting
 * an agent, or resubmitting the review. Every attempt re-reads the PR's
 * current state and re-verifies the approved head, so a retry can never merge
 * newly pushed or no-longer-approved changes. Outcomes persist onto the
 * originating Review run's `review_merge_*` columns (same dashboard surface
 * as before).
 *
 * **Re-verifying a stale head (issue #874).** An approval proves the diff was
 * read; it does not prove the *tree the merge would produce* was ever built. So
 * when the merge capability answers `stale-base` — the head is behind the base
 * it would land on — this dispatch does not merge. It brings the head up to
 * date through `ScmMergeProvider.updatePullRequestBranch`, re-pins itself to the
 * commit that produced, waits for **that** head's CI, and merges only once it is
 * green. Everything about it is bounded and per-pull-request:
 *
 *  - the update happens at the moment *this* pull request's own merge is
 *    attempted — no open pull request is kept continuously up to date, and the
 *    merge queue below is what stops two of them doing it at once;
 *  - it is allowed {@link MAX_BASE_UPDATES} times, after which the pull request
 *    is handed to a human rather than looping against a faster-moving base;
 *  - a conflicting update and a red fresh CI each settle terminally *and comment
 *    on the pull request* — refused rather than merged on stale evidence;
 *  - a provider that cannot update a branch at all (Bitbucket Cloud, gitlab.com,
 *    Azure DevOps Services) has the update done on a SWARM worker instead (issue
 *    #1117): a catch-up pass of the Resolve-conflicts phase merges the base into
 *    the branch with no agent and pushes it pinned to the approved head, and its
 *    result comes back to this dispatch to be settled exactly as the provider's
 *    own update would be ({@link requestWorkerBranchUpdate},
 *    {@link adoptWorkerBranchUpdate});
 *  - the head the update produces pre-claims its own PR+SHA review-dispatch slot
 *    so re-verification costs no `REVIEW_VERDICT_CAP` slot.
 *
 * **Every head is checked before it is merged (issue #1124).** An approval
 * proves the diff was read; it does not prove CI passed. A Review dispatched off
 * `opened` (issue #1123), or one that waited for a worker while CI changed under
 * it, can approve a head whose checks are still running or already red — and on
 * a repository with no branch protection nothing else refuses that merge. So
 * every attempt reads the head's aggregate checks first, with the classifier and
 * per-repository `reviewChecks` policy the pipeline itself uses: a red head is
 * refused terminally with a PR comment and left to Respond-to-CI, a pending one
 * waits on the ordinary bounded budget (keeping its merge-queue turn), and only a
 * green one is offered to the merge capability. A head refused while red, or
 * given up on while pending, is re-armed once when its checks later complete
 * green (issue #1128, {@link rearmMergeAutomationForGreenHead}).
 *
 * **A refusal the head caused frees the approval's cap slot (issue #1079).**
 * When a terminal `not-eligible` is explained *only* by the pull request's head
 * having moved since the review — in practice Resolve-conflicts pushing a merge
 * of a fast-moving base — the dispatch stamps that approval's review-verdict
 * slot `superseded_at` ({@link markApprovalSupersededByHeadChange}), so the pass
 * stops spending one of `REVIEW_VERDICT_CAP`'s three slots and the pull request
 * is reviewed again at its current head instead of stalling green, mergeable and
 * permanently unreviewed. Decided by one provider-neutral `getPullRequest` read
 * rather than a structured refusal reason, and written on the two head-moved
 * paths only — never on a red-head refusal, which is a real failure.
 *
 * **One merge per repository at a time (issue #1114).** Freshness checked per
 * pull request is not enough on its own: two approved pull requests can each read
 * "up to date", merge seconds apart, and land a combination nothing built. So the
 * critical section — staleness check → update → fresh CI → merge — runs for at
 * most one merge dispatch per `(project, repository)` at a time, which is
 * `(project, repository, base branch)` in practice: every SWARM-managed pull
 * request targets its repository's configured base (one that targets another
 * branch is over-serialized, never under).
 *
 *  - **The lock is derived, not stored.** The queue's head is the earliest-created
 *    live merge dispatch for the key ({@link resolveMergeQueueTurn}) — arrival
 *    order, the instant each approval recorded its intent. Every contender already
 *    is a durable dispatch with a lease and a reaper, so a second store would only
 *    add a release step that can be forgotten and a TTL that can disagree with the
 *    dispatch's own. A holder whose lease has lapsed (`classifyDispatchClaim`) is
 *    bypassed at once, which is how a dead holder's turn is reclaimed.
 *  - **A holder keeps its turn across its own retries** — a `retry-scheduled`
 *    holder waiting on its updated head's CI is still the head. That is the point,
 *    and the cost: about one merge per CI duration per base branch.
 *  - **Everyone else waits as `merge-queue`**, re-checked every
 *    {@link MERGE_QUEUE_RECHECK_MS} and woken earlier by every terminal ending of
 *    the holder ({@link settleMergeDispatch}), with no retry budget spent and a
 *    {@link MERGE_QUEUED} outcome on the Review run naming the pull request ahead.
 *  - **Head-of-line blocking is bounded by the budgets that already exist**: each
 *    head gets {@link MAX_MERGE_RETRIES} retries and there are at most
 *    {@link MAX_BASE_UPDATES} + 1 heads, while every refusal settles at once.
 *  - **Dependencies cannot be inverted by arrival order**: Implementation's
 *    dependency gate does not start a blocked item until its blockers are done, so
 *    a dependent's pull request — let alone its approval — never exists before its
 *    blocker merged.
 *
 * **A `merged` outcome also settles what the merge absorbed (issue #959).** When
 * this pull request's Review runs declared they traced a split sibling's whole
 * scope through its diff, that sibling is closed as part of the same merge —
 * `src/dispatch/absorbed-child-settle.ts` owns the decision and every guard on
 * it; this module only tells it a merge happened, plus the one source-control
 * fact those guards need and cannot read for themselves: the task the pull
 * request was written for, decoded from its head branch.
 */

import type { ProjectConfig } from '../config/schema.js';
import {
	adoptWorkerBranchUpdateIntoWaitingMerge,
	completeDispatch,
	type DispatchOutcome,
	type DispatchRow,
	type DispatchWaitReason,
	EXECUTING_DISPATCH_STATES,
	findDispatchByDedupKey,
	getActiveDispatchByRunId,
	listActiveMergeDispatchesForRepository,
	scheduleDispatchRetry,
	WAITING_DISPATCH_STATES,
} from '../db/repositories/dispatchesRepository.js';
import { markReviewVerdictSuperseded } from '../db/repositories/reviewVerdictsRepository.js';
import {
	findApprovedReviewRunForRearm,
	markReviewRunSuperseded,
	updateReviewMergeOutcome,
} from '../db/repositories/runsRepository.js';
import { settleAbsorbedChildren } from '../dispatch/absorbed-child-settle.js';
import { classifyDispatchClaim } from '../dispatch/claim-liveness.js';
import {
	createAndPublishDispatch,
	promoteMergeQueueWaits,
	publishDispatchWakeUp,
} from '../dispatch/dispatcher.js';
import { requireProjectSCMProvider } from '../integrations/scm/registry.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { issueNumberFromBranch } from '../pipeline/task-branch.js';
import {
	MERGE_CATCH_UP_ACTION,
	type MergeAutomationJob,
	type MergeCatchUpRequest,
	normalizeStoredJobPayload,
} from '../queue/jobs.js';
import type {
	MergePullRequest,
	MergePullRequestOutcome,
	UpdatePullRequestBranch,
	UpdatePullRequestBranchOutcome,
	WorkerBranchUpdateOutcome,
} from '../scm/merge.js';
import { SWARM_GENERATED_FOOTER } from '../scm/swarm-origin.js';
import type { SCMProvider } from '../scm/types.js';
import { decideAggregateCheckOutcome } from '../triggers/handlers/aggregate-check-decision.js';
import {
	buildReviewDispatchKey,
	claimReviewDispatch,
	refreshReviewDispatchClaim,
} from '../triggers/review-dispatch-dedup.js';

/**
 * Terminal outcome recorded once the bounded retry budget is spent while the
 * pull request itself never became ready.
 */
export const MERGE_RETRY_EXHAUSTED = 'retry-exhausted' as const;

/**
 * Terminal outcome recorded once that *same* bounded budget is spent against a
 * source-control provider that kept failing (issue #923). Distinct from
 * {@link MERGE_RETRY_EXHAUSTED} on purpose: run history has to tell "the forge
 * kept failing" apart from a refusal SWARM decided on its own, and both
 * complete the dispatch through the one `merge-retry-exhausted` outcome — the
 * same "same dispatch outcome, distinguishable run outcome" split issue #874
 * settled on for `stale-base`.
 */
export const MERGE_PROVIDER_ERROR_EXHAUSTED = 'provider-error-exhausted' as const;

/**
 * The one *waiting* outcome that is not a provider answer (issue #1114): the
 * dispatch has not attempted its merge because another pull request in the same
 * repository holds the merge queue. Its message names that pull request and how
 * long it has held the queue; it is overwritten by the dispatch's own first
 * attempt once its turn comes.
 */
export const MERGE_QUEUED = 'queued' as const;

/** Every value the `runs.review_merge_outcome` column can hold. */
export type ReviewMergeOutcomeStatus =
	| MergePullRequestOutcome['status']
	| typeof MERGE_RETRY_EXHAUSTED
	| typeof MERGE_PROVIDER_ERROR_EXHAUSTED
	| typeof MERGE_QUEUED;

/**
 * Bounded backoff, coded constants — merge retry policy is intentionally not
 * project-configurable, mirroring the fixed budget the rate-limit retry loop
 * uses (`MAX_RATE_LIMIT_RETRIES`, `src/worker/consumer.ts`). The delay doubles
 * from 15s up to a 5-minute ceiling: GitHub's own review-state propagation
 * typically clears within seconds, so seven total attempts (the immediate one
 * plus six retries) comfortably rides that out while staying bounded.
 */
export const MAX_MERGE_RETRIES = 6;
const MERGE_RETRY_BASE_DELAY_MS = 15_000;
const MERGE_RETRY_MAX_DELAY_MS = 5 * 60_000;

/**
 * How many times one merge dispatch may bring its pull request's head up to date
 * with the base before giving up (issue #874). Coded, on
 * {@link MAX_MERGE_RETRIES}'s precedent — this is a safety bound, not an
 * operator dial.
 *
 * Two, because each update costs a full CI round: one covers the ordinary case
 * (something landed on the base while this pull request was being reviewed), the
 * second covers losing that race once more, and a pull request that is *still*
 * behind after two rounds is losing it systematically — the base is moving
 * faster than this repository's CI, which no number of further retries fixes and
 * a human should see.
 */
export const MAX_BASE_UPDATES = 2;

/**
 * How often a dispatch waiting for its turn on the merge queue re-reads it
 * (issue #1114). A fallback, not the signal: every terminal ending of the holder
 * wakes the next waiter at once ({@link settleMergeDispatch}), so this only paces
 * the endings that do not — a holder cancelled from the Queue or reaped on a
 * lapsed lease. One Postgres read per waiter per minute, and no provider call.
 * Coded on {@link MAX_MERGE_RETRIES}'s precedent.
 */
export const MERGE_QUEUE_RECHECK_MS = 60_000;

/**
 * TTL the updated head's PR+SHA review-dispatch claim is held for, sized to
 * outlast the whole post-update merge budget: the retry after an update fires at
 * 15s and the six `not-ready` retries behind it span ~13 minutes
 * ({@link mergeRetryDelayMs}), so 15 minutes covers every attempt this dispatch
 * can still make, with margin. Sized here rather than shared with
 * `ci-no-fix-recovery.ts`'s own TTL: the two cover different waits and neither
 * should move because the other did.
 */
const UPDATED_HEAD_CLAIM_TTL_SEC = 15 * 60;

/** The delay before retry attempt `attempt` (1-indexed; attempt 0 is the immediate one). */
export function mergeRetryDelayMs(attempt: number): number {
	return Math.min(
		MERGE_RETRY_MAX_DELAY_MS,
		MERGE_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1),
	);
}

/**
 * The dispatch dedup identity for a Review run's merge intent. Keyed on the
 * run (not the PR/head) so each approving Review run carries exactly one
 * durable *initial* merge dispatch — a crash-retried creation, a webhook
 * redelivery, or the startup backfill can never mint a second — while a fresh
 * approval (a new Review run) still gets its own. The one other merge dispatch a
 * run can carry is a re-arm, once per approved head ({@link mergeRearmDedupKey}).
 */
export function mergeDispatchDedupKey(reviewRunId: string): string {
	return `merge:${reviewRunId}`;
}

/**
 * The dedup identity of the one merge re-arm a Review run gets for an approved
 * head whose checks later complete green (issue #1128,
 * {@link rearmMergeAutomationForGreenHead}). Keyed on the run *and* the head, so
 * sibling `checks` events and redeliveries for that head mint nothing more.
 */
export function mergeRearmDedupKey(reviewRunId: string, headSha: string): string {
	return `merge-rearm:${reviewRunId}:${headSha}`;
}

/**
 * The merge outcomes a now-green approved head can clear (issue #1128): the
 * red-head refusal (`not-eligible`, issue #1124) and a budget spent waiting for
 * the approved head's pending checks ({@link MERGE_RETRY_EXHAUSTED}). A
 * `not-eligible` with another cause is re-armed too and refused again, harmlessly,
 * because the merge re-verifies the approval and the head. `policy-blocked`,
 * `unsupported` and {@link MERGE_PROVIDER_ERROR_EXHAUSTED} are left out: a green
 * head changes none of them.
 */
export const MERGE_REARM_OUTCOMES = ['not-eligible', MERGE_RETRY_EXHAUSTED] as const;

/** The outcome `processJob` returns for a settled merge-automation dispatch. */
export interface MergeAutomationSettledOutcome {
	status: 'merge-automation-settled';
	result: ReviewMergeOutcomeStatus | 'retry-scheduled';
	prNumber: string;
}

export interface RequestMergeAutomationInput {
	project: ProjectConfig;
	/** The completed Review run whose `approve` this merge executes. */
	reviewRunId: string;
	/** The Review phase's task id — recorded on the dispatch for the Queue UI. */
	taskId: string;
	prNumber: string;
	/** The reviewed head SHA the approval covers. */
	approvedHeadSha: string;
}

/**
 * Persist a Review approval's merge intent as a durable dispatch and publish
 * its wake-up — intent lands in Postgres before any execution is attempted
 * (ADR-002's outbox order), so it survives worker/Redis restarts and is
 * visible/cancellable on the queue surfaces immediately. Called from the
 * worker's Review success path (`src/worker/consumer.ts`) — never from
 * pipeline code, which must not schedule queue work (`ai/RULES.md` §2).
 * Best-effort: a creation failure is logged, never thrown — the Review phase
 * already settled successfully, and a bookkeeping failure must not turn that
 * into a failed job.
 */
export async function requestMergeAutomation(input: RequestMergeAutomationInput): Promise<void> {
	try {
		const { dispatch, created } = await createAndPublishDispatch({
			projectId: input.project.id,
			jobPayload: buildMergeAutomationJob(
				input.project,
				input.reviewRunId,
				input.prNumber,
				input.approvedHeadSha,
			),
			dedupKey: mergeDispatchDedupKey(input.reviewRunId),
			source: 'synthetic',
			runId: input.reviewRunId,
			taskId: input.taskId,
			phase: 'merge-automation',
		});
		logger.info(
			created
				? 'Review approval: persisted durable merge dispatch'
				: 'Review approval: merge dispatch already exists — not duplicating',
			{
				dispatchId: dispatch.id,
				runId: input.reviewRunId,
				prNumber: input.prNumber,
				headSha: input.approvedHeadSha,
			},
		);
	} catch (err) {
		logger.error('Failed to persist merge dispatch after Review approval', {
			runId: input.reviewRunId,
			prNumber: input.prNumber,
			error: describeError(err),
		});
	}
}

/** The payload of a merge dispatch for the head a Review run approved. */
function buildMergeAutomationJob(
	project: ProjectConfig,
	reviewRunId: string,
	prNumber: string,
	headSha: string,
): MergeAutomationJob {
	return {
		type: 'merge-automation',
		projectId: project.id,
		reviewRunId,
		repo: project.repo,
		prNumber,
		approvedHeadSha: headSha,
		// The same SHA today, and deliberately a second field: `approvedHeadSha` is
		// re-written by a base update (issue #874) while the ledger slot stays where
		// the review was (issue #1079).
		reviewedHeadSha: headSha,
	};
}

export interface RearmMergeAutomationInput {
	project: ProjectConfig;
	prNumber: string;
	/** The head whose checks just completed green. */
	headSha: string;
}

/**
 * Re-arm merge automation for an approved head whose checks have since completed
 * green (issue #1128) — called by the `pr-review` trigger when a green aggregate
 * meets a review-verdict slot already `submitted` for that head, instead of
 * dropping the event as a same-head retry.
 *
 * The head's own merge dispatch stopped while it was red or pending ({@link
 * MERGE_REARM_OUTCOMES}), and its `merge:<reviewRunId>` key can never be created
 * again, so this creates one more under {@link mergeRearmDedupKey} — at most one
 * per (approving run, head). It is the ordinary merge dispatch: it re-reads the
 * head's checks before merging, so a head that reads red again is still refused
 * (issue #1124), and it takes its turn on the merge queue.
 *
 * Does nothing unless merge automation is on for the repository (the rule
 * `requestMergeAutomationForApproval` applies), a Review run approved this head
 * and its merge stopped with a re-armable outcome without being superseded, and
 * no dispatch is still active on that run — an active merge dispatch reads the
 * green head itself. Best-effort like {@link requestMergeAutomation}: a failure
 * is logged, never thrown, so it cannot fail the trigger evaluation.
 */
export async function rearmMergeAutomationForGreenHead({
	project,
	prNumber,
	headSha,
}: RearmMergeAutomationInput): Promise<void> {
	if (project.autoMerge !== true) return;
	const context = { projectId: project.id, prNumber, headSha };
	try {
		const run = await findApprovedReviewRunForRearm(
			{ projectId: project.id, repository: project.repo, prNumber, headSha },
			MERGE_REARM_OUTCOMES,
		);
		if (!run) {
			logger.debug('Merge automation: no stopped approval to re-arm for this head', context);
			return;
		}
		const active = await getActiveDispatchByRunId(run.id);
		if (active) {
			logger.debug('Merge automation: the approving run still has a dispatch due — not re-arming', {
				...context,
				runId: run.id,
				dispatchId: active.id,
			});
			return;
		}
		const { dispatch, created } = await createAndPublishDispatch({
			projectId: project.id,
			jobPayload: buildMergeAutomationJob(project, run.id, prNumber, headSha),
			dedupKey: mergeRearmDedupKey(run.id, headSha),
			source: 'synthetic',
			runId: run.id,
			taskId: run.taskId,
			phase: 'merge-automation',
		});
		logger.info(
			created
				? 'Merge automation: re-armed for an approved head whose checks turned green'
				: 'Merge automation: already re-armed for this head — not duplicating',
			{ ...context, runId: run.id, dispatchId: dispatch.id },
		);
	} catch (err) {
		logger.error('Failed to re-arm merge automation for a green approved head', {
			...context,
			error: describeError(err),
		});
	}
}

/** Map a terminal, non-retryable refusal onto its dispatch completion outcome. */
const TERMINAL_MERGE_OUTCOMES: Partial<Record<MergePullRequestOutcome['status'], DispatchOutcome>> =
	{
		merged: 'merged',
		'not-eligible': 'merge-not-eligible',
		'policy-blocked': 'merge-policy-blocked',
		unsupported: 'merge-unsupported',
	};

/**
 * Map a *retryable* outcome onto the run outcome recorded once its bounded
 * budget is spent — the counterpart of {@link TERMINAL_MERGE_OUTCOMES}, so the
 * whole settlement policy reads as one pair of tables.
 *
 * `provider-error` belongs here (issue #923) because every refusal an adapter
 * can *name* already leaves through a terminal status of its own — GitHub's
 * `classifyDirectMergeError` routes 403 to `policy-blocked`, 405/409 to
 * `not-ready`, a required merge queue to `unsupported` — so what reaches this
 * module as `provider-error` is the residue: 5xx, transport failures, and the
 * occasional unusable credential. That residue is exactly as retryable as
 * `not-ready`, and it was getting one attempt instead of seven.
 *
 * What still settles a genuinely non-retryable provider error terminally is the
 * *bound*, not a predicate: sniffing HTTP status or message text here would put
 * provider-specific shapes into shared worker code (`ai/RULES.md` §2), and the
 * honest place for that split is the adapters' own classifiers. A permanently
 * broken credential therefore costs the budget and then settles as
 * {@link MERGE_PROVIDER_ERROR_EXHAUSTED}, carrying the provider's own last
 * message — and the *first* failed attempt already persists `provider-error`
 * onto the Review run, so the dashboard names the reason from second one.
 */
const RETRYABLE_MERGE_OUTCOMES = {
	'not-ready': MERGE_RETRY_EXHAUSTED,
	'provider-error': MERGE_PROVIDER_ERROR_EXHAUSTED,
} as const satisfies Partial<Record<MergePullRequestOutcome['status'], ReviewMergeOutcomeStatus>>;

/** The exhaustion outcome for a retryable status, or `undefined` when it is terminal. */
function retryableExhaustion(
	status: MergePullRequestOutcome['status'],
): ReviewMergeOutcomeStatus | undefined {
	return (RETRYABLE_MERGE_OUTCOMES as Partial<Record<string, ReviewMergeOutcomeStatus>>)[status];
}

/**
 * What the Review run records once the budget is spent. The plain `not-ready`
 * wording is unchanged byte-for-byte — it is already in run history — while the
 * provider-error one names the forge, the attempts spent, and the provider's own
 * last error, which is the only place that detail would otherwise be lost.
 *
 * A `not-ready` budget spent on a head **this dispatch produced** keeps the last
 * reason too (issue #1113): there it is the fresh CI nothing else watches — a
 * self-hosted runner that is offline never starts it — and the reason names the
 * checks still pending, so the operator can tell a stuck runner from a moving
 * base or a red build. The existing budget still bounds that wait; nothing here
 * waits longer for it. The approved head's own checks (issue #1124) are waited
 * for on the same budget and named the same way.
 */
function exhaustionMessage(
	job: MergeAutomationJob,
	exhaustion: ReviewMergeOutcomeStatus,
	lastMessage: string,
): string {
	if (exhaustion === MERGE_PROVIDER_ERROR_EXHAUSTED)
		return `Merge automation gave up after ${MAX_MERGE_RETRIES + 1} attempts against a source-control provider that kept failing; the pull request is approved but was left open for a manual merge. Last provider error: ${lastMessage}`;
	// The worker-side update this dispatch asked for never landed (issue #1117) —
	// a worker that never picked it up, or a catch-up run that failed.
	if (job.workerCatchUp?.requestedFor === job.approvedHeadSha)
		return `Merge automation asked a SWARM worker to bring this pull request's head up to date with its base and gave up after ${MAX_MERGE_RETRIES + 1} attempts waiting for that update; the pull request is approved but was left open for a manual merge. Last reason: ${lastMessage}`;
	if (baseUpdatesSpent(job) > 0)
		return `Merge automation brought this pull request's head up to date with its base and gave up after ${MAX_MERGE_RETRIES + 1} attempts waiting for that head to become mergeable; the pull request is approved but was left open for a manual merge. Last reason: ${lastMessage}`;
	if (lastMessage.startsWith(WAITING_FOR_APPROVED_HEAD_CHECKS))
		return `Merge automation waited ${MAX_MERGE_RETRIES + 1} attempts for the approved head's checks to finish and gave up; the pull request is approved and left open, and SWARM merges it once its checks complete green. Last reason: ${lastMessage}`;
	return 'Merge automation gave up after repeated not-ready results; the pull request is approved but was left open for a manual merge.';
}

/**
 * Persist an attempt's outcome onto the Review run row — best-effort, logged.
 *
 * `advancedFrom` is the head this write *replaces*, passed only by the one write
 * that advances the approved head onto a base update: the row's own guard
 * (`updateReviewMergeOutcome`) otherwise refuses a write whose head differs from
 * the generation already recorded, which is exactly what protects a superseded
 * review's leftover attempt — and would equally have silenced every write after
 * an advance.
 */
async function persistMergeOutcome(
	job: MergeAutomationJob,
	status: ReviewMergeOutcomeStatus,
	message: string,
	attempt: number,
	advancedFrom?: string,
): Promise<void> {
	try {
		await updateReviewMergeOutcome(job.reviewRunId, {
			status,
			message,
			attempt,
			approvedHeadSha: job.approvedHeadSha,
			advancedFrom,
		});
	} catch (err) {
		logger.error("Failed to persist the merge attempt's outcome on the Review run", {
			runId: job.reviewRunId,
			error: describeError(err),
		});
	}
}

/**
 * The provider capabilities one merge attempt may need, each defaulting to the
 * project's registered provider. Injectable as a whole so a test can drive the
 * dispatch without a registry, exactly as the merge capability alone used to be.
 */
export interface MergeAutomationCapabilities {
	mergePullRequest?: MergePullRequest;
	updatePullRequestBranch?: UpdatePullRequestBranch;
	getAggregateCheckStatus?: SCMProvider['getAggregateCheckStatus'];
	commentOnPullRequest?: SCMProvider['commentOnPullRequest'];
	getPullRequest?: SCMProvider['getPullRequest'];
	/**
	 * Not a provider capability: how a stale head is handed to a SWARM worker when
	 * the provider cannot update the branch itself (issue #1117). Defaults to
	 * {@link requestMergeCatchUp}, and is injectable for the same reason the rest is.
	 */
	requestMergeCatchUp?: (input: RequestMergeCatchUpInput) => Promise<void>;
}

/**
 * One capability off the project's registered provider, resolved fresh at the
 * moment it is used. Never call this outside a `try` that can settle the
 * dispatch — `requireProjectSCMProvider` throws for an unresolvable provider,
 * and that has to land on the same `provider-error` path as any other provider
 * failure rather than escaping `processJob`.
 */
function scmCapability<K extends Exclude<keyof MergeAutomationCapabilities, 'requestMergeCatchUp'>>(
	project: ProjectConfig,
	key: K,
): NonNullable<MergeAutomationCapabilities[K]> {
	const scm = requireProjectSCMProvider(project);
	return scm[key].bind(scm) as NonNullable<MergeAutomationCapabilities[K]>;
}

/** How many base updates this dispatch has already spent (absent on a pre-#874 payload). */
function baseUpdatesSpent(job: MergeAutomationJob): number {
	return job.baseUpdates ?? 0;
}

/**
 * What the CI on the head this dispatch is about to merge says right now.
 *
 * Asked about every head before it is merged — the approved one as much as one
 * this dispatch produced by updating the branch (issue #874). An approval does
 * not prove the approved head is green (issue #1124): a Review dispatched off
 * `opened`, or one that queued while CI changed, can approve a head whose checks
 * are still running or already red, and the commit an update produces has never
 * been judged by anything. Relying on the provider's own merge endpoint to refuse
 * a pending or red head would make the guarantee a property of the repository's
 * branch protection — the alternative issue #872 explicitly set aside, and one a
 * private repository on a free plan cannot even configure.
 *
 * Judged with the *same* classifier and the same repository policy the `pr-review`
 * handler uses ({@link decideAggregateCheckOutcome}), so a head is never green
 * to merge automation and red to the pipeline. A repository that opts into
 * `if-present` accepts a zero-check answer here exactly as it does there.
 */
type FreshCheckVerdict =
	| { kind: 'green' }
	| { kind: 'pending'; message: string }
	| { kind: 'red'; failedChecks: string[] };

async function readFreshCheckVerdict(
	job: MergeAutomationJob,
	project: ProjectConfig,
	capabilities: MergeAutomationCapabilities,
): Promise<FreshCheckVerdict> {
	const read =
		capabilities.getAggregateCheckStatus ?? scmCapability(project, 'getAggregateCheckStatus');
	// Implementer: the persona this dispatch merges as, so one attempt does not
	// speak as two different accounts (the same reason `readBaseBranchHealth`
	// passes it explicitly — the contract's reads disagree on their defaults).
	const checks = await read(project, job.approvedHeadSha, 'implementer');
	const decision = decideAggregateCheckOutcome(
		checks,
		job.prNumber,
		project.reviewChecks ?? 'required',
	);
	if (decision.action === 'defer') return { kind: 'pending', message: decision.message };
	if (decision.action === 'respond-to-ci')
		return { kind: 'red', failedChecks: decision.failedChecks };
	return { kind: 'green' };
}

/**
 * Post the notice that merge automation refused this pull request, in the shape
 * `scmCommentCiFixGaveUp` (`src/triggers/handlers/review.ts`) uses: an *extra* on
 * top of the durable outcome, so a provider that cannot be reached costs the
 * comment and not the record. Never throws.
 *
 * Only the refusals issue #874 introduces comment, plus the red approved head
 * issue #1124 refuses on the same grounds. The pre-existing terminal
 * outcomes (a moved head, a policy block, …) are left exactly as they were —
 * they are reported on the dashboard, and adding a comment to them is a separate
 * decision from this one.
 */
async function commentOnMergeRefusal(
	job: MergeAutomationJob,
	project: ProjectConfig,
	capabilities: MergeAutomationCapabilities,
	body: string,
): Promise<void> {
	try {
		const comment =
			capabilities.commentOnPullRequest ?? scmCapability(project, 'commentOnPullRequest');
		await comment(
			project,
			Number(job.prNumber),
			`${body}\n\n---\n${SWARM_GENERATED_FOOTER}`,
			'implementer',
		);
	} catch (err) {
		logger.error('Merge automation: failed to post the terminal refusal comment', {
			runId: job.reviewRunId,
			prNumber: job.prNumber,
			error: describeError(err),
		});
	}
}

/** Why a refusal over a head behind its base matters — the default middle paragraph. */
const BEHIND_BASE_CONSEQUENCE = [
	'Merging it as it stands would land a change nothing has built against the',
	'current base, which is how two independently green pull requests combine',
	'into a red base branch. No branch changes were made by this attempt.',
].join('\n');

/** Why a refusal over a red approved head matters (issue #1124). */
const RED_HEAD_CONSEQUENCE = [
	'Merge automation merges only a head whose checks are green under this',
	"repository's `reviewChecks` policy, however its approving review was started.",
	'No branch changes were made by this attempt.',
].join('\n');

/** The notice for a refusal SWARM will not retry — one paragraph plus what a human should do. */
function mergeRefusalCommentBody(
	reason: string,
	nextStep: string,
	consequence: string = BEHIND_BASE_CONSEQUENCE,
): string {
	return [
		'## ⚠️ SWARM refused to merge this pull request',
		'',
		reason,
		'',
		consequence,
		'',
		nextStep,
	].join('\n');
}

/**
 * Claim the PR+SHA review-dispatch slot for the head an update just produced.
 *
 * Without it the `checks completed` event that head's own CI emits reaches the
 * `pr-review` trigger, which dispatches a **Review** — one of
 * `REVIEW_VERDICT_CAP`'s three verdict slots spent re-reading a diff that has
 * not changed, per update. A pull request bumped twice would arrive at its merge
 * with no slots left, so re-verification would cost it the ability to be
 * reviewed again at all. The claim makes the trigger skip that head instead, and
 * this dispatch stays the one thing waiting on its CI.
 *
 * Held for {@link UPDATED_HEAD_CLAIM_TTL_SEC} rather than the dedup module's
 * default five minutes: CI routinely outlasts that, and a claim that lapses
 * mid-wait is the same slot burnt a few minutes later. Best-effort — a claim
 * that cannot be taken (Redis down, or something already holds the slot) is
 * logged and the merge proceeds, since the cost is a wasted Review rather than a
 * wrong merge.
 */
async function claimUpdatedHeadReviewSlot(
	project: ProjectConfig,
	job: MergeAutomationJob,
	headSha: string,
): Promise<void> {
	const key = buildReviewDispatchKey(project.repo, job.prNumber, headSha);
	const claimed = await claimReviewDispatch(key, 'merge-automation', {
		prNumber: job.prNumber,
		headSha,
	});
	if (!claimed) {
		logger.warn('Merge automation: could not claim the review slot for the updated head', {
			runId: job.reviewRunId,
			prNumber: job.prNumber,
			headSha,
		});
		return;
	}
	await refreshReviewDispatchClaim(key, UPDATED_HEAD_CLAIM_TTL_SEC);
}

/**
 * Move the dispatch to `retry-scheduled` and wake it at `availableAt`. Persist
 * the retry intent before any queue work (ADR-002): a crash here leaves a
 * durable `retry-scheduled` row the reconciler re-publishes.
 */
async function scheduleMergeRetry(
	dispatchId: string,
	jobPayload: MergeAutomationJob,
	attempt: number,
	delayMs: number,
	wait: { waitReason: DispatchWaitReason; lastError?: string } = { waitReason: 'recheck' },
): Promise<void> {
	const updated = await scheduleDispatchRetry(dispatchId, {
		jobPayload,
		availableAt: new Date(Date.now() + delayMs),
		waitReason: wait.waitReason,
		attempt,
		lastError: wait.lastError,
	});
	if (!updated) return;
	try {
		await publishDispatchWakeUp(updated);
	} catch (err) {
		logger.warn('Failed to publish merge-retry wake-up (reconciler will repair)', {
			dispatchId,
			error: describeError(err),
		});
	}
}

/**
 * End this dispatch's turn on the merge queue: complete it, then wake the next
 * dispatch waiting for the same repository (issue #1114). Every terminal ending
 * goes through here so none can forget the second half — a forgotten wake-up
 * would cost the next pull request a {@link MERGE_QUEUE_RECHECK_MS} wait, never a
 * stuck queue, since the waiters' own timers are underneath. A `retry-scheduled`
 * ending deliberately does not: the dispatch is still the queue's holder.
 */
async function settleMergeDispatch(
	dispatch: DispatchRow,
	job: MergeAutomationJob,
	project: ProjectConfig,
	outcome: DispatchOutcome,
): Promise<void> {
	await completeDispatch(dispatch.id, outcome);
	await promoteMergeQueueWaits(project.id, job.repo);
}

/**
 * Whether this dispatch may run the merge's critical section now (issue #1114):
 * `head` carries the job with its turn stamped, `behind` the sentence that says
 * what it is waiting for.
 */
type MergeQueueTurn =
	| { kind: 'head'; job: MergeAutomationJob }
	| { kind: 'behind'; message: string; context: Record<string, unknown> };

/** `4m07s` — the "has held the queue for" clause; minutes are not rolled into hours. */
function formatQueueDuration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

/**
 * Decide whether this dispatch holds its repository's merge queue (issue #1114).
 *
 * The queue is the project's non-terminal merge dispatches for the repository in
 * arrival order ({@link listActiveMergeDispatchesForRepository}), minus any
 * `leased`/`running` row whose lease has lapsed — `classifyDispatchClaim`'s
 * `stale`, the reaper's own verdict reached without waiting for its cadence, so a
 * holder whose worker died stops blocking the moment its lease does. This
 * dispatch is the head when nothing live precedes it.
 *
 * Fails **open**: a queue read that throws, or an answer that somehow lacks this
 * dispatch's own just-claimed row, lets it proceed. The worst case is the
 * unserialized merge every dispatch made before the queue existed, whereas failing
 * closed would wedge every merge in the repository on a Postgres hiccup.
 *
 * The holder's turn length reads its own stamp, or — before its stamp is persisted
 * by a retry — when its row last changed state, which for a claimed holder is its
 * claim.
 */
async function resolveMergeQueueTurn(
	dispatch: DispatchRow,
	job: MergeAutomationJob,
	project: ProjectConfig,
	now = new Date(),
): Promise<MergeQueueTurn> {
	const head = (): MergeQueueTurn => {
		if (!job.queueTurnStartedAt) {
			logger.info('Merge automation: at the head of the merge queue', {
				dispatchId: dispatch.id,
				runId: job.reviewRunId,
				prNumber: job.prNumber,
				repo: job.repo,
				baseBranch: project.baseBranch,
			});
		}
		return {
			kind: 'head',
			job: { ...job, queueTurnStartedAt: job.queueTurnStartedAt ?? now.toISOString() },
		};
	};

	let queue: DispatchRow[];
	try {
		queue = await listActiveMergeDispatchesForRepository(project.id, job.repo);
	} catch (err) {
		logger.warn('Merge automation: could not read the merge queue — merging unserialized', {
			dispatchId: dispatch.id,
			runId: job.reviewRunId,
			prNumber: job.prNumber,
			repo: job.repo,
			error: describeError(err),
		});
		return head();
	}

	const live = queue.filter(
		(row) => row.id === dispatch.id || classifyDispatchClaim(row, now) !== 'stale',
	);
	const position = live.findIndex((row) => row.id === dispatch.id);
	const ahead = position === -1 ? [] : live.slice(0, position);
	const holder = ahead[0];
	if (!holder) return head();

	const holderJob = holder.jobPayload.type === 'merge-automation' ? holder.jobPayload : undefined;
	const holderPr = holderJob ? `#${holderJob.prNumber}` : 'an unknown pull request';
	const turnStartedAt = holderJob?.queueTurnStartedAt
		? new Date(holderJob.queueTurnStartedAt)
		: holder.updatedAt;
	const holderTurnMs = now.getTime() - turnStartedAt.getTime();
	const count = ahead.length === 1 ? '1 pull request' : `${ahead.length} pull requests`;
	return {
		kind: 'behind',
		message: `Waiting for the merge queue of ${job.repo} (${project.baseBranch}): ${count} ahead, next ${holderPr} (dispatch ${holder.id}, ${holder.state}), which has held the queue for ${formatQueueDuration(holderTurnMs)}.`,
		context: {
			dispatchId: dispatch.id,
			runId: job.reviewRunId,
			prNumber: job.prNumber,
			repo: job.repo,
			baseBranch: project.baseBranch,
			queuePosition: ahead.length,
			holderDispatchId: holder.id,
			holderPrNumber: holderJob?.prNumber,
			holderState: holder.state,
			holderTurnMs,
		},
	};
}

/**
 * What the `stale-base` branch decided: either the dispatch is settled, or the
 * attempt carries on down the ordinary bounded backoff with the outcome handed
 * back here — which is how the update call's own `provider-error` reaches the
 * same shared budget as the merge call's (issue #923) rather than adding a
 * second policy.
 */
type StaleBaseReaction =
	| { kind: 'settled'; outcome: MergeAutomationSettledOutcome }
	| { kind: 'retry'; outcome: MergePullRequestOutcome };

/** A branch update that produced something to act on — every status but `up-to-date`. */
type ProducedBranchUpdate = Exclude<WorkerBranchUpdateOutcome, { status: 'up-to-date' }>;

/** Who brought the head up to date: the provider's own update, or a SWARM worker (issue #1117). */
type BranchUpdateSource = 'provider' | 'worker';

function settledOutcome(
	job: MergeAutomationJob,
	result: MergeAutomationSettledOutcome['result'],
): MergeAutomationSettledOutcome {
	return { status: 'merge-automation-settled', result, prNumber: job.prNumber };
}

/**
 * React to a head that is behind its base: bring it up to date, re-pin the
 * approval to the commit that produced, and let the fresh CI decide (issue
 * #874). Every exit is either a scheduled retry or a *visible* terminal
 * settlement — never a merge.
 *
 * A provider that cannot update a branch at all hands the update to a SWARM
 * worker instead (issue #1117, {@link requestWorkerBranchUpdate}), and the
 * result that worker reports later is settled by {@link applyBranchUpdate}
 * exactly as the provider's own would have been.
 */
async function reactToStaleBase(
	dispatch: DispatchRow,
	job: MergeAutomationJob,
	project: ProjectConfig,
	staleMessage: string,
	attempt: number,
	capabilities: MergeAutomationCapabilities,
): Promise<StaleBaseReaction> {
	const spent = baseUpdatesSpent(job);

	if (spent >= MAX_BASE_UPDATES) {
		// Settled as `merge-retry-exhausted` — the queue's existing vocabulary for
		// "a bounded budget ran out", which this is; the Review run's own outcome
		// records `stale-base` so the reason stays distinguishable from a run of
		// `not-ready` results.
		const message = `Merge automation brought this pull request's head up to date with its base ${spent} times and it is behind again; the base is moving faster than this pull request can be verified, so it needs a human.`;
		await persistMergeOutcome(job, 'stale-base', message, attempt);
		await commentOnMergeRefusal(
			job,
			project,
			capabilities,
			mergeRefusalCommentBody(
				`Its head was brought up to date with the base ${spent} times and the base moved again each time, so SWARM stopped rather than starting another round of checks.`,
				'Merge it manually once the base is quiet, or re-run the checks against an up-to-date head.',
			),
		);
		logger.warn('Merge automation: base-update budget exhausted, leaving the PR open', {
			dispatchId: dispatch.id,
			runId: job.reviewRunId,
			prNumber: job.prNumber,
			baseUpdates: spent,
		});
		await settleMergeDispatch(dispatch, job, project, 'merge-retry-exhausted');
		return { kind: 'settled', outcome: settledOutcome(job, 'stale-base') };
	}

	let update: UpdatePullRequestBranchOutcome;
	try {
		const updateBranch =
			capabilities.updatePullRequestBranch ?? scmCapability(project, 'updatePullRequestBranch');
		update = await updateBranch(project, Number(job.prNumber), job.approvedHeadSha);
	} catch (err) {
		update = { status: 'provider-error', message: describeError(err) };
	}

	if (update.status === 'up-to-date') {
		// A race: something advanced the branch between the merge attempt that
		// reported `stale-base` and this call. Nothing to settle — the ordinary
		// backoff re-reads and merges.
		return {
			kind: 'retry',
			outcome: {
				status: 'not-ready',
				message: `${staleMessage}, but it is already up to date now`,
			},
		};
	}

	if (update.status === 'unsupported') {
		return requestWorkerBranchUpdate(dispatch, job, project, update.message, attempt, capabilities);
	}

	if (update.status === 'provider-error') {
		// The same transient class the merge call itself can meet, in the same
		// dispatch during the same merge — so it is handed back to the one shared
		// bounded budget instead of stranding the pull request here. Which call
		// failed travels in the message, preserving the diagnostic the removed
		// `logger.error` carried without logging the same failure twice.
		return {
			kind: 'retry',
			outcome: {
				status: 'provider-error',
				message: `failed to bring the head up to date with the base: ${update.message}`,
			},
		};
	}

	return {
		kind: 'settled',
		outcome: await applyBranchUpdate(
			dispatch,
			job,
			project,
			update,
			attempt,
			capabilities,
			'provider',
		),
	};
}

/**
 * Settle a branch update that produced something — the provider's own (issue
 * #874) or a SWARM worker's (issue #1117), through the same three branches, so a
 * pull request on Bitbucket, GitLab or Azure DevOps is advanced, refused and
 * commented on exactly as one on GitHub is.
 */
async function applyBranchUpdate(
	dispatch: DispatchRow,
	job: MergeAutomationJob,
	project: ProjectConfig,
	update: ProducedBranchUpdate,
	attempt: number,
	capabilities: MergeAutomationCapabilities,
	source: BranchUpdateSource,
): Promise<MergeAutomationSettledOutcome> {
	switch (update.status) {
		case 'updated':
			return advanceOntoUpdatedHead(dispatch, job, project, update.headSha, attempt, source);
		case 'head-moved':
			return settleHeadMovedDuringUpdate(
				dispatch,
				job,
				project,
				update.message,
				attempt,
				capabilities,
			);
		case 'conflict':
			return settleConflictingUpdate(dispatch, job, project, update.message, attempt, capabilities);
	}
}

/**
 * Re-pin the approval onto the head an update produced and wait for that head's
 * own CI. The approval is carried onto a commit built from the reviewed diff plus
 * the base, at SWARM's request and attributed to that request before it was
 * reported (`src/scm/merge.ts`'s header states why that is sound for both the
 * provider's update and a SWARM worker's, and `head-moved` is what an
 * unattributable head gets instead). What the advance invalidates is the
 * verification, and the reset budget below is this dispatch waiting for the
 * replacement.
 */
async function advanceOntoUpdatedHead(
	dispatch: DispatchRow,
	job: MergeAutomationJob,
	project: ProjectConfig,
	headSha: string,
	attempt: number,
	source: BranchUpdateSource,
): Promise<MergeAutomationSettledOutcome> {
	// `workerCatchUp` belonged to the head being replaced, so it is not carried.
	const { workerCatchUp: _consumed, ...rest } = job;
	const advanced: MergeAutomationJob = {
		...rest,
		approvedHeadSha: headSha,
		baseUpdates: baseUpdatesSpent(job) + 1,
	};
	const where = source === 'worker' ? ' on a SWARM worker' : '';
	const advancedMessage = `Brought the head up to date with the base${where} (${job.approvedHeadSha} → ${headSha}); the approval carries forward and the merge waits for this head's own checks.`;
	await persistMergeOutcome(advanced, 'stale-base', advancedMessage, attempt, job.approvedHeadSha);
	await claimUpdatedHeadReviewSlot(project, job, headSha);
	// `attempt: 0` resets the not-ready budget: the fresh CI is a new wait, not
	// a continuation of whatever the old head was waiting for.
	await scheduleMergeRetry(dispatch.id, advanced, 0, mergeRetryDelayMs(1), {
		waitReason: 'recheck',
		lastError: advancedMessage,
	});
	logger.info('Merge automation: advanced the approved head onto the base', {
		dispatchId: dispatch.id,
		runId: job.reviewRunId,
		prNumber: job.prNumber,
		previousHeadSha: job.approvedHeadSha,
		headSha,
		baseUpdates: advanced.baseUpdates,
		source,
	});
	return settledOutcome(job, 'retry-scheduled');
}

/**
 * The branch's head is not the reviewed commit and not the update's commit either
 * — somebody pushed. `approvedHeadSha` deliberately stays where it is: this is the
 * same `not-eligible` a pushed head has always produced, and the push's own Review
 * is what clears it.
 */
async function settleHeadMovedDuringUpdate(
	dispatch: DispatchRow,
	job: MergeAutomationJob,
	project: ProjectConfig,
	message: string,
	attempt: number,
	capabilities: MergeAutomationCapabilities,
): Promise<MergeAutomationSettledOutcome> {
	await persistMergeOutcome(job, 'not-eligible', message, attempt);
	await commentOnMergeRefusal(
		job,
		project,
		capabilities,
		mergeRefusalCommentBody(
			`Its head is behind the base, and while SWARM was bringing it up to date the branch moved to a commit SWARM did not ask for: ${message}`,
			'SWARM will pick the pull request up again from the review of the head that is there now.',
		),
	);
	logger.warn('Merge automation: the head moved while it was being updated', {
		dispatchId: dispatch.id,
		runId: job.reviewRunId,
		prNumber: job.prNumber,
		approvedHeadSha: job.approvedHeadSha,
		message,
	});
	// The head moved out from under the approval, which is exactly what must not
	// spend a review-cap slot (issue #1079).
	await markApprovalSupersededByHeadChange(job, project, capabilities);
	await settleMergeDispatch(dispatch, job, project, 'merge-not-eligible');
	return settledOutcome(job, 'not-eligible');
}

/**
 * The base does not merge into the head cleanly. Deliberately *not* stamped
 * superseded (issue #1079): a conflicting update means the base does not merge
 * into the head, not that the head moved, so the approval keeps its slot.
 * Resolving it is the Resolve-conflicts phase's job, not merge automation's.
 */
async function settleConflictingUpdate(
	dispatch: DispatchRow,
	job: MergeAutomationJob,
	project: ProjectConfig,
	message: string,
	attempt: number,
	capabilities: MergeAutomationCapabilities,
): Promise<MergeAutomationSettledOutcome> {
	await persistMergeOutcome(job, 'not-eligible', message, attempt);
	await commentOnMergeRefusal(
		job,
		project,
		capabilities,
		mergeRefusalCommentBody(
			`Its head is behind the base and the base does not merge into it cleanly: ${message}`,
			'Resolve the conflict on the branch; SWARM will pick the pull request up again from its next review.',
		),
	);
	logger.warn('Merge automation: cannot update a conflicting head', {
		dispatchId: dispatch.id,
		runId: job.reviewRunId,
		prNumber: job.prNumber,
		message,
	});
	await settleMergeDispatch(dispatch, job, project, 'merge-not-eligible');
	return settledOutcome(job, 'not-eligible');
}

/**
 * The provider cannot update the branch itself (issue #1117): ask a SWARM worker
 * that holds the repository to merge the base into it, and wait for that.
 *
 * The update has to run where a checkout is. This dispatch runs agent-less on
 * the control plane, which may have none, and a federated worker may have no
 * database — so the update is its own dispatch (a catch-up pass of the
 * Resolve-conflicts phase, {@link requestMergeCatchUp}) and its result reaches
 * this one through {@link adoptWorkerBranchUpdate}, which hands it in for the next
 * attempt to settle with {@link applyBranchUpdate}.
 *
 * Asked once per approved head (`workerCatchUp.requestedFor`): the first ask
 * parks this dispatch with the attempt budget reset — the update is a new wait,
 * sized like the one after the provider's own update — and every attempt after
 * it, until the result arrives, is an ordinary `not-ready` on that budget that
 * does not offer the merge at all ({@link awaitingWorkerBranchUpdate}). The
 * budget is therefore what bounds the wait for a worker that never answers, and
 * this dispatch keeps the merge queue's turn throughout.
 */
async function requestWorkerBranchUpdate(
	dispatch: DispatchRow,
	job: MergeAutomationJob,
	project: ProjectConfig,
	providerMessage: string,
	attempt: number,
	capabilities: MergeAutomationCapabilities,
): Promise<StaleBaseReaction> {
	const requested =
		job.workerCatchUp?.requestedFor === job.approvedHeadSha ? job.workerCatchUp : undefined;
	if (requested) {
		return {
			kind: 'retry',
			outcome: {
				status: 'not-ready',
				message:
					requested.result?.status === 'up-to-date'
						? 'the provider reports the head behind its base, but the SWARM worker that went to update it found the base already merged in'
						: WAITING_FOR_WORKER_UPDATE,
			},
		};
	}

	try {
		await (capabilities.requestMergeCatchUp ?? requestMergeCatchUp)({ project, job });
	} catch (err) {
		return {
			kind: 'retry',
			outcome: {
				status: 'not-ready',
				message: `could not ask a SWARM worker to bring the head up to date with the base: ${describeError(err)}`,
			},
		};
	}

	const parked: MergeAutomationJob = {
		...job,
		workerCatchUp: { requestedFor: job.approvedHeadSha },
	};
	const message = `This source-control provider cannot bring the head up to date with the base itself (${providerMessage}), so a SWARM worker is merging the base into it; the merge waits for that head and its own checks.`;
	await persistMergeOutcome(parked, 'stale-base', message, attempt);
	await scheduleMergeRetry(dispatch.id, parked, 0, mergeRetryDelayMs(1), {
		waitReason: 'recheck',
		lastError: message,
	});
	logger.info('Merge automation: asked a SWARM worker to bring the stale head up to date', {
		dispatchId: dispatch.id,
		runId: job.reviewRunId,
		prNumber: job.prNumber,
		approvedHeadSha: job.approvedHeadSha,
	});
	return { kind: 'settled', outcome: settledOutcome(job, 'retry-scheduled') };
}

/** The dedup identity of the catch-up one merge dispatch asks for one approved head. */
export function mergeCatchUpDedupKey(reviewRunId: string, approvedHeadSha: string): string {
	return `merge-catch-up:${reviewRunId}:${approvedHeadSha}`;
}

export interface RequestMergeCatchUpInput {
	project: ProjectConfig;
	/** The merge dispatch's payload — the head to update and the Review run to hand back to. */
	job: MergeAutomationJob;
}

/**
 * Persist the worker-side branch update a merge dispatch needs (issue #1117) as a
 * durable dispatch of its own: a synthetic `scm` job the `resolve-conflicts`
 * handler turns into a catch-up pass of that phase, pinned to the approved head.
 * Deduped per (Review run, approved head), so a crash-retried request can never
 * mint a second. Throws on failure — the caller treats it as a transient wait.
 */
export async function requestMergeCatchUp({
	project,
	job,
}: RequestMergeCatchUpInput): Promise<void> {
	const request: MergeCatchUpRequest = {
		reviewRunId: job.reviewRunId,
		headSha: job.approvedHeadSha,
	};
	const { dispatch, created } = await createAndPublishDispatch({
		projectId: project.id,
		jobPayload: {
			type: 'scm',
			providerId: requireProjectSCMProvider(project).type,
			projectId: project.id,
			mergeCatchUp: request,
			event: {
				kind: 'pull-request',
				action: MERGE_CATCH_UP_ACTION,
				repoFullName: job.repo,
				workItemId: job.prNumber,
				isCommentEvent: false,
				headSha: job.approvedHeadSha,
			},
		},
		dedupKey: mergeCatchUpDedupKey(job.reviewRunId, job.approvedHeadSha),
		source: 'synthetic',
		taskId: `${job.prNumber}-conflicts`,
		phase: 'resolve-conflicts',
	});
	logger.info(
		created
			? 'Merge automation: persisted the worker-side branch update dispatch'
			: 'Merge automation: worker-side branch update dispatch already exists — not duplicating',
		{
			dispatchId: dispatch.id,
			runId: job.reviewRunId,
			prNumber: job.prNumber,
			headSha: job.approvedHeadSha,
		},
	);
}

/**
 * The worker-side branch update handed back into this payload that is still to
 * be settled — `up-to-date` excepted, which has nothing to apply and lets the
 * attempt merge as usual.
 */
function handedBackBranchUpdate(job: MergeAutomationJob): ProducedBranchUpdate | undefined {
	const catchUp = job.workerCatchUp;
	if (!catchUp?.result || catchUp.requestedFor !== job.approvedHeadSha) return undefined;
	return catchUp.result.status === 'up-to-date' ? undefined : catchUp.result;
}

/** The `not-ready` reason while the worker-side branch update is still out. */
const WAITING_FOR_WORKER_UPDATE =
	'waiting for a SWARM worker to bring the head up to date with the base';

/** The `not-ready` reason while the approved head's own checks are still running (issue #1124). */
const WAITING_FOR_APPROVED_HEAD_CHECKS = 'waiting for the checks on the approved head';

/**
 * Whether the worker-side branch update this dispatch asked for its approved head
 * has not reported yet. While it has not, the merge is not offered at all: the
 * worker may already have pushed its merge commit, and a merge capability asked
 * to merge the approved head would read that commit as a push nobody reviewed —
 * a terminal `not-eligible` that supersedes the approval and drops the update the
 * hand-back is about to deliver. A head behind its base cannot merge anyway, so
 * the wait costs nothing; the attempt budget still bounds it.
 */
function awaitingWorkerBranchUpdate(job: MergeAutomationJob): boolean {
	const catchUp = job.workerCatchUp;
	return catchUp?.requestedFor === job.approvedHeadSha && !catchUp.result;
}

/** How often, and how far apart, the hand-back retries a merge dispatch caught mid-attempt. */
const HAND_BACK_ATTEMPTS = 5;
const HAND_BACK_RETRY_MS = 2_000;

export interface AdoptWorkerBranchUpdateInput {
	project: ProjectConfig;
	/** The Review run whose merge dispatch asked for the update. */
	reviewRunId: string;
	/** The approved head the update was asked for. */
	headSha: string;
	outcome: WorkerBranchUpdateOutcome;
}

/**
 * Hand a worker-side branch update's result to the merge dispatch waiting on it
 * (issue #1117) — called at the composition root once the catch-up run settles.
 *
 * It does not settle anything itself. The merge dispatch owns its payload and its
 * lifecycle, and every write that settles one is conditional on the claim it
 * holds, so the result is adopted into the waiting row ({@link
 * adoptWorkerBranchUpdateIntoWaitingMerge}) and the dispatch is woken to apply it
 * under its own claim with {@link applyBranchUpdate}: the advance, the review-slot
 * pre-claim and the reset budget for `updated`, and the same terminal outcome and
 * comment as the provider's own update for `conflict` and `head-moved`.
 *
 * Adopted only while the dispatch is still waiting for *this* update — the same
 * approved head, the catch-up recorded as requested for it. A merge dispatch
 * caught mid-attempt is read again a few times, {@link HAND_BACK_RETRY_MS} apart,
 * since an attempt is a handful of provider reads; anything else — no dispatch,
 * a settled one, one that has moved past this head — drops the result with a
 * line, and the dispatch's own budget is what covers it. Returns whether it was
 * adopted.
 */
export async function adoptWorkerBranchUpdate(
	input: AdoptWorkerBranchUpdateInput,
	sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<boolean> {
	const context = {
		projectId: input.project.id,
		runId: input.reviewRunId,
		headSha: input.headSha,
		status: input.outcome.status,
	};
	for (let tries = 1; ; tries += 1) {
		const handed = await tryAdoptWorkerBranchUpdate(input, context);
		if (handed !== 'busy') return handed === 'adopted';
		if (tries >= HAND_BACK_ATTEMPTS) {
			logger.warn(
				'Merge automation: the merge dispatch stayed busy — dropping the branch update',
				context,
			);
			return false;
		}
		await sleep(HAND_BACK_RETRY_MS);
	}
}

/**
 * One read-and-adopt pass of {@link adoptWorkerBranchUpdate}: `busy` when the merge
 * dispatch is mid-attempt (or won the compare-and-set race) and is worth reading
 * again, `dropped` when it is not waiting for this update at all.
 */
async function tryAdoptWorkerBranchUpdate(
	input: AdoptWorkerBranchUpdateInput,
	context: Record<string, unknown>,
): Promise<'adopted' | 'dropped' | 'busy'> {
	// The run's active dispatch first: a re-armed merge (issue #1128) is not keyed
	// `merge:<reviewRunId>`, and a run carries at most one active dispatch.
	const dispatch =
		(await getActiveDispatchByRunId(input.reviewRunId)) ??
		(await findDispatchByDedupKey(mergeDispatchDedupKey(input.reviewRunId)));
	const payload = dispatch ? normalizeStoredJobPayload(dispatch.jobPayload) : undefined;
	const waiting = WAITING_DISPATCH_STATES.some((state) => state === dispatch?.state);
	const executing = EXECUTING_DISPATCH_STATES.some((state) => state === dispatch?.state);
	if (!dispatch || payload?.type !== 'merge-automation' || (!waiting && !executing)) {
		logger.warn('Merge automation: no active merge dispatch to hand the branch update to', {
			...context,
			state: dispatch?.state,
		});
		return 'dropped';
	}
	if (
		payload.approvedHeadSha !== input.headSha ||
		payload.workerCatchUp?.requestedFor !== input.headSha
	) {
		logger.warn('Merge automation: the merge dispatch has moved past this branch update', {
			...context,
			dispatchId: dispatch.id,
			approvedHeadSha: payload.approvedHeadSha,
		});
		return 'dropped';
	}
	if (!waiting) return 'busy';
	const adopted = await adoptWorkerBranchUpdateIntoWaitingMerge(dispatch.id, dispatch.wakeSeq, {
		...payload,
		workerCatchUp: { requestedFor: input.headSha, result: input.outcome },
	});
	if (!adopted) return 'busy';
	try {
		await publishDispatchWakeUp(adopted);
	} catch (err) {
		logger.warn('Failed to publish the merge wake-up (reconciler will repair)', {
			...context,
			dispatchId: dispatch.id,
			error: describeError(err),
		});
	}
	logger.info('Merge automation: handed the worker-side branch update to its merge', {
		...context,
		dispatchId: dispatch.id,
	});
	return 'adopted';
}

/**
 * Record that this approval was superseded, when the pull request's head moved
 * after the review (issue #1079) — which frees the ledger slot's
 * `REVIEW_VERDICT_CAP` allowance so the pull request is reviewed again at its
 * current head instead of stopping green, mergeable and permanently unreviewed.
 *
 * Asked only on a terminal `not-eligible`, and answered by one provider read
 * rather than by a structured refusal reason on `MergePullRequestOutcome`, for
 * the reason `../dispatch/force-re-review.ts` states for the identical read: the
 * current head is in no row SWARM holds, the question is "did the head move",
 * and `not-eligible`'s other causes (drafted, closed, the approval dismissed)
 * all leave it where it was. Sniffing a provider's own prose for the answer is
 * what `ai/RULES.md` §2 forbids in shared code.
 *
 * The key is `reviewedHeadSha` — the head the Review reviewed — never the
 * possibly-advanced `approvedHeadSha` (issue #874), because the ledger slot
 * stays where the review was.
 *
 * The Review run row is stamped too (`runs.review_superseded_at`, issue #1080),
 * right after the ledger, so the dashboard can show which passes counted.
 *
 * Best-effort throughout: a read or write failure is logged and the settle is
 * unchanged. The worst case is today's behaviour — the slot keeps counting and
 * the pull request needs an operator's Force re-review.
 */
async function markApprovalSupersededByHeadChange(
	job: MergeAutomationJob,
	project: ProjectConfig,
	capabilities: MergeAutomationCapabilities,
): Promise<void> {
	const reviewedHeadSha = job.reviewedHeadSha ?? job.approvedHeadSha;
	try {
		const read = capabilities.getPullRequest ?? scmCapability(project, 'getPullRequest');
		// Implementer: the persona this dispatch merges as, so one attempt does not
		// speak as two different accounts.
		const details = await read(project, Number(job.prNumber), 'implementer');
		if (details.headSha === reviewedHeadSha) {
			logger.debug('Merge automation: the head is unchanged — the refusal had another cause', {
				runId: job.reviewRunId,
				prNumber: job.prNumber,
				reviewedHeadSha,
			});
			return;
		}
		const stamped = await markReviewVerdictSuperseded({
			projectId: project.id,
			repository: job.repo,
			prNumber: job.prNumber,
			headSha: reviewedHeadSha,
		});
		// The run-row copy (issue #1080), so the runs list can tell this pass from one
		// that spent a cap slot without a ledger read per row. Written whether or not
		// the ledger stamp landed just now: a retry after a crash between the two
		// writes finds the ledger already stamped, and must still reach the run row.
		const runStamped = await markReviewRunSuperseded(job.reviewRunId);
		const context = {
			runId: job.reviewRunId,
			prNumber: job.prNumber,
			reviewedHeadSha,
			currentHeadSha: details.headSha,
			runStamped,
		};
		if (stamped) {
			logger.info(
				'Merge automation: the approval was superseded by a head change — it no longer spends a review-cap slot',
				context,
			);
		} else {
			logger.warn(
				'Merge automation: no submitted review slot to mark superseded (already stamped, or never recorded)',
				context,
			);
		}
	} catch (err) {
		logger.warn('Merge automation: could not record the superseded approval', {
			runId: job.reviewRunId,
			prNumber: job.prNumber,
			reviewedHeadSha,
			error: describeError(err),
		});
	}
}

/** What one merge attempt came back with, before any of it is settled. */
interface MergeAttempt {
	outcome: MergePullRequestOutcome;
	/** Set only when the attempt refused because the head it was about to merge is red. */
	redFreshChecks: string[] | null;
}

/**
 * Ask for the merge: verify the head's checks first, then
 * hand the pull request to the provider-neutral merge capability. Never throws
 * — an unreachable provider comes back as `provider-error` so the caller
 * settles it the way it settles every other provider failure.
 */
async function attemptMerge(
	job: MergeAutomationJob,
	project: ProjectConfig,
	capabilities: MergeAutomationCapabilities,
): Promise<MergeAttempt> {
	// Resolving the defaults *inside* the try, not in default parameters: an
	// unresolvable provider (nothing registered, or a `project.scm` naming one that is
	// unregistered or not runtime-ready — `requireProjectSCMProvider`) would
	// otherwise throw during parameter binding, before the dispatch can be settled.
	// It must fail the same way any other provider failure does — `provider-error`
	// → outcome persisted on the Review run → `failDispatch` — rather than escaping
	// `processJob` and leaving a claimed dispatch in flight.
	try {
		const merge = capabilities.mergePullRequest ?? scmCapability(project, 'mergePullRequest');
		// Every head is verified before it is offered to the merge capability at
		// all — before the staleness check too, so a red approved head is refused
		// without first being brought up to date. A head this dispatch produced has
		// never been judged by anything, and an approval does not prove the approved
		// head is green either (issue #1124).
		const updated = baseUpdatesSpent(job) > 0;
		const freshChecks = await readFreshCheckVerdict(job, project, capabilities);
		if (freshChecks.kind === 'pending') {
			// The head's own CI has not finished. Ordinary backoff — for an updated
			// head the budget was reset when it advanced, so this is the wait it exists for.
			return {
				outcome: {
					status: 'not-ready',
					message: updated
						? `waiting for the checks on the head brought up to date with the base: ${freshChecks.message}`
						: `${WAITING_FOR_APPROVED_HEAD_CHECKS}: ${freshChecks.message}`,
				},
				redFreshChecks: null,
			};
		}
		if (freshChecks.kind === 'red') {
			const failed = freshChecks.failedChecks.join(', ');
			return {
				outcome: {
					status: 'not-eligible',
					message: updated
						? `the head brought up to date with the base fails its checks (${failed}); the reviewed diff and the current base do not combine cleanly`
						: `the approved head fails its checks (${failed}); merge automation does not merge a head whose checks are red`,
				},
				redFreshChecks: freshChecks.failedChecks,
			};
		}
		return {
			outcome: await merge(project, Number(job.prNumber), job.approvedHeadSha),
			redFreshChecks: null,
		};
	} catch (err) {
		return {
			outcome: { status: 'provider-error', message: describeError(err) },
			redFreshChecks: null,
		};
	}
}

/**
 * The task the merged pull request was written for, decoded from its head branch
 * — the one input the settle's own-task guard cannot recover for itself (issue
 * #959).
 *
 * Read here rather than passed down from the Review run row, because a Review
 * run's `taskId` is the *pull request's* number rather than the issue's
 * (`src/triggers/handlers/review.ts`), so the two are never comparable. SWARM
 * names every task branch `<branchPrefix><taskId>` (`GitWorktreeManager.provision`),
 * which is the same provider-agnostic derivation the PR-ownership gate
 * (`isSwarmManagedPullRequest`) and the PR-driven phases'
 * board-card lookup (`resolveBoardItemIdForPrBranch`) already answer from.
 *
 * `undefined` when the read failed or the head branch encodes no task; the settle
 * then does nothing, which is the safe direction — see its module header.
 */
async function resolveOwnTaskId(
	job: MergeAutomationJob,
	project: ProjectConfig,
	capabilities: MergeAutomationCapabilities,
): Promise<string | undefined> {
	try {
		const read = capabilities.getPullRequest ?? scmCapability(project, 'getPullRequest');
		// Implementer: the persona this dispatch merges as, so one attempt does not
		// speak as two different accounts.
		const details = await read(project, Number(job.prNumber), 'implementer');
		return issueNumberFromBranch(details.headBranch, project.branchPrefix, { strict: true });
	} catch (err) {
		logger.warn('Merge automation: could not resolve the pull request’s own task', {
			projectId: project.id,
			prNumber: job.prNumber,
			error: describeError(err),
		});
		return undefined;
	}
}

/**
 * Settle the split siblings this pull request's Review runs declared it absorbed
 * (issue #959) — the only board work a merge dispatch does, and the reason it is
 * delegated rather than inlined: this module deliberately knows the DB and the
 * SCM merge capability, not a PM provider. Resolving `ownTaskId` here is the same
 * split: the branch behind a pull request is an SCM fact, and the settle stays
 * free of the source-control contract.
 *
 * Runs after `completeDispatch`, never before: the merge is the fact the settle
 * is licensed by, and the dispatch's own outcome must not depend on it. Wrapped
 * even though {@link settleAbsorbedChildren} already fails open, because the
 * guarantee being kept here is this executor's — a merge that has happened is
 * never reported as anything else on account of a board error.
 */
async function settleChildrenThisMergeAbsorbed(
	dispatch: DispatchRow,
	job: MergeAutomationJob,
	project: ProjectConfig,
	capabilities: MergeAutomationCapabilities,
): Promise<void> {
	try {
		await settleAbsorbedChildren({
			project,
			dispatchId: dispatch.id,
			repository: job.repo,
			prNumber: job.prNumber,
			// Lazy: only a pull request that actually declared a fold-in pays the read.
			resolveOwnTaskId: () => resolveOwnTaskId(job, project, capabilities),
		});
	} catch (err) {
		logger.error('Merge automation: settling the absorbed split siblings failed', {
			dispatchId: dispatch.id,
			runId: job.reviewRunId,
			prNumber: job.prNumber,
			error: describeError(err),
		});
	}
}

/**
 * The head about to be merged is red. Refused, and said out loud on the pull
 * request — merging it would be exactly the red base this exists to prevent.
 *
 * For a head this dispatch produced that is the point of the whole exercise: the
 * reviewed diff and the current base are each fine and their combination is not.
 * For the approved head itself (issue #1124) the review approved a commit whose
 * CI failed; the failure belongs to Respond-to-CI, which the `pr-review` trigger
 * routes this head to on its own, so nothing here races it.
 */
async function refuseRedHead(
	dispatch: DispatchRow,
	job: MergeAutomationJob,
	project: ProjectConfig,
	message: string,
	redFreshChecks: string[],
	attempt: number,
	capabilities: MergeAutomationCapabilities,
): Promise<MergeAutomationSettledOutcome> {
	const failed = redFreshChecks.join(', ');
	const updated = baseUpdatesSpent(job) > 0;
	await persistMergeOutcome(job, 'not-eligible', message, attempt);
	await commentOnMergeRefusal(
		job,
		project,
		capabilities,
		updated
			? mergeRefusalCommentBody(
					`SWARM brought this pull request's head up to date with the base and the resulting commit fails its checks: ${failed}. Each side is green on its own; together they are not.`,
					'Fix the combination on this branch — the failure is real, and it is what this pull request would have landed.',
				)
			: mergeRefusalCommentBody(
					`The review approved head \`${job.approvedHeadSha}\`, but that head fails its checks: ${failed}.`,
					'SWARM handles the failing checks the same way as for any red pull request (Respond-to-CI, when it is enabled for this repository), and a fixed head gets its own review before it can merge. If the failure was spurious, re-run the failing checks: once they pass, SWARM merges this head — it re-arms the merge once per approved head.',
					RED_HEAD_CONSEQUENCE,
				),
	);
	logger.warn(
		updated
			? 'Merge automation: the updated head is red — refusing the merge'
			: 'Merge automation: the approved head is red — refusing the merge',
		{
			dispatchId: dispatch.id,
			runId: job.reviewRunId,
			prNumber: job.prNumber,
			headSha: job.approvedHeadSha,
			failedChecks: redFreshChecks,
		},
	);
	// Deliberately *not* stamped superseded (issue #1079), and returned before
	// the terminal branch that would: this refusal is a genuinely red head — a
	// merged tree, or the approved commit itself — not a supersession. The
	// approval must keep its slot — freeing it would buy re-reviews of a head
	// that is actually broken.
	await settleMergeDispatch(dispatch, job, project, 'merge-not-eligible');
	return settledOutcome(job, 'not-eligible');
}

/**
 * A retryable outcome: schedule the next attempt on the bounded, doubling
 * backoff, or — on the attempt that spends the budget — settle with the
 * exhaustion outcome that names why.
 */
async function retryOrExhaust(
	dispatch: DispatchRow,
	job: MergeAutomationJob,
	project: ProjectConfig,
	outcome: MergePullRequestOutcome,
	retryExhaustion: ReviewMergeOutcomeStatus,
	attempt: number,
): Promise<MergeAutomationSettledOutcome> {
	const nextAttempt = attempt + 1;
	if (nextAttempt > MAX_MERGE_RETRIES) {
		await persistMergeOutcome(
			job,
			retryExhaustion,
			exhaustionMessage(job, retryExhaustion, outcome.message),
			attempt,
		);
		logger.warn('Merge automation: retry budget exhausted, leaving the PR open', {
			dispatchId: dispatch.id,
			runId: job.reviewRunId,
			prNumber: job.prNumber,
			outcome: retryExhaustion,
			reason: outcome.message,
		});
		await settleMergeDispatch(dispatch, job, project, 'merge-retry-exhausted');
		return {
			status: 'merge-automation-settled',
			result: retryExhaustion,
			prNumber: job.prNumber,
		};
	}
	await persistMergeOutcome(job, outcome.status, outcome.message, attempt);
	await scheduleMergeRetry(dispatch.id, job, nextAttempt, mergeRetryDelayMs(nextAttempt), {
		waitReason: 'recheck',
		// Replaces whatever the row last said — a `merge-queue` sentence included.
		lastError: outcome.message,
	});
	const scheduled = {
		dispatchId: dispatch.id,
		runId: job.reviewRunId,
		prNumber: job.prNumber,
		attempt: nextAttempt,
		reason: outcome.message,
	};
	// A failing forge keeps the severity its terminal settle used to carry;
	// a pull request that is simply not ready yet is ordinary progress.
	if (outcome.status === 'provider-error') {
		logger.error('Merge automation: provider failure — retry scheduled', scheduled);
	} else {
		logger.info('Merge automation: pull request not ready — retry scheduled', scheduled);
	}
	return {
		status: 'merge-automation-settled',
		result: 'retry-scheduled',
		prNumber: job.prNumber,
	};
}

/**
 * Execute one claimed merge-automation dispatch: invoke the provider-neutral
 * merge capability (fresh PR state and approval re-checked from scratch),
 * persist the outcome on the originating Review run, and settle the dispatch —
 * `completed` for a merge or a terminal functional refusal, or
 * `retry-scheduled` (bounded, doubling backoff) while the PR is transiently
 * `not-ready`, while the provider is failing (issue #923), while the head
 * this dispatch itself brought up to date is still being verified (issue #874),
 * or while the approved head's own checks are still running (issue #1124).
 * Never `failed`: a spent budget completes as `merge-retry-exhausted` with the
 * reason on the Review run.
 *
 * None of that starts until this dispatch holds its repository's merge queue
 * (issue #1114); until then it defers as `merge-queue` with its attempt counter
 * untouched, and records {@link MERGE_QUEUED} on the Review run.
 */
export async function processMergeAutomationDispatch(
	dispatch: DispatchRow,
	claimedJob: MergeAutomationJob,
	project: ProjectConfig,
	capabilities: MergeAutomationCapabilities = {},
): Promise<MergeAutomationSettledOutcome> {
	const attempt = dispatch.attempt;
	const turn = await resolveMergeQueueTurn(dispatch, claimedJob, project);
	if (turn.kind === 'behind') {
		// Waiting spends none of the merge's own budget: `attempt` is persisted as
		// it was claimed, so the turn starts with every retry still available.
		await persistMergeOutcome(claimedJob, MERGE_QUEUED, turn.message, attempt);
		await scheduleMergeRetry(dispatch.id, claimedJob, attempt, MERGE_QUEUE_RECHECK_MS, {
			waitReason: 'merge-queue',
			lastError: turn.message,
		});
		logger.info('Merge automation: waiting for its turn on the merge queue', turn.context);
		return {
			status: 'merge-automation-settled',
			result: 'retry-scheduled',
			prNumber: claimedJob.prNumber,
		};
	}
	// Stamped with the turn's start, so every retry this dispatch schedules from
	// here carries it to the waiters reading the queue behind it.
	const job = turn.job;
	// A worker-side branch update this dispatch asked for has reported (issue
	// #1117): settle it exactly as the provider's own update would have been.
	const handedBack = handedBackBranchUpdate(job);
	if (handedBack) {
		return applyBranchUpdate(dispatch, job, project, handedBack, attempt, capabilities, 'worker');
	}
	if (awaitingWorkerBranchUpdate(job)) {
		return retryOrExhaust(
			dispatch,
			job,
			project,
			{ status: 'not-ready', message: WAITING_FOR_WORKER_UPDATE },
			MERGE_RETRY_EXHAUSTED,
			attempt,
		);
	}
	const attempted = await attemptMerge(job, project, capabilities);
	const redFreshChecks = attempted.redFreshChecks;
	let outcome: MergePullRequestOutcome = attempted.outcome;

	if (redFreshChecks) {
		return refuseRedHead(
			dispatch,
			job,
			project,
			outcome.message,
			redFreshChecks,
			attempt,
			capabilities,
		);
	}

	if (outcome.status === 'stale-base') {
		const reaction = await reactToStaleBase(
			dispatch,
			job,
			project,
			outcome.message,
			attempt,
			capabilities,
		);
		if (reaction.kind === 'settled') return reaction.outcome;
		outcome = reaction.outcome;
	}

	const retryExhaustion = retryableExhaustion(outcome.status);

	// A retryable outcome is persisted inside its branch below — but only when a
	// retry is actually scheduled. On the attempt that spends the budget it would
	// be immediately overwritten by the exhaustion status, so we skip the fleeting
	// write and let that branch record the terminal outcome directly. Every other
	// status is terminal here, so persist it once now.
	if (!retryExhaustion) {
		await persistMergeOutcome(job, outcome.status, outcome.message, attempt);
	}

	if (outcome.status === 'merged') {
		logger.info('Merge automation: merged pull request', {
			dispatchId: dispatch.id,
			runId: job.reviewRunId,
			prNumber: job.prNumber,
			attempt,
		});
		await settleMergeDispatch(dispatch, job, project, 'merged');
		await settleChildrenThisMergeAbsorbed(dispatch, job, project, capabilities);
		return { status: 'merge-automation-settled', result: 'merged', prNumber: job.prNumber };
	}

	if (retryExhaustion) {
		return retryOrExhaust(dispatch, job, project, outcome, retryExhaustion, attempt);
	}

	logger.warn('Merge automation: terminal non-merge outcome', {
		dispatchId: dispatch.id,
		runId: job.reviewRunId,
		prNumber: job.prNumber,
		status: outcome.status,
		message: outcome.message,
	});
	if (outcome.status === 'not-eligible') {
		// The one refusal a moved head produces here. The read inside decides
		// whether that is what happened — `not-eligible`'s other causes (drafted,
		// closed, the approval dismissed) leave the head where it was and keep
		// their slot (issue #1079).
		await markApprovalSupersededByHeadChange(job, project, capabilities);
	}
	await settleMergeDispatch(
		dispatch,
		job,
		project,
		TERMINAL_MERGE_OUTCOMES[outcome.status] ?? 'merge-not-eligible',
	);
	return { status: 'merge-automation-settled', result: outcome.status, prNumber: job.prNumber };
}
