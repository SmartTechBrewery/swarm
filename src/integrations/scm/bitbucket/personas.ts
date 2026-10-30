/**
 * The reviewer identity for Bitbucket — the Bitbucket twin of `../github/personas.ts`. It
 * answers the Respond-to-review author gate's one question, whether a review came
 * from SWARM's reviewer; the implementer has no single identity since issue #1249
 * (every pull request is authored by the operator whose worker produced it).
 *
 * The persona role model itself is provider-neutral (`ScmPersona`,
 * `src/scm/types.ts`) — there is deliberately no `BitbucketPersona` alias to
 * redeclare it. The agent-type → persona mapping is neutral too and stays where
 * it is (`getPersonaForAgentType`, `../github/personas.ts`); nothing about it is
 * GitHub-specific.
 */

import type { ProjectConfig } from '../../../config/schema.js';
import { logger } from '../../../lib/logger.js';
import { getBitbucketUserForCredential } from './client.js';
import { getBitbucketCredentialOrNull } from './credentials.js';

const PERSONA_CACHE_TTL_MS = 60_000; // 60s — matches the GitHub persona identity cache.

interface CacheEntry {
	value: string;
	expiresAt: number;
}

// Per-project TTL cache. Resolving an identity costs a credential lookup plus a
// Bitbucket round-trip; a burst of webhooks for one repo would otherwise repeat
// that per event. Errors are thrown, never cached, so a transient credential
// failure isn't pinned for the TTL window.
const reviewerIdentityCache = new Map<string, CacheEntry>();

/**
 * Resolve the Bitbucket login of a project's reviewer credential, cached per project with a 60s
 * TTL. Throws when it can't be resolved, so the Respond-to-review author gate
 * fails closed rather than answering a review it cannot attribute. The implementer
 * has no single identity to resolve (issue #1249): every pull request is authored by
 * the operator whose worker produced it.
 */
export async function resolveBitbucketReviewerIdentity(project: ProjectConfig): Promise<string> {
	const cached = reviewerIdentityCache.get(project.id);
	if (cached && Date.now() < cached.expiresAt) return cached.value;

	const reviewerCredential = await getBitbucketCredentialOrNull(project, 'reviewer');
	const reviewer = await getBitbucketUserForCredential(reviewerCredential);
	if (!reviewer) {
		throw new Error(
			`Failed to resolve Bitbucket identity for reviewer credential in project '${project.id}'`,
		);
	}

	logger.debug('Resolved Bitbucket reviewer identity', { projectId: project.id, reviewer });
	reviewerIdentityCache.set(project.id, {
		value: reviewer,
		expiresAt: Date.now() + PERSONA_CACHE_TTL_MS,
	});
	return reviewer;
}

/** @internal Visible for testing only — clears the per-project identity cache. */
export function _resetBitbucketPersonaIdentityCache(): void {
	reviewerIdentityCache.clear();
}

/**
 * Compared case-insensitively, unlike GitHub's exact login match: a Bitbucket
 * `nickname` is a user-editable field with no canonical-case guarantee, and a casing
 * difference must not make the author gate ignore SWARM's own reviewer.
 *
 * The reviewer identity is stored strictly as `nickname` (resolved from
 * `user.nickname` in `getBitbucketUserForCredential`); an account lacking a nickname
 * fails closed at identity resolution rather than falling back to `account_id`, which
 * lives in a different namespace and would never match an inbound actor's nickname.
 */
function sameAccount(login: string, identity: string): boolean {
	return login.toLowerCase() === identity.toLowerCase();
}

/** Whether a Bitbucket login is the reviewer identity. */
export function isBitbucketReviewer(login: string, reviewer: string): boolean {
	return sameAccount(login, reviewer);
}
