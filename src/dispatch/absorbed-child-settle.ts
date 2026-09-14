/**
 * Settling a split sibling whose scope a merged pull request absorbed (issue
 * #959, the last of #953's three phases).
 *
 * Planning splits an oversized item into sibling cards, and an implementation
 * occasionally delivers a later sibling's whole scope along the way. Until this,
 * that sibling was still queued: the Implementation agent refused to open an
 * empty pull request, the card sat in ToDo, and anything *depending* on it stayed
 * blocked until its seven-day dependency budget ran out. The Review phase now
 * declares the fold-in as data (`runs.review_absorbed`, phase 1/3) and the board
 * contract can settle a card (`PMProvider.closeWorkItem`, phase 2/3); this is the
 * step that acts on the declaration, at the one moment the claim becomes true —
 * when the pull request that made it actually merges.
 *
 * **A declaration is necessary but never sufficient.** The reviewer names a card;
 * three mechanical guards decide whether SWARM may touch it. It must resolve on
 * this project's board through the provider-agnostic one-card lookup; it must not
 * be the pull request's own task; and it must carry {@link SPLIT_CHILD_LABEL},
 * which is the proof that SWARM created it as a split child rather than a human
 * filing live work the reviewer happened to name. A card failing any of them is
 * left completely untouched, and so is a card already settled — which is what
 * makes a re-run of the merge dispatch a no-op.
 *
 * **It fails open, per item**, on {@link retireSupersededBoardPhases}' posture and
 * for a sharper reason: the merge has already happened and cannot be undone by a
 * board error, so a provider failure settles fewer cards rather than failing the
 * dispatch, and one entry's failure never stops the next. The one thing it fails
 * *closed* on is a missing Review run row, because that row supplies the own-task
 * guard's input — settling without it would risk closing the card the pull
 * request was written for.
 *
 * **Known limitation: only SWARM's own merge automation settles anything.** A
 * pull request a human merges in the forge produces no merge dispatch, so its
 * declarations are never acted on. That is deliberate rather than overlooked: the
 * declaration is durable on the Review run row, so a later issue can add the
 * `pull-request closed + merged` ingress path without re-deciding any of the
 * policy here.
 */

import type { ProjectConfig } from '../config/schema.js';
import {
	getReviewAbsorbedForPullRequest,
	getRunByIdFromDb,
} from '../db/repositories/runsRepository.js';
import { requireProjectPMProvider } from '../integrations/pm/registry.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { SPLIT_CHILD_LABEL } from '../pipeline/preplan.js';
import type { PmStatusKey } from '../pm/pipeline.js';
import type { PMProvider, WorkItem } from '../pm/types.js';
import type { ReviewAbsorbed } from '../scm/delivery.js';
import { repoSlugsMatch } from '../scm/repo-slug.js';
import { SWARM_GENERATED_FOOTER, swarmMarker } from '../scm/swarm-origin.js';
import { retireSupersededBoardPhases } from './board-phase-retirement.js';

/** The canonical status key a settled card carries — re-reading it is the idempotency check. */
const SETTLED_STATUS_KEY: PmStatusKey = 'done';

export interface SettleAbsorbedChildrenInput {
	/** The merged pull request's project, already scoped to its repository. */
	project: ProjectConfig;
	/** This merge dispatch — excluded from retirement so it can never retire itself. */
	dispatchId: string;
	/** The approving Review run, whose own task is the pull request's. */
	reviewRunId: string;
	/** `owner/repo` of the merged pull request. */
	repository: string;
	prNumber: string;
}

/**
 * Idempotency marker for the audit comment, keyed on the pull request that
 * absorbed the card rather than on the dispatch: two merge dispatches for the
 * same pull request cannot exist (`merge:<reviewRunId>` dedup), but a retried
 * *attempt* of one can, and both must recognise the same comment. It also shares
 * the `<!-- swarm-… -->` frame every SWARM comment carries, so comment loop
 * prevention drops this comment's own webhook (`isSwarmGeneratedBody`).
 */
export function absorbedChildMarker(repository: string, prNumber: string): string {
	return swarmMarker('absorbed-child', `${repository}:${prNumber}`);
}

/**
 * The audit comment left on the settled card: which pull request absorbed it, the
 * reviewer's evidence verbatim, and what SWARM did about it. Posted *before* the
 * close, so a card that is settled always carries its explanation — a closed card
 * with no reason on it is indistinguishable from a human having closed it.
 */
export function absorbedChildCommentBody(
	entry: ReviewAbsorbed,
	repository: string,
	prNumber: string,
): string {
	return [
		'## 🔀 Settled by another pull request',
		'',
		`The whole scope of this task was delivered by **${repository}#${prNumber}**, which has now merged.`,
		'Reviewing that pull request traced this task’s acceptance criteria through its diff and declared',
		'the scope absorbed:',
		'',
		`**Evidence.** ${entry.evidence}`,
		'',
		'SWARM has therefore closed this task instead of dispatching a phase for it — there is nothing',
		'left to implement. Reopen it if the evidence above does not hold; anything that was blocked on',
		'it is unblocked at its next dependency check.',
		'',
		'---',
		SWARM_GENERATED_FOOTER,
		'',
		absorbedChildMarker(repository, prNumber),
	].join('\n');
}

