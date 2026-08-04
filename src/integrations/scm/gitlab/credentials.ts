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
 * `src/config/provider.ts`: that function's `implementer` branch returns the
 * *GitHub* operator token. Widening it would either hand a GitLab call a GitHub
 * credential or force a GitHub-path change this phase has no reason to make. The
 * `reviewer` / `webhookSecret` references it reads are already provider-neutral
 * (issue #290 — `SCM_TOKEN_REVIEWER` / `SCM_WEBHOOK_SECRET`), so no config-schema
 * change is needed; `project.repo` (`owner/repo`) doubles as GitLab's
 * `namespace/project` path.
 */

import type { ProjectConfig } from '../../../config/schema.js';
import { resolveProjectCredential } from '../../../db/repositories/credentialsRepository.js';
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
	return resolveProjectCredential(project.id, project.credentials[persona]);
}

/**
 * Resolve `persona`'s GitLab token for `project`. Throws when none resolves — an
 * operation that needs a persona credential but has none configured is a
 * deployment error, not a soft "not found" (ai/CODING_STANDARDS.md "Error
 * handling"). The message names the persona's actual source, mirroring
 * `getPersonaToken`.
 */
export async function getGitLabToken(project: ProjectConfig, persona: ScmPersona): Promise<string> {
	const token = await getGitLabTokenOrNull(project, persona);
	if (!token) {
		if (persona === 'implementer') {
			throw new Error(
				`No GitLab implementer token configured: set ${OPERATOR_GITLAB_TOKEN_ENV} on this host ` +
					"(the worker operator's own token; never stored in project_credentials)",
			);
		}
		throw new Error(
			`No GitLab ${persona} token configured for project '${project.id}' ` +
				`(credential reference '${project.credentials[persona]}' not found in project_credentials)`,
		);
	}
	return token;
}
