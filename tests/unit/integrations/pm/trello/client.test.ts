import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	collectTrelloPage,
	getScopedTrelloCredentials,
	MAX_PAGES,
	PAGE_LIMIT,
	TRELLO_API_URL,
	TrelloApiError,
	type TrelloCredentials,
	trelloRequest,
	withTrelloCredentials,
} from '@/integrations/pm/trello/client.js';

/** A `fetch` stand-in typed with the real signature so `mock.calls` indexes. */
type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;
type PageEntry = { id: string };
type FetchPage = (before: string | undefined) => Promise<Array<PageEntry | null> | null>;

const credentials: TrelloCredentials = {
	apiKey: 'never-echo-this-key',
	token: 'never-echo-this-token',
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function requestUrl(fetchMock: FetchMock): URL {
	return new URL(String(fetchMock.mock.calls[0]?.[0]));
}

function headersOf(fetchMock: FetchMock): Record<string, string> {
	return (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
}

/** A page of `size` synthetic entries whose last id encodes the page number. */
function page(pageNumber: number, size: number): PageEntry[] {
	return Array.from({ length: size }, (_, index) => ({ id: `p${pageNumber}-e${index}` }));
}

describe('Trello REST client', () => {
	let fetchMock: FetchMock;

	beforeEach(() => {
		fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal('fetch', fetchMock);
	});

	it('authenticates with the scoped key/token pair as query parameters', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ id: 'card-1' }));

		await expect(
			withTrelloCredentials(credentials, () =>
				trelloRequest<{ id: string }>('cards/card-1', {
					query: { fields: 'name,idList', members: undefined },
				}),
			),
		).resolves.toEqual({ id: 'card-1' });

		const url = requestUrl(fetchMock);
		expect(`${url.origin}${url.pathname}`).toBe(`${TRELLO_API_URL}/cards/card-1`);
		expect(url.searchParams.get('key')).toBe('never-echo-this-key');
		expect(url.searchParams.get('token')).toBe('never-echo-this-token');
		expect(url.searchParams.get('fields')).toBe('name,idList');
		// An `undefined` query value is dropped rather than serialized as "undefined".
		expect(url.searchParams.has('members')).toBe(false);

		expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
		expect(headersOf(fetchMock).Accept).toBe('application/json');
		// Trello has no bearer scheme — the credentials are the query pair, nothing else.
		expect(headersOf(fetchMock).Authorization).toBeUndefined();
		// A GET carries no body, so it must not announce a JSON content type either.
		expect(headersOf(fetchMock)['Content-Type']).toBeUndefined();
		expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
	});

	it('keeps the scoped credentials even when the caller supplies its own key/token', async () => {
		fetchMock.mockResolvedValue(jsonResponse({}));

		await withTrelloCredentials(credentials, () =>
			trelloRequest('/cards/card-1?token=path-token', {
				query: { key: 'caller-key', filter: 'commentCard' },
			}),
		);

		const url = requestUrl(fetchMock);
		expect(url.searchParams.getAll('key')).toEqual(['never-echo-this-key']);
		expect(url.searchParams.getAll('token')).toEqual(['never-echo-this-token']);
		// A query baked into the path is still honoured for everything else.
		expect(url.searchParams.get('filter')).toBe('commentCard');
	});

	it('sends a JSON body with its content type', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ id: 'card-2' }));

		await withTrelloCredentials(credentials, () =>
			trelloRequest('cards', { method: 'POST', query: { idList: 'list-1' }, body: { name: 'A' } }),
		);

		expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
		expect(headersOf(fetchMock)['Content-Type']).toBe('application/json');
		expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ name: 'A' }));
	});

	it('resolves undefined for an empty body rather than failing to parse it', async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

		await expect(
			withTrelloCredentials(credentials, () =>
				trelloRequest<void>('webhooks/hook-1', { method: 'DELETE' }),
			),
		).resolves.toBeUndefined();
	});

	it('fails outside a credential scope and isolates concurrent scopes', async () => {
		expect(() => getScopedTrelloCredentials()).toThrow(/withTrelloCredentials/);

		const observed: string[] = [];
		const observe = async (delayTicks: number) => {
			for (let i = 0; i < delayTicks; i++) await Promise.resolve();
			observed.push(getScopedTrelloCredentials().token);
		};
		await Promise.all([
			withTrelloCredentials({ ...credentials, token: 'first' }, () => observe(3)),
			withTrelloCredentials({ ...credentials, token: 'second' }, () => observe(1)),
		]);

		expect(observed).toEqual(['second', 'first']);
	});

	it('surfaces a non-2xx as a TrelloApiError naming a query-stripped path', async () => {
		fetchMock.mockResolvedValue(new Response('invalid token', { status: 401 }));

		const thrown = await withTrelloCredentials(credentials, () =>
			trelloRequest('cards/card-1/actions?filter=commentCard', {
				query: { limit: PAGE_LIMIT },
			}).catch((error: unknown) => error),
		);

		expect(thrown).toBeInstanceOf(TrelloApiError);
		expect((thrown as TrelloApiError).status).toBe(401);
		expect((thrown as TrelloApiError).path).toBe('/cards/card-1/actions');
		expect(String(thrown)).toContain('invalid token');
		// Trello carries its credentials in the query string, so the message must not.
		expect(String(thrown)).not.toContain('never-echo-this-key');
		expect(String(thrown)).not.toContain('never-echo-this-token');
	});

	it('truncates a flood of error body and names an empty one', async () => {
		fetchMock.mockResolvedValueOnce(new Response('x'.repeat(5000), { status: 500 }));
		const truncated = await withTrelloCredentials(credentials, () =>
			trelloRequest('cards/card-1').catch((error: unknown) => error),
		);
		expect(String(truncated).length).toBeLessThan(300);

		fetchMock.mockResolvedValueOnce(new Response('', { status: 502 }));
		await expect(
			withTrelloCredentials(credentials, () => trelloRequest('cards/card-1')),
		).rejects.toThrow(/<empty response body>/);
	});
});

