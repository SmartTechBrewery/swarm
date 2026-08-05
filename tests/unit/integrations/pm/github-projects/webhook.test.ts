import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { verifyGitHubProjectsWebhookSignature } from '@/integrations/pm/github-projects/webhook.js';

const rawBody = JSON.stringify({
	action: 'edited',
	projects_v2_item: { node_id: 'PVTI_1', project_node_id: 'PVT_1' },
});

function verification(overrides: { secret?: string | null; signature?: string } = {}) {
	const secret = overrides.secret === undefined ? 'whsec' : overrides.secret;
	const signature =
		overrides.signature ??
		`sha256=${createHmac('sha256', 'whsec').update(rawBody, 'utf8').digest('hex')}`;
	return {
		rawBody,
		headers: (name: string) =>
			name.toLowerCase() === 'x-hub-signature-256' ? signature : undefined,
		secret,
		// GitHub signs the body alone; the callback URL is present for the providers
		// whose schemes cover it (Trello) and must not change the outcome here.
		callbackUrl: 'https://swarm.example.com/github/webhook',
	};
}

describe('verifyGitHubProjectsWebhookSignature', () => {
	it('accepts a body signed with the shared secret, read from X-Hub-Signature-256', () => {
		expect(verifyGitHubProjectsWebhookSignature(verification())).toBe(true);
	});

	it('rejects a signature computed with a different secret', () => {
		expect(verifyGitHubProjectsWebhookSignature(verification({ secret: 'other-secret' }))).toBe(
			false,
		);
	});

	it('rejects a delivery with no signature header', () => {
		expect(verifyGitHubProjectsWebhookSignature(verification({ signature: '' }))).toBe(false);
	});

	// Fails closed: an absent secret is not an empty key, which anyone could sign
	// with. The verifier input carries `secret: string | null` because a provider
	// signing with something else entirely (Trello) must still be able to verify.
	it('fails closed when the project has no webhook secret configured', () => {
		expect(verifyGitHubProjectsWebhookSignature(verification({ secret: null }))).toBe(false);
	});

	it('ignores the callback URL — GitHub signs the body alone', () => {
		const input = verification();
		expect(
			verifyGitHubProjectsWebhookSignature({ ...input, callbackUrl: 'https://elsewhere/x' }),
		).toBe(true);
	});
});
