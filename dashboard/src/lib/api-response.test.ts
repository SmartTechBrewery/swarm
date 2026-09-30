import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiUnavailableMessage, assertApiResponse, isJsonResponse } from './api-response.js';
import { trpcClient } from './trpc.js';

/** What the Vite proxy / Cloudflare tunnel answer with while the API restarts. */
function proxyErrorPage(status = 502): Response {
	return new Response('<!DOCTYPE html><html><body>Bad gateway</body></html>', {
		status,
		headers: { 'content-type': 'text/html; charset=UTF-8' },
	});
}

describe('isJsonResponse', () => {
	it('accepts the API’s JSON, charset parameter and error statuses included', () => {
		expect(isJsonResponse(Response.json([]))).toBe(true);
		expect(
			isJsonResponse(
				new Response('[]', {
					status: 500,
					headers: { 'content-type': 'application/json; charset=utf-8' },
				}),
			),
		).toBe(true);
	});

	it('rejects an HTML error page and a body with no type at all', () => {
		expect(isJsonResponse(proxyErrorPage())).toBe(false);
		expect(isJsonResponse(new Response(null, { status: 500 }))).toBe(false);
	});
});

describe('assertApiResponse', () => {
	it('passes a JSON response through untouched', () => {
		const response = Response.json({ ok: true });
		expect(assertApiResponse(response)).toBe(response);
	});

	it('throws the unavailable message, naming the status, for anything else', () => {
		expect(() => assertApiResponse(proxyErrorPage(502))).toThrow(apiUnavailableMessage(502));
	});
});

describe('trpcClient on a non-JSON answer (issue #1051)', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('reports the API as unavailable instead of a JSON parse error', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue(proxyErrorPage(502)));
		const failure = trpcClient.auth.me.query();
		await expect(failure).rejects.toThrow(apiUnavailableMessage(502));
		await expect(failure).rejects.not.toThrow(/Unexpected token|not valid JSON/);
	});
});
