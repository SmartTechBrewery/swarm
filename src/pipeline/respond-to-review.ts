/**
 * Respond-to-review phase (PROJECT.md §5.4, ai/ARCHITECTURE.md "Pipeline phases" #4).
 *
 * By default, the reviewer persona submits a `changes_requested` review and the
 * worker runs this: provision a worktree on the PR's existing task branch, spin
 * up Claude Code as the implementer to read the batched review, and for each
 * point either fix the code (Path A) or push back with a rationale (Path B).
 * `pipeline.respondToReview.skipOnMinors: false` can opt back into responding
 * to every reviewer verdict. "Wait for the final submitted review, not
 * individual line comments" is still Cascade's rule and still applies here.
 * Matching the event (`pull_request_review` `submitted`, authored by the
 * *reviewer* persona — the `getPersonaForLogin` routing in
 * `src/integrations/scm/github/webhook.ts`) is the trigger handler's job (SWARM-53),
 * not this phase's: it receives a review to respond to, already vetted.
 *
 * The checkout is the PR branch itself (`provision`'s `createBranch: false`
 * seam) — unlike Review's detached throwaway, the implementer commits and
 * pushes here. That checkout target must already exist as a *local* branch:
 * `git worktree add <path> <branch>` doesn't DWIM remote-only branches, so this
 * phase leans on the Implementation phase having created `issue-<n>` in the
 * same `repoRoot` and its cleanup leaving the branch behind (see
 * `runImplementationPhase`'s re-run note — the leftover branch is load-bearing
 * here). The local branch can still be *stale* — origin moves when a human
 * co-pushes, or on the second respond round — so the prompt's first step
 * fast-forwards it; a diverged branch fails that sync (and the job) rather than
 * letting the agent respond against code the reviewer never saw.
 *
 * Same token plumbing as Implementation, for the same reason: the implementer
 * persona's token is resolved and handed to the agent as `GH_TOKEN` (mirroring
 * `runReviewPhase`'s reviewer-token plumbing) so every `gh` call — the PR
 * comment reply included — acts as that persona, not whatever `gh auth`
 * session happens to be ambient on the worker's host. (An earlier version of
 * this comment claimed the ambient credentials already *were* the implementer
 * persona; confirmed live on the Implementation phase that assumption was
 * false — see `runImplementationPhase`'s header.)
 *
 * Board status reports (Implementation's pattern, mirrored here): the item sits
 * at "In review" when this phase starts; it moves the card to "In progress"
 * while the implementer works and back to "In review" once it has responded, so
 * a human watching the board sees the response happening rather than a card that
 * looks idle for minutes. These are **status reports, not triggers** — neither
 * "In progress" nor "In review" starts a PM-driven phase (`src/pm/pipeline.ts`),
 * so bouncing the card between them can't re-fire Review or anything else — that
 * re-review is driven only by the *new commit* a `fixed` response pushes (see
 * "Follow-up Review" below), deduped per head SHA —
 * `src/triggers/review-dispatch-dedup.ts`. And they are strictly
 * **best-effort**: the board item arrives already resolved from SWARM's own
 * durable card↔task link (`boardItemId`, `src/dispatch/board-card.ts` — issue
 * #498), falling back to the legacy `/issues/<n>` URL-suffix guess for a PR that
 * predates it; a failure to resolve it (a human-named branch, an item not on the
 * board) or to move it is logged and swallowed — a cosmetic status report must
 * never fail an otherwise-successful response. On a failed run the card is left
 * at "In progress" (as Implementation leaves it), with the worker's failure
 * comment explaining why; the next reviewer round moves it on.
 * Skipped entirely when no `pm` provider is injected (unit tests that don't
 * exercise the board).
 *
 * This is the phase's orchestration only, same as the other three. It composes
 * `GitWorktreeManager` (SWARM-14), `graftEnvironment` (SWARM-15) and
 * `runAgentCli` (SWARM-16), and takes the PR/review coordinates as inputs
 * rather than reaching for a queue or webhook payload.
 *
 * **Follow-up Review (issue #241).** A `fixed` outcome whose commit was
 * actually pushed and differs from the reviewed head (`headSha`) reliably
 * enqueues exactly one follow-up Review for the new SHA — part of this
 * phase's own deterministic delivery (`scheduleFollowUpReview`,
 * `src/pipeline/follow-up-review.ts`), not a best-effort post-success action
 * like `selfEnqueueNextPhase` (`src/worker/consumer.ts`). It runs after the
 * push/comment delivery steps but before the checkpoint that guards it
 * (`DeliveryProgress.followUpEnqueued`), so a queueing failure surfaces as a
 * `DeliveryDeferredError` and a resumed retry re-schedules rather than
 * silently dropping it; the default scheduler's job id is a deterministic hash
 * of (project, PR, new head), so a crash between a successful enqueue and that
 * checkpoint write can't duplicate the job. `pushed-back`, `no-findings`, a
 * failed/unpushed response, and an unchanged head all enqueue nothing. A
 * follow-up Review that approves may request the same approval-only merge
 * `runReviewPhase` already exposes (issue #235, provider-neutral since issue
 * #253) — Respond-to-review still never requests it directly.
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
import {
	type ScheduleFollowUpReview,
	scheduleFollowUpReviewDefault,
} from '@/pipeline/follow-up-review.js';
import { buildRespondToReviewPrompt } from '@/pipeline/prompts/respond-to-review.js';
import {
	acquireResumableWorktree,
	cleanupUnlessPreserved,
	sessionRunArgs,
	shouldPreserveFailedCheckout,
} from '@/pipeline/resume.js';
import type { PmStatusKey } from '@/pm/pipeline.js';
import type { PMProvider } from '@/pm/types.js';
import type { RecoveryMode } from '@/queue/jobs.js';
import {
	commitPreparedTree,
	DeliveryDeferredError,
	type DeliveryProgress,
	deliveryIdentity,
	HANDOFF_FILENAMES,
	hasDeliveryProgress,
	loadDeliveryProgress,
	ReviewResponseHandoffSchema,
	readHandoff,
	resumedDeliveryAgent,
	type ScmDeliveryProvider,
	saveDeliveryProgress,
} from '@/scm/delivery.js';
import { GitWorktreeManager } from '@/worker/git-worktree-manager.js';
import { graftEnvironment } from '@/worktree/graft.js';
import { issueNumberFromBranch } from './task-branch.js';

/** The file the respond agent is instructed to write its outcome to, at the worktree root. */
export const RESPOND_OUTCOME_FILENAME = HANDOFF_FILENAMES.respondToReview;

