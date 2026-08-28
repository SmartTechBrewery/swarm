import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SwarmUser } from '@/identity/schema.js';
import {
	handleOperatorLogin,
	handleOperatorLogout,
	handleOperatorWhoami,
	type OperatorSessionDeps,
	registerOperatorSession,
	resolveOperatorBearer,
} from '@/router/operator-session.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MINTED_TOKEN = 'opaque-session-token-should-never-be-reflected-on-failure';
const EXPIRES_AT = new Date('2026-09-04T00:00:00.000Z');

function makeUser(overrides: Partial<SwarmUser> = {}): SwarmUser {
	return {
		id: USER_ID,
		identifier: 'ada@example.com',
		displayName: 'Ada Lovelace',
		instanceAdmin: true,
		createdAt: new Date('2026-01-01T00:00:00Z'),
		updatedAt: new Date('2026-01-01T00:00:00Z'),
		...overrides,
	};
}

/** Fake identity services: `ada@example.com` + `correct horse` is the one live login. */
function makeDeps(overrides: Partial<OperatorSessionDeps> = {}): OperatorSessionDeps {
	return {
		verifyCredentials: vi.fn(async (identifier: string, password: string) =>
			identifier === 'ada@example.com' && password === 'correct horse' ? makeUser() : undefined,
		),
		createSession: vi.fn(async () => ({ token: MINTED_TOKEN, expiresAt: EXPIRES_AT })),
		resolveSession: vi.fn(async (token: string) =>
			token === MINTED_TOKEN ? makeUser() : undefined,
		),
		revokeSession: vi.fn(async () => {}),
		...overrides,
	};
}

/** Just enough of a Hono context for the header reader under test. */
function contextWithAuthorization(authorization?: string) {
	return {
		req: { header: (name: string) => (name === 'authorization' ? authorization : undefined) },
	} as unknown as Parameters<typeof resolveOperatorBearer>[0];
}

describe('operator session — POST (log in)', () => {
	it('mints a session for valid credentials and returns the token exactly once', async () => {
		const deps = makeDeps();

		const result = await handleOperatorLogin(deps, {
			identifier: 'ada@example.com',
			password: 'correct horse',
		});

		expect(result.status).toBe(200);
		expect(result.json).toMatchObject({
			token: MINTED_TOKEN,
			expiresAt: EXPIRES_AT.toISOString(),
			user: expect.objectContaining({ id: USER_ID, identifier: 'ada@example.com' }),
		});
		expect(deps.createSession).toHaveBeenCalledWith(USER_ID);
	});

	it('answers a wrong password and an unknown identifier identically, and mints nothing', async () => {
		const deps = makeDeps();

		const wrongPassword = await handleOperatorLogin(deps, {
			identifier: 'ada@example.com',
			password: 'hunter2',
		});
		const unknownUser = await handleOperatorLogin(deps, {
			identifier: 'nobody@example.com',
			password: 'correct horse',
		});

		expect(wrongPassword).toEqual({
			status: 401,
			json: { error: 'Unauthorized', reason: 'Invalid credentials' },
		});
		expect(unknownUser).toEqual(wrongPassword);
		expect(deps.createSession).not.toHaveBeenCalled();
	});

	it('rejects a missing or malformed body without touching the credential check', async () => {
		const deps = makeDeps();

		for (const body of [undefined, null, {}, { identifier: 'ada@example.com' }, { password: '' }]) {
			const result = await handleOperatorLogin(deps, body);
			expect(result.status).toBe(400);
			expect(result.json).toMatchObject({ error: 'Bad Request' });
		}
		expect(deps.verifyCredentials).not.toHaveBeenCalled();
	});

	it('never reflects the submitted password back to the caller', async () => {
		const deps = makeDeps();

		const result = await handleOperatorLogin(deps, {
			identifier: 'ada@example.com',
			password: 'hunter2',
		});

		expect(JSON.stringify(result.json)).not.toContain('hunter2');
	});
});

describe('operator session — GET (resolve the bearer)', () => {
	it('resolves a live token to its user', async () => {
		const result = await handleOperatorWhoami(makeDeps(), MINTED_TOKEN);

		expect(result.status).toBe(200);
		expect(result.json).toMatchObject({
			user: expect.objectContaining({ identifier: 'ada@example.com' }),
		});
	});

	it('refuses an absent, unknown, expired or revoked token with the same 401', async () => {
		const deps = makeDeps();

		const absent = await handleOperatorWhoami(deps, undefined);
		const unknown = await handleOperatorWhoami(deps, 'some-other-token');

		expect(absent).toEqual({
			status: 401,
			json: { error: 'Unauthorized', reason: 'Invalid session' },
		});
		expect(unknown).toEqual(absent);
		// An absent bearer is refused without a session lookup at all.
		expect(deps.resolveSession).toHaveBeenCalledTimes(1);
	});
});

