/**
 * Dual-persona identities for Azure DevOps — the Azure DevOps twin of
 * `../gitlab/personas.ts` (issue #1089, phase 2/6), and the same invariant: a
 * persona must never react to its own output, which is enforced by mapping an
 * inbound event's actor to a persona (ai/CODING_STANDARDS.md "Loop prevention").
 *
 * A persona "login" here is the Azure DevOps **identity id** (a GUID) its PAT
 * authenticates as — not a display name, which is neither unique nor stable — because
 * that id is what service hook payloads carry as `createdBy.id`, `author.id` and
 * `reviewers[].id` (`getAzureDevOpsUserForToken`, `./client.ts`).
 */

import type { ProjectConfig } from '../../../config/schema.js';
import { logger } from '../../../lib/logger.js';
import type { ScmPersona, ScmPersonaIdentities } from '../../../scm/types.js';
import { azureRepoCoordinates, getAzureDevOpsUserForToken } from './client.js';
import { getAzureDevOpsTokenOrNull } from './credentials.js';

const PERSONA_CACHE_TTL_MS = 60_000; // 60s — matches the other providers' caches.

interface CacheEntry {
	value: ScmPersonaIdentities;
	expiresAt: number;
}

// Per-project TTL cache. Resolving an identity costs a credential lookup plus an
// Azure DevOps round-trip; a burst of webhooks for one project would otherwise
// repeat that per event. Errors are thrown, never cached, so a transient credential
// failure isn't pinned for the TTL window.
const personaIdentityCache = new Map<string, CacheEntry>();

/**
 * Resolve both persona identity ids for a project, cached per project with a 60s
 * TTL. The organization they are resolved in is the project's own, from
 * `project.repo`. Throws when either can't be resolved: without both, loop
 * prevention can't tell SWARM's own events from a human's, so it fails closed rather
 * than proceeding.
 */
export async function resolveAzureDevOpsPersonaIdentities(
	project: ProjectConfig,
): Promise<ScmPersonaIdentities> {
	const cached = personaIdentityCache.get(project.id);
	if (cached && Date.now() < cached.expiresAt) return cached.value;

	const { organization } = azureRepoCoordinates(project.repo);
	const [implementerToken, reviewerToken] = await Promise.all([
		getAzureDevOpsTokenOrNull(project, 'implementer'),
		getAzureDevOpsTokenOrNull(project, 'reviewer'),
	]);

	const [implementer, reviewer] = await Promise.all([
		getAzureDevOpsUserForToken(implementerToken, organization),
		getAzureDevOpsUserForToken(reviewerToken, organization),
	]);

	if (!implementer) {
		throw new Error(
			`Failed to resolve Azure DevOps identity for implementer token in project '${project.id}'`,
		);
	}
	if (!reviewer) {
		throw new Error(
			`Failed to resolve Azure DevOps identity for reviewer token in project '${project.id}'`,
		);
	}

	const identities: ScmPersonaIdentities = { implementer, reviewer };

	logger.debug('Resolved Azure DevOps persona identities', {
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
export function _resetAzureDevOpsPersonaIdentityCache(): void {
	personaIdentityCache.clear();
}

/**
 * Compared case-insensitively: an identity id is a GUID, and Azure DevOps spells one
 * in either case depending on the API that produced it. Loop prevention has to fail
 * *closed* — treating a casing difference as "not SWARM" is the dangerous direction.
 */
function sameAccount(login: string, identity: string): boolean {
	return login.toLowerCase() === identity.toLowerCase();
}

/** Whether an Azure DevOps identity id belongs to either SWARM persona. */
export function isSwarmAzureDevOpsActor(login: string, identities: ScmPersonaIdentities): boolean {
	return sameAccount(login, identities.implementer) || sameAccount(login, identities.reviewer);
}

/** Which persona an Azure DevOps identity id belongs to, or `null` when it isn't one of SWARM's. */
export function getAzureDevOpsPersonaForLogin(
	login: string,
	identities: ScmPersonaIdentities,
): ScmPersona | null {
	if (sameAccount(login, identities.implementer)) return 'implementer';
	if (sameAccount(login, identities.reviewer)) return 'reviewer';
	return null;
}
