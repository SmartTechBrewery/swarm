import { TRPCClientError } from '@trpc/client';
import { API_URL } from './api.js';

/**
 * Client-side session auth (#281 task 2). Login/logout are plain `fetch` calls to
 * the backend's Hono routes (not tRPC) because those set/clear the HTTP-only
 * session cookie; `credentials: 'include'` makes the browser send and store it.
 * The current user is read via the `auth.me` tRPC query (see `useCurrentUser`).
 *
 * No token is ever held in JS here — the session lives only in the HTTP-only
 * cookie, unreadable to scripts, which is the point of retiring the build-time
 * `VITE_DASHBOARD_TOKEN`.
 */

/** The public user shape returned by `/auth/login` and `auth.me` — never a secret. */
export interface CurrentUser {
	id: string;
	identifier: string;
	displayName: string;
	instanceAdmin: boolean;
}

export interface LoginResult {
	ok: boolean;
	/** A human-readable reason when `ok` is false (e.g. "Invalid credentials"). */
	error?: string;
}

/** POST credentials to `/auth/login`; on success the session cookie is set by the server. */
export async function login(identifier: string, password: string): Promise<LoginResult> {
	let res: Response;
	try {
		res = await fetch(`${API_URL}/auth/login`, {
			method: 'POST',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ identifier, password }),
		});
	} catch {
		return { ok: false, error: 'Could not reach the server. Is it running?' };
	}
	if (res.ok) return { ok: true };
	if (res.status === 401) return { ok: false, error: 'Invalid credentials.' };
	return { ok: false, error: 'Login failed. Please try again.' };
}

export interface SetupResult extends LoginResult {
	/** Set when the installation already has a user, so the form offers sign-in instead. */
	alreadySetUp?: boolean;
}

/**
 * POST the first-run setup form to `/auth/setup` (issue #1150): redeems the
 * one-time link the server logged, creates the first installation admin, and
 * sets the session cookie exactly as a login does.
 */
export async function completeSetup(
	token: string,
	identifier: string,
	password: string,
): Promise<SetupResult> {
	let res: Response;
	try {
		res = await fetch(`${API_URL}/auth/setup`, {
			method: 'POST',
			credentials: 'include',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ token, identifier, password }),
		});
	} catch {
		return { ok: false, error: 'Could not reach the server. Is it running?' };
	}
	if (res.ok) return { ok: true };
	if (res.status === 403) {
		return {
			ok: false,
			error:
				'This setup link is invalid, expired, or already used. Restart the SWARM server to log a new one.',
		};
	}
	if (res.status === 409) {
		return {
			ok: false,
			error: 'This installation already has a user. Sign in instead.',
			alreadySetUp: true,
		};
	}
	if (res.status === 400) {
		return { ok: false, error: 'Enter a valid e-mail address and a password.' };
	}
	return { ok: false, error: 'Setup failed. Please try again.' };
}

/** POST to `/auth/logout`; clears the session cookie server-side. Best-effort. */
export async function logout(): Promise<void> {
	try {
		await fetch(`${API_URL}/auth/logout`, { method: 'POST', credentials: 'include' });
	} catch {
		// A failed logout still drops the client-side session state; ignore.
	}
}

/** Whether a caught error is a tRPC `UNAUTHORIZED` (the session is missing/expired). */
export function isUnauthorizedError(error: unknown): boolean {
	if (error instanceof TRPCClientError) {
		return error.data?.code === 'UNAUTHORIZED' || error.data?.httpStatus === 401;
	}
	return false;
}

/**
 * Decide whether an unauthenticated caller on `pathname` should be redirected to
 * the login screen. Pure so it can be unit-tested without a router: redirect only
 * when the session query failed with an auth error and we are not already on
 * `/login` (which would loop).
 */
export function shouldRedirectToLogin(pathname: string, sessionErrored: boolean): boolean {
	return sessionErrored && pathname !== '/login';
}
