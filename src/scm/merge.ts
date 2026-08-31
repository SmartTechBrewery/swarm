/**
 * Provider-neutral merge capability (issue #253; direct-merge-only per issue
 * #292). The adapter performs the provider's *direct* PR/MR merge operation
 * under the project's implementer credential — never the provider's own merge
 * automation (GitHub's native auto-merge is unavailable on many private
 * repositories and has no portable equivalent in Bitbucket/GitLab, so SWARM
 * neither requests nor relies on it). Orchestration — when to ask, how to
 * retry a transient refusal — lives in the durable merge dispatch
 * (`src/worker/merge-automation.ts`), which re-invokes this capability with
 * the approved head SHA on every attempt.
 *
 * Mirrors `src/scm/delivery.ts`'s `ScmDeliveryProvider` seam: dispatch/worker
 * code depends on {@link ScmMergeProvider} only, never on a provider's own
 * client or vocabulary ("pull request" here, not GitHub's `pulls.merge` or
 * GitLab's "merge request"). Three adapters implement it —
 * `GitHubSCMIntegration.mergePullRequest`
 * (`src/integrations/scm/github/scm-integration.ts`) and
 * `BitbucketSCMIntegration.mergePullRequest`
 * (`src/integrations/scm/bitbucket/scm-integration.ts`), and
 * `GitLabSCMIntegration.mergePullRequest`
 * (`src/integrations/scm/gitlab/scm-integration.ts`) — and all re-read current PR
 * state, verify the approved head and approval still hold, call the native direct
 * merge endpoint, and map the response onto {@link MergePullRequestOutcome}, with
 * no dispatch or worker changes. Bitbucket's endpoint takes no expected-head
 * parameter, so that re-read is the whole of its protection; GitHub and GitLab
 * also pin the merge to the approved SHA.
 *
 * **Base freshness, and the one place the reviewed-commit invariant is relaxed
 * (issue #874).** A head that passed its checks against an older base proves
 * nothing about the tree it would land on, which is how two independently green
 * pull requests combine into a red base branch. So the merge capability answers
 * {@link MergePullRequestOutcome} `stale-base` for a head that is behind its
 * base, and the dispatch answers *that* with
 * {@link ScmMergeProvider.updatePullRequestBranch}, waits for the fresh CI on
 * the head it produced, and merges only then.
 *
 * Carrying the approval across that new commit is deliberate, and it is the only
 * relaxation of "merge exactly the commit that was reviewed". Three things make
 * it sound, and all three have to hold:
 *
 *  1. the new commit is the reviewed diff plus the provider's **own** merge of
 *     the base — no human authored anything in it, and the reviewed diff is
 *     unchanged, so re-running the *review* would re-read the same code;
 *  2. what the update invalidates is the *verification*, not the review, and the
 *     dispatch replaces exactly that by waiting for the new head's CI;
 *  3. the adapter *proves* property 1 of the head it reports, rather than
 *     inferring it from the head having changed. Pinning the request with
 *     `expectedHeadSha` is not enough on its own: the request is accepted
 *     asynchronously, so the head observed afterwards is not necessarily the
 *     commit the request produced — anyone who may push to the branch can land
 *     one in that window. So a provider reports `updated` only for a commit it
 *     has attributed to its own update of the reviewed head onto the base, and
 *     reports {@link UpdatePullRequestBranchOutcome} `head-moved` for anything
 *     else, which needs a fresh review exactly as a pushed head always did.
 */

import type { ProjectConfig } from '../config/schema.js';

/**
 * Terminal outcome of one merge attempt. Every non-`merged` status is a
 * normal, visible refusal — never a thrown error — so a merge attempt can
 * never retroactively fail an already-submitted, completed Review.
 *
 * - `merged` — the request is merged now, or was already merged (a retry
 *   after a prior success is idempotent).
 * - `not-ready` — a transient readiness condition blocks merging right now:
 *   unsatisfied/pending required checks, unresolved conflicts, or the
 *   provider still converging on required-review state right after a
 *   submission. Expected to clear on its own; the merge dispatch retries it
 *   on a bounded schedule.
 * - `not-eligible` — the approval this attempt was requested for no longer
 *   holds: the head moved (new commits pushed since the review), the PR was
 *   closed or converted back to a draft, or the approving review was
 *   overridden (changes requested since). Distinct from `not-ready`: this
 *   will not clear on its own — it needs a fresh review before merge
 *   automation can proceed again.
 * - `policy-blocked` — a repository policy (branch protection, a ruleset, a
 *   permission restriction) refuses the merge outright; it will not clear on
 *   its own and needs a human to change the policy or merge manually.
 * - `unsupported` — this adapter has no way to perform the requested merge —
 *   a repository configuration this adapter doesn't implement (e.g. a
 *   required merge queue), or a provider that hasn't implemented the
 *   capability at all.
 * - `stale-base` — the approval still holds and the request is otherwise
 *   ready, but its head has never been built against the base it would land
 *   on: the base has advanced since these checks passed (issue #874). Merging
 *   would land a commit whose CI verified a tree that no longer exists, which
 *   is how two independently green pull requests combine into a red base
 *   branch. Not a refusal the *provider* can clear — the head has to be
 *   brought up to date and re-verified first, which is the merge dispatch's
 *   job ({@link ScmMergeProvider.updatePullRequestBranch}).
 * - `provider-error` — an unexpected API, authentication, rate-limit, or
 *   transport failure. Distinct from every refusal above: it reflects the
 *   provider being unreachable/misbehaving, not the request's own readiness
 *   or a deliberate policy.
 */
