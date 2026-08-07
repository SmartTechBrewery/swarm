import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
	LINEAR_SIGNATURE_HEADER,
	verifyLinearWebhookSignature,
} from '@/integrations/pm/linear/webhook.js';

const SECRET = 'lin_whsec_test';

const rawBody = JSON.stringify({
	action: 'update',
	type: 'Issue',
	data: {
		id: '0d5c3e5e-2d8e-4a3f-9f9a-0f5b1c0f0e21',
		teamId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
	},
	updatedFrom: { stateId: '9e1a4a5f-8d0c-4ea2-a27c-8142ad0297a0' },
});

/** The genuine Linear signature: a bare hex HMAC-SHA256 digest of the raw body. */
function sign(body: string, key = SECRET): string {
	return createHmac('sha256', key).update(body, 'utf8').digest('hex');
}

function verification(overrides: { secret?: string | null; signature?: string } = {}) {
	// `in` rather than `??`, so an explicit `signature: undefined` models the
	// delivery that arrives with no header at all.
	const signature = 'signature' in overrides ? overrides.signature : sign(rawBody);
	return {
		rawBody,
		headers: (name: string) =>
			name.toLowerCase() === LINEAR_SIGNATURE_HEADER ? signature : undefined,
		secret: overrides.secret === undefined ? SECRET : overrides.secret,
		// Linear signs the body alone; the callback URL is present for the providers
		// whose schemes cover it (Trello) and must not change the outcome here.
		callbackUrl: 'https://swarm.example.com/linear/webhook',
	};
}

describe('verifyLinearWebhookSignature', () => {
	it('accepts a body signed with the project secret, read from linear-signature', () => {
		expect(verifyLinearWebhookSignature(verification())).toBe(true);
	});

	it('rejects a tampered body whose signature no longer matches', () => {
		const input = verification();
		expect(
			verifyLinearWebhookSignature({ ...input, rawBody: `${rawBody.slice(0, -1)}, "x": 1}` }),
		).toBe(false);
	});

	it('rejects a signature computed with a different secret', () => {
		expect(verifyLinearWebhookSignature(verification({ signature: sign(rawBody, 'other') }))).toBe(
			false,
		);
	});

	// The framing assertion: Linear sends a *bare* hex digest, unlike GitHub's
	// `sha256=<hex>`. Accepting the prefixed form would mean the verifier had been
	// "unified" with the GitHub one — which would reject every genuine delivery.
	it('rejects a sha256=-prefixed value — Linear expects no prefix', () => {
		expect(
			verifyLinearWebhookSignature(verification({ signature: `sha256=${sign(rawBody)}` })),
		).toBe(false);
	});

	it('rejects a delivery with no signature header', () => {
		expect(verifyLinearWebhookSignature(verification({ signature: undefined }))).toBe(false);
	});

	// Fails closed: an absent secret is not an empty key, which anyone could sign
	// with. The verifier input carries `secret: string | null` because a provider
	// signing with something else entirely (Trello) must still be able to verify.
	it('fails closed when the project has no webhook secret configured', () => {
		expect(verifyLinearWebhookSignature(verification({ secret: null }))).toBe(false);
	});

	it.each([
		['too short', 'abc123'],
		['non-hex of the right length', 'z'.repeat(64)],
		['far too long', sign(rawBody).repeat(3)],
	])('rejects a %s signature without throwing', (_label, signature) => {
		expect(() => verifyLinearWebhookSignature(verification({ signature }))).not.toThrow();
		expect(verifyLinearWebhookSignature(verification({ signature }))).toBe(false);
	});

	it('ignores the callback URL — Linear signs the body alone', () => {
		const input = verification();
		expect(verifyLinearWebhookSignature({ ...input, callbackUrl: 'https://elsewhere/x' })).toBe(
			true,
		);
	});
});
