import { describe, expect, it, vi } from 'vitest';

import { logger } from '@/lib/logger.js';
import { resolveWebhookCallbackUrl } from '@/router/webhook-callback-url.js';

/** Header reader over a fixed map, like Hono's case-insensitive `c.req.header`. */
function headers(values: Record<string, string>) {
	return (name: string) => values[name.toLowerCase()];
}

describe('resolveWebhookCallbackUrl', () => {
	it('uses WEBHOOK_CALLBACK_BASE_URL when set, ignoring the request headers', () => {
		vi.stubEnv('WEBHOOK_CALLBACK_BASE_URL', 'https://swarm.example.com');
		const url = resolveWebhookCallbackUrl(
			'/trello/webhook',
			headers({ host: 'attacker.example', 'x-forwarded-proto': 'http' }),
		);
		expect(url).toBe('https://swarm.example.com/trello/webhook');
	});

	// The signed string must match the provider's byte for byte, so a configured
	// trailing slash must not produce `https://host//trello/webhook`.
	it('trims a trailing slash from the configured base URL', () => {
		vi.stubEnv('WEBHOOK_CALLBACK_BASE_URL', 'https://swarm.example.com/');
		expect(resolveWebhookCallbackUrl('/trello/webhook', headers({}))).toBe(
			'https://swarm.example.com/trello/webhook',
		);
	});

	it('falls back to the request Host and X-Forwarded-Proto when the setting is unset', () => {
		vi.stubEnv('WEBHOOK_CALLBACK_BASE_URL', '');
		const url = resolveWebhookCallbackUrl(
			'/trello/webhook',
			headers({ host: 'tunnel.example.com', 'x-forwarded-proto': 'https' }),
		);
		expect(url).toBe('https://tunnel.example.com/trello/webhook');
	});

	it('assumes https when the proxy sends no X-Forwarded-Proto', () => {
		vi.stubEnv('WEBHOOK_CALLBACK_BASE_URL', '');
		expect(
			resolveWebhookCallbackUrl('/trello/webhook', headers({ host: 'tunnel.example.com' })),
		).toBe('https://tunnel.example.com/trello/webhook');
	});

	// Cascade's diagnostic: without either source the URL is unusable, and the
	// resulting signature mismatch would otherwise surface as a bare 401. Warn and
	// continue — the providers whose schemes ignore the callback URL (GitHub
	// Projects' shared HMAC) must still verify.
	it('warns naming the setting when neither the setting nor a Host header is available', () => {
		vi.stubEnv('WEBHOOK_CALLBACK_BASE_URL', '');
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

		const url = resolveWebhookCallbackUrl('/trello/webhook', headers({}));

		expect(url).toBe('https://undefined/trello/webhook');
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining('WEBHOOK_CALLBACK_BASE_URL'),
			expect.objectContaining({ route: '/trello/webhook' }),
		);
		warn.mockRestore();
	});

	it('does not warn when the setting supplies the base URL', () => {
		vi.stubEnv('WEBHOOK_CALLBACK_BASE_URL', 'https://swarm.example.com');
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		resolveWebhookCallbackUrl('/trello/webhook', headers({}));
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});
});
