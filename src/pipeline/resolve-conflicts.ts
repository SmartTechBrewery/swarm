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
	advancedBaseHead,
	assertRemoteHead,
	type ConflictHandoff,
	ConflictHandoffSchema,
	type ConflictVerification,
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
	UnretryableDeliveryError,
} from '../scm/delivery.js';
import { GitWorktreeManager } from '../worker/git-worktree-manager.js';
import { graftEnvironment } from '../worktree/graft.js';
import { settleMergeResolution } from './merge-resolution.js';
import {
	buildBaseAdvancedRemergePrompt,
	buildMigrationJournalRepairPrompt,
	buildResolveConflictsPrompt,
} from './prompts/resolve-conflicts.js';
import {
	acquireResumableWorktree,
	cleanupUnlessPreserved,
	repairSessionId,
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

/**
 * How many extra resolution passes one run spends chasing a base branch that
 * keeps advancing (issue #1001).
 *
 * The window between reading the base and pushing is this phase's own runtime —
 * minutes — so on a repository SWARM itself merges into, losing the race once is
 * ordinary rather than unlucky, and catching up is cheap: only what the base
 * gained since the last pass can conflict. Losing it repeatedly means the base is
 * moving faster than the phase can resolve, which more agent runs do not fix, so
 * the bound is small and the run then says so and delivers nothing.
 */
const MAX_BASE_ADVANCE_REMERGES = 2;

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
	/** The run's real base branch, which the repair prompt tells the agent to leave alone. */
	baseBranch: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	runAgent: typeof runAgentCli;
}

/**
 * Everything the post-agent gates and a catch-up re-merge need about the run
 * (issue #1001), so the initial resolution and every later pass are gated by one
 * body rather than by copies that can drift apart.
 */
interface MergePassContext extends GuardMigrationJournalOptions {
	/** The pull request's head branch — the branch a re-merge pass is standing on. */
	prBranch: string;
}

/**
 * Deterministic backstop behind {@link buildResolveConflictsPrompt}'s migration
 * guidance (see that prompt's `migrationConflictGuidance` and this module's
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
 *
 * Returns whether a repair pass was attempted, which is exactly the window in
 * which the hand-off on disk can have changed under the caller: the repair
 * prompt ends by telling that agent to rewrite the hand-off if its fix changes
 * `body` or `verification` (`buildMigrationJournalRepairPrompt`). An attempt
 * that exited non-zero or could not be run counts — it may still have written
 * the file before it died.
 */
