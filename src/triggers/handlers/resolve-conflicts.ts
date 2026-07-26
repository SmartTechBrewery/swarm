import { scheduleCoalescedDispatch } from '../../dispatch/dispatcher.js';
import { logger } from '../../lib/logger.js';
import type { ScmEvent } from '../../scm/events.js';
import { SWARM_GENERATED_FOOTER } from '../../scm/swarm-origin.js';
import { buildConflictResolutionKey, claimConflictResolution } from '../resolve-conflicts-dedup.js';
import type { ScmTriggerContext, TriggerHandler, TriggerResult } from '../types.js';

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
		name: 'resolve-conflicts',
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
			const ours = await listSwarmCandidates(ctx);

			if (!ctx.event.conflictPrNumber) {
				await Promise.all(ours.map((pr) => scheduleCandidate(ctx, String(pr.number), 0)));
				return null;
			}

			const candidate = ours.find((pr) => String(pr.number) === ctx.event.conflictPrNumber);
			if (!candidate) return null;
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
		},
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

async function listSwarmCandidates(ctx: ScmTriggerContext) {
	const candidates = await ctx.scm.listConflictCandidates(
		ctx.project,
		ctx.event.baseBranch ?? ctx.project.baseBranch,
	);
	const identities = await ctx.scm.resolvePersonaIdentities(ctx.project);
	return candidates.filter(
		(pr) => pr.authorLogin && ctx.scm.isSwarmActor(pr.authorLogin, identities),
	);
}
