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
 * agent performs no git or GitHub write at all: it leaves a prepared tree plus a
 * structured hand-off (`HANDOFF_FILENAMES.implementation`, mirroring how the
 * Planning phase reads `proposed_plan.md`), and *SWARM* commits, pushes and opens
 * the PR through `ScmDeliveryProvider`. The `Closes #<n>` in the PR body is what
 * links the PR back to the Issue the Projects item wraps; the comment this phase
 * posts is the human-facing pointer.
 *
 * The implementer persona's token is resolved and handed to the agent as
 * `GH_TOKEN` (mirroring `runReviewPhase`'s reviewer-token plumbing) so every `gh`
 * read the agent makes acts as that persona, not whatever `gh auth` session
 * happens to be ambient on the worker's host; the delivery that opens the PR runs
 * under the same persona's credential. Since issue #396 the implementer token is
 * the worker operator's own token (`SWARM_OPERATOR_GH_TOKEN`, resolved through
 * the same `getPersonaToken(project, 'implementer')` seam), so the PR is authored
 * by the operator's account. Review's ownership gate no longer reads that author
 * at all (issue #397): it recognises the PR from its **branch**
 * (`<branchPrefix><issueNumber>`, the branch this phase's worktree provisions)
 * plus this phase's own `runs` row — see `src/triggers/swarm-managed-pr.ts`.
 * Which is why the branch name matters: an off-convention branch is a PR Review
 * will not recognise, silently stranding the item in "In review" forever with
 * nothing to trigger Review, let alone Respond-to-review after it.
 *
 * **An attempt that finds the work already delivered adopts it** (issue #558).
 * Delivery progress is recorded in the worktree, but an interrupted dispatch is
 * re-dispatched to whichever worker is eligible — which may be a machine holding
 * none of that state. So before running the agent this phase asks the SCM whether
 * its task branch already has an open PR; if it does, an earlier attempt already
 * implemented and pushed the task, and what this one owes is the *rest* of that
 * delivery (the PR-link comment and the status move), not a second implementation.
 * Without it, the second attempt produced a divergent commit that could never be
 * pushed, and burned its whole retry budget on the identical rejection.
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
import { requireProjectSCMProvider } from '@/integrations/scm/registry.js';
import { logger } from '@/lib/logger.js';
import type { Checkpoint } from '@/pipeline/checkpoint.js';
import { DependencyBlockedError, findGatingBlockers } from '@/pipeline/dependency-guard.js';
import {
	BLOCKED_REASON_FILENAME,
	buildImplementationPrompt,
} from '@/pipeline/prompts/implementation.js';
import {
	cleanupUnlessPreserved,
	executeRecoveryGate,
	sessionRunArgs,
	shouldPreserveFailedCheckout,
	warnStartingOverOnPreservedWork,
} from '@/pipeline/resume.js';
import type { PmStatusKey } from '@/pm/pipeline.js';
import type { PMProvider, WorkItem } from '@/pm/types.js';
import type { RecoveryMode } from '@/queue/jobs.js';
import {
	commitPreparedTree,
	DeliveryDeferredError,
	deliveryIdentity,
	HANDOFF_FILENAMES,
	hasDeliveryProgress,
	ImplementationHandoffSchema,
	loadDeliveryProgress,
	pushDeliveredBranch,
	readHandoff,
	resumedDeliveryAgent,
	type ScmDeliveryProvider,
	saveDeliveryProgress,
	shouldDeferDeliveryFailure,
} from '@/scm/delivery.js';
import { SWARM_GENERATED_SIGNATURE, swarmMarker } from '@/scm/swarm-origin.js';
import { GitWorktreeManager, type WorktreeHandle } from '@/worker/git-worktree-manager.js';
import { graftEnvironment } from '@/worktree/graft.js';

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
 * worker's memory without bound. The delivery reads the agent's hand-off file, not
 * its stdout, so truncating the captured stream costs nothing here.
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
	recoveryMode?: RecoveryMode;
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
	/**
	 * Provider-neutral deterministic SCM delivery seam. Omit to have the phase
	 * resolve the project's own registered provider.
	 */
	delivery?: ScmDeliveryProvider;
	/**
	 * Injectable implementer-token resolver — defaults to {@link getPersonaToken}.
	 * Supplied by the DB-free worker, which injects the operator's own token rather
	 * than reaching into a secret store it cannot read (ADR-003 §2).
	 */
	getToken?: typeof getPersonaToken;
}

export interface ImplementationPhaseResult {
	/** The URL of the PR this phase's delivery opened (or adopted). */
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
 * Per-delivery idempotency marker on the PR-link comment (issue #558). Mirrors
 * Planning's `planDeliveryMarker` and shares the `<!-- swarm-… -->` frame so
 * comment loop prevention still recognises the body (`isSwarmGeneratedBody`,
 * `src/scm/swarm-origin.ts`).
 *
 * The id is {@link deliveryIdentity} over (phase, repo, task, branch), so it is
 * the *same* for every attempt at one task's implementation — including an
 * attempt that resumes on a different worker with none of the first one's local
 * state. That is what lets a resumed delivery find the comment it already posted
 * instead of posting a second "Implementation complete" under the same PR link.
 */
export function implementationDeliveryMarker(deliveryId: string): string {
	return swarmMarker('implementation-delivery', deliveryId);
}

/**
 * Wrap the opened PR URL in a comment body that marks it as SWARM's
 * implementation output and points the human at the open PR. The trailing note
 * reflects whether automated Review is enabled for the project.
 */
export function implementationCommentBody(
	prUrl: string,
	reviewEnabled = true,
	deliveryId?: string,
): string {
	const note = reviewEnabled
		? `${SWARM_GENERATED_SIGNATURE} (Implementation phase). This item has moved to **In review**._`
		: `${SWARM_GENERATED_SIGNATURE} (Implementation phase). Automated Review is disabled; this item remains **In progress**._`;
	return [
		'## 🚀 Implementation complete',
		'',
		`A pull request is open and ready for review: ${prUrl.trim()}`,
		'',
		'---',
		note,
		...(deliveryId ? ['', implementationDeliveryMarker(deliveryId)] : []),
	].join('\n');
}

/**
 * Post the PR-link comment at most once per implementation delivery: an attempt
 * that resumes after an earlier one already commented reuses that comment rather
 * than adding a duplicate.
 */
async function postImplementationComment(
	pm: PMProvider,
	workItemId: string,
	prUrl: string,
	reviewEnabled: boolean,
	deliveryId: string,
): Promise<string> {
	const existing = await pm.findComment(workItemId, implementationDeliveryMarker(deliveryId));
	return (
		existing ??
		(await pm.addComment(workItemId, implementationCommentBody(prUrl, reviewEnabled, deliveryId)))
	);
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
 * an agent session, not merely the worktree, was resumed — a Tier 2 checkpoint
 * continuation resumes none, and hands its `checkpoint` back for the prompt
 * instead.
 */
async function acquireImplementationWorktree(
	worktrees: GitWorktreeManager,
	taskId: string,
	branch: string,
	resumeSessionId: string | undefined,
	resumeExistingBranch: boolean,
	resumeDelivery: boolean,
	recoveryMode?: RecoveryMode,
	runId?: string,
): Promise<{
	handle: WorktreeHandle;
	resumed: boolean;
	deliveryResumed: boolean;
	checkpoint?: Checkpoint;
}> {
	if (recoveryMode) {
		const { reuseHandle, checkpoint } = await executeRecoveryGate(
			worktrees,
			taskId,
			recoveryMode,
			resumeSessionId,
			'implementation',
			branch,
		);
		if (reuseHandle) {
			return {
				handle: reuseHandle,
				resumed: recoveryMode !== 'checkpoint',
				deliveryResumed: false,
				checkpoint,
			};
		}
	}
	// A prior attempt on this task already owns the task branch. Reuse its checkout
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
	// Implementation is the phase that writes checkpoints, so this fall-through is
	// where a lost continuation costs the most: reaching it with a preserved
	// checkout still on disk means the run is re-doing work it had already done
	// (issue #591). Warn, then provision as before — an unrequested start-over is
	// legal, it just must never be silent.
	warnStartingOverOnPreservedWork(worktrees, taskId, 'implementation', runId);
	const handle = resumeExistingBranch
		? await worktrees.provision(taskId, { createBranch: false, branch, runId })
		: await worktrees.provision(taskId, { runId });
	return { handle, resumed: false, deliveryResumed: false };
}

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
	// that can't model dependencies). Only *recorded* relationships reach this list
	// (issue #643): a prerequisite found only in the item's prose is surfaced by the
	// gate for a human and never defers the run.
	const gatingBlockers = await findGatingBlockers(pm, workItem);
	if (gatingBlockers.length > 0) {
		throw new DependencyBlockedError(workItem, gatingBlockers);
	}

	const worktrees = options.worktrees ?? new GitWorktreeManager(project);
	const reviewEnabled = project.pipeline?.review?.enabled !== false;
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
	const { handle, resumed, deliveryResumed, checkpoint } = await acquireImplementationWorktree(
		worktrees,
		taskId,
		`${project.branchPrefix}${taskId}`,
		resumeSessionId,
		resumeExistingBranch,
		resumeDelivery,
		recoveryMode,
		runId,
	);
	await onBranchProvisioned?.();
	let preserveForResume = false;
	try {
		graft(project.repoRoot, handle.path);

		// Deterministic delivery is resolved *before* the agent, not after: the
		// already-delivered probe below has to ask the SCM about this task's branch
		// while there is still an agent run to skip.
		const delivery =
			options.delivery ??
			(await requireProjectSCMProvider(project).deliveryProvider(project, 'implementer'));
		const deliveryId = deliveryIdentity(['implementation', project.repo, taskId, handle.branch]);

		// Already delivered by an earlier attempt (issue #558). An interruption after
		// the push — a control-plane restart, a worker shutdown, a lost socket — puts
		// the dispatch back in the pool, and the attempt that picks it up may land on a
		// machine holding none of the first one's worktree, so the local progress
		// sidecar cannot answer "did this task already deliver?". The open PR on the
		// task branch can, and it is the same answer on every host: an attempt that
		// finds one owes the *rest* of the delivery, not a second implementation of the
		// task. Running the agent again is what produced a divergent second commit that
		// could never be pushed. Skipped when the checkout's own progress file already
		// claimed this delivery (`deliveryResumed`) — that resume is strictly better
		// informed, and it still short-circuits the agent.
		if (!deliveryResumed) {
			const delivered = await delivery.findPullRequest(handle.branch);
			if (delivered) {
				logger.info('Implementation already delivered — adopting the open PR, skipping the agent', {
					taskId,
					workItemId: workItem.id,
					branch: handle.branch,
					prUrl: delivered.url,
				});
				const commentId = await postImplementationComment(
					pm,
					workItem.id,
					delivered.url,
					reviewEnabled,
					deliveryId,
				);
				if (reviewEnabled) await pm.moveWorkItem(workItem.id, NEXT_STATUS);
				return {
					prUrl: delivered.url,
					branch: handle.branch,
					commentId,
					movedTo: reviewEnabled ? NEXT_STATUS : undefined,
					agent: resumedDeliveryAgent(cli),
				};
			}
		}

		const agent = deliveryResumed
			? resumedDeliveryAgent(cli)
			: await runAgent({
					cli,
					model,
					reasoning,
					...sessionRunArgs({ sessionId, resumeSessionId }, resumed, recoveryMode),
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
								// Set only by a Tier 2 continuation (`recoveryMode: 'checkpoint'`):
								// this fresh session has no CLI context to resume, so the prompt
								// carries the stopped run's recorded remainder instead.
								checkpoint,
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
			// Either tier may claim this checkout: Tier 1's resumable session, or — when it
			// cannot apply — the Tier 2 checkpoint the agent left in the worktree.
			preserveForResume = shouldPreserveFailedCheckout(
				error,
				handle.path,
				'implementation',
				resumed,
			);
			throw error;
		}

		// A run that wrote a blocker instead of a hand-off names the prerequisite it is
		// waiting on, rather than failing with the generic missing-hand-off error
		// `readHandoff` would raise a line later.
		if (!existsSync(join(handle.path, HANDOFF_FILENAMES.implementation))) {
			const blockedReason = readBlockedReason(handle.path);
			if (blockedReason)
				throw new Error(`Implementation blocked for task '${taskId}': ${blockedReason}`);
		}
		const handoff = readHandoff(
			handle.path,
			HANDOFF_FILENAMES.implementation,
			ImplementationHandoffSchema,
		);
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
			await pushDeliveredBranch(delivery, handle.path, handle.branch, progress.commitSha);
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

		const commentId = await postImplementationComment(
			pm,
			workItem.id,
			prUrl,
			reviewEnabled,
			deliveryId,
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
		// `shouldDeferDeliveryFailure` (not a bare progress check) so a diverged branch
		// settles terminally instead of retrying a push that can never succeed (#558):
		// deferring would also preserve the checkout, denying the branch to the phase
		// that could unblock the PR. The delivered commit survives on the local branch
		// ref after the cleanup below, so nothing is lost to inspection.
		if (shouldDeferDeliveryFailure(error, handle.path)) {
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
