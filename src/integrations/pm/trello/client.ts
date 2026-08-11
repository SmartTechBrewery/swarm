/**
 * Trello REST API client with an AsyncLocalStorage-scoped key/token pair.
 *
 * Plain `fetch`, no SDK: the provider needs roughly a dozen endpoints, and
 * Cascade's `trello.js` dependency (`cascade/src/trello/client.ts`) would buy a
 * whole generated client for them. `@octokit/rest` stays the only provider SDK in
 * `package.json`, exactly as `../linear/client.ts` and `../jira/client.ts` decided.
 *
 * Auth is the one structural difference from the two prior clients: Trello
 * authenticates with an **API key plus a token, as query parameters** — there is
 * no `Authorization` header — which is why the credential is a pair
 * (`./credentials.ts`) and why {@link buildUrl} appends the pair *last*, after a
 * caller's own query, so nothing can displace it. It is never a function argument
 * (ai/CODING_STANDARDS.md "Error handling"): the scope carries it so it stays out
 * of signatures and stack traces. Credentials living in the URL is also why
 * {@link TrelloApiError} carries a **redacted** path — its query string stripped
 * *and* a leading `tokens/{token}` segment masked, since webhook administration
 * puts the token in the path itself (`./webhooks.ts`) — because the whole URL
 * would put the token in every log line.
 *
 * Verified against Trello's current REST documentation
 * (developer.atlassian.com/cloud/trello/rest) rather than inferred from Cascade's
 * pinned SDK. The endpoints later phases are built on:
 *
 * | Operation | Endpoint |
 * | --- | --- |
 * | Read card | `GET /cards/{id}` (`fields`, `members`, `attachments`) |
 * | Board / list cards | `GET /boards/{id}/cards`, `GET /lists/{id}/cards` |
 * | Move / edit card | `PUT /cards/{id}` (`idList`, `name`, `desc`) |
 * | Create card | `POST /cards` (`idList`, `name`, `desc`, `idLabels`) |
 * | Comments | `POST /cards/{id}/actions/comments`, `GET /cards/{id}/actions?filter=commentCard` |
 * | Board lists | `GET /boards/{id}/lists` |
 * | Board labels | `GET /boards/{id}/labels`, `POST /boards/{id}/labels`, `POST /cards/{id}/idLabels` |
 * | Boards | `GET /members/me/boards` |
 * | Identity | `GET /members/me` |
 * | Webhooks | `POST`/`GET /tokens/{token}/webhooks`, `DELETE /webhooks/{id}` |
 *
 * Paging is by **id cursor** (`limit` + `before=<oldest id seen>`) rather than by
 * offset (Jira) or an opaque cursor (Linear), and no response wraps its results in
 * a page envelope — a paged Trello operation answers a bare array. Hence
 * {@link collectTrelloPage}'s shape: a short page terminates the walk, so the
 * helper has to be told the page size the caller asked for.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** The REST API root every request is issued under. */
export const TRELLO_API_URL = 'https://api.trello.com/1';

/** Maximum pages a paging helper will follow before treating the response as malformed. */
export const MAX_PAGES = 100;

/**
 * Default `limit` for a paged operation — Trello's documented maximum for the
 * `/actions` and `/cards` collections. Exported so every caller pages at one size
 * and {@link collectTrelloPage}'s short-page check matches what was requested.
 */
export const PAGE_LIMIT = 1000;

/** Cap on how much of a failed HTTP response is included in an error message. */
const MAX_ERROR_BODY_CHARS = 200;

/** The Trello API key/token pair every request authenticates with. */
export interface TrelloCredentials {
	/** The Trello **API key** — the `key` query parameter. */
	readonly apiKey: string;
	/** The **token** issued for that key — the `token` query parameter. */
	readonly token: string;
}

/** How a request may be shaped beyond its path — no credential, ever. */
export interface TrelloRequestInit {
	method?: string;
	/** Serialized as JSON. Present ⇒ `Content-Type: application/json`. */
	body?: unknown;
	/** Query parameters; `undefined` values are dropped rather than sent as "undefined". */
	query?: Record<string, string | number | boolean | undefined>;
}

/** The minimum a paged entry must expose for {@link collectTrelloPage} to advance its cursor. */
export interface TrelloPageEntry {
	id?: string | null;
}

const credentialsStorage = new AsyncLocalStorage<TrelloCredentials>();

/** The Trello credentials scoped to the current async operation. */
export function getScopedTrelloCredentials(): TrelloCredentials {
	const credentials = credentialsStorage.getStore();
	if (!credentials) {
		throw new Error('No Trello credentials in scope. Wrap the call in withTrelloCredentials().');
	}
	return credentials;
}

