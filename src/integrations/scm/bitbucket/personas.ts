/**
 * Dual-persona identities for Bitbucket — the Bitbucket twin of
 * `../github/personas.ts`, and the same invariant: a persona must never react to
 * its own output, which is enforced by mapping an inbound event's actor to a
 * persona (ai/CODING_STANDARDS.md "Loop prevention").
 *
 * The persona role model itself is provider-neutral (`ScmPersona`,
 * `src/scm/types.ts`) — there is deliberately no `BitbucketPersona` alias to
 * redeclare it. The agent-type → persona mapping is neutral too and stays where
 * it is (`getPersonaForAgentType`, `../github/personas.ts`); nothing about it is
 * GitHub-specific.
 */

import type { ProjectConfig } from '../../../config/schema.js';
import { logger } from '../../../lib/logger.js';
import type { ScmPersona, ScmPersonaIdentities } from '../../../scm/types.js';
import { getBitbucketUserForCredential } from './client.js';
import { getBitbucketCredentialOrNull } from './credentials.js';

const PERSONA_CACHE_TTL_MS = 60_000; // 60s — matches the GitHub persona identity cache.

interface CacheEntry {
	value: ScmPersonaIdentities;
	expiresAt: number;
}

// Per-project TTL cache. Resolving an identity costs a credential lookup plus a
// Bitbucket round-trip; a burst of webhooks for one repo would otherwise repeat
// that per event. Errors are thrown, never cached, so a transient credential
// failure isn't pinned for the TTL window.
const personaIdentityCache = new Map<string, CacheEntry>();

/**
 * Resolve both persona logins for a project, cached per project with a 60s TTL.
 * Throws when either can't be resolved: without both, loop prevention can't tell
 * SWARM's own events from a human's, so it fails closed rather than proceeding.
 */
export async function resolveBitbucketPersonaIdentities(
	project: ProjectConfig,
): Promise<ScmPersonaIdentities> {
	const cached = personaIdentityCache.get(project.id);
	if (cached && Date.now() < cached.expiresAt) return cached.value;

	const [implementerCredential, reviewerCredential] = await Promise.all([
		getBitbucketCredentialOrNull(project, 'implementer'),
		getBitbucketCredentialOrNull(project, 'reviewer'),
	]);

	const [implementer, reviewer] = await Promise.all([
		getBitbucketUserForCredential(implementerCredential),
		getBitbucketUserForCredential(reviewerCredential),
	]);

	if (!implementer) {
		throw new Error(
			`Failed to resolve Bitbucket identity for implementer credential in project '${project.id}'`,
		);
	}
	if (!reviewer) {
		throw new Error(
			`Failed to resolve Bitbucket identity for reviewer credential in project '${project.id}'`,
		);
	}

	const identities: ScmPersonaIdentities = { implementer, reviewer };

	logger.debug('Resolved Bitbucket persona identities', {
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
export function _resetBitbucketPersonaIdentityCache(): void {
	personaIdentityCache.clear();
}

/**
 * Compared case-insensitively, unlike GitHub's exact login match: a Bitbucket
 * `nickname` is a user-editable field with no canonical-case guarantee, and loop
 * prevention has to fail *closed* — treating a casing difference as "not SWARM"
 * is the dangerous direction.
 *
 * Both persona identities are stored strictly as `nickname` (resolved from
 * `user.nickname` in `getBitbucketUserForCredential`); an account lacking a nickname
 * fails closed at persona resolution rather than falling back to `account_id`, which
 * lives in a different namespace and would never match an inbound actor's nickname.
 */
function sameAccount(login: string, identity: string): boolean {
	return login.toLowerCase() === identity.toLowerCase();
}

/**
 * Whether a Bitbucket login belongs to either SWARM persona.
 *
 * No `[bot]`-suffixed forms to handle: that suffix is a GitHub App artifact on
 * GitHub's event payloads and has no Bitbucket analogue — its automation actors
 * are ordinary accounts or app-password users. Not an omission.
 */
export function isSwarmBitbucketActor(login: string, identities: ScmPersonaIdentities): boolean {
	return sameAccount(login, identities.implementer) || sameAccount(login, identities.reviewer);
}

/** Which persona a Bitbucket login belongs to, or `null` when it isn't one of SWARM's. */
export function getBitbucketPersonaForLogin(
	login: string,
	identities: ScmPersonaIdentities,
): ScmPersona | null {
	if (sameAccount(login, identities.implementer)) return 'implementer';
	if (sameAccount(login, identities.reviewer)) return 'reviewer';
	return null;
}
