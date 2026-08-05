import { z } from 'zod';
import type { ProjectConfig } from '../config/schema.js';
import {
	type AgentCli,
	type AgentCliResult,
	describeAgent,
	runAgentCli,
} from '../harness/agent-cli.js';
import { agentRunError } from '../harness/agent-failure.js';
import type { ReasoningLevel } from '../harness/models.js';
import { requireProjectSCMProvider } from '../integrations/scm/registry.js';
import { logger } from '../lib/logger.js';
import type { RecoveryMode } from '../queue/jobs.js';
import {
	assertRemoteHead,
	ConflictHandoffSchema,
	commitPreparedTree,
	DeliveryDeferredError,
	deliveryIdentity,
	HANDOFF_FILENAMES,
	hasDeliveryProgress,
	loadDeliveryProgress,
	readHandoff,
	resumedDeliveryAgent,
	type ScmDeliveryProvider,
	saveDeliveryProgress,
} from '../scm/delivery.js';
import { GitWorktreeManager } from '../worker/git-worktree-manager.js';
import { graftEnvironment } from '../worktree/graft.js';
import { buildResolveConflictsPrompt } from './prompts/resolve-conflicts.js';
import {
	acquireResumableWorktree,
	cleanupUnlessPreserved,
	sessionRunArgs,
	shouldPreserveForResume,
} from './resume.js';

export const RESOLVE_CONFLICTS_OUTCOME_FILENAME = HANDOFF_FILENAMES.resolveConflicts;

// The static resolve-conflicts prompt now lives in
// `src/pipeline/prompts/resolve-conflicts.ts` (issue #135); re-exported so
// existing importers of `@/pipeline/resolve-conflicts.js` keep resolving it.
export { buildResolveConflictsPrompt };
export const ResolveConflictsOutcomeSchema = z.object({
	status: z.literal('resolved'),
	mergeCommitSha: z.string().min(7),
});
export type ResolveConflictsOutcome = z.infer<typeof ResolveConflictsOutcomeSchema>;

/** Coded default CLI for the resolve-conflicts phase (mirrors the other phases). */
export const DEFAULT_RESOLVE_CONFLICTS_CLI: AgentCli = 'claude';

export interface RunResolveConflictsPhaseOptions {
	project: ProjectConfig;
	prNumber: string;
	prBranch: string;
	headSha: string;
	baseBranch: string;
	baseSha: string;
	taskId: string;
	cli?: AgentCli;
	model?: string;
	/** Reasoning level for the agent's session. Omit for the CLI/model default (issue #180). */
	reasoning?: ReasoningLevel;
	/**
	 * Project's optional custom prompt for this phase (`agents.resolveConflicts.prompt`,
	 * issue #135) — appended to the static SWARM prompt as a supplement-only
	 * section. Omit for today's prompt exactly.
	 */
	customPrompt?: string;
	/** Assign a fresh session id (`sessionId`) or resume from one on retry (`resumeSessionId`). */
	sessionId?: string;
	resumeSessionId?: string;
	/** The database run id. */
	runId?: string;
	/** Mode for recovering a cancelled preserved worktree. */
	recoveryMode?: RecoveryMode;
	/** Resume deterministic delivery from a preserved worktree without rerunning the agent. */
	resumeDelivery?: boolean;
	timeoutMs?: number;
	signal?: AbortSignal;
	worktrees?: GitWorktreeManager;
	runAgent?: typeof runAgentCli;
	graft?: typeof graftEnvironment;
	delivery?: ScmDeliveryProvider;
}

