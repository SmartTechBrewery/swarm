/**
 * Trello PM credential seam — resolve the provider's two declared roles once per
 * operation and scope them for the duration of that operation's async work
 * (`./client.ts`). Credentials are never function arguments
 * (ai/CODING_STANDARDS.md "Error handling").
 *
 * Two roles rather than one because Trello authenticates with a **key/token pair**
 * passed as query parameters: the API key names the integration and the token names
 * the member who authorized it, so neither alone authenticates a request. Role keys
 * are camelCase, matching GitHub Projects' `apiToken`, Linear's `apiKey`, and Jira's
 * `email`/`apiToken` — Cascade's snake_case `api_key` is its convention, not SWARM's.
 *
 * Roles are resolved through the *registered manifest*: `requirePmCredential`
 * validates the role against `PMProviderManifest.credentialRoles` for
 * `project.pm.type` (`src/config/provider.ts`, issue #497). Trello registers no
 * manifest until the provider is complete (ai/RULES.md §2 "Register when the
 * contract is satisfied"), so this resolves for real only from that phase on; until
 * then the provider's own unit suite mocks `@/config/provider.js`.
 *
 * The **webhook-secret role is not declared here**: Trello signs each delivery with
 * the integration's *API secret*, but SWARM's receiver resolves exactly one role for
 * a verifier — `PM_WEBHOOK_SECRET_ROLE` (`../manifest.ts`) — so that secret is
 * declared on the manifest under that role, backed by `TRELLO_API_SECRET`, and
 * consumed by the receiver rather than by this module.
 */

import { requirePmCredential } from '../../../config/provider.js';
import type { ProjectConfig } from '../../../config/schema.js';
import { withTrelloCredentials } from './client.js';

/** The Trello API key — the `key` query parameter on every request. */
export const TRELLO_API_KEY_ROLE = 'apiKey';

/** The token issued for that key, which every board read and write runs as. */
export const TRELLO_TOKEN_ROLE = 'token';

/** Run `fn` with this project's Trello credentials bound to its asynchronous work. */
export async function withTrelloProjectCredentials<T>(
	project: ProjectConfig,
	fn: () => Promise<T>,
): Promise<T> {
	const [apiKey, token] = await Promise.all([
		requirePmCredential(project, TRELLO_API_KEY_ROLE),
		requirePmCredential(project, TRELLO_TOKEN_ROLE),
	]);
	return withTrelloCredentials({ apiKey, token }, fn);
}
