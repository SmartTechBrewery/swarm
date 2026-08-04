/**
 * Persona credential resolution for Bitbucket — the Bitbucket counterpart of
 * `getPersonaToken`/`getPersonaTokenOrNull` (`src/config/provider.ts`) plus the
 * worker-local operator token (`src/config/operator-token.ts`).
 *
 * The two personas resolve from *different* sources, exactly as GitHub's do
 * (issue #396): the **implementer** is the worker operator's own credential, a
 * worker-local `SWARM_OPERATOR_BITBUCKET_TOKEN` env var that is never persisted
 * to `project_credentials`, never in `ProjectConfig` (so never in the transport's
 * non-secret project slice), and never sent over the transport; the **reviewer**
 * stays a project-scoped credential *reference* resolved from the secret store.
 * Two distinct accounts are what breaks the automation feedback loop
 * (ai/CODING_STANDARDS.md "Loop prevention").
 *
 * **Why this lives in the provider folder** rather than widening
 * `src/config/provider.ts`: that function's `implementer` branch returns the
 * *GitHub* operator token. Widening it would either hand a Bitbucket call a
 * GitHub credential or force a GitHub-path change this phase has no reason to
 * make. The `reviewer` / `webhookSecret` references it reads are already
 * provider-neutral (issue #290 — `SCM_TOKEN_REVIEWER` / `SCM_WEBHOOK_SECRET`), so
 * no config-schema change is needed; `project.repo` (`owner/repo`) doubles as
 * Bitbucket's `workspace/repo_slug`.
 */

import type { ProjectConfig } from '../../../config/schema.js';
import { resolveProjectCredential } from '../../../db/repositories/credentialsRepository.js';
import { optionalEnv } from '../../../lib/env.js';
import type { ScmPersona } from '../../../scm/types.js';

/** Env var name holding the worker-local operator Bitbucket credential. */
export const OPERATOR_BITBUCKET_TOKEN_ENV = 'SWARM_OPERATOR_BITBUCKET_TOKEN';

/**
 * The operator's Bitbucket credential, or `null` when the env var is unset or
 * empty. Either an access token or a `username:app_password` pair — the client
 * picks the auth scheme from the form (`./client.ts`).
 */
export function getOperatorBitbucketCredentialOrNull(): string | null {
	return optionalEnv(OPERATOR_BITBUCKET_TOKEN_ENV, '').trim() || null;
}

/** Resolve `persona`'s Bitbucket credential for `project`, or `null` when none resolves. */
export async function getBitbucketCredentialOrNull(
	project: ProjectConfig,
	persona: ScmPersona,
): Promise<string | null> {
	if (persona === 'implementer') return getOperatorBitbucketCredentialOrNull();
	return resolveProjectCredential(project.id, project.credentials[persona]);
}

/**
 * Resolve `persona`'s Bitbucket credential for `project`. Throws when none
 * resolves — an operation that needs a persona credential but has none configured
 * is a deployment error, not a soft "not found" (ai/CODING_STANDARDS.md "Error
 * handling"). The message names the persona's actual source, mirroring
 * `getPersonaToken`.
 */
export async function getBitbucketCredential(
	project: ProjectConfig,
	persona: ScmPersona,
): Promise<string> {
	const credential = await getBitbucketCredentialOrNull(project, persona);
	if (!credential) {
		if (persona === 'implementer') {
			throw new Error(
				`No Bitbucket implementer credential configured: set ${OPERATOR_BITBUCKET_TOKEN_ENV} on this host ` +
					"(the worker operator's own credential; never stored in project_credentials)",
			);
		}
		throw new Error(
			`No Bitbucket ${persona} credential configured for project '${project.id}' ` +
				`(credential reference '${project.credentials[persona]}' not found in project_credentials)`,
		);
	}
	return credential;
}