export async function runResolveConflictsPhase(
	options: RunResolveConflictsPhaseOptions,
): Promise<{ agent: AgentCliResult; outcome: ResolveConflictsOutcome }> {
	const {
		project,
		prNumber,
		prBranch,
		headSha,
		baseBranch,
		baseSha,
		taskId,
		cli = DEFAULT_RESOLVE_CONFLICTS_CLI,
		model,
		reasoning,
		customPrompt,
		sessionId,
		resumeSessionId,
		runId,
		recoveryMode,
		resumeDelivery = false,
		timeoutMs,
		signal,
		runAgent = runAgentCli,
		graft = graftEnvironment,
	} = options;
	const worktrees = options.worktrees ?? new GitWorktreeManager(project);
	logger.info(
		`Phase started - Resolve-conflicts — running ${describeAgent(cli, model, reasoning)}`,
		{
			taskId,
			prNumber,
			headSha,
			baseSha,
			reasoning,
		},
	);
	// On a resume retry, reuse the preserved checkout so a partial merge resolution
	// and the agent's session carry over.
	const { handle, resumed, deliveryResumed, checkpoint } = await acquireResumableWorktree(
		worktrees,
		taskId,
		'resolve-conflicts',
		prBranch,
		false,
		resumeSessionId,
		() => worktrees.provision(taskId, { createBranch: false, branch: prBranch, runId }),
		resumeDelivery,
		recoveryMode,
		project.id,
	);
	let preserveForResume = false;
	try {
		graft(project.repoRoot, handle.path);
		const shouldResumeDelivery = deliveryResumed;
		const agent = shouldResumeDelivery
			? resumedDeliveryAgent(cli)
			: await runAgent({
					cli,
					model,
					reasoning,
					...sessionRunArgs({ sessionId, resumeSessionId }, resumed, recoveryMode),
					cwd: handle.path,
					args: [
						buildResolveConflictsPrompt(
							{
								project,
								prNumber,
								prBranch,
								headSha,
								baseBranch,
								baseSha,
								checkpoint,
							},
							customPrompt,
						),
					],
					maxOutputBytes: 1_000_000,
					logContext: { taskId, phase: 'resolve-conflicts', prNumber, headSha, baseSha },
					timeoutMs,
					signal,
				});
		if (agent.exitCode !== 0) {
			const error = agentRunError(
				agent,
				`Resolve-conflicts agent (${cli}) exited with code ${agent.exitCode}`,
				` for PR #${prNumber}`,
			);
			preserveForResume = shouldPreserveForResume(error);
			throw error;
		}
		const handoff = readHandoff(
			handle.path,
			RESOLVE_CONFLICTS_OUTCOME_FILENAME,
			ConflictHandoffSchema,
		);
		const delivery =
			options.delivery ??
			(await requireProjectSCMProvider(project).deliveryProvider(project, 'implementer'));
		const deliveryId = deliveryIdentity([
			'resolve-conflicts',
			project.repo,
			prNumber,
			headSha,
			baseSha,
		]);
		const progress = loadDeliveryProgress(handle.path, deliveryId);
		saveDeliveryProgress(handle.path, progress);
		if (!progress.commitSha) {
			await assertRemoteHead(handle.path, prBranch, headSha);
			progress.commitSha = await commitPreparedTree(
				handle.path,
				`chore: merge ${baseBranch} into ${prBranch}`,
				delivery.commitIdentity,
			);
			saveDeliveryProgress(handle.path, progress);
		}
		if (!progress.pushed) {
			await delivery.pushBranch(handle.path, prBranch, progress.commitSha);
			progress.pushed = true;
			saveDeliveryProgress(handle.path, progress);
		}
		if (!progress.commentId) {
			progress.commentId = await delivery.postComment({
				prNumber: Number(prNumber),
				body: handoff.body,
				deliveryId,
			});
			saveDeliveryProgress(handle.path, progress);
		}
		const outcome = ResolveConflictsOutcomeSchema.parse({
			status: handoff.status,
			mergeCommitSha: progress.commitSha,
		});
		logger.info('Phase finished - Resolve-conflicts', { taskId, prNumber, ...outcome });
		return { agent, outcome };
	} catch (error) {
		if (hasDeliveryProgress(handle.path)) {
			preserveForResume = true;
			throw new DeliveryDeferredError('Conflict-resolution delivery deferred for retry', {
				cause: error,
			});
		}
		throw error;
	} finally {
		await cleanupUnlessPreserved(
			worktrees,
			taskId,
			preserveForResume,
			'resolve-conflicts phase',
			runId,
		);
	}
}
