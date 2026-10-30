/**
 * The reviewer identity for Azure DevOps — the Azure DevOps twin of
 * `../gitlab/personas.ts` (issue #1089, phase 2/6). It answers the Respond-to-review
 * author gate's one question, whether a review came from SWARM's reviewer; the
 * implementer has no single identity since issue #1249 (every pull request is
 * authored by the operator whose worker produced it).
 *
 * A persona "login" here is the Azure DevOps **identity id** (a GUID) its PAT
 * authenticates as — not a display name, which is neither unique nor stable — because
 * that id is what service hook payloads carry as `createdBy.id`, `author.id` and
 * `reviewers[].id` (`getAzureDevOpsUserForToken`, `./client.ts`).
 */

import type { ProjectConfig } from '../../../config/schema.js';
import { logger } from '../../../lib/logger.js';
import { azureRepoCoordinates, getAzureDevOpsUserForToken } from './client.js';
import { getAzureDevOpsTokenOrNull } from './credentials.js';

const PERSONA_CACHE_TTL_MS = 60_000; // 60s — matches the other providers' caches.

interface CacheEntry {
	value: string;
	expiresAt: number;
}

// Per-project TTL cache. Resolving an identity costs a credential lookup plus an
// Azure DevOps round-trip; a burst of webhooks for one project would otherwise
// repeat that per event. Errors are thrown, never cached, so a transient credential
// failure isn't pinned for the TTL window.
const reviewerIdentityCache = new Map<string, CacheEntry>();

/**
 * Resolve the Azure DevOps identity id of a project's reviewer token, cached per
 * project with a 60s TTL. The organization it is resolved in is the project's own,
 * from `project.repo`. Throws when it can't be resolved, so the Respond-to-review
 * author gate fails closed rather than answering a review it cannot attribute. The
 * implementer has no single identity to resolve (issue #1249): every pull request is
 * authored by the operator whose worker produced it.
 */
export async function resolveAzureDevOpsReviewerIdentity(project: ProjectConfig): Promise<string> {
	const cached = reviewerIdentityCache.get(project.id);
	if (cached && Date.now() < cached.expiresAt) return cached.value;

	const { organization } = azureRepoCoordinates(project.repo);
	const reviewerToken = await getAzureDevOpsTokenOrNull(project, 'reviewer');
	const reviewer = await getAzureDevOpsUserForToken(reviewerToken, organization);
	if (!reviewer) {
		throw new Error(
			`Failed to resolve Azure DevOps identity for reviewer token in project '${project.id}'`,
		);
	}

	logger.debug('Resolved Azure DevOps reviewer identity', { projectId: project.id, reviewer });
	reviewerIdentityCache.set(project.id, {
		value: reviewer,
		expiresAt: Date.now() + PERSONA_CACHE_TTL_MS,
	});
	return reviewer;
}

/** @internal Visible for testing only — clears the per-project identity cache. */
export function _resetAzureDevOpsPersonaIdentityCache(): void {
	reviewerIdentityCache.clear();
}

/**
 * Compared case-insensitively: an identity id is a GUID, and Azure DevOps spells one
 * in either case depending on the API that produced it. A casing difference must
 * not make the author gate ignore SWARM's own reviewer.
 */
function sameAccount(login: string, identity: string): boolean {
	return login.toLowerCase() === identity.toLowerCase();
}

/** Whether an Azure DevOps identity id is the reviewer identity. */
export function isAzureDevOpsReviewer(login: string, reviewer: string): boolean {
	return sameAccount(login, reviewer);
}
