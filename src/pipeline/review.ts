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
 * phase moved it), and a submitted review doesn't change board status. Which
 * verdicts drive SWARM-21 is the *trigger's* policy, not this phase's: under the
 * default `pipeline.respondToReview.skipOnMinors` only `request-changes`
 * dispatches Respond-to-review (`src/triggers/handlers/respond-to-review.ts`), so
 * an `approve` is answered by the merge path rather than by the implementer. (This
 * phase originally submitted a third verdict, `comment`, from when every verdict
 * was answered; it satisfied neither path once that default changed, and was
 * removed in issue #470 — see {@link REVIEW_VERDICTS}.) Merging is not this
 * phase's job either: after an eligible
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
	REVIEW_VERDICT_CAP,
} from '@/db/repositories/reviewVerdictsRepository.js';
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
import { buildReviewHandoffRepairPrompt, buildReviewPrompt } from '@/pipeline/prompts/review.js';
import {
	acquireResumableWorktree,
	cleanupUnlessPreserved,
	repairSessionId,
	sessionRunArgs,
	shouldPreserveForResume,
} from '@/pipeline/resume.js';
import { renderReviewBody } from '@/pipeline/review-body.js';
import type { ReviewVerdictLedger } from '@/pipeline/review-ledger.js';
import type { RecoveryMode } from '@/queue/jobs.js';
import {
	DeliveryDeferredError,
	deliveryIdentity,
	HANDOFF_FILENAMES,
	hasDeliveryProgress,
	type LegacyReviewHandoff,
	LegacyReviewHandoffSchema,
	loadDeliveryProgress,
	ReviewHandoffSchema,
	readHandoff,
	resumedDeliveryAgent,
	type ScmDeliveryProvider,
	saveDeliveryProgress,
} from '@/scm/delivery.js';
import { GitWorktreeManager } from '@/worker/git-worktree-manager.js';
import { graftEnvironment } from '@/worktree/graft.js';

/** The hand-off file the review agent writes its verdict and findings to, at the worktree root. */
export const REVIEW_VERDICT_FILENAME = HANDOFF_FILENAMES.review;

// The static review prompt now lives in `src/pipeline/prompts/review.ts` (issue
// #135); re-exported so existing importers of `@/pipeline/review.js` keep
// resolving it unchanged.
export { buildReviewPrompt };

/**
 * The verdicts SWARM may submit on the agent's behalf. The agent names one in
 * {@link REVIEW_VERDICT_FILENAME}; anything else is a failed run, not a third
 * outcome. Kept as a named list rather than derived from
 * {@link ReviewHandoffSchema} because the wire protocol and the `runs` row check
 * themselves against it (`src/transport/protocol.ts`, `src/db/schema/runs.ts`).
 *
 * `comment` was removed (issue #470). It existed only to mirror `gh pr review`'s
 * third event flag, and it closed every exit at once: it never clears the review
 * gate (only `approve` persists a merge dispatch), it dispatches no
 * Respond-to-review run under the default `skipOnMinors`, it still charges the PR
 * a slot against {@link REVIEW_VERDICT_CAP}, and it sets no
 * `manual-intervention-required` signal — so the PR looked reviewed and was
 * silently terminal. A reviewer that cannot reach a verdict must fail its run,
 * which retries, rather than post a terminal non-verdict. Note this is SWARM's
 * *outbound* vocabulary only: `ScmReviewState` (`src/scm/events.ts`) still
 * observes an inbound `commented` review, which humans submit routinely.
 */
