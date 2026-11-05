/**
 * Implementation phase (PROJECT.md §5.2, ai/ARCHITECTURE.md "Pipeline phases" #2).
 *
 * An item moves to "ToDo" on the board → the worker runs this: move the item to
 * "In progress" to report that the agent has picked up the task (a status
 * report, not a trigger — see `src/pm/pipeline.ts`; the move is made for every
 * run bar one already aborted, which must not report a pickup it will never
 * honour — issue #912),
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
 * the PR through `ScmDeliveryProvider`. The PR body is SWARM's built-in description
 * structure filled in by the agent (issue #1277), followed by a line SWARM adds
 * itself: `Closes: #<n>` when the PR can close the card's linked issue, otherwise
 * `Work item: [<key>](<url>)` (`./pull-request-description.ts`); the comment this
 * phase posts is the human-facing pointer.
 *
 * The implementer persona's token is resolved and handed to the agent as
 * `GH_TOKEN` (mirroring `runReviewPhase`'s reviewer-token plumbing) so every `gh`
 * read the agent makes acts as that persona, not whatever `gh auth` session
 * happens to be ambient on the worker's host; the delivery that opens the PR runs
 * under the same persona's credential. Since issue #396 the implementer token is
 * the worker operator's own — since issue #765 resolved from the per-`(worker, SCM
 * provider)` store and handed to this phase as `agentToken`/`delivery` rather than
 * read from an env var — so the PR is authored by the operator's account. Review's ownership gate no longer reads that author
 * at all (issue #397): it recognises the PR from its **branch**
 * (the repository's branch name pattern filled for the task, issue #1241 — the branch
 * this phase decides, provisions and pushes)
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
import { agentRunError, agentRunFailed } from '@/harness/agent-failure.js';
import type { ReasoningLevel } from '@/harness/models.js';
import { requireProjectSCMProvider } from '@/integrations/scm/registry.js';
import { logger } from '@/lib/logger.js';
import {
	branchPatternNeedsImplementer,
	FALLBACK_WORK_TYPE,
	isWorkType,
	renderBranchName,
	toFriendlyName,
	type WorkType,
	workTypeFromCommitSubject,
} from '@/pipeline/branch-pattern.js';
import type { Checkpoint } from '@/pipeline/checkpoint.js';
import {
	normalizeSubject,
	renderCommitSubject,
	resolveCommitSubjectMaxLength,
	resolveCommitSubjectPattern,
} from '@/pipeline/commit-subject-pattern.js';
import { assertDependenciesSatisfied } from '@/pipeline/dependency-guard.js';
import {
	BLOCKED_REASON_FILENAME,
	buildImplementationPrompt,
} from '@/pipeline/prompts/implementation.js';
import { composePullRequestBody } from '@/pipeline/pull-request-description.js';
import {
	cleanupUnlessPreserved,
	executeRecoveryGate,
	sessionRunArgs,
	shouldPreserveFailedCheckout,
	warnStartingOverOnPreservedWork,
} from '@/pipeline/resume.js';
import { provisionalTaskBranch, resolveBranchPattern } from '@/pipeline/task-branch.js';
import type { PmStatusKey } from '@/pm/pipeline.js';
import type { PMProvider, WorkItem } from '@/pm/types.js';
import type { RecoveryMode } from '@/queue/jobs.js';
import {
	commitPreparedTree,
	DeliveryDeferredError,
	type DeliveryProgress,
	deliveryIdentity,
	HANDOFF_FILENAMES,
	hasDeliveryProgress,
	type ImplementationHandoff,
	ImplementationHandoffSchema,
	loadDeliveryProgress,
	lsRemoteBranchHead,
	pushDeliveredBranch,
	readHandoff,
	renameCheckedOutBranch,
	resolveCommitSha,
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
 * The `{friendly_name}` of last resort (issue #1241), for a task whose hand-off names
 * none and whose title transliterates to nothing ASCII.
 */
const FALLBACK_FRIENDLY_NAME = 'change';

/**
 * The task's `{work_type}` (issues #1241, #1242): the one the implementer named from the
 * closed list, else the type its legacy `commitSubject` starts with, else the fallback.
 */
