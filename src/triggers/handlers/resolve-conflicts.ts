/**
 * The `resolve-conflicts` trigger: a merge into a base branch can leave an open
 * SWARM pull request conflicting, and this is what notices. It runs two paths —
 * a fan-out over the open candidates on the advanced base, which only ever
 * *schedules* one per-PR check each, and the per-PR path those checks arrive on,
 * which reads mergeability, claims the head/base state and dispatches the phase.
 *
 * Both gate on the shared work-item origin gate (`../swarm-managed-pr.ts`, issue
 * #836) rather than on the PR's author — see that module's header for why author
 * identity carries no signal under the federated model.
 *
 * A third path is not about conflicts at all (issue #1117): merge automation's
 * worker-side branch update for a provider that cannot update a branch itself
 * arrives as a synthetic job carrying `mergeCatchUp`, and is dispatched as a
 * catch-up pass of this phase — see {@link checkCatchUp}.
 *
 * The per-PR path also holds a pull request a review cap has stopped for good
 * (issue #1446): if no review can follow the push, resolving the conflict buys
 * nothing, and the next base merge would only dispatch it again — see
 * {@link reviewCapHold}. The fan-out and catch-up paths are not gated: the
 * fan-out only schedules per-PR checks, and a catch-up is asked for a live approval.
 */

