/**
 * Bitbucket Cloud API client with `AsyncLocalStorage`-scoped credentials — the
 * Bitbucket twin of `../github/client.ts` (issue #296, phase 1/4).
 *
 * The credential is never a function argument. `withBitbucketCredential(cred, fn)`
 * binds it to the async context for the duration of `fn`, and every Bitbucket
 * request pulls it from that context via `getScopedCredential()`. That keeps
 * secrets out of call signatures, stack traces, and logs
 * (ai/CODING_STANDARDS.md "Scope credentials with AsyncLocalStorage") and is what
 * lets the implementer and reviewer personas run concurrently without one
 * leaking into the other's calls.
 *
 * Unlike GitHub, what gets bound is the **credential string**, not a client
 * object: Bitbucket has no Octokit equivalent, so requests are built per call
 * over the global `fetch` (Node 22 — no new npm dependency).
 *
 * Bitbucket **Cloud** only; Bitbucket Server / Data Center is out of scope.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { logger } from '../../../lib/logger.js';
import { abbreviateBitbucketSha } from './commits.js';

/** Bitbucket Cloud's REST base — every path below is relative to it. */
export const BITBUCKET_API_BASE = 'https://api.bitbucket.org/2.0';

/** Expected origin for Bitbucket API responses — used to reject off-origin pagination links. */
export const BITBUCKET_API_ORIGIN = new URL(BITBUCKET_API_BASE).origin;

/** Cap on the maximum number of pages `paginateBitbucket` will fetch. */
export const MAX_PAGES = 100;

/** Cap on how much of a non-JSON error body is echoed into a thrown message. */
const MAX_ERROR_BODY_CHARS = 200;

const credentialStorage = new AsyncLocalStorage<string>();

/**
 * The Bitbucket credential bound to the current async context. Throws if called
 * outside a `withBitbucketCredential` scope — an operation running without a
 * credential in scope is a bug (a missing wrap), not a recoverable condition.
 */
export function getScopedCredential(): string {
	const scoped = credentialStorage.getStore();
	if (!scoped) {
		throw new Error(
			'No Bitbucket credential in scope. Wrap the call in withBitbucketCredential() (or the SCM integration’s withPersonaCredentials()).',
		);
	}
	return scoped;
}

/** Run `fn` with `credential` bound to the async context. */
export function withBitbucketCredential<T>(credential: string, fn: () => Promise<T>): Promise<T> {
	return credentialStorage.run(credential, fn);
}

/**
 * A non-2xx Bitbucket response. `status` deliberately mirrors Octokit's
 * `RequestError#status`, which is the field the GitHub adapter's merge-outcome
 * classifier reads — so `classifyBitbucketDirectMergeError`
 * (`./scm-integration.ts`) reads it the same way instead of inventing a second
 * error shape.
 */
export class BitbucketApiError extends Error {
	constructor(
		readonly status: number,
		readonly method: string,
		readonly path: string,
		readonly detail: string,
	) {
		super(`Bitbucket API ${method} ${path} failed (${status}): ${detail}`);
		this.name = 'BitbucketApiError';
	}
}

/**
 * The only place that branches on the credential's *form*.
 *
 * A Bitbucket **app password** is usable only as HTTP Basic
 * `username:app_password`, and it is the one credential form that can answer
 * `GET /2.0/user` — workspace and repository access tokens cannot, so persona
 * identity resolution (`./personas.ts`) needs it. Anything without a colon is an
 * access token, sent as a bearer.
 */
function authorizationHeader(credential: string): string {
	if (credential.includes(':')) {
		return `Basic ${Buffer.from(credential).toString('base64')}`;
	}
	return `Bearer ${credential}`;
}

/**
 * The same credential as an HTTP Basic `user:password` pair, for the one caller
 * that cannot use {@link authorizationHeader}: `git push` over HTTPS, which
 * Bitbucket only accepts as Basic (there is no bearer form on the git endpoint).
 * An access token authenticates as the reserved `x-token-auth` user; an app
 * password already *is* the pair.
 *
 * Kept here so this module stays the only place that branches on the credential's
 * form — the caller base64-encodes the result into a git `extraheader`
 * (`./scm-integration.ts`) and never inspects it.
 */
export function bitbucketGitBasicCredential(credential: string): string {
	return credential.includes(':') ? credential : `x-token-auth:${credential}`;
}

/**
 * Bitbucket's error envelope is `{ error: { message, detail } }`. A proxy or
 * maintenance page answers with HTML instead, so fall back to a truncated slice
 * of the raw body rather than losing the diagnostic entirely. The response body
 * never contains the credential, so echoing it is safe.
 */
function detailFromErrorBody(body: string): string {
	try {
		const message = (JSON.parse(body) as { error?: { message?: unknown } } | null)?.error?.message;
		if (typeof message === 'string' && message !== '') return message;
	} catch {
		// Not JSON — fall through to the raw slice below.
	}
	return body.slice(0, MAX_ERROR_BODY_CHARS) || '<empty response body>';
}

async function bitbucketFetch<T>(method: string, url: string, body?: unknown): Promise<T> {
	const response = await fetch(url, {
		method,
		headers: {
			authorization: authorizationHeader(getScopedCredential()),
			accept: 'application/json',
			...(body === undefined ? {} : { 'content-type': 'application/json' }),
		},
		redirect: 'manual',
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});

	if (!response.ok) {
		// The path, not the full URL: a query string adds nothing an operator can act
		// on and is the one part of a request a future call site could put data in.
		throw new BitbucketApiError(
			response.status,
			method,
			new URL(url).pathname,
			detailFromErrorBody(await response.text()),
		);
	}
	// Bitbucket answers 204 for successful deletes/some merges; `.json()` on an
	// empty body throws a bare SyntaxError, which reads as a client bug.
	if (response.status === 204) return undefined as T;
	return (await response.json()) as T;
}

