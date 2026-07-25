/**
 * Review phase (PROJECT.md §5.3, ai/ARCHITECTURE.md "Pipeline phases" #3).
 *
 * A PR opens / its check suite passes → the worker runs this: provision a
 * read-only worktree at the PR's head commit, spin up Claude Code as the
 * reviewer persona to read the diff and verify findings against the checkout,
 * and have it submit a formal GitHub PR review — mirroring Cascade's
 * review-agent trigger on `check_suite` success.
 *
 * The review must be a *formal* review (`gh pr review`), not a plain comment:
 * the Respond-to-review phase (SWARM-21) is driven by the
 * `pull_request_review` webhook that only a submitted review emits, and its
 * `changes_requested` state is what routes work back to the implementer
 * (ai/ARCHITECTURE.md "Pipeline phases" #4). That in turn forces the persona
 * plumbing here: GitHub refuses to let a PR's author review their own PR, so
 * the agent's `gh` must authenticate as the *reviewer* persona, not the
 * implementer who opened it. SWARM's harness has no gadget layer (unlike
 * Cascade's `CreatePRReview`), so the reviewer token is resolved from the
 * project's credentials and handed to the CLI process as `GH_TOKEN` — the env
 * var `gh` reads before any ambient login. The token crosses exactly one
 * boundary (resolution → subprocess env), never function layers
 * (ai/CODING_STANDARDS.md "Error handling" / credential scoping).
 *
 * The checkout is detached at the PR's head SHA, like Planning's throwaway
 * checkout: review is read-only, and checking out the PR's `issue-<n>` branch
 * would collide with the local branch the Implementation phase's cleanup
 * leaves behind (see `runImplementationPhase`'s re-run note). The head SHA —
 * which the `pull_request` and `check_suite` webhooks both carry — also pins
 * the review to exactly the commit CI validated.
 *
 * No PM interaction: the item already sits at "In review" (the Implementation
 * phase moved it), and a submitted review doesn't change board status — any
 * verdict drives SWARM-21 (the implementer always responds, even to an
 * approval). Merging is not this phase's job either: after an eligible
 * `approve` the worker persists a durable merge dispatch (issue #292,
 * `src/worker/merge-automation.ts`) executed through the provider-neutral
 * merge capability (`src/scm/merge.ts`), or the PR is left to a human.
 *
 * This is the phase's orchestration only, same as Planning/Implementation. It
 * composes `GitWorktreeManager` (SWARM-14), `graftEnvironment` (SWARM-15) and
 * `runAgentCli` (SWARM-16), and takes the PR coordinates as inputs rather than
 * reaching for a queue or webhook payload. The trigger handler that matches
 * `pull_request` opened / `check_suite` success events and calls this —
 * including the aggregate-check-state and dedup policy Cascade's
 * `check-suite-success` trigger encodes — is its own issue, wired via
 * `src/triggers/builtins.ts` when it lands. That handler must accept only
 * same-repo PRs: `provision`'s best-effort `git fetch origin` fetches branch
 * refs, so a fork PR's head SHA is unreachable here and the detached checkout
 * would fail the job.
 */

import { getPersonaToken } from '@/config/provider.js';
import type { ProjectConfig } from '@/config/schema.js';
import {
	abandonReviewVerdict as abandonReviewVerdictDefault,
	getPriorSubmittedReview as getPriorSubmittedReviewDefault,
	isCapReachingRequestChanges,
	markReviewVerdictSubmitted as markReviewVerdictSubmittedDefault,
} from '@/db/repositories/reviewVerdictsRepository.js';
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
import { buildReviewPrompt } from '@/pipeline/prompts/review.js';
import {
	acquireResumableWorktree,
	cleanupUnlessPreserved,
	sessionRunArgs,
	shouldPreserveForResume,
} from '@/pipeline/resume.js';
import type { ReviewVerdictLedger } from '@/pipeline/review-ledger.js';
import {
	DeliveryDeferredError,
	deliveryIdentity,
	HANDOFF_FILENAMES,
	hasDeliveryProgress,
	loadDeliveryProgress,
	ReviewHandoffSchema,
	readHandoff,
	resumedDeliveryAgent,
	type ScmDeliveryProvider,
	saveDeliveryProgress,
} from '@/scm/delivery.js';
import { GitWorktreeManager } from '@/worker/git-worktree-manager.js';
import { graftEnvironment } from '@/worktree/graft.js';

