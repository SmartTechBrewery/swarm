import { TRPCClientError } from '@trpc/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	completeSetup,
	isUnauthorizedError,
	login,
	logout,
	redeemPasswordLink,
	shouldRedirectToLogin,
} from './auth.js';

describe('shouldRedirectToLogin', () => {
	it('redirects an errored session on any page except /login', () => {
		expect(shouldRedirectToLogin('/runs', true)).toBe(true);
		expect(shouldRedirectToLogin('/projects/x', true)).toBe(true);
	});

	it('does not redirect when the session is fine', () => {
		expect(shouldRedirectToLogin('/runs', false)).toBe(false);
	});

	it('never redirects while already on /login (would loop)', () => {
		expect(shouldRedirectToLogin('/login', true)).toBe(false);
		expect(shouldRedirectToLogin('/login', false)).toBe(false);
	});
});

describe('isUnauthorizedError', () => {
	it('recognizes a tRPC UNAUTHORIZED error', () => {
		const err = new TRPCClientError('Unauthorized');
		(err as unknown as { data: unknown }).data = { code: 'UNAUTHORIZED', httpStatus: 401 };
		expect(isUnauthorizedError(err)).toBe(true);
	});

	it('recognizes a 401 http status even without a code', () => {
		const err = new TRPCClientError('Unauthorized');
		(err as unknown as { data: unknown }).data = { httpStatus: 401 };
		expect(isUnauthorizedError(err)).toBe(true);
	});

	it('returns false for other errors and non-errors', () => {
		expect(isUnauthorizedError(new Error('boom'))).toBe(false);
		expect(isUnauthorizedError('nope')).toBe(false);
		expect(isUnauthorizedError(null)).toBe(false);
	});
});

describe('login', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('returns ok on a 2xx response', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
		expect(await login('ada@example.com', 'pw')).toEqual({ ok: true });
	});

	it('reports invalid credentials on 401', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));
		expect(await login('ada@example.com', 'bad')).toEqual({
			ok: false,
			error: 'Invalid credentials.',
		});
	});

	it('reports a generic failure on other non-2xx', async () => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
		const result = await login('ada@example.com', 'pw');
		expect(result.ok).toBe(false);
		expect(result.error).toBeTruthy();
	});

	it('reports a reachability error when the request throws', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
		const result = await login('ada@example.com', 'pw');
		expect(result.ok).toBe(false);
		expect(result.error).toBeTruthy();
	});

	it('posts JSON credentials with the session cookie included', async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		vi.stubGlobal('fetch', fetchMock);

		await login('ada@example.com', 'pw');

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toContain('/auth/login');
		expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
		expect(JSON.parse(init.body)).toEqual({ identifier: 'ada@example.com', password: 'pw' });
	});
});

describe('completeSetup', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('posts the token and credentials with the session cookie included', async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		vi.stubGlobal('fetch', fetchMock);

		expect(await completeSetup('tok', 'ada@example.com', 'pw')).toEqual({ ok: true });

		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toContain('/auth/setup');
		expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
		expect(JSON.parse(init.body)).toEqual({
			token: 'tok',
			identifier: 'ada@example.com',
			password: 'pw',
		});
	});

	it.each([
		[403, /invalid, expired, or already used/],
		[409, /already has a user/],
		[400, /valid e-mail/],
		[500, /Setup failed/],
	])('maps a %i response to a readable error', async (status, message) => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status }));
		const result = await completeSetup('tok', 'ada@example.com', 'pw');
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(message);
		expect(result.alreadySetUp ?? false).toBe(status === 409);
	});

	it('reports a reachability error when the request throws', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
		const result = await completeSetup('tok', 'ada@example.com', 'pw');
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/Could not reach the server/);
	});
});

describe('redeemPasswordLink', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('posts the token and password with the session cookie included', async () => {
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
		vi.stubGlobal('fetch', fetchMock);

		expect(await redeemPasswordLink('tok', 'pw')).toEqual({ ok: true });

		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toContain('/auth/set-password');
		expect(init).toMatchObject({ method: 'POST', credentials: 'include' });
		expect(JSON.parse(init.body)).toEqual({ token: 'tok', password: 'pw' });
	});

	it.each([
		[403, /invalid, expired, or already used\. Ask an installation administrator/],
		[400, /Enter a password/],
		[500, /Setting the password failed/],
	])('maps a %i response to a readable error', async (status, message) => {
		vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status }));
		const result = await redeemPasswordLink('tok', 'pw');
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(message);
	});

	it('reports a reachability error when the request throws', async () => {
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
		const result = await redeemPasswordLink('tok', 'pw');
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/Could not reach the server/);
	});
});

describe('logout', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('posts to /auth/logout with credentials and swallows failures', async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error('offline'));
		vi.stubGlobal('fetch', fetchMock);

		await expect(logout()).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledWith(
			expect.stringContaining('/auth/logout'),
			expect.objectContaining({ method: 'POST', credentials: 'include' }),
		);
	});
});
