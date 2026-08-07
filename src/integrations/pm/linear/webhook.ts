/**
 * Linear webhook authentication — the provider's `verifyWebhookSignature`
 * (`PMProviderManifest`, issue #496), kept in the provider folder beside the
 * GitHub Projects verifier so Linear's header name and signature framing never
 * reach the receiver.
 *
 * **Hex, with no prefix.** Linear puts a bare HMAC-SHA256 hex digest of the raw
 * body in `linear-signature`, where GitHub sends `sha256=<hex>` in
 * `x-hub-signature-256` and Jira frames its own differently again. So this must
 * *not* be routed through the GitHub-shaped verifier
 * (`../github-projects/webhook.ts` → `verifyGitHubSignature`): that one requires
 * the `sha256=` prefix and would reject every genuine Linear delivery. What is
 * shared is only the provider-neutral primitive — `verifyHmac`
 * (`src/webhook/signature-verification.ts`) takes the framing as data and does
 * the timing-safe compare, which is exactly the seam its own header describes.
 * Don't "unify" the two providers above that line.
 *
 * `callbackUrl` is unused: Linear signs the body alone. It stays in the input
 * shape for the providers whose schemes cover it (Trello).
 *
 * **No replay-window check, deliberately.** Linear recommends rejecting a
 * delivery whose `webhookTimestamp` is more than 60s old. SWARM does not: a
 * board event is only a doorbell here — the pipeline re-reads the card's state
 * authoritatively downstream and dedupes (`src/triggers/handlers/pm-status.ts`,
 * `pm-status-dedup.ts`), so a replayed delivery resolves to the state the card
 * is *already* in and does nothing. Add the window only with a real need.
 */

import { verifyHmac } from '../../../webhook/signature-verification.js';
import type { PmWebhookVerification } from '../manifest.js';

/** The header Linear puts its raw HMAC-SHA256 hex digest in (no prefix). */
export const LINEAR_SIGNATURE_HEADER = 'linear-signature';

/**
 * Verify a Linear webhook delivery against the project's webhook signing secret.
 *
 * Fails closed when the project has no secret configured — an absent secret is
 * *not* an empty key, which anyone could sign with. A missing, malformed, or
 * wrong-length signature is rejected by the shared verifier before the
 * constant-time compare, so a garbage header value returns `false` rather than
 * throwing.
 */
export function verifyLinearWebhookSignature({
	rawBody,
	headers,
	secret,
}: PmWebhookVerification): boolean {
	if (!secret) return false;
	return verifyHmac({
		algorithm: 'sha256',
		data: rawBody,
		secret,
		signature: headers(LINEAR_SIGNATURE_HEADER) ?? '',
		encoding: 'hex',
	});
}
