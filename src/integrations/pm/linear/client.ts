/**
 * Linear GraphQL client with an AsyncLocalStorage-scoped API key.
 *
 * Personal API keys use a bare Authorization header. `Bearer` is OAuth-only and
 * makes Linear reject a personal key with HTTP 400.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** Linear's GraphQL endpoint. */
export const LINEAR_API_URL = 'https://api.linear.app/graphql';

/** Maximum pages a connection helper will follow before treating it as malformed. */
export const MAX_PAGES = 100;

/** Cap on how much of a failed HTTP response is included in an error message. */
const MAX_ERROR_BODY_CHARS = 200;

const apiKeyStorage = new AsyncLocalStorage<string>();

export interface LinearConnection<N> {
	nodes?: Array<N | null> | null;
	pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
}

/** The API key scoped to the current async operation. */
export function getScopedApiKey(): string {
	const apiKey = apiKeyStorage.getStore();
	if (!apiKey) {
		throw new Error('No Linear API key in scope. Wrap the call in withLinearApiKey().');
	}
	return apiKey;
}

/** Run `fn` with a Linear API key scoped to its asynchronous work. */
export function withLinearApiKey<T>(apiKey: string, fn: () => Promise<T>): Promise<T> {
	return apiKeyStorage.run(apiKey, fn);
}

/** A non-2xx Linear API response. */
export class LinearApiError extends Error {
	constructor(
		readonly status: number,
		detail: string,
	) {
		super(`Linear API request failed (${status}): ${detail}`);
		this.name = 'LinearApiError';
	}
}

interface LinearGraphQLResponse<T> {
	data?: T;
	errors?: Array<{ message?: string }>;
}

/** Issue one authenticated GraphQL request and return its data payload. */
export async function linearGraphQL<T>(
	query: string,
	variables?: Record<string, unknown>,
): Promise<T> {
	const response = await fetch(LINEAR_API_URL, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			Authorization: getScopedApiKey(),
		},
		body: JSON.stringify({ query, variables }),
	});

	if (!response.ok) {
		const body = await response.text();
		throw new LinearApiError(
			response.status,
			body.slice(0, MAX_ERROR_BODY_CHARS) || '<empty response body>',
		);
	}

	const result = (await response.json()) as LinearGraphQLResponse<T>;
	if (result.errors && result.errors.length > 0) {
		throw new Error(`Linear API error: ${result.errors.map((error) => error.message).join('; ')}`);
	}
	if (result.data === undefined) throw new Error('Linear API returned no data');
	return result.data;
}

/**
 * Flatten a cursor-paginated Linear GraphQL connection. Stop on a terminal or
 * malformed cursor; fail rather than looping forever if an endpoint exceeds the
 * global page cap.
 */
export async function collectLinearConnection<N>(
	fetchPage: (cursor: string | undefined) => Promise<LinearConnection<N> | null>,
): Promise<N[]> {
	const collected: N[] = [];
	let cursor: string | undefined;

	for (let pageCount = 0; pageCount < MAX_PAGES; pageCount++) {
		const page = await fetchPage(cursor);
		for (const node of page?.nodes ?? []) {
			if (node) collected.push(node);
		}

		const pageInfo = page?.pageInfo;
		if (!pageInfo?.hasNextPage || !pageInfo.endCursor || pageInfo.endCursor === cursor) {
			return collected;
		}
		cursor = pageInfo.endCursor;
	}

	throw new Error(
		`Linear pagination exceeded maximum page count of ${MAX_PAGES} — refusing to follow an endless cursor`,
	);
}
