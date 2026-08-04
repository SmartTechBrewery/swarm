import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProjectConfig, createMockScmEvent } from '../../../../helpers/factories.js';

// Capture git invocations without spawning a process. `promisify(execFile)` calls
// the mocked `execFile` with a node-style callback, so resolve it successfully.
const execFileCalls: Array<{ args: string[]; env: NodeJS.ProcessEnv; cwd: string }> = [];
vi.mock('node:child_process', () => ({
	execFile: (
		_cmd: string,
		args: string[],
		opts: { env: NodeJS.ProcessEnv; cwd: string },
		cb: (err: unknown, res: { stdout: string; stderr: string }) => void,
	) => {
		execFileCalls.push({ args, env: opts.env, cwd: opts.cwd });
		cb(null, { stdout: '', stderr: '' });
	},
}));

// Only the credential-scoping and identity seams are stubbed; `BitbucketApiError`
// and `bitbucketGitBasicCredential` stay real, so the merge classifier and the push
// auth header are exercised against the actual shapes.
vi.mock('@/integrations/scm/bitbucket/client.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/integrations/scm/bitbucket/client.js')>()),
	// Pass-through so a probe inside the scope can observe the credential that
	// would have been bound, without a real API call.
	withBitbucketCredential: vi.fn(
		(_credential: string, fn: () => Promise<unknown>): Promise<unknown> => fn(),
	),
	getBitbucketUserForCredential: vi.fn<(credential: string | null) => Promise<string | null>>(),
	getScopedBitbucketUserEmail: vi.fn<() => Promise<string | null>>(),
}));
vi.mock('@/integrations/scm/bitbucket/credentials.js', () => ({
	getBitbucketCredential: vi.fn<(project: unknown, persona: string) => Promise<string>>(),
	getBitbucketCredentialOrNull:
		vi.fn<(project: unknown, persona: string) => Promise<string | null>>(),
}));
vi.mock('@/integrations/scm/bitbucket/personas.js', () => ({
	resolveBitbucketPersonaIdentities: vi.fn(),
	isSwarmBitbucketActor: vi.fn(),
	getBitbucketPersonaForLogin: vi.fn(),
}));
vi.mock('@/integrations/scm/bitbucket/pull-requests.js', () => ({
	findOpenBitbucketPullRequest: vi.fn(),
	getBitbucketPullRequest: vi.fn(),
	getBitbucketPullRequestApprovals: vi.fn(),
	getBitbucketPullRequestMergeState: vi.fn(),
	getBitbucketPullRequestTitle: vi.fn(),
	getBitbucketCommitBuildStatus: vi.fn(),
	listOpenBitbucketPullRequestsForBase: vi.fn(),
}));
vi.mock('@/integrations/scm/bitbucket/writes.js', () => ({
	createBitbucketPullRequest: vi.fn(),
	mergeBitbucketPullRequestDirect: vi.fn(),
	postBitbucketPullRequestComment: vi.fn(),
	postIdempotentBitbucketPullRequestComment: vi.fn(),
	submitBitbucketReview: vi.fn(),
}));

import {
	BitbucketApiError,
	getBitbucketUserForCredential,
	getScopedBitbucketUserEmail,
	withBitbucketCredential,
} from '@/integrations/scm/bitbucket/client.js';
import {
	getBitbucketCredential,
	getBitbucketCredentialOrNull,
} from '@/integrations/scm/bitbucket/credentials.js';
import {
	getBitbucketPersonaForLogin,
	isSwarmBitbucketActor,
	resolveBitbucketPersonaIdentities,
} from '@/integrations/scm/bitbucket/personas.js';
import {
	findOpenBitbucketPullRequest,
	getBitbucketCommitBuildStatus,
	getBitbucketPullRequest,
	getBitbucketPullRequestApprovals,
	getBitbucketPullRequestMergeState,
	getBitbucketPullRequestTitle,
	listOpenBitbucketPullRequestsForBase,
} from '@/integrations/scm/bitbucket/pull-requests.js';
import { BitbucketSCMIntegration } from '@/integrations/scm/bitbucket/scm-integration.js';
import {
	createBitbucketPullRequest,
	mergeBitbucketPullRequestDirect,
	postBitbucketPullRequestComment,
	postIdempotentBitbucketPullRequestComment,
	submitBitbucketReview,
} from '@/integrations/scm/bitbucket/writes.js';
import { SWARM_GENERATED_FOOTER } from '@/scm/swarm-origin.js';
import type { PullRequestDetails, ScmPersonaIdentities } from '@/scm/types.js';

