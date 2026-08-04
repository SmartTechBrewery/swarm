import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	BITBUCKET_API_BASE,
	BitbucketApiError,
	bitbucketRequest,
	getBitbucketUserForCredential,
	getScopedCredential,
	MAX_PAGES,
	paginateBitbucket,
	withBitbucketCredential,
} from '@/integrations/scm/bitbucket/client.js';

/** A `fetch` stand-in typed with the real signature so `mock.calls` indexes. */
type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function headersOf(fetchMock: FetchMock, call = 0): Record<string, string> {
	return (fetchMock.mock.calls[call]?.[1]?.headers ?? {}) as Record<string, string>;
}

describe('bitbucket client', () => {
	let fetchMock: FetchMock;

	beforeEach(() => {
		fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal('fetch', fetchMock);
	});

	describe('credential scoping', () => {
		it('throws when a request is attempted outside a credential scope', () => {
			expect(() => getScopedCredential()).toThrow(/No Bitbucket credential in scope/);
		});

		it('keeps concurrent scopes isolated from each other', async () => {
			const observed: string[] = [];
			const observe = async (delayTicks: number) => {
				for (let i = 0; i < delayTicks; i++) await Promise.resolve();
				observed.push(getScopedCredential());
			};

			await Promise.all([
				withBitbucketCredential('cred-implementer', () => observe(3)),
				withBitbucketCredential('cred-reviewer', () => observe(1)),
			]);

			expect(observed).toEqual(['cred-reviewer', 'cred-implementer']);
		});
	});

	describe('bitbucketRequest', () => {
		it('joins the path onto the Bitbucket Cloud base and asks for JSON', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ nickname: 'swarm-impl' }));

			const body = await withBitbucketCredential('token-abc', () =>
				bitbucketRequest<{ nickname: string }>('GET', '/user'),
			);

			expect(body).toEqual({ nickname: 'swarm-impl' });
			expect(fetchMock.mock.calls[0]?.[0]).toBe(`${BITBUCKET_API_BASE}/user`);
			expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
			expect(headersOf(fetchMock).accept).toBe('application/json');
		});

		it('sends a bare access token as a bearer credential', async () => {
			fetchMock.mockResolvedValue(jsonResponse({}));

			await withBitbucketCredential('token-abc', () => bitbucketRequest('GET', '/user'));

			expect(headersOf(fetchMock).authorization).toBe('Bearer token-abc');
		});

		it('sends a username:app_password pair as HTTP Basic', async () => {
			fetchMock.mockResolvedValue(jsonResponse({}));

			await withBitbucketCredential('swarm-impl:app-pw', () => bitbucketRequest('GET', '/user'));

			expect(headersOf(fetchMock).authorization).toBe(
				`Basic ${Buffer.from('swarm-impl:app-pw').toString('base64')}`,
			);
		});

		it('JSON-encodes a body and declares its content type', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ id: 7 }));

			await withBitbucketCredential('token-abc', () =>
				bitbucketRequest('POST', '/repositories/ws/repo/pullrequests/1/comments', {
					content: { raw: 'hello' },
				}),
			);

			const init = fetchMock.mock.calls[0]?.[1];
			expect(init?.body).toBe(JSON.stringify({ content: { raw: 'hello' } }));
			expect(headersOf(fetchMock)['content-type']).toBe('application/json');
		});

		it('sends no body or content type on a bodiless request', async () => {
			fetchMock.mockResolvedValue(jsonResponse({}));

			await withBitbucketCredential('token-abc', () => bitbucketRequest('GET', '/user'));

			expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
			expect(headersOf(fetchMock)['content-type']).toBeUndefined();
		});

		it('resolves undefined for a 204 rather than failing to parse an empty body', async () => {
			fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

			await expect(
				withBitbucketCredential('token-abc', () =>
					bitbucketRequest('DELETE', '/repositories/ws/repo/pullrequests/1/comments/2'),
				),
			).resolves.toBeUndefined();
		});

		it('throws a BitbucketApiError carrying the status and Bitbucket’s own message', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({ type: 'error', error: { message: 'Repository not found' } }, 404),
			);

			const thrown = await withBitbucketCredential('token-abc', () =>
				bitbucketRequest('GET', '/repositories/ws/repo').catch((err: unknown) => err),
			);

			expect(thrown).toBeInstanceOf(BitbucketApiError);
			const error = thrown as BitbucketApiError;
			expect(error.status).toBe(404);
			expect(error.method).toBe('GET');
			expect(error.path).toBe('/2.0/repositories/ws/repo');
			expect(error.message).toContain('Repository not found');
		});

		it('falls back to the raw body when the error response is not JSON', async () => {
			fetchMock.mockResolvedValue(new Response('<html>502 Bad Gateway</html>', { status: 502 }));

			await expect(
				withBitbucketCredential('token-abc', () => bitbucketRequest('GET', '/user')),
			).rejects.toThrow(/502 Bad Gateway/);
		});

		it('never puts the credential in the thrown message', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'Unauthorized' } }, 401));

			const thrown = await withBitbucketCredential('super-secret-token', () =>
				bitbucketRequest('GET', '/user').catch((err: unknown) => err),
			);

			expect(String(thrown)).not.toContain('super-secret-token');
		});
	});

	describe('paginateBitbucket', () => {
		it('follows the next cursor and flattens every page’s values', async () => {
			fetchMock
				.mockResolvedValueOnce(
					jsonResponse({ values: [{ id: 1 }], next: `${BITBUCKET_API_BASE}/things?page=2` }),
				)
				.mockResolvedValueOnce(jsonResponse({ values: [{ id: 2 }] }));

			const all = await withBitbucketCredential('token-abc', () =>
				paginateBitbucket<{ id: number }>('/things'),
			);

			expect(all).toEqual([{ id: 1 }, { id: 2 }]);
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(fetchMock.mock.calls[1]?.[0]).toBe(`${BITBUCKET_API_BASE}/things?page=2`);
		});

		it('rejects an off-origin next cursor, calls fetch once, and does not leak credentials in error', async () => {
			fetchMock.mockResolvedValueOnce(
				jsonResponse({ values: [{ id: 1 }], next: 'https://attacker.example.com/exfil' }),
			);

			const err = await withBitbucketCredential('super-secret-token', () =>
				paginateBitbucket('/things').catch((e: unknown) => e),
			);

			expect(err).toBeInstanceOf(Error);
			const message = (err as Error).message;
			expect(message).toContain('attacker.example.com');
			expect(message).not.toContain('super-secret-token');
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(headersOf(fetchMock).authorization).toBe('Bearer super-secret-token');
		});

		it('allows a same-origin next cursor with a different path', async () => {
			fetchMock
				.mockResolvedValueOnce(
					jsonResponse({ values: [{ id: 1 }], next: `${BITBUCKET_API_BASE}/other-path?page=2` }),
				)
				.mockResolvedValueOnce(jsonResponse({ values: [{ id: 2 }] }));

			const all = await withBitbucketCredential('token-abc', () =>
				paginateBitbucket<{ id: number }>('/things'),
			);

			expect(all).toEqual([{ id: 1 }, { id: 2 }]);
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		it('throws when MAX_PAGES pagination cap is exceeded', async () => {
			for (let i = 0; i < MAX_PAGES + 1; i++) {
				fetchMock.mockResolvedValueOnce(
					jsonResponse({ values: [{ id: i }], next: `${BITBUCKET_API_BASE}/things?page=${i + 2}` }),
				);
			}

			await expect(
				withBitbucketCredential('token-abc', () => paginateBitbucket('/things')),
			).rejects.toThrow(/exceeded maximum page count/);

			expect(fetchMock).toHaveBeenCalledTimes(MAX_PAGES);
		});

		it('tolerates a page that carries no values array', async () => {
			fetchMock.mockResolvedValue(jsonResponse({}));

			await expect(
				withBitbucketCredential('token-abc', () => paginateBitbucket('/things')),
			).resolves.toEqual([]);
		});

		it('refuses to follow a cursor pointing back at a page it already fetched', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({ values: [{ id: 1 }], next: `${BITBUCKET_API_BASE}/things` }),
			);

			await expect(
				withBitbucketCredential('token-abc', () => paginateBitbucket('/things')),
			).rejects.toThrow(/refusing to follow a cyclic next cursor/);
		});
	});

	describe('getBitbucketUserForCredential', () => {
		it('resolves the account nickname', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ nickname: 'swarm-impl', account_id: 'acc-1' }));

			await expect(getBitbucketUserForCredential('token-abc')).resolves.toBe('swarm-impl');
			expect(headersOf(fetchMock).authorization).toBe('Bearer token-abc');
		});

		it('returns null when no nickname is exposed so resolution fails closed', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ account_id: 'acc-1' }));

			await expect(getBitbucketUserForCredential('token-abc')).resolves.toBeNull();
		});

		it('returns null — never throws — when the lookup fails', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'Unauthorized' } }, 401));

			await expect(getBitbucketUserForCredential('token-abc')).resolves.toBeNull();
		});

		it('returns null for an absent credential without calling the API', async () => {
			await expect(getBitbucketUserForCredential(null)).resolves.toBeNull();
			expect(fetchMock).not.toHaveBeenCalled();
		});
	});
});
