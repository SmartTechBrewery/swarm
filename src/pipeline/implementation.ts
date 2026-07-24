/**
 * Implementation phase (PROJECT.md §5.2, ai/ARCHITECTURE.md "Pipeline phases" #2).
 *
 * An item moves to "ToDo" on the board → the worker runs this: move the item to
 * "In progress" to report that the agent has picked up the task (a status
 * report, not a trigger — see `src/pm/pipeline.ts`; this move is unconditional),
 * provision a worktree on the task branch (not detached — unlike Planning, this
 * phase commits and pushes), graft the environment, spin up Claude Code as the
 * implementer to implement the plan / run tests / commit / push / open a PR,
 * post the PR link back on the item, and move it to "In review" when the Review
 * phase is enabled. Review itself starts from PR lifecycle events, not this
 * Projects status report.
 *
 * Unlike Cascade — whose implementer opens the PR through a `CreatePR` gadget
 * exposed to the agent — SWARM's harness is deliberately narrow (`runAgentCli`
 * only spawns the CLI, no gadget layer; see ai/ARCHITECTURE.md "Harness"). So the
 * agent opens the PR itself via `gh` (the same way the `/solve-issue` skill does)
 * and hands the URL back through a file, mirroring how the Planning phase reads
 * `proposed_plan.md`. The `Closes #<n>` in the PR body is what links the PR back
 * to the Issue the Projects item wraps; the comment this phase posts is the
 * human-facing pointer.
 *
 * The implementer persona's token is resolved and handed to the agent as
 * `GH_TOKEN` (mirroring `runReviewPhase`'s reviewer-token plumbing) so `gh pr
 * create` opens the PR as that persona, not whatever `gh auth` session happens
 * to be ambient on the worker's host. Since issue #396 the implementer token is
 * the worker operator's own token (`SWARM_OPERATOR_GH_TOKEN`, resolved through
 * the same `getPersonaToken(project, 'implementer')` seam), so the PR is authored
 * by the operator's account — and that *is* the identity loop-prevention resolves
 * for the implementer (`resolvePersonaIdentities`, from the same token), so the
 * author-persona gate (`ai/ARCHITECTURE.md`, `src/triggers/handlers/review.ts`)
 * still recognises the PR as SWARM-authored. Confirmed live before that change:
 * without a persona `GH_TOKEN` the PR came back under whatever ambient `gh auth`
 * login the host had, which the gate refuses to review — "not a SWARM persona" —
 * silently stranding the item in "In review" forever with nothing to trigger
 * Review, let alone Respond-to-review after it.
 *
 * This is the phase's orchestration only. It composes the building blocks that
 * already exist — `GitWorktreeManager` (SWARM-14), `graftEnvironment` (SWARM-15),
 * `runAgentCli` (SWARM-16), the `PMProvider` contract (SWARM-11) — and takes them
 * (plus the work item) as inputs rather than reaching for a queue or a concrete
 * GraphQL provider. The BullMQ consumer that dequeues a `TASK_TYPE_IMPLEMENTATION`
 * job and calls this, and the concrete GitHub Projects `PMProvider` adapter, are
 * their own issues (SWARM-17 and the PM-adapter issue); this lands ahead of them
 * the same way Planning did, wired up when they arrive.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getPersonaToken } from '@/config/provider.js';
import type { ProjectConfig } from '@/config/schema.js';
import {
	type AgentCli,
	type AgentCliResult,
	describeAgent,
	runAgentCli,
} from '@/harness/agent-cli.js';
import { agentRunError } from '@/harness/agent-failure.js';
import type { ReasoningLevel } from '@/harness/models.js';
import { GitHubSCMIntegration } from '@/integrations/scm/github/scm-integration.js';
import { logger } from '@/lib/logger.js';
import { DependencyBlockedError, findOpenBlockers } from '@/pipeline/dependency-guard.js';
import {
	BLOCKED_REASON_FILENAME,
	buildImplementationPrompt,
} from '@/pipeline/prompts/implementation.js';
import {
	cleanupUnlessPreserved,
	executeRecoveryGate,
	sessionRunArgs,
	shouldPreserveForResume,
} from '@/pipeline/resume.js';
import type { PmStatusKey } from '@/pm/pipeline.js';
import type { PMProvider, WorkItem } from '@/pm/types.js';
import {
	commitPreparedTree,
	DeliveryDeferredError,
	deliveryIdentity,
	HANDOFF_FILENAMES,
	hasDeliveryProgress,
	ImplementationHandoffSchema,
	loadDeliveryProgress,
	readHandoff,
	resumedDeliveryAgent,
	type ScmDeliveryProvider,
	saveDeliveryProgress,
} from '@/scm/delivery.js';
import { GitWorktreeManager, type WorktreeHandle } from '@/worker/git-worktree-manager.js';
import { graftEnvironment } from '@/worktree/graft.js';

/** The file the implementation agent is instructed to write the opened PR's URL to, at the worktree root. */
export const OPENED_PR_FILENAME = HANDOFF_FILENAMES.implementation;

