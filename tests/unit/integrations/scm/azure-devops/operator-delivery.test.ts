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
	withAzureDevOpsToken,
	getScopedAzureDevOpsUser,
	findActiveAzureDevOpsPullRequest,
	createAzureDevOpsPullRequest,
	postIdempotentAzureDevOpsPullRequestThread,
	submitAzureDevOpsReview,
	readAzureDevOpsPullRequestContext,
} = vi.hoisted(() => ({
	withAzureDevOpsToken: vi.fn(<T>(_token: string, fn: () => Promise<T>) => fn()),
	getScopedAzureDevOpsUser:
		vi.fn<
			(organization: string) => Promise<{
				id: string;
				displayName: string | null;
				email: string | null;
			}>
		>(),
	findActiveAzureDevOpsPullRequest: vi.fn(async () => ({ number: 7, url: 'https://x/pr/7' })),
	createAzureDevOpsPullRequest: vi.fn(async () => ({ number: 8, url: 'https://x/pr/8' })),
	postIdempotentAzureDevOpsPullRequestThread: vi.fn(async () => 4242),
	submitAzureDevOpsReview: vi.fn(async () => 99),
	readAzureDevOpsPullRequestContext: vi.fn(async () => ({ number: 7 })),
}));

vi.mock('@/integrations/scm/azure-devops/client.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/integrations/scm/azure-devops/client.js')>()),
	withAzureDevOpsToken,
	getScopedAzureDevOpsUser,
}));
vi.mock('@/integrations/scm/azure-devops/pull-requests.js', () => ({
	findActiveAzureDevOpsPullRequest,
	readAzureDevOpsPullRequestContext,
}));
vi.mock('@/integrations/scm/azure-devops/writes.js', () => ({
	createAzureDevOpsPullRequest,
	postIdempotentAzureDevOpsPullRequestThread,
	submitAzureDevOpsReview,
}));

import {
	createAzureDevOpsDeliveryProvider,
	createAzureDevOpsOperatorDeliveryProvider,
} from '@/integrations/scm/azure-devops/operator-delivery.js';

const REPO = 'Fabrikam/Fiber Team/Web';
const CREDENTIAL = 'operator-pat-abc';
const OPERATOR = { id: 'guid-operator', displayName: 'Dana Operator', email: 'dana@example.com' };

