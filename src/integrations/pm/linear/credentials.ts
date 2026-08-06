/**
 * Linear PM credential seam — resolve the provider's declared API-key role once
 * per operation and scope it for the duration of that operation's async work
 * (`./client.ts`). The credential is never a function argument
 * (ai/CODING_STANDARDS.md "Error handling").
 *
 * The role is resolved through the *registered manifest*: `requirePmCredential`
 * validates the role against `PMProviderManifest.credentialRoles` for
 * `project.pm.type` (`src/config/provider.ts`, issue #497). Linear registers no
 * manifest until the provider is complete (ai/RULES.md §2 "Register when the
 * contract is satisfied"), so this resolves for real only from that phase on;
 * until then the provider's own unit suite mocks `@/config/provider.js`.
 */

import { requirePmCredential } from '../../../config/provider.js';
import type { ProjectConfig } from '../../../config/schema.js';
import { withLinearApiKey } from './client.js';

/**
 * The single credential role Linear needs: one API key. Personal keys and OAuth
 * access tokens both go in the same header, so there is nothing else to declare
 * (unlike Jira's email + token pair or Trello's key + token + secret).
 */
export const LINEAR_API_KEY_ROLE = 'apiKey';

/** Run `fn` with this project's Linear API key bound to its asynchronous work. */
export async function withLinearProjectCredentials<T>(
	project: ProjectConfig,
	fn: () => Promise<T>,
): Promise<T> {
	const apiKey = await requirePmCredential(project, LINEAR_API_KEY_ROLE);
	return withLinearApiKey(apiKey, fn);
}
