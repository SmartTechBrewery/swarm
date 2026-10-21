import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	AZURE_DEVOPS_API_BASE,
	AzureDevOpsApiError,
	azureDevOpsRequest,
	azureRepoCoordinates,
	getAzureDevOpsUserForToken,
	getScopedAzureDevOpsUser,
	getScopedToken,
	MAX_PAGES,
	PAGE_SIZE,
	paginateAzureDevOps,
	repositoryApiPath,
	withAzureDevOpsToken,
} from '@/integrations/scm/azure-devops/client.js';

/** A `fetch` stand-in typed with the real signature so `mock.calls` indexes. */
type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8; api-version=7.1', ...headers },
	});
}

function htmlResponse(status: number, headers: Record<string, string> = {}): Response {
	return new Response('<html><title>Sign In</title></html>', {
		status,
		headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
	});
}

function headersOf(fetchMock: FetchMock, call = 0): Record<string, string> {
	return (fetchMock.mock.calls[call]?.[1]?.headers ?? {}) as Record<string, string>;
}

function urlOf(fetchMock: FetchMock, call = 0): URL {
	return new URL(String(fetchMock.mock.calls[call]?.[0]));
}

const basic = (pat: string) => `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;

describe('azure devops client', () => {
	let fetchMock: FetchMock;

	beforeEach(() => {
		fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal('fetch', fetchMock);
	});

	describe('token scoping', () => {
		it('throws when a request is attempted outside a token scope', () => {
			expect(() => getScopedToken()).toThrow(/No Azure DevOps token in scope/);
		});

		it('keeps concurrent scopes isolated from each other', async () => {
			const observed: string[] = [];
			const observe = async (delayTicks: number) => {
				for (let i = 0; i < delayTicks; i++) await Promise.resolve();
				observed.push(getScopedToken());
			};

			await Promise.all([
				withAzureDevOpsToken('pat-implementer', () => observe(3)),
				withAzureDevOpsToken('pat-reviewer', () => observe(1)),
			]);

			expect(observed).toEqual(['pat-reviewer', 'pat-implementer']);
		});
	});

	describe('azureDevOpsRequest', () => {
		it('joins the path onto dev.azure.com, appends api-version=7.1 and asks for JSON', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ id: 'repo-guid' }));

			const body = await withAzureDevOpsToken('pat-abc', () =>
				azureDevOpsRequest<{ id: string }>('GET', '/org/proj/_apis/git/repositories/repo'),
			);

			expect(body).toEqual({ id: 'repo-guid' });
			expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
				`${AZURE_DEVOPS_API_BASE}/org/proj/_apis/git/repositories/repo?api-version=7.1`,
			);
			expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
			expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe('manual');
			expect(headersOf(fetchMock).accept).toBe('application/json');
		});

		it('sends the scoped PAT as Basic auth with an empty username', async () => {
			fetchMock.mockResolvedValue(jsonResponse({}));

			await withAzureDevOpsToken('pat-abc', () => azureDevOpsRequest('GET', '/org/_apis/projects'));

			expect(headersOf(fetchMock).authorization).toBe(basic('pat-abc'));
		});

		it('keeps an api-version the caller already set, and sends none when asked not to', async () => {
			fetchMock.mockImplementation(async () => jsonResponse({}));

			await withAzureDevOpsToken('pat-abc', async () => {
				await azureDevOpsRequest('GET', '/org/_apis/x?api-version=7.1-preview.1');
				await azureDevOpsRequest('GET', '/org/_apis/connectionData', undefined, {
					apiVersion: null,
				});
			});

			expect(urlOf(fetchMock, 0).searchParams.getAll('api-version')).toEqual(['7.1-preview.1']);
			expect(urlOf(fetchMock, 1).searchParams.has('api-version')).toBe(false);
		});

		it('JSON-encodes a body and declares its content type', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ id: 7 }));

			await withAzureDevOpsToken('pat-abc', () =>
				azureDevOpsRequest('POST', '/org/proj/_apis/git/repositories/repo/pullRequests', {
					title: 'hello',
				}),
			);

			expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ title: 'hello' }));
			expect(headersOf(fetchMock)['content-type']).toBe('application/json');
		});

		it('resolves undefined for a 204 and for an empty 200', async () => {
			fetchMock
				.mockResolvedValueOnce(new Response(null, { status: 204 }))
				.mockResolvedValueOnce(new Response('', { status: 200 }));

			await withAzureDevOpsToken('pat-abc', async () => {
				await expect(azureDevOpsRequest('DELETE', '/org/_apis/x')).resolves.toBeUndefined();
				await expect(azureDevOpsRequest('GET', '/org/_apis/x')).resolves.toBeUndefined();
			});
		});

		it('throws an AzureDevOpsApiError carrying the status, the path, and the { message, typeKey } envelope', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse(
					{
						message: 'TF401019: The Git repository with name or identifier repo does not exist.',
						typeKey: 'GitRepositoryNotFoundException',
					},
					404,
				),
			);

			const thrown = await withAzureDevOpsToken('pat-abc', () =>
				azureDevOpsRequest('GET', '/org/proj/_apis/git/repositories/repo').catch(
					(err: unknown) => err,
				),
			);

			expect(thrown).toBeInstanceOf(AzureDevOpsApiError);
			const error = thrown as AzureDevOpsApiError;
			expect(error.status).toBe(404);
			expect(error.method).toBe('GET');
			// The path only — never the query string.
			expect(error.path).toBe('/org/proj/_apis/git/repositories/repo');
			expect(error.message).toContain('TF401019');
			expect(error.message).toContain('GitRepositoryNotFoundException');
		});

		it('falls back to a truncated raw body when the error response is not JSON', async () => {
			fetchMock.mockResolvedValue(
				new Response(`<html>502 Bad Gateway${'x'.repeat(500)}</html>`, { status: 502 }),
			);

			const thrown = (await withAzureDevOpsToken('pat-abc', () =>
				azureDevOpsRequest('GET', '/org/_apis/x').catch((err: unknown) => err),
			)) as AzureDevOpsApiError;

			expect(thrown.detail).toContain('502 Bad Gateway');
			expect(thrown.detail.length).toBe(200);
		});

		// A rejected PAT can come back as a "success" — never read it as data.
		describe('a rejected PAT disguised as success', () => {
			it('treats a 203 with an HTML sign-in page as an authentication failure', async () => {
				fetchMock.mockResolvedValue(htmlResponse(203));

				const thrown = await withAzureDevOpsToken('pat-abc', () =>
					azureDevOpsRequest('GET', '/org/_apis/x').catch((err: unknown) => err),
				);

				expect(thrown).toBeInstanceOf(AzureDevOpsApiError);
				expect((thrown as AzureDevOpsApiError).status).toBe(401);
				expect(String(thrown)).toMatch(/HTTP 203/);
			});

			it('treats a 302 redirect to sign-in as an authentication failure', async () => {
				fetchMock.mockResolvedValue(
					htmlResponse(302, { location: 'https://spsprodweu5.vssps.visualstudio.com/_signin' }),
				);

				const thrown = await withAzureDevOpsToken('pat-abc', () =>
					azureDevOpsRequest('GET', '/org/_apis/x').catch((err: unknown) => err),
				);

				expect((thrown as AzureDevOpsApiError).status).toBe(401);
				expect(String(thrown)).toMatch(/HTTP 302 redirect/);
			});

			it('treats a 200 with a non-JSON body as an authentication failure', async () => {
				fetchMock.mockResolvedValue(htmlResponse(200));

				const thrown = await withAzureDevOpsToken('pat-abc', () =>
					azureDevOpsRequest('GET', '/org/_apis/x').catch((err: unknown) => err),
				);

				expect((thrown as AzureDevOpsApiError).status).toBe(401);
				expect(String(thrown)).toMatch(/text\/html/);
			});
		});

		it('never puts the token in the thrown message', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ message: 'Unauthorized' }, 401));

			const thrown = await withAzureDevOpsToken('super-secret-pat', () =>
				azureDevOpsRequest('GET', '/org/_apis/x').catch((err: unknown) => err),
			);

			expect(String(thrown)).not.toContain('super-secret-pat');
			expect(String(thrown)).not.toContain(Buffer.from(':super-secret-pat').toString('base64'));
		});
	});

	describe('paginateAzureDevOps', () => {
		describe('continuation-token style', () => {
			function page(value: unknown[], token?: string): Response {
				return jsonResponse(
					{ count: value.length, value },
					200,
					token === undefined ? {} : { 'x-ms-continuationtoken': token },
				);
			}

			it('follows x-ms-continuationtoken and flattens every page', async () => {
				fetchMock
					.mockResolvedValueOnce(page([{ id: 1 }], 'cursor-2'))
					.mockResolvedValueOnce(page([{ id: 2 }]));

				const all = await withAzureDevOpsToken('pat-abc', () =>
					paginateAzureDevOps<{ id: number }>('/org/_apis/things?state=active', 'continuation'),
				);

				expect(all).toEqual([{ id: 1 }, { id: 2 }]);
				expect(urlOf(fetchMock, 0).searchParams.has('continuationToken')).toBe(false);
				expect(urlOf(fetchMock, 0).searchParams.get('state')).toBe('active');
				expect(urlOf(fetchMock, 1).searchParams.get('continuationToken')).toBe('cursor-2');
				expect(urlOf(fetchMock, 1).searchParams.get('api-version')).toBe('7.1');
			});

			it('refuses a token it has already followed', async () => {
				fetchMock.mockImplementation(async () => page([{ id: 1 }], 'same'));

				await expect(
					withAzureDevOpsToken('pat-abc', () =>
						paginateAzureDevOps('/org/_apis/t', 'continuation'),
					),
				).rejects.toThrow(/cyclic x-ms-continuationtoken cursor/);
				expect(fetchMock).toHaveBeenCalledTimes(2);
			});

			it('refuses to walk past the page cap', async () => {
				let n = 0;
				fetchMock.mockImplementation(async () => {
					n += 1;
					return page([{ id: n }], `cursor-${n}`);
				});

				await expect(
					withAzureDevOpsToken('pat-abc', () =>
						paginateAzureDevOps('/org/_apis/t', 'continuation'),
					),
				).rejects.toThrow(new RegExp(`exceeded maximum page count of ${MAX_PAGES}`));
				expect(fetchMock).toHaveBeenCalledTimes(MAX_PAGES);
			});

			it('tolerates a page without a value array', async () => {
				fetchMock.mockResolvedValue(jsonResponse({}));

				await expect(
					withAzureDevOpsToken('pat-abc', () =>
						paginateAzureDevOps('/org/_apis/t', 'continuation'),
					),
				).resolves.toEqual([]);
			});
		});

		describe('$top/$skip style', () => {
			const fullPage = (offset: number) =>
				Array.from({ length: PAGE_SIZE }, (_, i) => ({ id: offset + i }));

			it('advances $skip by the page size until a short page', async () => {
				fetchMock
					.mockResolvedValueOnce(jsonResponse({ value: fullPage(0) }))
					.mockResolvedValueOnce(jsonResponse({ value: [{ id: PAGE_SIZE }] }));

				const all = await withAzureDevOpsToken('pat-abc', () =>
					paginateAzureDevOps<{ id: number }>('/org/_apis/t', 'skip'),
				);

				expect(all).toHaveLength(PAGE_SIZE + 1);
				expect(urlOf(fetchMock, 0).searchParams.get('$top')).toBe(String(PAGE_SIZE));
				expect(urlOf(fetchMock, 0).searchParams.get('$skip')).toBe('0');
				expect(urlOf(fetchMock, 1).searchParams.get('$skip')).toBe(String(PAGE_SIZE));
			});

			it('refuses a server that ignores $skip and repeats the same page', async () => {
				fetchMock.mockImplementation(async () => jsonResponse({ value: fullPage(0) }));

				await expect(
					withAzureDevOpsToken('pat-abc', () => paginateAzureDevOps('/org/_apis/t', 'skip')),
				).rejects.toThrow(/same \$skip page twice/);
				expect(fetchMock).toHaveBeenCalledTimes(2);
			});

			it('refuses to walk past the page cap', async () => {
				let offset = 0;
				fetchMock.mockImplementation(async () => {
					const value = fullPage(offset);
					offset += PAGE_SIZE;
					return jsonResponse({ value });
				});

				await expect(
					withAzureDevOpsToken('pat-abc', () => paginateAzureDevOps('/org/_apis/t', 'skip')),
				).rejects.toThrow(new RegExp(`exceeded maximum page count of ${MAX_PAGES}`));
				expect(fetchMock).toHaveBeenCalledTimes(MAX_PAGES);
			});
		});
	});

	describe('repository coordinates', () => {
		it('splits the three-segment slug', () => {
			expect(azureRepoCoordinates('fabrikam/Fiber Project/web')).toEqual({
				organization: 'fabrikam',
				project: 'Fiber Project',
				repository: 'web',
			});
		});

		it.each(['owner/repo', 'a/b/c/d', 'org//repo', ''])('throws on any other shape: %j', (repo) => {
			expect(() => azureRepoCoordinates(repo)).toThrow(/organization\/project\/repository/);
		});

		it('URL-encodes each segment of the repository API path', () => {
			expect(repositoryApiPath('fabrikam/Fiber Project/web#app')).toBe(
				'/fabrikam/Fiber%20Project/_apis/git/repositories/web%23app',
			);
		});
	});

	describe('getAzureDevOpsUserForToken', () => {
		it('resolves the identity GUID from the organization-scoped connection data', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({
					authenticatedUser: {
						id: 'A1B2C3D4-0000-0000-0000-000000000001',
						providerDisplayName: 'Swarm Impl',
					},
				}),
			);

			await expect(getAzureDevOpsUserForToken('pat-abc', 'Fabrikam Org')).resolves.toBe(
				'A1B2C3D4-0000-0000-0000-000000000001',
			);
			expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
				`${AZURE_DEVOPS_API_BASE}/Fabrikam%20Org/_apis/connectionData`,
			);
			expect(headersOf(fetchMock).authorization).toBe(basic('pat-abc'));
		});

		it('fails closed when connection data names no user id', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({ authenticatedUser: { providerDisplayName: 'x' } }),
			);

			await expect(getAzureDevOpsUserForToken('pat-abc', 'org')).resolves.toBeNull();
		});

		it('returns null — never throws — when the PAT is rejected as a 203 sign-in page', async () => {
			fetchMock.mockResolvedValue(htmlResponse(203));

			await expect(getAzureDevOpsUserForToken('pat-abc', 'org')).resolves.toBeNull();
		});

		it('never logs the token when the lookup fails', async () => {
			const warn = vi.spyOn(await import('@/lib/logger.js').then((m) => m.logger), 'warn');
			fetchMock.mockResolvedValue(jsonResponse({ message: 'Unauthorized' }, 401));

			await getAzureDevOpsUserForToken('super-secret-pat', 'org');

			expect(warn).toHaveBeenCalled();
			expect(JSON.stringify(warn.mock.calls)).not.toContain('super-secret-pat');
			warn.mockRestore();
		});

		it('returns null for an absent token without calling the API', async () => {
			await expect(getAzureDevOpsUserForToken(null, 'org')).resolves.toBeNull();
			expect(fetchMock).not.toHaveBeenCalled();
		});
	});

	describe('getScopedAzureDevOpsUser', () => {
		it('reads the scoped account’s id, display name and sign-in address', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({
					authenticatedUser: {
						id: 'guid-1',
						providerDisplayName: 'Swarm Impl',
						properties: { Account: { $value: 'impl@fabrikam.com' } },
					},
				}),
			);

			await expect(
				withAzureDevOpsToken('pat-abc', () => getScopedAzureDevOpsUser('org')),
			).resolves.toEqual({ id: 'guid-1', displayName: 'Swarm Impl', email: 'impl@fabrikam.com' });
		});

		it('answers a null email when the account property is not an address', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({
					authenticatedUser: { id: 'guid-1', properties: { Account: { $value: 'svc-account' } } },
				}),
			);

			await expect(
				withAzureDevOpsToken('pat-abc', () => getScopedAzureDevOpsUser('org')),
			).resolves.toEqual({ id: 'guid-1', displayName: null, email: null });
		});

		// Unlike persona resolution, a delivery must not commit under an identity it
		// failed to resolve — so a failure propagates.
		it('throws rather than answering null when the PAT is rejected', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ message: 'Unauthorized' }, 401));

			await expect(
				withAzureDevOpsToken('pat-abc', () => getScopedAzureDevOpsUser('org')),
			).rejects.toBeInstanceOf(AzureDevOpsApiError);
		});

		it('throws when connection data names no user', async () => {
			fetchMock.mockResolvedValue(jsonResponse({}));

			await expect(
				withAzureDevOpsToken('pat-abc', () => getScopedAzureDevOpsUser('org')),
			).rejects.toThrow(/named no authenticated user/);
		});
	});
});
