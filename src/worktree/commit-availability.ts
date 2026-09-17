/**
 * The "this machine cannot obtain the commit" failure (issue #1018).
 *
 * A phase that provisions its checkout **detached at a specific commit** — today
 * only Review (`src/pipeline/review.ts`) — can start only if that commit is in the
 * worker's own clone. The single thing that puts it there is `provision`'s
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
 */

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
	) {
		super(commitUnavailableMessage(commit, detail));
		this.name = 'CommitUnavailableError';
	}
}