function implementerWorkType(handoff: ImplementationHandoff): WorkType {
	const named = handoff.workType?.trim().toLowerCase();
	if (named && isWorkType(named)) return named;
	return workTypeFromCommitSubject(handoff.commitSubject ?? '') ?? FALLBACK_WORK_TYPE;
}

/** The task's `{friendly_name}` (issue #1241): the implementer's, else the card title's, else the fallback. */
function implementerFriendlyName(handoff: ImplementationHandoff, title: string): string {
	return (
		toFriendlyName(handoff.friendlyName ?? '') || toFriendlyName(title) || FALLBACK_FRIENDLY_NAME
	);
}

/**
 * The implementer's `{subject}` (issue #1242): its `subject`, or — from a hand-off an
 * older prompt prepared — the summary inside its whole `commitSubject`. `''` when
 * neither leaves any text, so the caller falls back to the card title.
 */
function implementerSubject(handoff: ImplementationHandoff, taskId: string): string {
	return normalizeSubject(handoff.subject ?? handoff.commitSubject ?? '', taskId);
}

/** What {@link decideDeliveryNaming} decides from. */
interface DeliveryNamingInput {
	project: ProjectConfig;
	taskId: string;
	workItem: WorkItem;
	handoff: ImplementationHandoff;
	progress: DeliveryProgress;
	branchPattern: string;
	decidedBranch?: string;
	storedCommitSubject?: string;
	/**
	 * An abandoned delivery's attempt (issue #1334): its subject is decided again, from
	 * the repository's current pattern rather than the one the old pull request used.
	 */
	abandoned?: boolean;
}

/**
 * The task branch and commit subject this delivery uses (issues #1241, #1242), each
 * decided once: a resumed delivery keeps what its first attempt recorded, a stored
 * value is reused, and only a first decision renders one. Both are rendered from one
 * work type, so the branch name and the commits never describe the task differently,
 * and the subject from the repository's pattern and the implementer's summary — never
 * the agent's own wording of the format.
 */
