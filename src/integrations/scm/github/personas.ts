/**
 * Dual-persona model for GitHub — ported from Cascade's `src/github/personas.ts`.
 *
 * SWARM runs Claude Code as two distinct GitHub identities: `implementer` (opens
 * PRs, pushes fixes, responds to review) and `reviewer` (reviews PRs). The split
 * exists to break the automation feedback loop: a persona must never react to its
 * own output — the implementer never reviews its own PR, and the reviewer's
 * `changes_requested` routes back to the implementer, not to itself
 * (ai/CODING_STANDARDS.md "Loop prevention"). That invariant is enforced by
 * mapping every inbound event's actor to a persona (`getPersonaForLogin`) and by
 * refusing to act on events a SWARM persona itself produced (`isSwarmBot`).
 *
 * The two personas resolve their tokens from different sources (issue #396): the
 * `implementer` identity is resolved from the worker operator's own token
 * (`SWARM_OPERATOR_GH_TOKEN`, via `getPersonaTokenOrNull`), the same token the
 * implementer phases open PRs with — so the resolved implementer login always
 * matches the PR author. The `reviewer` stays a project-scoped credential. The
 * two must still resolve to two distinct accounts (operator ≠ reviewer) for loop
 * prevention to hold.
 */

import { getPersonaTokenOrNull } from '../../../config/provider.js';
import type { ProjectConfig } from '../../../config/schema.js';
import { logger } from '../../../lib/logger.js';
import { getGitHubUserForToken } from './client.js';

// ============================================================================
// Types
// ============================================================================

export type GitHubPersona = 'implementer' | 'reviewer';

export interface PersonaIdentities {
	implementer: string;
	reviewer: string;
}

// ============================================================================
// Agent → Persona mapping
// ============================================================================

/**
 * Maps agent types to their GitHub persona — the canonical registration point.
 * The `review` agent acts as the reviewer; everything else (planning,
 * implementation, responding to review/CI/comments) acts as the implementer.
 * Any agent type not listed defaults to `implementer`.
 */
const AGENT_PERSONA_MAP: Record<string, GitHubPersona> = {
	planning: 'implementer',
	implementation: 'implementer',
	'respond-to-review': 'implementer',
	review: 'reviewer',
};

export function getPersonaForAgentType(agentType: string): GitHubPersona {
	return AGENT_PERSONA_MAP[agentType] ?? 'implementer';
}

// ============================================================================
// Identity resolution
// ============================================================================

const PERSONA_CACHE_TTL_MS = 60_000; // 60s — matches Cascade's persona identity cache

interface CacheEntry {
	value: PersonaIdentities;
	expiresAt: number;
}

// Per-project TTL cache of persona identities. Resolving an identity costs a
// token lookup plus a GitHub API round-trip; a burst of webhooks for one repo
// would otherwise repeat that work per event. Errors are re-thrown (not cached)
// so a transient credential failure doesn't get pinned for the TTL window.
const personaIdentityCache = new Map<string, CacheEntry>();

/**
 * Resolve both persona GitHub logins for a project, cached per-project with a
 * 60s TTL. Throws if either persona's token is missing or its identity can't be
 * resolved — without both identities, loop prevention can't tell SWARM's own
 * events apart from a human's, so proceeding would be unsafe.
 */
export async function resolvePersonaIdentities(project: ProjectConfig): Promise<PersonaIdentities> {
	const cached = personaIdentityCache.get(project.id);
	if (cached && Date.now() < cached.expiresAt) return cached.value;

	const [implementerToken, reviewerToken] = await Promise.all([
		getPersonaTokenOrNull(project, 'implementer'),
		getPersonaTokenOrNull(project, 'reviewer'),
	]);

	const [implementerLogin, reviewerLogin] = await Promise.all([
		getGitHubUserForToken(implementerToken),
		getGitHubUserForToken(reviewerToken),
	]);

	if (!implementerLogin) {
		throw new Error(
			`Failed to resolve GitHub identity for implementer token in project '${project.id}'`,
		);
	}
	if (!reviewerLogin) {
		throw new Error(
			`Failed to resolve GitHub identity for reviewer token in project '${project.id}'`,
		);
	}

	const identities: PersonaIdentities = {
		implementer: implementerLogin,
		reviewer: reviewerLogin,
	};

	logger.debug('Resolved persona identities', {
		projectId: project.id,
		implementer: implementerLogin,
		reviewer: reviewerLogin,
	});

	personaIdentityCache.set(project.id, {
		value: identities,
		expiresAt: Date.now() + PERSONA_CACHE_TTL_MS,
	});
	return identities;
}

/** @internal Visible for testing only — clears the per-project identity cache. */
export function _resetPersonaIdentityCache(): void {
	personaIdentityCache.clear();
}

// ============================================================================
// Bot detection (loop prevention)
// ============================================================================

/**
 * Whether a GitHub login belongs to either SWARM persona. The `[bot]`-suffixed
 * forms cover GitHub App identities, which surface with that suffix on events.
 */
export function isSwarmBot(login: string, identities: PersonaIdentities): boolean {
	return (
		login === identities.implementer ||
		login === identities.reviewer ||
		login === `${identities.implementer}[bot]` ||
		login === `${identities.reviewer}[bot]`
	);
}

/** Which persona a login belongs to, or `null` if it isn't a SWARM persona. */
export function getPersonaForLogin(
	login: string,
	identities: PersonaIdentities,
): GitHubPersona | null {
	if (login === identities.implementer || login === `${identities.implementer}[bot]`) {
		return 'implementer';
	}
	if (login === identities.reviewer || login === `${identities.reviewer}[bot]`) {
		return 'reviewer';
	}
	return null;
}
