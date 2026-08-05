/**
 * GitLab REST v4 API client with `AsyncLocalStorage`-scoped credentials — the
 * GitLab twin of `../bitbucket/client.ts` (issue #295, phase 1/4).
 *
 * The token is never a function argument. `withGitLabToken(token, fn)` binds it
 * to the async context for the duration of `fn`, and every GitLab request pulls
 * it from that context via `getScopedToken()`. That keeps secrets out of call
 * signatures, stack traces, and logs (ai/CODING_STANDARDS.md "Scope credentials
 * with AsyncLocalStorage") and is what lets the implementer and reviewer personas
 * run concurrently without one leaking into the other's calls.
 *
 * Like Bitbucket and unlike GitHub, what gets bound is the **token string**, not
 * a client object: requests are built per call over the global `fetch` (Node 22 —
 * no new npm dependency).
 *
 * There is deliberately **no branch on the credential's form**, which Bitbucket
 * needs: a GitLab personal, group, or project access token all authenticate the
 * same way — the `PRIVATE-TOKEN` header — and all resolve `GET /user`. Don't
 * reintroduce Bitbucket's `Basic`/`Bearer` fork here.
 *
 * **GitLab.com only** (`https://gitlab.com/api/v4`). A self-managed instance
 * would need its own base URL, which is a new project-config field this phase
 * deliberately does not add. Likewise **no subgroup paths**: a project is
 * addressed by `ProjectConfig.repo`, which `src/config/schema.ts` validates as
 * exactly two segments, so `group/subgroup/project` is out of scope rather than
 * half-supported.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { logger } from '../../../lib/logger.js';

/** GitLab.com's REST v4 base — every path below is relative to it. */
export const GITLAB_API_BASE = 'https://gitlab.com/api/v4';

/** Cap on the number of pages {@link paginateGitLab} will fetch. */
export const MAX_PAGES = 100;

/** Items per page — GitLab's documented maximum for offset pagination. */
export const PER_PAGE = 100;

/** Cap on how much of a non-JSON error body is echoed into a thrown message. */
const MAX_ERROR_BODY_CHARS = 200;

/** Cap on how much of a malformed pagination cursor is echoed into a thrown message. */
const MAX_CURSOR_CHARS = 20;

const tokenStorage = new AsyncLocalStorage<string>();

/**
 * The GitLab token bound to the current async context. Throws if called outside
 * a `withGitLabToken` scope — an operation running without a token in scope is a
 * bug (a missing wrap), not a recoverable condition.
 */
export function getScopedToken(): string {
	const scoped = tokenStorage.getStore();
	if (!scoped) {
		throw new Error(
			'No GitLab token in scope. Wrap the call in withGitLabToken() (or the SCM integration’s withPersonaCredentials()).',
		);
	}
	return scoped;
}

/** Run `fn` with `token` bound to the async context. */
export function withGitLabToken<T>(token: string, fn: () => Promise<T>): Promise<T> {
	return tokenStorage.run(token, fn);
}

/**
 * A non-2xx GitLab response. `status` deliberately mirrors Octokit's
 * `RequestError#status` and `BitbucketApiError#status`, which is the field both
 * adapters' merge-outcome classifiers read — so GitLab's (phase 4/4) can be
 * written the same way instead of inventing a third error shape.
 */
export class GitLabApiError extends Error {
	constructor(
		readonly status: number,
		readonly method: string,
		readonly path: string,
		readonly detail: string,
	) {
		super(`GitLab API ${method} ${path} failed (${status}): ${detail}`);
		this.name = 'GitLabApiError';
	}
}

/**
 * Flatten one GitLab error value into a message. Unlike Bitbucket's single
 * `{ error: { message } }` shape, GitLab's `message` is a string for a plain
 * failure (`"404 Project Not Found"`), an array for a validation failure
 * (`["is invalid"]`), or an object keyed by field
 * (`{ name: ["has already been taken"] }`).
 */
function flattenErrorValue(value: unknown): string {
	if (typeof value === 'string') return value;
	if (Array.isArray(value)) return value.map(flattenErrorValue).filter(Boolean).join('; ');
	if (typeof value === 'object' && value !== null) {
		return Object.entries(value)
			.map(([key, nested]) => `${key}: ${flattenErrorValue(nested)}`)
			.join('; ');
	}
	return '';
}

/**
 * GitLab's error envelope is `{ message }` (the API's own errors) or `{ error }`
 * (OAuth/auth failures). A proxy or maintenance page answers with HTML instead,
 * so fall back to a truncated slice of the raw body rather than losing the
 * diagnostic entirely. The response body never contains the token, so echoing it
 * is safe.
 */
function detailFromErrorBody(body: string): string {
	try {
		const parsed = JSON.parse(body) as { message?: unknown; error?: unknown } | null;
		const detail = flattenErrorValue(parsed?.message) || flattenErrorValue(parsed?.error);
		if (detail !== '') return detail;
	} catch {
		// Not JSON — fall through to the raw slice below.
	}
	return body.slice(0, MAX_ERROR_BODY_CHARS) || '<empty response body>';
}

/** Issue one authenticated request, throwing {@link GitLabApiError} for a non-2xx. */
async function gitlabFetch(method: string, url: string, body?: unknown): Promise<Response> {
	const response = await fetch(url, {
		method,
		headers: {
			'private-token': getScopedToken(),
			accept: 'application/json',
			...(body === undefined ? {} : { 'content-type': 'application/json' }),
		},
		redirect: 'manual',
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});

	if (!response.ok) {
		// The path, not the full URL: a query string adds nothing an operator can act
		// on and is the one part of a request a future call site could put data in.
		throw new GitLabApiError(
			response.status,
			method,
			new URL(url).pathname,
			detailFromErrorBody(await response.text()),
		);
	}
	return response;
}

