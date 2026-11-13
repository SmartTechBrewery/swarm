/**
 * Supersede the approvals merge automation refused at a head, once SWARM's own
 * base merge moves the pull request off that head (issue #1445).
 *
 * Merge automation deliberately leaves an approval it refused for red checks
 * counting toward `REVIEW_VERDICT_CAP` (issue #1079, `refuseRedHead`): the head is
 * genuinely broken, and freeing the slot would buy re-reviews of it. But that
 * approval stays parked at the refused head for good. When SWARM itself later
 * merges the base into the pull request — Resolve-conflicts, or merge
 * automation's own branch update (issues #874, #1117) — the head the approval
 * covered is gone, and the approval kept spending a slot the pull request never
 * gets back. Two or three of those and the pull request stopped at the cap
 * green, mergeable and unreviewed (`#2254`, `#2245`).
 *
 * **The rule.** When a SWARM base-merge push moves the head off `fromHeadSha`,
 * every approval that is all of:
 *  - a completed `approve` Review run of this pull request,
 *  - with its merge generation parked at `fromHeadSha`
 *    (`runs.review_merge_approved_head_sha`),
 *  - settled with a re-armable non-merge outcome (`MERGE_REARM_OUTCOMES`:
 *    `not-eligible`, `retry-exhausted`) — a merge still waiting keeps its own
 *    head-moved stamping, and a merged pull request has no further pushes,
 *  - and not yet superseded,
 *
 * gets the same two writes merge automation's own supersession makes: the
 * ledger slot (keyed on the head the run *reviewed*) and the run row.
 *
 * **Why it stays bounded.** Only `approve` runs are ever stamped, so a
 * request-changes loop still stops at `REVIEW_VERDICT_CAP`; and every stamp
 * counts against `REVIEW_SUPERSEDED_CAP`, so a head SWARM keeps moving still
 * stops there. A push SWARM did not make (a human's, or a Respond-to-CI fix)
 * never reaches this module, so a fix head is still reviewed as a counted
 * verdict. The rule does not tell a red-check refusal apart from `not-eligible`'s
 * other causes (drafted, the approval dismissed): that would need a structured
 * refusal reason, which issue #1079 already decided against rather than sniff a
 * provider's prose (ai/RULES.md §2) — and either way the code at that head was
 * approved and is no longer the pull request's head.
 *
 * Lives under `src/dispatch/` for the reason `./ci-no-fix-recovery.ts` does: it is
 * composition-root work — called from the worker's Resolve-conflicts settle and
 * from merge automation — not a phase (ai/RULES.md §2).
 */

import type { ProjectConfig } from '../config/schema.js';
import { markReviewVerdictSuperseded } from '../db/repositories/reviewVerdictsRepository.js';
import {
	listParkedApprovalsAtMergeHead,
	markReviewRunSuperseded,
} from '../db/repositories/runsRepository.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { MERGE_REARM_OUTCOMES } from '../worker/merge-rearm-outcomes.js';

/** Which SWARM base merge moved the head: a Resolve-conflicts push, or merge automation's branch update. */
export type BasePushCause = 'resolve-conflicts' | 'update-branch';

export interface SupersedeApprovalsParkedAtHeadInput {
	project: ProjectConfig;
	prNumber: string;
	/** The head SWARM's base merge moved the pull request off. */
	fromHeadSha: string;
	cause: BasePushCause;
}

/**
 * Stamp every approval parked at `fromHeadSha` superseded — see the module
 * header for the rule. Returns how many runs were stamped. Never throws: a read
 * or write failure is logged, and the worst case is the behaviour before issue
 * #1445 (the slot keeps counting; an operator's Force re-review unsticks it).
 */
export async function supersedeApprovalsParkedAtHead({
	project,
	prNumber,
	fromHeadSha,
	cause,
}: SupersedeApprovalsParkedAtHeadInput): Promise<number> {
	const context = { projectId: project.id, prNumber, fromHeadSha, cause };
	try {
		const parked = await listParkedApprovalsAtMergeHead(
			{ projectId: project.id, repository: project.repo, prNumber, headSha: fromHeadSha },
			MERGE_REARM_OUTCOMES,
		);
		let stamped = 0;
		for (const approval of parked) {
			const ledgerStamped = await markReviewVerdictSuperseded({
				projectId: project.id,
				repository: project.repo,
				prNumber,
				headSha: approval.reviewedHeadSha,
			});
			// Written whether or not the ledger stamp landed just now, exactly as merge
			// automation's own stamp: a retry after a crash between the two writes finds
			// the ledger already stamped and must still reach the run row.
			const runStamped = await markReviewRunSuperseded(approval.id);
			if (runStamped) stamped += 1;
			logger.info(
				'base push superseded a parked approval — it no longer spends a review-cap slot',
				{
					...context,
					runId: approval.id,
					reviewedHeadSha: approval.reviewedHeadSha,
					ledgerStamped,
					runStamped,
				},
			);
		}
		return stamped;
	} catch (err) {
		logger.warn('Could not supersede the approvals parked at the head a base push moved off', {
			...context,
			error: describeError(err),
		});
		return 0;
	}
}
