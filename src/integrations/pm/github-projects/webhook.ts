/**
 * GitHub Projects webhook authentication — the manifest's
 * `verifyWebhookSignature` (issue #496), kept in the provider folder beside the
 * SCM provider's own `webhook.ts` so GitHub's header name and `sha256=<hex>`
 * framing stay out of the receiver.
 *
 * It **delegates to the GitHub SCM provider's existing HMAC check**
 * (`verifyGitHubSignature`) and reads the signature with that provider's own
 * header reading, because SWARM's board and repo subscriptions are literally the
 * same GitHub webhook: one URL, one secret, one signature
 * (docs/github-projects-v2-api.md §5). That is the shared-secret reality, not a
 * shortcut — a board on a *different* account than the repo (a Jira board paired
 * with a GitHub repo) has its own secret and must implement its own verifier, the
 * same rule `PMRouterAdapter.isSelfAuthored` states for loop prevention
 * (ai/RULES.md §2 names the reach).
 */

import { readGitHubWebhookRequest, verifyGitHubSignature } from '../../scm/github/webhook.js';
import type { PmWebhookVerification } from '../manifest.js';

/**
 * Verify a `projects_v2_item` delivery against the project's shared HMAC secret.
 *
 * `callbackUrl` is unused: GitHub signs the body alone. It stays in the input
 * shape for the providers that sign their own callback URL (Trello).
 *
 * Fails closed when the project has no secret configured — an absent secret is
 * *not* an empty key, which anyone could sign with.
 */
export function verifyGitHubProjectsWebhookSignature({
	rawBody,
	headers,
	secret,
}: PmWebhookVerification): boolean {
	if (!secret) return false;
	return verifyGitHubSignature(rawBody, readGitHubWebhookRequest(headers).signature, secret);
}
