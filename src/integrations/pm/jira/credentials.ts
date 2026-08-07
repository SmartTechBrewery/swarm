/**
 * Jira PM credential seam — resolve the provider's two declared roles once per
 * operation and scope them, with the site's base URL, for the duration of that
 * operation's async work (`./client.ts`). Credentials are never function arguments
 * (ai/CODING_STANDARDS.md "Error handling").
 *
 * Two roles rather than one because Jira Cloud authenticates with **basic auth**:
 * the Atlassian account email is the username and the API token the password, so
 * neither alone authenticates a request. Role keys are camelCase, matching
 * GitHub Projects' `apiToken` and Linear's `apiKey` — Cascade's snake_case
 * `api_token` is its convention, not SWARM's.
 *
 * Roles are resolved through the *registered manifest*: `requirePmCredential`
 * validates the role against `PMProviderManifest.credentialRoles` for
 * `project.pm.type` (`src/config/provider.ts`, issue #497). Jira registers no
 * manifest until the provider is complete (ai/RULES.md §2 "Register when the
 * contract is satisfied"), so this resolves for real only from that phase on; until
 * then the provider's own unit suite mocks `@/config/provider.js`.
 *
 * The **webhook-secret role is not declared here**: it is `PM_WEBHOOK_SECRET_ROLE`
 * (`../manifest.ts`), declared on the manifest and consumed by the receiver.
 */

import { requirePmCredential } from '../../../config/provider.js';
import type { ProjectConfig } from '../../../config/schema.js';
import { withJiraCredentials } from './client.js';
import { requireJiraConfig } from './config-schema.js';

/** Basic-auth username: the Atlassian account the API token belongs to. */
export const JIRA_EMAIL_ROLE = 'email';

/** Basic-auth password: the Atlassian API token every board read and write runs as. */
export const JIRA_API_TOKEN_ROLE = 'apiToken';

/**
 * Run `fn` with this project's Jira credentials bound to its asynchronous work.
 *
 * `baseUrl` comes from the board mapping (`./config-schema.ts`), not from a
 * credential role — the site URL is not a secret.
 */
export async function withJiraProjectCredentials<T>(
	project: ProjectConfig,
	fn: () => Promise<T>,
): Promise<T> {
	const { baseUrl } = requireJiraConfig(project);
	const [email, apiToken] = await Promise.all([
		requirePmCredential(project, JIRA_EMAIL_ROLE),
		requirePmCredential(project, JIRA_API_TOKEN_ROLE),
	]);
	return withJiraCredentials({ email, apiToken, baseUrl }, fn);
}
