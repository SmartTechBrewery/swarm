import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	AzureDevOpsApiError,
	withAzureDevOpsToken,
} from '@/integrations/scm/azure-devops/client.js';
import {
	BUILD_SCAN_LIMIT,
	findActiveAzureDevOpsPullRequest,
	getAzureDevOpsBranchHead,
	getAzureDevOpsCommitChecks,
	getAzureDevOpsPullRequest,
	getAzureDevOpsPullRequestMergeState,
	getAzureDevOpsPullRequestTitle,
	isAzureDevOpsBaseContainedInHead,
	listActiveAzureDevOpsPullRequestsForBase,
	listAzureDevOpsPullRequestsForCommit,
	retryFailedAzureDevOpsBuilds,
} from '@/integrations/scm/azure-devops/pull-requests.js';
import { logger } from '@/lib/logger.js';
import { decideAggregateCheckOutcome } from '@/triggers/handlers/aggregate-check-decision.js';

import {
	createMockAzureDevOpsBuildResponse,
	createMockAzureDevOpsCommitStatusResponse,
	createMockAzureDevOpsPullRequestResponse,
} from '../../../../helpers/factories.js';

/** A `fetch` stand-in typed with the real signature so `mock.calls` indexes. */
type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

/** A project name with a space, so every path assertion also proves segment encoding. */
const REPO = 'Fabrikam/Fiber Team/Web';
const REPO_API = '/Fabrikam/Fiber%20Team/_apis/git/repositories/Web';
const HEAD_SHA = 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7';
const TARGET_SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER_SHA = 'feedfacefeedfacefeedfacefeedfacefeedface';

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8' },
	});
}

/** Every read must run inside a token scope — the persona wrapper's job in production. */
function scoped<T>(fn: () => Promise<T>): Promise<T> {
	return withAzureDevOpsToken('pat-abc', fn);
}

function requestedUrl(fetchMock: FetchMock, call = 0): URL {
	return new URL(String(fetchMock.mock.calls[call]?.[0]));
}

function requestedUrls(fetchMock: FetchMock): URL[] {
	return fetchMock.mock.calls.map((call) => new URL(String(call[0])));
}

/**
 * Answer by URL fragment rather than call order — the aggregate and the conflict
 * listing fan out into several requests whose order is an implementation detail.
 * The first matching fragment wins; anything unmatched is a 404.
 */
function routeFetch(fetchMock: FetchMock, routes: Array<[fragment: string, body: unknown]>): void {
	fetchMock.mockImplementation(async (input) => {
		const url = String(input);
		const route = routes.find(([fragment]) => url.includes(fragment));
		return route
			? jsonResponse(route[1])
			: jsonResponse({ message: `not found: ${url}`, typeKey: 'NotFoundException' }, 404);
	});
}

