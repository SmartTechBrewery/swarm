/**
 * Worker-local operator GitHub token (`SWARM_OPERATOR_GH_TOKEN`).
 *
 * The implementer persona is no longer a project-scoped secret: it resolves to
 * the worker operator's *own* GitHub token, held only on the machine that runs
 * the implementer phases. This mirrors `SWARM_WORKER_CREDENTIAL`
 * (`src/worker/index.ts`): a plain worker-local env var that is **never
 * persisted** (never written to `project_credentials`), **never in
 * `ProjectConfig`** (so it is never in the transport `NonSecretProjectConfig`
 * slice, `src/config/project-config-slice.ts`), and **never sent over the
 * transport**.
 *
 * Sourcing the implementer half from the operator keeps the dual-persona
 * loop-prevention invariant on the current same-host deployment (PROJECT.md
 * §5.3): the PR is authored by the operator's account *and* that is the identity
 * loop-prevention resolves for the implementer (both come from this one token),
 * so the review author gate still recognises SWARM's PRs while the reviewer PAT
 * stays a distinct project-scoped identity. Federating the reviewer delivery
 * (Phase 2) and re-basing loop-prevention off persona-authorship (Phase 3) are
 * separate work items — see issue #396.
 *
 * Every process that runs an implementer phase, discovers a board, or resolves
 * persona identities (the host worker, the API server, the router) must have
 * this env var set; when it is missing, {@link getOperatorGitHubToken} throws an
 * actionable error naming it (loop prevention then fails closed — the review
 * author gate skips rather than misattributing).
 */

import { optionalEnv } from '../lib/env.js';

/** Env var name holding the worker-local operator GitHub token. */
export const OPERATOR_GH_TOKEN_ENV = 'SWARM_OPERATOR_GH_TOKEN';

/**
 * Resolve the operator's GitHub token, or `null` when `SWARM_OPERATOR_GH_TOKEN`
 * is unset or empty. The `null` case lets callers (loop-prevention identity
 * resolution) decide how to treat a missing operator token, mirroring
 * `getPersonaTokenOrNull`.
 */
export function getOperatorGitHubTokenOrNull(): string | null {
	return optionalEnv(OPERATOR_GH_TOKEN_ENV, '').trim() || null;
}

/**
 * Resolve the operator's GitHub token. Throws an actionable error naming the env
 * var when unset — an implementer operation with no operator token is a
 * deployment error, not a soft "not found" (ai/CODING_STANDARDS.md "Error
 * handling"), the same policy {@link getPersonaToken} uses for project tokens.
 */
export function getOperatorGitHubToken(): string {
	const token = getOperatorGitHubTokenOrNull();
	if (!token) {
		throw new Error(
			`No operator GitHub token configured: set ${OPERATOR_GH_TOKEN_ENV} on this host ` +
				"(it is the worker operator's own token used for implementer commit/push/create-PR, " +
				'mirroring SWARM_WORKER_CREDENTIAL — never persisted, never in project config)',
		);
	}
	return token;
}
