import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	collectLinearConnection,
	getScopedApiKey,
	LINEAR_API_URL,
	LinearApiError,
	type LinearConnection,
	linearGraphQL,
	MAX_PAGES,
	withLinearApiKey,
} from '@/integrations/pm/linear/client.js';

/** A `fetch` stand-in typed with the real signature so `mock.calls` indexes. */
type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;
type FetchPage = (cursor: string | undefined) => Promise<LinearConnection<{ id: number }> | null>;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function headersOf(fetchMock: FetchMock): Record<string, string> {
	return (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
}

describe('Linear GraphQL client', () => {
	let fetchMock: FetchMock;

	beforeEach(() => {
		fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal('fetch', fetchMock);
	});

	it('posts GraphQL data with a bare personal API key, never a Bearer token', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ data: { viewer: { id: 'user-1' } } }));

		await expect(
			withLinearApiKey('lin_api_key', () =>
				linearGraphQL<{ viewer: { id: string } }>('query Viewer { viewer { id } }', {
					includeArchived: false,
				}),
			),
		).resolves.toEqual({ viewer: { id: 'user-1' } });

		expect(fetchMock.mock.calls[0]?.[0]).toBe(LINEAR_API_URL);
		expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
		expect(headersOf(fetchMock)['content-type']).toBe('application/json');
		expect(headersOf(fetchMock).Authorization).toBe('lin_api_key');
		expect(headersOf(fetchMock).Authorization).not.toMatch(/^Bearer\s/);
		expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
			JSON.stringify({
				query: 'query Viewer { viewer { id } }',
				variables: { includeArchived: false },
			}),
		);
	});

	it('fails outside an API-key scope and isolates concurrent scopes', async () => {
		expect(() => getScopedApiKey()).toThrow(/withLinearApiKey/);

		const observed: string[] = [];
		const observe = async (delayTicks: number) => {
			for (let i = 0; i < delayTicks; i++) await Promise.resolve();
			observed.push(getScopedApiKey());
		};
		await Promise.all([
			withLinearApiKey('implementer-key', () => observe(3)),
			withLinearApiKey('reviewer-key', () => observe(1)),
		]);

		expect(observed).toEqual(['reviewer-key', 'implementer-key']);
	});

	it('surfaces a non-2xx response as a status-carrying LinearApiError', async () => {
		fetchMock.mockResolvedValue(new Response('not authorized', { status: 401 }));

		const thrown = await withLinearApiKey('never-echo-this-key', () =>
			linearGraphQL('query Viewer { viewer { id } }').catch((error: unknown) => error),
		);

		expect(thrown).toBeInstanceOf(LinearApiError);
		expect((thrown as LinearApiError).status).toBe(401);
		expect(String(thrown)).toContain('not authorized');
		expect(String(thrown)).not.toContain('never-echo-this-key');
	});

	it('rejects GraphQL errors and a response without data', async () => {
		fetchMock.mockResolvedValueOnce(
			jsonResponse({ errors: [{ message: 'first problem' }, { message: 'second problem' }] }),
		);
		await expect(
			withLinearApiKey('key', () => linearGraphQL('query Viewer { viewer { id } }')),
		).rejects.toThrow(/first problem; second problem/);

		fetchMock.mockResolvedValueOnce(jsonResponse({}));
		await expect(
			withLinearApiKey('key', () => linearGraphQL('query Viewer { viewer { id } }')),
		).rejects.toThrow(/returned no data/);
	});
});

describe('collectLinearConnection', () => {
	it('flattens pages and stops on a final page', async () => {
		const fetchPage = vi
			.fn<FetchPage>()
			.mockResolvedValueOnce({
				nodes: [{ id: 1 }],
				pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
			})
			.mockResolvedValueOnce({
				nodes: [{ id: 2 }],
				pageInfo: { hasNextPage: false, endCursor: 'cursor-2' },
			});

		await expect(collectLinearConnection(fetchPage)).resolves.toEqual([{ id: 1 }, { id: 2 }]);
		expect(fetchPage.mock.calls).toEqual([[undefined], ['cursor-1']]);
	});

	it.each([
		{ hasNextPage: true, endCursor: null },
		{ hasNextPage: true, endCursor: undefined },
	])('stops when a next page has no usable cursor', async (pageInfo) => {
		const fetchPage = vi.fn<FetchPage>().mockResolvedValue({ nodes: [{ id: 1 }], pageInfo });

		await expect(collectLinearConnection(fetchPage)).resolves.toEqual([{ id: 1 }]);
		expect(fetchPage).toHaveBeenCalledTimes(1);
	});

	it('stops rather than refetching a repeated cursor', async () => {
		const fetchPage = vi
			.fn<FetchPage>()
			.mockResolvedValueOnce({
				nodes: [{ id: 1 }],
				pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
			})
			.mockResolvedValueOnce({
				nodes: [{ id: 2 }],
				pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
			});

		await expect(collectLinearConnection(fetchPage)).resolves.toEqual([{ id: 1 }, { id: 2 }]);
		expect(fetchPage).toHaveBeenCalledTimes(2);
	});

	it('rejects an endless sequence after the page cap', async () => {
		let page = 0;
		const fetchPage = vi.fn<FetchPage>(async () => {
			page += 1;
			return {
				nodes: [{ id: page }],
				pageInfo: { hasNextPage: true, endCursor: `cursor-${page}` },
			};
		});

		await expect(collectLinearConnection(fetchPage)).rejects.toThrow(
			new RegExp(`exceeded maximum page count of ${MAX_PAGES}`),
		);
		expect(fetchPage).toHaveBeenCalledTimes(MAX_PAGES);
	});
});
