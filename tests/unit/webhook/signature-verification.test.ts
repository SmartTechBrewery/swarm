import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { verifyHmac } from '@/webhook/signature-verification.js';

const SECRET = 'test-webhook-secret';
const BODY = '{"action":"opened","number":1}';

// GitHub's own `sha256=<hex>` framing moved into the provider with issue #385 —
// it is covered by `tests/unit/integrations/scm/github/webhook.test.ts`. What's
// left here is the provider-neutral primitive every provider's framing builds on.
describe('verifyHmac', () => {
	it('accepts a digest computed with the matching secret', () => {
		const digest = createHmac('sha256', SECRET).update(BODY, 'utf8').digest('hex');
		expect(
			verifyHmac({
				algorithm: 'sha256',
				data: BODY,
				secret: SECRET,
				signature: digest,
				encoding: 'hex',
			}),
		).toBe(true);
	});

	it('rejects a digest computed with a different secret', () => {
		const digest = createHmac('sha256', 'wrong').update(BODY, 'utf8').digest('hex');
		expect(
			verifyHmac({
				algorithm: 'sha256',
				data: BODY,
				secret: SECRET,
				signature: digest,
				encoding: 'hex',
			}),
		).toBe(false);
	});

	it('rejects an empty signature', () => {
		expect(
			verifyHmac({
				algorithm: 'sha256',
				data: BODY,
				secret: SECRET,
				signature: '',
				encoding: 'hex',
			}),
		).toBe(false);
	});

	it('rejects a signature missing the configured prefix', () => {
		const bare = createHmac('sha256', SECRET).update(BODY, 'utf8').digest('hex');
		expect(
			verifyHmac({
				algorithm: 'sha256',
				data: BODY,
				secret: SECRET,
				signature: bare,
				encoding: 'hex',
				prefix: 'sha256=',
			}),
		).toBe(false);
	});

	it('rejects a signature of the wrong length without throwing', () => {
		expect(
			verifyHmac({
				algorithm: 'sha256',
				data: BODY,
				secret: SECRET,
				signature: 'deadbeef',
				encoding: 'hex',
			}),
		).toBe(false);
	});

	it('supports base64 encoding without a prefix', () => {
		const digest = createHmac('sha1', SECRET).update(BODY, 'utf8').digest('base64');
		expect(
			verifyHmac({
				algorithm: 'sha1',
				data: BODY,
				secret: SECRET,
				signature: digest,
				encoding: 'base64',
			}),
		).toBe(true);
	});
});
