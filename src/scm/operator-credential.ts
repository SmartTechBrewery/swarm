/**
 * The control plane's **implementer** credential (issue #1249): never one of its
 * own, only the stored credential of the operator a write is made for, bound to the
 * async context for that write alone.
 *
 * The control plane used to resolve the implementer persona from one
 * installation-wide env var per provider (`SWARM_OPERATOR_GH_TOKEN` and its
 * Bitbucket, GitLab and Azure DevOps siblings) — a personal access token of
 * *somebody*, written into the server's environment, which on a multi-operator
 * installation was the wrong person for most pull requests. Those variables are
 * retired. What the router does instead:
 *
 *  - **reads** run as the project's reviewer credential;
 *  - **comments** the router posts (give-up, base-blocked, merge-refusal,
 *    phase-failure) are the reviewer's too — SWARM's own voice on the pull
 *    request, and a credential every project already holds;
 *  - **writes made on behalf of a pull request's author** — merge, branch update,
 *    check re-run — run as the operator whose worker produced that pull request,
 *    with that operator's stored credential (`runAsPullRequestOperator`,
 *    `src/identity/pull-request-operator.ts`), which binds it here.
 *
 * So every provider's `implementer` resolution reads {@link scopedOperatorCredential}
 * and nothing else. Outside a scope there is no implementer credential at all, and
 * {@link requireScopedOperatorCredential} says so without suggesting an env var.
 *
 * A scope rather than an argument, on ai/CODING_STANDARDS.md's "Scope credentials
 * with `AsyncLocalStorage`": the credential crosses the merge capability, the
 * provider and its client, and must not appear in any of their signatures. It is
 * the same discipline the provider clients already keep one layer down
 * (`withGitHubToken`, `withAzureDevOpsToken`, …).
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const operatorCredentialStorage = new AsyncLocalStorage<string>();

/** Run `fn` with `credential` as the implementer persona's credential. */
export function withOperatorCredential<T>(credential: string, fn: () => Promise<T>): Promise<T> {
	return operatorCredentialStorage.run(credential, fn);
}

/** The operator credential bound to the current async context, or `null` outside a scope. */
export function scopedOperatorCredential(): string | null {
	return operatorCredentialStorage.getStore() ?? null;
}

/**
 * The bound operator credential, throwing when none is — the `require`-shaped twin
 * every provider's implementer branch uses, so the message is worded once.
 * `providerLabel` names the provider in its own words ("Azure DevOps").
 */
export function requireScopedOperatorCredential(providerLabel: string): string {
	const credential = scopedOperatorCredential();
	if (credential) return credential;
	throw new Error(
		`No ${providerLabel} implementer credential is in scope: the control plane holds no ` +
			"implementer credential of its own — a write made for a pull request's author runs " +
			'as the stored credential of the operator whose worker produced it',
	);
}
