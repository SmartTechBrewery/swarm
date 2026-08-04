import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	BITBUCKET_API_BASE,
	BitbucketApiError,
	withBitbucketCredential,
} from '@/integrations/scm/bitbucket/client.js';
import {
	getBitbucketCommitBuildStatus,
	getBitbucketPullRequest,
	getBitbucketPullRequestApprovals,
	getBitbucketPullRequestMergeState,
	getBitbucketPullRequestTitle,
	listBitbucketPullRequestsForCommit,
	listOpenBitbucketPullRequestsForBase,
} from '@/integrations/scm/bitbucket/pull-requests.js';

import {
	createMockBitbucketBuildStatusResponse,
	createMockBitbucketPullRequestResponse,
} from '../../../../helpers/factories.js';

/** A `fetch` stand-in typed with the real signature so `mock.calls` indexes. */
type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

const WORKSPACE = 'jkwiecien';
const SLUG = 'swarm';
const REPO_PATH = `${BITBUCKET_API_BASE}/repositories/${WORKSPACE}/${SLUG}`;
const FULL_SHA = 'd3022fc0ca3d65c7f6654eea129d6bf0cf0ee08e';

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

/** Every read must run inside a credential scope — the persona wrapper's job in production. */
function scoped<T>(fn: () => Promise<T>): Promise<T> {
	return withBitbucketCredential('token-abc', fn);
}

function requestedUrl(fetchMock: FetchMock, call = 0): string {
	return String(fetchMock.mock.calls[call]?.[0]);
}