describe('azure devops delivery providers', () => {
	beforeEach(() => {
		execFileCalls.length = 0;
		withAzureDevOpsToken.mockClear();
		submitAzureDevOpsReview.mockClear();
		getScopedAzureDevOpsUser.mockReset();
		getScopedAzureDevOpsUser.mockResolvedValue(OPERATOR);
	});

	it('commits as the PAT’s account, resolved in the repository’s organization', async () => {
		const delivery = await createAzureDevOpsOperatorDeliveryProvider(REPO, CREDENTIAL);

		expect(delivery.commitIdentity).toEqual({ name: 'Dana Operator', email: 'dana@example.com' });
		expect(getScopedAzureDevOpsUser).toHaveBeenCalledWith('Fabrikam');
	});

	it('falls back to the stated noreply placeholder when the account names no email', async () => {
		getScopedAzureDevOpsUser.mockResolvedValue({ id: 'guid-sp', displayName: null, email: null });

		const delivery = await createAzureDevOpsOperatorDeliveryProvider(REPO, CREDENTIAL);

		expect(delivery.commitIdentity).toEqual({
			name: 'guid-sp',
			email: 'guid-sp@users.noreply.azure-devops.invalid',
		});
	});

	it('runs source delivery operations under the operator PAT', async () => {
		const delivery = await createAzureDevOpsOperatorDeliveryProvider(REPO, CREDENTIAL);

		await delivery.findPullRequest('issue-1');
		await delivery.createPullRequest({
			baseBranch: 'main',
			branch: 'issue-1',
			title: 't',
			body: 'b',
		});
		await delivery.postComment({ prNumber: 7, body: 'hi', deliveryId: 'd1' });

		expect(findActiveAzureDevOpsPullRequest).toHaveBeenCalledWith(REPO, 'issue-1');
		expect(createAzureDevOpsPullRequest).toHaveBeenCalledWith(
			REPO,
			expect.objectContaining({ branch: 'issue-1' }),
		);
		expect(postIdempotentAzureDevOpsPullRequestThread).toHaveBeenCalledWith(REPO, {
			pullRequestId: 7,
			body: 'hi',
			deliveryId: 'd1',
		});
		for (const call of withAzureDevOpsToken.mock.calls) expect(call[0]).toBe(CREDENTIAL);
		expect(withAzureDevOpsToken).toHaveBeenCalledTimes(4);
	});

	it('pushes the expected commit with the PAT in a git config header, never in argv', async () => {
		const delivery = await createAzureDevOpsOperatorDeliveryProvider(REPO, CREDENTIAL);
		await delivery.pushBranch('/work/tree', 'issue-1', 'sha123');

		expect(execFileCalls).toHaveLength(1);
		const call = execFileCalls[0];
		expect(call.args).toEqual([
			'push',
			'--no-verify',
			'https://dev.azure.com/Fabrikam/Fiber%20Team/_git/Web',
			'sha123:refs/heads/issue-1',
		]);
		expect(call.args.join(' ')).not.toContain(CREDENTIAL);
		expect(call.env.GIT_CONFIG_COUNT).toBe('1');
		expect(call.env.GIT_CONFIG_KEY_0).toBe('http.https://dev.azure.com/.extraheader');
		// A PAT is basic auth with an empty username — the REST client's own form.
		expect(call.env.GIT_CONFIG_VALUE_0).toBe(
			`AUTHORIZATION: Basic ${Buffer.from(`:${CREDENTIAL}`).toString('base64')}`,
		);
	});

	it('refuses submitReview on a worker, because a verdict is a server-side write', async () => {
		const delivery = await createAzureDevOpsOperatorDeliveryProvider(REPO, CREDENTIAL);
		expect(() =>
			delivery.submitReview({ prNumber: 7, verdict: 'approve', body: 'lgtm', deliveryId: 'd1' }),
		).toThrow(/submitReview is not available on a worker/i);
		expect(submitAzureDevOpsReview).not.toHaveBeenCalled();
	});

	it('casts a per-persona verdict as the PAT’s own identity', async () => {
		const delivery = await createAzureDevOpsDeliveryProvider(REPO, 'reviewer-pat', {
			reviews: true,
		});

		await expect(
			delivery.submitReview({
				prNumber: 7,
				verdict: 'request-changes',
				body: 'fix it',
				deliveryId: 'd2',
			}),
		).resolves.toBe(99);
		expect(submitAzureDevOpsReview).toHaveBeenCalledWith(REPO, {
			pullRequestId: 7,
			verdict: 'request-changes',
			body: 'fix it',
			deliveryId: 'd2',
			reviewerId: 'guid-operator',
		});
		expect(withAzureDevOpsToken.mock.calls.at(-1)?.[0]).toBe('reviewer-pat');
	});

	// A read, so neither provider gates it on `reviews` (issue #1239).
	it.each([
		[
			'the operator provider',
			() => createAzureDevOpsOperatorDeliveryProvider(REPO, CREDENTIAL),
			CREDENTIAL,
		],
		[
			'a per-persona provider',
			() => createAzureDevOpsDeliveryProvider(REPO, 'reviewer-pat', { reviews: true }),
			'reviewer-pat',
		],
	])('reads the pull request context under %s’s PAT', async (_label, build, pat) => {
		const delivery = await build();
		await expect(delivery.readPullRequestContext(7)).resolves.toEqual({ number: 7 });
		expect(readAzureDevOpsPullRequestContext).toHaveBeenLastCalledWith(REPO, 7);
		expect(withAzureDevOpsToken.mock.calls.at(-1)?.[0]).toBe(pat);
	});
});