async function guardMigrationJournal(options: GuardMigrationJournalOptions): Promise<boolean> {
	const { worktreePath, taskId, prNumber, headSha } = options;
	const migrationsDir = join(worktreePath, 'src/db/migrations');
	const issues = validateMigrationJournal(migrationsDir);
	if (issues.length === 0) return false;

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
			args: [buildMigrationJournalRepairPrompt(issues, options.baseBranch)],
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
	return true;
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

/**
 * The verification the agent reported, read for what it says about the merge
 * (issue #924). A `pre-existing-failure` is delivered — refusing it would only
 * teach the next agent to write `passed`, which is exactly what the old single
 * literal did — but it is logged at `warn`, as `settleResolvedPaths` logs the
 * drift it settles, so a merge delivered with failures stays attributable. A
 * `failed` entry is the opposite claim — this merge broke it — so it stops the
 * phase here: before the repair pass, the commit, the push and the comment.
 *
 * Called twice on a merge that needed a migration-journal repair pass, because
 * the hand-off it gates is a file the repair prompt explicitly lets that pass
 * rewrite. The first call is what saves the wasted agent run; the second reads
 * what the pass actually left on disk, and is the one the commit, the push and
 * the comment body are bound to. That path warns twice for a pre-existing
 * failure both hand-offs report, which is the honest reading — two hand-offs
 * were gated — and cheaper than teaching this to diff them.
 *
 * Deliberately a plain `Error`, not an `UnretryableDeliveryError`: that class is
 * for refusals nothing between attempts can change, while a re-run resolves the
 * merge from scratch and can genuinely produce a tree that builds. The message
 * is what the phase-failure report posts, so it names the commands and the
 * agent's own detail — a broken merge, not a schema complaint.
 */
function assertMergeVerified(
	handoff: ConflictHandoff,
	context: { taskId: string; prNumber: string; headSha: string },
): void {
	const describe = (entries: readonly ConflictVerification[]) =>
		entries.map((entry) => `\`${entry.command}\`: ${entry.detail}`).join('; ');
	const preExisting = handoff.verification.filter((e) => e.outcome === 'pre-existing-failure');
	if (preExisting.length > 0)
		logger.warn(
			'resolve-conflicts: delivering a merge whose failures the agent reports as pre-existing',
			{ ...context, verification: describe(preExisting) },
		);
	const failed = handoff.verification.filter((e) => e.outcome === 'failed');
	if (failed.length > 0)
		throw new Error(
			`resolve-conflicts: the merge for PR #${context.prNumber} fails verification the agent attributes to the merge itself — ${describe(failed)}. Nothing was committed or pushed; the pull request is still conflicted.`,
		);
}

/** The one subject every pass's merge commit carries. */
function mergeCommitSubject(baseBranch: string, prBranch: string): string {
	return `chore: merge ${baseBranch} into ${prBranch}`;
}

/**
 * Read, gate and settle the merge an agent pass just left, and return the
 * hand-off delivery is bound to — the three backstops in their established
 * order, in one place so a catch-up pass (issue #1001) is gated exactly as the
 * first pass is rather than delivering past them.
 */
async function gatePreparedMerge(ctx: MergePassContext): Promise<ConflictHandoff> {
	const context = { taskId: ctx.taskId, prNumber: ctx.prNumber, headSha: ctx.headSha };
	let handoff = readHandoff(
		ctx.worktreePath,
		RESOLVE_CONFLICTS_OUTCOME_FILENAME,
		ConflictHandoffSchema,
	);
	// Before the repair pass and every delivery step, so a merge we are going to
	// refuse never spends an agent run or reaches the remote (issue #924).
	assertMergeVerified(handoff, context);
	const repairPassRan = await guardMigrationJournal(ctx);
	// After the repair pass, which can still edit files.
	await settleResolvedPaths(ctx.worktreePath, context);
	// The repair prompt tells that pass to rewrite the hand-off when its fix
	// changes `body` or `verification`, so the gate above only ever covered what
	// the merge agent wrote. Re-read and re-gate whatever it actually left, and
	// bind the delivery steps to that: otherwise a repair pass that re-ran the
	// suite and reported `failed` would be committed, pushed and commented on
	// with the pre-repair body claiming success.
	if (repairPassRan) {
		handoff = readHandoff(
			ctx.worktreePath,
			RESOLVE_CONFLICTS_OUTCOME_FILENAME,
			ConflictHandoffSchema,
		);
		assertMergeVerified(handoff, context);
	}
	return handoff;
}

/**
 * The report for a run the base branch simply outran (issue #1001). The error
 * class does not survive the federated wire, so this message is the whole thing
 * an operator gets (see {@link UnretryableDeliveryError}): it names the branch
 * that moved, where it moved to, how much was spent chasing it, and the fact that
 * nothing was delivered. `Stale merge:` is the greppable prefix, deliberately
 * distinct from `validatePreparedTree`'s `Unsafe delivery:` — this refusal is
 * about the remote, not about the tree.
 */
function staleMergeMessage(ctx: MergePassContext, advancedTo: string, remerges: number): string {
	return (
		`Stale merge: base branch '${ctx.baseBranch}' advanced to ${advancedTo} while PR #${ctx.prNumber}'s ` +
		`conflicts were being resolved, and kept advancing through ${remerges} re-merge ` +
		`${remerges === 1 ? 'pass' : 'passes'}, so the merge built here would land on a pull request that ` +
		`is conflicted again. Nothing was pushed or commented and the branch is untouched on the remote. ` +
		`Re-run this phase once '${ctx.baseBranch}' has settled.`
	);
}

/**
 * Prove the merge about to be pushed still contains the base branch **as it
 * stands now**, and merge the base in again — bounded by
 * {@link MAX_BASE_ADVANCE_REMERGES} — when it does not (issue #1001).
 *
 * This is the other end of the staleness `GitWorktreeManager.provision()` guards
 * at the start of a phase. The resolution is built against one read of
 * `origin/<base>` and delivered minutes later; a merge landing in between makes
 * the pull request conflicting again the instant the push lands, and the run
 * still settles `phase-succeeded` over it. Asked here — after the commit, before
 * the push, the comment and the outcome — so a resolution that lost the race
 * costs an extra pass rather than a green run over a conflicted pull request.
 *
 * A catch-up pass is a *second merge on top of the first*, not a redo: the
 * previous commit stays, only what the base gained is merged again, and each pass
 * goes through {@link gatePreparedMerge} and {@link commitPreparedTree} exactly as
 * the first did. That also means a pass with nothing to merge is refused by
 * `validatePreparedTree` rather than silently pushed.
 *
 * Exhausting the bound throws an {@link UnretryableDeliveryError} rather than a
 * plain error, because deferring is the one thing that must not happen: a
 * deferred delivery resumes *without* re-running the agent
 * ({@link resumedDeliveryAgent}), which is precisely a push of the stale merge
 * this exists to stop.
 */
async function catchUpWithAdvancedBase(
	ctx: MergePassContext,
	state: { commitSha: string; handoff: ConflictHandoff },
	commitIdentity: { name: string; email: string },
): Promise<{ commitSha: string; handoff: ConflictHandoff }> {
	let { commitSha, handoff } = state;
	// A fresh pass mints its own session on a self-minting CLI, so the id the next
	// one may resume is the one the last pass actually reported.
	let resumeSessionId = ctx.resumeSessionId;
	for (let remerges = 0; ; remerges++) {
		const advancedTo = await advancedBaseHead(ctx.worktreePath, ctx.baseBranch, commitSha);
		if (!advancedTo) return { commitSha, handoff };
		if (remerges >= MAX_BASE_ADVANCE_REMERGES)
			throw new UnretryableDeliveryError(staleMergeMessage(ctx, advancedTo, remerges));
		logger.warn(
			'resolve-conflicts: the base advanced while the conflicts were being resolved — merging it again',
			{
				taskId: ctx.taskId,
				prNumber: ctx.prNumber,
				baseBranch: ctx.baseBranch,
				advancedTo,
				mergeCommitSha: commitSha,
				remerge: remerges + 1,
			},
		);
		const pass = await ctx.runAgent({
			cli: ctx.cli,
			model: ctx.model,
			reasoning: ctx.reasoning,
			resumeSessionId,
			cwd: ctx.worktreePath,
			args: [
				buildBaseAdvancedRemergePrompt({
					prNumber: ctx.prNumber,
					prBranch: ctx.prBranch,
					baseBranch: ctx.baseBranch,
					baseSha: advancedTo,
					deliveredSha: commitSha,
				}),
			],
			maxOutputBytes: 1_000_000,
			logContext: {
				taskId: ctx.taskId,
				phase: 'resolve-conflicts-base-advanced',
				prNumber: ctx.prNumber,
				headSha: ctx.headSha,
				baseSha: advancedTo,
			},
			timeoutMs: ctx.timeoutMs,
			signal: ctx.signal,
		});
		if (pass.exitCode !== 0)
			throw agentRunError(
				pass,
				`Resolve-conflicts re-merge agent (${ctx.cli}) exited with code ${pass.exitCode}`,
				` for PR #${ctx.prNumber}`,
			);
		resumeSessionId = pass.sessionId ?? resumeSessionId;
		const passContext = { ...ctx, resumeSessionId };
		handoff = await gatePreparedMerge(passContext);
		commitSha = await commitPreparedTree(
			ctx.worktreePath,
			mergeCommitSubject(ctx.baseBranch, ctx.prBranch),
			commitIdentity,
		);
	}
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
		const mergeContext: MergePassContext = {
			worktreePath: handle.path,
			cli,
			model,
			reasoning,
			resumeSessionId: repairSessionId(cli, agent, { sessionId, resumeSessionId }, resumed),
			taskId,
			prNumber,
			prBranch,
			headSha,
			baseBranch,
			timeoutMs,
			signal,
			runAgent,
		};
		// A resumed delivery already passed every gate in the attempt that first
		// wrote the hand-off — delivery progress only exists past this point — so
		// they are safe to skip here, bar the cheap read of what the agent claimed;
		// only a fresh merge this call actually produced needs the rest. See
		// `validateMigrationJournal`'s own header (issue #503/#508) and
		// `settleResolvedPaths` above (issue #844) for why each exists.
		let handoff: ConflictHandoff;
		if (shouldResumeDelivery) {
			handoff = readHandoff(handle.path, RESOLVE_CONFLICTS_OUTCOME_FILENAME, ConflictHandoffSchema);
			// Before every delivery step, so a merge we are going to refuse never
			// reaches the remote (issue #924).
			assertMergeVerified(handoff, { taskId, prNumber, headSha });
		} else {
			handoff = await gatePreparedMerge(mergeContext);
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
				mergeCommitSubject(baseBranch, prBranch),
				delivery.commitIdentity,
			);
			saveDeliveryProgress(handle.path, progress);
		}
		if (!progress.pushed) {
			// The base can advance between the read this resolution was built on and
			// this push — on a repository SWARM itself merges into, well within the
			// phase's own runtime (issue #1001). Prove it has not before the branch, the
			// run row and the posted comment all say the conflict is resolved.
			const caughtUp = await catchUpWithAdvancedBase(
				mergeContext,
				{ commitSha: progress.commitSha, handoff },
				delivery.commitIdentity,
			);
			if (caughtUp.commitSha !== progress.commitSha) {
				progress.commitSha = caughtUp.commitSha;
				saveDeliveryProgress(handle.path, progress);
			}
			// Bound the comment and the outcome to whatever the last pass actually left.
			handoff = caughtUp.handoff;
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