describe('collectTrelloPage', () => {
	it('walks the id cursor and stops on a short page', async () => {
		const fetchPage = vi
			.fn<FetchPage>()
			.mockResolvedValueOnce(page(1, 2))
			.mockResolvedValueOnce(page(2, 1));

		await expect(collectTrelloPage(fetchPage, 2)).resolves.toEqual([...page(1, 2), ...page(2, 1)]);
		// The next page is requested *before* the oldest entry seen — the last of the page.
		expect(fetchPage.mock.calls).toEqual([[undefined], ['p1-e1']]);
	});

	it.each([
		{ label: 'an empty page', result: [] },
		{ label: 'a null response', result: null },
	])('treats $label as terminal rather than paging on', async ({ result }) => {
		const fetchPage = vi.fn<FetchPage>().mockResolvedValue(result);

		await expect(collectTrelloPage(fetchPage, 2)).resolves.toEqual([]);
		expect(fetchPage).toHaveBeenCalledTimes(1);
	});

	it('skips null entries inside a page', async () => {
		const fetchPage = vi.fn<FetchPage>().mockResolvedValue([null, { id: 'a' }]);

		await expect(collectTrelloPage(fetchPage, 3)).resolves.toEqual([{ id: 'a' }]);
	});

	it('stops when the last entry carries no id to page before', async () => {
		const fetchPage = vi.fn<FetchPage>().mockResolvedValue([{ id: 'a' }, { id: '' }]);

		await expect(collectTrelloPage(fetchPage, 2)).resolves.toHaveLength(2);
		expect(fetchPage.mock.calls).toEqual([[undefined]]);
	});

	it('stops on a cursor that fails to advance rather than refetching the same page', async () => {
		const fetchPage = vi.fn<FetchPage>().mockResolvedValue([{ id: 'a' }, { id: 'stuck' }]);

		await expect(collectTrelloPage(fetchPage, 2)).resolves.toHaveLength(4);
		expect(fetchPage.mock.calls).toEqual([[undefined], ['stuck']]);
	});

	it('defaults the page size to the documented Trello maximum', async () => {
		const fetchPage = vi.fn<FetchPage>().mockResolvedValue(page(1, 1));

		await expect(collectTrelloPage(fetchPage)).resolves.toHaveLength(1);
		// One entry is a short page at PAGE_LIMIT, so the walk ends immediately.
		expect(fetchPage).toHaveBeenCalledTimes(1);
		expect(PAGE_LIMIT).toBe(1000);
	});

	it('rejects an endless cursor after the page cap', async () => {
		let pageNumber = 0;
		const fetchPage = vi.fn<FetchPage>(async () => {
			pageNumber += 1;
			return page(pageNumber, 2);
		});

		await expect(collectTrelloPage(fetchPage, 2)).rejects.toThrow(
			new RegExp(`exceeded maximum page count of ${MAX_PAGES}`),
		);
		expect(fetchPage).toHaveBeenCalledTimes(MAX_PAGES);
	});
});