/** The file the review agent is instructed to write its submitted verdict to, at the worktree root. */
export const REVIEW_VERDICT_FILENAME = HANDOFF_FILENAMES.review;

// The static review prompt now lives in `src/pipeline/prompts/review.ts` (issue
// #135); re-exported so existing importers of `@/pipeline/review.js` keep
// resolving it unchanged.
export { buildReviewPrompt };

/**
 * The verdicts the agent may submit — `gh pr review`'s three event flags. The
 * agent hands back which one it used via {@link REVIEW_VERDICT_FILENAME};
 * anything else is a failed run, not a fourth outcome.
 */
export const REVIEW_VERDICTS = ['approve', 'request-changes', 'comment'] as const;

export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/**
 * Review-automation outcomes recorded on a completed Review run's history row
 * (issue #235) — currently only the terminal one: this run submitted the last
 * `request-changes` verdict the review-verdict safety cap allows, so
 * Respond-to-review stops the automatic cycle instead of dispatching a further
 * review. Every other outcome (an approval, an earlier verdict) leaves the
 * run's `reviewAutomationOutcome` column unset.
 */
export const REVIEW_AUTOMATION_OUTCOMES = ['manual-intervention-required'] as const;

export type ReviewAutomationOutcome = (typeof REVIEW_AUTOMATION_OUTCOMES)[number];

/** Claude Code is SWARM's review agent (PROJECT.md §5.3) — run as the reviewer persona. */
export const DEFAULT_REVIEW_CLI: AgentCli = 'claude';

/**
 * Cap on captured agent output, so a chatty/runaway review run can't grow the
 * worker's memory without bound. The verdict is read from
 * {@link REVIEW_VERDICT_FILENAME}, not from stdout, so truncating the captured
 * stream costs nothing here.
 */
const MAX_AGENT_OUTPUT_BYTES = 1_000_000;

export interface RunReviewPhaseOptions {
	/** The SWARM project whose repo the PR belongs to. */
	project: ProjectConfig;
	/** The number of the PR under review. */
	prNumber: string;
	/**
	 * The PR's head commit — what the detached checkout points at and what the
	 * review covers. Both triggering webhooks carry it (`pull_request.head.sha` /
	 * `check_suite.head_sha`), and pinning to it means the agent reviews exactly
	 * the commit whose checks passed, even if the branch moves mid-run.
	 */
	headSha: string;
	/**
	 * Task identifier for the worktree path (`task-<taskId>`). Passed explicitly
	 * rather than derived from `prNumber`: the worker that dequeues the job owns
	 * task naming, and a review worktree must not collide with an
	 * implementation/respond worktree for the same change.
	 */
	taskId: string;
	/** Worktree manager for the project — provisions and cleans up the checkout. */
	worktrees?: GitWorktreeManager;
	/** Which agent CLI to run. Defaults to Claude Code. */
	cli?: AgentCli;
	/** Model for the agent's session (e.g. 'sonnet', 'opus'). Omit for the CLI's own default. */
	model?: string;
	/** Reasoning level for the agent's session. Omit for the CLI/model default (issue #180). */
	reasoning?: ReasoningLevel;
	/**
	 * Project's optional custom prompt for this phase (`agents.review.prompt`,
	 * issue #135) — appended to the static SWARM prompt as a supplement-only
	 * section. Omit for today's prompt exactly.
	 */
	customPrompt?: string;
	/**
	 * Session id to assign to a fresh run (`sessionId`) or resume from on a retry
	 * (`resumeSessionId`). When resuming, the preserved head-SHA checkout is reused
	 * so the agent continues its prior session in place.
	 */
	sessionId?: string;
	resumeSessionId?: string;
	/** The database run id. */
	runId?: string;
	/** Mode for recovering a cancelled preserved worktree. */
	recoveryMode?: 'resume' | 'fresh';
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
	/** Injectable reviewer-token resolver — defaults to {@link getPersonaToken}; overridden in tests. */
	delivery?: ScmDeliveryProvider;
	/** @deprecated Compatibility seam for pre-delivery tests; production leaves this unset. */
	getToken?: typeof getPersonaToken;
	/**
	 * Injectable review-verdict ledger writers (issue #235) — defaults to the
	 * real {@link markReviewVerdictSubmittedDefault}/{@link abandonReviewVerdictDefault}
	 * repository calls; overridden in tests, and by a DB-free worker with the
	 * transport-backed ledger ({@link ReviewVerdictLedger}).
	 */
	markReviewVerdictSubmitted?: ReviewVerdictLedger['markReviewVerdictSubmitted'];
	abandonReviewVerdict?: ReviewVerdictLedger['abandonReviewVerdict'];
	/**
	 * Injectable prior-submitted-review lookup (issue #328) — defaults to the real
	 * {@link getPriorSubmittedReviewDefault}; overridden in tests. Its result
	 * decides whether this run is a re-review (a prior `request-changes` verdict)
	 * and therefore gets the scoped, verify-the-requested-changes-only prompt.
	 */
	getPriorSubmittedReview?: ReviewVerdictLedger['getPriorSubmittedReview'];
}

