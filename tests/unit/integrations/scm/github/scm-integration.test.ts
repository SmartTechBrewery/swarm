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
	getCheckSuiteStatus: vi.fn(),
	getPullRequestAuthorLogin: vi.fn(),
	getPullRequestMergeState: vi.fn(),
	getPullRequestReviewDecision: vi.fn(),
	getPullRequestReviews: vi.fn(),
	mergePullRequestDirect: vi.fn(),
}));

import { getPersonaToken, getPersonaTokenOrNull } from '@/config/provider.js';
import {
	getCheckSuiteStatus,
	getGitHubUserForToken,
	getPullRequestAuthorLogin,
	getPullRequestMergeState,
	getPullRequestReviewDecision,
	getPullRequestReviews,
	mergePullRequestDirect,
	withGitHubToken,
} from '@/integrations/scm/github/client.js';
import {
	_resetPersonaIdentityCache,
	getPersonaForLogin,
	isSwarmBot,
} from '@/integrations/scm/github/personas.js';
import { GitHubSCMIntegration } from '@/integrations/scm/github/scm-integration.js';
import type { ScmPersonaIdentities } from '@/scm/types.js';

const project = createMockProjectConfig();
const IDENTITIES: ScmPersonaIdentities = { implementer: 'swarm-impl', reviewer: 'swarm-rev' };

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

	describe('persona/actor resolution (SCMProvider contract wrappers)', () => {
		beforeEach(() => {
			_resetPersonaIdentityCache();
		});

		it('resolves both persona identities from their own tokens', async () => {
			vi.mocked(getPersonaTokenOrNull).mockImplementation(async (_p, persona) => `tok-${persona}`);
			vi.mocked(getGitHubUserForToken).mockImplementation(async (token) =>
				token === 'tok-implementer' ? 'swarm-impl' : 'swarm-rev',
			);
			await expect(scm.resolvePersonaIdentities(project)).resolves.toEqual(IDENTITIES);
		});

		it('propagates the throw when an identity cannot be resolved', async () => {
			vi.mocked(getPersonaTokenOrNull).mockResolvedValue('tok');
			vi.mocked(getGitHubUserForToken).mockResolvedValue(null);
			await expect(scm.resolvePersonaIdentities(project)).rejects.toThrow(/implementer/);
		});

		it('personaForActor answers the same as the module-level mapping, bot suffix included', () => {
			for (const login of [
				'swarm-impl',
				'swarm-impl[bot]',
				'swarm-rev',
				'swarm-rev[bot]',
				'human',
			]) {
				expect(scm.personaForActor(login, IDENTITIES)).toBe(getPersonaForLogin(login, IDENTITIES));
			}
			expect(scm.personaForActor('swarm-rev[bot]', IDENTITIES)).toBe('reviewer');
			expect(scm.personaForActor('human', IDENTITIES)).toBeNull();
		});

		it('isSwarmActor answers the same as the module-level bot check', () => {
			for (const login of ['swarm-impl', 'swarm-rev[bot]', 'human']) {
				expect(scm.isSwarmActor(login, IDENTITIES)).toBe(isSwarmBot(login, IDENTITIES));
			}
			expect(scm.isSwarmActor('swarm-impl[bot]', IDENTITIES)).toBe(true);
			expect(scm.isSwarmActor('human', IDENTITIES)).toBe(false);
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

	describe('getPullRequestAuthor', () => {
		beforeEach(() => {
			vi.mocked(getPullRequestAuthorLogin).mockReset();
			vi.mocked(getPullRequestAuthorLogin).mockResolvedValue('someone');
		});

		it('reads under the reviewer persona by default, with owner/repo split from project.repo', async () => {
			vi.mocked(getPersonaToken).mockResolvedValue('tok-rev');
			await expect(scm.getPullRequestAuthor(project, 42)).resolves.toBe('someone');

			expect(getPersonaToken).toHaveBeenCalledWith(project, 'reviewer');
			expect(withGitHubToken).toHaveBeenCalledWith('tok-rev', expect.any(Function));
			expect(getPullRequestAuthorLogin).toHaveBeenCalledWith('jkwiecien', 'swarm', 42);
		});

		it('honours an explicit persona override', async () => {
			vi.mocked(getPersonaToken).mockResolvedValue('tok-impl');
			await scm.getPullRequestAuthor(project, 42, 'implementer');
			expect(getPersonaToken).toHaveBeenCalledWith(project, 'implementer');
		});

		it('propagates an API failure rather than reporting no author', async () => {
			vi.mocked(getPersonaToken).mockResolvedValue('tok-rev');
			vi.mocked(getPullRequestAuthorLogin).mockRejectedValue(new Error('502 Bad Gateway'));
			await expect(scm.getPullRequestAuthor(project, 42)).rejects.toThrow(/502/);
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
			expect(getCheckSuiteStatus).toHaveBeenCalledWith('jkwiecien', 'swarm', 'cafe');
		});

		it('honours an explicit persona override', async () => {
			vi.mocked(getPersonaToken).mockResolvedValue('tok-impl');
			await scm.getAggregateCheckStatus(project, 'cafe', 'implementer');
			expect(getPersonaToken).toHaveBeenCalledWith(project, 'implementer');
		});
	});

	describe('mergePullRequest (issue #253, direct PAT merge as the sole strategy per issue #292)', () => {
		beforeEach(() => {
			vi.mocked(getPersonaToken).mockResolvedValue('tok-impl');
			vi.mocked(getPullRequestMergeState).mockReset();
			vi.mocked(mergePullRequestDirect).mockReset();
			vi.mocked(getPullRequestReviewDecision).mockReset();
			vi.mocked(getPullRequestReviews).mockReset();
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
			});

			await expect(scm.mergePullRequest(project, 42, 'reviewed-head')).resolves.toEqual({
				status: 'merged',
				message: 'pull request already merged',
			});
			expect(mergePullRequestDirect).not.toHaveBeenCalled();
		});

		it('is not-eligible when the current head no longer matches the approved head', async () => {
			vi.mocked(getPullRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: false,
				headSha: 'new-head-after-push',
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
				'jkwiecien',
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
			});
			vi.mocked(mergePullRequestDirect).mockRejectedValue(
				Object.assign(new Error('Internal Server Error'), { status: 500 }),
			);

			await expect(scm.mergePullRequest(project, 42, 'reviewed-head')).resolves.toEqual({
				status: 'provider-error',
				message: 'Internal Server Error',
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
					'https://github.com/jkwiecien/swarm.git',
					'abc1234:refs/heads/issue-241',
				],
				expect.objectContaining({ cwd: '/worktree' }),
				expect.any(Function),
			);
		});
	});
});