// The static implementation prompt and its blocked-reason filename now live in
// `src/pipeline/prompts/implementation.ts` (issue #135); re-exported so existing
// importers of `@/pipeline/implementation.js` keep resolving them unchanged.
export { BLOCKED_REASON_FILENAME, buildImplementationPrompt };

/** Claude Code is SWARM's implementer agent (PROJECT.md §5.2). */
export const DEFAULT_IMPLEMENTATION_CLI: AgentCli = 'claude';

/**
 * Status the item moves to as soon as this phase starts, before the agent even
 * runs — reports to a human watching the board that the task has been picked
 * up. Not a trigger: entering "In progress" doesn't itself start anything
 * (`src/pm/pipeline.ts`), only the item entering "ToDo" does.
 */
const START_STATUS: PmStatusKey = 'inProgress';

/**
 * Status the item moves to once the PR is opened when Review is enabled — the
 * board's "In review". Typed to {@link PmStatusKey} so a typo fails to
 * compile rather than silently sending the item to a status the adapter can't
 * resolve. This status isn't a PM-driven phase entry point
 * (`src/pm/pipeline.ts`), so moving here can't loop back into implementation.
 */
const NEXT_STATUS: PmStatusKey = 'inReview';

/**
 * Cap on captured agent output, so a chatty/runaway Claude Code run can't grow the
 * worker's memory without bound. The PR URL is read from {@link OPENED_PR_FILENAME},
 * not from stdout, so truncating the captured stream costs nothing here.
 */
const MAX_AGENT_OUTPUT_BYTES = 1_000_000;