/** Everything one entry's settle needs beyond the entry itself. */
interface SettleContext {
	pm: PMProvider;
	project: ProjectConfig;
	dispatchId: string;
	repository: string;
	prNumber: string;
	/** The pull request's own task — the card this must never settle. */
	ownTaskId: string;
}

/** Whether the card is the very task the merged pull request was written for. */
function isOwnTask(item: WorkItem, ctx: SettleContext): boolean {
	return (
		item.taskRef === ctx.ownTaskId &&
		item.taskRepository !== undefined &&
		repoSlugsMatch(item.taskRepository, ctx.repository)
	);
}

/**
 * Settle one declared card, or explain why it was left alone. Returns whether it
 * was settled. Never throws: every guard is a skip and every provider failure is
 * this entry's alone.
 */
async function settleOne(entry: ReviewAbsorbed, ctx: SettleContext): Promise<boolean> {
	const context = {
		projectId: ctx.project.id,
		repository: ctx.repository,
		prNumber: ctx.prNumber,
		reference: entry.reference,
		url: entry.url,
	};
	const skip = (reason: string): false => {
		logger.warn('absorbed-child settle: leaving a declared task alone', { ...context, reason });
		return false;
	};

	try {
		const item = await ctx.pm.findWorkItemByUrlSuffix(entry.url);
		if (!item) return skip('no card on this board wraps that URL');
		// An unplaceable card cannot be proven *not* to be the pull request's own
		// task, and its queued phases cannot be found either, so it is refused for
		// the same reason the own-task guard below exists.
		if (!item.taskRef || !item.taskRepository)
			return skip('the card names no source-control artifact');
		if (isOwnTask(item, ctx)) return skip('it is the pull request’s own task');
		if (!item.labels.some((label) => label.name === SPLIT_CHILD_LABEL))
			return skip(`the card does not carry '${SPLIT_CHILD_LABEL}', so SWARM did not create it`);
		if (item.statusKey === SETTLED_STATUS_KEY) return skip('the card is already settled');

		if (!(await ctx.pm.findComment(item.id, absorbedChildMarker(ctx.repository, ctx.prNumber)))) {
			await ctx.pm.addComment(
				item.id,
				absorbedChildCommentBody(entry, ctx.repository, ctx.prNumber),
			);
		}
		await ctx.pm.closeWorkItem(item.id);

		// Retirement is keyed on `(projectId, taskId)` alone
		// (`listRetirableBoardDispatchesForTask`), so a card whose artifact lives in
		// another of the project's repositories is deliberately left queued rather
		// than risk retiring a same-numbered task's phase in this one.
		if (repoSlugsMatch(item.taskRepository, ctx.repository)) {
			await retireSupersededBoardPhases({
				projectId: ctx.project.id,
				taskId: item.taskRef,
				keepPhase: undefined,
				excludeDispatchId: ctx.dispatchId,
			});
		}
		return true;
	} catch (err) {
		logger.warn('absorbed-child settle: could not settle a declared task', {
			...context,
			error: describeError(err),
		});
		return false;
	}
}

/**
 * Settle every split sibling the merged pull request's Review runs declared
 * absorbed, and return the references actually settled (`[]` when nothing was
 * declared, nothing passed the guards, or the read itself failed).
 *
 * Never throws — see the module header. The merge branch that calls it still
 * wraps it, because "a completed merge is never turned into a failed dispatch by
 * bookkeeping" is the merge dispatch's own guarantee to keep.
 */
export async function settleAbsorbedChildren(
	input: SettleAbsorbedChildrenInput,
): Promise<string[]> {
	const { project, dispatchId, reviewRunId, repository, prNumber } = input;
	try {
		const declared = await getReviewAbsorbedForPullRequest(project.id, repository, prNumber);
		if (declared.length === 0) return [];

		const run = await getRunByIdFromDb(reviewRunId);
		if (!run) {
			logger.warn(
				'absorbed-child settle: the Review run is gone, so the declared tasks cannot be told apart from the pull request’s own',
				{ projectId: project.id, repository, prNumber, reviewRunId },
			);
			return [];
		}

		const ctx: SettleContext = {
			pm: requireProjectPMProvider(project),
			project,
			dispatchId,
			repository,
			prNumber,
			ownTaskId: run.taskId,
		};

		const settled: string[] = [];
		for (const entry of declared) {
			if (await settleOne(entry, ctx)) settled.push(entry.reference);
		}
		if (settled.length > 0) {
			logger.info('absorbed-child settle: closed the tasks this merge absorbed', {
				projectId: project.id,
				repository,
				prNumber,
				settled,
			});
		}
		return settled;
	} catch (err) {
		logger.warn('absorbed-child settle: failed before any task was settled', {
			projectId: project.id,
			repository,
			prNumber,
			error: describeError(err),
		});
		return [];
	}
}