export const REVIEW_VERDICTS = ['approve', 'request-changes'] as const;

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
	/**
	 * The repository this run acts on — the same value recorded on its run row
	 * (`runs.repository`, issue #683). Required, and fed from the control plane
	 * rather than read off `project.repo`: it is what the review-verdict ledger
	 * keys on (both the prior-submitted-review lookup and the submitted slot) and
	 * what the review prompt names, so for a project holding several repositories
	 * those rows key on the repository the run actually reviewed rather than on
	 * whichever one the config happens to list first. Identical to `project.repo`
	 * because both are resolved from the job's own repository (issue #699), which
	 * is the invariant issue #685 asserts rather than assumes.
	 */
	repository: string;
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
	/**
	 * Mode for recovering a cancelled preserved worktree. The full
	 * {@link RecoveryMode}, even though this phase writes no checkpoint
	 * (`docs/CHECKPOINTS.md`) and so can never legitimately be sent
	 * `'checkpoint'`: the executor forwards one value to every phase (issue #591),
	 * and narrowing it here only meant this phase could not be handed the union it
	 * is given. If a `'checkpoint'` ever does arrive, the recovery gate's
	 * `validateCheckpointForContinuation` fails it with the accurate
	 * `missing-validation` / `checkpoint-divergent` reason rather than the phase
	 * failing to compile.
	 */
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
	/**
	 * Provider-neutral deterministic SCM delivery seam. Omit to have the phase
	 * resolve the project's own registered provider.
	 */
	delivery?: ScmDeliveryProvider;
	/**
	 * Injectable reviewer-token resolver — defaults to {@link getPersonaToken}.
	 * Supplied by the DB-free worker, which injects the operator's own token rather
	 * than reaching into a secret store it cannot read (ADR-003 §2).
	 */
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
	/** The verdict SWARM submitted, read from {@link REVIEW_VERDICT_FILENAME}. */
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
	/** The repository the run recorded ({@link RunReviewPhaseOptions.repository}). */
	repository: string;
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
): Promise<{ agent: AgentCliResult; isReReview: boolean; passOrdinal: number }> {
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
		repository,
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
	const priorReview = await getPriorSubmittedReview(project.id, repository, prNumber, headSha);
	const isReReview = priorReview?.verdict === 'request-changes';
	// This run's own slot number, for the rendered body's pass label (issue #470).
	// Derived from the prior *submitted* verdict rather than read back from the
	// reservation: `reserveReviewVerdict` blocks while another slot is still
	// pending and numbers active slots contiguously from 1, so the prior submitted
	// ordinal plus one *is* this run's ordinal — and deriving it here keeps the
	// three-method `ReviewVerdictLedger` seam (and its transport implementation for
	// DB-free workers, ADR-003 §2) unchanged. The authoritative ordinal still comes
	// from `markReviewVerdictSubmitted` after delivery, and drives the cap.
	const passOrdinal = (priorReview?.ordinal ?? 0) + 1;

	if (shouldResumeDelivery) {
		return { agent: resumedDeliveryAgent(cli), isReReview, passOrdinal };
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
		args: [buildReviewPrompt({ repo: repository, prNumber, headSha }, customPrompt, isReReview)],
		// `gh` reads GH_TOKEN ahead of any ambient `gh auth` login, so every gh
		// call the agent makes acts as the reviewer persona.
		maxOutputBytes: MAX_AGENT_OUTPUT_BYTES,
		logContext: { taskId, phase: 'review', prNumber, headSha },
		timeoutMs,
		signal,
		env: { GH_TOKEN: agentToken },
	});
	return { agent, isReReview, passOrdinal };
}

interface RepairReviewHandoffParams {
	validationError: string;
	isReReview: boolean;
	cli: AgentCli;
	model?: string;
	reasoning?: ReasoningLevel;
	/** The session to continue, so the repair pass still has the review in context. */
	resumeSessionId?: string;
	worktreePath: string;
	taskId: string;
	prNumber: string;
	headSha: string;
	agentToken: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	runAgent: (opts: Parameters<typeof runAgentCli>[0]) => Promise<AgentCliResult>;
}

/**
 * What one repair pass actually did — as opposed to what the hand-off looks like
 * afterwards. `executed: false` is the case issue #865 was filed for: the pass
 * never reached the model, and before that issue it settled identically to a
 * model that re-read the contract and still got the shape wrong.
 */
export type ReviewRepairOutcome =
	| { executed: true; resumedSession: boolean }
	| { executed: false; reason: string };

/**
 * Re-run the review agent once, in the same worktree, with nothing but the
 * validator's complaint and the hand-off contract — see {@link
 * readReviewSubmission} for why the failure is worth one pass rather than three
 * whole reviews.
 *
 * It resumes the session the review just ran where one is addressable
 * ({@link repairSessionId}), so the agent still holds its own reasoning about the
 * diff rather than re-deriving it. Where no id was usable the pass runs in a
 * fresh session and is still not wasted: the hand-off it must repair, and the
 * checkout its evidence came from, are both still on disk.
 *
 * Never throws — it reports what it did as a {@link ReviewRepairOutcome} instead.
 * A repair run that fails leaves the invalid hand-off in place, and the caller
 * fails with the original validation error — which names the actual defect,
 * unlike whatever this pass may have gone wrong with — carrying this outcome.
 */