export interface RunImplementationPhaseOptions {
	/** The SWARM project whose board the item lives on. */
	project: ProjectConfig;
	/**
	 * The Projects item that entered "ToDo". Its `id` addresses the item
	 * for the PM provider; its `url`/`title`/`description` describe the work.
	 */
	workItem: WorkItem;
	/**
	 * Task identifier for the worktree path (`task-<taskId>`) and branch name
	 * (`<branchPrefix><taskId>`) — the linked issue number. Also the `#<n>` the PR
	 * body closes, which is what links the PR to the item. Passed explicitly rather
	 * than derived from `workItem`: the item's `id` is an opaque node ID, and the
	 * worker that dequeues the job is the layer that knows the issue number.
	 */
	taskId: string;
	/** PM provider used to post the PR-link comment and move the item's status. */
	pm: PMProvider;
	/** Worktree manager for the project — provisions and cleans up the checkout. */
	worktrees?: GitWorktreeManager;
	/** Which agent CLI to run. Defaults to Claude Code. */
	cli?: AgentCli;
	/** Model for the agent's session (e.g. 'sonnet', 'opus'). Omit for the CLI's own default. */
	model?: string;
	/** Reasoning level for the agent's session. Omit for the CLI/model default (issue #180). */
	reasoning?: ReasoningLevel;
	/**
	 * Project's optional custom prompt for this phase (`agents.implementation.prompt`,
	 * issue #135) — appended to the static SWARM prompt as a supplement-only
	 * section. Omit for today's prompt exactly.
	 */
	customPrompt?: string;
	/** Deterministic Claude session handle assigned by the run row. */
	sessionId?: string;
	/** Resume this Claude session when its preserved worktree still exists. */
	resumeSessionId?: string;
	/** The database run id. */
	runId?: string;
	/** Mode for recovering a cancelled preserved worktree. */
	recoveryMode?: 'resume' | 'fresh';
	/** Resume deterministic delivery from a preserved worktree without rerunning the agent. */
	resumeDelivery?: boolean;
	/** Resume a deferred implementation from its existing task branch. */
	resumeExistingBranch?: boolean;
	/** Called once the task branch worktree has been acquired successfully. */
	onBranchProvisioned?: () => Promise<void>;
	/** Kill the agent run after this many ms. Omit for no timeout. */
	timeoutMs?: number;
	/** External cancellation — aborting kills the agent run. */
	signal?: AbortSignal;
	/** Injectable agent runner — defaults to {@link runAgentCli}; overridden in tests. */
	runAgent?: (opts: Parameters<typeof runAgentCli>[0]) => Promise<AgentCliResult>;
	/** Injectable env-grafting step — defaults to {@link graftEnvironment}; overridden in tests. */
	graft?: typeof graftEnvironment;
	/** Provider-neutral deterministic SCM delivery seam. */
	delivery?: ScmDeliveryProvider;
	/** @deprecated Compatibility seam; production deterministic delivery leaves this unset. */
	getToken?: typeof getPersonaToken;
}

export interface ImplementationPhaseResult {
	/** The URL of the PR the agent opened, read from {@link OPENED_PR_FILENAME}. */
	prUrl: string;
	/** The branch the implementation was committed to and the PR opened from. */
	branch: string;
	/** ID of the comment the PR link was posted as. */
	commentId: string;
	/** The canonical status the item was moved to, or `undefined` when Review is disabled. */
	movedTo?: PmStatusKey;
	/** The agent run's result (exit code, duration, captured output). */
	agent: AgentCliResult;
}

/**
 * Wrap the opened PR URL in a comment body that marks it as SWARM's
 * implementation output and points the human at the open PR. The trailing note
 * reflects whether automated Review is enabled for the project.
 */
export function implementationCommentBody(prUrl: string, reviewEnabled = true): string {
	const note = reviewEnabled
		? '_Generated by SWARM (Implementation phase). This item has moved to **In review**._'
		: '_Generated by SWARM (Implementation phase). Automated Review is disabled; this item remains **In progress**._';
	return [
		'## 🚀 Implementation complete',
		'',
		`A pull request is open and ready for review: ${prUrl.trim()}`,
		'',
		'---',
		note,
	].join('\n');
}

/**
 * Log a failed implementation run's captured output before the phase throws, so
 * the worker (SWARM-17) that marks the job failed has the agent's own
 * stdout/stderr to diagnose *why* — the thrown Error carries only a message.
 * Output is already bounded by {@link MAX_AGENT_OUTPUT_BYTES}.
 */
function logAgentFailure(taskId: string, workItemId: string, agent: AgentCliResult): void {
	logger.error('Phase failed - Implementation — agent output', {
		taskId,
		workItemId,
		cli: agent.cli,
		exitCode: agent.exitCode,
		timedOut: agent.timedOut,
		durationMs: agent.durationMs,
		outputTruncated: agent.outputTruncated,
		stdout: agent.stdout,
		stderr: agent.stderr,
	});
}

/** Read an agent's concise blocker handoff, if it supplied one. */
function readBlockedReason(worktreePath: string): string | undefined {
	const path = join(worktreePath, BLOCKED_REASON_FILENAME);
	if (!existsSync(path)) return undefined;
	const reason = readFileSync(path, 'utf8').trim();
	return reason.length > 0 ? reason.slice(0, 2_000) : undefined;
}

