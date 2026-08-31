import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	GITLAB_API_BASE,
	GitLabApiError,
	PER_PAGE,
	withGitLabToken,
} from '@/integrations/scm/gitlab/client.js';
import {
	findOpenGitLabMergeRequest,
	getGitLabCommitStatuses,
	getGitLabMergeRequest,
	getGitLabMergeRequestApprovals,
	getGitLabMergeRequestMergeState,
	getGitLabMergeRequestTitle,
	listGitLabMergeRequestsForCommit,
	listOpenGitLabMergeRequestsForBase,
} from '@/integrations/scm/gitlab/merge-requests.js';

import {
	createMockGitLabCommitStatusResponse,
	createMockGitLabMergeRequestResponse,
} from '../../../../helpers/factories.js';

/** A `fetch` stand-in typed with the real signature so `mock.calls` indexes. */
type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

const REPO = 'jkwiecien/swarm';
/** GitLab addresses the project by its URL-encoded path — one segment, not a split pair. */
const PROJECT_PATH = '/projects/jkwiecien%2Fswarm';
const HEAD_SHA = 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7';
const BASE_SHA = 'ce5965ddd2890b1e39d0f7b0d5b1e3f0b2c4a6d8';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers },
	});
}

/** Every read must run inside a token scope — the persona wrapper's job in production. */
function scoped<T>(fn: () => Promise<T>): Promise<T> {
	return withGitLabToken('token-abc', fn);
}

function requestedUrl(fetchMock: FetchMock, call = 0): string {
	return String(fetchMock.mock.calls[call]?.[0]);
}

function requestedUrls(fetchMock: FetchMock): string[] {
	return fetchMock.mock.calls.map((call) => String(call[0]));
}

/**
 * Answer by URL fragment rather than call order — the conflict-candidate read fans a
 * list page out into one detail request per candidate, so an ordered mock chain would
 * encode an implementation detail the test isn't asserting.
 */
function routeFetch(fetchMock: FetchMock, routes: Array<[fragment: string, body: unknown]>): void {
	fetchMock.mockImplementation(async (input) => {
		const url = String(input);
		const route = routes.find(([fragment]) => url.includes(fragment));
		return route ? jsonResponse(route[1]) : jsonResponse({ message: `404 Not Found: ${url}` }, 404);
	});
}