// The static respond-to-review prompt now lives in
// `src/pipeline/prompts/respond-to-review.ts` (issue #135); re-exported so
// existing importers of `@/pipeline/respond-to-review.js` keep resolving it.
export { buildRespondToReviewPrompt };

/**
 * Status the card moves to while the implementer responds — the board's "In
 * progress". A status *report* (a human watching sees the response happening),
 * never a trigger: entering "In progress" starts no PM-driven phase
 * (`src/pm/pipeline.ts`). Typed to {@link PmStatusKey} so a typo fails to
 * compile rather than silently addressing a status the adapter can't resolve.
 */
const PICKUP_STATUS: PmStatusKey = 'inProgress';

/**
 * Status the card returns to once the response is posted — back to the board's
 * "In review" it started at. Also a report, not a trigger (`src/pm/pipeline.ts`),
 * so returning here can't re-fire Review; only a *new commit* does, deduped per
 * head SHA (`src/triggers/review-dispatch-dedup.ts`).
 */
const DONE_STATUS: PmStatusKey = 'inReview';

/**
 * The outcomes the agent may report — PROJECT.md §5.4's two paths, now also
 * covering an approval/comment review with nothing actionable in it. `fixed`
 * means at least one fix commit was pushed (even if some points were pushed
 * back); `pushed-back` means no code changed because at least one concrete
 * point was rejected with a rationale; `no-findings` means the review raised
 * no actionable points and the agent only acknowledged it. The agent hands
 * back which one applied via
 * {@link RESPOND_OUTCOME_FILENAME}; anything else is a failed run, not a third
 * outcome.
 */
export const RESPOND_OUTCOMES = ['fixed', 'pushed-back', 'no-findings'] as const;

export type RespondOutcome = (typeof RESPOND_OUTCOMES)[number];

/** Claude Code is SWARM's implementer agent (PROJECT.md §5.4) — the persona that responds. */
export const DEFAULT_RESPOND_CLI: AgentCli = 'claude';

/**
 * Cap on captured agent output, so a chatty/runaway respond run can't grow the
 * worker's memory without bound. The outcome is read from
 * {@link RESPOND_OUTCOME_FILENAME}, not from stdout, so truncating the captured
 * stream costs nothing here.
 */
const MAX_AGENT_OUTPUT_BYTES = 1_000_000;