describe('operator session — DELETE (revoke)', () => {
	it('revokes the presented token and reports success', async () => {
		const deps = makeDeps();

		const result = await handleOperatorLogout(deps, MINTED_TOKEN);

		expect(result).toEqual({ status: 200, json: { ok: true } });
		expect(deps.revokeSession).toHaveBeenCalledWith(MINTED_TOKEN);
	});

	it('is idempotent: an unknown token, or none at all, still answers 200', async () => {
		const deps = makeDeps();

		expect(await handleOperatorLogout(deps, 'some-other-token')).toEqual({
			status: 200,
			json: { ok: true },
		});
		expect(await handleOperatorLogout(deps, undefined)).toEqual({
			status: 200,
			json: { ok: true },
		});
		// Nothing to revoke means nothing is called, not a failure.
		expect(deps.revokeSession).toHaveBeenCalledTimes(1);
	});
});

describe('operator session — SWARM_SINGLE_USER_MODE', () => {
	afterEach(() => {
		delete process.env.SWARM_SINGLE_USER_MODE;
	});

	it('is ignored: the router is internet-reachable, so no request is served an implicit admin', async () => {
		process.env.SWARM_SINGLE_USER_MODE = 'true';
		const deps = makeDeps();

		// No bearer, no credentials — in single-user mode the API server would hand
		// this caller `localhost-admin`. Here it gets nothing.
		expect((await handleOperatorWhoami(deps, undefined)).status).toBe(401);
		expect((await handleOperatorLogin(deps, {})).status).toBe(400);
		expect(
			(await handleOperatorLogin(deps, { identifier: 'localhost-admin', password: 'anything' }))
				.status,
		).toBe(401);
	});
});

describe('resolveOperatorBearer', () => {
	it('reads the token out of an Authorization: Bearer header, case-insensitively', () => {
		expect(resolveOperatorBearer(contextWithAuthorization(`Bearer ${MINTED_TOKEN}`))).toBe(
			MINTED_TOKEN,
		);
		expect(resolveOperatorBearer(contextWithAuthorization(`bearer ${MINTED_TOKEN}`))).toBe(
			MINTED_TOKEN,
		);
	});

	it('returns undefined for a missing, empty or non-bearer header', () => {
		expect(resolveOperatorBearer(contextWithAuthorization(undefined))).toBeUndefined();
		expect(resolveOperatorBearer(contextWithAuthorization('Bearer'))).toBeUndefined();
		expect(resolveOperatorBearer(contextWithAuthorization('Basic dXNlcjpwYXNz'))).toBeUndefined();
	});
});

// The three cases above drive the pure handlers; these drive the real Hono
// registration, so a route mounted on the wrong method or path — which the
// handler tests cannot see — fails here.
describe('registerOperatorSession — the mounted routes', () => {
	function appWith(deps: OperatorSessionDeps): Hono {
		const app = new Hono();
		registerOperatorSession(app, deps);
		return app;
	}

	it('mounts POST/GET/DELETE on /operator/session', async () => {
		const app = appWith(makeDeps());

		const login = await app.request('/operator/session', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ identifier: 'ada@example.com', password: 'correct horse' }),
		});
		expect(login.status).toBe(200);
		const minted = (await login.json()) as { token: string };
		expect(minted.token).toBe(MINTED_TOKEN);

		const whoami = await app.request('/operator/session', {
			headers: { authorization: `Bearer ${minted.token}` },
		});
		expect(whoami.status).toBe(200);
		expect(await whoami.json()).toMatchObject({
			user: expect.objectContaining({ identifier: 'ada@example.com' }),
		});

		const revoke = await app.request('/operator/session', {
			method: 'DELETE',
			headers: { authorization: `Bearer ${minted.token}` },
		});
		expect(revoke.status).toBe(200);
		expect(await revoke.json()).toEqual({ ok: true });
	});

	it('answers a non-JSON login body with 400 rather than an unhandled throw', async () => {
		const deps = makeDeps();
		const response = await appWith(deps).request('/operator/session', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: 'not json at all',
		});

		expect(response.status).toBe(400);
		expect(deps.verifyCredentials).not.toHaveBeenCalled();
	});

	it('refuses a GET carrying no bearer', async () => {
		const response = await appWith(makeDeps()).request('/operator/session');

		expect(response.status).toBe(401);
	});
});