/**
 * Run the Implementation phase for one work item. Moves the item to "In
 * progress" to report that work has started, provisions a worktree on the
 * task branch, runs the implementer agent to build the change and open a PR,
 * posts the PR link as a comment on the linked Issue, and moves the item to
 * "In review".
 *
 * Throws if the agent exits non-zero or produced no PR URL — an implementation
 * run that didn't open a PR is a failed job, not a soft miss
 * (ai/CODING_STANDARDS.md "Error handling"), and the throw lets the worker mark
 * the job failed. The worktree is always removed, success or failure; the pushed
 * branch survives cleanup so the PR is unaffected.
 *
 * Note that `GitWorktreeManager.cleanup` removes the worktree but not the local
 * `<branchPrefix><taskId>` branch it created — deliberately, so a *successful*
 * run leaves the branch for Review/Respond-to-review/Respond-to-CI to check
 * out again. A re-run after a mid-flight failure would otherwise hit
 * `git worktree add -b` "branch already exists" on the leftover branch;
 * `GitWorktreeManager.provision` now reaps that orphan itself when it's
 * provably safe to (no matching ref on `origin`), so this phase doesn't need
 * its own retry/leftover-branch handling.
 */
/**
 * Acquire the task-branch worktree for the implementation run. When resuming a
 * Claude session (`resumeSessionId`) it reuses the existing worktree so the
 * agent can `--resume` in place. A manual retry of an implementation that already
 * provisioned its branch also reuses that checkout, but starts a fresh agent
 * session. If the checkout is gone, it falls through to provision the existing
 * task branch (`resumeExistingBranch`) or a new one. `resumed` reports whether
 * an agent session, not merely the worktree, was resumed.
 */
async function acquireImplementationWorktree(
	worktrees: GitWorktreeManager,
	taskId: string,
	branch: string,
	resumeSessionId: string | undefined,
	resumeExistingBranch: boolean,
	resumeDelivery: boolean,
	recoveryMode?: 'resume' | 'fresh',
	projectId?: string,
): Promise<{ handle: WorktreeHandle; resumed: boolean; deliveryResumed: boolean }> {
	if (recoveryMode) {
		const { reuseHandle } = await executeRecoveryGate(
			worktrees,
			taskId,
			recoveryMode,
			resumeSessionId,
			projectId ?? '',
		);
		if (reuseHandle) {
			return {
				handle: reuseHandle,
				resumed: true,
				deliveryResumed: false,
			};
		}
	}
	// A checkpoint means this run already owns the task branch. Reuse its checkout
	// when it survived a failed/manual retry so a fresh agent session does not
	// collide with `task-<id>` or discard partial, unpushed work. A session is only
	// resumed when an actual resume id is present.
	if (resumeSessionId || resumeExistingBranch || resumeDelivery) {
		const handle = resumeDelivery
			? await worktrees.reuse(taskId, branch, false, hasDeliveryProgress)
			: await worktrees.reuse(taskId, branch, false);
		if (handle)
			return {
				handle,
				resumed: resumeSessionId !== undefined,
				deliveryResumed: resumeDelivery,
			};
	}
	const handle = resumeExistingBranch
		? await worktrees.provision(taskId, { createBranch: false, branch })
		: await worktrees.provision(taskId);
	return { handle, resumed: false, deliveryResumed: false };
}

/**
 * Read the PR URL the implementation agent handed back through
 * {@link OPENED_PR_FILENAME}. Throws a descriptive error when the file is
 * missing (surfacing a `blocked` reason the agent may have written instead) or
 * empty. `onInvalid` runs before each throw so the caller can log the captured
 * agent output alongside the failure.
 */
