/**
 * Trello webhook authentication — the provider's `verifyWebhookSignature`
 * (`PMProviderManifest`, issue #496), kept in the provider folder beside the
 * GitHub Projects, Linear, and Jira verifiers so Trello's header name and
 * signature framing never reach the receiver.
 *
 * Three things here must not be "unified" away with another provider's verifier:
 *
 * - **SHA-1, base64, bare.** Trello puts the base64 digest of an HMAC-**SHA1** in
 *   `x-trello-webhook` — not GitHub's and Jira's `sha256=<hex>` framing, and not
 *   Linear's bare SHA-256 hex. What is shared is only the provider-neutral
 *   primitive: `verifyHmac` (`src/webhook/signature-verification.ts`) already
 *   takes the algorithm and the encoding as data and does the timing-safe
 *   compare, so this needs no crypto of its own. Don't route it through another
 *   provider's verifier above that line.
 * - **The HMAC covers `rawBody + callbackUrl`** — the one SWARM provider whose
 *   signature includes SWARM's *own* URL, which is why
 *   `PmWebhookVerification.callbackUrl` exists at all. It must stay the receiver's
 *   value (`src/router/webhook-callback-url.ts`, preferring
 *   `WEBHOOK_CALLBACK_BASE_URL` — the base URL the webhook was actually
 *   registered with), never a URL re-derived here from a spoofable `Host`
 *   header: the signed string has to match the subscription's callback exactly,
 *   and a caller-controlled value in a signed string is a caller-controlled
 *   signature input.
 * - **The secret is Trello's API secret**, not a per-webhook secret SWARM
 *   generates: Trello signs every delivery for an integration with the secret
 *   paired to its API key. The manifest (`./index.ts`) declares it under
 *   `PM_WEBHOOK_SECRET_ROLE` (`../manifest.ts`) because the receiver resolves
 *   exactly that one role for a verifier — the role name is the receiver's
 *   vocabulary, and the credential behind it is Trello's `TRELLO_API_SECRET`.
 *
 * **No replay-window check**, for the same reason Linear's verifier carries none:
 * a board event is only a doorbell, and the pipeline re-reads the card's state
 * authoritatively downstream and dedupes (`src/triggers/handlers/pm-status.ts`,
 * `pm-status-dedup.ts`).
 */

import { verifyHmac } from '../../../webhook/signature-verification.js';
import type { PmWebhookVerification } from '../manifest.js';

/** The header Trello puts its base64 HMAC-SHA1 digest in (no prefix). */
export const TRELLO_SIGNATURE_HEADER = 'x-trello-webhook';

/**
 * Verify a Trello webhook delivery against the project's Trello API secret.
 *
 * Fails closed when the project has no secret configured — an absent secret is
 * *not* an empty key, which anyone could sign with. A missing, malformed, or
 * wrong-length signature is rejected by the shared verifier before the
 * constant-time compare, so a garbage header value returns `false` rather than
 * throwing.
 */
export function verifyTrelloWebhookSignature({
	rawBody,
	headers,
	secret,
	callbackUrl,
}: PmWebhookVerification): boolean {
	if (!secret) return false;
	return verifyHmac({
		algorithm: 'sha1',
		// Trello signs the body *concatenated with* the callback URL it delivers to —
		// see this module's header for why that URL is the receiver's to supply.
		data: rawBody + callbackUrl,
		secret,
		signature: headers(TRELLO_SIGNATURE_HEADER) ?? '',
		encoding: 'base64',
	});
}
