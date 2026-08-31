import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	GITLAB_API_BASE,
	GitLabApiError,
	getGitLabBranchHead,
	getGitLabUserForToken,
	getScopedToken,
	gitlabRequest,
	MAX_PAGES,
	PER_PAGE,
	paginateGitLab,
	projectPath,
	withGitLabToken,
} from '@/integrations/scm/gitlab/client.js';

/** A `fetch` stand-in typed with the real signature so `mock.calls` indexes. */
type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers },
	});
}

function headersOf(fetchMock: FetchMock, call = 0): Record<string, string> {
	return (fetchMock.mock.calls[call]?.[1]?.headers ?? {}) as Record<string, string>;
}

describe('gitlab client', () => {
	let fetchMock: FetchMock;

	beforeEach(() => {
		fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal('fetch', fetchMock);
	});

	describe('token scoping', () => {
		it('throws when a request is attempted outside a token scope', () => {
			expect(() => getScopedToken()).toThrow(/No GitLab token in scope/);
		});

		it('keeps concurrent scopes isolated from each other', async () => {
			const observed: string[] = [];
			const observe = async (delayTicks: number) => {
				for (let i = 0; i < delayTicks; i++) await Promise.resolve();
				observed.push(getScopedToken());
			};

			await Promise.all([
				withGitLabToken('token-implementer', () => observe(3)),
				withGitLabToken('token-reviewer', () => observe(1)),
			]);

			expect(observed).toEqual(['token-reviewer', 'token-implementer']);
		});
	});

	describe('gitlabRequest', () => {
		it('joins the path onto the GitLab.com v4 base and asks for JSON', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ username: 'swarm-impl' }));

			const body = await withGitLabToken('token-abc', () =>
				gitlabRequest<{ username: string }>('GET', '/user'),
			);

			expect(body).toEqual({ username: 'swarm-impl' });
			expect(fetchMock.mock.calls[0]?.[0]).toBe(`${GITLAB_API_BASE}/user`);
			expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
			expect(headersOf(fetchMock).accept).toBe('application/json');
		});

		// Every GitLab token form — personal, group, project — authenticates this
		// one way, so there is no credential-form branch to test (unlike Bitbucket).
		it('sends the scoped token as a PRIVATE-TOKEN header', async () => {
			fetchMock.mockResolvedValue(jsonResponse({}));

			await withGitLabToken('token-abc', () => gitlabRequest('GET', '/user'));

			expect(headersOf(fetchMock)['private-token']).toBe('token-abc');
			expect(headersOf(fetchMock).authorization).toBeUndefined();
		});

		it('JSON-encodes a body and declares its content type', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ id: 7 }));

			await withGitLabToken('token-abc', () =>
				gitlabRequest('POST', `${projectPath('ns/proj')}/merge_requests/1/notes`, {
					body: 'hello',
				}),
			);

			const init = fetchMock.mock.calls[0]?.[1];
			expect(init?.body).toBe(JSON.stringify({ body: 'hello' }));
			expect(headersOf(fetchMock)['content-type']).toBe('application/json');
		});

		it('sends no body or content type on a bodiless request', async () => {
			fetchMock.mockResolvedValue(jsonResponse({}));

			await withGitLabToken('token-abc', () => gitlabRequest('GET', '/user'));

			expect(fetchMock.mock.calls[0]?.[1]?.body).toBeUndefined();
			expect(headersOf(fetchMock)['content-type']).toBeUndefined();
		});

		it('resolves undefined for a 204 rather than failing to parse an empty body', async () => {
			fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

			await expect(
				withGitLabToken('token-abc', () =>
					gitlabRequest('DELETE', `${projectPath('ns/proj')}/merge_requests/1/notes/2`),
				),
			).resolves.toBeUndefined();
		});

		it('resolves undefined for a 200 with an empty body', async () => {
			fetchMock.mockResolvedValue(new Response('', { status: 200 }));

			await expect(
				withGitLabToken('token-abc', () => gitlabRequest('GET', '/user')),
			).resolves.toBeUndefined();
		});

		it('throws a GitLabApiError carrying the status, the path, and GitLab’s message', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ message: '404 Project Not Found' }, 404));

			const thrown = await withGitLabToken('token-abc', () =>
				gitlabRequest('GET', `${projectPath('ns/proj')}?statistics=true`).catch(
					(err: unknown) => err,
				),
			);

			expect(thrown).toBeInstanceOf(GitLabApiError);
			const error = thrown as GitLabApiError;
			expect(error.status).toBe(404);
			expect(error.method).toBe('GET');
			// The path only — a query string is where a future call site could put data.
			expect(error.path).toBe('/api/v4/projects/ns%2Fproj');
			expect(error.message).toContain('404 Project Not Found');
		});

		it('flattens a field-keyed validation message envelope', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({ message: { source_branch: ["can't be blank", 'is invalid'] } }, 400),
			);

			await expect(
				withGitLabToken('token-abc', () => gitlabRequest('POST', '/x', {})),
			).rejects.toThrow(/source_branch: can't be blank; is invalid/);
		});

		it('reads the auth envelope’s `error` key when there is no `message`', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_token' }, 401));

			await expect(
				withGitLabToken('token-abc', () => gitlabRequest('GET', '/user')),
			).rejects.toThrow(/invalid_token/);
		});

		it('falls back to the raw body when the error response is not JSON', async () => {
			fetchMock.mockResolvedValue(new Response('<html>502 Bad Gateway</html>', { status: 502 }));

			await expect(
				withGitLabToken('token-abc', () => gitlabRequest('GET', '/user')),
			).rejects.toThrow(/502 Bad Gateway/);
		});

		it('never puts the token in the thrown message', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ message: '401 Unauthorized' }, 401));

			const thrown = await withGitLabToken('super-secret-token', () =>
				gitlabRequest('GET', '/user').catch((err: unknown) => err),
			);

			expect(String(thrown)).not.toContain('super-secret-token');
		});
	});

	describe('paginateGitLab', () => {
		function page(body: unknown, nextPage: string): Response {
			return jsonResponse(body, 200, { 'x-next-page': nextPage });
		}

		it('follows x-next-page and flattens every page', async () => {
			fetchMock
				.mockResolvedValueOnce(page([{ id: 1 }], '2'))
				.mockResolvedValueOnce(page([{ id: 2 }], ''));

			const all = await withGitLabToken('token-abc', () =>
				paginateGitLab<{ id: number }>('/things'),
			);

			expect(all).toEqual([{ id: 1 }, { id: 2 }]);
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(fetchMock.mock.calls[0]?.[0]).toBe(
				`${GITLAB_API_BASE}/things?per_page=${PER_PAGE}&page=1`,
			);
			expect(fetchMock.mock.calls[1]?.[0]).toBe(
				`${GITLAB_API_BASE}/things?per_page=${PER_PAGE}&page=2`,
			);
		});

		it('preserves a query string the caller already set on the path', async () => {
			fetchMock.mockResolvedValue(page([], ''));

			await withGitLabToken('token-abc', () => paginateGitLab('/things?state=opened'));

			expect(fetchMock.mock.calls[0]?.[0]).toBe(
				`${GITLAB_API_BASE}/things?state=opened&per_page=${PER_PAGE}&page=1`,
			);
		});

		it('stops when the header is absent entirely', async () => {
			fetchMock.mockResolvedValue(jsonResponse([{ id: 1 }]));

			await expect(withGitLabToken('token-abc', () => paginateGitLab('/things'))).resolves.toEqual([
				{ id: 1 },
			]);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		it('tolerates a page whose body is not an array', async () => {
			fetchMock.mockResolvedValue(jsonResponse({}));

			await expect(withGitLabToken('token-abc', () => paginateGitLab('/things'))).resolves.toEqual(
				[],
			);
		});

		it('refuses to follow a cursor pointing back at a page it already fetched', async () => {
			fetchMock.mockResolvedValue(page([{ id: 1 }], '1'));

			await expect(withGitLabToken('token-abc', () => paginateGitLab('/things'))).rejects.toThrow(
				/refusing to follow a cyclic x-next-page cursor/,
			);
		});

		it('refuses to walk past the page cap', async () => {
			// Always points one page further on, so only MAX_PAGES stops it.
			let nextPage = 1;
			fetchMock.mockImplementation(async () => {
				nextPage += 1;
				return page([{ id: nextPage }], String(nextPage));
			});

			await expect(withGitLabToken('token-abc', () => paginateGitLab('/things'))).rejects.toThrow(
				new RegExp(`exceeded maximum page count of ${MAX_PAGES}`),
			);
			expect(fetchMock).toHaveBeenCalledTimes(MAX_PAGES);
		});

		it('refuses a non-numeric cursor rather than trusting the server’s value', async () => {
			fetchMock.mockResolvedValue(page([{ id: 1 }], 'https://evil.example/things'));

			await expect(withGitLabToken('token-abc', () => paginateGitLab('/things'))).rejects.toThrow(
				/non-numeric x-next-page cursor/,
			);
		});
	});

	describe('projectPath', () => {
		it('URL-encodes the namespace/project path GitLab addresses a project by', () => {
			expect(projectPath('my-group/my-project')).toBe('/projects/my-group%2Fmy-project');
		});
	});

	describe('getGitLabBranchHead', () => {
		it("reads the branch under the project's own path and returns its commit id", async () => {
			fetchMock.mockResolvedValue(jsonResponse({ name: 'main', commit: { id: 'a'.repeat(40) } }));

			await expect(
				withGitLabToken('token-abc', () => getGitLabBranchHead('my-group/my-project', 'main')),
			).resolves.toBe('a'.repeat(40));
			expect(fetchMock.mock.calls[0]?.[0]).toBe(
				`${GITLAB_API_BASE}/projects/my-group%2Fmy-project/repository/branches/main`,
			);
		});

		it('URL-encodes a branch name with a slash in it', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ commit: { id: 'a'.repeat(40) } }));

			await withGitLabToken('token-abc', () =>
				getGitLabBranchHead('my-group/my-project', 'release/1.0'),
			);

			expect(fetchMock.mock.calls[0]?.[0]).toBe(
				`${GITLAB_API_BASE}/projects/my-group%2Fmy-project/repository/branches/release%2F1.0`,
			);
		});

		it('answers null when GitLab names no head commit', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ name: 'main' }));

			await expect(
				withGitLabToken('token-abc', () => getGitLabBranchHead('my-group/my-project', 'main')),
			).resolves.toBeNull();
		});

		// The adapter's standing rule: an unreadable read is never flattened into an
		// ordinary answer, so a 404 propagates rather than reading as "no head".
		it('propagates a 404 rather than answering null', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ message: '404 Branch Not Found' }, 404));

			await expect(
				withGitLabToken('token-abc', () => getGitLabBranchHead('my-group/my-project', 'gone')),
			).rejects.toBeInstanceOf(GitLabApiError);
		});
	});

	describe('getGitLabUserForToken', () => {
		it('resolves the account username', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ id: 1, username: 'swarm-impl' }));

			await expect(getGitLabUserForToken('token-abc')).resolves.toBe('swarm-impl');
			expect(headersOf(fetchMock)['private-token']).toBe('token-abc');
			expect(fetchMock.mock.calls[0]?.[0]).toBe(`${GITLAB_API_BASE}/user`);
		});

		it('fails closed when the account exposes no username', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ id: 1 }));

			await expect(getGitLabUserForToken('token-abc')).resolves.toBeNull();
		});

		it('returns null — never throws — when the lookup fails', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ message: '401 Unauthorized' }, 401));

			await expect(getGitLabUserForToken('token-abc')).resolves.toBeNull();
		});

		it('never logs the token when the lookup fails', async () => {
			const warn = vi.spyOn(await import('@/lib/logger.js').then((m) => m.logger), 'warn');
			fetchMock.mockResolvedValue(jsonResponse({ message: '401 Unauthorized' }, 401));

			await getGitLabUserForToken('super-secret-token');

			expect(warn).toHaveBeenCalled();
			expect(JSON.stringify(warn.mock.calls)).not.toContain('super-secret-token');
			warn.mockRestore();
		});

		it('returns null for an absent token without calling the API', async () => {
			await expect(getGitLabUserForToken(null)).resolves.toBeNull();
			expect(fetchMock).not.toHaveBeenCalled();
		});
	});
});
