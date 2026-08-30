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
 */

import { scheduleCoalescedDispatch } from '../../dispatch/dispatcher.js';
import { logger } from '../../lib/logger.js';
import type { ScmEvent } from '../../scm/events.js';
import { SWARM_GENERATED_FOOTER } from '../../scm/swarm-origin.js';
import type { PullRequestDetails } from '../../scm/types.js';
import { buildConflictResolutionKey, claimConflictResolution } from '../resolve-conflicts-dedup.js';
import { resolveSwarmManagedPr, type SwarmManagedPrResult } from '../swarm-managed-pr.js';
import type { ScmTriggerContext, TriggerHandler, TriggerResult } from '../types.js';

const TRIGGER_NAME = 'resolve-conflicts';
const RECHECK_DELAY_MS = 30_000;
const MAX_RECHECKS = 20;

async function scheduleCandidate(
	ctx: ScmTriggerContext,
	prNumber: string,
	delay: number,
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
		`resolve-conflicts:${ctx.project.repo}:${prNumber}:${ctx.event.baseBranch}`,
		delay,
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
				ctx.event.action === 'closed' &&
				ctx.event.merged === true
			);
		},
		async handle(ctx): Promise<TriggerResult | null> {
			if (ctx.source !== 'scm' || !ctx.event.baseBranch) return null;
			const candidates = await ctx.scm.listConflictCandidates(ctx.project, ctx.event.baseBranch);

			if (!ctx.event.conflictPrNumber) {
				await fanOutCandidates(ctx, candidates);
				return null;
			}

			const candidate = candidates.find((pr) => String(pr.number) === ctx.event.conflictPrNumber);
			return candidate ? checkCandidate(ctx, candidate) : null;
		},
	};
}

/**
 * The per-PR path: decide ownership, then mergeability, then claim the head/base
 * state and dispatch. Ownership comes first, mirroring `review.ts` — a PR that is
 * not ours must not spend rechecks waiting for a mergeability answer that would
 * be discarded anyway.
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
		return null;
	}

	if (candidate.mergeable === null) {
		await deferUnknownMergeability(ctx, candidate.number);
		return null;
	}
	if (candidate.mergeable) return null;

	const stateKey = buildConflictResolutionKey(
		ctx.project.repo,
		String(candidate.number),
		candidate.headSha,
		candidate.baseSha,
	);
	if (
		!ctx.runId &&
		!ctx.continuationDispatchClaimed &&
		!(await claimConflictResolution(stateKey))
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

async function deferUnknownMergeability(ctx: ScmTriggerContext, prNumber: number): Promise<void> {
	if ((ctx.recheckAttempt ?? 0) < MAX_RECHECKS) {
		await scheduleCandidate(ctx, String(prNumber), RECHECK_DELAY_MS);
		return;
	}
	logger.warn('resolve-conflicts: mergeability remained unknown; manual intervention required', {
		prNumber,
	});
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
 * Cost: one `runs` lookup per open candidate whose head branch decodes under the
 * project's `branchPrefix` — a branch outside it is answered with no query at all
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
			.map(({ pr }) => scheduleCandidate(ctx, String(pr.number), 0)),
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
	if ((ctx.recheckAttempt ?? 0) < MAX_RECHECKS) {
		await scheduleCandidate(ctx, String(prNumber), RECHECK_DELAY_MS);
		return;
	}
	logger.warn('resolve-conflicts: PR ownership stayed unresolved; giving up', {
		prNumber,
		attempts: ctx.recheckAttempt,
	});
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
