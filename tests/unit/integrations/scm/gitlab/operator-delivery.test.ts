import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const {
	withGitLabToken,
	getScopedGitLabUser,
	findOpenGitLabMergeRequest,
	createGitLabMergeRequest,
	postIdempotentGitLabMergeRequestNote,
} = vi.hoisted(() => ({
	withGitLabToken: vi.fn(<T>(_token: string, fn: () => Promise<T>) => fn()),
	getScopedGitLabUser: vi.fn<() => Promise<{ username: string | null; email: string | null }>>(
		async () => ({
			username: 'operator-login',
			email: 'op@example.com',
		}),
	),
	findOpenGitLabMergeRequest: vi.fn(async () => ({ number: 7, url: 'https://example.com/mr/7' })),
	createGitLabMergeRequest: vi.fn(async () => ({ number: 8, url: 'https://example.com/mr/8' })),
	postIdempotentGitLabMergeRequestNote: vi.fn(async () => 4242),
}));

vi.mock('@/integrations/scm/gitlab/client.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/integrations/scm/gitlab/client.js')>()),
	withGitLabToken,
	getScopedGitLabUser,
}));
vi.mock('@/integrations/scm/gitlab/merge-requests.js', () => ({
	findOpenGitLabMergeRequest,
}));
vi.mock('@/integrations/scm/gitlab/writes.js', () => ({
	createGitLabMergeRequest,
	postIdempotentGitLabMergeRequestNote,
}));

import { createGitLabOperatorDeliveryProvider } from '@/integrations/scm/gitlab/operator-delivery.js';

const REPO = 'SmartTechBrewery/swarm';
const CREDENTIAL = 'operator-token-abc';

describe('createGitLabOperatorDeliveryProvider', () => {
	beforeEach(() => {
		execFileCalls.length = 0;
		withGitLabToken.mockClear();
		getScopedGitLabUser.mockClear();
		getScopedGitLabUser.mockResolvedValue({ username: 'operator-login', email: 'op@example.com' });
	});

	it('sets the commit identity from the operator token', async () => {
		const delivery = await createGitLabOperatorDeliveryProvider(REPO, CREDENTIAL);
		expect(delivery.commitIdentity).toEqual({ name: 'operator-login', email: 'op@example.com' });
	});

	it('falls back to the noreply placeholder when the token exposes no email', async () => {
		getScopedGitLabUser.mockResolvedValue({ username: 'operator-login', email: null });

		const delivery = await createGitLabOperatorDeliveryProvider(REPO, CREDENTIAL);

		expect(delivery.commitIdentity.email).toBe('operator-login@users.noreply.gitlab.com');
	});

	it('throws when the operator token resolves to no GitLab identity', async () => {
		getScopedGitLabUser.mockResolvedValueOnce({ username: null, email: null });
		await expect(createGitLabOperatorDeliveryProvider(REPO, CREDENTIAL)).rejects.toThrow(
			/could not resolve gitlab identity/i,
		);
	});

	it('runs source delivery operations under the operator token', async () => {
		const delivery = await createGitLabOperatorDeliveryProvider(REPO, CREDENTIAL);

		await delivery.findPullRequest('issue-1');
		await delivery.createPullRequest({
			baseBranch: 'main',
			branch: 'issue-1',
			title: 't',
			body: 'b',
		});
		await delivery.postComment({ prNumber: 7, body: 'hi', deliveryId: 'd1' });

		expect(findOpenGitLabMergeRequest).toHaveBeenCalledWith(REPO, 'issue-1');
		expect(createGitLabMergeRequest).toHaveBeenCalledWith(
			REPO,
			expect.objectContaining({ branch: 'issue-1' }),
		);
		// The contract's `prNumber` is GitLab's `iid` for this provider.
		expect(postIdempotentGitLabMergeRequestNote).toHaveBeenCalledWith(REPO, {
			iid: 7,
			body: 'hi',
			deliveryId: 'd1',
		});
		for (const call of withGitLabToken.mock.calls) expect(call[0]).toBe(CREDENTIAL);
		expect(withGitLabToken).toHaveBeenCalledTimes(4);
	});

	it('pushes the expected commit with the token out of argv', async () => {
		const delivery = await createGitLabOperatorDeliveryProvider(REPO, CREDENTIAL);
		await delivery.pushBranch('/work/tree', 'issue-1', 'sha123');

		expect(execFileCalls).toHaveLength(1);
		const call = execFileCalls[0];
		expect(call.args).toEqual([
			'push',
			'--no-verify',
			'https://gitlab.com/SmartTechBrewery/swarm.git',
			'sha123:refs/heads/issue-1',
		]);
		expect(call.args.join(' ')).not.toContain(CREDENTIAL);
		// GitLab authenticates any token form as the reserved `oauth2` user.
		expect(call.env.GIT_CONFIG_VALUE_0).toBe(
			`AUTHORIZATION: basic ${Buffer.from(`oauth2:${CREDENTIAL}`).toString('base64')}`,
		);
	});

	it('refuses submitReview because a reviewer verdict is a server-side write', async () => {
		const delivery = await createGitLabOperatorDeliveryProvider(REPO, CREDENTIAL);
		expect(() =>
			delivery.submitReview({ prNumber: 7, verdict: 'approve', body: 'lgtm', deliveryId: 'd1' }),
		).toThrow(/submitReview is not available on a worker/i);
	});
});
