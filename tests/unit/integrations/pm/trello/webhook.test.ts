import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
	TRELLO_SIGNATURE_HEADER,
	verifyTrelloWebhookSignature,
} from '@/integrations/pm/trello/webhook.js';

/** Trello's *API secret* — the secret paired with the integration's API key. */
const SECRET = 'trello_api_secret_test';

/** The callback URL the webhook was registered with, and therefore signed with. */
const CALLBACK_URL = 'https://swarm.example.com/trello/webhook';

const rawBody = JSON.stringify({
	action: {
		id: '65f0a1b2c3d4e5f60718293a',
		idMemberCreator: '5d1b2c3d4e5f60718293a4b5',
		type: 'updateCard',
		data: {
			card: { id: '65e0a1b2c3d4e5f60718293a', name: 'Wire triggers' },
			board: { id: '5f2b9c1a4e6d7f0a1b2c3d4e' },
			listBefore: { id: '6a1b2c3d4e5f60718293a4b2', name: 'Ready' },
			listAfter: { id: '6a1b2c3d4e5f60718293a4b3', name: 'In progress' },
		},
	},
	model: { id: '5f2b9c1a4e6d7f0a1b2c3d4e' },
});

/** The genuine Trello signature: base64 HMAC-SHA1 over `body + callbackUrl`. */
function sign(body: string, callbackUrl = CALLBACK_URL, key = SECRET): string {
	return createHmac('sha1', key)
		.update(body + callbackUrl, 'utf8')
		.digest('base64');
}

function verification(
	overrides: { secret?: string | null; signature?: string; callbackUrl?: string } = {},
) {
	// `in` rather than `??`, so an explicit `signature: undefined` models the
	// delivery that arrives with no header at all.
	const signature = 'signature' in overrides ? overrides.signature : sign(rawBody);
	return {
		rawBody,
		headers: (name: string) =>
			name.toLowerCase() === TRELLO_SIGNATURE_HEADER ? signature : undefined,
		secret: overrides.secret === undefined ? SECRET : overrides.secret,
		callbackUrl: overrides.callbackUrl ?? CALLBACK_URL,
	};
}

describe('verifyTrelloWebhookSignature', () => {
	it('accepts a body signed with the API secret, read from x-trello-webhook', () => {
		expect(verifyTrelloWebhookSignature(verification())).toBe(true);
	});

	it('rejects a tampered body whose signature no longer matches', () => {
		const input = verification();
		expect(
			verifyTrelloWebhookSignature({ ...input, rawBody: `${rawBody.slice(0, -1)}, "x": 1}` }),
		).toBe(false);
	});

	// The raw-body assertion: a re-serialized copy of the same JSON differs by
	// whitespace and key order, and Trello signed the bytes it sent.
	it('rejects a re-serialized copy of the same JSON', () => {
		const reserialized = JSON.stringify(JSON.parse(rawBody), null, 2);
		expect(reserialized).not.toBe(rawBody);
		expect(verifyTrelloWebhookSignature({ ...verification(), rawBody: reserialized })).toBe(false);
	});

	// The whole reason `PmWebhookVerification` carries a callback URL: Trello is
	// the one provider whose HMAC covers SWARM's own URL, so a receiver that
	// derived the wrong one (a spoofed `Host`, a missing
	// `WEBHOOK_CALLBACK_BASE_URL`) must fail rather than silently pass.
	it('rejects an otherwise-correct body verified against a different callback URL', () => {
		expect(
			verifyTrelloWebhookSignature(
				verification({ callbackUrl: 'https://elsewhere/trello/webhook' }),
			),
		).toBe(false);
	});

	it('accepts only the callback URL the delivery was signed with', () => {
		const other = 'https://tunnel.example.dev/trello/webhook';
		expect(
			verifyTrelloWebhookSignature(
				verification({ callbackUrl: other, signature: sign(rawBody, other) }),
			),
		).toBe(true);
	});

	it('rejects a signature computed with a different secret', () => {
		expect(
			verifyTrelloWebhookSignature(
				verification({ signature: sign(rawBody, CALLBACK_URL, 'other') }),
			),
		).toBe(false);
	});

	// The framing assertion: Trello sends a bare base64 SHA-1 digest, so neither
	// GitHub's/Jira's `sha256=<hex>` framing nor Linear's bare hex may be accepted
	// by a verifier that "unified" the providers.
	it('rejects the same digest encoded as hex rather than base64', () => {
		const hex = createHmac('sha1', SECRET)
			.update(rawBody + CALLBACK_URL, 'utf8')
			.digest('hex');
		expect(verifyTrelloWebhookSignature(verification({ signature: hex }))).toBe(false);
	});

	it('rejects a correctly framed SHA-256 digest (wrong algorithm)', () => {
		const sha256 = createHmac('sha256', SECRET)
			.update(rawBody + CALLBACK_URL, 'utf8')
			.digest('base64');
		expect(verifyTrelloWebhookSignature(verification({ signature: sha256 }))).toBe(false);
	});

	// Signing the body alone is the mistake a "unify it with Linear" refactor makes.
	it('rejects a digest computed over the body alone', () => {
		const bodyOnly = createHmac('sha1', SECRET).update(rawBody, 'utf8').digest('base64');
		expect(verifyTrelloWebhookSignature(verification({ signature: bodyOnly }))).toBe(false);
	});

	it('rejects a delivery with no signature header', () => {
		expect(verifyTrelloWebhookSignature(verification({ signature: undefined }))).toBe(false);
	});

	// Fails closed: an absent secret is not an empty key, which anyone could sign
	// with. The verifier input carries `secret: string | null` because a provider
	// signing with something else entirely must still be able to verify.
	it('fails closed when the project has no webhook secret configured', () => {
		expect(verifyTrelloWebhookSignature(verification({ secret: null }))).toBe(false);
	});

	it.each([
		['too short', 'abc123'],
		['non-base64 of the right length', '!'.repeat(28)],
		['far too long', sign(rawBody).repeat(3)],
		['empty', ''],
	])('rejects a %s signature without throwing', (_label, signature) => {
		expect(() => verifyTrelloWebhookSignature(verification({ signature }))).not.toThrow();
		expect(verifyTrelloWebhookSignature(verification({ signature }))).toBe(false);
	});
});
