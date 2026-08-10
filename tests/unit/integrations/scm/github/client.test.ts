import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture Octokit constructor calls so we can assert which token each scope
// authenticates with, and stub the authenticated-user lookup.
const octokitInstances: Array<{
	auth: unknown;
	users: { getAuthenticated: ReturnType<typeof vi.fn> };
}> = [];
const getAuthenticated = vi.fn();
// Shared Actions-API endpoint stubs + paginate: `getCheckSuiteStatus` passes
// each endpoint reference to `paginate`, so paginate switches on identity.
const listWorkflowRunsForRepo = vi.fn();
const listJobsForWorkflowRun = vi.fn();
const pullsGet = vi.fn();
const pullsMerge = vi.fn();
const listPullRequestsAssociatedWithCommit = vi.fn();
const paginate = vi.fn();
const graphql = vi.fn();

vi.mock('@octokit/rest', () => ({
	Octokit: class {
		auth: unknown;
		users = { getAuthenticated };
		actions = { listWorkflowRunsForRepo, listJobsForWorkflowRun };
		pulls = { get: pullsGet, merge: pullsMerge };
		repos = { listPullRequestsAssociatedWithCommit };
		paginate = paginate;
		graphql = graphql;
		constructor(opts: { auth: unknown }) {
			this.auth = opts.auth;
			octokitInstances.push(this);
		}
	},
}));

import {
	getCheckSuiteStatus,
	getGitHubUserForToken,
	getPullRequestMergeState,
	getPullRequestReviewDecision,
	getScopedClient,
	listPullRequestsForCommit,
	mergePullRequestDirect,
	withGitHubToken,
} from '@/integrations/scm/github/client.js';