/**
 * GitLab answers 204 for successful deletes and some accepted writes; `.json()`
 * on an empty body throws a bare `SyntaxError`, which reads as a client bug
 * rather than as an empty response.
 */
async function readJsonBody<T>(response: Response): Promise<T> {
	if (response.status === 204) return undefined as T;
	const text = await response.text();
	if (text === '') return undefined as T;
	return JSON.parse(text) as T;
}

/** One GitLab.com request against `path` (relative to {@link GITLAB_API_BASE}). */
export async function gitlabRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
	return readJsonBody<T>(await gitlabFetch(method, `${GITLAB_API_BASE}${path}`, body));
}

/** The request URL for one page of `path`, preserving any query the caller already set. */
function pageUrl(path: string, page: string): string {
	const url = new URL(`${GITLAB_API_BASE}${path}`);
	url.searchParams.set('per_page', String(PER_PAGE));
	url.searchParams.set('page', page);
	return url.toString();
}

/**
 * Walk GitLab's offset pagination and flatten every page — a list endpoint
 * returns a bare JSON array, and the `x-next-page` response header carries the
 * next page index (empty once exhausted).
 *
 * Bitbucket's paginator guards a server-supplied *URL* (`next`), so it asserts
 * same-origin and HTTPS on every cursor it follows. GitLab's cursor is a page
 * *number* appended to a URL this module builds from a constant base, so no
 * off-origin link is reachable and such an assertion would be dead code. The
 * equivalent "don't trust the server's cursor" guard here is the format check
 * below — plus the same {@link MAX_PAGES} bound and cycle detection, since a
 * server that keeps pointing at a page it already served is the failure mode
 * those exist for.
 */
export async function paginateGitLab<T>(path: string): Promise<T[]> {
	const collected: T[] = [];
	const fetched = new Set<string>();
	let page = '1';

	for (;;) {
		if (fetched.size >= MAX_PAGES) {
			throw new Error(
				`GitLab pagination exceeded maximum page count of ${MAX_PAGES} — refusing to follow an endless x-next-page cursor`,
			);
		}
		if (fetched.has(page)) {
			throw new Error(
				`GitLab pagination revisited page ${page} of ${path} — refusing to follow a cyclic x-next-page cursor`,
			);
		}
		fetched.add(page);

		const response = await gitlabFetch('GET', pageUrl(path, page));
		const body = await readJsonBody<T[] | undefined>(response);
		if (Array.isArray(body)) collected.push(...body);

		const next = response.headers.get('x-next-page')?.trim() ?? '';
		if (next === '') return collected;
		if (!/^[1-9][0-9]*$/.test(next)) {
			throw new Error(
				`GitLab pagination received a non-numeric x-next-page cursor '${next.slice(0, MAX_CURSOR_CHARS)}' for ${path} — refusing to follow it`,
			);
		}
		page = next;
	}
}

/**
 * A project's API path segment. GitLab addresses a project by its URL-encoded
 * `namespace/project` path, so — unlike Bitbucket's `workspace` / `repo_slug`
 * pair — `ProjectConfig.repo` passes through whole with no split.
 */
export function projectPath(repo: string): string {
	return `/projects/${encodeURIComponent(repo)}`;
}

/**
 * Resolve the GitLab username a token authenticates as, or `null` when it is
 * absent or the lookup fails — the same contract as `getGitHubUserForToken` and
 * `getBitbucketUserForCredential`, for the same reason: one bad credential must
 * not take down persona resolution, and the caller decides whether a missing
 * identity is fatal (`./personas.ts` says yes).
 *
 * `username` is the field GitLab's merge-request, note, and pipeline webhook
 * payloads carry as `user.username`, so a resolved identity and an inbound
 * actor are comparable strings.
 */
export async function getGitLabUserForToken(token: string | null): Promise<string | null> {
	if (!token) return null;
	try {
		const user = await withGitLabToken(token, () =>
			gitlabRequest<{ username?: string }>('GET', '/user'),
		);
		return user.username ?? null;
	} catch (err) {
		// `GitLabApiError` is built from method/path/status/response body only, so
		// this can't leak the token.
		logger.warn('Failed to resolve GitLab identity for token', { error: String(err) });
		return null;
	}
}

/** The `GET /user` fields a delivery's commit identity is built from. */
export interface GitLabScopedUser {
	username: string | null;
	/** `null` whenever GitLab withholds it — see {@link getScopedGitLabUser}. */
	email: string | null;
}

/**
 * The account the **scoped** token authenticates as, for the delivery seam's
 * commit identity. One request answers both halves, where Bitbucket needs a
 * second call to `/user/emails`.
 *
 * Two divergences from {@link getGitLabUserForToken}, which resolves the same
 * endpoint for persona identity: the token comes from the async context rather
 * than an argument, and a `GitLabApiError` **propagates** instead of being logged
 * and flattened to `null`. Persona resolution must survive one bad credential; a
 * delivery must not commit under an identity it failed to resolve, and the API
 * error says why (a token without `read_user`/`api` scope cannot read `/user` at
 * all) where a bare `null` would not.
 *
 * `email` comes back `null` — not an error — when GitLab returns none: the field
 * is omitted for a token whose scope doesn't expose it, and a project/group
 * access token's bot user has no address to expose. The caller substitutes the
 * noreply placeholder.
 */
export async function getScopedGitLabUser(): Promise<GitLabScopedUser> {
	const user = await gitlabRequest<{ username?: string; email?: string | null }>('GET', '/user');
	return { username: user.username ?? null, email: user.email?.trim() || null };
}
