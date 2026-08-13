import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/projectsRepository.js', () => ({
	findProjectByRepoFromDb: vi.fn(),
	findProjectByBoardFromDb: vi.fn(),
	findProjectByIdFromDb: vi.fn(),
	upsertProjectToDb: vi.fn(),
	createProjectInDb: vi.fn(),
	deleteProjectFromDb: vi.fn(),
	listAllProjectRecordsFromDb: vi.fn(),
	getProjectByIdFromDb: vi.fn(),
}));

vi.mock('@/identity/auth.js', () => ({
	verifyCredentials: vi.fn(),
	createSession: vi.fn(),
	resolveSession: vi.fn(),
	resolveSingleUser: vi.fn(),
	revokeSession: vi.fn(),
}));

vi.mock('@/identity/membership-service.js', () => ({
	getMembership: vi.fn(),
	listAccessibleProjectIds: vi.fn(),
}));

// The single-user context re-reads its user per request (issue #662), so the
// read seam is mocked here; `isInstanceAdmin` is supplied so the module's other
// consumers aren't left undefined.
vi.mock('@/identity/service.js', () => ({
	getUser: vi.fn(),
	isInstanceAdmin: vi.fn(),
	renameUser: vi.fn(),
}));

import { createApiApp, SESSION_COOKIE_NAME } from '@/api/server.js';
import { listAllProjectRecordsFromDb } from '@/db/repositories/projectsRepository.js';
import {
	createSession,
	resolveSession,
	resolveSingleUser,
	revokeSession,
	verifyCredentials,
} from '@/identity/auth.js';
import { listAccessibleProjectIds } from '@/identity/membership-service.js';
import type { SwarmUser } from '@/identity/schema.js';
import { getUser } from '@/identity/service.js';

const user: SwarmUser = {
	id: '11111111-1111-4111-8111-111111111111',
	identifier: 'ada@example.com',
	displayName: 'Ada',
	instanceAdmin: false,
	createdAt: new Date('2020-01-01T00:00:00Z'),
	updatedAt: new Date('2020-01-01T00:00:00Z'),
};

const RAW_TOKEN = 'raw-session-token';