export interface RunRespondToReviewPhaseOptions {
	/** The SWARM project whose repo the PR belongs to. */
	project: ProjectConfig;
	/** The number of the PR the review was submitted on. */
	prNumber: string;
	/**
	 * The PR's head branch (`pull_request.head.ref`) — the existing task branch
	 * the worktree checks out and the agent pushes fixes to.
	 */
	prBranch: string;
	/**
	 * The submitted review's numeric ID (`review.id` from the
	 * `pull_request_review` webhook) — pins the agent to the one batched review
	 * it must respond to, rather than whatever `gh pr view` surfaces last.
	 */
	reviewId: string;
	/**
	 * The PR head SHA the submitted review covered. Compared against the fix
	 * commit this phase pushes so a `fixed` outcome only schedules a follow-up
	 * Review (issue #241) when the head actually advanced — never for a commit
	 * that (implausibly) matches the reviewed head.
	 */
	headSha: string;
	/**
	 * Task identifier for the worktree path (`task-<taskId>`). Passed explicitly
	 * rather than derived from `prNumber`: the worker that dequeues the job owns
	 * task naming, and a respond worktree must not collide with a review
	 * worktree for the same change — the trigger handler dispatches this as
	 * `` `${prNumber}-respond` ``, not the bare PR number Review's own `taskId`
	 * uses, for exactly that reason (see git history for the incident this fixed).
	 */
	taskId: string;
	/**
	 * PM provider for the project's board, used purely for best-effort status
	 * reports (→ In progress while responding, → In review when done). Provider-
	 * agnostic — this phase only ever calls the {@link PMProvider} interface, so a
	 * future Jira/Linear/Trello provider drops in with no change here. Omitted in
	 * unit tests that don't exercise the board (board reports are then skipped).
	 */
	pm?: PMProvider;
	/**
	 * The board card this PR's task was dispatched from, already resolved
	 * control-plane side from the durable `runs.work_item_id` link
	 * (`src/dispatch/board-card.ts`, issue #498) — where the DB is, so a federated
	 * worker needs none (ADR-003 §2). Omitted when nothing links the task to a card
	 * (a pruned run row, a PR from before this change), in which case
	 * {@link resolveBoardItemId} falls back to the legacy URL-suffix lookup.
	 */
	boardItemId?: string;
	/** Worktree manager for the project — provisions and cleans up the checkout. */
	worktrees?: GitWorktreeManager;
	/** Which agent CLI to run. Defaults to Claude Code. */
	cli?: AgentCli;
	/** Model for the agent's session (e.g. 'sonnet', 'opus'). Omit for the CLI's own default. */
	model?: string;
	/** Reasoning level for the agent's session. Omit for the CLI/model default (issue #180). */
	reasoning?: ReasoningLevel;
	/**
	 * Project's optional custom prompt for this phase (`agents.respondToReview.prompt`,
	 * issue #135) — appended to the static SWARM prompt as a supplement-only
	 * section. Omit for today's prompt exactly.
	 */
	customPrompt?: string;
	/**
	 * Session id to assign to a fresh run (`sessionId`) or resume from on a retry
	 * (`resumeSessionId`). When resuming, the preserved PR-branch checkout is
	 * reused so the agent continues its prior session (and any partial fixes) in place.
	 */
	sessionId?: string;
	resumeSessionId?: string;
	/** The database run id. */
	runId?: string;
	/** Mode for recovering a cancelled preserved worktree. */
	recoveryMode?: RecoveryMode;
	/** Resume deterministic delivery from a preserved worktree without rerunning the agent. */
	resumeDelivery?: boolean;
	/** Kill the agent run after this many ms. Omit for no timeout. */
	timeoutMs?: number;
	/** External cancellation — aborting kills the agent run. */
	signal?: AbortSignal;
	/** Injectable agent runner — defaults to {@link runAgentCli}; overridden in tests. */
	runAgent?: (opts: Parameters<typeof runAgentCli>[0]) => Promise<AgentCliResult>;
	/** Injectable env-grafting step — defaults to {@link graftEnvironment}; overridden in tests. */
	graft?: typeof graftEnvironment;
	/** Injectable implementer-token resolver — defaults to {@link getPersonaToken}; overridden in tests. */
	delivery?: ScmDeliveryProvider;
	getToken?: typeof getPersonaToken;
	/**
	 * Injectable follow-up-Review scheduler (issue #241) — defaults to
	 * {@link scheduleFollowUpReviewDefault}; overridden in tests. Not consulted in
	 * legacy mode (no delivery progress to key the checkpoint on).
	 */
	scheduleFollowUpReview?: ScheduleFollowUpReview;
}

