/**
 * Persona credential resolution for GitLab — the GitLab counterpart of
 * `getPersonaToken`/`getPersonaTokenOrNull` (`src/config/provider.ts`) plus the
 * worker-local operator token (`src/config/operator-token.ts`), and a near-verbatim
 * port of `../bitbucket/credentials.ts`.
 *
 * The two personas resolve from *different* sources, exactly as GitHub's and
 * Bitbucket's do (issue #396): the **implementer** is the worker operator's own
 * token, a worker-local `SWARM_OPERATOR_GITLAB_TOKEN` env var that is never
 * persisted to `project_credentials`, never in `ProjectConfig` (so never in the
 * transport's non-secret project slice), and never sent over the transport; the
 * **reviewer** stays a project-scoped credential *reference* resolved from the
 * secret store. Two distinct accounts are what breaks the automation feedback
 * loop (ai/CODING_STANDARDS.md "Loop prevention").
 *
 * **Why this lives in the provider folder** rather than widening
 * `getPersonaToken` (`src/config/provider.ts`): that function's `implementer` branch
 * returns the *GitHub* operator token, and its `reviewer` branch resolves GitHub's own
 * per-provider reference. Widening it would either hand a GitLab call a GitHub
 * credential or force a GitHub-path change this file has no reason to make.
 *
 * The reviewer reference itself is **GitLab's own** since issue #628: it resolves
 * through the provider-parameterised `requireScmCredential` /
 * `resolveScmCredentialOrNull` seam, reading `credentials.scm.gitlab.reviewer` and
 * nothing else — so a project holding both GitLab's and GitHub's tokens keeps them
 * apart, and a project with only GitHub's fails here with GitLab's own error rather
 * than silently authenticating as GitHub's reviewer. (Before #628 the two references
 * were one shared provider-neutral pair, which is why this file's own doc used to say
 * no config-schema change was needed.) `project.repo` (`owner/repo`) doubles as
 * GitLab's `namespace/project` path.
 */

import { requireScmCredential, resolveScmCredentialOrNull } from '../../../config/provider.js';
import type { ProjectConfig } from '../../../config/schema.js';
import { optionalEnv } from '../../../lib/env.js';
import type { ScmPersona } from '../../../scm/types.js';

/** Env var name holding the worker-local operator GitLab token. */
export const OPERATOR_GITLAB_TOKEN_ENV = 'SWARM_OPERATOR_GITLAB_TOKEN';

/**
 * The operator's GitLab token, or `null` when the env var is unset or empty.
 * Any token form GitLab accepts in `PRIVATE-TOKEN` — personal, group, or project
 * access — works; the client does not branch on it (`./client.ts`).
 */
export function getOperatorGitLabTokenOrNull(): string | null {
	return optionalEnv(OPERATOR_GITLAB_TOKEN_ENV, '').trim() || null;
}

/** Resolve `persona`'s GitLab token for `project`, or `null` when none resolves. */
export async function getGitLabTokenOrNull(
	project: ProjectConfig,
	persona: ScmPersona,
): Promise<string | null> {
	if (persona === 'implementer') return getOperatorGitLabTokenOrNull();
	return resolveScmCredentialOrNull(project, 'gitlab', persona);
}

/**
 * Resolve `persona`'s GitLab token for `project`. Throws when none resolves — an
 * operation that needs a persona credential but has none configured is a
 * deployment error, not a soft "not found" (ai/CODING_STANDARDS.md "Error
 * handling"). The message names the persona's actual source: the operator env var for
 * the implementer, and — through the shared `requireScmCredential` — GitLab's own
 * reference plus its conventional config-apply key for the reviewer.
 */
export async function getGitLabToken(project: ProjectConfig, persona: ScmPersona): Promise<string> {
	if (persona === 'implementer') {
		const token = getOperatorGitLabTokenOrNull();
		if (token) return token;
		throw new Error(
			`No GitLab implementer token configured: set ${OPERATOR_GITLAB_TOKEN_ENV} on this host ` +
				"(the worker operator's own token; never stored in project_credentials)",
		);
	}
	return requireScmCredential(project, 'gitlab', persona);
}
