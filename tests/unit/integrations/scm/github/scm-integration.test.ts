import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProjectConfig } from '../../../../helpers/factories.js';

type ExecFileCallback = (error: Error | null, stdout: string, stderr: string) => void;

const { mockExecFile } = vi.hoisted(() => ({
	mockExecFile: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:child_process')>()),
	execFile: mockExecFile,
}));

vi.mock('@/config/provider.js', () => ({
	getPersonaToken: vi.fn(),
	getPersonaTokenOrNull: vi.fn(),
}));
vi.mock('@/integrations/scm/github/client.js', () => ({
	// Pass-through so we can assert the token that would be scoped without a real Octokit.
	withGitHubToken: vi.fn((_token: string, fn: () => Promise<unknown>) => fn()),
	getGitHubUserForToken: vi.fn(),
	getBranchHead: vi.fn(),
	getCheckSuiteStatus: vi.fn(),
	getPullRequestMergeState: vi.fn(),
	getPullRequestReviewDecision: vi.fn(),
	getPullRequestReviews: vi.fn(),
	getCommitProvenance: vi.fn(),
	isBaseContainedInHead: vi.fn(),
	isContainedInBranch: vi.fn(),
	mergePullRequestDirect: vi.fn(),
	readGitHubPullRequestContext: vi.fn(),
	rerunFailedWorkflowRuns: vi.fn(),
	updatePullRequestBranchDirect: vi.fn(),
}));

import { getPersonaToken, getPersonaTokenOrNull } from '@/config/provider.js';
import {
	getBranchHead,
	getCheckSuiteStatus,
	getCommitProvenance,
	getGitHubUserForToken,
	getPullRequestMergeState,
	getPullRequestReviewDecision,
	getPullRequestReviews,
	isBaseContainedInHead,
	isContainedInBranch,
	mergePullRequestDirect,
	readGitHubPullRequestContext,
	rerunFailedWorkflowRuns,
	updatePullRequestBranchDirect,
	withGitHubToken,
} from '@/integrations/scm/github/client.js';
import { _resetPersonaIdentityCache, isReviewerLogin } from '@/integrations/scm/github/personas.js';
import { GitHubSCMIntegration } from '@/integrations/scm/github/scm-integration.js';

const project = createMockProjectConfig();