async function repairReviewHandoff(
	params: RepairReviewHandoffParams,
): Promise<ReviewRepairOutcome> {
	const { cli, taskId, prNumber, headSha } = params;
	try {
		const agent = await params.runAgent({
			cli,
			model: params.model,
			reasoning: params.reasoning,
			resumeSessionId: params.resumeSessionId,
			cwd: params.worktreePath,
			args: [buildReviewHandoffRepairPrompt(params.validationError, params.isReReview)],
			maxOutputBytes: MAX_AGENT_OUTPUT_BYTES,
			logContext: { taskId, phase: 'review-handoff-repair', prNumber, headSha },
			// Its own budget: the harness has no notion of a phase's remaining time,
			// and a repair pass is short next to the review it follows.
			timeoutMs: params.timeoutMs,
			signal: params.signal,
			env: { GH_TOKEN: params.agentToken },
		});
		if (agent.exitCode !== 0) {
			logger.warn('Review — the hand-off repair pass exited non-zero', {
				taskId,
				prNumber,
				headSha,
				cli,
				exitCode: agent.exitCode,
			});
			return {
				executed: false,
				reason: `the ${cli} repair run exited ${agent.exitCode} after ${agent.durationMs} ms`,
			};
		}
		return { executed: true, resumedSession: params.resumeSessionId !== undefined };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn('Review — the hand-off repair pass could not be run', {
			taskId,
			prNumber,
			headSha,
			cli,
			error: message,
		});
		return { executed: false, reason: `the ${cli} repair run could not be started: ${message}` };
	}
}

/**
 * Whether a non-blocking finding this review reports will be answered by an agent
 * at all. Both conditions have to hold: a disabled Respond-to-review skips every
 * verdict regardless of `skipOnMinors`, and the rendered body must not promise a
 * run that will not happen.
 */
function minorsAreAnswered(project: ProjectConfig): boolean {
	const respondToReview = project.pipeline?.respondToReview;
	return respondToReview?.enabled !== false && respondToReview?.skipOnMinors === false;
}

/**
 * Bind {@link repairReviewHandoff} to this run, so the submission reader can call
 * it with nothing but the validator's message. Split out to keep the closure —
 * and its long argument list — out of {@link runReviewPhase}'s complexity budget.
 */
function reviewRepairStep(
	params: Omit<RepairReviewHandoffParams, 'validationError'>,
): (validationError: string) => Promise<ReviewRepairOutcome> {
	return (validationError) => repairReviewHandoff({ ...params, validationError });
}

interface ReviewSubmissionContext {
	cli: AgentCli;
	headSha: string;
	ordinal: number;
	isReReview: boolean;
	minorsAnswered: boolean;
	/** Accept a pre-#470 hand-off — set only when resuming a delivery (see below). */
	allowLegacy: boolean;
	/**
	 * Re-run the agent once against the validator's own complaint, for a run whose
	 * hand-off didn't validate. Never reached on a resumed delivery — `allowLegacy`
	 * is answered first, and that run's agent has already exited for good — so the
	 * phase passes this unconditionally; only a caller with no agent to re-run
	 * (a test) leaves it out.
	 */
	repair?: (validationError: string) => Promise<ReviewRepairOutcome>;
	/**
	 * Whether {@link repair} was bound to a session id at all — logged before the
	 * pass runs, so a repair that dies on the resume is attributable without
	 * waiting for its outcome (issue #865). Resolved by {@link repairSessionId},
	 * which withholds an *assigned* id from a CLI that never received one.
	 */
	repairResumesSession?: boolean;
}

