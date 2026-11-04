import { describe, expect, it } from 'vitest';

import {
	describeProviderUnavailable,
	isProviderServerError,
	ProviderUnavailableError,
} from '@/lib/provider-errors.js';

/** A provider client error the way Octokit and every `*ApiError` carry it. */
const withStatus = (status: number, message = `failed (${status})`) =>
	Object.assign(new Error(message), { status });

describe('isProviderServerError', () => {
	it.each([500, 502, 503, 504])('recognises a provider %i', (status) => {
		expect(isProviderServerError(withStatus(status))).toBe(true);
	});

	it('recognises a ProviderUnavailableError, which carries no status', () => {
		expect(isProviderServerError(new ProviderUnavailableError('GitHub API unavailable'))).toBe(
			true,
		);
	});

	it('recognises a 5xx wrapped as the cause of another error', () => {
		const wrapped = new Error('Planning could not move the card', { cause: withStatus(502) });
		expect(isProviderServerError(wrapped)).toBe(true);
	});

	it.each([401, 403, 404, 422, 429])('leaves a client-side %i alone', (status) => {
		expect(isProviderServerError(withStatus(status))).toBe(false);
	});

	it('leaves a plain error, a string status and a non-error alone', () => {
		expect(isProviderServerError(new Error('boom'))).toBe(false);
		expect(isProviderServerError(Object.assign(new Error('x'), { status: '502' }))).toBe(false);
		expect(isProviderServerError({ status: 502 })).toBe(false);
		expect(isProviderServerError(undefined)).toBe(false);
	});

	it('survives a cyclic cause chain', () => {
		const a = new Error('a');
		const b = new Error('b', { cause: a });
		(a as { cause?: unknown }).cause = b;
		expect(isProviderServerError(a)).toBe(false);
	});
});

describe('describeProviderUnavailable', () => {
	it("prefixes the provider's own message", () => {
		expect(describeProviderUnavailable(withStatus(502, '502 Bad Gateway'))).toBe(
			'Provider unavailable: 502 Bad Gateway',
		);
	});

	it('strips an HTML error page, collapses whitespace and truncates', () => {
		const page = `<html>\n<head><title>502 Bad Gateway</title></head>\n<body>${'x'.repeat(800)}</body></html>`;
		const text = describeProviderUnavailable(withStatus(502, page));

		expect(text).not.toMatch(/[<>]/);
		expect(text).not.toMatch(/\s{2,}/);
		expect(text.startsWith('Provider unavailable: 502 Bad Gateway')).toBe(true);
		expect(text.length).toBeLessThanOrEqual('Provider unavailable: '.length + 300);
	});

	it('does not prefix a text that already names a provider outage', () => {
		const relayed = new ProviderUnavailableError(
			'Control-plane delivery /worker/delivery/pm/move failed with status 502: Provider unavailable: 502 Bad Gateway',
		);
		expect(describeProviderUnavailable(relayed)).toBe(relayed.message);
	});
});