describe('GitHubSCMIntegration', () => {
	const scm = new GitHubSCMIntegration();

	beforeEach(() => {
		vi.mocked(getPersonaToken).mockReset();
		vi.mocked(getPersonaTokenOrNull).mockReset();
		vi.mocked(withGitHubToken).mockClear();
		mockExecFile.mockImplementation(
			(_file: string, _args: string[], _options: unknown, callback: ExecFileCallback) =>
				callback(null, '', ''),
		);
	});

	describe('hasIntegration', () => {
		it('is true when only the implementer token is configured', async () => {
			vi.mocked(getPersonaTokenOrNull).mockImplementation(async (_p, persona) =>
				persona === 'implementer' ? 'tok' : null,
			);
			expect(await scm.hasIntegration(project)).toBe(true);
		});

		it('is true when only the reviewer token is configured', async () => {
			vi.mocked(getPersonaTokenOrNull).mockImplementation(async (_p, persona) =>
				persona === 'reviewer' ? 'tok' : null,
			);
			expect(await scm.hasIntegration(project)).toBe(true);
		});

		it('is false when neither token is configured', async () => {
			vi.mocked(getPersonaTokenOrNull).mockResolvedValue(null);
			expect(await scm.hasIntegration(project)).toBe(false);
		});
	});

	describe('hasPersonaToken', () => {
		it('reflects whether the specific persona token exists', async () => {
			vi.mocked(getPersonaTokenOrNull).mockResolvedValue('tok');
			expect(await scm.hasPersonaToken(project, 'reviewer')).toBe(true);
			vi.mocked(getPersonaTokenOrNull).mockResolvedValue(null);
			expect(await scm.hasPersonaToken(project, 'reviewer')).toBe(false);
		});
	});

	describe('withPersonaCredentials', () => {
		it("scopes the persona's token and runs fn within it", async () => {
			vi.mocked(getPersonaToken).mockResolvedValue('tok-rev');
			const result = await scm.withPersonaCredentials(project, 'reviewer', async () => 'done');

			expect(getPersonaToken).toHaveBeenCalledWith(project, 'reviewer');
			expect(withGitHubToken).toHaveBeenCalledWith('tok-rev', expect.any(Function));
			expect(result).toBe('done');
		});

		it('propagates the throw when the persona token is missing', async () => {
			vi.mocked(getPersonaToken).mockRejectedValue(new Error('no reviewer token'));
			await expect(
				scm.withPersonaCredentials(project, 'reviewer', async () => 'never'),
			).rejects.toThrow(/no reviewer token/);
			expect(withGitHubToken).not.toHaveBeenCalled();
		});
	});

	describe('withCredentials', () => {
		it('defaults to the implementer persona', async () => {
			vi.mocked(getPersonaToken).mockResolvedValue('tok-impl');
			await scm.withCredentials(project, async () => undefined);
			expect(getPersonaToken).toHaveBeenCalledWith(project, 'implementer');
		});
	});

	describe('reviewer identity + actor check (SCMProvider contract wrappers)', () => {
		beforeEach(() => {
			_resetPersonaIdentityCache();
		});

		it('resolves the reviewer identity from the reviewer token alone', async () => {
			vi.mocked(getPersonaTokenOrNull).mockImplementation(async (_p, persona) => `tok-${persona}`);
			vi.mocked(getGitHubUserForToken).mockImplementation(async (token) =>
				token === 'tok-reviewer' ? 'swarm-rev' : 'someone-else',
			);
			await expect(scm.resolveReviewerIdentity(project)).resolves.toBe('swarm-rev');
			expect(getPersonaTokenOrNull).not.toHaveBeenCalledWith(project, 'implementer');
		});

		it('propagates the throw when the reviewer identity cannot be resolved', async () => {
			vi.mocked(getPersonaTokenOrNull).mockResolvedValue('tok');
			vi.mocked(getGitHubUserForToken).mockResolvedValue(null);
			await expect(scm.resolveReviewerIdentity(project)).rejects.toThrow(/reviewer/);
		});

		it('isReviewerActor answers the same as the module-level check, bot suffix included', () => {
			for (const login of ['swarm-rev', 'swarm-rev[bot]', 'operator-alice', 'human']) {
				expect(scm.isReviewerActor(login, 'swarm-rev')).toBe(isReviewerLogin(login, 'swarm-rev'));
			}
			expect(scm.isReviewerActor('swarm-rev[bot]', 'swarm-rev')).toBe(true);
			expect(scm.isReviewerActor('operator-alice', 'swarm-rev')).toBe(false);
		});
	});

	describe('verifyWebhookSignature', () => {
		const rawBody = '{"action":"opened"}';
		const secret = 'shhh';
		const valid = `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;

		it('accepts a correctly computed signature', () => {
			expect(scm.verifyWebhookSignature(rawBody, valid, secret)).toBe(true);
		});

		it('rejects a forged signature, a missing prefix, and an empty one', () => {
			expect(scm.verifyWebhookSignature(rawBody, `${valid.slice(0, -1)}0`, secret)).toBe(false);
			expect(scm.verifyWebhookSignature(rawBody, valid.replace('sha256=', ''), secret)).toBe(false);
			expect(scm.verifyWebhookSignature(rawBody, '', secret)).toBe(false);
		});

		it('rejects a signature computed over a different body', () => {
			expect(scm.verifyWebhookSignature('{"action":"closed"}', valid, secret)).toBe(false);
		});
	});

	// A pure grammar, so it is asserted as one: no credential, no request. The other
	// two providers spell the same thing differently, which is why shared code asks
	// the provider instead of deriving this URL itself.
	describe('pullRequestUrl', () => {
		it('spells GitHub’s own pull-request web path', () => {
			expect(scm.pullRequestUrl('team/app', 42)).toBe('https://github.com/team/app/pull/42');
			expect(scm.pullRequestUrl('team/app', '42')).toBe('https://github.com/team/app/pull/42');
		});

		// The repository is the caller's, not `project.repo`: a stalled row records
		// the repository its run actually acted on (issue #683).
		it('uses the repository it is handed rather than the project’s', () => {
			expect(scm.pullRequestUrl('other/repo', 7)).toBe('https://github.com/other/repo/pull/7');
		});
	});

	describe('getBranchHead', () => {
		beforeEach(() => {
			vi.mocked(getBranchHead).mockReset();
			vi.mocked(getBranchHead).mockResolvedValue('base-head-sha');
		});

		// The reviewer, like every read the control plane makes (issue #1249).
		it('reads under the reviewer persona by default, with owner/repo split from project.repo', async () => {
			vi.mocked(getPersonaToken).mockResolvedValue('tok-rev');
			await expect(scm.getBranchHead(project, 'main')).resolves.toBe('base-head-sha');

			expect(getPersonaToken).toHaveBeenCalledWith(project, 'reviewer');
			expect(withGitHubToken).toHaveBeenCalledWith('tok-rev', expect.any(Function));
			expect(getBranchHead).toHaveBeenCalledWith('SmartTechBrewery', 'swarm', 'main');
		});

		it('honours an explicit persona override', async () => {
			vi.mocked(getPersonaToken).mockResolvedValue('tok-impl');
			await scm.getBranchHead(project, 'main', 'implementer');
			expect(getPersonaToken).toHaveBeenCalledWith(project, 'implementer');
		});
	});

	describe('getAggregateCheckStatus', () => {
		const aggregate = {
			totalCount: 1,
			checkRuns: [{ name: 'test', status: 'completed', conclusion: 'success' }],
		};

		beforeEach(() => {
			vi.mocked(getCheckSuiteStatus).mockReset();
			vi.mocked(getCheckSuiteStatus).mockResolvedValue(aggregate);
		});

		it('reads under the reviewer persona by default, with owner/repo split from project.repo', async () => {
			vi.mocked(getPersonaToken).mockResolvedValue('tok-rev');
			await expect(scm.getAggregateCheckStatus(project, 'cafe')).resolves.toEqual(aggregate);

			expect(getPersonaToken).toHaveBeenCalledWith(project, 'reviewer');
			expect(withGitHubToken).toHaveBeenCalledWith('tok-rev', expect.any(Function));
			expect(getCheckSuiteStatus).toHaveBeenCalledWith('SmartTechBrewery', 'swarm', 'cafe');
		});

		it('honours an explicit persona override', async () => {
			vi.mocked(getPersonaToken).mockResolvedValue('tok-impl');
			await scm.getAggregateCheckStatus(project, 'cafe', 'implementer');
			expect(getPersonaToken).toHaveBeenCalledWith(project, 'implementer');
		});
	});

	describe('rerunFailedChecks', () => {
		beforeEach(() => {
			vi.mocked(rerunFailedWorkflowRuns).mockReset();
		});

		it('writes as the implementer by default and reports the re-run workflow runs', async () => {
			vi.mocked(getPersonaToken).mockResolvedValue('tok-impl');
			vi.mocked(rerunFailedWorkflowRuns).mockResolvedValue(['CI']);

			await expect(scm.rerunFailedChecks(project, 'cafe')).resolves.toEqual({
				status: 'requested',
				checks: ['CI'],
			});
			expect(getPersonaToken).toHaveBeenCalledWith(project, 'implementer');
			expect(withGitHubToken).toHaveBeenCalledWith('tok-impl', expect.any(Function));
			expect(rerunFailedWorkflowRuns).toHaveBeenCalledWith('SmartTechBrewery', 'swarm', 'cafe');
		});

		it('honours an explicit persona override', async () => {
			vi.mocked(getPersonaToken).mockResolvedValue('tok-rev');
			vi.mocked(rerunFailedWorkflowRuns).mockResolvedValue([]);
			await scm.rerunFailedChecks(project, 'cafe', 'reviewer');
			expect(getPersonaToken).toHaveBeenCalledWith(project, 'reviewer');
		});

		it('answers nothing-to-rerun when no workflow run failed', async () => {
			vi.mocked(getPersonaToken).mockResolvedValue('tok-impl');
			vi.mocked(rerunFailedWorkflowRuns).mockResolvedValue([]);
			await expect(scm.rerunFailedChecks(project, 'cafe')).resolves.toEqual({
				status: 'nothing-to-rerun',
			});
		});

		it('turns a refused re-run (a 403 included) into provider-error instead of throwing', async () => {
			vi.mocked(getPersonaToken).mockResolvedValue('tok-impl');
			vi.mocked(rerunFailedWorkflowRuns).mockRejectedValue(
				new Error('Resource not accessible by personal access token'),
			);
			await expect(scm.rerunFailedChecks(project, 'cafe')).resolves.toEqual({
				status: 'provider-error',
				message: 'Resource not accessible by personal access token',
			});
		});

		it('turns an unresolvable token into provider-error instead of throwing', async () => {
			vi.mocked(getPersonaToken).mockRejectedValue(new Error('no implementer token'));
			await expect(scm.rerunFailedChecks(project, 'cafe')).resolves.toEqual({
				status: 'provider-error',
				message: 'no implementer token',
			});
			expect(rerunFailedWorkflowRuns).not.toHaveBeenCalled();
		});
	});

	describe('mergePullRequest (issue #253, direct PAT merge as the sole strategy per issue #292)', () => {
		beforeEach(() => {
			vi.mocked(getPersonaToken).mockResolvedValue('tok-impl');
			vi.mocked(getPullRequestMergeState).mockReset();
			vi.mocked(mergePullRequestDirect).mockReset();
			vi.mocked(getPullRequestReviewDecision).mockReset();
			vi.mocked(getPullRequestReviews).mockReset();
			// A head that already contains its base, unless a test says otherwise.
			vi.mocked(isBaseContainedInHead).mockReset().mockResolvedValue(true);
			// The default fixture models an unambiguously-approved PR, so every test
			// that doesn't care about the review-decision recheck proceeds past it.
			vi.mocked(getPullRequestReviewDecision).mockResolvedValue('APPROVED');
			vi.mocked(getPullRequestReviews).mockResolvedValue([
				{ state: 'APPROVED', commitId: 'reviewed-head' },
			]);
		});

		it('exposes no native auto-merge capability anywhere in the GitHub client (issue #292)', async () => {
			// The `Auto merge is not allowed for this repository` failure can only
			// recur if some code path asks GitHub to arm native auto-merge again —
			// the capability must not exist to be called.
			const actual = await vi.importActual<Record<string, unknown>>(
				'@/integrations/scm/github/client.js',
			);
			expect(Object.keys(actual).filter((key) => /auto.?merge/i.test(key))).toEqual([]);
		});

		it('runs under the implementer credentials', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: true,
				state: 'closed',
				draft: false,
				headSha: 'reviewed-head',
				behindBase: false,
				baseRef: 'main',
			});
			await scm.mergePullRequest(project, 42, 'reviewed-head');
			expect(getPersonaToken).toHaveBeenCalledWith(project, 'implementer');
		});

		it('reports merged idempotently when the PR is already merged, without attempting anything', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: true,
				state: 'closed',
				draft: false,
				headSha: 'reviewed-head',
				behindBase: false,
				baseRef: 'main',
			});

			await expect(scm.mergePullRequest(project, 42, 'reviewed-head')).resolves.toEqual({
				status: 'merged',
				message: 'pull request already merged',
			});
			expect(mergePullRequestDirect).not.toHaveBeenCalled();
			expect(isBaseContainedInHead).not.toHaveBeenCalled();
		});

		it('is not-eligible when the current head no longer matches the approved head', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: false,
				headSha: 'new-head-after-push',
				behindBase: false,
				baseRef: 'main',
			});

			await expect(scm.mergePullRequest(project, 42, 'reviewed-head')).resolves.toEqual({
				status: 'not-eligible',
				message: expect.stringContaining('pull request head changed since the reviewed commit'),
			});
			expect(getPullRequestReviewDecision).not.toHaveBeenCalled();
			expect(mergePullRequestDirect).not.toHaveBeenCalled();
		});

		it('is not-eligible for a draft pull request, without attempting anything', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: true,
				headSha: 'reviewed-head',
				behindBase: false,
				baseRef: 'main',
			});

			await expect(scm.mergePullRequest(project, 42, 'reviewed-head')).resolves.toEqual({
				status: 'not-eligible',
				message: 'pull request was converted back to a draft after the review was approved',
			});
			expect(mergePullRequestDirect).not.toHaveBeenCalled();
		});

		it('is not-eligible for a closed, unmerged pull request', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'closed',
				draft: false,
				headSha: 'reviewed-head',
				behindBase: false,
				baseRef: 'main',
			});

			await expect(scm.mergePullRequest(project, 42, 'reviewed-head')).resolves.toEqual({
				status: 'not-eligible',
				message: 'pull request is closed',
			});
			expect(mergePullRequestDirect).not.toHaveBeenCalled();
		});

		it('is not-eligible when the approving review has since had changes requested', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: false,
				headSha: 'reviewed-head',
				behindBase: false,
				baseRef: 'main',
			});
			vi.mocked(getPullRequestReviewDecision).mockResolvedValue('CHANGES_REQUESTED');

			await expect(scm.mergePullRequest(project, 42, 'reviewed-head')).resolves.toEqual({
				status: 'not-eligible',
				message: 'the approving review is no longer in effect — changes have since been requested',
			});
			expect(mergePullRequestDirect).not.toHaveBeenCalled();
		});

		it('proceeds to attempt the merge when review-decision propagation still shows REVIEW_REQUIRED', async () => {
			// GitHub can briefly report the required-review decision as not-yet-caught-up
			// right after a review is submitted — this must not be treated as ineligible;
			// it rides the same not-ready retry loop as any other transient condition.
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: false,
				headSha: 'reviewed-head',
				behindBase: false,
				baseRef: 'main',
			});
			vi.mocked(getPullRequestReviewDecision).mockResolvedValue('REVIEW_REQUIRED');
			vi.mocked(mergePullRequestDirect).mockResolvedValue({
				merged: true,
				message: 'Pull Request successfully merged',
				sha: 'deadbeef',
			});

			await expect(scm.mergePullRequest(project, 42, 'reviewed-head')).resolves.toEqual({
				status: 'merged',
				message: 'Pull Request successfully merged',
				sha: 'deadbeef',
			});
		});

		it('is not-eligible when the required-review decision is REVIEW_REQUIRED and the approval is dismissed', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: false,
				headSha: 'reviewed-head',
				behindBase: false,
				baseRef: 'main',
			});
			vi.mocked(getPullRequestReviewDecision).mockResolvedValue('REVIEW_REQUIRED');
			vi.mocked(getPullRequestReviews).mockResolvedValue([
				{ state: 'DISMISSED', commitId: 'reviewed-head' },
			]);

			await expect(scm.mergePullRequest(project, 42, 'reviewed-head')).resolves.toEqual({
				status: 'not-eligible',
				message: 'the approving review is no longer in effect — it has since been dismissed',
			});
			expect(mergePullRequestDirect).not.toHaveBeenCalled();
		});

		it('proceeds to attempt the merge when the repository has no review-decision opinion (null)', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: false,
				headSha: 'reviewed-head',
				behindBase: false,
				baseRef: 'main',
			});
			vi.mocked(getPullRequestReviewDecision).mockResolvedValue(null);
			vi.mocked(mergePullRequestDirect).mockResolvedValue({
				merged: true,
				message: 'Pull Request successfully merged',
				sha: 'deadbeef',
			});

			await expect(scm.mergePullRequest(project, 42, 'reviewed-head')).resolves.toEqual({
				status: 'merged',
				message: 'Pull Request successfully merged',
				sha: 'deadbeef',
			});
		});

		it('is provider-error when the review-decision lookup fails', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: false,
				headSha: 'reviewed-head',
				behindBase: false,
				baseRef: 'main',
			});
			vi.mocked(getPullRequestReviewDecision).mockRejectedValue(new Error('502 Bad Gateway'));

			await expect(scm.mergePullRequest(project, 42, 'reviewed-head')).resolves.toEqual({
				status: 'provider-error',
				message: '502 Bad Gateway',
			});
			expect(mergePullRequestDirect).not.toHaveBeenCalled();
		});

		it('is provider-error when the initial PR lookup fails', async () => {
			vi.mocked(getPullRequestMergeState).mockRejectedValue(new Error('502 Bad Gateway'));

			await expect(scm.mergePullRequest(project, 42, 'reviewed-head')).resolves.toEqual({
				status: 'provider-error',
				message: '502 Bad Gateway',
			});
			expect(mergePullRequestDirect).not.toHaveBeenCalled();
		});

		it('merges an eligible PR through the direct endpoint, pinned to the reviewed head', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: false,
				headSha: 'reviewed-head',
				behindBase: false,
				baseRef: 'main',
			});
			vi.mocked(mergePullRequestDirect).mockResolvedValue({
				merged: true,
				message: 'Pull Request successfully merged',
				sha: 'deadbeef',
			});

			await expect(scm.mergePullRequest(project, 42, 'reviewed-head')).resolves.toEqual({
				status: 'merged',
				message: 'Pull Request successfully merged',
				sha: 'deadbeef',
			});
			expect(mergePullRequestDirect).toHaveBeenCalledWith(
				'SmartTechBrewery',
				'swarm',
				42,
				'reviewed-head',
			);
		});

		it('is not-ready when the direct merge reports the PR is not currently mergeable', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: false,
				headSha: 'reviewed-head',
				behindBase: false,
				baseRef: 'main',
			});
			vi.mocked(mergePullRequestDirect).mockResolvedValue({
				merged: false,
				message: 'At least 1 approving review is required',
			});

			await expect(scm.mergePullRequest(project, 42, 'reviewed-head')).resolves.toEqual({
				status: 'not-ready',
				message: 'At least 1 approving review is required',
			});
		});

		it('is not-ready when the direct merge endpoint responds 405 (unmet checks/reviews/conflicts)', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: false,
				headSha: 'reviewed-head',
				behindBase: false,
				baseRef: 'main',
			});
			vi.mocked(mergePullRequestDirect).mockRejectedValue(
				Object.assign(new Error('Pull Request is not mergeable'), { status: 405 }),
			);

			await expect(scm.mergePullRequest(project, 42, 'reviewed-head')).resolves.toEqual({
				status: 'not-ready',
				message: 'Pull Request is not mergeable',
			});
		});

		it('is not-ready when the direct merge endpoint responds 409 (head branch modified)', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: false,
				headSha: 'reviewed-head',
				behindBase: false,
				baseRef: 'main',
			});
			vi.mocked(mergePullRequestDirect).mockRejectedValue(
				Object.assign(new Error('Head branch was modified. Review and try the merge again.'), {
					status: 409,
				}),
			);

			await expect(scm.mergePullRequest(project, 42, 'reviewed-head')).resolves.toEqual({
				status: 'not-ready',
				message: 'Head branch was modified. Review and try the merge again.',
			});
		});

		it('is unsupported when the repository requires the merge queue (403 variant)', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: false,
				headSha: 'reviewed-head',
				behindBase: false,
				baseRef: 'main',
			});
			vi.mocked(mergePullRequestDirect).mockRejectedValue(
				Object.assign(
					new Error('Changes must be made through a pull request using a merge queue'),
					{
						status: 403,
					},
				),
			);

			await expect(scm.mergePullRequest(project, 42, 'reviewed-head')).resolves.toEqual({
				status: 'unsupported',
				message: 'Changes must be made through a pull request using a merge queue',
			});
		});

		it('is unsupported when the repository requires the merge queue (405 variant)', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: false,
				headSha: 'reviewed-head',
				behindBase: false,
				baseRef: 'main',
			});
			vi.mocked(mergePullRequestDirect).mockRejectedValue(
				Object.assign(new Error('This branch must be merged via the merge queue'), {
					status: 405,
				}),
			);

			await expect(scm.mergePullRequest(project, 42, 'reviewed-head')).resolves.toEqual({
				status: 'unsupported',
				message: 'This branch must be merged via the merge queue',
			});
		});

		it('is policy-blocked for a plain 403 branch-protection/permission refusal', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: false,
				headSha: 'reviewed-head',
				behindBase: false,
				baseRef: 'main',
			});
			vi.mocked(mergePullRequestDirect).mockRejectedValue(
				Object.assign(new Error('Protected branch update failed'), { status: 403 }),
			);

			await expect(scm.mergePullRequest(project, 42, 'reviewed-head')).resolves.toEqual({
				status: 'policy-blocked',
				message: 'Protected branch update failed',
			});
		});

		it('is provider-error for an unexpected direct-merge failure (e.g. 500 or network)', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: false,
				headSha: 'reviewed-head',
				behindBase: false,
				baseRef: 'main',
			});
			vi.mocked(mergePullRequestDirect).mockRejectedValue(
				Object.assign(new Error('Internal Server Error'), { status: 500 }),
			);

			await expect(scm.mergePullRequest(project, 42, 'reviewed-head')).resolves.toEqual({
				status: 'provider-error',
				message: 'Internal Server Error',
			});
		});

		// Issue #874: an approved, otherwise-ready head whose checks never built the
		// base it would land on is refused rather than merged, so the dispatch can
		// bring it up to date and wait for the fresh CI.
		it('refuses a head that is behind its base instead of merging it', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: false,
				headSha: 'reviewed-head',
				behindBase: true,
				baseRef: 'main',
			});

			await expect(scm.mergePullRequest(project, 42, 'reviewed-head')).resolves.toMatchObject({
				status: 'stale-base',
			});
			expect(mergePullRequestDirect).not.toHaveBeenCalled();
			// GitHub's own `behind` is trusted as-is (issue #1113): a repository that
			// requires up-to-date branches costs no extra read and answers as before.
			expect(isBaseContainedInHead).not.toHaveBeenCalled();
		});

		// Issue #1113: a repository that does not require up-to-date branches
		// reports `clean` for a head many commits behind, so the commit graph decides.
		it('refuses a head GitHub calls clean when it does not contain its base', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: false,
				headSha: 'reviewed-head',
				behindBase: false,
				baseRef: 'main',
			});
			vi.mocked(isBaseContainedInHead).mockResolvedValue(false);

			await expect(scm.mergePullRequest(project, 42, 'reviewed-head')).resolves.toEqual({
				status: 'stale-base',
				message:
					'pull request head reviewed-head is behind its base branch, so its checks did not build the tree this merge would produce',
			});
			expect(isBaseContainedInHead).toHaveBeenCalledExactlyOnceWith(
				'SmartTechBrewery',
				'swarm',
				'main',
				'reviewed-head',
			);
			expect(mergePullRequestDirect).not.toHaveBeenCalled();
		});

		it('merges a head that contains its base after exactly one graph read', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: false,
				headSha: 'reviewed-head',
				behindBase: false,
				baseRef: 'main',
			});
			vi.mocked(mergePullRequestDirect).mockResolvedValue({
				merged: true,
				message: 'Pull Request successfully merged',
				sha: 'merge-sha',
			});

			await expect(scm.mergePullRequest(project, 42, 'reviewed-head')).resolves.toMatchObject({
				status: 'merged',
			});
			expect(isBaseContainedInHead).toHaveBeenCalledTimes(1);
			expect(mergePullRequestDirect).toHaveBeenCalledExactlyOnceWith(
				'SmartTechBrewery',
				'swarm',
				42,
				'reviewed-head',
			);
		});

		it('reports a failed graph read as a provider error, never as up to date', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: false,
				headSha: 'reviewed-head',
				behindBase: false,
				baseRef: 'main',
			});
			vi.mocked(isBaseContainedInHead).mockRejectedValue(new Error('compare unavailable'));

			await expect(scm.mergePullRequest(project, 42, 'reviewed-head')).resolves.toEqual({
				status: 'provider-error',
				message: 'compare unavailable',
			});
			expect(mergePullRequestDirect).not.toHaveBeenCalled();
		});

		// Ordering matters: an approval that no longer holds must report *that*,
		// rather than sending the dispatch off to update a branch nobody may merge.
		it('reports a lost approval ahead of base staleness', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: false,
				headSha: 'pushed-since',
				behindBase: true,
				baseRef: 'main',
			});

			await expect(scm.mergePullRequest(project, 42, 'reviewed-head')).resolves.toMatchObject({
				status: 'not-eligible',
			});
			expect(isBaseContainedInHead).not.toHaveBeenCalled();
		});
	});

	// Issue #874. The endpoint answers 202 with no SHA, so the new head is read
	// back — and the approval the dispatch carries forward is pinned to it.
	describe('updatePullRequestBranch', () => {
		beforeEach(() => {
			vi.mocked(getPersonaToken).mockResolvedValue('tok-impl');
			vi.mocked(getPullRequestMergeState).mockReset();
			vi.mocked(updatePullRequestBranchDirect).mockReset();
			vi.mocked(updatePullRequestBranchDirect).mockResolvedValue(undefined);
			vi.mocked(getCommitProvenance).mockReset();
			vi.mocked(isContainedInBranch).mockReset();
			// The default is the commit GitHub's own update produces: a two-parent
			// merge of the reviewed head with a base commit, signed by GitHub.
			vi.mocked(getCommitProvenance).mockResolvedValue({
				parents: ['reviewed-head', 'base-head'],
				signedByGitHub: true,
			});
			vi.mocked(isContainedInBranch).mockResolvedValue(true);
			vi.mocked(isBaseContainedInHead).mockReset().mockResolvedValue(true);
		});

		function mergeStateAt(headSha: string, behindBase = false) {
			return { merged: false, state: 'open', draft: false, headSha, behindBase, baseRef: 'main' };
		}

		/** Drive the read-back loop's timers and settle the call. */
		async function updateAndSettle(expectedHeadSha = 'reviewed-head') {
			vi.useFakeTimers();
			try {
				const outcome = scm.updatePullRequestBranch(project, 42, expectedHeadSha);
				await vi.advanceTimersByTimeAsync(10_000);
				return await outcome;
			} finally {
				vi.useRealTimers();
			}
		}

		it('updates as the implementer, pinned to the expected head, and reports the new one', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue(mergeStateAt('merged-base-head'));

			await expect(updateAndSettle()).resolves.toEqual({
				status: 'updated',
				headSha: 'merged-base-head',
			});

			expect(updatePullRequestBranchDirect).toHaveBeenCalledExactlyOnceWith(
				'SmartTechBrewery',
				'swarm',
				42,
				'reviewed-head',
			);
			expect(getPersonaToken).toHaveBeenCalledWith(project, 'implementer');
			// The new head is attributed to *this* update before the approval may
			// travel onto it: GitHub built it, from the reviewed head and base code.
			expect(getCommitProvenance).toHaveBeenCalledWith(
				'SmartTechBrewery',
				'swarm',
				'merged-base-head',
			);
			expect(isContainedInBranch).toHaveBeenCalledWith(
				'SmartTechBrewery',
				'swarm',
				'main',
				'base-head',
			);
			// A moved head is judged by attribution alone; no staleness read.
			expect(isBaseContainedInHead).not.toHaveBeenCalled();
		});

		// The blocker this capability exists to avoid: `PUT .../update-branch`
		// validates `expected_head_sha` and then merges in the *background*, so the
		// head observed afterwards is whatever the branch points at by then. Anyone
		// who may push to the branch can land a commit in that window, and treating
		// it as the update's result would re-pin the approval to unreviewed code and
		// suppress the review that push is owed.
		describe('a head it cannot attribute to this update', () => {
			beforeEach(() => {
				vi.mocked(getPullRequestMergeState).mockResolvedValue(mergeStateAt('pushed-head'));
			});

			it('refuses a commit pushed on top of the reviewed head', async () => {
				vi.mocked(getCommitProvenance).mockResolvedValue({
					parents: ['reviewed-head'],
					signedByGitHub: false,
				});

				await expect(updateAndSettle()).resolves.toMatchObject({ status: 'head-moved' });
			});

			it('refuses a merge that does not build on the reviewed head', async () => {
				vi.mocked(getCommitProvenance).mockResolvedValue({
					parents: ['somebody-elses-head', 'base-head'],
					signedByGitHub: true,
				});

				await expect(updateAndSettle()).resolves.toMatchObject({ status: 'head-moved' });
			});

			// The shape of GitHub's update commit is not proof of its *content*: a
			// merge commit with the right two parents and a hand-composed tree is a
			// thing a push can produce, and only GitHub's signature rules it out.
			it('refuses a correctly shaped merge GitHub did not sign', async () => {
				vi.mocked(getCommitProvenance).mockResolvedValue({
					parents: ['reviewed-head', 'base-head'],
					signedByGitHub: false,
				});

				await expect(updateAndSettle()).resolves.toMatchObject({ status: 'head-moved' });
				// Refused on the commit alone — no need to ask about its second parent.
				expect(isContainedInBranch).not.toHaveBeenCalled();
			});

			// Merging the reviewed head with an *arbitrary* branch is still a signed,
			// two-parent merge of the reviewed head — what makes it unsafe is that its
			// other side is code the base does not have.
			it('refuses a merge whose other parent is not base code', async () => {
				vi.mocked(getCommitProvenance).mockResolvedValue({
					parents: ['reviewed-head', 'unrelated-branch-head'],
					signedByGitHub: true,
				});
				vi.mocked(isContainedInBranch).mockResolvedValue(false);

				await expect(updateAndSettle()).resolves.toMatchObject({ status: 'head-moved' });
			});

			it('names the head it refused and the commit it expected an update from', async () => {
				vi.mocked(getCommitProvenance).mockResolvedValue({
					parents: ['reviewed-head'],
					signedByGitHub: false,
				});

				const outcome = await updateAndSettle();
				expect(outcome).toMatchObject({ status: 'head-moved' });
				const message = 'message' in outcome ? outcome.message : '';
				expect(message).toContain('pushed-head');
				expect(message).toContain('reviewed-head');
				expect(message).toContain('main');
			});

			// An unreachable attribution read is a provider failure, not a licence to
			// carry the approval: neither answer may default to `updated`.
			it('is a provider error when the attribution read fails', async () => {
				vi.mocked(getCommitProvenance).mockRejectedValue(new Error('502 Bad Gateway'));

				await expect(updateAndSettle()).resolves.toEqual({
					status: 'provider-error',
					message: '502 Bad Gateway',
				});
			});
		});

		// A 422 is GitHub's answer both to "the head is not that commit any more"
		// and to "the base does not merge cleanly"; either way there is nothing to
		// retry, and the merge dispatch settles the pull request terminally.
		it('is a conflict for a 422', async () => {
			vi.mocked(updatePullRequestBranchDirect).mockRejectedValue(
				Object.assign(new Error('merge conflict between base and head'), { status: 422 }),
			);

			await expect(scm.updatePullRequestBranch(project, 42, 'reviewed-head')).resolves.toEqual({
				status: 'conflict',
				message: 'merge conflict between base and head',
			});
		});

		it('is up-to-date when GitHub says the branch already contains the base', async () => {
			vi.mocked(updatePullRequestBranchDirect).mockRejectedValue(
				Object.assign(new Error('This branch is already up to date'), { status: 422 }),
			);

			await expect(scm.updatePullRequestBranch(project, 42, 'reviewed-head')).resolves.toEqual({
				status: 'up-to-date',
			});
		});

		it('is unsupported when the credential may not write the branch', async () => {
			vi.mocked(updatePullRequestBranchDirect).mockRejectedValue(
				Object.assign(new Error('Resource not accessible by integration'), { status: 403 }),
			);

			await expect(scm.updatePullRequestBranch(project, 42, 'reviewed-head')).resolves.toEqual({
				status: 'unsupported',
				message: 'Resource not accessible by integration',
			});
		});

		// The head never moving is not "updated with the old SHA": re-pinning the
		// approval to a commit the background job is about to replace would make the
		// next attempt read a moved head and refuse the merge outright.
		it('reports a provider error rather than an unchanged head when the job never publishes', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue(mergeStateAt('reviewed-head', true));

			vi.useFakeTimers();
			const outcome = scm.updatePullRequestBranch(project, 42, 'reviewed-head');
			await vi.advanceTimersByTimeAsync(10_000);
			await expect(outcome).resolves.toMatchObject({ status: 'provider-error' });
			vi.useRealTimers();
			expect(isBaseContainedInHead).not.toHaveBeenCalled();
		});

		it('reports up-to-date when the head never moves and already contains its base', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue(mergeStateAt('reviewed-head', false));

			await expect(updateAndSettle()).resolves.toEqual({ status: 'up-to-date' });
			// Asked once, after the wait — not once per read-back attempt.
			expect(isBaseContainedInHead).toHaveBeenCalledExactlyOnceWith(
				'SmartTechBrewery',
				'swarm',
				'main',
				'reviewed-head',
			);
		});

		// Issue #1113: GitHub says `clean` in a repository that does not require
		// up-to-date branches, so `mergeable_state` cannot call this up to date.
		it('reports a provider error when the head never moves and still lacks the base', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue(mergeStateAt('reviewed-head', false));
			vi.mocked(isBaseContainedInHead).mockResolvedValue(false);

			await expect(updateAndSettle()).resolves.toEqual({
				status: 'provider-error',
				message:
					'GitHub accepted the branch update for #42 but had not published the new head after 5s',
			});
		});

		it('reports a provider error when the graph read fails after the head never moved', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue(mergeStateAt('reviewed-head', false));
			vi.mocked(isBaseContainedInHead).mockRejectedValue(new Error('compare unavailable'));

			await expect(updateAndSettle()).resolves.toEqual({
				status: 'provider-error',
				message: 'compare unavailable',
			});
		});

		it('never throws — an unresolvable credential comes back as provider-error', async () => {
			vi.mocked(getPersonaToken).mockRejectedValue(new Error('no implementer token'));

			await expect(scm.updatePullRequestBranch(project, 42, 'reviewed-head')).resolves.toEqual({
				status: 'provider-error',
				message: 'no implementer token',
			});
		});
	});

	describe('deliveryProvider', () => {
		it('resolves deterministic commit identity from the selected persona token', async () => {
			vi.mocked(getPersonaToken).mockResolvedValue('tok-impl');
			vi.mocked(getGitHubUserForToken).mockResolvedValue('swarm-implementer');
			const delivery = await scm.deliveryProvider(project, 'implementer');
			expect(delivery.commitIdentity).toEqual({
				name: 'swarm-implementer',
				email: 'swarm-implementer@users.noreply.github.com',
			});
		});

		it('reads the pull request context under the persona token (issue #1239)', async () => {
			vi.mocked(getPersonaToken).mockResolvedValue('tok-reviewer');
			vi.mocked(getGitHubUserForToken).mockResolvedValue('swarm-reviewer');
			vi.mocked(readGitHubPullRequestContext).mockResolvedValue({
				number: 7,
			} as Awaited<ReturnType<typeof readGitHubPullRequestContext>>);
			const delivery = await scm.deliveryProvider(project, 'reviewer');

			await expect(delivery.readPullRequestContext(7)).resolves.toEqual({ number: 7 });

			expect(readGitHubPullRequestContext).toHaveBeenCalledWith('SmartTechBrewery', 'swarm', 7);
			expect(vi.mocked(withGitHubToken).mock.calls.at(-1)?.[0]).toBe('tok-reviewer');
		});

		it('bypasses interactive git hooks when pushing a worker-owned delivery', async () => {
			vi.mocked(getPersonaToken).mockResolvedValue('tok-impl');
			vi.mocked(getGitHubUserForToken).mockResolvedValue('swarm-implementer');
			const delivery = await scm.deliveryProvider(project, 'implementer');

			await delivery.pushBranch('/worktree', 'issue-241', 'abc1234');

			expect(mockExecFile).toHaveBeenCalledWith(
				'git',
				[
					'push',
					'--no-verify',
					'https://github.com/SmartTechBrewery/swarm.git',
					'abc1234:refs/heads/issue-241',
				],
				expect.objectContaining({ cwd: '/worktree' }),
				expect.any(Function),
			);
		});
	});

	// The operator-credential producer a DB-free federated worker resolves through
	// the registry (issue #462) instead of importing `operator-delivery.ts` itself.
	describe('operatorDeliveryProvider', () => {
		it('resolves commit identity from the operator credential, not a persona token', async () => {
			vi.mocked(getGitHubUserForToken).mockResolvedValue('operator-login');
			const delivery = await scm.operatorDeliveryProvider(project.repo, 'operator-token');

			expect(delivery.commitIdentity).toEqual({
				name: 'operator-login',
				email: 'operator-login@users.noreply.github.com',
			});
			// The credential is the operator's own — no secret store is consulted, which
			// is the whole point on a worker that holds none.
			expect(getGitHubUserForToken).toHaveBeenCalledWith('operator-token');
			expect(getPersonaToken).not.toHaveBeenCalled();
		});

		it('refuses submitReview — a reviewer verdict stays the server delivery API write', async () => {
			vi.mocked(getGitHubUserForToken).mockResolvedValue('operator-login');
			const delivery = await scm.operatorDeliveryProvider(project.repo, 'operator-token');

			expect(() =>
				delivery.submitReview({
					prNumber: 7,
					verdict: 'approve',
					body: 'lgtm',
					deliveryId: 'd1',
				}),
			).toThrow(/submitReview is not available on a worker/i);
		});
	});
});
