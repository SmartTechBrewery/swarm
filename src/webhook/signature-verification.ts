/**
 * HMAC signature verification for inbound webhooks — ported from Cascade's
 * `src/webhook/signatureVerification.ts`.
 *
 * Provider-neutral on purpose: each provider's own framing (algorithm, header
 * prefix, encoding) is passed in by that provider's
 * {@link import('../scm/types.js').SCMProvider.verifyWebhookSignature}
 * implementation — GitHub's `sha256=<hex>` framing lives in
 * `src/integrations/scm/github/webhook.ts` (issue #385).
 *
 * The comparison is timing-safe: a naive `===` on the digest would leak, through
 * response-time differences, how many leading bytes of a forged signature were
 * correct — enough to reconstruct a valid signature byte by byte. `timingSafeEqual`
 * closes that side channel.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface VerifyHmacOptions {
	/** HMAC algorithm, e.g. `'sha256'`. */
	algorithm: string;
	/** The raw data to sign (the exact request body bytes, as received). */
	data: string;
	/** The shared secret. */
	secret: string;
	/** The signature received from the caller. */
	signature: string;
	/** Digest encoding. */
	encoding: 'hex' | 'base64';
	/**
	 * Optional prefix the computed digest is wrapped in before comparison
	 * (`'sha256='` for GitHub). When set, the comparison string is
	 * `<prefix><digest>` and a signature missing the prefix fails fast.
	 */
	prefix?: string;
}

/**
 * Generic timing-safe HMAC verification. Returns `false` immediately for an
 * empty signature, a wrong prefix, or a length mismatch — none of which leak
 * timing information about the secret, since they're decided before the
 * constant-time compare.
 */
export function verifyHmac({
	algorithm,
	data,
	secret,
	signature,
	encoding,
	prefix = '',
}: VerifyHmacOptions): boolean {
	if (!signature) return false;
	if (prefix && !signature.startsWith(prefix)) return false;

	const digest = createHmac(algorithm, secret).update(data, 'utf8').digest(encoding);
	const expected = Buffer.from(`${prefix}${digest}`, 'utf8');
	const actual = Buffer.from(signature, 'utf8');

	// timingSafeEqual throws on differing lengths, so gate on length first — a
	// length difference is not secret-dependent, so returning here leaks nothing.
	if (expected.length !== actual.length) return false;

	return timingSafeEqual(expected, actual);
}