describe('bitbucket pull-request reads', () => {
	let fetchMock: FetchMock;

	beforeEach(() => {
		fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal('fetch', fetchMock);
	});

	describe('getBitbucketPullRequest', () => {
		it('maps Bitbucket’s pull request onto the neutral shape', async () => {
			fetchMock.mockResolvedValue(jsonResponse(createMockBitbucketPullRequestResponse()));

			await expect(scoped(() => getBitbucketPullRequest(WORKSPACE, SLUG, 17))).resolves.toEqual({
				number: 17,
				headBranch: 'swarm/issue-17',
				headSha: 'd3022fc0ca3d',
				baseBranch: 'main',
				baseSha: 'ce5965ddd289',
				mergeable: null,
				authorLogin: 'human-dev',
			});
			expect(requestedUrl(fetchMock)).toBe(`${REPO_PATH}/pullrequests/17`);
		});

		it('reports mergeable as null — Bitbucket Cloud exposes no mergeability flag', async () => {
			fetchMock.mockResolvedValue(jsonResponse(createMockBitbucketPullRequestResponse()));

			const pr = await scoped(() => getBitbucketPullRequest(WORKSPACE, SLUG, 17));

			expect(pr.mergeable).toBeNull();
		});

		it('narrows a full 40-character hash to Bitbucket’s 12-character spelling', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse(
					createMockBitbucketPullRequestResponse({
						source: { branch: { name: 'topic' }, commit: { hash: FULL_SHA } },
					}),
				),
			);

			const pr = await scoped(() => getBitbucketPullRequest(WORKSPACE, SLUG, 17));

			expect(pr.headSha).toBe('d3022fc0ca3d');
		});

		it('reports a null author when Bitbucket exposes no nickname', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse(
					createMockBitbucketPullRequestResponse({ author: { account_id: 'account-1' } }),
				),
			);

			await expect(
				scoped(() => getBitbucketPullRequest(WORKSPACE, SLUG, 17)),
			).resolves.toMatchObject({ authorLogin: null });
		});

		it('throws rather than substituting a stand-in for a missing head commit', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse(createMockBitbucketPullRequestResponse({ source: { branch: { name: 'x' } } })),
			);

			await expect(scoped(() => getBitbucketPullRequest(WORKSPACE, SLUG, 17))).rejects.toThrow(
				/missing required fields/,
			);
		});

		it('surfaces a 404 as a BitbucketApiError rather than an empty value', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({ error: { message: 'Pull request not found' } }, 404),
			);

			const thrown = await scoped(() =>
				getBitbucketPullRequest(WORKSPACE, SLUG, 404).catch((err: unknown) => err),
			);

			expect(thrown).toBeInstanceOf(BitbucketApiError);
			expect((thrown as BitbucketApiError).status).toBe(404);
		});
	});

	describe('getBitbucketPullRequestTitle', () => {
		it('returns the title', async () => {
			fetchMock.mockResolvedValue(jsonResponse(createMockBitbucketPullRequestResponse()));

			await expect(scoped(() => getBitbucketPullRequestTitle(WORKSPACE, SLUG, 17))).resolves.toBe(
				'Add a thing',
			);
		});

		it('returns null when the response carries no title', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ id: 17 }));

			await expect(
				scoped(() => getBitbucketPullRequestTitle(WORKSPACE, SLUG, 17)),
			).resolves.toBeNull();
		});
	});

	describe('getBitbucketPullRequestMergeState', () => {
		const cases: Array<[state: string, expected: { merged: boolean; state: string }]> = [
			['OPEN', { merged: false, state: 'open' }],
			['MERGED', { merged: true, state: 'closed' }],
			['DECLINED', { merged: false, state: 'closed' }],
			['SUPERSEDED', { merged: false, state: 'closed' }],
		];

		for (const [state, expected] of cases) {
			it(`maps ${state} onto ${expected.state}${expected.merged ? ' + merged' : ''}`, async () => {
				fetchMock.mockResolvedValue(
					jsonResponse(createMockBitbucketPullRequestResponse({ state })),
				);

				await expect(
					scoped(() => getBitbucketPullRequestMergeState(WORKSPACE, SLUG, 17)),
				).resolves.toEqual({ ...expected, draft: false, headSha: 'd3022fc0ca3d' });
			});
		}

		it('reports a draft pull request', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse(createMockBitbucketPullRequestResponse({ draft: true })),
			);

			await expect(
				scoped(() => getBitbucketPullRequestMergeState(WORKSPACE, SLUG, 17)),
			).resolves.toMatchObject({ draft: true });
		});
	});

	describe('getBitbucketPullRequestApprovals', () => {
		it('maps participant verdicts onto GitHub’s review-state spelling', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse(
					createMockBitbucketPullRequestResponse({
						participants: [
							{ state: 'approved' },
							{ state: 'changes_requested' },
							{ state: null },
							{},
						],
					}),
				),
			);

			await expect(
				scoped(() => getBitbucketPullRequestApprovals(WORKSPACE, SLUG, 17)),
			).resolves.toEqual([
				{ state: 'APPROVED', commitId: 'd3022fc0ca3d' },
				{ state: 'CHANGES_REQUESTED', commitId: 'd3022fc0ca3d' },
			]);
		});

		it('is empty when nobody has ruled', async () => {
			fetchMock.mockResolvedValue(jsonResponse(createMockBitbucketPullRequestResponse()));

			await expect(
				scoped(() => getBitbucketPullRequestApprovals(WORKSPACE, SLUG, 17)),
			).resolves.toEqual([]);
		});
	});

	describe('listOpenBitbucketPullRequestsForBase', () => {
		it('filters server-side on state and destination branch', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ values: [] }));

			await scoped(() => listOpenBitbucketPullRequestsForBase(WORKSPACE, SLUG, 'main'));

			const url = new URL(requestedUrl(fetchMock));
			expect(url.pathname).toBe(`/2.0/repositories/${WORKSPACE}/${SLUG}/pullrequests`);
			expect(url.searchParams.get('q')).toBe('state="OPEN" AND destination.branch.name="main"');
		});

		it('escapes a quote in the branch name so the query literal can’t be broken out of', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ values: [] }));

			await scoped(() => listOpenBitbucketPullRequestsForBase(WORKSPACE, SLUG, 'we"ird'));

			expect(new URL(requestedUrl(fetchMock)).searchParams.get('q')).toBe(
				'state="OPEN" AND destination.branch.name="we\\"ird"',
			);
		});

		it('follows pagination and maps every page’s pull requests', async () => {
			fetchMock
				.mockResolvedValueOnce(
					jsonResponse({
						values: [createMockBitbucketPullRequestResponse()],
						next: `${REPO_PATH}/pullrequests?page=2`,
					}),
				)
				.mockResolvedValueOnce(
					jsonResponse({
						values: [
							createMockBitbucketPullRequestResponse({
								id: 18,
								source: {
									branch: { name: 'swarm/issue-18' },
									commit: { hash: 'aaaaaaaaaaaa' },
									repository: { full_name: 'jkwiecien/swarm' },
								},
							}),
						],
					}),
				);

			const candidates = await scoped(() =>
				listOpenBitbucketPullRequestsForBase(WORKSPACE, SLUG, 'main'),
			);

			expect(candidates.map((pr) => pr.number)).toEqual([17, 18]);
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});

		it('drops fork pull requests, whose head branch this repository does not have', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({
					values: [
						createMockBitbucketPullRequestResponse(),
						createMockBitbucketPullRequestResponse({
							id: 19,
							source: {
								branch: { name: 'fork-topic' },
								commit: { hash: 'bbbbbbbbbbbb' },
								repository: { full_name: 'someone-else/swarm' },
							},
						}),
					],
				}),
			);

			const candidates = await scoped(() =>
				listOpenBitbucketPullRequestsForBase(WORKSPACE, SLUG, 'main'),
			);

			expect(candidates.map((pr) => pr.number)).toEqual([17]);
		});

		it('drops a pull request whose source repository is gone', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({
					values: [
						createMockBitbucketPullRequestResponse({
							source: { branch: { name: 'topic' }, commit: { hash: 'cccccccccccc' } },
						}),
					],
				}),
			);

			await expect(
				scoped(() => listOpenBitbucketPullRequestsForBase(WORKSPACE, SLUG, 'main')),
			).resolves.toEqual([]);
		});
	});

	describe('getBitbucketCommitBuildStatus', () => {
		it('aggregates every build status on the commit', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({
					values: [
						createMockBitbucketBuildStatusResponse(),
						createMockBitbucketBuildStatusResponse({
							key: 'LINT',
							name: 'Lint',
							state: 'FAILED',
						}),
						createMockBitbucketBuildStatusResponse({
							key: 'E2E',
							name: 'End to end',
							state: 'INPROGRESS',
						}),
						createMockBitbucketBuildStatusResponse({
							key: 'DEPLOY',
							name: 'Deploy',
							state: 'STOPPED',
						}),
					],
				}),
			);

			await expect(
				scoped(() => getBitbucketCommitBuildStatus(WORKSPACE, SLUG, FULL_SHA)),
			).resolves.toEqual({
				totalCount: 4,
				checkRuns: [
					{ name: 'Unit Tests', status: 'completed', conclusion: 'success' },
					{ name: 'Lint', status: 'completed', conclusion: 'failure' },
					{ name: 'End to end', status: 'in_progress', conclusion: null },
					{ name: 'Deploy', status: 'completed', conclusion: 'cancelled' },
				],
			});
			expect(new URL(requestedUrl(fetchMock)).pathname).toBe(
				`/2.0/repositories/${WORKSPACE}/${SLUG}/commit/${FULL_SHA}/statuses`,
			);
		});

		it('reports totalCount 0 for a commit with no statuses', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ values: [] }));

			await expect(
				scoped(() => getBitbucketCommitBuildStatus(WORKSPACE, SLUG, FULL_SHA)),
			).resolves.toEqual({ totalCount: 0, checkRuns: [] });
		});

		it('keeps only the newest status per key, so a re-run’s stale failure never leaks in', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({
					values: [
						createMockBitbucketBuildStatusResponse({
							state: 'FAILED',
							updated_on: '2026-08-04T10:00:00.000000+00:00',
						}),
						createMockBitbucketBuildStatusResponse({
							state: 'SUCCESSFUL',
							updated_on: '2026-08-04T11:00:00.000000+00:00',
						}),
					],
				}),
			);

			await expect(
				scoped(() => getBitbucketCommitBuildStatus(WORKSPACE, SLUG, FULL_SHA)),
			).resolves.toEqual({
				totalCount: 1,
				checkRuns: [{ name: 'Unit Tests', status: 'completed', conclusion: 'success' }],
			});
		});

		it('treats an unrecognized state as still running so the aggregate defers', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({
					values: [createMockBitbucketBuildStatusResponse({ state: 'PAUSED_FOR_APPROVAL' })],
				}),
			);

			await expect(
				scoped(() => getBitbucketCommitBuildStatus(WORKSPACE, SLUG, FULL_SHA)),
			).resolves.toMatchObject({
				checkRuns: [{ name: 'Unit Tests', status: 'in_progress', conclusion: null }],
			});
		});

		it('falls back to the status key, then a placeholder, for an unnamed status', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({
					values: [
						createMockBitbucketBuildStatusResponse({ name: undefined }),
						createMockBitbucketBuildStatusResponse({ key: undefined, name: undefined }),
					],
				}),
			);

			const aggregate = await scoped(() =>
				getBitbucketCommitBuildStatus(WORKSPACE, SLUG, FULL_SHA),
			);

			expect(aggregate.checkRuns.map((run) => run.name)).toEqual([
				'UNIT-TESTS',
				'<unnamed build status>',
			]);
		});

		it('surfaces a 404 rather than reporting a commit with no checks', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'Commit not found' } }, 404));

			await expect(
				scoped(() => getBitbucketCommitBuildStatus(WORKSPACE, SLUG, FULL_SHA)),
			).rejects.toBeInstanceOf(BitbucketApiError);
		});
	});

	describe('listBitbucketPullRequestsForCommit', () => {
		it('resolves the pull requests a commit belongs to', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({
					values: [
						createMockBitbucketPullRequestResponse(),
						createMockBitbucketPullRequestResponse({
							id: 18,
							state: 'MERGED',
							source: { branch: { name: 'swarm/issue-18' }, commit: { hash: 'aaaaaaaaaaaa' } },
						}),
					],
				}),
			);

			await expect(
				scoped(() => listBitbucketPullRequestsForCommit(WORKSPACE, SLUG, FULL_SHA)),
			).resolves.toEqual([
				{ number: 17, state: 'OPEN', headBranch: 'swarm/issue-17' },
				{ number: 18, state: 'MERGED', headBranch: 'swarm/issue-18' },
			]);
			expect(new URL(requestedUrl(fetchMock)).pathname).toBe(
				`/2.0/repositories/${WORKSPACE}/${SLUG}/commit/${FULL_SHA}/pullrequests`,
			);
		});

		it('is empty when the commit belongs to no pull request', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ values: [] }));

			await expect(
				scoped(() => listBitbucketPullRequestsForCommit(WORKSPACE, SLUG, FULL_SHA)),
			).resolves.toEqual([]);
		});
	});

	it('refuses to read outside a credential scope', async () => {
		await expect(getBitbucketPullRequest(WORKSPACE, SLUG, 17)).rejects.toThrow(
			/No Bitbucket credential in scope/,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