export type MergePullRequestOutcome =
	| { status: 'merged'; message: string; sha?: string }
	| { status: 'not-ready'; message: string }
	| { status: 'not-eligible'; message: string }
	| { status: 'policy-blocked'; message: string }
	| { status: 'unsupported'; message: string }
	| { status: 'stale-base'; message: string }
	| { status: 'provider-error'; message: string };

/**
 * Terminal outcome of one attempt to bring a pull request's head up to date
 * with its base. Like {@link MergePullRequestOutcome}, every status is a normal
 * answer rather than a thrown error.
 *
 * - `updated` — the provider produced a **new head commit** that merges the
 *   current base into the pull request's branch. `headSha` is that commit, read
 *   back from the provider rather than guessed, because it is what the dispatch
 *   re-pins its approval and its merge to — and *attributed* to this very
 *   update before it is reported, because re-pinning an approval is the one
 *   thing this outcome authorizes.
 * - `up-to-date` — there was nothing to do: the head already contains the base.
 *   A race, in practice — something else advanced the branch between the merge
 *   attempt that reported `stale-base` and this call.
 * - `head-moved` — the branch's head is no longer the reviewed commit, and what
 *   it *is* cannot be attributed to this update: somebody pushed to the branch,
 *   or the provider offers no way to prove the commit it produced. Terminal, and
 *   deliberately not `updated`: the approval must not travel onto a commit the
 *   provider did not build from the reviewed diff, so this needs a fresh review
 *   exactly as any other pushed head does.
 * - `conflict` — the base cannot be merged into the head without human
 *   intervention. Terminal here: resolving conflicts is the Resolve-conflicts
 *   phase's job, not merge automation's.
 * - `unsupported` — this provider exposes no way to update a pull request's
 *   branch. A *declared* answer, not a stub: the capability genuinely does not
 *   exist in the provider's API, so the dispatch refuses the merge visibly
 *   instead of merging on stale evidence.
 * - `provider-error` — an unexpected API, authentication, rate-limit, or
 *   transport failure, exactly as on the merge side.
 */
export type UpdatePullRequestBranchOutcome =
	| { status: 'updated'; headSha: string }
	| { status: 'up-to-date' }
	| { status: 'head-moved'; message: string }
	| { status: 'conflict'; message: string }
	| { status: 'unsupported'; message: string }
	| { status: 'provider-error'; message: string };

/**
 * Provider-neutral capability: merge an approved, ready pull/merge request.
 * `prNumber` is deliberately generic (GitLab calls it an "IID"; GitHub a PR
 * number) — the concrete adapter resolves whatever identifier its own API
 * needs from `project` + `prNumber`. `approvedHeadSha` is the commit the
 * approval actually covers (the reviewed head) — every call, including a
 * durable retry long after the original approval, re-checks the PR's
 * *current* head against it so a merge never lands a commit nobody reviewed.
 */
export interface ScmMergeProvider {
	mergePullRequest(
		project: ProjectConfig,
		prNumber: number,
		approvedHeadSha: string,
	): Promise<MergePullRequestOutcome>;

	/**
	 * Provider-neutral capability: merge the current base into a pull request's
	 * head, producing a new head commit whose CI builds the tree the request
	 * would actually land on (issue #874). The answer to a `stale-base` merge
	 * outcome, and the *only* place SWARM's "merge exactly the commit that was
	 * reviewed" invariant is relaxed — see this module's header for why that is
	 * sound, and `src/worker/merge-automation.ts` for the bound on how often it
	 * may happen.
	 *
	 * `expectedHeadSha` is what keeps the relaxation honest, on both sides of the
	 * call: the provider must refuse the update when the pull request's head is
	 * not that commit, **and** must report `updated` only for a resulting head it
	 * can attribute to that update — a head somebody pushed in the meantime is
	 * `head-moved`, never `updated`. So the dispatch can only ever carry the
	 * approval across a commit the provider built from the reviewed one.
	 *
	 * Never throws — every refusal, including "this provider cannot do this at
	 * all", comes back as an {@link UpdatePullRequestBranchOutcome}.
	 */
	updatePullRequestBranch(
		project: ProjectConfig,
		prNumber: number,
		expectedHeadSha: string,
	): Promise<UpdatePullRequestBranchOutcome>;
}

/** Injectable function type mirroring {@link ScmMergeProvider.mergePullRequest} for phase options. */
export type MergePullRequest = ScmMergeProvider['mergePullRequest'];

/** Injectable function type mirroring {@link ScmMergeProvider.updatePullRequestBranch}. */
export type UpdatePullRequestBranch = ScmMergeProvider['updatePullRequestBranch'];
