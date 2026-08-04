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
 * GitLab's "merge request"). Two adapters implement it —
 * `GitHubSCMIntegration.mergePullRequest`
 * (`src/integrations/scm/github/scm-integration.ts`) and
 * `BitbucketSCMIntegration.mergePullRequest`
 * (`src/integrations/scm/bitbucket/scm-integration.ts`) — and both do the same
 * three things: re-read current PR state, verify the approved head and approval
 * still hold, call the native direct merge endpoint, and map the response onto
 * {@link MergePullRequestOutcome}, with no dispatch or worker changes. Bitbucket's
 * endpoint takes no expected-head parameter, so that re-read is the whole of its
 * protection where GitHub also pins the merge to the approved SHA.
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
}

/** Injectable function type mirroring {@link ScmMergeProvider.mergePullRequest} for phase options. */
export type MergePullRequest = ScmMergeProvider['mergePullRequest'];
