import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { promptHidden, readStdin } = vi.hoisted(() => ({
	promptHidden: vi.fn(),
	readStdin: vi.fn(),
}));
const {
	readOperatorSessionCache,
	writeOperatorSessionCache,
	clearOperatorSessionCache,
	operatorSessionCachePath,
} = vi.hoisted(() => ({
	readOperatorSessionCache: vi.fn(),
	writeOperatorSessionCache: vi.fn(),
	clearOperatorSessionCache: vi.fn(),
	operatorSessionCachePath: vi.fn(),
}));

vi.mock('@/cli/_shared/secret-input.js', () => ({ promptHidden, readStdin }));
vi.mock('@/cli/_shared/operator-session-cache.js', () => ({
	readOperatorSessionCache,
	writeOperatorSessionCache,
	clearOperatorSessionCache,
	operatorSessionCachePath,
}));

import { run } from '@/cli/commands/login.js';

const CONTROL_PLANE = 'https://swarm.example.com';
const CACHE_PATH = '/home/ada/.swarm/operator-sessions/abc123/session.json';
const TOKEN = 'opaque-session-token';
const EXPIRES_AT = '2026-09-04T00:00:00.000Z';

const USER = { id: 'user-1', identifier: 'ada@example.com', displayName: 'Ada Lovelace' };

type FakeResponse = { status: number; body?: unknown };