export interface ReviewPhaseResult {
	/** The verdict the agent submitted, read from {@link REVIEW_VERDICT_FILENAME}. */
	verdict: ReviewVerdict;
	/** The agent run's result (exit code, duration, captured output). */
	agent: AgentCliResult;
	/**
	 * This run's slot number in the review-verdict safety-cap ledger (1…
	 * `REVIEW_VERDICT_CAP`), `undefined` if the ledger had no reservation for
	 * this PR/head to mark submitted (issue #235).
	 */
	reviewOrdinal?: number;
	/**
	 * Set to `manual-intervention-required` when this run submitted the last
	 * `request-changes` verdict the cap allows; `undefined` for every other
	 * verdict/ordinal.
	 */
	automationOutcome?: ReviewAutomationOutcome;
}

/**
 * Log a failed review run's captured output before the phase throws, so the
 * worker that marks the job failed has the agent's own stdout/stderr to
 * diagnose *why* — the thrown Error carries only a message. Output is already
 * bounded by {@link MAX_AGENT_OUTPUT_BYTES}.
 */
function logAgentFailure(taskId: string, prNumber: string, agent: AgentCliResult): void {
	logger.error('Phase failed - Review — agent output', {
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

interface ReviewAgentRunParams {
	/** Reuse a preserved worktree's already-delivered agent output instead of running fresh. */
	shouldResumeDelivery: boolean;
	cli: AgentCli;
	model?: string;
	reasoning?: ReasoningLevel;
	sessionId?: string;
	resumeSessionId?: string;
	resumed: boolean;
	worktreePath: string;
	project: ProjectConfig;
	prNumber: string;
	headSha: string;
	taskId: string;
	customPrompt?: string;
	agentToken: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	runAgent: (opts: Parameters<typeof runAgentCli>[0]) => Promise<AgentCliResult>;
	getPriorSubmittedReview: ReviewVerdictLedger['getPriorSubmittedReview'];
}

/**
 * Produce the review agent's result and whether this run is a re-review. Either
 * resumes a preserved worktree's already-delivered output (no fresh run) or runs
 * the agent. It asks the ledger whether a `request-changes` verdict was already
 * submitted for this PR at an earlier head (issue #328) in both cases, so the
 * re-review flag is reported accurately even on a resumed delivery; only a fresh
 * run additionally uses it to hand the agent the scoped prompt that verifies
 * only the previously requested changes rather than surfacing newly-noticed
 * pre-existing issues. Split out of {@link runReviewPhase} to keep that
 * orchestrator within the cognitive-complexity budget.
 */
async function produceReviewAgentResult(
	params: ReviewAgentRunParams,
): Promise<{ agent: AgentCliResult; isReReview: boolean }> {
	const {
		shouldResumeDelivery,
		cli,
		model,
		reasoning,
		sessionId,
		resumeSessionId,
		resumed,
		worktreePath,
		project,
		prNumber,
		headSha,
		taskId,
		customPrompt,
		agentToken,
		timeoutMs,
		signal,
		runAgent,
		getPriorSubmittedReview,
	} = params;

	// Read-only, and the current head is excluded, so this can't mistake the run's
	// own slot for a prior review. Resolved before the resume check so the phase's
	// completion log reports `isReReview` accurately on a resumed delivery too.
	const priorReview = await getPriorSubmittedReview(project.id, project.repo, prNumber, headSha);
	const isReReview = priorReview?.verdict === 'request-changes';

	if (shouldResumeDelivery) {
		return { agent: resumedDeliveryAgent(cli), isReReview };
	}

	if (isReReview) {
		logger.info('Review — running as a re-review (verifying previously requested changes only)', {
			taskId,
			prNumber,
			headSha,
			priorOrdinal: priorReview?.ordinal,
		});
	}

	const agent = await runAgent({
		cli,
		model,
		reasoning,
		...sessionRunArgs({ sessionId, resumeSessionId }, resumed),
		cwd: worktreePath,
		args: [buildReviewPrompt({ repo: project.repo, prNumber, headSha }, customPrompt, isReReview)],
		// `gh` reads GH_TOKEN ahead of any ambient `gh auth` login, so every gh
		// call the agent makes acts as the reviewer persona.
		maxOutputBytes: MAX_AGENT_OUTPUT_BYTES,
		logContext: { taskId, phase: 'review', prNumber, headSha },
		timeoutMs,
		signal,
		env: { GH_TOKEN: agentToken },
	});
	return { agent, isReReview };
}

/**
 * Run the Review phase for one PR. Resolves the reviewer persona's token,
 * provisions a detached worktree at the PR's head SHA, runs the review agent
 * to read the diff and submit a formal PR review as the reviewer, and
 * validates the verdict it handed back.
 *
 * Throws if the reviewer token is missing (resolved *before* provisioning —
 * without it the agent could only act as the PR's own author, which GitHub
 * rejects), if the agent exits non-zero, or if it produced no recognizable
 * verdict — a review run that didn't verifiably submit a review is a failed
 * job, not a soft miss (ai/CODING_STANDARDS.md "Error handling"). The worktree
 * is always removed once provisioned, success or failure; the submitted review
 * lives on GitHub and is unaffected.
 */
export async function runReviewPhase(options: RunReviewPhaseOptions): Promise<ReviewPhaseResult> {
	const {
		project,
		prNumber,
		headSha,
		taskId,
		cli = DEFAULT_REVIEW_CLI,
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
		markReviewVerdictSubmitted = markReviewVerdictSubmittedDefault,
		abandonReviewVerdict = abandonReviewVerdictDefault,
		getPriorSubmittedReview = getPriorSubmittedReviewDefault,
	} = options;
	const worktrees = options.worktrees ?? new GitWorktreeManager(project);
	const legacyMode = options.getToken !== undefined && options.delivery === undefined;
	const agentToken = await (options.getToken ?? getPersonaToken)(project, 'reviewer');
	const verdictKey = { projectId: project.id, repository: project.repo, prNumber, headSha };

	logger.info(`Phase started - Review — running ${describeAgent(cli, model, reasoning)}`, {
		taskId,
		prNumber,
		headSha,
		cli,
		model,
		reasoning,
	});

	// Resolved first: a missing reviewer credential fails the job before any
	// worktree exists to clean up. Never returned or passed on — it goes straight
	// into the subprocess env below.
	// Read-only checkout pinned to the reviewed commit (see the module header for
	// why detached-at-SHA rather than the PR branch). On a resume retry, reuse the
	// preserved checkout so the agent continues its session against the same head.
	const { handle, resumed, deliveryResumed } = await acquireResumableWorktree(
		worktrees,
		taskId,
		headSha,
		true,
		resumeSessionId,
		() => worktrees.provision(taskId, { detach: true, baseBranch: headSha, runId }),
		resumeDelivery,
		recoveryMode,
		project.id,
	);
	let preserveForResume = false;
	try {
		graft(project.repoRoot, handle.path);

		const shouldResumeDelivery = !legacyMode && deliveryResumed;
		const { agent, isReReview } = await produceReviewAgentResult({
			shouldResumeDelivery,
			cli,
			model,
			reasoning,
			sessionId,
			resumeSessionId,
			resumed,
			worktreePath: handle.path,
			project,
			prNumber,
			headSha,
			taskId,
			customPrompt,
			agentToken,
			timeoutMs,
			signal,
			runAgent,
			getPriorSubmittedReview,
		});

		if (agent.exitCode !== 0) {
			logAgentFailure(taskId, prNumber, agent);
			const error = agentRunError(
				agent,
				`Review agent (${cli}) exited with code ${agent.exitCode}`,
				` for PR #${prNumber}`,
			);
			preserveForResume = shouldPreserveForResume(error);
			throw error;
		}

		if (legacyMode) {
			if (!existsSync(join(handle.path, REVIEW_VERDICT_FILENAME)))
				throw new Error(`Review agent (${cli}) did not write ${REVIEW_VERDICT_FILENAME}`);
			const original = readFileSync(join(handle.path, REVIEW_VERDICT_FILENAME), 'utf8').trim();
			const raw = original.toLowerCase() as ReviewVerdict;
			if (!raw) throw new Error(`Review agent (${cli}) wrote an empty ${REVIEW_VERDICT_FILENAME}`);
			if (!REVIEW_VERDICTS.includes(raw))
				throw new Error(`Review agent (${cli}) wrote unrecognized verdict '${original}'`);
			const ledgerRecord = await markReviewVerdictSubmitted(verdictKey, { verdict: raw });
			const automationOutcome = isCapReachingRequestChanges(ledgerRecord?.ordinal, raw)
				? 'manual-intervention-required'
				: undefined;
			return {
				verdict: raw,
				agent,
				reviewOrdinal: ledgerRecord?.ordinal,
				automationOutcome,
			};
		}
		const handoff = readHandoff(handle.path, REVIEW_VERDICT_FILENAME, ReviewHandoffSchema);
		const delivery =
			options.delivery ?? (await new GitHubSCMIntegration().deliveryProvider(project, 'reviewer'));
		const deliveryId = deliveryIdentity(['review', project.repo, prNumber, headSha]);
		const progress = loadDeliveryProgress(handle.path, deliveryId);
		saveDeliveryProgress(handle.path, progress);
		if (!progress.reviewId)
			progress.reviewId = await delivery.submitReview({
				prNumber: Number(prNumber),
				verdict: handoff.verdict,
				body: handoff.body,
				deliveryId,
			});
		saveDeliveryProgress(handle.path, progress);
		const verdict = handoff.verdict;
		// Marked after delivery confirms the review id — idempotent, so a crash
		// between GitHub delivery and this write is repaired by a retry without
		// submitting a second review (issue #235).
		const ledgerRecord = await markReviewVerdictSubmitted(verdictKey, {
			verdict,
			reviewId: progress.reviewId !== undefined ? String(progress.reviewId) : undefined,
		});
		const reviewOrdinal = ledgerRecord?.ordinal;
		const automationOutcome = isCapReachingRequestChanges(reviewOrdinal, verdict)
			? 'manual-intervention-required'
			: undefined;

		logger.info('Phase finished - Review', {
			taskId,
			prNumber,
			headSha,
			verdict,
			reviewOrdinal,
			automationOutcome,
			isReReview,
		});

		return { verdict, agent, reviewOrdinal, automationOutcome };
	} catch (error) {
		if (!legacyMode && hasDeliveryProgress(handle.path)) {
			preserveForResume = true;
			throw new DeliveryDeferredError('Review delivery deferred for retry', { cause: error });
		}
		// No delivery progress exists (or this is legacy mode, which has none) —
		// the review is known to have never been submitted, so free the ledger's
		// pending slot rather than charging the PR for this failed attempt
		// (issue #235). Best-effort: a failure here must not mask the original error.
		try {
			await abandonReviewVerdict(verdictKey);
		} catch (abandonError) {
			logger.warn('review: failed to abandon review-verdict reservation after a failed run', {
				taskId,
				prNumber,
				headSha,
				error: abandonError instanceof Error ? abandonError.message : String(abandonError),
			});
		}
		throw error;
	} finally {
		await cleanupUnlessPreserved(worktrees, taskId, preserveForResume, 'review phase', runId);
	}
}

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