describe('gitlab merge-request reads', () => {
	let fetchMock: FetchMock;

	beforeEach(() => {
		fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal('fetch', fetchMock);
	});

	describe('getGitLabMergeRequest', () => {
		it('maps GitLab’s merge request onto the neutral shape', async () => {
			fetchMock.mockResolvedValue(jsonResponse(createMockGitLabMergeRequestResponse()));

			await expect(scoped(() => getGitLabMergeRequest(REPO, 17))).resolves.toEqual({
				number: 17,
				headBranch: 'swarm/issue-17',
				headSha: HEAD_SHA,
				baseBranch: 'main',
				baseSha: BASE_SHA,
				mergeable: true,
				authorLogin: 'human-dev',
				state: 'open',
			});
			expect(requestedUrl(fetchMock)).toBe(`${GITLAB_API_BASE}${PROJECT_PATH}/merge_requests/17`);
		});

		// The contract's neutral pair, so a mergeability recheck can see that the merge
		// request it is polling is already done (issue #772).
		it.each([
			'merged',
			'closed',
			'locked',
		])('reports a %s merge request as closed', async (state) => {
			fetchMock.mockResolvedValue(jsonResponse(createMockGitLabMergeRequestResponse({ state })));

			await expect(scoped(() => getGitLabMergeRequest(REPO, 17))).resolves.toMatchObject({
				state: 'closed',
			});
		});

		it('reports the iid as the number, not the global id', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse(createMockGitLabMergeRequestResponse({ id: 155016530, iid: 133 })),
			);

			await expect(scoped(() => getGitLabMergeRequest(REPO, 133))).resolves.toMatchObject({
				number: 133,
			});
		});

		it('reports the merge base as baseSha, not the target branch tip', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse(
					createMockGitLabMergeRequestResponse({
						diff_refs: { base_sha: 'aaaa000000000000000000000000000000000000', head_sha: HEAD_SHA },
					}),
				),
			);

			await expect(scoped(() => getGitLabMergeRequest(REPO, 17))).resolves.toMatchObject({
				baseSha: 'aaaa000000000000000000000000000000000000',
			});
		});

		it('reports a null author when GitLab exposes no username', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse(createMockGitLabMergeRequestResponse({ author: { id: 6 } })),
			);

			await expect(scoped(() => getGitLabMergeRequest(REPO, 17))).resolves.toMatchObject({
				authorLogin: null,
			});
		});

		// GitLab reports real mergeability, unlike Bitbucket, so the whole tri-state has
		// to survive the mapping: `false` sends the conflict trigger in, `null` makes it
		// defer, and a *policy* blocker must not be mistaken for a conflict.
		describe('mergeable', () => {
			const cases: Array<{
				mergeStatus: string | undefined;
				detailed: string | undefined;
				expected: boolean | null;
			}> = [
				{ mergeStatus: 'can_be_merged', detailed: 'mergeable', expected: true },
				{ mergeStatus: 'cannot_be_merged', detailed: 'conflict', expected: false },
				{ mergeStatus: 'checking', detailed: 'checking', expected: null },
				{ mergeStatus: 'unchecked', detailed: 'preparing', expected: null },
				// `merge_status` wins over `detailed_merge_status`: it answers the git-only
				// question the contract asks, where the detailed field also reports policy.
				{ mergeStatus: 'can_be_merged', detailed: 'not_approved', expected: true },
				// An undocumented internal `merge_status` falls through to the detailed field,
				// which is also the path for `merge_status` disappearing in a future API version.
				{ mergeStatus: 'cannot_be_merged_recheck', detailed: 'conflict', expected: false },
				{ mergeStatus: 'cannot_be_merged_recheck', detailed: undefined, expected: null },
				{ mergeStatus: undefined, detailed: 'mergeable', expected: true },
				{ mergeStatus: undefined, detailed: 'conflict', expected: false },
				{ mergeStatus: undefined, detailed: 'broken_status', expected: false },
				{ mergeStatus: undefined, detailed: 'commits_status', expected: false },
				{ mergeStatus: undefined, detailed: 'checking', expected: null },
				{ mergeStatus: undefined, detailed: 'preparing', expected: null },
				{ mergeStatus: undefined, detailed: 'unchecked', expected: null },
				{ mergeStatus: undefined, detailed: 'not_approved', expected: true },
				{ mergeStatus: undefined, detailed: 'ci_still_running', expected: true },
				{ mergeStatus: undefined, detailed: 'discussions_not_resolved', expected: true },
				{ mergeStatus: undefined, detailed: 'draft_status', expected: true },
				{ mergeStatus: undefined, detailed: 'requested_changes', expected: true },
				{ mergeStatus: undefined, detailed: 'need_rebase', expected: true },
				{ mergeStatus: undefined, detailed: 'a_status_gitlab_added_later', expected: true },
				{ mergeStatus: undefined, detailed: undefined, expected: null },
			];

			for (const { mergeStatus, detailed, expected } of cases) {
				it(`is ${expected} for merge_status=${mergeStatus} / detailed_merge_status=${detailed}`, async () => {
					fetchMock.mockResolvedValue(
						jsonResponse(
							createMockGitLabMergeRequestResponse({
								merge_status: mergeStatus,
								detailed_merge_status: detailed,
							}),
						),
					);

					const mr = await scoped(() => getGitLabMergeRequest(REPO, 17));

					expect(mr.mergeable).toBe(expected);
				});
			}
		});

		// Each of these becomes part of an exact-match conflict claim key, so a stand-in
		// would key a claim on the wrong commit instead of failing.
		const missingFields: Array<[label: string, overrides: Record<string, unknown>]> = [
			['the head sha', { sha: undefined }],
			['the source branch', { source_branch: undefined }],
			['the target branch', { target_branch: undefined }],
			['the iid', { iid: undefined }],
			['diff_refs entirely', { diff_refs: undefined }],
			['the merge base inside diff_refs', { diff_refs: { head_sha: HEAD_SHA } }],
		];

		for (const [label, overrides] of missingFields) {
			it(`throws rather than substituting a stand-in when ${label} is absent`, async () => {
				fetchMock.mockResolvedValue(jsonResponse(createMockGitLabMergeRequestResponse(overrides)));

				await expect(scoped(() => getGitLabMergeRequest(REPO, 17))).rejects.toThrow(
					/missing required fields/,
				);
			});
		}

		it('throws rather than defaulting a missing state to either side', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse(createMockGitLabMergeRequestResponse({ state: undefined })),
			);

			await expect(scoped(() => getGitLabMergeRequest(REPO, 17))).rejects.toThrow(
				/missing required fields/,
			);
		});

		it('surfaces a 404 as a GitLabApiError rather than an empty value', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ message: '404 Not found' }, 404));

			const thrown = await scoped(() =>
				getGitLabMergeRequest(REPO, 404).catch((err: unknown) => err),
			);

			expect(thrown).toBeInstanceOf(GitLabApiError);
			expect((thrown as GitLabApiError).status).toBe(404);
		});
	});

	describe('getGitLabMergeRequestTitle', () => {
		it('returns the title', async () => {
			fetchMock.mockResolvedValue(jsonResponse(createMockGitLabMergeRequestResponse()));

			await expect(scoped(() => getGitLabMergeRequestTitle(REPO, 17))).resolves.toBe('Add a thing');
		});

		it('returns null when the response carries no title', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ iid: 17 }));

			await expect(scoped(() => getGitLabMergeRequestTitle(REPO, 17))).resolves.toBeNull();
		});

		it('surfaces a 401 rather than reporting an untitled merge request', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ message: '401 Unauthorized' }, 401));

			await expect(scoped(() => getGitLabMergeRequestTitle(REPO, 17))).rejects.toBeInstanceOf(
				GitLabApiError,
			);
		});
	});

	describe('getGitLabMergeRequestMergeState', () => {
		const cases: Array<[state: string, expected: { merged: boolean; state: string }]> = [
			['opened', { merged: false, state: 'open' }],
			['merged', { merged: true, state: 'closed' }],
			['closed', { merged: false, state: 'closed' }],
			['locked', { merged: false, state: 'closed' }],
		];

		for (const [state, expected] of cases) {
			it(`maps ${state} onto ${expected.state}${expected.merged ? ' + merged' : ''}`, async () => {
				fetchMock.mockResolvedValue(jsonResponse(createMockGitLabMergeRequestResponse({ state })));

				await expect(scoped(() => getGitLabMergeRequestMergeState(REPO, 17))).resolves.toEqual({
					...expected,
					draft: false,
					headSha: HEAD_SHA,
					changesRequested: false,
					behindBase: null,
				});
			});
		}

		it('reports a draft merge request', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse(createMockGitLabMergeRequestResponse({ draft: true })),
			);

			await expect(scoped(() => getGitLabMergeRequestMergeState(REPO, 17))).resolves.toMatchObject({
				draft: true,
			});
		});

		// The verdict lives on `reviewers[].state`, which the approvals endpoint does not
		// carry — `detailed_merge_status` is where a single merge-request read exposes it.
		it('reports a standing changes-requested verdict off detailed_merge_status', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse(
					createMockGitLabMergeRequestResponse({
						merge_status: 'can_be_merged',
						detailed_merge_status: 'requested_changes',
					}),
				),
			);

			await expect(scoped(() => getGitLabMergeRequestMergeState(REPO, 17))).resolves.toMatchObject({
				changesRequested: true,
			});
		});

		// Base freshness (issue #874). GitLab computes the count only when asked, so
		// the request has to carry the opt-in — and a response without it means
		// "cannot say", never "up to date".
		it('asks GitLab for the divergence count and reports a behind head', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse(createMockGitLabMergeRequestResponse({ diverged_commits_count: 3 })),
			);

			await expect(scoped(() => getGitLabMergeRequestMergeState(REPO, 17))).resolves.toMatchObject({
				behindBase: true,
			});
			const url = new URL(requestedUrl(fetchMock));
			expect(url.pathname).toBe(`/api/v4${PROJECT_PATH}/merge_requests/17`);
			expect(url.searchParams.get('include_diverged_commits_count')).toBe('true');
		});

		it('reports a zero divergence count as up to date', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse(createMockGitLabMergeRequestResponse({ diverged_commits_count: 0 })),
			);

			await expect(scoped(() => getGitLabMergeRequestMergeState(REPO, 17))).resolves.toMatchObject({
				behindBase: false,
			});
		});

		it('throws rather than reporting a merge state with no head to pin a merge to', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse(createMockGitLabMergeRequestResponse({ sha: undefined })),
			);

			await expect(scoped(() => getGitLabMergeRequestMergeState(REPO, 17))).rejects.toThrow(
				/carries no sha/,
			);
		});
	});

	describe('findOpenGitLabMergeRequest', () => {
		it('filters server-side on the source branch and maps the first match', async () => {
			fetchMock.mockResolvedValue(jsonResponse([createMockGitLabMergeRequestResponse()]));

			await expect(
				scoped(() => findOpenGitLabMergeRequest(REPO, 'swarm/issue-17')),
			).resolves.toEqual({
				number: 17,
				url: 'https://gitlab.com/jkwiecien/swarm/-/merge_requests/17',
			});
			const url = new URL(requestedUrl(fetchMock));
			expect(url.pathname).toBe(`/api/v4${PROJECT_PATH}/merge_requests`);
			expect(url.searchParams.get('state')).toBe('opened');
			expect(url.searchParams.get('source_branch')).toBe('swarm/issue-17');
		});

		it('reports no open merge request rather than throwing', async () => {
			fetchMock.mockResolvedValue(jsonResponse([]));

			await expect(
				scoped(() => findOpenGitLabMergeRequest(REPO, 'swarm/issue-17')),
			).resolves.toBeUndefined();
		});

		it('derives the web URL when GitLab’s response carries none', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse([createMockGitLabMergeRequestResponse({ web_url: undefined })]),
			);

			await expect(
				scoped(() => findOpenGitLabMergeRequest(REPO, 'swarm/issue-17')),
			).resolves.toMatchObject({
				url: 'https://gitlab.com/jkwiecien/swarm/-/merge_requests/17',
			});
		});

		it('throws rather than referencing a merge request with no iid', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse([createMockGitLabMergeRequestResponse({ iid: undefined })]),
			);

			await expect(
				scoped(() => findOpenGitLabMergeRequest(REPO, 'swarm/issue-17')),
			).rejects.toThrow(/carries no iid/);
		});
	});

	describe('getGitLabMergeRequestApprovals', () => {
		it('maps standing approvals onto GitHub’s review-state spelling', async () => {
			routeFetch(fetchMock, [
				[
					'/approvals',
					{
						approvals_required: 2,
						approvals_left: 0,
						approved_by: [{ user: { username: 'swarm-rev' } }, { user: { username: 'human-dev' } }],
					},
				],
				['/merge_requests/17', createMockGitLabMergeRequestResponse()],
			]);

			await expect(scoped(() => getGitLabMergeRequestApprovals(REPO, 17))).resolves.toEqual([
				{ state: 'APPROVED', commitId: HEAD_SHA },
				{ state: 'APPROVED', commitId: HEAD_SHA },
			]);
			expect(requestedUrls(fetchMock)).toContain(
				`${GITLAB_API_BASE}${PROJECT_PATH}/merge_requests/17/approvals`,
			);
		});

		it('is empty when nobody has approved', async () => {
			routeFetch(fetchMock, [
				['/approvals', { approvals_required: 1, approvals_left: 1, approved_by: [] }],
				['/merge_requests/17', createMockGitLabMergeRequestResponse()],
			]);

			await expect(scoped(() => getGitLabMergeRequestApprovals(REPO, 17))).resolves.toEqual([]);
		});

		it('carries the merge request’s current head, since GitLab pins an approval to no commit', async () => {
			routeFetch(fetchMock, [
				['/approvals', { approved_by: [{ user: { username: 'swarm-rev' } }] }],
				[
					'/merge_requests/17',
					createMockGitLabMergeRequestResponse({
						sha: 'bbbb000000000000000000000000000000000000',
					}),
				],
			]);

			await expect(scoped(() => getGitLabMergeRequestApprovals(REPO, 17))).resolves.toEqual([
				{ state: 'APPROVED', commitId: 'bbbb000000000000000000000000000000000000' },
			]);
		});

		// A fresh `Response` per call: this read issues two requests, and one response
		// body can only be consumed once.
		it('surfaces a 404 rather than reporting an unapproved merge request', async () => {
			fetchMock.mockImplementation(async () => jsonResponse({ message: '404 Not found' }, 404));

			await expect(scoped(() => getGitLabMergeRequestApprovals(REPO, 17))).rejects.toBeInstanceOf(
				GitLabApiError,
			);
		});
	});

	describe('listOpenGitLabMergeRequestsForBase', () => {
		it('filters server-side on state and target branch', async () => {
			fetchMock.mockResolvedValue(jsonResponse([]));

			await scoped(() => listOpenGitLabMergeRequestsForBase(REPO, 'main'));

			const url = new URL(requestedUrl(fetchMock));
			expect(url.pathname).toBe(`/api/v4${PROJECT_PATH}/merge_requests`);
			expect(url.searchParams.get('state')).toBe('opened');
			expect(url.searchParams.get('target_branch')).toBe('main');
			expect(url.searchParams.get('per_page')).toBe(String(PER_PAGE));
		});

		it('is empty for a base branch with no open merge requests', async () => {
			fetchMock.mockResolvedValue(jsonResponse([]));

			await expect(scoped(() => listOpenGitLabMergeRequestsForBase(REPO, 'main'))).resolves.toEqual(
				[],
			);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		// The list endpoint omits `diff_refs` and serves a cached `merge_status`, so the
		// candidate's merge base and mergeability both have to come from a single-merge-request
		// read — which is also what asks GitLab to recompute mergeability.
		it('re-reads each candidate so its merge base and mergeability are real', async () => {
			routeFetch(fetchMock, [
				[
					'/merge_requests/17',
					createMockGitLabMergeRequestResponse({
						merge_status: 'cannot_be_merged',
						detailed_merge_status: 'conflict',
					}),
				],
				[
					'/merge_requests?',
					[
						{
							iid: 17,
							source_branch: 'swarm/issue-17',
							target_branch: 'main',
							source_project_id: 42,
							target_project_id: 42,
							merge_status: 'unchecked',
						},
					],
				],
			]);

			await expect(scoped(() => listOpenGitLabMergeRequestsForBase(REPO, 'main'))).resolves.toEqual(
				[
					{
						number: 17,
						headBranch: 'swarm/issue-17',
						headSha: HEAD_SHA,
						baseBranch: 'main',
						baseSha: BASE_SHA,
						mergeable: false,
						authorLogin: 'human-dev',
						state: 'open',
					},
				],
			);
			expect(requestedUrls(fetchMock)).toContain(
				`${GITLAB_API_BASE}${PROJECT_PATH}/merge_requests/17`,
			);
		});

		it('follows pagination and maps every page’s merge requests', async () => {
			const listEntry = (iid: number) => ({
				iid,
				source_branch: `swarm/issue-${iid}`,
				target_branch: 'main',
				source_project_id: 42,
				target_project_id: 42,
			});
			fetchMock.mockImplementation(async (input) => {
				const url = new URL(String(input));
				if (url.pathname.endsWith('/merge_requests/17'))
					return jsonResponse(createMockGitLabMergeRequestResponse());
				if (url.pathname.endsWith('/merge_requests/18'))
					return jsonResponse(
						createMockGitLabMergeRequestResponse({ iid: 18, source_branch: 'swarm/issue-18' }),
					);
				return url.searchParams.get('page') === '1'
					? jsonResponse([listEntry(17)], 200, { 'x-next-page': '2' })
					: jsonResponse([listEntry(18)]);
			});

			const candidates = await scoped(() => listOpenGitLabMergeRequestsForBase(REPO, 'main'));

			expect(candidates.map((mr) => mr.number)).toEqual([17, 18]);
		});

		it('limits concurrent candidate detail reads', async () => {
			const listEntry = (iid: number) => ({
				iid,
				source_branch: `swarm/issue-${iid}`,
				target_branch: 'main',
				source_project_id: 42,
				target_project_id: 42,
			});
			let releaseDetails: (() => void) | undefined;
			const detailsReady = new Promise<void>((resolve) => {
				releaseDetails = resolve;
			});
			fetchMock.mockImplementation(async (input) => {
				const url = new URL(String(input));
				if (url.pathname.endsWith('/merge_requests')) {
					return jsonResponse(Array.from({ length: 11 }, (_, index) => listEntry(index + 17)));
				}
				await detailsReady;
				const iid = Number(url.pathname.split('/').at(-1));
				return jsonResponse(createMockGitLabMergeRequestResponse({ iid }));
			});

			const candidates = scoped(() => listOpenGitLabMergeRequestsForBase(REPO, 'main'));
			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(11));
			releaseDetails?.();

			await expect(candidates).resolves.toHaveLength(11);
		});

		it('drops fork merge requests, whose source branch this project does not have', async () => {
			routeFetch(fetchMock, [
				['/merge_requests/17', createMockGitLabMergeRequestResponse()],
				[
					'/merge_requests?',
					[
						{
							iid: 17,
							source_branch: 'swarm/issue-17',
							target_branch: 'main',
							source_project_id: 42,
							target_project_id: 42,
						},
						{
							iid: 19,
							source_branch: 'fork-topic',
							target_branch: 'main',
							source_project_id: 77,
							target_project_id: 42,
						},
					],
				],
			]);

			const candidates = await scoped(() => listOpenGitLabMergeRequestsForBase(REPO, 'main'));

			expect(candidates.map((mr) => mr.number)).toEqual([17]);
			expect(requestedUrls(fetchMock)).not.toContain(
				`${GITLAB_API_BASE}${PROJECT_PATH}/merge_requests/19`,
			);
		});

		it('drops a merge request whose project ids GitLab did not report', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse([{ iid: 20, source_branch: 'topic', target_branch: 'main' }]),
			);

			await expect(scoped(() => listOpenGitLabMergeRequestsForBase(REPO, 'main'))).resolves.toEqual(
				[],
			);
		});

		it('surfaces a 404 rather than reporting that nothing can conflict', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ message: '404 Project Not Found' }, 404));

			await expect(
				scoped(() => listOpenGitLabMergeRequestsForBase(REPO, 'main')),
			).rejects.toBeInstanceOf(GitLabApiError);
		});
	});

	describe('getGitLabCommitStatuses', () => {
		it('aggregates every commit status on the commit', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse([
					createMockGitLabCommitStatusResponse(),
					createMockGitLabCommitStatusResponse({ name: 'lint', status: 'failed' }),
					createMockGitLabCommitStatusResponse({ name: 'e2e', status: 'running' }),
					createMockGitLabCommitStatusResponse({ name: 'deploy', status: 'canceled' }),
					createMockGitLabCommitStatusResponse({ name: 'docs', status: 'skipped' }),
				]),
			);

			await expect(scoped(() => getGitLabCommitStatuses(REPO, HEAD_SHA))).resolves.toEqual({
				totalCount: 5,
				checkRuns: [
					{ name: 'unit-tests', status: 'completed', conclusion: 'success' },
					{ name: 'lint', status: 'completed', conclusion: 'failure' },
					{ name: 'e2e', status: 'in_progress', conclusion: null },
					{ name: 'deploy', status: 'completed', conclusion: 'cancelled' },
					{ name: 'docs', status: 'completed', conclusion: 'skipped' },
				],
			});
			expect(new URL(requestedUrl(fetchMock)).pathname).toBe(
				`/api/v4${PROJECT_PATH}/repository/commits/${HEAD_SHA}/statuses`,
			);
		});

		it('reports totalCount 0 for a commit with no statuses', async () => {
			fetchMock.mockResolvedValue(jsonResponse([]));

			await expect(scoped(() => getGitLabCommitStatuses(REPO, HEAD_SHA))).resolves.toEqual({
				totalCount: 0,
				checkRuns: [],
			});
		});

		it('keeps only the newest status per name, so a re-run’s stale failure never leaks in', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse([
					createMockGitLabCommitStatusResponse({
						status: 'failed',
						finished_at: '2026-08-04T10:05:00.000Z',
					}),
					createMockGitLabCommitStatusResponse({
						status: 'success',
						finished_at: '2026-08-04T11:05:00.000Z',
					}),
				]),
			);

			await expect(scoped(() => getGitLabCommitStatuses(REPO, HEAD_SHA))).resolves.toEqual({
				totalCount: 1,
				checkRuns: [{ name: 'unit-tests', status: 'completed', conclusion: 'success' }],
			});
		});

		it('lets a re-run that has not finished yet defer the aggregate', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse([
					createMockGitLabCommitStatusResponse({
						status: 'failed',
						created_at: '2026-08-04T10:00:00.000Z',
						finished_at: '2026-08-04T10:05:00.000Z',
					}),
					createMockGitLabCommitStatusResponse({
						status: 'running',
						created_at: '2026-08-04T11:00:00.000Z',
						finished_at: undefined,
					}),
				]),
			);

			await expect(scoped(() => getGitLabCommitStatuses(REPO, HEAD_SHA))).resolves.toEqual({
				totalCount: 1,
				checkRuns: [{ name: 'unit-tests', status: 'in_progress', conclusion: null }],
			});
		});

		it('maps advisory failures and manual jobs to skipped so they cannot block CI', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse([
					createMockGitLabCommitStatusResponse(),
					createMockGitLabCommitStatusResponse({
						name: 'bundler:audit',
						status: 'failed',
						allow_failure: true,
					}),
					createMockGitLabCommitStatusResponse({
						name: 'optional deploy',
						status: 'manual',
						allow_failure: true,
					}),
				]),
			);

			await expect(scoped(() => getGitLabCommitStatuses(REPO, HEAD_SHA))).resolves.toEqual({
				totalCount: 3,
				checkRuns: [
					{ name: 'unit-tests', status: 'completed', conclusion: 'success' },
					{ name: 'bundler:audit', status: 'completed', conclusion: 'skipped' },
					{ name: 'optional deploy', status: 'completed', conclusion: 'skipped' },
				],
			});
		});

		it('keeps all-advisory pipelines reviewable', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse([
					createMockGitLabCommitStatusResponse({
						name: 'bundler:audit',
						status: 'failed',
						allow_failure: true,
					}),
					createMockGitLabCommitStatusResponse({
						name: 'optional deploy',
						status: 'manual',
						allow_failure: true,
					}),
				]),
			);

			await expect(scoped(() => getGitLabCommitStatuses(REPO, HEAD_SHA))).resolves.toEqual({
				totalCount: 2,
				checkRuns: [
					{ name: 'bundler:audit', status: 'completed', conclusion: 'skipped' },
					{ name: 'optional deploy', status: 'completed', conclusion: 'skipped' },
				],
			});
		});

		it('treats an unrecognized status as still running so the aggregate defers', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse([
					createMockGitLabCommitStatusResponse({ name: 'gate', status: 'manual' }),
					createMockGitLabCommitStatusResponse({ name: 'wait', status: 'waiting_for_resource' }),
					createMockGitLabCommitStatusResponse({ name: 'cancelling', status: 'canceling' }),
					createMockGitLabCommitStatusResponse({ name: 'nameless', status: undefined }),
				]),
			);

			await expect(scoped(() => getGitLabCommitStatuses(REPO, HEAD_SHA))).resolves.toMatchObject({
				checkRuns: [
					{ name: 'gate', status: 'in_progress', conclusion: null },
					{ name: 'wait', status: 'in_progress', conclusion: null },
					{ name: 'cancelling', status: 'in_progress', conclusion: null },
					{ name: 'nameless', status: 'in_progress', conclusion: null },
				],
			});
		});

		it('counts an unnamed status on its own rather than collapsing them', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse([
					createMockGitLabCommitStatusResponse({ name: undefined }),
					createMockGitLabCommitStatusResponse({ name: undefined, status: 'failed' }),
				]),
			);

			const aggregate = await scoped(() => getGitLabCommitStatuses(REPO, HEAD_SHA));

			expect(aggregate.totalCount).toBe(2);
			expect(aggregate.checkRuns.map((run) => run.name)).toEqual([
				'<unnamed commit status>',
				'<unnamed commit status>',
			]);
		});

		it('surfaces a 404 rather than reporting a commit with no checks', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ message: '404 Commit Not Found' }, 404));

			await expect(scoped(() => getGitLabCommitStatuses(REPO, HEAD_SHA))).rejects.toBeInstanceOf(
				GitLabApiError,
			);
		});
	});

	describe('listGitLabMergeRequestsForCommit', () => {
		it('resolves the merge requests a commit belongs to', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse([
					createMockGitLabMergeRequestResponse(),
					createMockGitLabMergeRequestResponse({
						iid: 18,
						state: 'merged',
						source_branch: 'swarm/issue-18',
					}),
				]),
			);

			await expect(scoped(() => listGitLabMergeRequestsForCommit(REPO, HEAD_SHA))).resolves.toEqual(
				[
					{ number: 17, state: 'opened', headBranch: 'swarm/issue-17' },
					{ number: 18, state: 'merged', headBranch: 'swarm/issue-18' },
				],
			);
			expect(new URL(requestedUrl(fetchMock)).pathname).toBe(
				`/api/v4${PROJECT_PATH}/repository/commits/${HEAD_SHA}/merge_requests`,
			);
		});

		it('is empty when the commit belongs to no merge request', async () => {
			fetchMock.mockResolvedValue(jsonResponse([]));

			await expect(scoped(() => listGitLabMergeRequestsForCommit(REPO, HEAD_SHA))).resolves.toEqual(
				[],
			);
		});

		it('throws rather than reporting a merge request it cannot name', async () => {
			fetchMock.mockResolvedValue(jsonResponse([{ state: 'opened', source_branch: 'topic' }]));

			await expect(scoped(() => listGitLabMergeRequestsForCommit(REPO, HEAD_SHA))).rejects.toThrow(
				/missing required fields/,
			);
		});

		it('surfaces a 404 rather than reporting an unassociated commit', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ message: '404 Commit Not Found' }, 404));

			await expect(
				scoped(() => listGitLabMergeRequestsForCommit(REPO, HEAD_SHA)),
			).rejects.toBeInstanceOf(GitLabApiError);
		});
	});

	it('refuses to read outside a token scope', async () => {
		await expect(getGitLabMergeRequest(REPO, 17)).rejects.toThrow(/No GitLab token in scope/);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
