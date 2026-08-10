/**
 * Jira webhook authentication — the provider's `verifyWebhookSignature`
 * (`PMProviderManifest`, issue #496), kept in the provider folder beside the
 * GitHub Projects and Linear verifiers so Jira's header name and signature
 * framing never reach the receiver.
 *
 * **GitHub's framing, emphatically not GitHub's secret.** A Jira Cloud webhook
 * signs the raw body with HMAC-SHA256 and sends `sha256=<hex>` in
 * `x-hub-signature` — the same shape GitHub uses, one header name older. That
 * coincidence is exactly why this must *not* be routed through
 * `../github-projects/webhook.ts`: that verifier delegates to the GitHub SCM
 * provider and authenticates against the **repository's** webhook secret, which
 * Jira never signs with (its secret is entered on Atlassian's own webhook
 * screen and is declared as this provider's own credential role). What is
 * shared is only the provider-neutral primitive — `verifyHmac`
 * (`src/webhook/signature-verification.ts`) takes the framing as data and does
 * the timing-safe compare — which is the same line Linear's verifier draws for
 * its own header. Don't "unify" the two providers above that line.
 *
 * `callbackUrl` is unused: Jira signs the body alone. It stays in the input
 * shape for the providers whose schemes cover it (Trello).
 */

import { verifyHmac } from '../../../webhook/signature-verification.js';
import type { PmWebhookVerification } from '../manifest.js';

/** The header Jira puts its `sha256=<hex>` HMAC digest of the raw body in. */
export const JIRA_SIGNATURE_HEADER = 'x-hub-signature';

/** The framing Jira wraps that digest in — hex, prefixed with the algorithm. */
const JIRA_SIGNATURE_PREFIX = 'sha256=';

/**
 * Verify a Jira webhook delivery against the project's webhook signing secret.
 *
 * Fails closed when the project has no secret configured — an absent secret is
 * *not* an empty key, which anyone could sign with. A missing, wrong-prefix, or
 * wrong-length signature is rejected by the shared verifier before the
 * constant-time compare, so a garbage header value returns `false` rather than
 * throwing.
 */
export function verifyJiraWebhookSignature({
	rawBody,
	headers,
	secret,
}: PmWebhookVerification): boolean {
	if (!secret) return false;
	return verifyHmac({
		algorithm: 'sha256',
		data: rawBody,
		secret,
		signature: headers(JIRA_SIGNATURE_HEADER) ?? '',
		encoding: 'hex',
		prefix: JIRA_SIGNATURE_PREFIX,
	});
}
