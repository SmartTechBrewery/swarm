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
	withBitbucketCredential,
	getBitbucketUserForCredential,
	getScopedBitbucketUserEmail,
	findOpenBitbucketPullRequest,
	createBitbucketPullRequest,
	postIdempotentBitbucketPullRequestComment,
} = vi.hoisted(() => ({
	withBitbucketCredential: vi.fn(<T>(_credential: string, fn: () => Promise<T>) => fn()),
	getBitbucketUserForCredential: vi.fn<(credential: string | null) => Promise<string | null>>(
		async () => 'operator-login',
	),
	getScopedBitbucketUserEmail: vi.fn<() => Promise<string | null>>(async () => 'op@example.com'),
	findOpenBitbucketPullRequest: vi.fn(async () => ({ number: 7, url: 'https://example.com/pr/7' })),
	createBitbucketPullRequest: vi.fn(async () => ({ number: 8, url: 'https://example.com/pr/8' })),
	postIdempotentBitbucketPullRequestComment: vi.fn(async () => 4242),
}));

vi.mock('@/integrations/scm/bitbucket/client.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/integrations/scm/bitbucket/client.js')>()),
	withBitbucketCredential,
	getBitbucketUserForCredential,
	getScopedBitbucketUserEmail,
}));
vi.mock('@/integrations/scm/bitbucket/pull-requests.js', () => ({
	findOpenBitbucketPullRequest,
}));
vi.mock('@/integrations/scm/bitbucket/writes.js', () => ({
	createBitbucketPullRequest,
	postIdempotentBitbucketPullRequestComment,
}));

import { createBitbucketOperatorDeliveryProvider } from '@/integrations/scm/bitbucket/operator-delivery.js';

const REPO = 'SmartTechBrewery/swarm';
const CREDENTIAL = 'operator-token-abc';

describe('createBitbucketOperatorDeliveryProvider', () => {
	beforeEach(() => {
		execFileCalls.length = 0;
		withBitbucketCredential.mockClear();
		getBitbucketUserForCredential.mockClear();
		getScopedBitbucketUserEmail.mockClear();
		getBitbucketUserForCredential.mockResolvedValue('operator-login');
		getScopedBitbucketUserEmail.mockResolvedValue('op@example.com');
	});

	it('sets the commit identity from the operator credential', async () => {
		const delivery = await createBitbucketOperatorDeliveryProvider(REPO, CREDENTIAL);
		expect(delivery.commitIdentity).toEqual({ name: 'operator-login', email: 'op@example.com' });
	});

	it('throws when the operator credential resolves to no Bitbucket identity', async () => {
		getBitbucketUserForCredential.mockResolvedValueOnce(null);
		await expect(createBitbucketOperatorDeliveryProvider(REPO, CREDENTIAL)).rejects.toThrow(
			/could not resolve bitbucket identity/i,
		);
	});

	it('runs source delivery operations under the operator credential', async () => {
		const delivery = await createBitbucketOperatorDeliveryProvider(REPO, CREDENTIAL);

		await delivery.findPullRequest('issue-1');
		await delivery.createPullRequest({
			baseBranch: 'main',
			branch: 'issue-1',
			title: 't',
			body: 'b',
		});
		await delivery.postComment({ prNumber: 7, body: 'hi', deliveryId: 'd1' });

		expect(findOpenBitbucketPullRequest).toHaveBeenCalledWith(
			'SmartTechBrewery',
			'swarm',
			'issue-1',
		);
		expect(createBitbucketPullRequest).toHaveBeenCalledWith(
			'SmartTechBrewery',
			'swarm',
			expect.objectContaining({ branch: 'issue-1' }),
		);
		expect(postIdempotentBitbucketPullRequestComment).toHaveBeenCalledWith(
			'SmartTechBrewery',
			'swarm',
			expect.objectContaining({ prNumber: 7, deliveryId: 'd1' }),
		);
		for (const call of withBitbucketCredential.mock.calls) expect(call[0]).toBe(CREDENTIAL);
		expect(withBitbucketCredential).toHaveBeenCalledTimes(4);
	});

	it('pushes the expected commit with the credential out of argv', async () => {
		const delivery = await createBitbucketOperatorDeliveryProvider(REPO, CREDENTIAL);
		await delivery.pushBranch('/work/tree', 'issue-1', 'sha123');

		expect(execFileCalls).toHaveLength(1);
		const call = execFileCalls[0];
		expect(call.args).toEqual([
			'push',
			'--no-verify',
			'https://bitbucket.org/SmartTechBrewery/swarm.git',
			'sha123:refs/heads/issue-1',
		]);
		expect(call.args.join(' ')).not.toContain(CREDENTIAL);
		expect(call.env.GIT_CONFIG_VALUE_0).toBe(
			`AUTHORIZATION: basic ${Buffer.from(`x-token-auth:${CREDENTIAL}`).toString('base64')}`,
		);
	});

	it('refuses submitReview because a reviewer verdict is a server-side write', async () => {
		const delivery = await createBitbucketOperatorDeliveryProvider(REPO, CREDENTIAL);
		expect(() =>
			delivery.submitReview({ prNumber: 7, verdict: 'approve', body: 'lgtm', deliveryId: 'd1' }),
		).toThrow(/submitReview is not available on a worker/i);
	});
});
