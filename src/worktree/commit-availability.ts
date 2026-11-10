/**
 * The "this machine cannot obtain the commit" failure (issue #1018), and its two
 * branch-shaped variants (issue #1401).
 *
 * A phase that provisions its checkout **detached at a specific commit** — Review
 * (`src/pipeline/review.ts`) — can start only if that commit is in the worker's own
 * clone. The single thing that puts it there is `provision`'s
 * `git fetch origin`, which is deliberately best-effort, so a worker whose fetch is
 * not working provisioned from stale refs and died on git's own
 * `fatal: invalid reference: <sha>`. That message names the symptom: it sends an
 * operator to check the pull request, the branch and the SHA, all of which are fine
 * on the remote, while the fetch that was supposed to supply the object failed
 * minutes earlier in a `logger.warn` on a machine they may not even have access to.
 *
 * This error is the honest replacement. It is raised only after the provisioner has
 * *tried* to get the commit — the ordinary fetch, then a targeted
 * `git fetch origin <commit>` — so by the time it is thrown, "this clone does not
 * have it and could not get it" is a verified statement rather than an inference
 * from a checkout that happened to fail. It carries both fetch failures verbatim,
 * because that is the cause an operator otherwise never sees.
 *
 * It is separate from {@link BlockedRecoveryError} (`./reclaim.ts`) on purpose:
 * that one means "this checkout holds work SWARM must not discard" and is terminal
 * by design, whereas this one is a statement about **one machine**, not about the
 * run — another enrolled worker may well hold the commit. So it defers
 * (`commit-unavailable`, `src/harness/agent-failure.ts`) and the next attempt
 * prefers a machine that has not already failed to obtain it
 * (`src/worker/eligibility-gate.ts`).
 *
 * The phases that check out the pull request's **branch** — Resolve-conflicts,
 * Respond-to-review, Respond-to-CI — depend on the same best-effort fetch, and fail
 * on it in two shapes (issue #1401). Either provisioning cannot resolve the branch
 * at all ({@link BranchUnavailableError}), or a stale local copy of it checks out
 * and the agent's own mandated sync with origin fails, so it stops without a
 * hand-off ({@link BranchSyncUnavailableError}). Both are subclasses of
 * {@link CommitUnavailableError}, so every classifier that keys on it — the
 * deferral, the sticky `runs.recovery.commitUnavailableWorkerIds`, the gate's
 * preference for another machine — applies to them unchanged. Only the message
 * differs, because a branch is not a commit and the fetch is not always the last
 * thing that failed.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Why the commit is missing, as far as the provisioner could establish. */
export interface CommitUnavailableDetail {
	/** The repository checkout that was asked for the commit. */
	repoRoot: string;
	/** The task whose worktree was being provisioned. */
	taskId: string;
	/**
	 * The failure of the provision-time `git fetch origin`, verbatim, when it failed.
	 * Absent when the fetch succeeded (and still did not supply the commit) or was
	 * skipped by the caller.
	 */
	fetchError?: string;
	/** The failure of the targeted `git fetch origin <commit>`, verbatim, when it failed. */
	targetedFetchError?: string;
	/** Whether a `git fetch origin` ran at all for this provision. */
	fetched: boolean;
}

/**
 * The operator-facing text. It states, in order: what is missing, where it is
 * missing from, what was tried to get it, and why each attempt did not supply it —
 * so the reader is never left to guess that a fetch was involved at all.
 */
function commitUnavailableMessage(commit: string, detail: CommitUnavailableDetail): string {
	const attempts: string[] = [];
	if (!detail.fetched) {
		attempts.push('this provision was asked to skip `git fetch origin`');
	} else if (detail.fetchError) {
		attempts.push(`\`git fetch origin\` failed: ${detail.fetchError}`);
	} else {
		attempts.push('`git fetch origin` succeeded but did not bring the commit in');
	}
	attempts.push(
		detail.targetedFetchError
			? `fetching the commit directly (\`git fetch origin ${commit}\`) failed: ${detail.targetedFetchError}`
			: `fetching the commit directly (\`git fetch origin ${commit}\`) reported success but the commit is still absent`,
	);
	return (
		`Commit ${commit} is not in this worker's clone at ${detail.repoRoot}, so the checkout for ` +
		`task '${detail.taskId}' could not be created at it — ${attempts.join('; ')}. ` +
		'The commit is on the remote whenever another machine produced it, so this is a fact ' +
		"about this worker's clone rather than about the pull request, the branch or the SHA: " +
		'SWARM retries on another enrolled worker when one is eligible. If none is, fix this ' +
		"machine's access to the remote (network, credentials, `git fetch origin` by hand)."
	);
}