/** Run `fn` with Trello credentials scoped to its asynchronous work. */
export function withTrelloCredentials<T>(
	credentials: TrelloCredentials,
	fn: () => Promise<T>,
): Promise<T> {
	return credentialsStorage.run(credentials, fn);
}

/**
 * A non-2xx Trello API response.
 *
 * `path` is the request path with **any query string removed** and a `tokens/{token}`
 * segment masked — Trello carries the API key and token as query parameters, and
 * webhook administration carries the token in the path, so neither can reach an
 * error message or a log line.
 */
export class TrelloApiError extends Error {
	constructor(
		readonly status: number,
		readonly path: string,
		detail: string,
	) {
		super(`Trello API request failed (${status}) for ${path}: ${detail}`);
		this.name = 'TrelloApiError';
	}
}

/**
 * The request path with its query string dropped and the token masked out of a
 * `tokens/{token}/…` prefix — safe to log or surface in an error.
 *
 * The query goes because the key/token pair rides there on every request; the path
 * segment is masked because webhook administration addresses the collection *by
 * token* (`./webhooks.ts`), so stripping the query alone would still put a live
 * credential in every failure message.
 */
function redactPath(path: string): string {
	const withoutQuery = `/${path.replace(/^\/+/, '').split('?')[0]}`;
	return withoutQuery.replace(/^\/tokens\/[^/]+/, '/tokens/{token}');
}

function buildUrl(
	credentials: TrelloCredentials,
	path: string,
	query: TrelloRequestInit['query'],
): string {
	const url = new URL(`${TRELLO_API_URL}/${path.replace(/^\/+/, '')}`);
	for (const [key, value] of Object.entries(query ?? {})) {
		if (value !== undefined) url.searchParams.set(key, String(value));
	}
	// Last, and unconditionally: a caller's own `key`/`token` — in the query record or
	// baked into the path — must never displace the credentials in scope.
	url.searchParams.set('key', credentials.apiKey);
	url.searchParams.set('token', credentials.token);
	return url.toString();
}

/**
 * Issue one authenticated REST request and return its parsed body.
 *
 * Resolves to `undefined` for a response with no body — Trello answers some writes
 * (`DELETE /webhooks/{id}` among them) with an empty payload, so a write's caller
 * types `T` as `void` rather than being handed a JSON parse error.
 */
export async function trelloRequest<T>(path: string, init: TrelloRequestInit = {}): Promise<T> {
	const credentials = getScopedTrelloCredentials();
	const hasBody = init.body !== undefined;
	const response = await fetch(buildUrl(credentials, path, init.query), {
		method: init.method ?? 'GET',
		headers: {
			Accept: 'application/json',
			...(hasBody ? { 'Content-Type': 'application/json' } : {}),
		},
		...(hasBody ? { body: JSON.stringify(init.body) } : {}),
	});

	if (!response.ok) {
		const body = await response.text();
		throw new TrelloApiError(
			response.status,
			redactPath(path),
			body.slice(0, MAX_ERROR_BODY_CHARS) || '<empty response body>',
		);
	}

	const text = await response.text();
	if (!text) return undefined as T;
	return JSON.parse(text) as T;
}

/**
 * Flatten an id-cursor-paged Trello collection into one array.
 *
 * Trello pages with `limit` + `before=<id>`: each page is a bare array ordered
 * newest-first, and the next page is requested "before" the **oldest** entry seen
 * — the last element of the page just read. There is no `hasNextPage` flag and no
 * reported total, so termination is driven by the page itself: an empty page, a
 * page shorter than the `limit` that was asked for, or a cursor that fails to
 * advance (an entry with no id, or the same id again). Past the global page cap
 * this fails rather than looping forever, the same guard
 * `collectLinearConnection`/`collectJiraPage` apply.
 *
 * `pageLimit` must be the `limit` `fetchPage` actually sends — that is what makes a
 * short page mean "last page" — and defaults to {@link PAGE_LIMIT}.
 */
export async function collectTrelloPage<N extends TrelloPageEntry>(
	fetchPage: (before: string | undefined) => Promise<Array<N | null> | null>,
	pageLimit: number = PAGE_LIMIT,
): Promise<N[]> {
	const collected: N[] = [];
	let before: string | undefined;

	for (let pageCount = 0; pageCount < MAX_PAGES; pageCount++) {
		const page = (await fetchPage(before)) ?? [];
		for (const entry of page) {
			if (entry !== null && entry !== undefined) collected.push(entry);
		}

		if (page.length === 0 || page.length < pageLimit) return collected;
		const nextBefore = page[page.length - 1]?.id;
		if (!nextBefore || nextBefore === before) return collected;
		before = nextBefore;
	}

	throw new Error(
		`Trello pagination exceeded maximum page count of ${MAX_PAGES} — refusing to follow an endless cursor`,
	);
}
