import { join } from 'node:path';
import { z } from 'zod';
import type { ProjectConfig } from '../config/schema.js';
import { validateMigrationJournal } from '../db/migration-journal.js';
import {
	type AgentCli,
	type AgentCliResult,
	describeAgent,
	runAgentCli,
} from '../harness/agent-cli.js';
import { agentRunError } from '../harness/agent-failure.js';
import type { ReasoningLevel } from '../harness/models.js';
import { requireProjectSCMProvider } from '../integrations/scm/registry.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { RecoveryMode } from '../queue/jobs.js';
import {
	assertRemoteHead,
	ConflictHandoffSchema,
	commitPreparedTree,
	DeliveryDeferredError,
	deliveryIdentity,
	HANDOFF_FILENAMES,
	loadDeliveryProgress,
	pushDeliveredBranch,
	readHandoff,
	resumedDeliveryAgent,
	type ScmDeliveryProvider,
	saveDeliveryProgress,
	shouldDeferDeliveryFailure,
} from '../scm/delivery.js';
import { GitWorktreeManager } from '../worker/git-worktree-manager.js';
import { graftEnvironment } from '../worktree/graft.js';
import { settleMergeResolution } from './merge-resolution.js';
import {
	buildMigrationJournalRepairPrompt,
	buildResolveConflictsPrompt,
} from './prompts/resolve-conflicts.js';
import {
	acquireResumableWorktree,
	cleanupUnlessPreserved,
	sessionRunArgs,
	shouldPreserveFailedCheckout,
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

interface GuardMigrationJournalOptions {
	worktreePath: string;
	cli: AgentCli;
	model?: string;
	reasoning?: ReasoningLevel;
	/** The session to continue, so the repair pass still holds the merge it just did. */
	resumeSessionId?: string;
	taskId: string;
	prNumber: string;
	headSha: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	runAgent: typeof runAgentCli;
}

/**
 * Deterministic backstop behind {@link buildResolveConflictsPrompt}'s migration
 * guidance (see that prompt's `MIGRATION_CONFLICT_GUIDANCE` and this module's
 * header — issue #503/#508's own incident): validate the merge this call just
 * produced against drizzle's own migration-journal invariants, and — mirroring
 * `readReviewSubmission`/`repairReviewHandoff`'s one-repair-pass shape in
 * `src/pipeline/review.ts` — give the same agent session exactly one chance to
 * fix it with the validator's own complaint before failing the phase outright.
 *
 * Runs before any commit/push (the caller places this ahead of
 * `commitPreparedTree`), so a still-broken journal after the repair pass fails
 * the phase with nothing delivered — never a broken migration state pushed to
 * the PR for a human or a future review pass to discover instead.
 */
async function guardMigrationJournal(options: GuardMigrationJournalOptions): Promise<void> {
	const { worktreePath, taskId, prNumber, headSha } = options;
	const migrationsDir = join(worktreePath, 'src/db/migrations');
	const issues = validateMigrationJournal(migrationsDir);
	if (issues.length === 0) return;

	logger.warn(
		'resolve-conflicts: merged migration journal failed validation — running one repair pass',
		{ taskId, prNumber, headSha, issues },
	);
	try {
		const repairAgent = await options.runAgent({
			cli: options.cli,
			model: options.model,
			reasoning: options.reasoning,
			resumeSessionId: options.resumeSessionId,
			cwd: worktreePath,
			args: [buildMigrationJournalRepairPrompt(issues)],
			maxOutputBytes: 1_000_000,
			logContext: { taskId, phase: 'resolve-conflicts-migration-repair', prNumber, headSha },
			timeoutMs: options.timeoutMs,
			signal: options.signal,
		});
		if (repairAgent.exitCode !== 0) {
			logger.warn('resolve-conflicts: migration-journal repair pass exited non-zero', {
				taskId,
				prNumber,
				headSha,
				exitCode: repairAgent.exitCode,
			});
		}
	} catch (error) {
		logger.warn('resolve-conflicts: migration-journal repair pass could not be run', {
			taskId,
			prNumber,
			headSha,
			error: describeError(error),
		});
	}

	const remaining = validateMigrationJournal(migrationsDir);
	if (remaining.length > 0) {
		throw new Error(
			`resolve-conflicts: merged migration journal for PR #${prNumber} still fails validation after one repair pass: ${remaining.join(' ')}`,
		);
	}
	logger.info('resolve-conflicts: migration-journal repair pass fixed the merge', {
		taskId,
		prNumber,
		headSha,
	});
}

/**
 * The phase's second deterministic backstop, behind
 * {@link buildResolveConflictsPrompt}'s `INDEX_RESOLUTION_GUIDANCE` (issue
 * #844): the agent verifies its merge by scanning the files for conflict
 * markers, while `validatePreparedTree` asks the *index*. Those are different
 * questions, and only the second gates delivery — so settle the index for
 * whatever the agent really did resolve.
 *
 * Deliberately raises nothing of its own for a path left unmerged: that is a
 * genuine ambiguity, and letting `validatePreparedTree` refuse it keeps one
 * refusal message and one classification (issue #839's) rather than two
 * competing ones. Anything staged is logged at `warn`, because the agent left
 * drift and that should be attributable.
 */
async function settleResolvedPaths(
	worktreePath: string,
	context: { taskId: string; prNumber: string; headSha: string },
): Promise<void> {
	const settlement = await settleMergeResolution(worktreePath);
	if (settlement.staged.length > 0)
		logger.warn('resolve-conflicts: staged merge-resolved paths the agent left unmerged', {
			...context,
			staged: settlement.staged,
			unresolved: settlement.unresolved,
		});
	else
		logger.debug('resolve-conflicts: merge resolution left nothing to stage', {
			...context,
			unresolved: settlement.unresolved,
		});
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
		runId,
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
			// Either tier may claim this checkout: Tier 1's resumable session, or — when it
			// cannot apply — the Tier 2 checkpoint the agent left in the worktree.
			preserveForResume = shouldPreserveFailedCheckout(
				error,
				handle.path,
				'resolve-conflicts',
				resumed,
			);
			throw error;
		}
		const handoff = readHandoff(
			handle.path,
			RESOLVE_CONFLICTS_OUTCOME_FILENAME,
			ConflictHandoffSchema,
		);
		// A resumed delivery already passed both gates in the attempt that first
		// wrote `handoff` — delivery progress only exists past this point — so they
		// are safe to skip here; only a fresh merge this call actually produced
		// needs checking. See `validateMigrationJournal`'s own header (issue
		// #503/#508) and `settleResolvedPaths` above (issue #844) for why each exists.
		if (!shouldResumeDelivery) {
			await guardMigrationJournal({
				worktreePath: handle.path,
				cli,
				model,
				reasoning,
				resumeSessionId: agent.sessionId ?? (resumed ? resumeSessionId : sessionId),
				taskId,
				prNumber,
				headSha,
				timeoutMs,
				signal,
				runAgent,
			});
			// After the repair pass, which can still edit files.
			await settleResolvedPaths(handle.path, { taskId, prNumber, headSha });
		}
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
			await pushDeliveredBranch(delivery, handle.path, prBranch, progress.commitSha);
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
		// `shouldDeferDeliveryFailure` (not a bare progress check): a refusal that is a
		// property of the prepared tree, or of a branch that cannot fast-forward, settles
		// terminally rather than spending the retry budget re-validating identical state
		// (#558, generalised by #839).
		if (shouldDeferDeliveryFailure(error, handle.path)) {
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
