/**
 * The reviewer identity for GitLab — the GitLab twin of `../github/personas.ts`. It
 * answers the Respond-to-review author gate's one question, whether a review came
 * from SWARM's reviewer; the implementer has no single identity since issue #1249
 * (every pull request is authored by the operator whose worker produced it).
 *
 * The persona role model itself is provider-neutral (`ScmPersona`,
 * `src/scm/types.ts`) — there is deliberately no `GitLabPersona` alias to
 * redeclare it. The agent-type → persona mapping is neutral too and stays where
 * it is (`getPersonaForAgentType`, `../github/personas.ts`); nothing about it is
 * GitHub-specific.
 */

import type { ProjectConfig } from '../../../config/schema.js';
import { logger } from '../../../lib/logger.js';
import { getGitLabUserForToken } from './client.js';
import { getGitLabTokenOrNull } from './credentials.js';

const PERSONA_CACHE_TTL_MS = 60_000; // 60s — matches the GitHub and Bitbucket caches.

interface CacheEntry {
	value: string;
	expiresAt: number;
}

// Per-project TTL cache. Resolving an identity costs a credential lookup plus a
// GitLab round-trip; a burst of webhooks for one project would otherwise repeat
// that per event. Errors are thrown, never cached, so a transient credential
// failure isn't pinned for the TTL window.
const reviewerIdentityCache = new Map<string, CacheEntry>();

/**
 * Resolve the GitLab username of a project's reviewer token, cached per project with a 60s
 * TTL. Throws when it can't be resolved, so the Respond-to-review author gate
 * fails closed rather than answering a review it cannot attribute. The implementer
 * has no single identity to resolve (issue #1249): every pull request is authored by
 * the operator whose worker produced it.
 */
export async function resolveGitLabReviewerIdentity(project: ProjectConfig): Promise<string> {
	const cached = reviewerIdentityCache.get(project.id);
	if (cached && Date.now() < cached.expiresAt) return cached.value;

	const reviewerToken = await getGitLabTokenOrNull(project, 'reviewer');
	const reviewer = await getGitLabUserForToken(reviewerToken);
	if (!reviewer) {
		throw new Error(
			`Failed to resolve GitLab identity for reviewer token in project '${project.id}'`,
		);
	}

	logger.debug('Resolved GitLab reviewer identity', { projectId: project.id, reviewer });
	reviewerIdentityCache.set(project.id, {
		value: reviewer,
		expiresAt: Date.now() + PERSONA_CACHE_TTL_MS,
	});
	return reviewer;
}

/** @internal Visible for testing only — clears the per-project identity cache. */
export function _resetGitLabPersonaIdentityCache(): void {
	reviewerIdentityCache.clear();
}

/**
 * Compared case-insensitively, like Bitbucket's and unlike GitHub's exact login
 * match: a GitLab username is unique but not case-canonical across payloads, and a
 * casing difference must not make the author gate ignore SWARM's own reviewer.
 *
 * The reviewer identity is strictly the GitLab `username` (resolved from
 * `user.username` in `getGitLabUserForToken`), which is the same field inbound
 * merge-request / note / pipeline payloads carry, so the two are comparable.
 */
function sameAccount(login: string, identity: string): boolean {
	return login.toLowerCase() === identity.toLowerCase();
}

/** Whether a GitLab username is the reviewer identity. */
export function isGitLabReviewer(login: string, reviewer: string): boolean {
	return sameAccount(login, reviewer);
}
