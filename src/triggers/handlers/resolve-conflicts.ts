import { scheduleCoalescedDispatch } from '../../dispatch/dispatcher.js';
import { isSwarmBot, resolvePersonaIdentities } from '../../integrations/scm/github/personas.js';
import { GitHubSCMIntegration } from '../../integrations/scm/github/scm-integration.js';
import { logger } from '../../lib/logger.js';
import type { GitHubParsedEvent } from '../../router/adapters/github.js';
import { SWARM_GENERATED_FOOTER } from '../../scm/swarm-origin.js';
import { buildConflictResolutionKey, claimConflictResolution } from '../resolve-conflicts-dedup.js';
import type { TriggerContext, TriggerHandler, TriggerResult } from '../types.js';

const RECHECK_DELAY_MS = 30_000;
const MAX_RECHECKS = 20;

async function scheduleCandidate(
	ctx: Extract<TriggerContext, { source: 'github' }>,
	prNumber: string,
	delay: number,
): Promise<void> {
	const event: GitHubParsedEvent = { ...ctx.event, conflictPrNumber: prNumber };
	await scheduleCoalescedDispatch(
		{
			type: 'github',
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
				ctx.source === 'github' &&
				ctx.event.eventType === 'pull_request' &&
				ctx.event.action === 'closed' &&
				ctx.event.merged === true
			);
		},
		async handle(ctx): Promise<TriggerResult | null> {
			if (ctx.source !== 'github' || !ctx.event.baseBranch) return null;
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

async function deferUnknownMergeability(
	ctx: Extract<TriggerContext, { source: 'github' }>,
	prNumber: number,
): Promise<void> {
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
	ctx: Extract<TriggerContext, { source: 'github' }>,
	prNumber: number,
): Promise<void> {
	try {
		await new GitHubSCMIntegration().commentOnPullRequest(
			ctx.project,
			prNumber,
			`## ⚠️ SWARM conflict check needs attention\n\nGitHub did not produce a mergeability result after repeated checks. No branch changes were made. Please inspect this PR manually and retry after GitHub reports its mergeability.\n\n---\n${SWARM_GENERATED_FOOTER}`,
		);
	} catch (error) {
		logger.error('resolve-conflicts: failed to post terminal mergeability comment', {
			prNumber,
			error: String(error),
		});
	}
}

async function listSwarmCandidates(ctx: Extract<TriggerContext, { source: 'github' }>) {
	const candidates = await new GitHubSCMIntegration().listConflictCandidates(
		ctx.project,
		ctx.event.baseBranch ?? ctx.project.baseBranch,
	);
	const identities = await resolvePersonaIdentities(ctx.project);
	return candidates.filter((pr) => pr.authorLogin && isSwarmBot(pr.authorLogin, identities));
}
