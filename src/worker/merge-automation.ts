/**
 * Durable merge automation (issue #292, superseding issue #278's standalone
 * follow-up queue): after the Review phase submits an eligible `approve`, the
 * merge intent is persisted as one ADR-002 dispatch (`merge-automation`
 * payload, dedup key `merge:<reviewRunId>`) and executed through the normal
 * dispatch lifecycle — claim, bounded `retry-scheduled` backoff for transient
 * `not-ready` outcomes, terminal completion/failure, reconciler recovery, and
 * cancellation via the standard queue surfaces.
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
 *    attempted, so several stay in flight — nothing is serialized behind a
 *    queue, and no open pull request is kept continuously up to date;
 *  - it is allowed {@link MAX_BASE_UPDATES} times, after which the pull request
 *    is handed to a human rather than looping against a faster-moving base;
 *  - a provider that cannot update a branch, a conflicting update, and a red
 *    fresh CI each settle terminally *and comment on the pull request* —
 *    refused rather than merged on stale evidence;
 *  - the head the update produces pre-claims its own PR+SHA review-dispatch slot
 *    so re-verification costs no `REVIEW_VERDICT_CAP` slot.
 */

import type { ProjectConfig } from '../config/schema.js';
import {
	completeDispatch,
	type DispatchOutcome,
	type DispatchRow,
	failDispatch,
	scheduleDispatchRetry,
} from '../db/repositories/dispatchesRepository.js';
import { updateReviewMergeOutcome } from '../db/repositories/runsRepository.js';
import { createAndPublishDispatch, publishDispatchWakeUp } from '../dispatch/dispatcher.js';
import { requireProjectSCMProvider } from '../integrations/scm/registry.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { MergeAutomationJob } from '../queue/jobs.js';
import type {
	MergePullRequest,
	MergePullRequestOutcome,
	UpdatePullRequestBranch,
	UpdatePullRequestBranchOutcome,
} from '../scm/merge.js';
import { SWARM_GENERATED_FOOTER } from '../scm/swarm-origin.js';
import type { SCMProvider } from '../scm/types.js';
import { decideAggregateCheckOutcome } from '../triggers/handlers/aggregate-check-decision.js';
import {
	buildReviewDispatchKey,
	claimReviewDispatch,
	refreshReviewDispatchClaim,
} from '../triggers/review-dispatch-dedup.js';

/** Terminal outcome recorded once the bounded retry budget is spent without merging. */
export const MERGE_RETRY_EXHAUSTED = 'retry-exhausted' as const;

/** Every value the `runs.review_merge_outcome` column can hold. */
export type ReviewMergeOutcomeStatus =
	| MergePullRequestOutcome['status']
	| typeof MERGE_RETRY_EXHAUSTED;

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
 * durable merge dispatch for all time — a crash-retried creation, a webhook
 * redelivery, or the startup backfill can never mint a second — while a fresh
 * approval (a new Review run) still gets its own.
 */
