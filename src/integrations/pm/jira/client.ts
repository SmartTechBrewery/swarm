/**
 * Jira Cloud REST API v3 client with AsyncLocalStorage-scoped basic auth.
 *
 * Plain `fetch`, no SDK: the provider needs roughly ten endpoints, and Cascade's
 * `jira.js` dependency (`cascade/src/pm/jira/integration.ts`) would buy a whole
 * generated client for them. `@octokit/rest` stays the only provider SDK in
 * `package.json`, exactly as `../linear/client.ts` decided for Linear.
 *
 * Auth is Jira Cloud **basic** auth — `Basic base64(email:apiToken)` — which is
 * why the credential is a pair rather than a single token (`./credentials.ts`).
 * It is never a function argument (ai/CODING_STANDARDS.md "Error handling"): the
 * scope carries it so it stays out of signatures and stack traces.
 *
 * Verified against Atlassian's current Jira Cloud platform REST v3 documentation
 * (developer.atlassian.com/cloud/jira/platform/rest/v3) rather than inferred from
 * Cascade's pinned SDK:
 *
 * - paged operations are **offset**-based and wrap their results as
 *   `{ startAt, maxResults, total, isLast, values }`, with `total` and `isLast`
 *   documented as *not present on every* operation — hence
 *   {@link collectJiraPage}'s progress-based termination rather than trusting
 *   either field to exist;
 * - JQL issue search is the exception and does **not** use that shape: the
 *   enhanced-search operations (`GET`/`POST /rest/api/3/search/jql`, replacing the
 *   removed `POST /rest/api/3/search`) page with an opaque `nextPageToken`. A
 *   later phase's search helper must page on that token, not through
 *   {@link collectJiraPage}.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** The REST v3 path prefix every request is issued under. */
export const JIRA_API_PATH = '/rest/api/3';

/** Maximum pages a paging helper will follow before treating the response as malformed. */
export const MAX_PAGES = 100;

/** Cap on how much of a failed HTTP response is included in an error message. */
const MAX_ERROR_BODY_CHARS = 200;

/** Jira Cloud basic-auth credentials plus the site they authenticate against. */
export interface JiraCredentials {
	/** Atlassian account email — the basic-auth username. */
	readonly email: string;
	/** Atlassian API token — the basic-auth password. */
	readonly apiToken: string;
	/**
	 * The Jira site's base URL (`https://acme.atlassian.net`). Board *config*, not
	 * a secret (`./config-schema.ts`), threaded through the credential scope only
	 * because every request needs it alongside the auth header.
	 */
	readonly baseUrl: string;
}

/** A single Jira offset-paged response page (`{ startAt, maxResults, total, isLast, values }`). */
export interface JiraPage<N> {
	values?: Array<N | null> | null;
	startAt?: number | null;
	maxResults?: number | null;
	total?: number | null;
	isLast?: boolean | null;
}

/** How a request may be shaped beyond its path — no credential, ever. */
export interface JiraRequestInit {
	method?: string;
	/** Serialized as JSON. Present ⇒ `Content-Type: application/json`. */
	body?: unknown;
	/** Query parameters; `undefined` values are dropped rather than sent as "undefined". */
	query?: Record<string, string | number | boolean | undefined>;
}

const credentialsStorage = new AsyncLocalStorage<JiraCredentials>();

/** The Jira credentials scoped to the current async operation. */
export function getScopedJiraCredentials(): JiraCredentials {
	const credentials = credentialsStorage.getStore();
	if (!credentials) {
		throw new Error('No Jira credentials in scope. Wrap the call in withJiraCredentials().');
	}
	return credentials;
}

/**
 * Run `fn` with Jira credentials scoped to its asynchronous work.
 *
 * `baseUrl` is normalized here — a trailing slash is trimmed once, at the single
 * point every request URL is built from, so a config value of
 * `https://acme.atlassian.net/` can never produce `//rest/api/3`.
 */
export function withJiraCredentials<T>(
	credentials: JiraCredentials,
	fn: () => Promise<T>,
): Promise<T> {
	return credentialsStorage.run(
		{ ...credentials, baseUrl: credentials.baseUrl.replace(/\/+$/, '') },
		fn,
	);
}

/** A non-2xx Jira API response. */
export class JiraApiError extends Error {
	constructor(
		readonly status: number,
		detail: string,
	) {
		super(`Jira API request failed (${status}): ${detail}`);
		this.name = 'JiraApiError';
	}
}

/** The `Authorization` header value for the scoped credentials. */
function basicAuthHeader(credentials: JiraCredentials): string {
	const encoded = Buffer.from(`${credentials.email}:${credentials.apiToken}`, 'utf8').toString(
		'base64',
	);
	return `Basic ${encoded}`;
}

function buildUrl(
	credentials: JiraCredentials,
	path: string,
	query: JiraRequestInit['query'],
): string {
	const url = new URL(`${credentials.baseUrl}${JIRA_API_PATH}/${path.replace(/^\/+/, '')}`);
	for (const [key, value] of Object.entries(query ?? {})) {
		if (value !== undefined) url.searchParams.set(key, String(value));
	}
	return url.toString();
}

/**
 * Issue one authenticated REST v3 request and return its parsed body.
 *
 * Resolves to `undefined` for a response with no body — Jira answers
 * `PUT /issue/{key}` and `POST /issue/{key}/transitions` with `204 No Content`, so
 * a write's caller types `T` as `void` rather than being handed a JSON parse error.
 */
export async function jiraRequest<T>(path: string, init: JiraRequestInit = {}): Promise<T> {
	const credentials = getScopedJiraCredentials();
	const hasBody = init.body !== undefined;
	const response = await fetch(buildUrl(credentials, path, init.query), {
		method: init.method ?? 'GET',
		headers: {
			Accept: 'application/json',
			Authorization: basicAuthHeader(credentials),
			...(hasBody ? { 'Content-Type': 'application/json' } : {}),
		},
		...(hasBody ? { body: JSON.stringify(init.body) } : {}),
	});

	if (!response.ok) {
		const body = await response.text();
		throw new JiraApiError(
			response.status,
			body.slice(0, MAX_ERROR_BODY_CHARS) || '<empty response body>',
		);
	}

	const text = await response.text();
	if (!text) return undefined as T;
	return JSON.parse(text) as T;
}

/**
 * Flatten a Jira offset-paged operation into one array.
 *
 * Jira pages by offset (`startAt`), not by cursor, and its own documentation warns
 * that `total` and `isLast` are absent from some operations — so termination is
 * driven by *progress*: a page that returns no values, a page `isLast` marks, a
 * page reaching a reported `total`, or an offset that fails to advance. Past the
 * global page cap this fails rather than looping forever, the same guard
 * `collectLinearConnection` applies to an endless cursor.
 */
export async function collectJiraPage<N>(
	fetchPage: (startAt: number) => Promise<JiraPage<N> | null>,
): Promise<N[]> {
	const collected: N[] = [];
	let startAt = 0;

	for (let pageCount = 0; pageCount < MAX_PAGES; pageCount++) {
		const page = await fetchPage(startAt);
		const values = page?.values ?? [];
		for (const value of values) {
			if (value !== null && value !== undefined) collected.push(value);
		}

		if (page?.isLast || values.length === 0) return collected;
		const nextStartAt = startAt + values.length;
		if (typeof page?.total === 'number' && nextStartAt >= page.total) return collected;
		startAt = nextStartAt;
	}

	throw new Error(
		`Jira pagination exceeded maximum page count of ${MAX_PAGES} — refusing to follow an endless offset`,
	);
}