import type { DispatchWaitReason } from '../../db/repositories/dispatchesRepository.js';
import {
	getSubmittedReviewSlot,
	isLastPermittedVerdict,
	isReviewAllowanceSpent,
	listActiveReviewSlotsForPullRequest,
	type PullRequestReviewSlot,
	type ReviewCapBound,
	type ReviewVerdictKey,
	reviewCapBoundAfterSupersession,
} from '../../db/repositories/reviewVerdictsRepository.js';
import { listParkedApprovalsAtMergeHead } from '../../db/repositories/runsRepository.js';
import { scheduleCoalescedDispatch } from '../../dispatch/dispatcher.js';
import { describeError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import type { MergeCatchUpRequest, ScmWebhookJob } from '../../queue/jobs.js';
import type { ScmEvent } from '../../scm/events.js';
import { SWARM_GENERATED_FOOTER } from '../../scm/swarm-origin.js';
import type { PullRequestDetails } from '../../scm/types.js';
import { MERGE_REARM_OUTCOMES } from '../../worker/merge-rearm-outcomes.js';
import { noteSkip } from '../decline.js';
import { buildConflictResolutionKey, claimConflictResolution } from '../resolve-conflicts-dedup.js';
import {
	describeUnmanagedPullRequest,
	resolveSwarmManagedPr,
	type SwarmManagedPrResult,
} from '../swarm-managed-pr.js';
import type { ScmTriggerContext, TriggerHandler, TriggerResult } from '../types.js';

const TRIGGER_NAME = 'resolve-conflicts';
const RECHECK_DELAY_MS = 30_000;
const MAX_RECHECKS = 20;

/**
 * The coalesce identity of one pull request's conflict check against one base —
 * shared by the fan-out, its rechecks, and merge automation's hand-off (issue
 * #1264), so a request from any of them supersedes a pending one rather than
 * queueing beside it.
 */
export function conflictCheckCoalesceKey(
	repo: string,
	prNumber: string,
	baseBranch: string,
): string {
	return `resolve-conflicts:${repo}:${prNumber}:${baseBranch}`;
}

export interface ConflictCheckJobInput {
	providerId: ScmWebhookJob['providerId'];
	projectId: string;
	repo: string;
	prNumber: string;
	baseBranch: string;
}

/**
 * The per-PR conflict check for a pull request no merge event is in hand for —
 * the shape the fan-out schedules, as merge automation asks for it when an
 * approved head turns out to conflict with its base (issue #1264). It carries no
 * `workItemId`/`prBranch`/`headSha`: there is no merged sibling for them to
 * describe, and the per-PR path reads the candidate itself.
 */
export function buildConflictCheckJob(input: ConflictCheckJobInput): ScmWebhookJob {
	return {
		type: 'scm',
		providerId: input.providerId,
		projectId: input.projectId,
		event: {
			kind: 'pull-request',
			action: 'closed',
			merged: true,
			repoFullName: input.repo,
			isCommentEvent: false,
			baseBranch: input.baseBranch,
			conflictPrNumber: input.prNumber,
		},
	};
}

async function scheduleCandidate(
	ctx: ScmTriggerContext,
	prNumber: string,
	delay: number,
	waitReason: DispatchWaitReason | null,
): Promise<void> {
	const event: ScmEvent = { ...ctx.event, conflictPrNumber: prNumber };
	await scheduleCoalescedDispatch(
		{
			type: 'scm',
			providerId: ctx.providerId,
			projectId: ctx.project.id,
			event,
			recheckAttempt: (ctx.recheckAttempt ?? 0) + 1,
		},
		conflictCheckCoalesceKey(ctx.project.repo, prNumber, ctx.event.baseBranch ?? ''),
		delay,
		waitReason,
	);
}

export function createResolveConflictsTrigger(): TriggerHandler {
	return {
		name: TRIGGER_NAME,
		description: 'Resolve genuine conflicts after a pull request advances its base branch',
		matches(ctx) {
			return (
				ctx.source === 'scm' &&
				ctx.event.kind === 'pull-request' &&
				(ctx.mergeCatchUp !== undefined ||
					(ctx.event.action === 'closed' && ctx.event.merged === true))
			);
		},
		async handle(ctx): Promise<TriggerResult | null> {
			if (ctx.source !== 'scm') return null;
			if (ctx.mergeCatchUp) return checkCatchUp(ctx, ctx.mergeCatchUp);
			if (!ctx.event.baseBranch) {
				noteSkip(
					ctx,
					'The merged pull request event names no base branch, so there is nothing to check for conflicts.',
				);
				return null;
			}
			const candidates = await ctx.scm.listConflictCandidates(ctx.project, ctx.event.baseBranch);

			if (!ctx.event.conflictPrNumber) {
				await fanOutCandidates(ctx, candidates);
				return null;
			}

			const candidate = candidates.find((pr) => String(pr.number) === ctx.event.conflictPrNumber);
			if (candidate) return checkCandidate(ctx, candidate);
			noteSkip(
				ctx,
				`Pull request #${ctx.event.conflictPrNumber} is no longer open against \`${ctx.event.baseBranch}\`, so there is no conflict to resolve.`,
			);
			return null;
		},
	};
}

/**
 * The per-PR path: decide ownership, then mergeability, then whether a review cap
 * has stopped the pull request for good, then claim the head/base state and
 * dispatch. Ownership comes first, mirroring `review.ts` — a PR that is not ours
 * must not spend rechecks waiting for a mergeability answer that would be
 * discarded anyway. The cap hold sits before the claim, so a held pull request
 * takes none.
 */
async function checkCandidate(
	ctx: ScmTriggerContext,
	candidate: PullRequestDetails,
): Promise<TriggerResult | null> {
	const owned = await resolveSwarmManagedPr(ctx.project, candidate.headBranch, TRIGGER_NAME);
	if (owned === 'error') {
		await deferUnresolvedOwnership(ctx, candidate.number);
		return null;
	}
	if (!owned.managed) {
		logOwnershipSkip(candidate, owned);
		noteSkip(ctx, describeUnmanagedPullRequest(candidate.number, candidate.headBranch, owned));
		return null;
	}

	if (candidate.mergeable === null) {
		await deferUnknownMergeability(ctx, candidate.number);
		return null;
	}
	if (candidate.mergeable) {
		noteSkip(
			ctx,
			`Pull request #${candidate.number} does not conflict with its base branch \`${candidate.baseBranch}\`, so there is nothing to resolve.`,
		);
		return null;
	}

	const bound = await reviewCapHold(ctx, candidate);
	if (bound) {
		logger.info(
			'resolve-conflicts: a review cap stops this pull request and a base merge cannot reopen it — not resolving',
			{ prNumber: candidate.number, headSha: candidate.headSha, bound },
		);
		noteSkip(
			ctx,
			`Pull request #${candidate.number} has spent its review allowance (${bound}), and resolving ` +
				'the conflict would not reopen review, so SWARM does not resolve it. Use Force re-review ' +
				"on the pull request's last Review run to grant another review, then Recheck mergeability " +
				'(`pr_recheck_mergeability`) so Resolve-conflicts runs without waiting for the next merge ' +
				`into \`${candidate.baseBranch}\`.`,
		);
		return null;
	}

	const stateKey = buildConflictResolutionKey(
		ctx.project.repo,
		String(candidate.number),
		candidate.headSha,
		candidate.baseSha,
	);
	if (
		!ctx.runId &&
		!ctx.continuationDispatchClaimed &&
		!(await claimConflictResolution(stateKey, ctx.dispatchId))
	) {
		return null;
	}
	return {
		phase: 'resolve-conflicts',
		taskId: `${candidate.number}-conflicts`,
		prNumber: String(candidate.number),
		prBranch: candidate.headBranch,
		headSha: candidate.headSha,
		baseBranch: candidate.baseBranch,
		baseSha: candidate.baseSha,
	};
}

/**
 * Which review-cap bound would still stop this pull request after the push a
 * Resolve-conflicts run makes, or `null` when the run is worth dispatching
 * (issue #1446). A capped pull request is resolved, reviewed by nobody, and
 * conflicts again at the next base merge — `#2245` had seven such runs overnight.
 *
 * `null` — dispatch as before — when any of these hold:
 *  - the allowance is not spent, or an operator's Force re-review grant is
 *    outstanding (`isReviewAllowanceSpent`);
 *  - a review is in flight (a `pending` slot whose dispatch is still live);
 *  - the pull request's last verdict is an approval of its current head
 *    ({@link isUnmovedApproval}): Force re-review cannot act on an approval
 *    whose head has not moved (`head-unchanged`), so the push a resolution
 *    makes is what gives the operator — and merge automation — a way forward.
 *    Holding it would strand an approved pull request (with `autoMerge` off, or
 *    after a Force re-review approved past the cap) with no SWARM remedy at all;
 *  - SWARM's own push would reopen review: stamping the approvals parked at the
 *    current head superseded, as `src/dispatch/base-push-supersession.ts` does on
 *    a successful Resolve-conflicts settle (issue #1445), leaves no bound reached
 *    (`reviewCapBoundAfterSupersession`). That is the `#2254` shape, and holding
 *    it would block the very push that unsticks it.
 *
 * Fails open: a read error is logged and answers `null`, so the worst case is the
 * behaviour before this gate existed.
 */
async function reviewCapHold(
	ctx: ScmTriggerContext,
	candidate: PullRequestDetails,
): Promise<ReviewCapBound | null> {
	const prNumber = String(candidate.number);
	try {
		const slots = await listActiveReviewSlotsForPullRequest(
			ctx.project.id,
			ctx.project.repo,
			prNumber,
		);
		if (!isReviewAllowanceSpent(slots)) return null;
		if (slots.some((slot) => slot.state === 'pending' && slot.dispatchActive)) return null;
		const key = {
			projectId: ctx.project.id,
			repository: ctx.project.repo,
			prNumber,
			headSha: candidate.headSha,
		};
		if (await isUnmovedApproval(slots, key)) return null;
		const parked = await listParkedApprovalsAtMergeHead(key, MERGE_REARM_OUTCOMES);
		return reviewCapBoundAfterSupersession(
			slots,
			new Set(parked.map((approval) => approval.reviewedHeadSha)),
		);
	} catch (err) {
		logger.warn('resolve-conflicts: could not read the review cap — resolving as usual', {
			prNumber,
			headSha: candidate.headSha,
			error: describeError(err),
		});
		return null;
	}
}

/**
 * Whether the pull request's last submitted verdict is a still-counted approval
 * of `key.headSha` — the head the pull request is at now (issue #1446). Force
 * re-review refuses exactly this shape (`head-unchanged`,
 * `src/dispatch/force-re-review.ts`), so a hold here would leave nothing to act
 * on. The in-memory slots answer "last, counted, at this head" with no read; the
 * verdict itself is read only for that one candidate slot.
 */
async function isUnmovedApproval(
	slots: readonly PullRequestReviewSlot[],
	key: ReviewVerdictKey,
): Promise<boolean> {
	const atHead = slots.find(
		(slot) => slot.state === 'submitted' && !slot.superseded && slot.headSha === key.headSha,
	);
	if (!atHead || !isLastPermittedVerdict(slots, atHead.ordinal)) return false;
	return (await getSubmittedReviewSlot(key))?.verdict === 'approve';
}

/**
 * Merge automation's worker-side branch update (issue #1117): dispatch a catch-up
 * pass pinned to the approved head the merge dispatch is waiting on.
 *
 * No ownership or mergeability gate — SWARM's own Review approved this pull
 * request and SWARM's own merge dispatch asked for the update, and a stale head
 * is *mergeable* by definition, which is exactly what the ordinary path would
 * turn away. The pull request is read once for the coordinates the phase needs
 * (its head branch and the base it targets), and a closed one is not updated.
 *
 * The run takes the resolve-conflicts dedup claim like any other pass, keyed on
 * the pinned head and the base head read here, so it cannot run beside an
 * ordinary resolution of the very same state; the PR-scoped hold (#850) applies
 * downstream, as for every branch-writing phase.
 */
async function checkCatchUp(
	ctx: ScmTriggerContext,
	request: MergeCatchUpRequest,
): Promise<TriggerResult | null> {
	const prNumber = ctx.event.workItemId;
	if (!prNumber) {
		noteSkip(ctx, 'The merge catch-up event names no pull request, so there is nothing to update.');
		return null;
	}
	const pr = await ctx.scm.getPullRequest(ctx.project, Number(prNumber), 'reviewer');
	if (pr.state !== 'open') {
		logger.info(
			'resolve-conflicts: catch-up requested for a pull request that is closed — skipping',
			{
				prNumber,
				reviewRunId: request.reviewRunId,
			},
		);
		noteSkip(ctx, `Pull request #${prNumber} is closed, so its branch is not brought up to date.`);
		return null;
	}
	const stateKey = buildConflictResolutionKey(
		ctx.project.repo,
		prNumber,
		request.headSha,
		pr.baseSha,
	);
	if (
		!ctx.runId &&
		!ctx.continuationDispatchClaimed &&
		!(await claimConflictResolution(stateKey, ctx.dispatchId))
	) {
		return null;
	}
	return {
		phase: 'resolve-conflicts',
		taskId: `${prNumber}-conflicts`,
		prNumber,
		prBranch: pr.headBranch,
		headSha: request.headSha,
		baseBranch: pr.baseBranch,
		baseSha: pr.baseSha,
		mergeCatchUp: request,
	};
}

async function deferUnknownMergeability(ctx: ScmTriggerContext, prNumber: number): Promise<void> {
	const attempt = ctx.recheckAttempt ?? 0;
	if (attempt < MAX_RECHECKS) {
		await scheduleCandidate(ctx, String(prNumber), RECHECK_DELAY_MS, 'mergeability');
		noteSkip(
			ctx,
			`The source-control provider has not yet reported whether pull request #${prNumber} is ` +
				`mergeable. SWARM re-checks in ${RECHECK_DELAY_MS / 1000}s (attempt ${attempt + 1} of ${MAX_RECHECKS}).`,
		);
		return;
	}
	logger.warn('resolve-conflicts: mergeability remained unknown; manual intervention required', {
		prNumber,
	});
	noteSkip(
		ctx,
		`The source-control provider never reported whether pull request #${prNumber} is mergeable ` +
			`after ${MAX_RECHECKS} re-checks, so SWARM stopped checking it for conflicts — inspect it by hand.`,
	);
	await scmCommentUnknownMergeability(ctx, prNumber);
}

async function scmCommentUnknownMergeability(
	ctx: ScmTriggerContext,
	prNumber: number,
): Promise<void> {
	try {
		await ctx.scm.commentOnPullRequest(
			ctx.project,
			prNumber,
			`## ⚠️ SWARM conflict check needs attention\n\nThe source-control provider did not produce a mergeability result after repeated checks. No branch changes were made. Please inspect this PR manually and retry after the provider reports its mergeability.\n\n---\n${SWARM_GENERATED_FOOTER}`,
		);
	} catch (error) {
		logger.error('resolve-conflicts: failed to post terminal mergeability comment', {
			prNumber,
			error: String(error),
		});
	}
}

/**
 * Schedule one per-PR conflict check per candidate SWARM manages. A candidate
 * whose ownership lookup *failed* is kept rather than dropped: this path can only
 * schedule, never dispatch, so the per-PR check re-runs the gate with a bounded
 * budget behind it, and a candidate that turns out not to be ours costs one
 * no-trigger job. Silently disappearing here is the failure this trigger was
 * fixed for (issue #836) and must not come back as a DB blip.
 *
 * Cost: one `runs` lookup per open candidate whose head branch decodes as one of the
 * repository's task branches — any other branch is answered with no query at all
 * (`isSwarmManagedPullRequest`). Bounded by the open-PR count on the base branch,
 * and paid once per merge into it.
 */
async function fanOutCandidates(
	ctx: ScmTriggerContext,
	candidates: PullRequestDetails[],
): Promise<void> {
	const decided = await Promise.all(
		candidates.map(async (pr) => ({
			pr,
			decision: await resolveSwarmManagedPr(ctx.project, pr.headBranch, TRIGGER_NAME),
		})),
	);
	await Promise.all(
		decided
			.filter(({ decision }) => decision === 'error' || decision.managed)
			// Due now and waiting on nothing, so it records no wait reason.
			.map(({ pr }) => scheduleCandidate(ctx, String(pr.number), 0, null)),
	);
}

/**
 * The run-history lookup did not answer, so ownership is unknown — deferred, not
 * skipped, exactly as `review.ts` degrades the same failure to a recheck. It
 * spends this trigger's existing `recheckAttempt` allowance rather than one of
 * its own; a spent allowance stops at a warn, with no dispatch and no
 * pull-request comment (the unknown-mergeability notice describes the *provider*
 * declining to answer, which this is not).
 */
async function deferUnresolvedOwnership(ctx: ScmTriggerContext, prNumber: number): Promise<void> {
	const attempt = ctx.recheckAttempt ?? 0;
	if (attempt < MAX_RECHECKS) {
		await scheduleCandidate(ctx, String(prNumber), RECHECK_DELAY_MS, 'read-failed');
		noteSkip(
			ctx,
			`SWARM's run history could not confirm pull request #${prNumber} is one SWARM implemented ` +
				`(the lookup failed). SWARM re-checks in ${RECHECK_DELAY_MS / 1000}s (attempt ${attempt + 1} of ${MAX_RECHECKS}).`,
		);
		return;
	}
	logger.warn('resolve-conflicts: PR ownership stayed unresolved; giving up', {
		prNumber,
		attempts: ctx.recheckAttempt,
	});
	noteSkip(
		ctx,
		`SWARM's run history never confirmed pull request #${prNumber} is one SWARM implemented ` +
			`after ${MAX_RECHECKS} re-checks, so SWARM stopped checking it for conflicts.`,
	);
}

/** `authorLogin` is carried for diagnostics only — it is never a gate. */
function logOwnershipSkip(
	candidate: PullRequestDetails,
	decision: Extract<SwarmManagedPrResult, { managed: false }>,
): void {
	if (decision.reason === 'no-run') {
		logger.warn(
			'resolve-conflicts: PR branch matches SWARM format but has no Implementation run row — skipping',
			{
				prNumber: candidate.number,
				prBranch: candidate.headBranch,
				prAuthorLogin: candidate.authorLogin,
				taskId: decision.taskId,
			},
		);
		return;
	}
	logger.debug('resolve-conflicts: PR is not linked to a SWARM work item — skipping', {
		prNumber: candidate.number,
		prBranch: candidate.headBranch,
		prAuthorLogin: candidate.authorLogin,
	});
}