export function mergeDispatchDedupKey(reviewRunId: string): string {
	return `merge:${reviewRunId}`;
}

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
	const job: MergeAutomationJob = {
		type: 'merge-automation',
		projectId: input.project.id,
		reviewRunId: input.reviewRunId,
		repo: input.project.repo,
		prNumber: input.prNumber,
		approvedHeadSha: input.approvedHeadSha,
	};
	try {
		const { dispatch, created } = await createAndPublishDispatch({
			projectId: input.project.id,
			jobPayload: job,
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

/** Map a terminal, non-retryable refusal onto its dispatch completion outcome. */
const TERMINAL_MERGE_OUTCOMES: Partial<Record<MergePullRequestOutcome['status'], DispatchOutcome>> =
	{
		merged: 'merged',
		'not-eligible': 'merge-not-eligible',
		'policy-blocked': 'merge-policy-blocked',
		unsupported: 'merge-unsupported',
	};

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
}

/**
 * One capability off the project's registered provider, resolved fresh at the
 * moment it is used. Never call this outside a `try` that can settle the
 * dispatch — `requireProjectSCMProvider` throws for an unresolvable provider,
 * and that has to land on the same `provider-error` path as any other provider
 * failure rather than escaping `processJob`.
 */
function scmCapability<K extends keyof MergeAutomationCapabilities>(
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
 * What the fresh CI on a head **this dispatch produced** says right now.
 *
 * Only ever asked about an updated head, and that is the whole point: an
 * ordinary merge is requested by a Review the provider only dispatched once
 * every check on that commit had completed, so its checks are already known
 * good. The commit an update produces has never been judged by anything, and
 * relying on the provider's own merge endpoint to refuse a pending or red one
 * would make the guarantee a property of the repository's branch protection —
 * the alternative issue #872 explicitly set aside.
 *
 * Judged with the *same* classifier and the same project policy the `pr-review`
 * handler uses ({@link decideAggregateCheckOutcome}), so a head is never green
 * to merge automation and red to the pipeline. A project that opts into
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
		project.pipeline?.review?.checks ?? 'required',
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
 * Only the refusals issue #874 introduces comment. The pre-existing terminal
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

/** The notice for a refusal SWARM will not retry — one paragraph plus what a human should do. */
function mergeRefusalCommentBody(reason: string, nextStep: string): string {
	return [
		'## ⚠️ SWARM refused to merge this pull request',
		'',
		reason,
		'',
		'Merging it as it stands would land a change nothing has built against the',
		'current base, which is how two independently green pull requests combine',
		'into a red base branch. No branch changes were made by this attempt.',
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
): Promise<void> {
	const updated = await scheduleDispatchRetry(dispatchId, {
		jobPayload,
		availableAt: new Date(Date.now() + delayMs),
		waitReason: 'recheck',
		attempt,
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
 * What the `stale-base` branch decided: either the dispatch is settled, or the
 * attempt should carry on down the ordinary `not-ready` backoff.
 */
type StaleBaseReaction =
	| { kind: 'settled'; outcome: MergeAutomationSettledOutcome }
	| { kind: 'not-ready'; message: string };

/**
 * React to a head that is behind its base: bring it up to date, re-pin the
 * approval to the commit that produced, and let the fresh CI decide (issue
 * #874). Every exit is either a scheduled retry or a *visible* terminal
 * settlement — never a merge.
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
	const settle = (result: MergeAutomationSettledOutcome['result']): StaleBaseReaction => ({
		kind: 'settled',
		outcome: { status: 'merge-automation-settled', result, prNumber: job.prNumber },
	});

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
		await completeDispatch(dispatch.id, 'merge-retry-exhausted');
		return settle('stale-base');
	}

	let update: UpdatePullRequestBranchOutcome;
	try {
		const updateBranch =
			capabilities.updatePullRequestBranch ?? scmCapability(project, 'updatePullRequestBranch');
		update = await updateBranch(project, Number(job.prNumber), job.approvedHeadSha);
	} catch (err) {
		update = { status: 'provider-error', message: describeError(err) };
	}

	if (update.status === 'updated') {
		// The approval is carried onto a commit the *provider* built from the
		// reviewed diff plus the base, at SWARM's request and attributed to that
		// request before it was reported (`src/scm/merge.ts`'s header states why
		// that is sound, and `head-moved` below is what an unattributable head gets
		// instead). What the advance invalidates is the verification, and the reset
		// budget below is this dispatch waiting for the replacement.
		const advanced: MergeAutomationJob = {
			...job,
			approvedHeadSha: update.headSha,
			baseUpdates: spent + 1,
		};
		await persistMergeOutcome(
			advanced,
			'stale-base',
			`Brought the head up to date with the base (${job.approvedHeadSha} → ${update.headSha}); the approval carries forward and the merge waits for this head's own checks.`,
			attempt,
			job.approvedHeadSha,
		);
		await claimUpdatedHeadReviewSlot(project, job, update.headSha);
		// `attempt: 0` resets the not-ready budget: the fresh CI is a new wait, not
		// a continuation of whatever the old head was waiting for.
		await scheduleMergeRetry(dispatch.id, advanced, 0, mergeRetryDelayMs(1));
		logger.info('Merge automation: advanced the approved head onto the base', {
			dispatchId: dispatch.id,
			runId: job.reviewRunId,
			prNumber: job.prNumber,
			previousHeadSha: job.approvedHeadSha,
			headSha: update.headSha,
			baseUpdates: advanced.baseUpdates,
		});
		return settle('retry-scheduled');
	}

	if (update.status === 'up-to-date') {
		// A race: something advanced the branch between the merge attempt that
		// reported `stale-base` and this call. Nothing to settle — the ordinary
		// backoff re-reads and merges.
		return { kind: 'not-ready', message: `${staleMessage}, but it is already up to date now` };
	}

	if (update.status === 'head-moved') {
		// The branch's head is not the reviewed commit and not this update's
		// commit either — somebody pushed. `approvedHeadSha` deliberately stays
		// where it is: this is the same `not-eligible` a pushed head has always
		// produced, and the push's own Review is what clears it.
		await persistMergeOutcome(job, 'not-eligible', update.message, attempt);
		await commentOnMergeRefusal(
			job,
			project,
			capabilities,
			mergeRefusalCommentBody(
				`Its head is behind the base, and while SWARM was bringing it up to date the branch moved to a commit SWARM did not ask for: ${update.message}`,
				'SWARM will pick the pull request up again from the review of the head that is there now.',
			),
		);
		logger.warn('Merge automation: the head moved while it was being updated', {
			dispatchId: dispatch.id,
			runId: job.reviewRunId,
			prNumber: job.prNumber,
			approvedHeadSha: job.approvedHeadSha,
			message: update.message,
		});
		await completeDispatch(dispatch.id, 'merge-not-eligible');
		return settle('not-eligible');
	}

	if (update.status === 'conflict') {
		await persistMergeOutcome(job, 'not-eligible', update.message, attempt);
		await commentOnMergeRefusal(
			job,
			project,
			capabilities,
			mergeRefusalCommentBody(
				`Its head is behind the base and the base does not merge into it cleanly: ${update.message}`,
				'Resolve the conflict on the branch; SWARM will pick the pull request up again from its next review.',
			),
		);
		logger.warn('Merge automation: cannot update a conflicting head', {
			dispatchId: dispatch.id,
			runId: job.reviewRunId,
			prNumber: job.prNumber,
			message: update.message,
		});
		await completeDispatch(dispatch.id, 'merge-not-eligible');
		return settle('not-eligible');
	}

	if (update.status === 'unsupported') {
		await persistMergeOutcome(job, 'unsupported', update.message, attempt);
		await commentOnMergeRefusal(
			job,
			project,
			capabilities,
			mergeRefusalCommentBody(
				`Its head is behind the base, and this source-control provider cannot bring it up to date automatically: ${update.message}`,
				'Update the branch yourself and let its checks run, then merge it manually.',
			),
		);
		logger.warn('Merge automation: provider cannot update a stale head', {
			dispatchId: dispatch.id,
			runId: job.reviewRunId,
			prNumber: job.prNumber,
			message: update.message,
		});
		await completeDispatch(dispatch.id, 'merge-unsupported');
		return settle('unsupported');
	}

	await persistMergeOutcome(job, 'provider-error', update.message, attempt);
	logger.error('Merge automation: provider failure while updating the head', {
		dispatchId: dispatch.id,
		runId: job.reviewRunId,
		prNumber: job.prNumber,
		message: update.message,
	});
	await failDispatch(dispatch.id, update.message);
	return settle('provider-error');
}

/** What one merge attempt came back with, before any of it is settled. */
interface MergeAttempt {
	outcome: MergePullRequestOutcome;
	/** Set only when the attempt refused because the head *it* produced is red. */
	redFreshChecks: string[] | null;
}

/**
 * Ask for the merge: verify a head this dispatch itself produced first, then
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
		// A head this dispatch produced has to be verified before it is offered to
		// the merge capability at all; an ordinary approved head skips this read.
		const freshChecks: FreshCheckVerdict =
			baseUpdatesSpent(job) > 0
				? await readFreshCheckVerdict(job, project, capabilities)
				: { kind: 'green' };
		if (freshChecks.kind === 'pending') {
			// The updated head's own CI has not finished. Ordinary backoff — the
			// budget was reset when the head advanced, so this is the wait it exists for.
			return {
				outcome: {
					status: 'not-ready',
					message: `waiting for the checks on the head brought up to date with the base: ${freshChecks.message}`,
				},
				redFreshChecks: null,
			};
		}
		if (freshChecks.kind === 'red') {
			return {
				outcome: {
					status: 'not-eligible',
					message: `the head brought up to date with the base fails its checks (${freshChecks.failedChecks.join(', ')}); the reviewed diff and the current base do not combine cleanly`,
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
 * Execute one claimed merge-automation dispatch: invoke the provider-neutral
 * merge capability (fresh PR state and approval re-checked from scratch),
 * persist the outcome on the originating Review run, and settle the dispatch —
 * `completed` for a merge or a terminal functional refusal, `failed` for an
 * unexpected provider failure, or `retry-scheduled` (bounded, doubling
 * backoff) while the PR is transiently `not-ready` or while the head this
 * dispatch itself brought up to date is still being verified (issue #874).
 */
export async function processMergeAutomationDispatch(
	dispatch: DispatchRow,
	job: MergeAutomationJob,
	project: ProjectConfig,
	capabilities: MergeAutomationCapabilities = {},
): Promise<MergeAutomationSettledOutcome> {
	const attempt = dispatch.attempt;
	const attempted = await attemptMerge(job, project, capabilities);
	const redFreshChecks = attempted.redFreshChecks;
	let outcome: MergePullRequestOutcome = attempted.outcome;

	if (redFreshChecks) {
		// The point of the whole exercise: the reviewed diff and the current base
		// are each fine and their combination is not. Refused, and said out loud on
		// the pull request — merging it would be exactly the red base this exists
		// to prevent.
		const failed = redFreshChecks.join(', ');
		await persistMergeOutcome(job, 'not-eligible', outcome.message, attempt);
		await commentOnMergeRefusal(
			job,
			project,
			capabilities,
			mergeRefusalCommentBody(
				`SWARM brought this pull request's head up to date with the base and the resulting commit fails its checks: ${failed}. Each side is green on its own; together they are not.`,
				'Fix the combination on this branch — the failure is real, and it is what this pull request would have landed.',
			),
		);
		logger.warn('Merge automation: the updated head is red — refusing the merge', {
			dispatchId: dispatch.id,
			runId: job.reviewRunId,
			prNumber: job.prNumber,
			headSha: job.approvedHeadSha,
			failedChecks: redFreshChecks,
		});
		await completeDispatch(dispatch.id, 'merge-not-eligible');
		return {
			status: 'merge-automation-settled',
			result: 'not-eligible',
			prNumber: job.prNumber,
		};
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
		outcome = { status: 'not-ready', message: reaction.message };
	}

	// A `not-ready` is persisted inside its branch below — but only when a retry
	// is actually scheduled. On the attempt that spends the budget it would be
	// immediately overwritten by `retry-exhausted`, so we skip the fleeting write
	// and let that branch record the terminal outcome directly. Every other status
	// is terminal here, so persist it once now.
	if (outcome.status !== 'not-ready') {
		await persistMergeOutcome(job, outcome.status, outcome.message, attempt);
	}

	if (outcome.status === 'merged') {
		logger.info('Merge automation: merged pull request', {
			dispatchId: dispatch.id,
			runId: job.reviewRunId,
			prNumber: job.prNumber,
			attempt,
		});
		await completeDispatch(dispatch.id, 'merged');
		return { status: 'merge-automation-settled', result: 'merged', prNumber: job.prNumber };
	}

	if (outcome.status === 'not-ready') {
		const nextAttempt = attempt + 1;
		if (nextAttempt > MAX_MERGE_RETRIES) {
			await persistMergeOutcome(
				job,
				MERGE_RETRY_EXHAUSTED,
				'Merge automation gave up after repeated not-ready results; the pull request is approved but was left open for a manual merge.',
				attempt,
			);
			logger.warn('Merge automation: retry budget exhausted, leaving the PR open', {
				dispatchId: dispatch.id,
				runId: job.reviewRunId,
				prNumber: job.prNumber,
			});
			await completeDispatch(dispatch.id, 'merge-retry-exhausted');
			return {
				status: 'merge-automation-settled',
				result: MERGE_RETRY_EXHAUSTED,
				prNumber: job.prNumber,
			};
		}
		await persistMergeOutcome(job, 'not-ready', outcome.message, attempt);
		await scheduleMergeRetry(dispatch.id, job, nextAttempt, mergeRetryDelayMs(nextAttempt));
		logger.info('Merge automation: pull request not ready — retry scheduled', {
			dispatchId: dispatch.id,
			runId: job.reviewRunId,
			prNumber: job.prNumber,
			attempt: nextAttempt,
			reason: outcome.message,
		});
		return {
			status: 'merge-automation-settled',
			result: 'retry-scheduled',
			prNumber: job.prNumber,
		};
	}

	if (outcome.status === 'provider-error') {
		logger.error('Merge automation: provider failure', {
			dispatchId: dispatch.id,
			runId: job.reviewRunId,
			prNumber: job.prNumber,
			message: outcome.message,
		});
		await failDispatch(dispatch.id, outcome.message);
		return { status: 'merge-automation-settled', result: 'provider-error', prNumber: job.prNumber };
	}

	logger.warn('Merge automation: terminal non-merge outcome', {
		dispatchId: dispatch.id,
		runId: job.reviewRunId,
		prNumber: job.prNumber,
		status: outcome.status,
		message: outcome.message,
	});
	await completeDispatch(
		dispatch.id,
		TERMINAL_MERGE_OUTCOMES[outcome.status] ?? 'merge-not-eligible',
	);
	return { status: 'merge-automation-settled', result: outcome.status, prNumber: job.prNumber };
}