/** One Bitbucket Cloud request against `path` (relative to {@link BITBUCKET_API_BASE}). */
export function bitbucketRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
	return bitbucketFetch<T>(method, `${BITBUCKET_API_BASE}${path}`, body);
}

/** One page of a Bitbucket collection — `next` is an absolute URL, absent on the last page. */
interface BitbucketPage<T> {
	values?: T[];
	next?: string;
}

/**
 * Follow Bitbucket's `next` cursor and flatten every page's `values`. Page bounds
 * are capped at {@link MAX_PAGES} to prevent infinite pagination loops, and any
 * `next` cursor pointing to a different origin or non-HTTPS URL is rejected.
 * Cyclic cursors are also detected and thrown.
 */
export async function paginateBitbucket<T>(path: string): Promise<T[]> {
	const collected: T[] = [];
	const fetched = new Set<string>();
	let nextUrl: string | undefined = `${BITBUCKET_API_BASE}${path}`;

	while (nextUrl) {
		// Read out of the cursor before the request: assigning the next cursor back
		// into the loop variable would make its narrowed type depend on the response
		// it is used to fetch (TS7022).
		const url: string = nextUrl;
		const parsedUrl = new URL(url, BITBUCKET_API_BASE);
		if (parsedUrl.protocol !== 'https:' || parsedUrl.origin !== BITBUCKET_API_ORIGIN) {
			throw new Error(
				`Bitbucket pagination rejected cross-origin or non-HTTPS cursor ${parsedUrl.origin} — refusing to follow off-origin next link`,
			);
		}
		if (fetched.size >= MAX_PAGES) {
			throw new Error(
				`Bitbucket pagination exceeded maximum page count of ${MAX_PAGES} — refusing to follow endless next cursor`,
			);
		}
		if (fetched.has(url)) {
			throw new Error(
				`Bitbucket pagination revisited ${parsedUrl.pathname} — refusing to follow a cyclic next cursor`,
			);
		}
		fetched.add(url);
		const page = await bitbucketFetch<BitbucketPage<T>>('GET', url);
		if (page.values) collected.push(...page.values);
		nextUrl = page.next;
	}

	return collected;
}

/**
 * The commit a branch currently points at, or `null` when Bitbucket answers
 * without naming one.
 *
 * A {@link BitbucketApiError} **propagates**, including a 404: this adapter never
 * flattens an unreadable read into an ordinary answer, and "no such branch" and
 * "this credential cannot see this repository" are the same response
 * ({@link SCMProvider.getBranchHead}).
 *
 * The hash is narrowed to Bitbucket's 12-character spelling (`./commits.ts`)
 * because `target.hash` on this endpoint is the full 40-character form, and every
 * SHA this adapter emits has to be the one spelling its exact-match consumers
 * compare against — an unnarrowed value would silently split one commit into two.
 */
export async function getBitbucketBranchHead(
	workspace: string,
	slug: string,
	branch: string,
): Promise<string | null> {
	const ref = await bitbucketRequest<{ target?: { hash?: string } }>(
		'GET',
		`/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}/refs/branches/${encodeURIComponent(branch)}`,
	);
	return abbreviateBitbucketSha(ref.target?.hash) ?? null;
}

/**
 * Resolve the Bitbucket login a credential authenticates as, or `null` when it is
 * absent or the lookup fails — the same contract as `getGitHubUserForToken`, for
 * the same reason: one bad credential must not take down persona resolution, and
 * the caller decides whether a missing identity is fatal (`./personas.ts` says
 * yes).
 *
 * Bitbucket removed `username` from its API, so `nickname` is the closest thing
 * to a login. Returns `user.nickname ?? null` — an account without a nickname
 * returns `null` so persona resolution fails closed rather than caching an
 * `account_id` string that webhook actor nickname comparisons can never match.
 */
export async function getBitbucketUserForCredential(
	credential: string | null,
): Promise<string | null> {
	if (!credential) return null;
	try {
		const user = await withBitbucketCredential(credential, () =>
			bitbucketRequest<{ nickname?: string; account_id?: string }>('GET', '/user'),
		);
		return user.nickname ?? null;
	} catch (err) {
		// `BitbucketApiError` is built from method/path/status/response body only, so
		// this can't leak the credential.
		logger.warn('Failed to resolve Bitbucket identity for credential', { error: String(err) });
		return null;
	}
}

/** One address from `GET /2.0/user/emails`. */
interface BitbucketUserEmail {
	email?: string;
	is_primary?: boolean;
	is_confirmed?: boolean;
}

/**
 * The primary **confirmed** email of the account the scoped credential
 * authenticates as, or `null` when Bitbucket won't say — the commit-author address
 * a delivery signs its commits with (`./scm-integration.ts`).
 *
 * `null` rather than a throw for every failure mode, because they are all ordinary:
 * `GET /user/emails` needs the `email` scope, which a workspace or repository
 * access token cannot hold at all, and an account whose primary address is
 * unconfirmed has nothing usable to report. The caller substitutes a documented
 * placeholder; a missing scope must not fail a delivery.
 */
export async function getScopedBitbucketUserEmail(): Promise<string | null> {
	try {
		const addresses = await paginateBitbucket<BitbucketUserEmail>('/user/emails');
		const primary = addresses.find((entry) => entry.is_primary === true && entry.is_confirmed);
		return primary?.email ?? null;
	} catch (err) {
		logger.warn('Failed to resolve a Bitbucket commit-author email', { error: String(err) });
		return null;
	}
}
