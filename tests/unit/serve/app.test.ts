import { beforeEach, describe, expect, it, vi } from 'vitest';

// Nothing here may reach Postgres: the session reads behind `/auth/*` and
// `/operator/session` are mocked, as in tests/unit/api/server.test.ts.
vi.mock('@/identity/auth.js', () => ({
	verifyCredentials: vi.fn(),
	createSession: vi.fn(),
	resolveSession: vi.fn(),
	resolveSingleUser: vi.fn(),
	revokeSession: vi.fn(),
}));

import { createAllInOneApp } from '@/serve/app.js';

const STATIC_ROOT = 'tests/fixtures/dashboard-dist';

function buildApp() {
	return createAllInOneApp({ api: { staticRoot: STATIC_ROOT, singleUserMode: false } }).app;
}

describe('createAllInOneApp (issue #1148)', () => {
	beforeEach(() => {
		delete process.env.CORS_ORIGIN;
	});

	it('serves a single /health — the router’s', async () => {
		const res = await buildApp().request('/health');

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: 'ok', service: 'router' });
	});

	it('answers a provider webhook ping instead of the SPA shell', async () => {
		const res = await buildApp().request('/github/webhook');

		expect(res.status).toBe(200);
		expect(await res.text()).toBe('OK');
	});

	it('answers GET /operator/session from the router, not with index.html', async () => {
		const res = await buildApp().request('/operator/session');

		expect(res.status).toBe(401);
		expect(res.headers.get('Content-Type')).toContain('json');
	});

	it('serves the worker handshake route', async () => {
		const res = await buildApp().request('/worker/session', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: 'not json',
		});

		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({ authenticated: false });
	});

	it('serves the API’s auth and tRPC routes', async () => {
		const app = buildApp();

		const login = await app.request('/auth/login', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: '{}',
		});
		expect(login.status).toBe(400);

		const ping = await app.request('/trpc/ping.ping');
		expect(ping.status).toBe(200);
		expect(JSON.stringify(await ping.json())).toContain('pong');
	});

	it('serves the dashboard for a client-side route and 404s a missing asset', async () => {
		const app = buildApp();

		const deepLink = await app.request('/some/deep/link');
		expect(deepLink.status).toBe(200);
		expect(deepLink.headers.get('Cache-Control')).toContain('no-store');
		expect(await deepLink.text()).toContain('Hello from web-dist fixture!');

		const missing = await app.request('/assets/missing.js');
		expect(missing.status).toBe(404);
	});

	it('still answers a dashboard CORS preflight for /trpc', async () => {
		const res = await buildApp().request('/trpc/ping.ping', {
			method: 'OPTIONS',
			headers: {
				Origin: 'http://localhost:5173',
				'Access-Control-Request-Method': 'GET',
			},
		});

		expect(res.status).toBe(204);
		expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
	});
});