const project = createMockProjectConfig();
const IDENTITIES: ScmPersonaIdentities = { implementer: 'swarm-impl', reviewer: 'swarm-rev' };

describe('BitbucketSCMIntegration', () => {
	const scm = new BitbucketSCMIntegration();

	beforeEach(() => {
		vi.mocked(getBitbucketCredential).mockReset();
		vi.mocked(getBitbucketCredentialOrNull).mockReset();
		vi.mocked(withBitbucketCredential).mockClear();
	});

	it('declares itself as the bitbucket SCM provider', () => {
		expect(scm.type).toBe('bitbucket');
		expect(scm.category).toBe('scm');
	});

	describe('hasIntegration', () => {
		it('is an OR over the two persona credentials', async () => {
			vi.mocked(getBitbucketCredentialOrNull).mockImplementation(async (_p, persona) =>
				persona === 'reviewer' ? 'cred-rev' : null,
			);

			await expect(scm.hasIntegration(project)).resolves.toBe(true);
		});

		it('is false only when neither persona resolves', async () => {
			vi.mocked(getBitbucketCredentialOrNull).mockResolvedValue(null);

			await expect(scm.hasIntegration(project)).resolves.toBe(false);
		});
	});

	describe('hasPersonaToken', () => {
		it('reports per persona', async () => {
			vi.mocked(getBitbucketCredentialOrNull).mockImplementation(async (_p, persona) =>
				persona === 'implementer' ? 'cred-impl' : null,
			);

			await expect(scm.hasPersonaToken(project, 'implementer')).resolves.toBe(true);
			await expect(scm.hasPersonaToken(project, 'reviewer')).resolves.toBe(false);
		});
	});

	describe('withPersonaCredentials', () => {
		it('binds the requested persona’s own credential', async () => {
			vi.mocked(getBitbucketCredential).mockImplementation(async (_p, persona) =>
				persona === 'implementer' ? 'cred-impl' : 'cred-rev',
			);

			await scm.withPersonaCredentials(project, 'reviewer', async () => undefined);

			expect(vi.mocked(getBitbucketCredential)).toHaveBeenCalledWith(project, 'reviewer');
			expect(vi.mocked(withBitbucketCredential).mock.calls[0]?.[0]).toBe('cred-rev');
		});

		it('runs fn inside the scope and returns its value', async () => {
			vi.mocked(getBitbucketCredential).mockResolvedValue('cred-impl');

			await expect(
				scm.withPersonaCredentials(project, 'implementer', async () => 'done'),
			).resolves.toBe('done');
		});

		it('throws before running fn when the credential is missing', async () => {
			vi.mocked(getBitbucketCredential).mockRejectedValue(new Error('No Bitbucket implementer'));
			const fn = vi.fn(async () => 'never');

			await expect(scm.withPersonaCredentials(project, 'implementer', fn)).rejects.toThrow(
				/No Bitbucket implementer/,
			);
			expect(fn).not.toHaveBeenCalled();
		});
	});

	describe('persona identity + actor resolution', () => {
		it('delegates identity resolution to the cached resolver', async () => {
			vi.mocked(resolveBitbucketPersonaIdentities).mockResolvedValue(IDENTITIES);

			await expect(scm.resolvePersonaIdentities(project)).resolves.toEqual(IDENTITIES);
			expect(vi.mocked(resolveBitbucketPersonaIdentities)).toHaveBeenCalledWith(project);
		});

		it('delegates actor → persona mapping', () => {
			vi.mocked(getBitbucketPersonaForLogin).mockReturnValue('reviewer');

			expect(scm.personaForActor('swarm-rev', IDENTITIES)).toBe('reviewer');
			expect(vi.mocked(getBitbucketPersonaForLogin)).toHaveBeenCalledWith('swarm-rev', IDENTITIES);
		});

		it('delegates the SWARM-actor check', () => {
			vi.mocked(isSwarmBitbucketActor).mockReturnValue(true);

			expect(scm.isSwarmActor('swarm-impl', IDENTITIES)).toBe(true);
			expect(vi.mocked(isSwarmBitbucketActor)).toHaveBeenCalledWith('swarm-impl', IDENTITIES);
		});
	});

	// The four webhook-ingress methods delegate to `./webhook.ts`, whose own suite
	// covers the header names, every event-key mapping, and the signature framing.
	// These assert only that the contract methods are wired to it rather than still
	// throwing their phase-1 stub.
	describe('webhook ingress', () => {
		it('reads Bitbucket headers through the provider', () => {
			const headers: Record<string, string> = {
				'x-event-key': 'pullrequest:created',
				'x-request-uuid': 'req-1',
				'x-hub-signature': 'sha256=deadbeef',
			};
			expect(scm.readWebhookRequest((name) => headers[name.toLowerCase()])).toEqual({
				eventName: 'pullrequest:created',
				deliveryId: 'req-1',
				signature: 'sha256=deadbeef',
			});
		});

		it('verifies a correctly signed body and rejects a forged one', () => {
			const rawBody = '{"pullrequest":{"id":17}}';
			const secret = 'sh4red-s3cret';
			const valid = `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;

			expect(scm.verifyWebhookSignature(rawBody, valid, secret)).toBe(true);
			expect(scm.verifyWebhookSignature(rawBody, valid, 'other-secret')).toBe(false);
			expect(scm.verifyWebhookSignature(rawBody, '', secret)).toBe(false);
		});

		it('normalizes a supported event key and drops an unsupported one', () => {
			const payload = {
				repository: { full_name: 'jkwiecien/swarm' },
				pullrequest: { id: 17 },
			};
			expect(scm.parseWebhookEvent('pullrequest:created', payload)).toMatchObject({
				kind: 'pull-request',
				action: 'opened',
				workItemId: '17',
			});
			expect(scm.parseWebhookEvent('repo:push', payload)).toBeNull();
		});

		it('applies the comment-scoped SWARM-origin gate', async () => {
			const marked = createMockScmEvent({
				kind: 'work-item-comment',
				isCommentEvent: true,
				commentBody: `Done.\n\n${SWARM_GENERATED_FOOTER}`,
			});
			await expect(scm.isSwarmGeneratedEvent(marked, project)).resolves.toBe(true);

			const human = createMockScmEvent({
				kind: 'work-item-comment',
				isCommentEvent: true,
				commentBody: 'please rebase',
			});
			await expect(scm.isSwarmGeneratedEvent(human, project)).resolves.toBe(false);
		});
	});

	// The four read methods delegate to `./pull-requests.ts`, whose own suite covers
	// every endpoint path and field mapping. These assert the two things only the
	// class decides: that the repo coordinates come off `project.repo`, and that each
	// read runs under the same persona GitHub's adapter uses for it.
	describe('pull-request reads', () => {
		const PR_DETAILS: PullRequestDetails = {
			number: 17,
			headBranch: 'swarm/issue-17',
			headSha: 'd3022fc0ca3d',
			baseBranch: 'main',
			baseSha: 'ce5965ddd289',
			mergeable: null,
			authorLogin: 'human-dev',
		};

		beforeEach(() => {
			vi.mocked(getBitbucketCredential).mockImplementation(
				async (_p, persona) => `cred-${persona}`,
			);
		});

		it('reads a pull request as the reviewer by default', async () => {
			vi.mocked(getBitbucketPullRequest).mockResolvedValue(PR_DETAILS);

			await expect(scm.getPullRequest(project, 17)).resolves.toEqual(PR_DETAILS);
			expect(vi.mocked(getBitbucketPullRequest)).toHaveBeenCalledWith(
				'SmartTechBrewery',
				'swarm',
				17,
			);
			expect(vi.mocked(getBitbucketCredential)).toHaveBeenCalledWith(project, 'reviewer');
		});

		it('honours an explicitly requested persona', async () => {
			vi.mocked(getBitbucketPullRequest).mockResolvedValue(PR_DETAILS);

			await scm.getPullRequest(project, 17, 'implementer');

			expect(vi.mocked(getBitbucketCredential)).toHaveBeenCalledWith(project, 'implementer');
		});

		it('reads a title as the implementer — the PR’s own author', async () => {
			vi.mocked(getBitbucketPullRequestTitle).mockResolvedValue('Add a thing');

			await expect(scm.getPullRequestTitle(project, 17)).resolves.toBe('Add a thing');
			expect(vi.mocked(getBitbucketPullRequestTitle)).toHaveBeenCalledWith(
				'SmartTechBrewery',
				'swarm',
				17,
			);
			expect(vi.mocked(getBitbucketCredential)).toHaveBeenCalledWith(project, 'implementer');
		});

		it('aggregates build statuses as the reviewer', async () => {
			const aggregate = { totalCount: 0, checkRuns: [] };
			vi.mocked(getBitbucketCommitBuildStatus).mockResolvedValue(aggregate);

			await expect(scm.getAggregateCheckStatus(project, 'd3022fc0ca3d')).resolves.toBe(aggregate);
			expect(vi.mocked(getBitbucketCommitBuildStatus)).toHaveBeenCalledWith(
				'SmartTechBrewery',
				'swarm',
				'd3022fc0ca3d',
			);
			expect(vi.mocked(getBitbucketCredential)).toHaveBeenCalledWith(project, 'reviewer');
		});

		it('lists conflict candidates as the implementer, the persona that pushes the fix', async () => {
			vi.mocked(listOpenBitbucketPullRequestsForBase).mockResolvedValue([PR_DETAILS]);

			await expect(scm.listConflictCandidates(project, 'main')).resolves.toEqual([PR_DETAILS]);
			expect(vi.mocked(listOpenBitbucketPullRequestsForBase)).toHaveBeenCalledWith(
				'SmartTechBrewery',
				'swarm',
				'main',
			);
			expect(vi.mocked(getBitbucketCredential)).toHaveBeenCalledWith(project, 'implementer');
		});
	});

	describe('commentOnPullRequest', () => {
		beforeEach(() => {
			vi.mocked(getBitbucketCredential).mockImplementation(
				async (_p, persona) => `cred-${persona}`,
			);
			vi.mocked(postBitbucketPullRequestComment).mockResolvedValue(991);
		});

		it('comments as the implementer by default — the pull request’s own author', async () => {
			await expect(scm.commentOnPullRequest(project, 17, 'reclaimed mid-run')).resolves.toBe(991);
			expect(vi.mocked(postBitbucketPullRequestComment)).toHaveBeenCalledWith(
				'SmartTechBrewery',
				'swarm',
				17,
				'reclaimed mid-run',
			);
			expect(vi.mocked(getBitbucketCredential)).toHaveBeenCalledWith(project, 'implementer');
		});

		it('honours an explicitly requested persona', async () => {
			await scm.commentOnPullRequest(project, 17, 'note', 'reviewer');

			expect(vi.mocked(getBitbucketCredential)).toHaveBeenCalledWith(project, 'reviewer');
		});
	});

	// The merge capability is the one contract method that must never throw: every
	// refusal maps onto a terminal `MergePullRequestOutcome` so a completed Review
	// can't be retroactively failed (issue #253/#292).
	describe('mergePullRequest', () => {
		const APPROVED_SHA = 'd3022fc0ca3d';
		const FULL_SHA = 'd3022fc0ca3d65c7f6654eea129d6bf0cf0ee08e';

		function openAt(headSha: string) {
			return { merged: false, state: 'open', draft: false, headSha };
		}

		beforeEach(() => {
			vi.mocked(getBitbucketCredential).mockImplementation(
				async (_p, persona) => `cred-${persona}`,
			);
			vi.mocked(getBitbucketPullRequestMergeState).mockReset();
			vi.mocked(getBitbucketPullRequestApprovals).mockReset();
			vi.mocked(mergeBitbucketPullRequestDirect).mockReset();
			vi.mocked(getBitbucketPullRequestApprovals).mockResolvedValue([
				{ state: 'APPROVED', commitId: APPROVED_SHA },
			]);
		});

		it('merges as the implementer and reports the merge commit', async () => {
			vi.mocked(getBitbucketPullRequestMergeState).mockResolvedValue(openAt(APPROVED_SHA));
			vi.mocked(mergeBitbucketPullRequestDirect).mockResolvedValue({
				merged: true,
				message: 'pull request merged',
				sha: 'abcdef012345',
			});

			await expect(scm.mergePullRequest(project, 17, APPROVED_SHA)).resolves.toEqual({
				status: 'merged',
				message: 'pull request merged',
				sha: 'abcdef012345',
			});
			expect(vi.mocked(getBitbucketCredential)).toHaveBeenCalledWith(project, 'implementer');
		});

		it('reports an already-merged pull request as merged without attempting a merge', async () => {
			vi.mocked(getBitbucketPullRequestMergeState).mockResolvedValue({
				merged: true,
				state: 'closed',
				draft: false,
				headSha: APPROVED_SHA,
			});

			await expect(scm.mergePullRequest(project, 17, APPROVED_SHA)).resolves.toEqual({
				status: 'merged',
				message: 'pull request already merged',
			});
			expect(vi.mocked(mergeBitbucketPullRequestDirect)).not.toHaveBeenCalled();
		});

		it('treats a full SHA and its abbreviation as the same commit', async () => {
			vi.mocked(getBitbucketPullRequestMergeState).mockResolvedValue(openAt(APPROVED_SHA));
			vi.mocked(mergeBitbucketPullRequestDirect).mockResolvedValue({
				merged: true,
				message: 'pull request merged',
			});

			await expect(scm.mergePullRequest(project, 17, FULL_SHA)).resolves.toMatchObject({
				status: 'merged',
			});
		});

		it('refuses when the head moved since the reviewed commit', async () => {
			vi.mocked(getBitbucketPullRequestMergeState).mockResolvedValue(openAt('aaaaaaaaaaaa'));

			await expect(scm.mergePullRequest(project, 17, APPROVED_SHA)).resolves.toMatchObject({
				status: 'not-eligible',
				message: expect.stringContaining('head changed'),
			});
			expect(vi.mocked(mergeBitbucketPullRequestDirect)).not.toHaveBeenCalled();
		});

		it('refuses a truncated head it cannot pin to the reviewed commit', async () => {
			vi.mocked(getBitbucketPullRequestMergeState).mockResolvedValue(openAt('d3022f'));

			await expect(scm.mergePullRequest(project, 17, APPROVED_SHA)).resolves.toMatchObject({
				status: 'not-eligible',
			});
		});

		it('refuses a pull request converted back to a draft', async () => {
			vi.mocked(getBitbucketPullRequestMergeState).mockResolvedValue({
				...openAt(APPROVED_SHA),
				draft: true,
			});

			await expect(scm.mergePullRequest(project, 17, APPROVED_SHA)).resolves.toMatchObject({
				status: 'not-eligible',
				message: expect.stringContaining('draft'),
			});
		});

		it('refuses a declined pull request', async () => {
			vi.mocked(getBitbucketPullRequestMergeState).mockResolvedValue({
				...openAt(APPROVED_SHA),
				state: 'closed',
			});

			await expect(scm.mergePullRequest(project, 17, APPROVED_SHA)).resolves.toMatchObject({
				status: 'not-eligible',
				message: 'pull request is closed',
			});
		});

		it('refuses when a participant has since requested changes', async () => {
			vi.mocked(getBitbucketPullRequestMergeState).mockResolvedValue(openAt(APPROVED_SHA));
			vi.mocked(getBitbucketPullRequestApprovals).mockResolvedValue([
				{ state: 'APPROVED', commitId: APPROVED_SHA },
				{ state: 'CHANGES_REQUESTED', commitId: APPROVED_SHA },
			]);

			await expect(scm.mergePullRequest(project, 17, APPROVED_SHA)).resolves.toMatchObject({
				status: 'not-eligible',
				message: expect.stringContaining('changes have since been requested'),
			});
			expect(vi.mocked(mergeBitbucketPullRequestDirect)).not.toHaveBeenCalled();
		});

		it('refuses when the approval has been dismissed', async () => {
			vi.mocked(getBitbucketPullRequestMergeState).mockResolvedValue(openAt(APPROVED_SHA));
			vi.mocked(getBitbucketPullRequestApprovals).mockResolvedValue([]);

			await expect(scm.mergePullRequest(project, 17, APPROVED_SHA)).resolves.toMatchObject({
				status: 'not-eligible',
				message: expect.stringContaining('dismissed'),
			});
		});

		it('reports a non-merged 200 as not-ready rather than a silent success', async () => {
			vi.mocked(getBitbucketPullRequestMergeState).mockResolvedValue(openAt(APPROVED_SHA));
			vi.mocked(mergeBitbucketPullRequestDirect).mockResolvedValue({
				merged: false,
				message: 'still OPEN',
			});

			await expect(scm.mergePullRequest(project, 17, APPROVED_SHA)).resolves.toEqual({
				status: 'not-ready',
				message: 'still OPEN',
			});
		});

		const classifications: Array<[status: number, detail: string, expected: string]> = [
			[409, 'There are merge conflicts', 'not-ready'],
			[555, 'The merge took too long', 'not-ready'],
			[403, 'Branch restrictions forbid this merge', 'policy-blocked'],
			[400, 'One or more merge checks are not passing', 'policy-blocked'],
			[500, 'Internal server error', 'provider-error'],
			[401, 'Unauthorized', 'provider-error'],
		];

		for (const [status, detail, expected] of classifications) {
			it(`maps a ${status} merge refusal onto ${expected}`, async () => {
				vi.mocked(getBitbucketPullRequestMergeState).mockResolvedValue(openAt(APPROVED_SHA));
				vi.mocked(mergeBitbucketPullRequestDirect).mockRejectedValue(
					new BitbucketApiError(status, 'POST', '/pullrequests/17/merge', detail),
				);

				await expect(scm.mergePullRequest(project, 17, APPROVED_SHA)).resolves.toMatchObject({
					status: expected,
				});
			});
		}

		it('reports a failed state read as provider-error rather than throwing', async () => {
			vi.mocked(getBitbucketPullRequestMergeState).mockRejectedValue(
				new BitbucketApiError(404, 'GET', '/pullrequests/17', 'Not found'),
			);

			await expect(scm.mergePullRequest(project, 17, APPROVED_SHA)).resolves.toMatchObject({
				status: 'provider-error',
			});
		});

		it('reports a failed approvals read as provider-error rather than throwing', async () => {
			vi.mocked(getBitbucketPullRequestMergeState).mockResolvedValue(openAt(APPROVED_SHA));
			vi.mocked(getBitbucketPullRequestApprovals).mockRejectedValue(
				new BitbucketApiError(500, 'GET', '/pullrequests/17', 'boom'),
			);

			await expect(scm.mergePullRequest(project, 17, APPROVED_SHA)).resolves.toMatchObject({
				status: 'provider-error',
			});
		});

		it('reports a missing implementer credential as provider-error rather than throwing', async () => {
			vi.mocked(getBitbucketCredential).mockRejectedValue(
				new Error('No Bitbucket implementer credential configured'),
			);

			await expect(scm.mergePullRequest(project, 17, APPROVED_SHA)).resolves.toEqual({
				status: 'provider-error',
				message: 'No Bitbucket implementer credential configured',
			});
		});
	});

	describe('deliveryProvider', () => {
		beforeEach(() => {
			execFileCalls.length = 0;
			vi.mocked(getBitbucketCredential).mockImplementation(
				async (_p, persona) => `cred-${persona}`,
			);
			vi.mocked(getBitbucketUserForCredential).mockResolvedValue('swarm-impl');
			vi.mocked(getScopedBitbucketUserEmail).mockResolvedValue('impl@example.com');
		});

		it('signs commits with the account nickname and its confirmed email', async () => {
			const delivery = await scm.deliveryProvider(project, 'implementer');

			expect(delivery.commitIdentity).toEqual({
				name: 'swarm-impl',
				email: 'impl@example.com',
			});
		});

		it('falls back to the noreply placeholder when the emails endpoint is unavailable', async () => {
			vi.mocked(getScopedBitbucketUserEmail).mockResolvedValue(null);

			const delivery = await scm.deliveryProvider(project, 'implementer');

			expect(delivery.commitIdentity.email).toBe('swarm-impl@users.noreply.bitbucket.org');
		});

		it('throws when the credential resolves to no Bitbucket account', async () => {
			vi.mocked(getBitbucketUserForCredential).mockResolvedValue(null);

			await expect(scm.deliveryProvider(project, 'reviewer')).rejects.toThrow(
				/Could not resolve Bitbucket identity for reviewer persona/,
			);
		});

		it('runs every scoped operation under the requested persona’s credential', async () => {
			vi.mocked(findOpenBitbucketPullRequest).mockResolvedValue(undefined);
			vi.mocked(createBitbucketPullRequest).mockResolvedValue({
				number: 21,
				url: 'https://bitbucket.org/SmartTechBrewery/swarm/pull-requests/21',
			});
			vi.mocked(submitBitbucketReview).mockResolvedValue(55);
			vi.mocked(postIdempotentBitbucketPullRequestComment).mockResolvedValue(42);
			const delivery = await scm.deliveryProvider(project, 'reviewer');
			vi.mocked(withBitbucketCredential).mockClear();

			await delivery.findPullRequest('issue-457');
			await delivery.createPullRequest({
				baseBranch: 'main',
				branch: 'issue-457',
				title: 't',
				body: 'b',
			});
			await delivery.submitReview({
				prNumber: 21,
				verdict: 'approve',
				body: 'LGTM',
				deliveryId: 'd1',
			});
			await delivery.postComment({ prNumber: 21, body: 'note', deliveryId: 'd1' });

			expect(vi.mocked(findOpenBitbucketPullRequest)).toHaveBeenCalledWith(
				'SmartTechBrewery',
				'swarm',
				'issue-457',
			);
			expect(vi.mocked(createBitbucketPullRequest)).toHaveBeenCalledWith(
				'SmartTechBrewery',
				'swarm',
				expect.objectContaining({ branch: 'issue-457' }),
			);
			expect(vi.mocked(submitBitbucketReview)).toHaveBeenCalledWith(
				'SmartTechBrewery',
				'swarm',
				expect.objectContaining({ verdict: 'approve', deliveryId: 'd1' }),
			);
			expect(vi.mocked(postIdempotentBitbucketPullRequestComment)).toHaveBeenCalledWith(
				'SmartTechBrewery',
				'swarm',
				expect.objectContaining({ prNumber: 21, deliveryId: 'd1' }),
			);
			for (const call of vi.mocked(withBitbucketCredential).mock.calls) {
				expect(call[0]).toBe('cred-reviewer');
			}
			expect(vi.mocked(withBitbucketCredential)).toHaveBeenCalledTimes(4);
		});

		it('pushes the exact expected commit to Bitbucket with the credential out of argv', async () => {
			const delivery = await scm.deliveryProvider(project, 'implementer');

			await delivery.pushBranch('/worktree', 'issue-457', 'abc1234');

			expect(execFileCalls).toHaveLength(1);
			const call = execFileCalls[0];
			expect(call.cwd).toBe('/worktree');
			expect(call.args).toEqual([
				'push',
				'--no-verify',
				'https://bitbucket.org/SmartTechBrewery/swarm.git',
				'abc1234:refs/heads/issue-457',
			]);
			expect(call.env.GIT_CONFIG_COUNT).toBe('1');
			expect(call.env.GIT_CONFIG_KEY_0).toBe('http.https://bitbucket.org/.extraheader');
			// An access token authenticates as Bitbucket's reserved `x-token-auth` user.
			expect(call.env.GIT_CONFIG_VALUE_0).toBe(
				`AUTHORIZATION: basic ${Buffer.from('x-token-auth:cred-implementer').toString('base64')}`,
			);
			expect(call.args.join(' ')).not.toContain('cred-implementer');
		});

		it('sends an app password as the Basic pair it already is', async () => {
			vi.mocked(getBitbucketCredential).mockResolvedValue('swarm-bot:app-password-xyz');
			const delivery = await scm.deliveryProvider(project, 'implementer');

			await delivery.pushBranch('/worktree', 'issue-457', 'abc1234');

			expect(execFileCalls[0]?.env.GIT_CONFIG_VALUE_0).toBe(
				`AUTHORIZATION: basic ${Buffer.from('swarm-bot:app-password-xyz').toString('base64')}`,
			);
		});
	});
});
