import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
	JIRA_SIGNATURE_HEADER,
	verifyJiraWebhookSignature,
} from '@/integrations/pm/jira/webhook.js';

const SECRET = 'jira_whsec_test';

const rawBody = JSON.stringify({
	webhookEvent: 'jira:issue_updated',
	issue: { key: 'SWARM-42', fields: { project: { key: 'SWARM' } } },
	changelog: { items: [{ fieldId: 'status', from: '10000', to: '3' }] },
});

/** The genuine Jira signature: `sha256=` + the hex HMAC-SHA256 digest of the raw body. */
function sign(body: string, key = SECRET): string {
	return `sha256=${createHmac('sha256', key).update(body, 'utf8').digest('hex')}`;
}

function verification(overrides: { secret?: string | null; signature?: string } = {}) {
	// `in` rather than `??`, so an explicit `signature: undefined` models the
	// delivery that arrives with no header at all.
	const signature = 'signature' in overrides ? overrides.signature : sign(rawBody);
	return {
		rawBody,
		headers: (name: string) =>
			name.toLowerCase() === JIRA_SIGNATURE_HEADER ? signature : undefined,
		secret: overrides.secret === undefined ? SECRET : overrides.secret,
		// Jira signs the body alone; the callback URL is present for the providers
		// whose schemes cover it (Trello) and must not change the outcome here.
		callbackUrl: 'https://swarm.example.com/jira/webhook',
	};
}

describe('verifyJiraWebhookSignature', () => {
	it('accepts a body signed with the project secret, read from x-hub-signature', () => {
		expect(verifyJiraWebhookSignature(verification())).toBe(true);
	});

	it('rejects a tampered body whose signature no longer matches', () => {
		const input = verification();
		expect(
			verifyJiraWebhookSignature({ ...input, rawBody: `${rawBody.slice(0, -1)}, "x": 1}` }),
		).toBe(false);
	});

	// The raw-body assertion: a re-serialized copy of the same JSON differs by
	// whitespace and key order, and Jira signed the bytes it sent.
	it('rejects a re-serialized copy of the same JSON', () => {
		const reserialized = JSON.stringify(JSON.parse(rawBody), null, 2);
		expect(reserialized).not.toBe(rawBody);
		expect(verifyJiraWebhookSignature({ ...verification(), rawBody: reserialized })).toBe(false);
	});

	it('rejects a signature computed with a different secret', () => {
		expect(verifyJiraWebhookSignature(verification({ signature: sign(rawBody, 'other') }))).toBe(
			false,
		);
	});

	// The framing assertion: Jira wraps its digest exactly as GitHub does, so a
	// bare hex digest — Linear's shape — must be rejected rather than accepted by
	// a verifier that dropped the prefix check.
	it('rejects a bare hex digest with no sha256= prefix', () => {
		expect(
			verifyJiraWebhookSignature(verification({ signature: sign(rawBody).replace('sha256=', '') })),
		).toBe(false);
	});

	it('rejects a correctly signed digest framed with another algorithm', () => {
		expect(
			verifyJiraWebhookSignature(
				verification({ signature: sign(rawBody).replace('sha256=', 'sha1=') }),
			),
		).toBe(false);
	});

	it('rejects a delivery with no signature header', () => {
		expect(verifyJiraWebhookSignature(verification({ signature: undefined }))).toBe(false);
	});

	// Fails closed: an absent secret is not an empty key, which anyone could sign
	// with. The verifier input carries `secret: string | null` because a provider
	// signing with something else entirely (Trello) must still be able to verify.
	it('fails closed when the project has no webhook secret configured', () => {
		expect(verifyJiraWebhookSignature(verification({ secret: null }))).toBe(false);
	});

	it.each([
		['too short', 'sha256=abc123'],
		['non-hex of the right length', `sha256=${'z'.repeat(64)}`],
		['far too long', sign(rawBody).repeat(3)],
		['prefix only', 'sha256='],
	])('rejects a %s signature without throwing', (_label, signature) => {
		expect(() => verifyJiraWebhookSignature(verification({ signature }))).not.toThrow();
		expect(verifyJiraWebhookSignature(verification({ signature }))).toBe(false);
	});

	it('ignores the callback URL — Jira signs the body alone', () => {
		const input = verification();
		expect(verifyJiraWebhookSignature({ ...input, callbackUrl: 'https://elsewhere/x' })).toBe(true);
	});
});