/**
 * Thrown by worktree provisioning when a detached-at-commit checkout cannot be
 * created because the commit is absent from this worker's clone and could not be
 * fetched. See the module header for why it is not a {@link BlockedRecoveryError}.
 */
export class CommitUnavailableError extends Error {
	constructor(
		readonly commit: string,
		readonly detail: CommitUnavailableDetail,
		message: string = commitUnavailableMessage(commit, detail),
	) {
		super(message);
		this.name = 'CommitUnavailableError';
	}
}

/** What this worker established about a pull request branch it could not get from origin. */
export interface BranchUnavailableDetail {
	/** The repository checkout that was asked for the branch. */
	repoRoot: string;
	/** The task whose worktree was being provisioned. */
	taskId: string;
	/** The failure of the provision-time `git fetch origin`, verbatim. */
	fetchError: string;
}

/** The sentence every branch variant ends with: where the fault lies, and what happens next. */
const BRANCH_REMEDY =
	"This is a fact about this worker's access to the remote rather than about the pull " +
	'request or its branch: SWARM retries on another enrolled worker when one is eligible. ' +
	"If none is, fix this machine's access to the remote (network, credentials, SSH host " +
	'alias, `git fetch origin` by hand).';

/**
 * Thrown by worktree provisioning when an existing branch (`createBranch: false`)
 * cannot be checked out because this clone has neither a local nor a
 * remote-tracking ref for it, after the provision-time `git fetch origin` failed
 * (issue #1401, shape 1). The branch is on the remote — the pull request names it —
 * so the failure belongs to this machine, exactly as a missing commit does.
 */
export class BranchUnavailableError extends CommitUnavailableError {
	constructor(
		readonly branch: string,
		readonly branchDetail: BranchUnavailableDetail & { checkoutError: string },
	) {
		super(
			branch,
			{
				repoRoot: branchDetail.repoRoot,
				taskId: branchDetail.taskId,
				fetchError: branchDetail.fetchError,
				fetched: true,
			},
			`Branch '${branch}' is not in this worker's clone at ${branchDetail.repoRoot}, so the ` +
				`checkout for task '${branchDetail.taskId}' could not be created — \`git fetch origin\` ` +
				`failed: ${branchDetail.fetchError}; the checkout then failed: ${branchDetail.checkoutError}. ` +
				BRANCH_REMEDY,
		);
		this.name = 'BranchUnavailableError';
	}
}

/**
 * Thrown by a branch phase whose agent stopped without writing its hand-off after
 * this provision's `git fetch origin` had failed (issue #1401, shape 2). The checkout
 * itself succeeded from stale local refs, but the agent's prescribed first step — a
 * `git pull --ff-only origin <branch>` (`src/pipeline/prompts/respond-to-review.ts`,
 * `respond-to-ci.ts`) — talks to the same remote, so it failed too and the agent
 * stopped as told. Without this, the run read as a generic missing hand-off.
 */
export class BranchSyncUnavailableError extends CommitUnavailableError {
	constructor(
		readonly branch: string,
		readonly branchDetail: BranchUnavailableDetail & { handoffFilename: string },
	) {
		super(
			branch,
			{
				repoRoot: branchDetail.repoRoot,
				taskId: branchDetail.taskId,
				fetchError: branchDetail.fetchError,
				fetched: true,
			},
			`This worker could not sync branch '${branch}' with origin for task ` +
				`'${branchDetail.taskId}' — \`git fetch origin\` in ${branchDetail.repoRoot} failed: ` +
				`${branchDetail.fetchError}. The agent's own sync with origin depends on the same ` +
				`remote, and it stopped without writing ${branchDetail.handoffFilename}. ` +
				BRANCH_REMEDY,
		);
		this.name = 'BranchSyncUnavailableError';
	}
}

/**
 * Raise {@link BranchSyncUnavailableError} when a branch phase's agent wrote no
 * hand-off and this run's provision-time fetch had failed; otherwise do nothing, so
 * the caller's own `readHandoff` reports whatever is actually wrong.
 *
 * Gated on the provision's own fetch failure rather than on the agent's transcript:
 * the fetch is the verified, CLI-independent fact, and a worker that cannot fetch
 * cannot pull or push either — so a missing hand-off on that worker is the remote,
 * not the task. A fetch that succeeded leaves the missing hand-off a genuine one.
 */
export function assertBranchSyncReachedOrigin(params: {
	worktreePath: string;
	handoffFilename: string;
	branch: string;
	taskId: string;
	repoRoot: string;
	fetchError: string | undefined;
}): void {
	const { fetchError } = params;
	if (!fetchError || existsSync(join(params.worktreePath, params.handoffFilename))) return;
	throw new BranchSyncUnavailableError(params.branch, {
		repoRoot: params.repoRoot,
		taskId: params.taskId,
		fetchError,
		handoffFilename: params.handoffFilename,
	});
}