export interface RespondToReviewPhaseResult {
	/** The outcome the agent reported, read from {@link RESPOND_OUTCOME_FILENAME}. */
	outcome: RespondOutcome;
	/**
	 * The canonical status the card was moved back to on success ({@link DONE_STATUS}),
	 * or `undefined` when no board report happened — no `pm` injected, the board
	 * item couldn't be resolved, or the move failed (all best-effort).
	 */
	movedTo?: PmStatusKey;
	/** The agent run's result (exit code, duration, captured output). */
	agent: AgentCliResult;
	/**
	 * The newly pushed commit SHA a follow-up Review was scheduled for (issue
	 * #241) — set only for a `fixed` outcome whose commit was actually pushed and
	 * differs from the reviewed head; `undefined` for every other outcome, an
	 * unpushed/unchanged head, or legacy mode.
	 */
	pushedHeadSha?: string;
}

export { issueNumberFromBranch } from './task-branch.js';

/**
 * The pushed commit SHA a follow-up Review should be scheduled for (issue
 * #241), or `undefined` when this response doesn't qualify: any outcome but
 * `fixed`, a commit that was never actually pushed, or a head that
 * (implausibly) didn't advance past what was reviewed. Pure so the exclusion
 * rules unit-test without a real git checkout.
 */
export function resolvePushedHeadSha(
	outcome: RespondOutcome,
	progress: DeliveryProgress,
	reviewedHeadSha: string,
): string | undefined {
	if (outcome !== 'fixed' || !progress.commitSha || !progress.pushed) return undefined;
	return progress.commitSha !== reviewedHeadSha ? progress.commitSha : undefined;
}

/**
 * Resolve the board card this response should report on to its provider-native
 * ID, or `undefined` when there is none.
 *
 * Prefers `injectedItemId` — the card resolved control-plane side from SWARM's
 * own durable `runs.work_item_id` link (`src/dispatch/board-card.ts`, issue
 * #498). That link is provider-neutral by construction, so it works for a
 * Jira/Linear/Trello board paired with a GitHub repo.
 *
 * The fallback is the **GitHub-shaped legacy path**, and the only remaining place
 * that assumption lives: a PR opened before this change (or one whose run rows
 * were pruned) has no recorded card, so the card is guessed from a
 * `/issues/<n>` URL suffix. It resolves nothing for a board whose items carry
 * some other URL shape, which is exactly the pre-#498 behaviour it preserves.
 *
 * Swallows and logs provider errors either way — the caller treats any failure as
 * "no board report", never a phase failure.
 */