/** Queue one fake HTTP answer per call, in order; `null` stands for a transport failure. */
function stubFetch(...answers: (FakeResponse | null)[]) {
	const fetchMock = vi.fn(async () => {
		const next = answers.shift();
		if (!next) throw new Error('connect ECONNREFUSED');
		return {
			status: next.status,
			json: async () => next.body,
		} as unknown as Response;
	});
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

function printed(): string {
	const log = vi.mocked(console.log).mock.calls.flat().join('\n');
	const err = vi.mocked(console.error).mock.calls.flat().join('\n');
	const warn = vi.mocked(console.warn).mock.calls.flat().join('\n');
	return [log, err, warn].join('\n');
}

function cachedSession(overrides: Record<string, unknown> = {}) {
	return {
		controlPlaneUrl: CONTROL_PLANE,
		token: TOKEN,
		userId: USER.id,
		identifier: USER.identifier,
		expiresAt: EXPIRES_AT,
		createdAt: '2026-08-28T00:00:00.000Z',
		...overrides,
	};
}

describe('swarm login', () => {
	const originalIsTTY = process.stdin.isTTY;

	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		process.env.SWARM_CONTROL_PLANE_URL = CONTROL_PLANE;
		// Not a TTY by default: the password comes from stdin and `--identifier`
		// supplies the handle, which is the scriptable path.
		Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
		promptHidden.mockReset();
		readStdin.mockReset().mockResolvedValue('correct horse');
		readOperatorSessionCache.mockReset().mockReturnValue(null);
		writeOperatorSessionCache.mockReset().mockReturnValue(CACHE_PATH);
		clearOperatorSessionCache.mockReset().mockReturnValue(true);
		operatorSessionCachePath.mockReset().mockReturnValue(CACHE_PATH);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		delete process.env.SWARM_CONTROL_PLANE_URL;
		Object.defineProperty(process.stdin, 'isTTY', {
			value: originalIsTTY,
			configurable: true,
		});
	});

	it('logs in, verifies the minted token, caches it, and prints no secret', async () => {
		const fetchMock = stubFetch(
			{ status: 200, body: { token: TOKEN, expiresAt: EXPIRES_AT, user: USER } },
			{ status: 200, body: { user: USER } },
		);

		expect(await run(['--identifier', 'ada@example.com'])).toBe(0);

		// POST to log in, then GET with the minted bearer to prove it authenticates.
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const [loginUrl, loginInit] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(loginUrl).toBe(`${CONTROL_PLANE}/operator/session`);
		expect(loginInit.method).toBe('POST');
		expect(loginInit.body).toBe(
			JSON.stringify({ identifier: 'ada@example.com', password: 'correct horse' }),
		);
		const [verifyUrl, verifyInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
		expect(verifyUrl).toBe(`${CONTROL_PLANE}/operator/session`);
		expect(verifyInit.method).toBe('GET');
		expect((verifyInit.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);

		expect(writeOperatorSessionCache).toHaveBeenCalledWith(
			expect.objectContaining({
				controlPlaneUrl: CONTROL_PLANE,
				token: TOKEN,
				userId: USER.id,
				identifier: USER.identifier,
				expiresAt: EXPIRES_AT,
			}),
		);

		const output = printed();
		expect(output).toContain("signed in to https://swarm.example.com as 'ada@example.com'");
		expect(output).toContain(CACHE_PATH);
		// Neither secret is ever printed.
		expect(output).not.toContain(TOKEN);
		expect(output).not.toContain('correct horse');
	});

	it('never puts the token in a URL', async () => {
		const fetchMock = stubFetch(
			{ status: 200, body: { token: TOKEN, expiresAt: EXPIRES_AT, user: USER } },
			{ status: 200, body: { user: USER } },
		);

		await run(['--identifier', 'ada@example.com']);

		for (const call of fetchMock.mock.calls) {
			expect(String((call as unknown as [string])[0])).not.toContain(TOKEN);
		}
	});

	it('fails with one line and a non-zero exit on rejected credentials, caching nothing', async () => {
		stubFetch({ status: 401, body: { error: 'Unauthorized', reason: 'Invalid credentials' } });

		expect(await run(['--identifier', 'ada@example.com'])).toBe(1);
		expect(printed()).toContain('login failed — check the identifier and password');
		expect(writeOperatorSessionCache).not.toHaveBeenCalled();
	});

	it('fails when the control plane is unreachable', async () => {
		stubFetch(null);

		expect(await run(['--identifier', 'ada@example.com'])).toBe(1);
		expect(printed()).toContain('could not reach the control plane');
		expect(writeOperatorSessionCache).not.toHaveBeenCalled();
	});

	it('revokes an unverified minted token after a verification transport failure', async () => {
		const fetchMock = stubFetch(
			{ status: 200, body: { token: TOKEN, expiresAt: EXPIRES_AT, user: USER } },
			null,
			{ status: 200, body: { ok: true } },
		);

		expect(await run(['--identifier', 'ada@example.com'])).toBe(1);
		expect(writeOperatorSessionCache).not.toHaveBeenCalled();
		const [, , revokeInit] = fetchMock.mock.calls as unknown as [
			[string, RequestInit],
			[string, RequestInit],
			[string, RequestInit],
		];
		expect(revokeInit[1].method).toBe('DELETE');
		expect((revokeInit[1].headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
	});

	it('revokes an unverified minted token after a rejected verification', async () => {
		const fetchMock = stubFetch(
			{ status: 200, body: { token: TOKEN, expiresAt: EXPIRES_AT, user: USER } },
			{ status: 401, body: { error: 'Unauthorized' } },
			{ status: 200, body: { ok: true } },
		);

		expect(await run(['--identifier', 'ada@example.com'])).toBe(1);
		expect(writeOperatorSessionCache).not.toHaveBeenCalled();
		const [, , revokeInit] = fetchMock.mock.calls as unknown as [
			[string, RequestInit],
			[string, RequestInit],
			[string, RequestInit],
		];
		expect(revokeInit[1].method).toBe('DELETE');
		expect((revokeInit[1].headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
	});

	it('identifies an unexpected successful login response as version skew', async () => {
		stubFetch({ status: 200, body: { token: TOKEN } });

		expect(await run(['--identifier', 'ada@example.com'])).toBe(1);
		expect(printed()).toContain('unexpected response');
		expect(printed()).not.toContain('HTTP 200');
		expect(writeOperatorSessionCache).not.toHaveBeenCalled();
	});

	it('fails when SWARM_CONTROL_PLANE_URL is unset', async () => {
		delete process.env.SWARM_CONTROL_PLANE_URL;
		const fetchMock = stubFetch();

		expect(await run([])).toBe(1);
		expect(printed()).toContain('SWARM_CONTROL_PLANE_URL is unset');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('fails when SWARM_CONTROL_PLANE_URL is not an http(s) URL', async () => {
		process.env.SWARM_CONTROL_PLANE_URL = 'ws://swarm.example.com';
		const fetchMock = stubFetch();

		expect(await run([])).toBe(1);
		expect(printed()).toContain('must be an http(s) URL');
		expect(fetchMock).not.toHaveBeenCalled();

		process.env.SWARM_CONTROL_PLANE_URL = 'not a url';
		expect(await run([])).toBe(1);
		expect(printed()).toContain('is not a valid URL');
	});

	it('refuses a piped login with no --identifier, since stdin carries the password', async () => {
		const fetchMock = stubFetch();

		expect(await run([])).toBe(1);
		expect(printed()).toContain('--identifier <id> is required');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('reads the password without echo on a TTY, never from argv', async () => {
		Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
		promptHidden.mockResolvedValue('correct horse');
		stubFetch(
			{ status: 200, body: { token: TOKEN, expiresAt: EXPIRES_AT, user: USER } },
			{ status: 200, body: { user: USER } },
		);

		expect(await run(['--identifier', 'ada@example.com'])).toBe(0);
		expect(promptHidden).toHaveBeenCalledTimes(1);
		expect(readStdin).not.toHaveBeenCalled();
	});
});

describe('swarm login --status', () => {
	const originalIsTTY = process.stdin.isTTY;

	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		process.env.SWARM_CONTROL_PLANE_URL = CONTROL_PLANE;
		Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
		readOperatorSessionCache.mockReset().mockReturnValue(null);
		operatorSessionCachePath.mockReset().mockReturnValue(CACHE_PATH);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		delete process.env.SWARM_CONTROL_PLANE_URL;
		Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
	});

	it('reports "not signed in" on an empty cache without calling the control plane', async () => {
		const fetchMock = stubFetch();

		expect(await run(['--status'])).toBe(1);
		expect(printed()).toContain('not signed in — run `swarm login`');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('reports an unreadable cache entry as its own problem', async () => {
		readOperatorSessionCache.mockReturnValue(undefined);
		const fetchMock = stubFetch();

		expect(await run(['--status'])).toBe(1);
		expect(printed()).toContain('could not be read');
		expect(printed()).toContain(CACHE_PATH);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('asks the control plane who the cached token resolves to', async () => {
		readOperatorSessionCache.mockReturnValue(cachedSession());
		const fetchMock = stubFetch({ status: 200, body: { user: USER } });

		expect(await run(['--status'])).toBe(0);
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(init.method).toBe('GET');
		expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
		const output = printed();
		expect(output).toContain("signed in to https://swarm.example.com as 'ada@example.com'");
		expect(output).toContain(EXPIRES_AT);
		expect(output).not.toContain(TOKEN);
	});

	it('says a cached-but-rejected session needs a fresh login', async () => {
		readOperatorSessionCache.mockReturnValue(cachedSession());
		stubFetch({ status: 401, body: { error: 'Unauthorized' } });

		expect(await run(['--status'])).toBe(1);
		expect(printed()).toContain('the cached session was rejected (expired or revoked)');
	});

	it('identifies an unexpected successful cached-session response as version skew', async () => {
		readOperatorSessionCache.mockReturnValue(cachedSession());
		stubFetch({ status: 200, body: { user: { identifier: USER.identifier } } });

		expect(await run(['--status'])).toBe(1);
		expect(printed()).toContain('unexpected response');
		expect(printed()).not.toContain('HTTP 200');
	});
});

describe('swarm login --logout', () => {
	const originalIsTTY = process.stdin.isTTY;

	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		process.env.SWARM_CONTROL_PLANE_URL = CONTROL_PLANE;
		Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });
		readOperatorSessionCache.mockReset().mockReturnValue(cachedSession());
		clearOperatorSessionCache.mockReset().mockReturnValue(true);
		operatorSessionCachePath.mockReset().mockReturnValue(CACHE_PATH);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		delete process.env.SWARM_CONTROL_PLANE_URL;
		Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
	});

	it('revokes the session server-side and clears the cache', async () => {
		const fetchMock = stubFetch({ status: 200, body: { ok: true } });

		expect(await run(['--logout'])).toBe(0);
		const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(init.method).toBe('DELETE');
		expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
		expect(clearOperatorSessionCache).toHaveBeenCalledWith(CONTROL_PLANE);
	});

	it('clears the local copy even when the revocation fails, and says the session stays live', async () => {
		stubFetch(null);

		expect(await run(['--logout'])).toBe(1);
		expect(clearOperatorSessionCache).toHaveBeenCalledWith(CONTROL_PLANE);
		const output = printed();
		expect(output).toContain('removed the local session');
		expect(output).toContain('did not confirm the revocation');
	});

	it('is a no-op when nothing is cached', async () => {
		readOperatorSessionCache.mockReturnValue(null);
		const fetchMock = stubFetch();

		expect(await run(['--logout'])).toBe(0);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(clearOperatorSessionCache).not.toHaveBeenCalled();
		expect(printed()).toContain('not signed in — nothing to revoke');
	});

	it('deletes an unreadable entry it cannot revoke, and says so', async () => {
		readOperatorSessionCache.mockReturnValue(undefined);
		const fetchMock = stubFetch();

		expect(await run(['--logout'])).toBe(1);
		expect(fetchMock).not.toHaveBeenCalled();
		expect(clearOperatorSessionCache).toHaveBeenCalledWith(CONTROL_PLANE);
		expect(printed()).toContain('nothing was revoked');
	});

	it('refuses --status and --logout together', async () => {
		expect(await run(['--status', '--logout'])).toBe(1);
		expect(printed()).toContain('mutually exclusive');
	});
});
