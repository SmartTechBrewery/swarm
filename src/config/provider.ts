/**
 * Config + credential resolution facade — mirrors Cascade's `src/config/provider.ts`,
 * trimmed to SWARM's single provider pair and single-user scope.
 *
 * This is the seam the router and SCM layers call: they ask for a project by
 * repo and for a persona's token, and never touch the DB repositories or the
 * `credentials`-reference indirection directly. Keeping that indirection here
 * means the rest of the code deals in `(project, persona)` and never in raw
 * env-var keys or ciphertext.
 */

import { resolveProjectCredential } from '../db/repositories/credentialsRepository.js';
import {
	findProjectByBoardFromDb,
	findProjectByRepoFromDb,
} from '../db/repositories/projectsRepository.js';
import { requireProjectPMCredentialRole } from '../integrations/pm/registry.js';
import type { ScmPersona } from '../scm/types.js';
import { getOperatorGitHubTokenOrNull, OPERATOR_GH_TOKEN_ENV } from './operator-token.js';
import type { ProjectConfig } from './schema.js';

/**
 * Resolve the SWARM project that owns a GitHub repository (`owner/repo`).
 * Returns `undefined` when the repo isn't tracked — the router treats that as
 * "not ours", not an error.
 */
export async function findProjectByRepo(repo: string): Promise<ProjectConfig | undefined> {
	return findProjectByRepoFromDb(repo);
}

/**
 * Resolve the SWARM project that owns a GitHub Projects (v2) board, by its node
 * ID (`pm.projectId`). The PM-side counterpart of
 * {@link findProjectByRepo}: a `projects_v2_item` webhook is a board event with
 * no repo, so the board node ID is what identifies the project. Returns
 * `undefined` when the board isn't tracked — "not ours", not an error.
 */
export async function findProjectByBoard(
	projectNodeId: string,
): Promise<ProjectConfig | undefined> {
	return findProjectByBoardFromDb(projectNodeId);
}

/**
 * Resolve a persona's GitHub token for a project, or `null` if it resolves to no
 * token.
 *
 * The two personas resolve from *different* sources (issue #396): the
 * `implementer` is the worker operator's own token, a worker-local env var
 * (`SWARM_OPERATOR_GH_TOKEN`, `./operator-token.ts`) that is never persisted and
 * never in the project config; the `reviewer` stays a project-scoped credential
 * *reference* (an env-var key in `project.credentials`) resolved from the secret
 * store. The implementer/reviewer split is the whole point (ai/CODING_STANDARDS.md
 * "Loop prevention"): the two personas must resolve to two distinct identities so
 * neither reacts to its own output — here the author (operator) ≠ reviewer.
 */
export async function getPersonaTokenOrNull(
	project: ProjectConfig,
	persona: ScmPersona,
): Promise<string | null> {
	if (persona === 'implementer') return getOperatorGitHubTokenOrNull();
	const envVarKey = project.credentials[persona];
	return resolveProjectCredential(project.id, envVarKey);
}

/**
 * Resolve a project's GitHub webhook HMAC secret, or `null` if the reference
 * resolves to no stored credential. Like the persona tokens, the config holds
 * only the *reference* (an env-var key) in its `credentials` block; this maps it
 * to the stored secret. Returning `null` (rather than throwing) lets the router
 * decide how to treat a project with no secret configured.
 */
export async function getWebhookSecretOrNull(project: ProjectConfig): Promise<string | null> {
	return resolveProjectCredential(project.id, project.credentials.webhookSecret);
}

/**
 * Resolve one of a project's PM-provider credentials by the *role* its provider
 * declares (`PMProviderManifest.credentialRoles`, issue #497), or `null` when the
 * role resolves to nothing. The PM twin of {@link getPersonaTokenOrNull}: shared
 * code asks for `(project, role)` and never learns which reference, env var, or
 * store row it came from.
 *
 * Resolution order, most specific first:
 *
 * 1. the reference the project configured for the role (`credentials.pm[role]`),
 *    through the secret store;
 * 2. the shared `credentials` reference the role declares it inherits
 *    (`inheritsSharedCredential`) — also a store reference, so it belongs above the
 *    host env; this is what keeps GitHub Projects' webhook secret *exactly* the
 *    project's existing SCM webhook secret;
 * 3. the role's `envVarKey` in this host's environment — only when the project
 *    explicitly configured `credentials.pm[role]`, as the escape hatch for a host
 *    that exports that opted-in secret directly rather than storing it;
 * 4. `null`.
 *
 * A configured reference that resolves to nothing falls through rather than
 * short-circuiting: `swarm config apply` warns-and-skips a reference whose env var
 * was unset, so "reference configured, store row absent, env var present on the
 * worker" is a legitimate state and resolving it is what an operator expects. A
 * role with no configured PM reference never reads a host environment variable,
 * preserving the fail-closed behavior of inherited webhook credentials.
 *
 * Throws when the role isn't one the project's provider declares — asking for a
 * credential a provider has no notion of is a wiring bug, not a lookup miss
 * (ai/CODING_STANDARDS.md "Error handling").
 */
export async function resolvePmCredential(
	project: ProjectConfig,
	role: string,
): Promise<string | null> {
	const spec = requireProjectPMCredentialRole(project, role);

	const configured = project.credentials.pm?.[role];
	if (configured) {
		const stored = await resolveProjectCredential(project.id, configured);
		if (stored) return stored;
	}

	if (spec.inheritsSharedCredential) {
		const inherited = await resolveProjectCredential(
			project.id,
			project.credentials[spec.inheritsSharedCredential],
		);
		if (inherited) return inherited;
	}

	return configured ? process.env[spec.envVarKey] || null : null;
}

/**
 * Resolve a PM-provider credential, throwing when it resolves to nothing — the
 * `require`-shaped twin of {@link resolvePmCredential} for the provider operations
 * that cannot run without it, worded like {@link getPersonaToken} so the message
 * names both the role and the ways it can be supplied.
 */
export async function requirePmCredential(project: ProjectConfig, role: string): Promise<string> {
	const secret = await resolvePmCredential(project, role);
	if (!secret) {
		const spec = requireProjectPMCredentialRole(project, role);
		throw new Error(
			`No PM ${spec.label} (role '${role}') configured for project '${project.id}' ` +
				`(set credentials.pm.${role} to a stored reference; ${spec.envVarKey} is its conventional config-apply key)`,
		);
	}
	return secret;
}

/**
 * Resolve a persona's GitHub token for a project. Throws if it resolves to no
 * token — an operation that needs a persona token but has none configured is a
 * deployment error, not a soft "not found" (ai/CODING_STANDARDS.md "Error
 * handling"). The message points at the persona's actual source: the operator
 * env var for the implementer, the project credential reference for the reviewer.
 */
export async function getPersonaToken(
	project: ProjectConfig,
	persona: ScmPersona,
): Promise<string> {
	const token = await getPersonaTokenOrNull(project, persona);
	if (!token) {
		if (persona === 'implementer') {
			throw new Error(
				`No GitHub implementer token configured: set ${OPERATOR_GH_TOKEN_ENV} on this host ` +
					"(the worker operator's own token; never stored in project_credentials)",
			);
		}
		throw new Error(
			`No GitHub ${persona} token configured for project '${project.id}' ` +
				`(credential reference '${project.credentials[persona]}' not found in project_credentials)`,
		);
	}
	return token;
}