/** Parse the structured hand-off and render the body SWARM will post. Throws if it doesn't validate. */
function renderSubmission(
	worktreePath: string,
	context: ReviewSubmissionContext,
): { verdict: ReviewVerdict; body: string } {
	const handoff = readHandoff(worktreePath, REVIEW_VERDICT_FILENAME, ReviewHandoffSchema);
	return {
		verdict: handoff.verdict,
		body: renderReviewBody({
			handoff,
			headSha: context.headSha,
			ordinal: context.ordinal,
			// An operator-forced re-review (issue #511) runs at an ordinal above the
			// automatic cap, having been granted exactly one extra slot — so the pass
			// label states the cap this pass actually ran under ("pass 4 of 4 — final
			// permitted verdict") rather than the nonsensical "pass 4 of 3". An
			// ordinary pass is at or below the cap, so this is a no-op for it.
			cap: Math.max(REVIEW_VERDICT_CAP, context.ordinal),
			isReReview: context.isReReview,
			minorsAnswered: context.minorsAnswered,
		}),
	};
}

/**
 * The pre-#470 escape hatch, taken only when resuming a delivery. A worktree
 * preserved by a half-failed submission may hold a hand-off an older agent wrote,
 * and that shape can no longer satisfy `ReviewHandoffSchema`; without this the
 * retry would fail validation forever instead of finishing the submission it had
 * already started. A fresh run gets no such latitude — its hand-off must be the
 * structured shape, which is what makes the format enforceable at all.
 *
 * `structuredError` is rethrown when the file isn't the legacy shape either: the
 * structured schema's complaint is then the real one, and surfacing the legacy
 * schema's "body Required" in its place would bury it.
 */
function legacySubmission(
	worktreePath: string,
	context: ReviewSubmissionContext,
	structuredError: unknown,
): { verdict: ReviewVerdict; body: string } {
	let legacy: LegacyReviewHandoff;
	try {
		legacy = readHandoff(worktreePath, REVIEW_VERDICT_FILENAME, LegacyReviewHandoffSchema);
	} catch {
		throw structuredError;
	}
	if (legacy.verdict === 'comment')
		throw new Error(
			`Review agent (${context.cli}) resumed a legacy hand-off with the removed 'comment' verdict; ` +
				'it submits no actionable review (issue #470) — re-run the phase from a fresh worktree',
		);
	logger.warn('Review — resumed a pre-#470 hand-off; posting its authored body verbatim', {
		headSha: context.headSha,
		verdict: legacy.verdict,
		reason: structuredError instanceof Error ? structuredError.message : String(structuredError),
	});
	return { verdict: legacy.verdict, body: legacy.body };
}

/**
 * The error the phase fails with after a repair pass — carrying **what the pass
 * did** as well as the original defect (issue #865). Both outcomes used to
 * rethrow the validator's complaint verbatim, so a run whose repair never
 * reached the model was indistinguishable in `runs.error` from one whose model
 * re-read the contract and still got it wrong; the only record of the difference
 * was `logs/worker.log`.
 *
 * The original message stays the *head* of the composed one — it names the actual
 * defect, which is still what an operator reads first — and the original error
 * travels on `cause` unchanged, so anything inspecting it is unaffected.
 */
function repairFailureError(original: unknown, outcome: ReviewRepairOutcome): Error {
	const head = original instanceof Error ? original.message : String(original);
	const tail = outcome.executed
		? `the repair pass re-asked the agent ${outcome.resumedSession ? "in the review's own session" : 'in a fresh session'} and the hand-off was still invalid`
		: `the repair pass never ran — ${outcome.reason}`;
	return new Error(`${head} — ${tail}`, { cause: original });
}

/**
 * Read the review hand-off and produce what gets submitted: the verdict, and the
 * body **rendered by SWARM** from the hand-off's fields (issue #470) rather than
 * authored by the agent, so the review's structure is identical whichever CLI or
 * model produced it.
 *
 * A hand-off that doesn't validate gets **one** repair pass before the run fails.
 * The agent never sees the validator's complaint otherwise: the phase throws, the
 * queue retries the job, and the whole review runs again from scratch — three
 * full passes (`attempts`, `src/queue/producer.ts`) for a model that mis-shapes
 * the JSON the same way each time. Since #470 moved the format's enforcement into
 * the schema, this is the only feedback path that enforcement has. A second
 * failure fails with the *first* error's message as the **head** of a composed one
 * that also says what the repair pass did, carrying the original error on `cause`
 * — so the logs still name the original defect rather than whatever the repair
 * pass made of it (see {@link repairFailureError}).
 */
