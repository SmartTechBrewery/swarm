import { beforeEach, describe, expect, it, vi } from 'vitest';

// Capture git invocations without spawning a process. `promisify(execFile)` calls
// the mocked `execFile` with a node-style callback, so resolve it successfully.
const execFileCalls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
vi.mock('node:child_process', () => ({
	execFile: (
		_cmd: string,
		args: string[],
		opts: { env: NodeJS.ProcessEnv },
		cb: (err: unknown, res: { stdout: string; stderr: string }) => void,
	) => {
		execFileCalls.push({ args, env: opts.env });
		cb(null, { stdout: '', stderr: '' });
	},
}));

// The GitHub client seams: `withGitHubToken` records the token in scope, and each
// operation returns a canned result. No real Octokit / network.
const {
	withGitHubToken,
	getGitHubUserForToken,
	findOpenPullRequest,
	createPullRequest,
	postIdempotentPullRequestComment,
} = vi.hoisted(() => ({
	withGitHubToken: vi.fn(<T>(_token: string, fn: () => Promise<T>) => fn()),
	getGitHubUserForToken: vi.fn<(token: string | null) => Promise<string | null>>(
		async () => 'operator-login',
	),
	findOpenPullRequest: vi.fn(async () => ({ number: 7, url: 'https://example.com/pr/7' })),
	createPullRequest: vi.fn(async () => ({ number: 8, url: 'https://example.com/pr/8' })),
	postIdempotentPullRequestComment: vi.fn(async () => 4242),
}));
vi.mock('@/integrations/scm/github/client.js', () => ({
	withGitHubToken,
	getGitHubUserForToken,
	findOpenPullRequest,
	createPullRequest,
	postIdempotentPullRequestComment,
}));

import { createOperatorDeliveryProvider } from '@/integrations/scm/github/operator-delivery.js';

const REPO = 'jkwiecien/swarm';
const TOKEN = 'operator-token-abc';

describe('createOperatorDeliveryProvider', () => {
	beforeEach(() => {
		execFileCalls.length = 0;
		withGitHubToken.mockClear();
		getGitHubUserForToken.mockClear();
		getGitHubUserForToken.mockResolvedValue('operator-login');
	});

	it('sets the commit identity from the operator login', async () => {
		const delivery = await createOperatorDeliveryProvider(REPO, TOKEN);
		expect(delivery.commitIdentity).toEqual({
			name: 'operator-login',
			email: 'operator-login@users.noreply.github.com',
		});
	});

	it('throws when the operator token resolves to no GitHub user', async () => {
		getGitHubUserForToken.mockResolvedValueOnce(null);
		await expect(createOperatorDeliveryProvider(REPO, TOKEN)).rejects.toThrow(
			/could not resolve github identity/i,
		);
	});

	it('runs findPullRequest / createPullRequest / postComment under the operator token', async () => {
		const delivery = await createOperatorDeliveryProvider(REPO, TOKEN);

		await delivery.findPullRequest('issue-1');
		await delivery.createPullRequest({
			baseBranch: 'main',
			branch: 'issue-1',
			title: 't',
			body: 'b',
		});
		await delivery.postComment({ prNumber: 7, body: 'hi', deliveryId: 'd1' });

		expect(findOpenPullRequest).toHaveBeenCalledWith('jkwiecien', 'swarm', 'issue-1');
		expect(createPullRequest).toHaveBeenCalledWith(
			'jkwiecien',
			'swarm',
			expect.objectContaining({ branch: 'issue-1' }),
		);
		expect(postIdempotentPullRequestComment).toHaveBeenCalledWith(
			'jkwiecien',
			'swarm',
			expect.objectContaining({ prNumber: 7, deliveryId: 'd1' }),
		);
		// Every scoped op ran inside `withGitHubToken(operatorToken, …)`.
		for (const call of withGitHubToken.mock.calls) {
			expect(call[0]).toBe(TOKEN);
		}
		expect(withGitHubToken).toHaveBeenCalledTimes(3);
	});

	it('pushes the branch with the operator token in the auth header', async () => {
		const delivery = await createOperatorDeliveryProvider(REPO, TOKEN);
		await delivery.pushBranch('/work/tree', 'issue-1', 'sha123');

		expect(execFileCalls).toHaveLength(1);
		const call = execFileCalls[0];
		expect(call.args).toContain('push');
		expect(call.args).toContain('sha123:refs/heads/issue-1');
		expect(call.args).toContain(`https://github.com/${REPO}.git`);
		const authorization = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
		expect(call.env.GIT_CONFIG_VALUE_0).toContain(authorization);
	});

	it('refuses submitReview — a reviewer verdict is a server-side write', async () => {
		const delivery = await createOperatorDeliveryProvider(REPO, TOKEN);
		expect(() =>
			delivery.submitReview({ prNumber: 7, verdict: 'approve', body: 'lgtm', deliveryId: 'd1' }),
		).toThrow(/submitReview is not available on a worker/i);
	});
});
