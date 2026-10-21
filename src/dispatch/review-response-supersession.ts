/**
 * Review-response supersession (issue #1102) — the rule that makes **a pull
 * request's newest review the one its Respond-to-review run answers**.
 *
 * Every Respond-to-review dispatch for a pull request binds to the same task id,
 * `<pr>-respond`, and so to the same run row. An earlier review's dispatch left
 * waiting (`pending`, or a `retry-scheduled` retry) keeps that row active, so a
 * newer review's dispatch used to collide with it on `uq_dispatches_active_run`
 * and settle `failed` — leaving the newer review unanswered and, once the older
 * dispatch ran, answering a review that was no longer the latest.
 *
 * {@link retireSupersededReviewResponses} is the sibling of
 * `retireSupersededBoardPhases` (`./board-phase-retirement.ts`, issue #909) and has
 * its shape and posture:
 *
 * - **It fires from the newer delivery**, not as a self-check on the stale one.
 * - **Only waiting dispatches are retired, and only ones created before the asking
 *   dispatch.** An executing one is left alone — stopping it stays Terminate's job,
 *   and the existing `skipped-duplicate` verdict already covers a newer review
 *   arriving while an older one is executing.
 * - **It fails open.** Every failure is logged and answered with `0`: the failure
 *   direction is "the older dispatch survives", and the claim-side bind in
 *   `src/worker/consumer.ts` still keeps the newer attempt off the held run row.
 *
 * The deliberate limit, shared with #909: an older delivery that was never claimed
 * has a null `phase`, is invisible to the read, and is not retired here.
 */

import {
	getDispatchById,
	listEarlierWaitingRespondToReviewDispatches,
	retireWaitingDispatch,
} from '../db/repositories/dispatchesRepository.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { phaseLabel } from '../pipeline/phase-label.js';
import { removePendingJobById } from '../queue/producer.js';
import { wakeJobId } from './dispatcher.js';

export interface RetireReviewResponsesInput {
	projectId: string;
	/** The pull request's Respond-to-review task id (`<pr>-respond`). */
	taskId: string;
	/** The newer review's own dispatch — never retired, and the age cut-off. */
	excludeDispatchId: string;
}

/**
 * The operator-facing sentence recorded on the retired dispatch and its run.
 * Built from the canonical phase vocabulary alone, naming no provider
 * (ai/RULES.md §2).
 */
function supersededReason(): string {
	return `Superseded — a later review of this pull request is now waiting to be answered, so this queued ${phaseLabel('respond-to-review')} phase for an earlier review will not run.`;
}

/**
 * Retire every Respond-to-review dispatch for this pull request that an earlier
 * review left waiting, settling each one's run row with it. Returns how many were
 * retired (`0` when there were none, and `0` on any failure).
 */
export async function retireSupersededReviewResponses(
	input: RetireReviewResponsesInput,
): Promise<number> {
	const { projectId, taskId, excludeDispatchId } = input;
	try {
		const asking = await getDispatchById(excludeDispatchId);
		if (!asking) return 0;
		const stale = await listEarlierWaitingRespondToReviewDispatches(
			projectId,
			taskId,
			excludeDispatchId,
			asking.createdAt,
		);
		if (stale.length === 0) return 0;

		const retired: { id: string; runId: string | null }[] = [];
		for (const row of stale) {
			const settled = await retireWaitingDispatch(row.id, supersededReason());
			// `null` means a worker claimed it between the read and the conditional
			// cancel — it is executing now, and stopping it stays Terminate's job.
			if (!settled) continue;
			// Best-effort, as every cancel path does it: claim-time refusal covers any
			// wake-up that survives, because the dispatch is already terminal.
			await removePendingJobById(wakeJobId(settled.dispatch)).catch(() => false);
			retired.push({ id: settled.dispatch.id, runId: settled.dispatch.runId });
		}

		if (retired.length > 0) {
			logger.info(
				'respond-to-review: retired earlier waiting responses superseded by a newer review',
				{
					projectId,
					taskId,
					retired,
				},
			);
		}
		return retired.length;
	} catch (err) {
		logger.warn(
			'respond-to-review: supersession of earlier waiting responses failed (leaving the queue as it was)',
			{ projectId, taskId, error: describeError(err) },
		);
		return 0;
	}
}
