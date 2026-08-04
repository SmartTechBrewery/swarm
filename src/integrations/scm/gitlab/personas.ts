/**
 * Dual-persona identities for GitLab — the GitLab twin of `../bitbucket/personas.ts`
 * and `../github/personas.ts`, and the same invariant: a persona must never react
 * to its own output, which is enforced by mapping an inbound event's actor to a
 * persona (ai/CODING_STANDARDS.md "Loop prevention").
 *
 * The persona role model itself is provider-neutral (`ScmPersona`,
 * `src/scm/types.ts`) — there is deliberately no `GitLabPersona` alias to
 * redeclare it. The agent-type → persona mapping is neutral too and stays where
 * it is (`getPersonaForAgentType`, `../github/personas.ts`); nothing about it is
 * GitHub-specific.
 */

import type { ProjectConfig } from '../../../config/schema.js';
import { logger } from '../../../lib/logger.js';
import type { ScmPersona, ScmPersonaIdentities } from '../../../scm/types.js';
import { getGitLabUserForToken } from './client.js';
import { getGitLabTokenOrNull } from './credentials.js';

const PERSONA_CACHE_TTL_MS = 60_000; // 60s — matches the GitHub and Bitbucket caches.

interface CacheEntry {
	value: ScmPersonaIdentities;
	expiresAt: number;
}

// Per-project TTL cache. Resolving an identity costs a credential lookup plus a
// GitLab round-trip; a burst of webhooks for one project would otherwise repeat
// that per event. Errors are thrown, never cached, so a transient credential
// failure isn't pinned for the TTL window.
const personaIdentityCache = new Map<string, CacheEntry>();

/**
 * Resolve both persona usernames for a project, cached per project with a 60s TTL.
 * Throws when either can't be resolved: without both, loop prevention can't tell
 * SWARM's own events from a human's, so it fails closed rather than proceeding.
 */
export async function resolveGitLabPersonaIdentities(
	project: ProjectConfig,
): Promise<ScmPersonaIdentities> {
	const cached = personaIdentityCache.get(project.id);
	if (cached && Date.now() < cached.expiresAt) return cached.value;

	const [implementerToken, reviewerToken] = await Promise.all([
		getGitLabTokenOrNull(project, 'implementer'),
		getGitLabTokenOrNull(project, 'reviewer'),
	]);

	const [implementer, reviewer] = await Promise.all([
		getGitLabUserForToken(implementerToken),
		getGitLabUserForToken(reviewerToken),
	]);

	if (!implementer) {
		throw new Error(
			`Failed to resolve GitLab identity for implementer token in project '${project.id}'`,
		);
	}
	if (!reviewer) {
		throw new Error(
			`Failed to resolve GitLab identity for reviewer token in project '${project.id}'`,
		);
	}

	const identities: ScmPersonaIdentities = { implementer, reviewer };

	logger.debug('Resolved GitLab persona identities', {
		projectId: project.id,
		implementer,
		reviewer,
	});

	personaIdentityCache.set(project.id, {
		value: identities,
		expiresAt: Date.now() + PERSONA_CACHE_TTL_MS,
	});
	return identities;
}

/** @internal Visible for testing only — clears the per-project identity cache. */
export function _resetGitLabPersonaIdentityCache(): void {
	personaIdentityCache.clear();
}

/**
 * Compared case-insensitively, like Bitbucket's and unlike GitHub's exact login
 * match: a GitLab username is unique but not case-canonical across payloads, and
 * loop prevention has to fail *closed* — treating a casing difference as "not
 * SWARM" is the dangerous direction.
 *
 * Both persona identities are strictly the GitLab `username` (resolved from
 * `user.username` in `getGitLabUserForToken`), which is the same field inbound
 * merge-request / note / pipeline payloads carry, so the two are comparable.
 */
function sameAccount(login: string, identity: string): boolean {
	return login.toLowerCase() === identity.toLowerCase();
}

/**
 * Whether a GitLab username belongs to either SWARM persona.
 *
 * No `[bot]`-suffixed forms to handle: that suffix is a GitHub App artifact on
 * GitHub's event payloads and has no GitLab analogue — GitLab automation actors
 * are ordinary users or project-access-token bot users, whose usernames carry no
 * suffix to strip. Not an omission.
 */
export function isSwarmGitLabActor(login: string, identities: ScmPersonaIdentities): boolean {
	return sameAccount(login, identities.implementer) || sameAccount(login, identities.reviewer);
}

/** Which persona a GitLab username belongs to, or `null` when it isn't one of SWARM's. */
export function getGitLabPersonaForLogin(
	login: string,
	identities: ScmPersonaIdentities,
): ScmPersona | null {
	if (sameAccount(login, identities.implementer)) return 'implementer';
	if (sameAccount(login, identities.reviewer)) return 'reviewer';
	return null;
}
