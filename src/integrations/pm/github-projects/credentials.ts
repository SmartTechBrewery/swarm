/**
 * GitHub Projects PM credential seam (issue #537) — resolve the provider's own
 * declared API-token role and scope it for the duration of an operation's async
 * work. The token is never a function argument (ai/CODING_STANDARDS.md "Scope
 * credentials with AsyncLocalStorage"); it is bound once and read back off the
 * scope by `getScopedClient()`.
 *
 * This is what makes board authentication a **project** credential rather than a
 * worker-local SCM identity. Before #537 every board read/write and the whole
 * board-discovery path ran inside
 * `GitHubSCMIntegration.withPersonaCredentials(project, 'implementer', …)`, i.e.
 * on `SWARM_OPERATOR_GH_TOKEN` — which made a worker's implementer identity a
 * hidden requirement of the API host, gave a project admin no way to configure
 * board access, and broke discovery whenever that operator token happened to lack
 * `read:org`. The operator token is now strictly an SCM implementer credential
 * (`src/config/operator-token.ts`); the board resolves `credentials.pm.apiToken`
 * through the provider-agnostic role mechanism (`resolvePmCredential`,
 * `src/config/provider.ts`, issue #497) and nothing here ever falls back to it.
 *
 * Reusing the SCM module's Octokit client (`withGitHubToken` / `getScopedClient` /
 * `getGitHubUserForToken`) is *client* reuse, not identity reuse: the board and
 * the repo speak the same API, so there is one HTTP client, but the credential
 * bound to it here is the PM provider's own.
 */

import { createHash } from 'node:crypto';
import { requirePmCredential } from '../../../config/provider.js';
import type { ProjectConfig } from '../../../config/schema.js';
import { logger } from '../../../lib/logger.js';
import { getGitHubUserForToken, withGitHubToken } from '../../scm/github/client.js';

/**
 * The single credential role GitHub Projects declares for itself: one GitHub API
 * token with access to the board (and to the Issues/PRs its cards wrap). Classic
 * and fine-grained tokens both go in the same header, so there is nothing else to
 * declare — the shared webhook secret stays a separate role on the manifest
 * because it is not an API credential at all.
 */
export const GITHUB_PROJECTS_API_TOKEN_ROLE = 'apiToken';

/** Run `fn` with this project's GitHub Projects API token bound to its async work. */
export async function withGitHubProjectsCredentials<T>(
	project: ProjectConfig,
	fn: () => Promise<T>,
): Promise<T> {
	const token = await requirePmCredential(project, GITHUB_PROJECTS_API_TOKEN_ROLE);
	return withGitHubToken(token, fn);
}

/** 60s, matching the SCM persona identity cache (`../../scm/github/personas.ts`). */
const IDENTITY_CACHE_TTL_MS = 60_000;

interface CacheEntry {
	login: string;
	/** Fingerprint of the credential the login was resolved for — see below. */
	credentialFingerprint: string;
	expiresAt: number;
}

// Per-project TTL cache of the board identity. The board's loop-prevention gate
// asks for it on every inbound `projects_v2_item` delivery, and the expensive half
// of answering is the GitHub round-trip — that is what this caches. The credential
// itself is still resolved on each call, so rotating it is observed immediately
// instead of at the end of a TTL window in which SWARM's own board writes (made
// with the *new* token) would be compared against the old login and mistaken for a
// human's. Failures are re-thrown rather than cached, so a transient credential
// error isn't pinned for the whole window.
const identityCache = new Map<string, CacheEntry>();

/**
 * A stable, non-reversible tag for a credential value, so a cache entry can be
 * invalidated when the credential changes without the cache holding the secret.
 */
function credentialFingerprint(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

/**
 * The GitHub login the project's board credential authenticates as — the identity
 * every SWARM board write is attributed to, and therefore the one the board's
 * loop-prevention gate must recognize as its own
 * (`GitHubProjectsRouterAdapter.isSelfAuthored`).
 *
 * Keyed on the *PM* credential, deliberately: since #537 a card SWARM moves is
 * moved by this token, so asking the SCM personas "was this us?" would answer
 * about an account that no longer touches the board. Throws when the credential is
 * missing or its identity can't be resolved — the caller decides how to treat that
 * (the gate fails open and logs).
 *
 * Cached per project for {@link IDENTITY_CACHE_TTL_MS}, keyed additionally on a
 * fingerprint of the credential, so a rotated token is picked up on the next call
 * rather than at the end of the window.
 */
export async function resolveGitHubProjectsIdentity(project: ProjectConfig): Promise<string> {
	// Resolved before the cache is consulted, deliberately: a credential that was
	// rotated (or removed — in which case this throws, as it should) must not keep
	// answering with the login of the account that no longer writes to the board.
	const token = await requirePmCredential(project, GITHUB_PROJECTS_API_TOKEN_ROLE);
	const fingerprint = credentialFingerprint(token);

	const cached = identityCache.get(project.id);
	if (cached && cached.credentialFingerprint === fingerprint && Date.now() < cached.expiresAt) {
		return cached.login;
	}

	const login = await getGitHubUserForToken(token);
	if (!login) {
		throw new Error(
			`Failed to resolve the GitHub identity of the board credential for project '${project.id}'`,
		);
	}

	logger.debug('pm: resolved GitHub Projects board identity', { projectId: project.id, login });
	identityCache.set(project.id, {
		login,
		credentialFingerprint: fingerprint,
		expiresAt: Date.now() + IDENTITY_CACHE_TTL_MS,
	});
	return login;
}

/**
 * Whether a webhook actor login *is* the board identity. The `[bot]`-suffixed form
 * covers a GitHub App credential, which surfaces with that suffix on events —
 * the same allowance `isSwarmBot` makes on the SCM side.
 */
export function matchesGitHubProjectsIdentity(actorLogin: string, identity: string): boolean {
	return actorLogin === identity || actorLogin === `${identity}[bot]`;
}

/** @internal Visible for testing only — clears the per-project identity cache. */
export function _resetGitHubProjectsIdentityCache(): void {
	identityCache.clear();
}
