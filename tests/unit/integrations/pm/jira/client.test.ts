import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	collectJiraPage,
	getScopedJiraCredentials,
	JIRA_API_PATH,
	JiraApiError,
	type JiraCredentials,
	type JiraPage,
	jiraRequest,
	MAX_PAGES,
	withJiraCredentials,
} from '@/integrations/pm/jira/client.js';

/** A `fetch` stand-in typed with the real signature so `mock.calls` indexes. */
type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;
type FetchPage = (startAt: number) => Promise<JiraPage<{ id: number }> | null>;

const credentials: JiraCredentials = {
	email: 'bot@example.com',
	apiToken: 'never-echo-this-token',
	baseUrl: 'https://example.atlassian.net',
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function headersOf(fetchMock: FetchMock): Record<string, string> {
	return (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
}

describe('Jira REST client', () => {
	let fetchMock: FetchMock;

	beforeEach(() => {
		fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal('fetch', fetchMock);
	});

	it('authenticates with basic auth over the scoped site base URL', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ key: 'SWARM-1' }));

		await expect(
			withJiraCredentials(credentials, () =>
				jiraRequest<{ key: string }>('issue/SWARM-1', {
					query: { fields: 'status', expand: undefined },
				}),
			),
		).resolves.toEqual({ key: 'SWARM-1' });

		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			`https://example.atlassian.net${JIRA_API_PATH}/issue/SWARM-1?fields=status`,
		);
		expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
		expect(headersOf(fetchMock).Accept).toBe('application/json');
		expect(headersOf(fetchMock).Authorization).toBe(
			`Basic ${Buffer.from('bot@example.com:never-echo-this-token', 'utf8').toString('base64')}`,
		);
		// A GET carries no body, so it must not announce a JSON content type either.
		expect(headersOf(fetchMock)['Content-Type']).toBeUndefined();
		expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
	});

	it.each([
		'https://example.atlassian.net/',
		'https://example.atlassian.net///',
	])('never doubles the slash for a base URL stored with a trailing one (%s)', async (baseUrl) => {
		fetchMock.mockResolvedValue(jsonResponse({}));

		await withJiraCredentials({ ...credentials, baseUrl }, () =>
			jiraRequest('/project/SWARM/statuses'),
		);

		expect(fetchMock.mock.calls[0]?.[0]).toBe(
			`https://example.atlassian.net${JIRA_API_PATH}/project/SWARM/statuses`,
		);
	});

	it('sends a JSON body with its content type', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ id: '10000' }));

		await withJiraCredentials(credentials, () =>
			jiraRequest('issue', { method: 'POST', body: { fields: { summary: 'A task' } } }),
		);

		expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
		expect(headersOf(fetchMock)['Content-Type']).toBe('application/json');
		expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(
			JSON.stringify({ fields: { summary: 'A task' } }),
		);
	});

	it('resolves undefined for a 204 rather than failing to parse an empty body', async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

		await expect(
			withJiraCredentials(credentials, () =>
				jiraRequest<void>('issue/SWARM-1/transitions', {
					method: 'POST',
					body: { transition: { id: '31' } },
				}),
			),
		).resolves.toBeUndefined();
	});

	it('fails outside a credential scope and isolates concurrent scopes', async () => {
		expect(() => getScopedJiraCredentials()).toThrow(/withJiraCredentials/);

		const observed: string[] = [];
		const observe = async (delayTicks: number) => {
			for (let i = 0; i < delayTicks; i++) await Promise.resolve();
			observed.push(getScopedJiraCredentials().email);
		};
		await Promise.all([
			withJiraCredentials({ ...credentials, email: 'first@example.com' }, () => observe(3)),
			withJiraCredentials({ ...credentials, email: 'second@example.com' }, () => observe(1)),
		]);

		expect(observed).toEqual(['second@example.com', 'first@example.com']);
	});

	it('surfaces a non-2xx response as a status-carrying JiraApiError', async () => {
		fetchMock.mockResolvedValue(new Response('client must be authenticated', { status: 401 }));

		const thrown = await withJiraCredentials(credentials, () =>
			jiraRequest('issue/SWARM-1').catch((error: unknown) => error),
		);

		expect(thrown).toBeInstanceOf(JiraApiError);
		expect((thrown as JiraApiError).status).toBe(401);
		expect(String(thrown)).toContain('client must be authenticated');
		expect(String(thrown)).not.toContain('never-echo-this-token');
	});

	it('truncates a flood of error body and names an empty one', async () => {
		fetchMock.mockResolvedValueOnce(new Response('x'.repeat(5000), { status: 500 }));
		const truncated = await withJiraCredentials(credentials, () =>
			jiraRequest('issue/SWARM-1').catch((error: unknown) => error),
		);
		expect(String(truncated).length).toBeLessThan(300);

		fetchMock.mockResolvedValueOnce(new Response('', { status: 502 }));
		await expect(
			withJiraCredentials(credentials, () => jiraRequest('issue/SWARM-1')),
		).rejects.toThrow(/<empty response body>/);
	});
});

describe('collectJiraPage', () => {
	it('walks offsets and stops on the page Jira marks last', async () => {
		const fetchPage = vi
			.fn<FetchPage>()
			.mockResolvedValueOnce({ startAt: 0, maxResults: 2, values: [{ id: 1 }, { id: 2 }] })
			.mockResolvedValueOnce({ startAt: 2, maxResults: 2, isLast: true, values: [{ id: 3 }] });

		await expect(collectJiraPage(fetchPage)).resolves.toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
		expect(fetchPage.mock.calls).toEqual([[0], [2]]);
	});

	it('stops once a reported total is reached, for an operation without isLast', async () => {
		const fetchPage = vi
			.fn<FetchPage>()
			.mockResolvedValueOnce({ startAt: 0, total: 3, values: [{ id: 1 }, { id: 2 }] })
			.mockResolvedValueOnce({ startAt: 2, total: 3, values: [{ id: 3 }] });

		await expect(collectJiraPage(fetchPage)).resolves.toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
		expect(fetchPage).toHaveBeenCalledTimes(2);
	});

	it.each([
		{ label: 'an empty page', page: { startAt: 0, values: [] } },
		{ label: 'a page with no values field', page: { startAt: 0 } },
		{ label: 'a null page', page: null },
	])('treats $label as terminal rather than paging on', async ({ page }) => {
		const fetchPage = vi.fn<FetchPage>().mockResolvedValue(page);

		await expect(collectJiraPage(fetchPage)).resolves.toEqual([]);
		expect(fetchPage).toHaveBeenCalledTimes(1);
	});

	it('skips null entries inside a page', async () => {
		const fetchPage = vi
			.fn<FetchPage>()
			.mockResolvedValue({ startAt: 0, isLast: true, values: [null, { id: 1 }, null] });

		await expect(collectJiraPage(fetchPage)).resolves.toEqual([{ id: 1 }]);
	});

	it('rejects an endless sequence after the page cap', async () => {
		let page = 0;
		const fetchPage = vi.fn<FetchPage>(async () => {
			page += 1;
			return { startAt: page - 1, values: [{ id: page }] };
		});

		await expect(collectJiraPage(fetchPage)).rejects.toThrow(
			new RegExp(`exceeded maximum page count of ${MAX_PAGES}`),
		);
		expect(fetchPage).toHaveBeenCalledTimes(MAX_PAGES);
	});
});