async function readReviewSubmission(
	worktreePath: string,
	context: ReviewSubmissionContext,
): Promise<{ verdict: ReviewVerdict; body: string }> {
	try {
		return renderSubmission(worktreePath, context);
	} catch (error) {
		if (context.allowLegacy) return legacySubmission(worktreePath, context, error);
		if (!context.repair) throw error;
		const validationError = error instanceof Error ? error.message : String(error);
		logger.warn('Review — hand-off failed validation; running one repair pass', {
			headSha: context.headSha,
			cli: context.cli,
			reason: validationError,
			resumingSession: context.repairResumesSession,
		});
		const outcome = await context.repair(validationError);
		try {
			return renderSubmission(worktreePath, context);
		} catch (repairError) {
			logger.error('Review — the repair pass did not produce a valid hand-off', {
				headSha: context.headSha,
				cli: context.cli,
				reason: repairError instanceof Error ? repairError.message : String(repairError),
				repairExecuted: outcome.executed,
				repairReason: outcome.executed ? undefined : outcome.reason,
			});
			throw repairFailureError(error, outcome);
		}
	}
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
		repository,
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
	const agentToken = await (options.getToken ?? getPersonaToken)(project, 'reviewer');
	const verdictKey = { projectId: project.id, repository, prNumber, headSha };

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
		'review',
		headSha,
		true,
		resumeSessionId,
		() => worktrees.provision(taskId, { detach: true, baseBranch: headSha, runId }),
		resumeDelivery,
		recoveryMode,
		runId,
	);
	let preserveForResume = false;
	try {
		graft(project.repoRoot, handle.path);

		const { agent, isReReview, passOrdinal } = await produceReviewAgentResult({
			shouldResumeDelivery: deliveryResumed,
			cli,
			model,
			reasoning,
			sessionId,
			resumeSessionId,
			resumed,
			worktreePath: handle.path,
			project,
			repository,
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

		// Resolved once: it is both what the repair pass resumes and what the
		// pre-pass log line reports (issue #865). `undefined` means "run the pass,
		// but do not resume" — see {@link repairSessionId}.
		const repairResumeId = repairSessionId(cli, agent, { sessionId, resumeSessionId }, resumed);
		const submission = await readReviewSubmission(handle.path, {
			cli,
			headSha,
			ordinal: passOrdinal,
			isReReview,
			minorsAnswered: minorsAreAnswered(project),
			allowLegacy: deliveryResumed,
			repairResumesSession: repairResumeId !== undefined,
			repair: reviewRepairStep({
				isReReview,
				cli,
				model,
				reasoning,
				resumeSessionId: repairResumeId,
				worktreePath: handle.path,
				taskId,
				prNumber,
				headSha,
				agentToken,
				timeoutMs,
				signal,
				runAgent,
			}),
		});
		const delivery =
			options.delivery ??
			(await requireProjectSCMProvider(project).deliveryProvider(project, 'reviewer'));
		// Deliberately still `project.repo`, not the run's `repository`: this is a
		// resume-idempotency key a preserved worktree's sidecar was written under, so
		// re-deriving it from a different input would orphan the progress of a run in
		// flight across the deploy. The two agree because both are resolved from the
		// job's own repository — `project` reaches this phase already scoped to it
		// (issue #699), and `repository` is filled from the same source (issue #692) —
		// not because a project holds only one. Both being repository-keyed is what
		// keeps two same-numbered PRs in two repositories from sharing this key
		// (issue #685; asserted in `tests/unit/pipeline/review-delivery.test.ts`).
		const deliveryId = deliveryIdentity(['review', project.repo, prNumber, headSha]);
		const progress = loadDeliveryProgress(handle.path, deliveryId);
		saveDeliveryProgress(handle.path, progress);
		if (!progress.reviewId)
			progress.reviewId = await delivery.submitReview({
				prNumber: Number(prNumber),
				verdict: submission.verdict,
				body: submission.body,
				deliveryId,
			});
		saveDeliveryProgress(handle.path, progress);
		const verdict = submission.verdict;
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
		if (hasDeliveryProgress(handle.path)) {
			preserveForResume = true;
			throw new DeliveryDeferredError('Review delivery deferred for retry', { cause: error });
		}
		// No delivery progress exists — the review is known to have never been
		// submitted, so free the ledger's pending slot rather than charging the PR for
		// this failed attempt (issue #235). Best-effort: a failure here must not mask
		// the original error.
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