describe('swarm-api', () => {
	beforeEach(() => {
		// Keep the default-CORS assertions deterministic regardless of the ambient env.
		delete process.env.CORS_ORIGIN;
		// Keep the single-user policy off unless a test opts in via the app option,
		// so the default-mode assertions don't depend on the ambient env.
		delete process.env.SWARM_SINGLE_USER_MODE;
		vi.mocked(listAllProjectRecordsFromDb).mockReset();
		vi.mocked(verifyCredentials).mockReset();
		vi.mocked(createSession).mockReset();
		vi.mocked(resolveSession).mockReset();
		vi.mocked(resolveSingleUser).mockReset();
		vi.mocked(revokeSession).mockReset().mockResolvedValue(undefined);
		vi.mocked(listAccessibleProjectIds).mockReset();
		vi.mocked(getUser).mockReset();
	});

	describe('public routes', () => {
		it('serves /health without authentication', async () => {
			const app = createApiApp();
			const res = await app.request('/health');

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				status: 'ok',
				service: 'swarm-api',
				timestamp: expect.any(String),
			});
		});

		it('serves the ping query without a session (it stays public)', async () => {
			const app = createApiApp();
			const res = await app.request('/trpc/ping.ping');

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({
				result: { data: { message: 'pong', timestamp: expect.any(String) } },
			});
		});
	});

	describe('authed procedures', () => {
		it('returns 401 for an authed procedure with no session cookie', async () => {
			const app = createApiApp();
			const res = await app.request('/trpc/projects.list');

			expect(res.status).toBe(401);
			expect(listAllProjectRecordsFromDb).not.toHaveBeenCalled();
		});

		it('serves an authed procedure when the session cookie resolves to a user', async () => {
			vi.mocked(resolveSession).mockResolvedValue(user);
			vi.mocked(listAllProjectRecordsFromDb).mockResolvedValue([]);
			vi.mocked(listAccessibleProjectIds).mockResolvedValue([]);

			const app = createApiApp();
			const res = await app.request('/trpc/projects.list', {
				headers: { Cookie: `${SESSION_COOKIE_NAME}=${RAW_TOKEN}` },
			});

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ result: { data: [] } });
			expect(resolveSession).toHaveBeenCalledWith(RAW_TOKEN);
			expect(listAllProjectRecordsFromDb).toHaveBeenCalledTimes(1);
		});

		it('returns 401 when the session cookie no longer resolves to a user', async () => {
			vi.mocked(resolveSession).mockResolvedValue(undefined);

			const app = createApiApp();
			const res = await app.request('/trpc/projects.list', {
				headers: { Cookie: `${SESSION_COOKIE_NAME}=stale` },
			});

			expect(res.status).toBe(401);
			expect(listAllProjectRecordsFromDb).not.toHaveBeenCalled();
		});
	});

	describe('single-user mode (SWARM_SINGLE_USER_MODE)', () => {
		const admin: SwarmUser = {
			...user,
			identifier: 'localhost-admin',
			displayName: 'Local Admin',
			instanceAdmin: true,
		};

		it('serves auth.me from the bootstrapped admin with no session cookie', async () => {
			vi.mocked(resolveSingleUser).mockResolvedValue(admin);
			vi.mocked(getUser).mockResolvedValue(admin);

			const app = createApiApp({ singleUserMode: true });
			const res = await app.request('/trpc/auth.me');

			expect(res.status).toBe(200);
			const body = await res.json();
			expect(body.result.data).toMatchObject({
				identifier: 'localhost-admin',
				instanceAdmin: true,
			});
			// The cookie/session path is never consulted in single-user mode.
			expect(resolveSession).not.toHaveBeenCalled();
		});

		it('serves a protected procedure with no cookie and without resolveSession', async () => {
			vi.mocked(resolveSingleUser).mockResolvedValue(admin);
			vi.mocked(getUser).mockResolvedValue(admin);
			vi.mocked(listAllProjectRecordsFromDb).mockResolvedValue([]);

			const app = createApiApp({ singleUserMode: true });
			const res = await app.request('/trpc/projects.list');

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ result: { data: [] } });
			expect(resolveSession).not.toHaveBeenCalled();
			expect(listAllProjectRecordsFromDb).toHaveBeenCalledTimes(1);
		});

		it('bootstraps the admin once across requests', async () => {
			vi.mocked(resolveSingleUser).mockResolvedValue(admin);
			vi.mocked(getUser).mockResolvedValue(admin);

			const app = createApiApp({ singleUserMode: true });
			await app.request('/trpc/auth.me');
			await app.request('/trpc/auth.me');

			expect(resolveSingleUser).toHaveBeenCalledTimes(1);
		});

		it('re-reads the admin per request, so a self-service change is visible at once', async () => {
			// Issue #662: caching the whole user for the app's lifetime would keep
			// reporting the old name until the process restarted.
			vi.mocked(resolveSingleUser).mockResolvedValue(admin);
			vi.mocked(getUser)
				.mockResolvedValueOnce(admin)
				.mockResolvedValueOnce({ ...admin, displayName: 'Ada Lovelace' });

			const app = createApiApp({ singleUserMode: true });
			const first = await app.request('/trpc/auth.me');
			const second = await app.request('/trpc/auth.me');

			expect((await first.json()).result.data.displayName).toBe('Local Admin');
			expect((await second.json()).result.data.displayName).toBe('Ada Lovelace');
			expect(getUser).toHaveBeenCalledWith(admin.id);
		});

		it('falls back to the bootstrap when the row is momentarily unreadable', async () => {
			vi.mocked(resolveSingleUser).mockResolvedValue(admin);
			vi.mocked(getUser).mockResolvedValue(undefined);

			const app = createApiApp({ singleUserMode: true });
			const res = await app.request('/trpc/auth.me');

			expect(res.status).toBe(200);
			expect((await res.json()).result.data).toMatchObject({ identifier: 'localhost-admin' });
		});

		it('explicitly disabled: still 401s without a cookie and never bootstraps an admin', async () => {
			const app = createApiApp({ singleUserMode: false });
			const res = await app.request('/trpc/projects.list');

			expect(res.status).toBe(401);
			expect(resolveSingleUser).not.toHaveBeenCalled();
			expect(listAllProjectRecordsFromDb).not.toHaveBeenCalled();
		});

		it('explicitly disabled: still resolves a valid cookie exactly as today', async () => {
			vi.mocked(resolveSession).mockResolvedValue(user);
			vi.mocked(listAllProjectRecordsFromDb).mockResolvedValue([]);
			vi.mocked(listAccessibleProjectIds).mockResolvedValue([]);

			const app = createApiApp({ singleUserMode: false });
			const res = await app.request('/trpc/projects.list', {
				headers: { Cookie: `${SESSION_COOKIE_NAME}=${RAW_TOKEN}` },
			});

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ result: { data: [] } });
			expect(resolveSession).toHaveBeenCalledWith(RAW_TOKEN);
			expect(resolveSingleUser).not.toHaveBeenCalled();
		});
	});

	describe('POST /auth/login', () => {
		it('sets an HTTP-only session cookie and returns the user (never the token)', async () => {
			vi.mocked(verifyCredentials).mockResolvedValue(user);
			vi.mocked(createSession).mockResolvedValue({
				token: RAW_TOKEN,
				expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
			});

			const app = createApiApp();
			const res = await app.request('http://example.com/auth/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ identifier: 'ada@example.com', password: 'hunter2' }),
			});

			expect(res.status).toBe(200);
			const body = await res.json();
			// Dates serialize to ISO strings over JSON, so match the identity fields.
			expect(body.user).toMatchObject({
				id: user.id,
				identifier: user.identifier,
				displayName: user.displayName,
				instanceAdmin: user.instanceAdmin,
			});
			expect(JSON.stringify(body)).not.toContain(RAW_TOKEN);

			const setCookie = res.headers.get('set-cookie') ?? '';
			expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=${RAW_TOKEN}`);
			expect(setCookie).toMatch(/HttpOnly/i);
			expect(setCookie).toMatch(/SameSite=Strict/i);
		});

		it('marks the cookie Secure off localhost but not on localhost', async () => {
			vi.mocked(verifyCredentials).mockResolvedValue(user);
			vi.mocked(createSession).mockResolvedValue({
				token: RAW_TOKEN,
				expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
			});

			const app = createApiApp();
			const body = JSON.stringify({ identifier: 'ada@example.com', password: 'hunter2' });
			const headers = { 'Content-Type': 'application/json' };

			const remote = await app.request('http://example.com/auth/login', {
				method: 'POST',
				headers,
				body,
			});
			expect(remote.headers.get('set-cookie') ?? '').toMatch(/Secure/i);

			const local = await app.request('http://localhost/auth/login', {
				method: 'POST',
				headers,
				body,
			});
			expect(local.headers.get('set-cookie') ?? '').not.toMatch(/Secure/i);
		});

		it('returns 401 with no cookie for invalid credentials', async () => {
			vi.mocked(verifyCredentials).mockResolvedValue(undefined);

			const app = createApiApp();
			const res = await app.request('http://example.com/auth/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ identifier: 'ada@example.com', password: 'wrong' }),
			});

			expect(res.status).toBe(401);
			expect(res.headers.get('set-cookie')).toBeNull();
			expect(createSession).not.toHaveBeenCalled();
		});

		it('returns 400 for a malformed body', async () => {
			const app = createApiApp();
			const res = await app.request('http://example.com/auth/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ identifier: 'ada@example.com' }),
			});

			expect(res.status).toBe(400);
			expect(verifyCredentials).not.toHaveBeenCalled();
		});
	});

	describe('POST /auth/logout', () => {
		it('revokes the session and clears the cookie', async () => {
			const app = createApiApp();
			const res = await app.request('http://example.com/auth/logout', {
				method: 'POST',
				headers: { Cookie: `${SESSION_COOKIE_NAME}=${RAW_TOKEN}` },
			});

			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ ok: true });
			expect(revokeSession).toHaveBeenCalledWith(RAW_TOKEN);

			const setCookie = res.headers.get('set-cookie') ?? '';
			expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
			expect(setCookie).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
		});

		it('is a no-op (still 200) with no session cookie', async () => {
			const app = createApiApp();
			const res = await app.request('http://example.com/auth/logout', { method: 'POST' });

			expect(res.status).toBe(200);
			expect(revokeSession).not.toHaveBeenCalled();
		});
	});

	describe('CORS (credentialed, for the separate-origin dev setup)', () => {
		it('answers a pre-flight from the Vite dev origin with credentialed CORS headers', async () => {
			// Reproduces the reviewer's case: SPA on http://localhost:5173, API on
			// API_PORT. The credentialed POST /auth/login is pre-flighted.
			const app = createApiApp();
			const res = await app.request('http://127.0.0.1:3101/auth/login', {
				method: 'OPTIONS',
				headers: {
					Origin: 'http://localhost:5173',
					'Access-Control-Request-Method': 'POST',
					'Access-Control-Request-Headers': 'content-type',
				},
			});

			expect(res.status).toBeLessThan(300);
			expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
			expect(res.headers.get('access-control-allow-credentials')).toBe('true');
			// Never the wildcard — illegal alongside credentials.
			expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
		});

		it('reflects the configured CORS_ORIGIN allow-list and rejects others', async () => {
			const app = createApiApp({ corsOrigin: 'https://dash.example.com' });

			const allowed = await app.request('http://api.example.com/auth/login', {
				method: 'OPTIONS',
				headers: {
					Origin: 'https://dash.example.com',
					'Access-Control-Request-Method': 'POST',
				},
			});
			expect(allowed.headers.get('access-control-allow-origin')).toBe('https://dash.example.com');
			expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');

			const other = await app.request('http://api.example.com/auth/login', {
				method: 'OPTIONS',
				headers: {
					Origin: 'https://evil.example.com',
					'Access-Control-Request-Method': 'POST',
				},
			});
			expect(other.headers.get('access-control-allow-origin')).not.toBe('https://evil.example.com');
		});

		it('exposes credentialed CORS on /trpc as well', async () => {
			const app = createApiApp();
			const res = await app.request('http://127.0.0.1:3101/trpc/projects.list', {
				method: 'OPTIONS',
				headers: {
					Origin: 'http://localhost:5173',
					'Access-Control-Request-Method': 'POST',
				},
			});

			expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
			expect(res.headers.get('access-control-allow-credentials')).toBe('true');
		});
	});

	describe('static assets', () => {
		it('serves static assets without authentication', async () => {
			const app = createApiApp({ staticRoot: 'tests/fixtures/dashboard-dist' });
			const res = await app.request('/assets/app.js');

			expect(res.status).toBe(200);
			expect(res.headers.get('Content-Type')).toContain('javascript');
			expect(await res.text()).toContain('Hello from web-dist app.js fixture!');
		});

		it('falls back to index.html for client-side routes without authentication', async () => {
			const app = createApiApp({ staticRoot: 'tests/fixtures/dashboard-dist' });
			const res = await app.request('/login');

			expect(res.status).toBe(200);
			expect(res.headers.get('Content-Type')).toContain('html');
			expect(await res.text()).toContain('Hello from web-dist fixture!');
		});

		it('returns 404 for unknown routes when no static assets exist', async () => {
			const app = createApiApp({ staticRoot: './non-existent-dist' });
			const res = await app.request('/nope');

			expect(res.status).toBe(404);
		});
	});
});