function decideDeliveryNaming(input: DeliveryNamingInput): {
	branch: string;
	commitSubject: string;
} {
	const { project, taskId, workItem, handoff, progress } = input;
	const workType = implementerWorkType(handoff);
	const branch =
		progress.branch ??
		input.decidedBranch ??
		renderBranchName(input.branchPattern, {
			issueKey: taskId,
			workType,
			friendlyName: implementerFriendlyName(handoff, workItem.title),
		});
	const commitSubject =
		progress.commitSubject ??
		(input.abandoned ? undefined : input.storedCommitSubject) ??
		renderCommitSubject(resolveCommitSubjectPattern(project), {
			issueKey: taskId,
			workType,
			subject: implementerSubject(handoff, taskId) || workItem.title,
		});
	const maxLength = resolveCommitSubjectMaxLength(project);
	if (commitSubject.length > maxLength)
		logger.warn('Commit subject is longer than the repository asks for — committing it anyway', {
			taskId,
			commitSubject,
			maxLength,
		});
	return { branch, commitSubject };
}

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
	 * (named by the repository's branch name pattern) — the linked issue number. Also the `#<n>` the PR
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
	/**
	 * The task branch an earlier attempt or run already decided for this task (issue
	 * #1241), read back off the run record. Reused verbatim — checked out, probed for an
	 * open PR, pushed to — and never re-rendered, so a retry cannot rename a branch a
	 * PR may already be open from.
	 */
	taskBranch?: string;
	/**
	 * Called with the task branch's name once this attempt has decided it — at
	 * provisioning when the repository's pattern needs no implementer-chosen part, at
	 * delivery otherwise — so the caller can store it with the run (issue #1241). Not
	 * called when {@link taskBranch} was handed in: that name is already stored.
	 */
	onBranchNamed?: (branch: string) => Promise<void>;
	/**
	 * The commit subject an earlier attempt or run already decided for this task (issue
	 * #1242), read back off the run record. Reused verbatim — committed with, and the
	 * pull request titled by — never re-rendered, so the task's commits and its branch
	 * name keep the `{work_type}` and summary they were first given.
	 */
	commitSubject?: string;
	/**
	 * Called with the commit subject once this attempt has decided it, at delivery, so
	 * the caller can store it with the run (issue #1242) for every later attempt and for
	 * the Respond-to-review / Respond-to-CI fix commits. Not called when
	 * {@link commitSubject} was handed in: that subject is already stored.
	 */
	onCommitSubjectNamed?: (commitSubject: string) => Promise<void>;
	/**
	 * The pull request an earlier Implementation run of this task delivered (issue
	 * #1334), read back off the run record. When the task branch has no open pull
	 * request any more — it was closed unmerged, or merged — an attempt that is not
	 * continuing its own work starts afresh: the branch is reset to the base, the
	 * commit subject is decided again from the repository's current pattern, the push
	 * replaces the abandoned head under a lease, and the card says so. Unset, or with
	 * the pull request still open, the attempt resumes or adopts exactly as before.
	 */
	deliveredPullRequestUrl?: string;
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
 * Idempotency marker on the fresh-attempt notice (issue #1334), keyed by the
 * abandoned pull request it replaces — one notice per abandoned pull request,
 * however many attempts the fresh start takes.
 */
export function freshAttemptMarker(abandonedPullRequestUrl: string): string {
	return swarmMarker(
		'implementation-fresh-attempt',
		deliveryIdentity(['implementation-fresh-attempt', abandonedPullRequestUrl]),
	);
}

/** What the fresh-attempt notice names (issue #1334). */
export interface FreshAttemptNotice {
	abandonedPullRequestUrl: string;
	baseBranch: string;
	branch: string;
	/** The abandoned branch's head on `origin`, or `undefined` when the branch was gone. */
	abandonedHead?: string;
}

/**
 * The card comment that makes a fresh attempt visible (issue #1334): which pull
 * request was abandoned, which base the attempt starts from, and what the task
 * branch's head was before it was replaced.
 */
export function freshAttemptCommentBody(notice: FreshAttemptNotice): string {
	const head = notice.abandonedHead
		? `its previous head was \`${notice.abandonedHead}\``
		: 'it was absent on origin';
	return [
		'## 🔁 Starting a fresh implementation',
		'',
		`The previous pull request (${notice.abandonedPullRequestUrl.trim()}) is no longer open, so this is a fresh attempt from \`${notice.baseBranch}\`. Task branch \`${notice.branch}\` was reset; ${head}.`,
		'',
		'---',
		`${SWARM_GENERATED_SIGNATURE} (Implementation phase)._`,
		'',
		freshAttemptMarker(notice.abandonedPullRequestUrl),
	].join('\n');
}

/**
 * Post the fresh-attempt notice at most once per abandoned pull request. Best-effort
 * like the phase-failure comments: a board that refuses the comment must not stop
 * the attempt it announces, so a failure is logged and swallowed.
 */
async function postFreshAttemptNotice(
	pm: PMProvider,
	workItemId: string,
	notice: FreshAttemptNotice,
): Promise<void> {
	try {
		const marker = freshAttemptMarker(notice.abandonedPullRequestUrl);
		if (await pm.findComment(workItemId, marker)) return;
		await pm.addComment(workItemId, freshAttemptCommentBody(notice));
	} catch (error) {
		logger.warn('Could not post the fresh-attempt notice on the card — continuing', {
			workItemId,
			abandonedPullRequestUrl: notice.abandonedPullRequestUrl,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Whether the task's earlier delivery was abandoned (issue #1334): an earlier run
 * delivered a pull request, and `branch` has none open any more. A fresh attempt is
 * an abandoned delivery's attempt that is not `continuingOwnWork` — not a resumed
 * session, a checkpoint continuation or a resumed delivery, each of which carries
 * the fresh attempt itself on. `openPullRequest` is the probe's answer, reused by
 * the already-delivered probe so the SCM is asked once.
 */
async function probeAbandonedDelivery(
	delivery: ScmDeliveryProvider,
	branch: string,
	deliveredPullRequestUrl: string | undefined,
	continuingOwnWork: boolean,
): Promise<AbandonedDeliveryProbe> {
	if (!deliveredPullRequestUrl)
		return {
			abandoned: false,
			freshAttempt: false,
			findOpenPullRequest: (handleBranch) => delivery.findPullRequest(handleBranch),
		};
	const openPullRequest = await delivery.findPullRequest(branch);
	const findOpenPullRequest = async () => openPullRequest;
	if (openPullRequest || continuingOwnWork)
		return { abandoned: !openPullRequest, freshAttempt: false, findOpenPullRequest };
	return {
		abandoned: true,
		freshAttempt: true,
		abandonedPullRequestUrl: deliveredPullRequestUrl,
		findOpenPullRequest,
	};
}

/** What {@link probeAbandonedDelivery} found. */
type AbandonedDeliveryProbe = {
	/** An earlier run delivered a pull request, and the task branch has none open. */
	abandoned: boolean;
	/** The task branch's open pull request — the probe's own answer when it asked. */
	findOpenPullRequest(branch: string): Promise<{ number: number; url: string } | undefined>;
} & (
	| { freshAttempt: false }
	/** An abandoned delivery's attempt that starts afresh from the base. */
	| { freshAttempt: true; abandonedPullRequestUrl: string }
);

/**
 * The abandoned branch's head on `origin` (issue #1334), or `undefined` for a delivery
 * that abandoned nothing. Asked of the remote itself: the remote-tracking ref outlives
 * a branch deleted with its pull request, since no fetch here prunes, and a lease over
 * that stale head would be refused on every push. Only when the remote cannot be
 * asked does this fall back to the tracking ref — a lease that turns out stale is
 * still recovered from by `pushDeliveredBranch`'s plain fast-forward retry.
 */
async function readAbandonedHead(
	handle: WorktreeHandle,
	abandoned: boolean,
): Promise<{ branch: string; sha?: string } | undefined> {
	if (!abandoned) return undefined;
	try {
		const sha = await lsRemoteBranchHead(handle.path, handle.branch);
		return { branch: handle.branch, sha: sha ?? undefined };
	} catch (error) {
		logger.warn('Could not ask origin for the abandoned head — using the remote-tracking ref', {
			branch: handle.branch,
			error: error instanceof Error ? error.message : String(error),
		});
		return {
			branch: handle.branch,
			sha: await resolveCommitSha(handle.path, `refs/remotes/origin/${handle.branch}`),
		};
	}
}

/**
 * Record the abandoned head this delivery replaces (issue #1334) — once, before the
 * push, so a resumed delivery pushes under the same lease; and only for the branch
 * that head was read from, since a branch decided under another name replaces nothing.
 */
function recordReplacedHead(
	progress: DeliveryProgress,
	branch: string,
	abandonedHead: { branch: string; sha?: string } | undefined,
): void {
	if (progress.pushed || progress.replacingSha !== undefined) return;
	if (abandonedHead?.sha && abandonedHead.branch === branch)
		progress.replacingSha = abandonedHead.sha;
}

/**
 * The PR-link comment's idempotency key: the delivery's own, unless the pull request
 * it links replaces the one an earlier run delivered (issue #1334) — that delivery's
 * comment already carries the base key, and linking the new pull request needs a
 * comment of its own.
 */
function prLinkDeliveryId(
	deliveryParts: readonly string[],
	prUrl: string,
	deliveredPullRequestUrl: string | undefined,
): string {
	return deliveredPullRequestUrl !== undefined && prUrl !== deliveredPullRequestUrl
		? deliveryIdentity([...deliveryParts, deliveredPullRequestUrl])
		: deliveryIdentity(deliveryParts);
}

/** Log and post the fresh-attempt notice (issue #1334) before the agent starts over. */
async function announceFreshAttempt(
	pm: PMProvider,
	workItemId: string,
	notice: FreshAttemptNotice,
	context: { taskId: string; runId?: string },
): Promise<void> {
	logger.warn('Earlier pull request is no longer open — starting a fresh attempt from the base', {
		...context,
		workItemId,
		...notice,
	});
	await postFreshAttemptNotice(pm, workItemId, notice);
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
 * task branch it created — deliberately, so a *successful*
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
	freshAttempt = false,
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
	//
	// Never for a fresh attempt (issue #1334): the branch's existing work is the
	// abandoned pull request's, which is exactly what that attempt must not resume.
	if (!freshAttempt && (resumeSessionId || resumeExistingBranch || resumeDelivery)) {
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
	// A fresh attempt cuts the branch from the base whatever this host or `origin`
	// still holds of it — including on its own retry, whose `resumeExistingBranch`
	// would otherwise check out the abandoned remote head again.
	const handle = freshAttempt
		? await worktrees.provision(taskId, { branch, runId, resetBranch: true })
		: resumeExistingBranch
			? await worktrees.provision(taskId, { createBranch: false, branch, runId })
			: await worktrees.provision(taskId, { branch, runId });
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
		taskBranch: storedTaskBranch,
		onBranchNamed,
		commitSubject: storedCommitSubject,
		onCommitSubjectNamed,
		deliveredPullRequestUrl,
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
	// gate for a human and never defers the run. Planning runs the same shared gate
	// at the same point in its own phase (issue #889), so the two cannot drift.
	await assertDependenciesSatisfied(pm, workItem);

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
	//
	// Skipped for a run that was already aborted (issue #912): a cancellation can
	// still land between the worker's pre-phase guard and here, since the dependency
	// gate above is a round trip. Reporting a pickup for a run that is dying leaves
	// the card in "In progress" with nothing to pick it up — dependency recheck skips
	// a card whose status already matches the phase. Skip only, never throw: the run
	// is already settling through the existing failure path (`runAgentCli` returns
	// immediately on an aborted signal), and a shutdown abort simply re-makes the
	// move on the deferred run's retry.
	if (!signal?.aborted) await pm.moveWorkItem(workItem.id, START_STATUS);

	// The task branch's name (issue #1241): the one an earlier attempt decided when
	// there is one, never re-rendered. Otherwise a pattern with no implementer-chosen
	// part is decided here, from the task id alone; one with a `{work_type}` or
	// `{friendly_name}` is checked out on its provisional legacy-shaped name and
	// decided at delivery, once the implementer's hand-off has chosen them.
	const branchPattern = resolveBranchPattern(project);
	const provisionalBranch = provisionalTaskBranch(project, taskId);
	const decidedBranch =
		storedTaskBranch ??
		(branchPatternNeedsImplementer(branchPattern) ? undefined : provisionalBranch);

	// Deterministic delivery is resolved *before* the agent, not after: the
	// already-delivered probe below has to ask the SCM about this task's branch
	// while there is still an agent run to skip. Before the worktree, too — the
	// abandoned-delivery probe decides how that worktree is provisioned, and a
	// failure here then leaves no checkout to clean up.
	const delivery =
		options.delivery ??
		(await requireProjectSCMProvider(project).deliveryProvider(project, 'implementer'));

	// An abandoned delivery (issue #1334): an earlier run delivered a pull request for
	// this task, and its branch has none open any more — closed unmerged, or merged.
	// Resuming the branch would start the agent on that pull request's finished work.
	// A run continuing its *own* work (a resumed session, a checkpoint continuation, a
	// resumed delivery) is the fresh attempt itself being carried on, so it keeps its
	// checkout; any other attempt starts afresh from the base.
	const probedBranch = decidedBranch ?? provisionalBranch;
	const probe = await probeAbandonedDelivery(
		delivery,
		probedBranch,
		deliveredPullRequestUrl,
		Boolean(resumeSessionId || resumeDelivery || recoveryMode),
	);

	// Task-branch checkout (createBranch defaults to true): the agent commits and
	// pushes here, so — unlike Planning — this is not a detached, throwaway HEAD.
	const { handle, resumed, deliveryResumed, checkpoint } = await acquireImplementationWorktree(
		worktrees,
		taskId,
		probedBranch,
		resumeSessionId,
		resumeExistingBranch,
		resumeDelivery,
		recoveryMode,
		runId,
		probe.freshAttempt,
	);
	await onBranchProvisioned?.();
	if (decidedBranch && !storedTaskBranch) await onBranchNamed?.(decidedBranch);
	let preserveForResume = false;
	try {
		graft(project.repoRoot, handle.path);

		// The abandoned head this delivery replaces, as `origin` holds it now — for a
		// fresh attempt and a continuation alike. It is the lease the push is made under,
		// so a push someone made to the old branch since is refused rather than
		// overwritten. Absent when the branch was deleted with its pull request: the push
		// is then ordinary.
		const abandonedHead = await readAbandonedHead(handle, probe.abandoned);
		// Keyed on the provisional name rather than the checkout's, which a decided
		// pattern name replaces between attempts — the progress sidecar and the PR-link
		// comment marker must stay this task's across that rename. For a pattern with no
		// implementer-chosen part the two are the same name, as they always were.
		const deliveryParts = ['implementation', project.repo, taskId, provisionalBranch];
		const deliveryId = deliveryIdentity(deliveryParts);

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
		//
		// A fresh attempt skips it: the abandoned-delivery probe above already found no
		// open pull request, and that probe's answer is reused when it ran.
		if (!deliveryResumed && !probe.freshAttempt) {
			const delivered = await probe.findOpenPullRequest(handle.branch);
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
					prLinkDeliveryId(deliveryParts, delivered.url, deliveredPullRequestUrl),
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

		if (probe.freshAttempt)
			await announceFreshAttempt(
				pm,
				workItem.id,
				{
					abandonedPullRequestUrl: probe.abandonedPullRequestUrl,
					baseBranch: project.baseBranch,
					branch: handle.branch,
					abandonedHead: abandonedHead?.sha,
				},
				{ taskId, runId },
			);

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
								// Asked for only while the branch is undecided (issue #1241).
								branchPattern: decidedBranch ? undefined : branchPattern,
								commitSubjectNaming: project,
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

		if (agentRunFailed(agent)) {
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
		const { branch, commitSubject } = decideDeliveryNaming({
			project,
			taskId,
			workItem,
			handoff,
			progress,
			branchPattern,
			decidedBranch,
			storedCommitSubject,
			abandoned: probe.abandoned,
		});
		progress.branch = branch;
		progress.commitSubject = commitSubject;
		recordReplacedHead(progress, branch, abandonedHead);
		saveDeliveryProgress(handle.path, progress);
		if (!handle.detached) await renameCheckedOutBranch(handle.path, branch);
		// A name decided before the agent ran was already stored, or reported at provisioning.
		if (branch !== decidedBranch) await onBranchNamed?.(branch);
		if (commitSubject !== storedCommitSubject) await onCommitSubjectNamed?.(commitSubject);
		if (!progress.commitSha) {
			progress.commitSha = await commitPreparedTree(
				handle.path,
				commitSubject,
				delivery.commitIdentity,
			);
			saveDeliveryProgress(handle.path, progress);
		}
		if (!progress.pushed) {
			await pushDeliveredBranch(
				delivery,
				handle.path,
				branch,
				progress.commitSha,
				progress.replacingSha,
			);
			progress.pushed = true;
			saveDeliveryProgress(handle.path, progress);
		}
		if (!progress.pullRequestUrl) {
			const pull =
				(await delivery.findPullRequest(branch)) ??
				(await delivery.createPullRequest({
					baseBranch: project.baseBranch,
					branch,
					// Titled by the commit subject once the repository states a pattern (issue
					// #1242) — Azure DevOps pre-fills a squash merge's message from the title,
					// so it has to carry the issue key as much as the commits do. A repository
					// stating none keeps the card's own title, exactly as before.
					title: project.commitSubjectPattern !== undefined ? commitSubject : workItem.title,
					body: composePullRequestBody({ description: handoff.summary, workItem, project }),
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
			prLinkDeliveryId(deliveryParts, prUrl, deliveredPullRequestUrl),
		);
		if (reviewEnabled) {
			await pm.moveWorkItem(workItem.id, NEXT_STATUS);
		}

		logger.info('Phase finished - Implementation', {
			taskId,
			workItemId: workItem.id,
			branch,
			prUrl,
			commentId,
			movedTo: reviewEnabled ? NEXT_STATUS : undefined,
		});

		return {
			prUrl,
			branch,
			commentId,
			movedTo: reviewEnabled ? NEXT_STATUS : undefined,
			agent,
		};
	} catch (error) {
		// `shouldDeferDeliveryFailure` (not a bare progress check): a refusal that is a
		// property of the prepared tree, or of a branch that cannot fast-forward,
		// settles terminally rather than spending the retry budget re-validating
		// identical state (#558, generalised by #839). Deferring would also preserve
		// the checkout, denying the branch to the phase that could unblock the PR. For
		// a divergence the delivered commit survives on the local branch ref after the
		// cleanup below, so nothing is lost to inspection.
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
