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
import type { MergePullRequest, MergePullRequestOutcome } from '../scm/merge.js';

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

/** Persist an attempt's outcome onto the Review run row — best-effort, logged. */
async function persistMergeOutcome(
	job: MergeAutomationJob,
	status: ReviewMergeOutcomeStatus,
	message: string,
	attempt: number,
): Promise<void> {
	try {
		await updateReviewMergeOutcome(job.reviewRunId, {
			status,
			message,
			attempt,
			approvedHeadSha: job.approvedHeadSha,
		});
	} catch (err) {
		logger.error("Failed to persist the merge attempt's outcome on the Review run", {
			runId: job.reviewRunId,
			error: describeError(err),
		});
	}
}

/** The default merge capability: the project's registered provider, resolved fresh per attempt. */
function defaultMergePullRequest(project: ProjectConfig): MergePullRequest {
	const scm = requireProjectSCMProvider(project);
	return scm.mergePullRequest.bind(scm);
}

/**
 * Execute one claimed merge-automation dispatch: invoke the provider-neutral
 * merge capability (fresh PR state and approval re-checked from scratch),
 * persist the outcome on the originating Review run, and settle the dispatch —
 * `completed` for a merge or a terminal functional refusal, `failed` for an
 * unexpected provider failure, or `retry-scheduled` (bounded, doubling
 * backoff) while the PR is transiently `not-ready`.
 */
export async function processMergeAutomationDispatch(
	dispatch: DispatchRow,
	job: MergeAutomationJob,
	project: ProjectConfig,
	mergePullRequest?: MergePullRequest,
): Promise<MergeAutomationSettledOutcome> {
	const attempt = dispatch.attempt;
	let outcome: MergePullRequestOutcome;
	// Resolving the default *inside* the try, not in a default parameter: an
	// unresolvable provider (nothing registered, or a `project.scm` naming one that is
	// unregistered or not runtime-ready — `requireProjectSCMProvider`) would
	// otherwise throw during parameter binding, before this function can settle the
	// dispatch it was handed. It must fail the same way any other provider failure
	// does — `provider-error` → outcome persisted on the Review run → `failDispatch`
	// — rather than escaping `processJob` and leaving a claimed dispatch in flight.
	try {
		const merge = mergePullRequest ?? defaultMergePullRequest(project);
		outcome = await merge(project, Number(job.prNumber), job.approvedHeadSha);
	} catch (err) {
		outcome = { status: 'provider-error', message: describeError(err) };
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
		// Persist the retry intent before any queue work (ADR-002): a crash here
		// leaves a durable `retry-scheduled` row the reconciler re-publishes.
		const updated = await scheduleDispatchRetry(dispatch.id, {
			jobPayload: job,
			availableAt: new Date(Date.now() + mergeRetryDelayMs(nextAttempt)),
			waitReason: 'recheck',
			attempt: nextAttempt,
		});
		if (updated) {
			try {
				await publishDispatchWakeUp(updated);
			} catch (err) {
				logger.warn('Failed to publish merge-retry wake-up (reconciler will repair)', {
					dispatchId: dispatch.id,
					error: describeError(err),
				});
			}
		}
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