async function resolveBoardItemId(
	pm: PMProvider,
	issueNumber: string | undefined,
	taskId: string,
	injectedItemId: string | undefined,
): Promise<string | undefined> {
	if (injectedItemId) return injectedItemId;
	if (!issueNumber) return undefined;
	try {
		// A `/issues/100` suffix can't false-match `/issues/1001` — the char before
		// `100` must be `/` — so no need to anchor on the repo too.
		const match = await pm.findWorkItemByUrlSuffix(`/issues/${issueNumber}`);
		if (!match) {
			logger.debug('respond-to-review: no board item found for issue — skipping status report', {
				taskId,
				issueNumber,
			});
			return undefined;
		}
		return match.id;
	} catch (error) {
		logger.warn('respond-to-review: could not resolve board item — skipping status report', {
			taskId,
			issueNumber,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

/**
 * Best-effort board status report. Moves the item and returns whether it
 * succeeded; a provider error is logged and swallowed (returns `false`) so a
 * cosmetic report can never fail the response — see the module header.
 */
async function reportBoardStatus(
	pm: PMProvider,
	itemId: string,
	status: PmStatusKey,
	taskId: string,
): Promise<boolean> {
	try {
		await pm.moveWorkItem(itemId, status);
		return true;
	} catch (error) {
		logger.warn('respond-to-review: board status report failed — continuing', {
			taskId,
			status,
			error: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}

/**
 * Log a failed respond run's captured output before the phase throws, so the
 * worker that marks the job failed has the agent's own stdout/stderr to
 * diagnose *why* — the thrown Error carries only a message. Output is already
 * bounded by {@link MAX_AGENT_OUTPUT_BYTES}.
 */
function logAgentFailure(taskId: string, prNumber: string, agent: AgentCliResult): void {
	logger.error('Phase failed - Respond-to-review — agent output', {
		taskId,
		prNumber,
		cli: agent.cli,
		exitCode: agent.exitCode,
		timedOut: agent.timedOut,
		durationMs: agent.durationMs,
		outputTruncated: agent.outputTruncated,
		stdout: agent.stdout,
		stderr: agent.stderr,
	});
}

/**
 * Run the Respond-to-review phase for one submitted review. Provisions a
 * worktree on the PR's existing branch, runs the implementer agent to address
 * the batched review — fixing code or pushing back point by point — and
 * validates the outcome it handed back.
 *
 * Throws if the agent exits non-zero (including the prompt's deliberate
 * diverged-branch bail-out) or if it produced no recognizable outcome — a
 * respond run that didn't verifiably answer the review is a failed job, not a
 * soft miss (ai/CODING_STANDARDS.md "Error handling"). The worktree is always
 * removed once provisioned, success or failure; pushed fixes and the PR reply
 * live on GitHub and are unaffected.
 */
export async function runRespondToReviewPhase(
	options: RunRespondToReviewPhaseOptions,
): Promise<RespondToReviewPhaseResult> {
	const {
		project,
		prNumber,
		prBranch,
		reviewId,
		headSha,
		taskId,
		pm,
		cli = DEFAULT_RESPOND_CLI,
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
		scheduleFollowUpReview = scheduleFollowUpReviewDefault,
	} = options;
	const worktrees = options.worktrees ?? new GitWorktreeManager(project);
	const legacyMode = options.getToken !== undefined && options.delivery === undefined;
	const agentToken = await (options.getToken ?? getPersonaToken)(project, 'implementer');

	logger.info(
		`Phase started - Respond-to-review — running ${describeAgent(cli, model, reasoning)}`,
		{
			taskId,
			prNumber,
			prBranch,
			reviewId,
			cli,
			model,
			reasoning,
		},
	);

	// Resolved first: a missing implementer credential fails the job before any
	// worktree exists to clean up. Never returned or passed on — it goes straight
	// into the subprocess env below.
	// Best-effort board report: resolve the card once (reused for the closing
	// move) and reflect "In progress" before the (possibly long) agent run, so a
	// human watching the board sees the response start — never blocks or fails the
	// response. See the module header. Skipped when no provider is injected.
	const issueNumber = issueNumberFromBranch(prBranch, project.branchPrefix);
	const boardItemId = pm
		? await resolveBoardItemId(pm, issueNumber, taskId, options.boardItemId)
		: undefined;
	if (pm && boardItemId) {
		await reportBoardStatus(pm, boardItemId, PICKUP_STATUS, taskId);
	}

	// The existing task branch, not a fresh one — the agent commits and pushes to
	// the PR here (see the module header for the local-branch precondition). On a
	// resume retry, reuse the preserved checkout so partial fixes and the agent's
	// session carry over.
	const { handle, resumed, deliveryResumed, checkpoint } = await acquireResumableWorktree(
		worktrees,
		taskId,
		'respond-to-review',
		prBranch,
		false,
		resumeSessionId,
		() => worktrees.provision(taskId, { createBranch: false, branch: prBranch, runId }),
		resumeDelivery,
		recoveryMode,
	);
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
					...sessionRunArgs({ sessionId, resumeSessionId }, resumed, recoveryMode),
					cwd: handle.path,
					args: [
						buildRespondToReviewPrompt(
							{ repo: project.repo, prNumber, prBranch, reviewId, checkpoint },
							customPrompt,
						),
					],
					// `gh` reads GH_TOKEN ahead of any ambient `gh auth` login, so every gh
					// call the agent makes (incl. the PR comment reply) acts as the
					// implementer persona, not the worker host's own logged-in account.
					maxOutputBytes: MAX_AGENT_OUTPUT_BYTES,
					logContext: { taskId, phase: 'respond-to-review', prNumber, prBranch },
					timeoutMs,
					signal,
					env: { GH_TOKEN: agentToken },
				});

		if (agent.exitCode !== 0) {
			logAgentFailure(taskId, prNumber, agent);
			const error = agentRunError(
				agent,
				`Respond-to-review agent (${cli}) exited with code ${agent.exitCode}`,
				` for PR #${prNumber}`,
			);
			// Either tier may claim this checkout: Tier 1's resumable session, or — when it
			// cannot apply — the Tier 2 checkpoint the agent left in the worktree.
			preserveForResume = shouldPreserveFailedCheckout(
				error,
				handle.path,
				'respond-to-review',
				resumed,
			);
			throw error;
		}

		// Case-tolerant ("Fixed" happens) but otherwise strict: an unknown outcome
		// means the hand-off contract broke, and pretending the response happened
		// would stall the pipeline silently.
		if (legacyMode) {
			if (!existsSync(join(handle.path, RESPOND_OUTCOME_FILENAME)))
				throw new Error(
					`Respond-to-review agent (${cli}) did not write ${RESPOND_OUTCOME_FILENAME}`,
				);
			const outcome = readFileSync(join(handle.path, RESPOND_OUTCOME_FILENAME), 'utf8')
				.trim()
				.toLowerCase() as RespondOutcome;
			if (!outcome)
				throw new Error(
					`Respond-to-review agent (${cli}) wrote an empty ${RESPOND_OUTCOME_FILENAME}`,
				);
			if (!RESPOND_OUTCOMES.includes(outcome))
				throw new Error(`Respond-to-review agent (${cli}) wrote unrecognized outcome '${outcome}'`);
			let movedTo: PmStatusKey | undefined;
			if (pm && boardItemId && (await reportBoardStatus(pm, boardItemId, DONE_STATUS, taskId)))
				movedTo = DONE_STATUS;
			return { outcome, movedTo, agent };
		}
		const handoff = readHandoff(handle.path, RESPOND_OUTCOME_FILENAME, ReviewResponseHandoffSchema);
		if (
			handoff.outcome === 'fixed' &&
			(!handoff.commitSubject || (handoff.verification?.length ?? 0) === 0)
		) {
			throw new Error(
				'Invalid respond-to-review hand-off: fixed requires commitSubject and verification',
			);
		}
		const delivery =
			options.delivery ??
			(await requireProjectSCMProvider(project).deliveryProvider(project, 'implementer'));
		const deliveryId = deliveryIdentity(['respond-to-review', project.repo, prNumber, reviewId]);
		const progress = loadDeliveryProgress(handle.path, deliveryId);
		saveDeliveryProgress(handle.path, progress);
		if (handoff.outcome === 'fixed' && !progress.commitSha) {
			progress.commitSha = await commitPreparedTree(
				handle.path,
				handoff.commitSubject as string,
				delivery.commitIdentity,
			);
			saveDeliveryProgress(handle.path, progress);
		}
		if (progress.commitSha && !progress.pushed) {
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
		const outcome = handoff.outcome;

		// Reliably enqueue exactly one follow-up Review for the new head (issue
		// #241) — never for pushed-back/no-findings, a failed/unpushed response, or
		// an unchanged head (the commit somehow matching what was reviewed). The
		// checkpoint guards a resumed retry from re-scheduling once this is saved;
		// the queue's own deterministic job id (`followUpReviewDeliveryId`) absorbs
		// a crash between a successful enqueue and that write.
		const pushedHeadSha = resolvePushedHeadSha(outcome, progress, headSha);
		if (pushedHeadSha && !progress.followUpEnqueued) {
			logger.debug('respond-to-review: scheduling follow-up Review for the pushed fix', {
				taskId,
				prNumber,
				reviewedHeadSha: headSha,
				pushedHeadSha,
			});
			await scheduleFollowUpReview({ project, prNumber, prBranch, headSha: pushedHeadSha });
			progress.followUpEnqueued = true;
			saveDeliveryProgress(handle.path, progress);
		}

		// Best-effort: return the card to "In review" now the response is posted.
		// Only on success — a failed run leaves it at "In progress" (as
		// Implementation does), with the worker's failure comment explaining why.
		let movedTo: PmStatusKey | undefined;
		if (pm && boardItemId && (await reportBoardStatus(pm, boardItemId, DONE_STATUS, taskId))) {
			movedTo = DONE_STATUS;
		}

		logger.info('Phase finished - Respond-to-review', {
			taskId,
			prNumber,
			prBranch,
			outcome,
			movedTo,
			pushedHeadSha,
		});

		return { outcome, movedTo, agent, pushedHeadSha };
	} catch (error) {
		if (!legacyMode && hasDeliveryProgress(handle.path)) {
			preserveForResume = true;
			throw new DeliveryDeferredError('Review-response delivery deferred for retry', {
				cause: error,
			});
		}
		throw error;
	} finally {
		await cleanupUnlessPreserved(
			worktrees,
			taskId,
			preserveForResume,
			'respond-to-review phase',
			runId,
		);
	}
}
