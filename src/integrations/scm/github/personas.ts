/**
 * Dual-persona model for GitHub — ported from Cascade's `src/github/personas.ts`.
 *
 * SWARM runs Claude Code as two distinct GitHub identities: `implementer` (opens
 * PRs, pushes fixes, responds to review) and `reviewer` (reviews PRs). The split
 * exists to break the automation feedback loop: a persona must never react to its
 * own output — the implementer never reviews its own PR, and the reviewer's
 * `changes_requested` routes back to the implementer, not to itself
 * (ai/CODING_STANDARDS.md "Loop prevention").
 *
 * Only the **reviewer** has an identity the control plane can resolve (issue
 * #1249): it is the project's own credential. The implementer is whichever
 * operator's worker produced a pull request — an ordinary account, one per
 * operator — so there is no single implementer login to resolve, and nothing asks
 * for one. The Respond-to-review author gate only asks whether a review came from
 * the reviewer ({@link resolveReviewerIdentity} + {@link isReviewerLogin}); SWARM's
 * own comments are recognised by their marker (issue #443, `src/scm/swarm-origin.ts`)
 * and its own pull requests by work-item origin (`src/triggers/swarm-managed-pr.ts`).
 */

import { getPersonaTokenOrNull } from '../../../config/provider.js';
import type { ProjectConfig } from '../../../config/schema.js';
import { logger } from '../../../lib/logger.js';
import type { ScmPersona } from '../../../scm/types.js';
import { getGitHubUserForToken } from './client.js';

// ============================================================================
// Types
// ============================================================================

/**
 * The persona role model is provider-neutral (`ScmPersona`, `src/scm/types.ts`);
 * this is the GitHub module's local name for it. Kept as an alias rather than
 * renamed at every call site: ~10 files still spell `GitHubPersona`, and issues
 * #385/#386 retire the alias as they migrate those call sites onto the registry.
 */
export type GitHubPersona = ScmPersona;

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
// Reviewer identity
// ============================================================================

const PERSONA_CACHE_TTL_MS = 60_000; // 60s — matches Cascade's persona identity cache

interface CacheEntry {
	value: string;
	expiresAt: number;
}

// Per-project TTL cache of the reviewer identity. Resolving it costs a token lookup
// plus a GitHub API round-trip; a burst of webhooks for one repo would otherwise
// repeat that work per event. Errors are re-thrown (not cached) so a transient
// credential failure doesn't get pinned for the TTL window.
const reviewerIdentityCache = new Map<string, CacheEntry>();

/**
 * Resolve the GitHub login of a project's reviewer token, cached per project with a
 * 60s TTL. Throws if the token is missing or its identity can't be resolved — the
 * author gate then fails closed rather than answering a review it cannot attribute.
 */
export async function resolveReviewerIdentity(project: ProjectConfig): Promise<string> {
	const cached = reviewerIdentityCache.get(project.id);
	if (cached && Date.now() < cached.expiresAt) return cached.value;

	const reviewer = await getGitHubUserForToken(await getPersonaTokenOrNull(project, 'reviewer'));
	if (!reviewer) {
		throw new Error(
			`Failed to resolve GitHub identity for reviewer token in project '${project.id}'`,
		);
	}

	logger.debug('Resolved reviewer identity', { projectId: project.id, reviewer });
	reviewerIdentityCache.set(project.id, {
		value: reviewer,
		expiresAt: Date.now() + PERSONA_CACHE_TTL_MS,
	});
	return reviewer;
}

/** @internal Visible for testing only — clears the per-project identity cache. */
export function _resetPersonaIdentityCache(): void {
	reviewerIdentityCache.clear();
}

/**
 * Whether a GitHub login is the reviewer identity. The `[bot]`-suffixed form covers
 * a GitHub App identity, which surfaces with that suffix on events.
 */
export function isReviewerLogin(login: string, reviewer: string): boolean {
	return login === reviewer || login === `${reviewer}[bot]`;
}