describe('azure devops pull-request reads', () => {
	let fetchMock: FetchMock;

	beforeEach(() => {
		fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal('fetch', fetchMock);
	});

	describe('getAzureDevOpsPullRequest', () => {
		const read = (overrides: Record<string, unknown> = {}) => {
			fetchMock.mockResolvedValue(
				jsonResponse(createMockAzureDevOpsPullRequestResponse(overrides)),
			);
			return scoped(() => getAzureDevOpsPullRequest(REPO, 17));
		};

		it('maps Azure’s pull request onto the neutral shape', async () => {
			await expect(read()).resolves.toEqual({
				number: 17,
				headBranch: 'swarm/issue-17',
				headSha: HEAD_SHA,
				baseBranch: 'main',
				baseSha: TARGET_SHA,
				mergeable: true,
				authorLogin: '11bb11bb-cc22-dd33-ee44-55ff55ff55ff',
				state: 'open',
			});
			expect(requestedUrl(fetchMock).pathname).toBe(`${REPO_API}/pullrequests/17`);
		});

		it.each([
			['succeeded', true],
			['conflicts', false],
			['queued', null],
			['notSet', null],
			// Policy and evaluation errors are not merge conflicts.
			['rejectedByPolicy', null],
			['failure', null],
			[undefined, null],
		])('maps mergeStatus %s to mergeable %s', async (mergeStatus, mergeable) => {
			await expect(read({ mergeStatus })).resolves.toMatchObject({ mergeable });
		});

		it.each([
			['completed', 'closed'],
			['abandoned', 'closed'],
		])('maps status %s to %s, with no mergeability once inactive', async (status, state) => {
			await expect(read({ status, mergeStatus: 'conflicts' })).resolves.toMatchObject({
				state,
				mergeable: null,
			});
		});

		it.each([
			['lastMergeSourceCommit', { lastMergeSourceCommit: undefined }],
			['lastMergeTargetCommit', { lastMergeTargetCommit: undefined }],
			['an unknown status', { status: 'notSet' }],
			['sourceRefName', { sourceRefName: undefined }],
		])('throws when %s is missing rather than keying on a stand-in', async (_field, overrides) => {
			await expect(read(overrides)).rejects.toThrow(/missing required fields/);
		});

		it('propagates an API error', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ message: 'gone' }, 404));

			await expect(scoped(() => getAzureDevOpsPullRequest(REPO, 17))).rejects.toBeInstanceOf(
				AzureDevOpsApiError,
			);
		});
	});

	describe('getAzureDevOpsPullRequestTitle', () => {
		it('returns the title, or null when Azure reports none', async () => {
			fetchMock.mockResolvedValueOnce(jsonResponse(createMockAzureDevOpsPullRequestResponse()));
			await expect(scoped(() => getAzureDevOpsPullRequestTitle(REPO, 17))).resolves.toBe(
				'Add a thing',
			);

			fetchMock.mockResolvedValueOnce(
				jsonResponse(createMockAzureDevOpsPullRequestResponse({ title: undefined })),
			);
			await expect(scoped(() => getAzureDevOpsPullRequestTitle(REPO, 17))).resolves.toBeNull();
		});
	});

	describe('getAzureDevOpsPullRequestMergeState', () => {
		it('reports draft, the head and every reviewer vote', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse(
					createMockAzureDevOpsPullRequestResponse({
						isDraft: true,
						reviewers: [
							{ id: 'guid-rev', vote: 10, isRequired: true },
							{ id: 'guid-other', vote: -10 },
							{ vote: 5 },
						],
					}),
				),
			);

			await expect(scoped(() => getAzureDevOpsPullRequestMergeState(REPO, 17))).resolves.toEqual({
				merged: false,
				state: 'open',
				draft: true,
				headSha: HEAD_SHA,
				reviewers: [
					{ id: 'guid-rev', vote: 10, isRequired: true },
					{ id: 'guid-other', vote: -10, isRequired: false },
				],
				mergeStatus: 'succeeded',
				mergeCommitSha: null,
				baseBranch: 'main',
			});
		});

		it('reads a completed pull request as merged and closed, with its merge commit', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse(
					createMockAzureDevOpsPullRequestResponse({
						status: 'completed',
						lastMergeCommit: { commitId: OTHER_SHA },
					}),
				),
			);

			await expect(
				scoped(() => getAzureDevOpsPullRequestMergeState(REPO, 17)),
			).resolves.toMatchObject({ merged: true, state: 'closed', mergeCommitSha: OTHER_SHA });
		});

		it('throws when the head commit is not populated yet', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse(createMockAzureDevOpsPullRequestResponse({ lastMergeSourceCommit: null })),
			);

			await expect(scoped(() => getAzureDevOpsPullRequestMergeState(REPO, 17))).rejects.toThrow(
				/missing required fields/,
			);
		});

		it('throws when the target branch is absent', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse(createMockAzureDevOpsPullRequestResponse({ targetRefName: undefined })),
			);

			await expect(scoped(() => getAzureDevOpsPullRequestMergeState(REPO, 17))).rejects.toThrow(
				/targetRefName=undefined/,
			);
		});
	});

	// Issue #1116: the commit-graph answer to "is this head behind its base?".
	describe('isAzureDevOpsBaseContainedInHead', () => {
		it('diffs the head commit against the target branch, skipping the change list', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ aheadCount: 0, behindCount: 2 }));

			await scoped(() => isAzureDevOpsBaseContainedInHead(REPO, 'release/1.0', HEAD_SHA));

			const url = requestedUrl(fetchMock);
			expect(url.pathname).toBe(`${REPO_API}/diffs/commits`);
			expect(Object.fromEntries(url.searchParams)).toEqual({
				baseVersion: HEAD_SHA,
				baseVersionType: 'commit',
				targetVersion: 'release/1.0',
				targetVersionType: 'branch',
				$top: '1',
				'api-version': '7.1',
			});
		});

		// `aheadCount` counts the target's commits the base lacks; `behindCount` (the
		// head's own commits) must not decide.
		it('answers true when the target branch is not ahead of the head', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ aheadCount: 0, behindCount: 5 }));

			await expect(
				scoped(() => isAzureDevOpsBaseContainedInHead(REPO, 'main', HEAD_SHA)),
			).resolves.toBe(true);
		});

		it('answers false when the target branch has commits the head lacks', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ aheadCount: 3, behindCount: 0 }));

			await expect(
				scoped(() => isAzureDevOpsBaseContainedInHead(REPO, 'main', HEAD_SHA)),
			).resolves.toBe(false);
		});

		it('throws on a response with no aheadCount rather than reading it as up to date', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ behindCount: 0 }));

			await expect(
				scoped(() => isAzureDevOpsBaseContainedInHead(REPO, 'main', HEAD_SHA)),
			).rejects.toThrow(/no aheadCount/);
		});

		it('propagates an API error', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({ message: 'TF401175: not found', typeKey: 'GitItemNotFoundException' }, 404),
			);

			await expect(
				scoped(() => isAzureDevOpsBaseContainedInHead(REPO, 'main', HEAD_SHA)),
			).rejects.toBeInstanceOf(AzureDevOpsApiError);
		});
	});

	describe('findActiveAzureDevOpsPullRequest', () => {
		it('looks the branch up by its exact source ref among active pull requests', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({ count: 1, value: [createMockAzureDevOpsPullRequestResponse()] }),
			);

			await expect(
				scoped(() => findActiveAzureDevOpsPullRequest(REPO, 'swarm/issue-17')),
			).resolves.toEqual({
				number: 17,
				url: 'https://dev.azure.com/Fabrikam/Fiber%20Team/_git/Web/pullrequest/17',
			});
			const url = requestedUrl(fetchMock);
			expect(url.pathname).toBe(`${REPO_API}/pullrequests`);
			expect(url.searchParams.get('searchCriteria.sourceRefName')).toBe(
				'refs/heads/swarm/issue-17',
			);
			expect(url.searchParams.get('searchCriteria.status')).toBe('active');
		});

		it('answers undefined when the branch has no active pull request', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ count: 0, value: [] }));

			await expect(
				scoped(() => findActiveAzureDevOpsPullRequest(REPO, 'swarm/issue-17')),
			).resolves.toBeUndefined();
		});
	});

	describe('getAzureDevOpsBranchHead', () => {
		it('picks the exact branch out of the prefix-matched listing', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({
					count: 2,
					value: [
						{ name: 'refs/heads/main-old', objectId: OTHER_SHA },
						{ name: 'refs/heads/main', objectId: HEAD_SHA },
					],
				}),
			);

			await expect(scoped(() => getAzureDevOpsBranchHead(REPO, 'main'))).resolves.toBe(HEAD_SHA);
			const url = requestedUrl(fetchMock);
			expect(url.pathname).toBe(`${REPO_API}/refs`);
			expect(url.searchParams.get('filter')).toBe('heads/main');
		});

		it('throws on a prefix-only match instead of answering with the wrong branch', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({ count: 1, value: [{ name: 'refs/heads/main-old', objectId: OTHER_SHA }] }),
			);

			await expect(scoped(() => getAzureDevOpsBranchHead(REPO, 'main'))).rejects.toThrow(
				/'main' .* not found or is not visible/,
			);
		});

		it('throws on an empty listing, the way a 404 reads elsewhere', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ count: 0, value: [] }));

			await expect(scoped(() => getAzureDevOpsBranchHead(REPO, 'main'))).rejects.toThrow(
				/not found or is not visible/,
			);
		});

		it('answers null when the exact ref names no commit', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ count: 1, value: [{ name: 'refs/heads/main' }] }));

			await expect(scoped(() => getAzureDevOpsBranchHead(REPO, 'main'))).resolves.toBeNull();
		});

		it('propagates an API error', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ message: 'denied' }, 401));

			await expect(scoped(() => getAzureDevOpsBranchHead(REPO, 'main'))).rejects.toBeInstanceOf(
				AzureDevOpsApiError,
			);
		});
	});

	describe('getAzureDevOpsCommitChecks', () => {
		const STATUSES = `${REPO_API}/commits/${HEAD_SHA}/statuses`;
		const BUILDS = '/Fabrikam/Fiber%20Team/_apis/build/builds';

		/** Route the three reads the aggregate makes: statuses, the repository, builds. */
		const routeChecks = (statuses: unknown[], builds: unknown[]) =>
			routeFetch(fetchMock, [
				[STATUSES, { count: statuses.length, value: statuses }],
				[BUILDS, { count: builds.length, value: builds }],
				[`${REPO_API}?`, { id: 'repo-guid', name: 'Web' }],
			]);

		it('unions commit statuses with the newest build per definition on the commit', async () => {
			routeChecks(
				[createMockAzureDevOpsCommitStatusResponse()],
				[
					createMockAzureDevOpsBuildResponse({ id: 40, definition: { id: 5, name: 'Web CI' } }),
					// A pull-request build ran on the merge commit; its head is in triggerInfo.
					createMockAzureDevOpsBuildResponse({
						id: 39,
						sourceVersion: OTHER_SHA,
						triggerInfo: { 'pr.sourceSha': HEAD_SHA },
						definition: { id: 6, name: 'Lint' },
						result: 'failed',
					}),
					// An older run of definition 5 — its stale failure must not count.
					createMockAzureDevOpsBuildResponse({ id: 38, result: 'failed' }),
					// A build of some other commit.
					createMockAzureDevOpsBuildResponse({
						id: 37,
						sourceVersion: OTHER_SHA,
						definition: { id: 7, name: 'Other' },
					}),
				],
			);

			await expect(scoped(() => getAzureDevOpsCommitChecks(REPO, HEAD_SHA))).resolves.toEqual({
				totalCount: 3,
				checkRuns: [
					{ name: 'jenkins/build', status: 'completed', conclusion: 'success' },
					{ name: 'Web CI', status: 'completed', conclusion: 'success' },
					{ name: 'Lint', status: 'completed', conclusion: 'failure' },
				],
			});
		});

		it('asks for the repository’s newest builds by its GUID, bounded', async () => {
			routeChecks([], []);

			await scoped(() => getAzureDevOpsCommitChecks(REPO, HEAD_SHA));

			const builds = requestedUrls(fetchMock).find((url) => url.pathname.endsWith('/build/builds'));
			expect(builds?.searchParams.get('repositoryId')).toBe('repo-guid');
			expect(builds?.searchParams.get('repositoryType')).toBe('TfsGit');
			expect(builds?.searchParams.get('queryOrder')).toBe('queueTimeDescending');
			expect(builds?.searchParams.get('$top')).toBe(String(BUILD_SCAN_LIMIT));
			const statuses = requestedUrls(fetchMock).find((url) => url.pathname.endsWith('/statuses'));
			expect(statuses?.searchParams.get('latestOnly')).toBe('true');
		});

		it('logs when the build scan fills its bound', async () => {
			const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
			routeChecks(
				[],
				Array.from({ length: BUILD_SCAN_LIMIT }, (_, id) =>
					createMockAzureDevOpsBuildResponse({ id, sourceVersion: OTHER_SHA }),
				),
			);

			await expect(scoped(() => getAzureDevOpsCommitChecks(REPO, HEAD_SHA))).resolves.toEqual({
				totalCount: 0,
				checkRuns: [],
			});
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining('build scan hit its bound'),
				expect.objectContaining({ limit: BUILD_SCAN_LIMIT }),
			);
			warn.mockRestore();
		});

		it.each([
			['notStarted', undefined, 'queued', null],
			['postponed', undefined, 'queued', null],
			['inProgress', undefined, 'in_progress', null],
			['cancelling', undefined, 'in_progress', null],
			['completed', 'partiallySucceeded', 'completed', 'neutral'],
			['completed', 'canceled', 'completed', 'cancelled'],
			['completed', 'none', 'in_progress', null],
			['completed', undefined, 'in_progress', null],
			['completed', 'somethingNew', 'in_progress', null],
		])('maps build %s/%s to %s/%s', async (status, result, checkStatus, conclusion) => {
			routeChecks([], [createMockAzureDevOpsBuildResponse({ status, result })]);

			const aggregate = await scoped(() => getAzureDevOpsCommitChecks(REPO, HEAD_SHA));
			expect(aggregate.checkRuns).toEqual([{ name: 'Web CI', status: checkStatus, conclusion }]);
		});

		it.each([
			'none',
			undefined,
			'somethingNew',
		])('defers the aggregate decision on a completed build with result %s', async (result) => {
			routeChecks([], [createMockAzureDevOpsBuildResponse({ status: 'completed', result })]);

			const aggregate = await scoped(() => getAzureDevOpsCommitChecks(REPO, HEAD_SHA));
			expect(decideAggregateCheckOutcome(aggregate, '17')).toMatchObject({
				action: 'defer',
				incompleteChecks: ['Web CI'],
			});
		});

		it.each([
			['succeeded', 'completed', 'success'],
			['failed', 'completed', 'failure'],
			['error', 'completed', 'failure'],
			['notApplicable', 'completed', 'skipped'],
			['pending', 'in_progress', null],
			['notSet', 'in_progress', null],
		])('maps commit-status state %s to %s/%s', async (state, checkStatus, conclusion) => {
			routeChecks([createMockAzureDevOpsCommitStatusResponse({ state })], []);

			const aggregate = await scoped(() => getAzureDevOpsCommitChecks(REPO, HEAD_SHA));
			expect(aggregate.checkRuns).toEqual([
				{ name: 'jenkins/build', status: checkStatus, conclusion },
			]);
		});

		it('keeps the newest commit status per genre/name', async () => {
			routeChecks(
				[
					createMockAzureDevOpsCommitStatusResponse({
						state: 'failed',
						creationDate: '2026-10-21T08:00:00.000Z',
					}),
					createMockAzureDevOpsCommitStatusResponse({
						state: 'succeeded',
						creationDate: '2026-10-21T09:00:00.000Z',
					}),
					createMockAzureDevOpsCommitStatusResponse({ context: { name: 'deploy' } }),
				],
				[],
			);

			await expect(scoped(() => getAzureDevOpsCommitChecks(REPO, HEAD_SHA))).resolves.toEqual({
				totalCount: 2,
				checkRuns: [
					{ name: 'jenkins/build', status: 'completed', conclusion: 'success' },
					{ name: 'deploy', status: 'completed', conclusion: 'success' },
				],
			});
		});

		it('throws rather than reading green when the commit statuses are unreadable', async () => {
			routeFetch(fetchMock, [
				[BUILDS, { count: 0, value: [] }],
				[`${REPO_API}?`, { id: 'repo-guid' }],
			]);

			await expect(scoped(() => getAzureDevOpsCommitChecks(REPO, HEAD_SHA))).rejects.toBeInstanceOf(
				AzureDevOpsApiError,
			);
		});

		it('throws when the builds are unreadable', async () => {
			routeFetch(fetchMock, [
				[STATUSES, { count: 0, value: [] }],
				[`${REPO_API}?`, { id: 'repo-guid' }],
			]);

			await expect(scoped(() => getAzureDevOpsCommitChecks(REPO, HEAD_SHA))).rejects.toBeInstanceOf(
				AzureDevOpsApiError,
			);
		});
	});

	describe('retryFailedAzureDevOpsBuilds', () => {
		const BUILDS = '/Fabrikam/Fiber%20Team/_apis/build/builds';

		/** Route the build scan plus a retry of any build; record every request's method. */
		const routeBuilds = (builds: unknown[], retry: unknown = { id: 0, status: 'notStarted' }) =>
			routeFetch(fetchMock, [
				[`${BUILDS}/`, retry],
				[BUILDS, { count: builds.length, value: builds }],
				[`${REPO_API}?`, { id: 'repo-guid', name: 'Web' }],
			]);

		const retries = () =>
			fetchMock.mock.calls
				.filter((call) => call[1]?.method === 'PATCH')
				.map((call) => new URL(String(call[0])));

		it('retries only the newest failed build per definition on the commit', async () => {
			routeBuilds([
				createMockAzureDevOpsBuildResponse({ id: 40, definition: { id: 5, name: 'Web CI' } }),
				createMockAzureDevOpsBuildResponse({
					id: 39,
					sourceVersion: OTHER_SHA,
					triggerInfo: { 'pr.sourceSha': HEAD_SHA },
					definition: { id: 6, name: 'Lint' },
					result: 'failed',
				}),
				// An older run of definition 5 — a stale failure the aggregate ignores.
				createMockAzureDevOpsBuildResponse({ id: 38, result: 'failed' }),
				// A failed build of some other commit.
				createMockAzureDevOpsBuildResponse({
					id: 37,
					sourceVersion: OTHER_SHA,
					definition: { id: 7, name: 'Other' },
					result: 'failed',
				}),
			]);

			await expect(scoped(() => retryFailedAzureDevOpsBuilds(REPO, HEAD_SHA))).resolves.toEqual([
				'Lint',
			]);
			const [retry, ...rest] = retries();
			expect(rest).toEqual([]);
			expect(retry?.pathname).toBe(`${BUILDS}/39`);
			expect(retry?.searchParams.get('retry')).toBe('true');
			expect(retry?.searchParams.get('api-version')).toBe('7.1');
		});

		it('retries nothing when every build is green or still running', async () => {
			routeBuilds([
				createMockAzureDevOpsBuildResponse({ id: 40 }),
				createMockAzureDevOpsBuildResponse({
					id: 41,
					status: 'inProgress',
					result: undefined,
					definition: { id: 6, name: 'Lint' },
				}),
			]);

			await expect(scoped(() => retryFailedAzureDevOpsBuilds(REPO, HEAD_SHA))).resolves.toEqual([]);
			expect(retries()).toEqual([]);
		});

		it('lets a refused retry propagate as an AzureDevOpsApiError', async () => {
			routeFetch(fetchMock, [
				[BUILDS, { count: 1, value: [createMockAzureDevOpsBuildResponse({ result: 'failed' })] }],
				[`${REPO_API}?`, { id: 'repo-guid' }],
			]);
			// The list route also matches the PATCH path, so refuse the PATCH explicitly.
			const listed = fetchMock.getMockImplementation();
			fetchMock.mockImplementation(async (input, init) =>
				init?.method === 'PATCH'
					? jsonResponse({ message: 'Access denied', typeKey: 'AccessCheckException' }, 403)
					: (listed as typeof fetch)(input, init),
			);

			await expect(
				scoped(() => retryFailedAzureDevOpsBuilds(REPO, HEAD_SHA)),
			).rejects.toBeInstanceOf(AzureDevOpsApiError);
		});
	});

	describe('listAzureDevOpsPullRequestsForCommit', () => {
		it('answers the active pull requests whose head is the commit', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({
					count: 2,
					value: [
						createMockAzureDevOpsPullRequestResponse(),
						createMockAzureDevOpsPullRequestResponse({
							pullRequestId: 18,
							lastMergeSourceCommit: { commitId: OTHER_SHA },
						}),
					],
				}),
			);

			await expect(
				scoped(() => listAzureDevOpsPullRequestsForCommit(REPO, HEAD_SHA)),
			).resolves.toEqual([{ number: 17, state: 'open', headBranch: 'swarm/issue-17' }]);
			const url = requestedUrl(fetchMock);
			expect(url.pathname).toBe(`${REPO_API}/pullrequests`);
			expect(url.searchParams.get('searchCriteria.status')).toBe('active');
		});

		it('treats an unindexed commit as an ordinary empty answer', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ count: 0, value: [] }));

			await expect(
				scoped(() => listAzureDevOpsPullRequestsForCommit(REPO, HEAD_SHA)),
			).resolves.toEqual([]);
		});
	});

	describe('listActiveAzureDevOpsPullRequestsForBase', () => {
		it('lists active pull requests targeting the base, dropping forks', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({
					count: 2,
					value: [
						createMockAzureDevOpsPullRequestResponse({ mergeStatus: 'conflicts' }),
						createMockAzureDevOpsPullRequestResponse({
							pullRequestId: 19,
							forkSource: { name: 'refs/heads/feature', repository: { id: 'fork-guid' } },
						}),
					],
				}),
			);

			const candidates = await scoped(() => listActiveAzureDevOpsPullRequestsForBase(REPO, 'main'));

			expect(candidates).toEqual([
				expect.objectContaining({ number: 17, mergeable: false, baseSha: TARGET_SHA }),
			]);
			// Complete list entries need no per-candidate read.
			expect(fetchMock).toHaveBeenCalledTimes(1);
			const url = requestedUrl(fetchMock);
			expect(url.searchParams.get('searchCriteria.status')).toBe('active');
			expect(url.searchParams.get('searchCriteria.targetRefName')).toBe('refs/heads/main');
		});

		it('re-reads an entry whose list form lacks the merge evaluation', async () => {
			routeFetch(fetchMock, [
				[
					`${REPO_API}/pullrequests/18`,
					createMockAzureDevOpsPullRequestResponse({ pullRequestId: 18 }),
				],
				[
					`${REPO_API}/pullrequests?`,
					{
						count: 1,
						value: [
							createMockAzureDevOpsPullRequestResponse({
								pullRequestId: 18,
								mergeStatus: undefined,
								lastMergeTargetCommit: undefined,
							}),
						],
					},
				],
			]);

			await expect(
				scoped(() => listActiveAzureDevOpsPullRequestsForBase(REPO, 'main')),
			).resolves.toEqual([
				expect.objectContaining({ number: 18, mergeable: true, baseSha: TARGET_SHA }),
			]);
			expect(requestedUrls(fetchMock).map((url) => url.pathname)).toContain(
				`${REPO_API}/pullrequests/18`,
			);
		});

		it('fails the listing when a re-read candidate is still unevaluated', async () => {
			const unevaluated = createMockAzureDevOpsPullRequestResponse({
				pullRequestId: 18,
				lastMergeSourceCommit: undefined,
			});
			routeFetch(fetchMock, [
				[`${REPO_API}/pullrequests/18`, unevaluated],
				[`${REPO_API}/pullrequests?`, { count: 1, value: [unevaluated] }],
			]);

			await expect(
				scoped(() => listActiveAzureDevOpsPullRequestsForBase(REPO, 'main')),
			).rejects.toThrow(/missing required fields/);
		});
	});
});