export async function runImplementationPhase(
	options: RunImplementationPhaseOptions,
): Promise<ImplementationPhaseResult> {
	const {
		project,
		workItem,
		taskId,
		pm,
		cli = DEFAULT_IMPLEMENTATION_CLI,
		model,
		reasoning,
		customPrompt,
		sessionId,
		resumeSessionId,
		runId,
		recoveryMode,
		resumeDelivery = false,
		resumeExistingBranch = false,
		onBranchProvisioned,
		timeoutMs,
		signal,
		runAgent = runAgentCli,
		graft = graftEnvironment,
	} = options;

	// Dependency gate (issue #330): never start implementing a task whose
	// prerequisites are unfinished — the exact out-of-order build that produced the
	// PR #326/#327 migration conflict. Checked before the "In progress" move, the
	// worktree, credentials, and the agent, so a blocked run defers having spent
	// zero model tokens; the worker re-checks it cheaply until the blocker closes.
	// Provider-agnostic — it speaks only the PMProvider gate (no-op for a provider
	// that can't model dependencies).
	const openBlockers = await findOpenBlockers(pm, workItem);
	if (openBlockers.length > 0) {
		throw new DependencyBlockedError(workItem, openBlockers);
	}

	const worktrees = options.worktrees ?? new GitWorktreeManager(project);
	const reviewEnabled = project.pipeline?.review?.enabled !== false;
	const legacyMode = options.getToken !== undefined && options.delivery === undefined;
	const agentToken = await (options.getToken ?? getPersonaToken)(project, 'implementer');

	logger.info(`Phase started - Implementation — running ${describeAgent(cli, model, reasoning)}`, {
		taskId,
		workItemId: workItem.id,
		cli,
		model,
		reasoning,
	});

	// Resolved first: a missing implementer credential fails the job before any
	// worktree exists to clean up. Never returned or passed on — it goes straight
	// into the subprocess env below.
	// Report the pickup before doing any work — including before provisioning —
	// so a human watching the board sees "In progress" as soon as the worker
	// commits to this task, not only once the (possibly long) agent run finishes.
	await pm.moveWorkItem(workItem.id, START_STATUS);

	// Task-branch checkout (createBranch defaults to true): the agent commits and
	// pushes here, so — unlike Planning — this is not a detached, throwaway HEAD.
	const { handle, resumed, deliveryResumed } = await acquireImplementationWorktree(
		worktrees,
		taskId,
		`${project.branchPrefix}${taskId}`,
		resumeSessionId,
		resumeExistingBranch,
		resumeDelivery,
		recoveryMode,
		project.id,
	);
	await onBranchProvisioned?.();
	let preserveForResume = false;
	try {
		graft(project.repoRoot, handle.path);

		const shouldResumeDelivery = !legacyMode && deliveryResumed;
		const agent = shouldResumeDelivery
			? resumedDeliveryAgent(cli)
			: await runAgent({
					cli,
					model,
					reasoning,
					...sessionRunArgs({ sessionId, resumeSessionId }, resumed),
					cwd: handle.path,
					args: [
						buildImplementationPrompt(
							workItem,
							{
								repo: project.repo,
								taskId,
								branch: handle.branch,
								baseBranch: project.baseBranch,
								// Antigravity's `agy --print` runs from its own scratch dir, not this
								// worktree (issue #226), so name the absolute path in the prompt and
								// require edits/hand-off be written there. Claude/Codex run from `cwd`,
								// so it stays unset and their prompt is unchanged.
								worktreePath: cli === 'antigravity' ? handle.path : undefined,
							},
							customPrompt,
						),
					],
					// `gh` reads GH_TOKEN ahead of any ambient `gh auth` login, so every gh
					// call the agent makes (including `gh pr create`) acts as the
					// implementer persona, not the worker host's own logged-in account.
					maxOutputBytes: MAX_AGENT_OUTPUT_BYTES,
					logContext: { taskId, phase: 'implementation', workItemId: workItem.id },
					timeoutMs,
					signal,
					env: { GH_TOKEN: agentToken },
				});

		if (agent.exitCode !== 0) {
			logAgentFailure(taskId, workItem.id, agent);
			const error = agentRunError(
				agent,
				`Implementation agent (${cli}) exited with code ${agent.exitCode}`,
				` for task '${taskId}'`,
			);
			preserveForResume = shouldPreserveForResume(error);
			throw error;
		}

		if (!existsSync(join(handle.path, OPENED_PR_FILENAME))) {
			const blockedReason = readBlockedReason(handle.path);
			if (blockedReason)
				throw new Error(`Implementation blocked for task '${taskId}': ${blockedReason}`);
			if (legacyMode)
				throw new Error(`Implementation agent (${cli}) did not write ${OPENED_PR_FILENAME}`);
		}
		if (legacyMode) {
			const prUrl = readFileSync(join(handle.path, OPENED_PR_FILENAME), 'utf8').trim();
			if (!prUrl)
				throw new Error(`Implementation agent (${cli}) wrote an empty ${OPENED_PR_FILENAME}`);
			const commentId = await pm.addComment(
				workItem.id,
				implementationCommentBody(prUrl, reviewEnabled),
			);
			if (reviewEnabled) await pm.moveWorkItem(workItem.id, NEXT_STATUS);
			return {
				prUrl,
				branch: handle.branch,
				commentId,
				movedTo: reviewEnabled ? NEXT_STATUS : undefined,
				agent,
			};
		}
		const handoff = readHandoff(handle.path, OPENED_PR_FILENAME, ImplementationHandoffSchema);
		const delivery =
			options.delivery ??
			(await new GitHubSCMIntegration().deliveryProvider(project, 'implementer'));
		const deliveryId = deliveryIdentity(['implementation', project.repo, taskId, handle.branch]);
		const progress = loadDeliveryProgress(handle.path, deliveryId);
		saveDeliveryProgress(handle.path, progress);
		if (!progress.commitSha) {
			progress.commitSha = await commitPreparedTree(
				handle.path,
				handoff.commitSubject,
				delivery.commitIdentity,
			);
			saveDeliveryProgress(handle.path, progress);
		}
		if (!progress.pushed) {
			await delivery.pushBranch(handle.path, handle.branch, progress.commitSha);
			progress.pushed = true;
			saveDeliveryProgress(handle.path, progress);
		}
		if (!progress.pullRequestUrl) {
			const pull =
				(await delivery.findPullRequest(handle.branch)) ??
				(await delivery.createPullRequest({
					baseBranch: project.baseBranch,
					branch: handle.branch,
					title: workItem.title,
					body: `Closes #${taskId}\n\n${handoff.summary}`,
				}));
			progress.pullRequestNumber = pull.number;
			progress.pullRequestUrl = pull.url;
			saveDeliveryProgress(handle.path, progress);
		}
		const prUrl = progress.pullRequestUrl;

		const commentId = await pm.addComment(
			workItem.id,
			implementationCommentBody(prUrl, reviewEnabled),
		);
		if (reviewEnabled) {
			await pm.moveWorkItem(workItem.id, NEXT_STATUS);
		}

		logger.info('Phase finished - Implementation', {
			taskId,
			workItemId: workItem.id,
			branch: handle.branch,
			prUrl,
			commentId,
			movedTo: reviewEnabled ? NEXT_STATUS : undefined,
		});

		return {
			prUrl,
			branch: handle.branch,
			commentId,
			movedTo: reviewEnabled ? NEXT_STATUS : undefined,
			agent,
		};
	} catch (error) {
		if (!legacyMode && hasDeliveryProgress(handle.path)) {
			preserveForResume = true;
			throw new DeliveryDeferredError('Implementation delivery deferred for retry', {
				cause: error,
			});
		}
		throw error;
	} finally {
		await cleanupUnlessPreserved(
			worktrees,
			taskId,
			preserveForResume,
			'implementation phase',
			runId,
		);
	}
}