describe('github client', () => {
	beforeEach(() => {
		octokitInstances.length = 0;
		getAuthenticated.mockReset();
		listWorkflowRunsForRepo.mockReset();
		listJobsForWorkflowRun.mockReset();
		pullsGet.mockReset();
		pullsMerge.mockReset();
		paginate.mockReset();
		graphql.mockReset();
	});

	describe('getScopedClient', () => {
		it('throws when called outside a withGitHubToken scope', () => {
			expect(() => getScopedClient()).toThrow(/No GitHub client in scope/);
		});
	});

	describe('withGitHubToken', () => {
		it('binds an Octokit authenticated with the given token to the async scope', async () => {
			const seen = await withGitHubToken('tok-abc', async () => getScopedClient());
			expect(octokitInstances).toHaveLength(1);
			expect(octokitInstances[0].auth).toBe('tok-abc');
			expect(seen).toBe(octokitInstances[0]);
		});

		it('returns the value produced by fn', async () => {
			const result = await withGitHubToken('tok', async () => 42);
			expect(result).toBe(42);
		});

		it('does not leak the client past the scope', async () => {
			await withGitHubToken('tok', async () => getScopedClient());
			expect(() => getScopedClient()).toThrow(/No GitHub client in scope/);
		});

		it('isolates concurrent scopes — each sees its own token', async () => {
			const [a, b] = await Promise.all([
				withGitHubToken('tok-a', async () => getScopedClient().auth),
				withGitHubToken('tok-b', async () => getScopedClient().auth),
			]);
			expect(a).toBe('tok-a');
			expect(b).toBe('tok-b');
		});
	});

	describe('getGitHubUserForToken', () => {
		it('returns null for a null token without calling GitHub', async () => {
			expect(await getGitHubUserForToken(null)).toBeNull();
			expect(getAuthenticated).not.toHaveBeenCalled();
		});

		it('returns the authenticated login for a valid token', async () => {
			getAuthenticated.mockResolvedValue({ data: { login: 'swarm-impl' } });
			expect(await getGitHubUserForToken('tok')).toBe('swarm-impl');
		});

		it('returns null (not throw) when the lookup fails', async () => {
			getAuthenticated.mockRejectedValue(new Error('401'));
			expect(await getGitHubUserForToken('bad-tok')).toBeNull();
		});
	});

	describe('getCheckSuiteStatus', () => {
		it('flattens workflow-run jobs into check runs, deduping stale reruns per workflow', async () => {
			// Two runs of workflow 100 (newest-first: run 1 kept, run 2 the stale
			// rerun dropped) plus one run of workflow 200.
			paginate.mockImplementation(async (endpoint: unknown, params: { run_id?: number }) => {
				if (endpoint === listWorkflowRunsForRepo) {
					return [
						{ id: 1, workflow_id: 100 },
						{ id: 2, workflow_id: 100 },
						{ id: 3, workflow_id: 200 },
					];
				}
				const jobsByRun: Record<number, unknown[]> = {
					1: [{ name: 'build', status: 'completed', conclusion: 'success' }],
					2: [{ name: 'build', status: 'completed', conclusion: 'failure' }],
					3: [{ name: 'test', status: 'in_progress', conclusion: null }],
				};
				return jobsByRun[params.run_id ?? -1] ?? [];
			});

			const result = await withGitHubToken('tok', () =>
				getCheckSuiteStatus('jkwiecien', 'swarm', 'cafe'),
			);

			expect(result).toEqual({
				totalCount: 2,
				checkRuns: [
					{ name: 'build', status: 'completed', conclusion: 'success' },
					{ name: 'test', status: 'in_progress', conclusion: null },
				],
			});
			// The stale rerun (run 2) was never queried — proving the workflow-id dedupe.
			expect(paginate).not.toHaveBeenCalledWith(
				listJobsForWorkflowRun,
				expect.objectContaining({ run_id: 2 }),
			);
		});

		it('returns an empty aggregate when the ref has no workflow runs', async () => {
			paginate.mockResolvedValue([]);
			const result = await withGitHubToken('tok', () =>
				getCheckSuiteStatus('jkwiecien', 'swarm', 'deadbeef'),
			);
			expect(result).toEqual({ totalCount: 0, checkRuns: [] });
		});
	});

	// GitHub `check_suite` payloads name associated pull requests when available;
	// unresolved branch and default-branch checks use this neutral contract seam
	// (issue #618).
	describe('listPullRequestsForCommit', () => {
		it("maps associated pull requests onto the contract's neutral shape", async () => {
			paginate.mockResolvedValue([
				{ number: 42, state: 'open', head: { ref: 'issue-42' } },
				{ number: 41, state: 'closed', head: { ref: 'issue-41' } },
			]);

			await expect(
				withGitHubToken('tok', () => listPullRequestsForCommit('jkwiecien', 'swarm', 'deadbeef')),
			).resolves.toEqual([
				{ number: 42, state: 'open', headBranch: 'issue-42' },
				{ number: 41, state: 'closed', headBranch: 'issue-41' },
			]);
			expect(paginate).toHaveBeenCalledWith(
				listPullRequestsAssociatedWithCommit,
				expect.objectContaining({ owner: 'jkwiecien', repo: 'swarm', commit_sha: 'deadbeef' }),
			);
		});

		it('reports no pull request for a commit that belongs to none', async () => {
			paginate.mockResolvedValue([]);
			await expect(
				withGitHubToken('tok', () => listPullRequestsForCommit('jkwiecien', 'swarm', 'deadbeef')),
			).resolves.toEqual([]);
		});
	});

	describe('getPullRequestMergeState', () => {
		it('resolves merged/state/draft/head SHA from the PR', async () => {
			pullsGet.mockResolvedValue({
				data: { merged: false, state: 'open', draft: true, head: { sha: 'reviewed-head' } },
			});

			await expect(
				withGitHubToken('tok', () => getPullRequestMergeState('jkwiecien', 'swarm', 42)),
			).resolves.toEqual({
				merged: false,
				state: 'open',
				draft: true,
				headSha: 'reviewed-head',
			});
			expect(pullsGet).toHaveBeenCalledWith({ owner: 'jkwiecien', repo: 'swarm', pull_number: 42 });
		});

		it('normalizes a missing draft flag to false', async () => {
			pullsGet.mockResolvedValue({
				data: { merged: true, state: 'closed', head: { sha: 'merged-head' } },
			});

			await expect(
				withGitHubToken('tok', () => getPullRequestMergeState('jkwiecien', 'swarm', 42)),
			).resolves.toEqual({
				merged: true,
				state: 'closed',
				draft: false,
				headSha: 'merged-head',
			});
		});
	});

	describe('getPullRequestReviewDecision (issue #278)', () => {
		it('resolves the aggregate review decision via GraphQL', async () => {
			graphql.mockResolvedValue({ repository: { pullRequest: { reviewDecision: 'APPROVED' } } });

			await expect(
				withGitHubToken('tok', () => getPullRequestReviewDecision('jkwiecien', 'swarm', 42)),
			).resolves.toBe('APPROVED');
			expect(graphql).toHaveBeenCalledWith(expect.stringContaining('reviewDecision'), {
				owner: 'jkwiecien',
				repo: 'swarm',
				number: 42,
			});
		});

		it('returns null when the repository requires no reviews', async () => {
			graphql.mockResolvedValue({ repository: { pullRequest: { reviewDecision: null } } });

			await expect(
				withGitHubToken('tok', () => getPullRequestReviewDecision('jkwiecien', 'swarm', 42)),
			).resolves.toBeNull();
		});

		it('returns null when the PR or repository is missing from the response', async () => {
			graphql.mockResolvedValue({ repository: null });

			await expect(
				withGitHubToken('tok', () => getPullRequestReviewDecision('jkwiecien', 'swarm', 42)),
			).resolves.toBeNull();
		});
	});

	describe('mergePullRequestDirect (issue #253)', () => {
		it('merges via the REST endpoint and returns the merge response', async () => {
			pullsMerge.mockResolvedValue({
				data: { merged: true, message: 'Pull Request successfully merged', sha: 'deadbeef' },
			});

			await expect(
				withGitHubToken('tok', () =>
					mergePullRequestDirect('jkwiecien', 'swarm', 42, 'reviewed-head'),
				),
			).resolves.toEqual({
				merged: true,
				message: 'Pull Request successfully merged',
				sha: 'deadbeef',
			});
			expect(pullsMerge).toHaveBeenCalledWith({
				owner: 'jkwiecien',
				repo: 'swarm',
				pull_number: 42,
				sha: 'reviewed-head',
			});
		});

		it('propagates a thrown Octokit error for the caller to classify', async () => {
			const error = Object.assign(new Error('Pull Request is not mergeable'), { status: 405 });
			pullsMerge.mockRejectedValue(error);

			await expect(
				withGitHubToken('tok', () =>
					mergePullRequestDirect('jkwiecien', 'swarm', 42, 'reviewed-head'),
				),
			).rejects.toThrow(/not mergeable/);
		});
	});
});
