import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	createMockAzureDevOpsPullRequestPayload,
	createMockProjectConfig,
	createMockScmEvent,
} from '../../../../helpers/factories.js';

vi.mock('@/integrations/scm/azure-devops/client.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/integrations/scm/azure-devops/client.js')>()),
	// Pass-through so a probe inside the scope can observe the token that would have
	// been bound, without a real API call.
	withAzureDevOpsToken: vi.fn((_pat: string, fn: () => Promise<unknown>): Promise<unknown> => fn()),
}));
vi.mock('@/integrations/scm/azure-devops/credentials.js', () => ({
	getAzureDevOpsToken: vi.fn<(project: unknown, persona: string) => Promise<string>>(),
	getAzureDevOpsTokenOrNull: vi.fn<(project: unknown, persona: string) => Promise<string | null>>(),
}));
// The reads' own suite (`pull-requests.test.ts`) proves every endpoint and mapping;
// here they are stubs, so these tests assert only the wiring and persona defaults.
vi.mock('@/integrations/scm/azure-devops/pull-requests.js', () => ({
	getAzureDevOpsPullRequest: vi.fn(),
	getAzureDevOpsPullRequestMergeState: vi.fn(),
	getAzureDevOpsPullRequestTitle: vi.fn(),
	getAzureDevOpsBranchHead: vi.fn(),
	getAzureDevOpsCommitChecks: vi.fn(),
	isAzureDevOpsBaseContainedInHead: vi.fn(),
	listAzureDevOpsPullRequestsForCommit: vi.fn(),
	listActiveAzureDevOpsPullRequestsForBase: vi.fn(),
}));
// The writes' and delivery builders' own suites prove their requests; here they are
// stubs, so the merge recheck, completion poll and classification are what is tested.
vi.mock('@/integrations/scm/azure-devops/writes.js', () => ({
	completeAzureDevOpsPullRequest: vi.fn(),
	postAzureDevOpsPullRequestThread: vi.fn(),
}));
vi.mock('@/integrations/scm/azure-devops/operator-delivery.js', () => ({
	createAzureDevOpsDeliveryProvider: vi.fn(),
	createAzureDevOpsOperatorDeliveryProvider: vi.fn(),
}));
// The completion poll waits between reads; the tests count reads, not seconds.
vi.mock('node:timers/promises', () => ({ setTimeout: vi.fn(async () => undefined) }));
vi.mock('@/integrations/scm/azure-devops/personas.js', () => ({
	resolveAzureDevOpsPersonaIdentities: vi.fn(),
	isSwarmAzureDevOpsActor: vi.fn(),
	getAzureDevOpsPersonaForLogin: vi.fn(),
}));

import {
	AzureDevOpsApiError,
	withAzureDevOpsToken,
} from '@/integrations/scm/azure-devops/client.js';
import {
	getAzureDevOpsToken,
	getAzureDevOpsTokenOrNull,
} from '@/integrations/scm/azure-devops/credentials.js';
import {
	createAzureDevOpsDeliveryProvider,
	createAzureDevOpsOperatorDeliveryProvider,
} from '@/integrations/scm/azure-devops/operator-delivery.js';
import {
	getAzureDevOpsPersonaForLogin,
	isSwarmAzureDevOpsActor,
	resolveAzureDevOpsPersonaIdentities,
} from '@/integrations/scm/azure-devops/personas.js';
import {
	getAzureDevOpsBranchHead,
	getAzureDevOpsCommitChecks,
	getAzureDevOpsPullRequest,
	getAzureDevOpsPullRequestMergeState,
	getAzureDevOpsPullRequestTitle,
	isAzureDevOpsBaseContainedInHead,
	listActiveAzureDevOpsPullRequestsForBase,
	listAzureDevOpsPullRequestsForCommit,
} from '@/integrations/scm/azure-devops/pull-requests.js';
import {
	AzureDevOpsSCMIntegration,
	MERGE_COMPLETION_POLL,
} from '@/integrations/scm/azure-devops/scm-integration.js';
import {
	completeAzureDevOpsPullRequest,
	postAzureDevOpsPullRequestThread,
} from '@/integrations/scm/azure-devops/writes.js';
import { SWARM_GENERATED_FOOTER } from '@/scm/swarm-origin.js';
import type { ScmPersonaIdentities } from '@/scm/types.js';

const project = createMockProjectConfig({ scm: 'azure-devops', repo: 'fabrikam/proj/web' });
const IDENTITIES: ScmPersonaIdentities = { implementer: 'guid-impl', reviewer: 'guid-rev' };

describe('AzureDevOpsSCMIntegration', () => {
	const scm = new AzureDevOpsSCMIntegration();

	beforeEach(() => {
		vi.mocked(getAzureDevOpsToken).mockReset();
		vi.mocked(getAzureDevOpsTokenOrNull).mockReset();
		vi.mocked(withAzureDevOpsToken).mockClear();
	});

	it('declares itself as the azure-devops SCM provider', () => {
		expect(scm.type).toBe('azure-devops');
		expect(scm.category).toBe('scm');
	});

	describe('hasIntegration', () => {
		it('is an OR over the two persona tokens', async () => {
			vi.mocked(getAzureDevOpsTokenOrNull).mockImplementation(async (_p, persona) =>
				persona === 'reviewer' ? 'pat-rev' : null,
			);

			await expect(scm.hasIntegration(project)).resolves.toBe(true);
		});

		it('is false only when neither persona resolves', async () => {
			vi.mocked(getAzureDevOpsTokenOrNull).mockResolvedValue(null);

			await expect(scm.hasIntegration(project)).resolves.toBe(false);
		});
	});

	describe('hasPersonaToken', () => {
		it('reports per persona', async () => {
			vi.mocked(getAzureDevOpsTokenOrNull).mockImplementation(async (_p, persona) =>
				persona === 'implementer' ? 'pat-impl' : null,
			);

			await expect(scm.hasPersonaToken(project, 'implementer')).resolves.toBe(true);
			await expect(scm.hasPersonaToken(project, 'reviewer')).resolves.toBe(false);
		});
	});

	describe('withPersonaCredentials', () => {
		it('binds the requested persona’s own token', async () => {
			vi.mocked(getAzureDevOpsToken).mockImplementation(async (_p, persona) =>
				persona === 'implementer' ? 'pat-impl' : 'pat-rev',
			);

			await scm.withPersonaCredentials(project, 'reviewer', async () => undefined);

			expect(vi.mocked(getAzureDevOpsToken)).toHaveBeenCalledWith(project, 'reviewer');
			expect(vi.mocked(withAzureDevOpsToken).mock.calls[0]?.[0]).toBe('pat-rev');
		});

		it('runs fn inside the scope and returns its value', async () => {
			vi.mocked(getAzureDevOpsToken).mockResolvedValue('pat-impl');

			await expect(
				scm.withPersonaCredentials(project, 'implementer', async () => 'done'),
			).resolves.toBe('done');
		});

		it('throws before running fn when the token is missing', async () => {
			vi.mocked(getAzureDevOpsToken).mockRejectedValue(
				new Error('No Azure DevOps implementer token'),
			);
			const fn = vi.fn(async () => 'never');

			await expect(scm.withPersonaCredentials(project, 'implementer', fn)).rejects.toThrow(
				/No Azure DevOps implementer token/,
			);
			expect(fn).not.toHaveBeenCalled();
		});
	});

	describe('persona identity + actor resolution', () => {
		it('delegates identity resolution to the cached resolver', async () => {
			vi.mocked(resolveAzureDevOpsPersonaIdentities).mockResolvedValue(IDENTITIES);

			await expect(scm.resolvePersonaIdentities(project)).resolves.toEqual(IDENTITIES);
			expect(vi.mocked(resolveAzureDevOpsPersonaIdentities)).toHaveBeenCalledWith(project);
		});

		it('delegates actor → persona mapping', () => {
			vi.mocked(getAzureDevOpsPersonaForLogin).mockReturnValue('reviewer');

			expect(scm.personaForActor('guid-rev', IDENTITIES)).toBe('reviewer');
			expect(vi.mocked(getAzureDevOpsPersonaForLogin)).toHaveBeenCalledWith('guid-rev', IDENTITIES);
		});

		it('delegates the SWARM-actor check', () => {
			vi.mocked(isSwarmAzureDevOpsActor).mockReturnValue(true);

			expect(scm.isSwarmActor('guid-impl', IDENTITIES)).toBe(true);
			expect(vi.mocked(isSwarmAzureDevOpsActor)).toHaveBeenCalledWith('guid-impl', IDENTITIES);
		});
	});

	// The four webhook-ingress methods delegate to `./webhook.ts`, whose own suite
	// covers the body fields, every event mapping, and the Basic-auth comparison. These
	// assert only that the contract methods are wired to it rather than still throwing
	// their phase-2 stub.
	describe('webhook ingress', () => {
		it('reads the event and delivery from the body and the credential from the header', () => {
			const payload = createMockAzureDevOpsPullRequestPayload({ id: 'event-guid' });
			const headers: Record<string, string> = { authorization: 'Basic abc=' };
			expect(scm.readWebhookRequest((name) => headers[name.toLowerCase()], payload)).toEqual({
				eventName: 'git.pullrequest.created',
				deliveryId: 'event-guid',
				signature: 'Basic abc=',
			});
		});

		it('accepts the configured Basic password and rejects anything else', () => {
			const credential = (password: string) =>
				`Basic ${Buffer.from(`swarm:${password}`).toString('base64')}`;
			expect(scm.verifyWebhookSignature('{}', credential('s3cret'), 's3cret')).toBe(true);
			expect(scm.verifyWebhookSignature('{}', credential('other'), 's3cret')).toBe(false);
			expect(scm.verifyWebhookSignature('{}', '', 's3cret')).toBe(false);
		});

		it('normalizes a supported event and drops an unsupported one', () => {
			const payload = createMockAzureDevOpsPullRequestPayload();
			expect(scm.parseWebhookEvent('git.pullrequest.created', payload)).toMatchObject({
				kind: 'pull-request',
				action: 'opened',
				workItemId: '17',
			});
			expect(scm.parseWebhookEvent('git.push', { ...payload, eventType: 'git.push' })).toBeNull();
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

	describe('pull-request and CI reads', () => {
		/** The persona whose token each read was scoped to, via the bound PAT. */
		const boundPersona = () => vi.mocked(withAzureDevOpsToken).mock.calls[0]?.[0];

		beforeEach(() => {
			vi.mocked(getAzureDevOpsToken).mockImplementation(async (_p, persona) => `pat-${persona}`);
		});

		const reads: Array<
			[
				method: string,
				persona: string,
				call: () => Promise<unknown>,
				read: (...args: never[]) => unknown,
				args: unknown[],
			]
		> = [
			[
				'getPullRequest',
				'reviewer',
				() => scm.getPullRequest(project, 17),
				getAzureDevOpsPullRequest,
				[project.repo, 17],
			],
			[
				'getPullRequestTitle',
				'implementer',
				() => scm.getPullRequestTitle(project, 17),
				getAzureDevOpsPullRequestTitle,
				[project.repo, 17],
			],
			[
				'getBranchHead',
				'implementer',
				() => scm.getBranchHead(project, 'main'),
				getAzureDevOpsBranchHead,
				[project.repo, 'main'],
			],
			[
				'getAggregateCheckStatus',
				'reviewer',
				() => scm.getAggregateCheckStatus(project, 'abc123'),
				getAzureDevOpsCommitChecks,
				[project.repo, 'abc123'],
			],
			[
				'listPullRequestsForCommit',
				'reviewer',
				() => scm.listPullRequestsForCommit(project, 'abc123'),
				listAzureDevOpsPullRequestsForCommit,
				[project.repo, 'abc123'],
			],
			[
				'listConflictCandidates',
				'implementer',
				() => scm.listConflictCandidates(project, 'main'),
				listActiveAzureDevOpsPullRequestsForBase,
				[project.repo, 'main'],
			],
		];

		for (const [method, persona, call, read, args] of reads) {
			it(`${method} reads as the ${persona} by default`, async () => {
				vi.mocked(read).mockResolvedValue('answer' as never);

				await expect(call()).resolves.toBe('answer');
				expect(vi.mocked(read)).toHaveBeenCalledWith(...args);
				expect(boundPersona()).toBe(`pat-${persona}`);
			});
		}

		it('honours an explicit persona', async () => {
			vi.mocked(getAzureDevOpsPullRequest).mockResolvedValue({} as never);

			await scm.getPullRequest(project, 17, 'implementer');

			expect(boundPersona()).toBe('pat-implementer');
		});

		it('builds the pull request’s web URL with no credential, encoding every segment', () => {
			expect(scm.pullRequestUrl('Fabrikam/Fiber Team/Web', 17)).toBe(
				'https://dev.azure.com/Fabrikam/Fiber%20Team/_git/Web/pullrequest/17',
			);
			expect(vi.mocked(getAzureDevOpsToken)).not.toHaveBeenCalled();
			expect(() => scm.pullRequestUrl('fabrikam/web', 17)).toThrow(
				/organization\/project\/repository/,
			);
		});
	});

	describe('commentOnPullRequest', () => {
		it('posts a thread as the implementer by default and returns its id', async () => {
			vi.mocked(getAzureDevOpsToken).mockImplementation(async (_p, persona) => `pat-${persona}`);
			vi.mocked(postAzureDevOpsPullRequestThread).mockResolvedValue(55);

			await expect(scm.commentOnPullRequest(project, 17, 'hello')).resolves.toBe(55);
			expect(postAzureDevOpsPullRequestThread).toHaveBeenCalledWith(
				'fabrikam/proj/web',
				17,
				'hello',
			);
			expect(vi.mocked(withAzureDevOpsToken).mock.calls[0]?.[0]).toBe('pat-implementer');
		});
	});

	describe('delivery providers', () => {
		it('builds the per-persona provider over that persona’s own PAT, with reviews', async () => {
			vi.mocked(getAzureDevOpsToken).mockResolvedValue('pat-rev');
			const delivery = {} as never;
			vi.mocked(createAzureDevOpsDeliveryProvider).mockResolvedValue(delivery);

			await expect(scm.deliveryProvider(project, 'reviewer')).resolves.toBe(delivery);
			expect(getAzureDevOpsToken).toHaveBeenCalledWith(project, 'reviewer');
			expect(createAzureDevOpsDeliveryProvider).toHaveBeenCalledWith(
				'fabrikam/proj/web',
				'pat-rev',
				{
					reviews: true,
				},
			);
		});

		it('builds the operator provider from the worker’s own credential', async () => {
			const delivery = {} as never;
			vi.mocked(createAzureDevOpsOperatorDeliveryProvider).mockResolvedValue(delivery);

			await expect(scm.operatorDeliveryProvider('fabrikam/proj/web', 'op-pat')).resolves.toBe(
				delivery,
			);
			expect(createAzureDevOpsOperatorDeliveryProvider).toHaveBeenCalledWith(
				'fabrikam/proj/web',
				'op-pat',
			);
			expect(getAzureDevOpsToken).not.toHaveBeenCalled();
		});
	});

	describe('mergePullRequest', () => {
		const APPROVED = 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7';
		const MERGE_COMMIT = 'feedfacefeedfacefeedfacefeedfacefeedface';

		type MergeState = Awaited<ReturnType<typeof getAzureDevOpsPullRequestMergeState>>;
		const state = (overrides: Partial<MergeState> = {}): MergeState => ({
			merged: false,
			state: 'open',
			draft: false,
			headSha: APPROVED,
			reviewers: [{ id: IDENTITIES.reviewer, vote: 10, isRequired: false }],
			mergeStatus: 'succeeded',
			mergeCommitSha: null,
			baseBranch: 'main',
			...overrides,
		});
		const merge = () => scm.mergePullRequest(project, 17, APPROVED);

		beforeEach(() => {
			vi.mocked(getAzureDevOpsToken).mockImplementation(async (_p, persona) => `pat-${persona}`);
			vi.mocked(resolveAzureDevOpsPersonaIdentities).mockResolvedValue(IDENTITIES);
			vi.mocked(getAzureDevOpsPullRequestMergeState).mockReset();
			vi.mocked(completeAzureDevOpsPullRequest).mockReset();
			vi.mocked(completeAzureDevOpsPullRequest).mockResolvedValue(undefined);
			vi.mocked(isAzureDevOpsBaseContainedInHead).mockReset();
			vi.mocked(isAzureDevOpsBaseContainedInHead).mockResolvedValue(true);
		});

		it('reports an already-completed pull request as merged without completing again', async () => {
			vi.mocked(getAzureDevOpsPullRequestMergeState).mockResolvedValue(
				state({ merged: true, state: 'closed', mergeCommitSha: MERGE_COMMIT }),
			);

			await expect(merge()).resolves.toEqual({
				status: 'merged',
				message: 'pull request already completed',
				sha: MERGE_COMMIT,
			});
			expect(completeAzureDevOpsPullRequest).not.toHaveBeenCalled();
		});

		it.each([
			['the head moved', { headSha: 'abc' }, /head changed since the reviewed commit/],
			['it is a draft again', { draft: true }, /draft/],
			['it was abandoned', { state: 'closed' as const }, /abandoned/],
			[
				'the reviewer persona’s vote no longer approves',
				{ reviewers: [{ id: IDENTITIES.reviewer, vote: -5, isRequired: false }] },
				/vote no longer approves/,
			],
			['the reviewer persona never voted', { reviewers: [] }, /vote no longer approves/],
			[
				'another reviewer rejected it',
				{
					reviewers: [
						{ id: IDENTITIES.reviewer, vote: 10, isRequired: false },
						{ id: 'guid-human', vote: -10, isRequired: false },
					],
				},
				/rejected/,
			],
		])('is not-eligible when %s', async (_case, overrides, message) => {
			vi.mocked(getAzureDevOpsPullRequestMergeState).mockResolvedValue(state(overrides));

			const outcome = await merge();

			expect(outcome.status).toBe('not-eligible');
			expect(outcome.message).toMatch(message);
			expect(completeAzureDevOpsPullRequest).not.toHaveBeenCalled();
			// An ineligible head never spends the commit-graph read (issue #1116).
			expect(isAzureDevOpsBaseContainedInHead).not.toHaveBeenCalled();
		});

		it('accepts "approved with suggestions" and an upper-cased identity', async () => {
			vi.mocked(getAzureDevOpsPullRequestMergeState)
				.mockResolvedValueOnce(
					state({
						reviewers: [{ id: IDENTITIES.reviewer.toUpperCase(), vote: 5, isRequired: false }],
					}),
				)
				.mockResolvedValueOnce(
					state({ merged: true, state: 'closed', mergeCommitSha: MERGE_COMMIT }),
				);

			await expect(merge()).resolves.toMatchObject({ status: 'merged', sha: MERGE_COMMIT });
		});

		it('is not-ready while Azure reports merge conflicts', async () => {
			vi.mocked(getAzureDevOpsPullRequestMergeState).mockResolvedValue(
				state({ mergeStatus: 'conflicts' }),
			);

			await expect(merge()).resolves.toMatchObject({ status: 'not-ready' });
			expect(completeAzureDevOpsPullRequest).not.toHaveBeenCalled();
		});

		it('completes as the implementer pinned to the approved head, then polls for the result', async () => {
			vi.mocked(getAzureDevOpsPullRequestMergeState)
				.mockResolvedValueOnce(state())
				.mockResolvedValueOnce(state({ mergeStatus: 'queued' }))
				.mockResolvedValueOnce(
					state({ merged: true, state: 'closed', mergeCommitSha: MERGE_COMMIT }),
				);

			await expect(merge()).resolves.toEqual({
				status: 'merged',
				message: 'pull request completed',
				sha: MERGE_COMMIT,
			});
			expect(completeAzureDevOpsPullRequest).toHaveBeenCalledWith(
				'fabrikam/proj/web',
				17,
				APPROVED,
			);
			expect(vi.mocked(withAzureDevOpsToken).mock.calls[0]?.[0]).toBe('pat-implementer');
		});

		it('is not-ready when the completion is still running after the bounded poll', async () => {
			vi.mocked(getAzureDevOpsPullRequestMergeState).mockResolvedValue(state());

			await expect(merge()).resolves.toMatchObject({
				status: 'not-ready',
				message: expect.stringMatching(/has not finished merging yet/),
			});
			// One recheck plus every poll attempt — and no more.
			expect(getAzureDevOpsPullRequestMergeState).toHaveBeenCalledTimes(
				1 + MERGE_COMPLETION_POLL.attempts,
			);
		});

		it.each([
			['a policy rejection', { mergeStatus: 'rejectedByPolicy' }, 'policy-blocked'],
			['an abandonment', { state: 'closed' as const }, 'not-eligible'],
			['a conflict', { mergeStatus: 'conflicts' }, 'not-ready'],
		])('reports %s seen while polling', async (_case, overrides, status) => {
			vi.mocked(getAzureDevOpsPullRequestMergeState)
				.mockResolvedValueOnce(state())
				.mockResolvedValueOnce(state(overrides));

			await expect(merge()).resolves.toMatchObject({ status });
		});

		it('is not-ready when a poll read fails after the completion was accepted', async () => {
			vi.mocked(getAzureDevOpsPullRequestMergeState)
				.mockResolvedValueOnce(state())
				.mockRejectedValueOnce(new Error('socket hang up'));

			await expect(merge()).resolves.toMatchObject({ status: 'not-ready' });
		});

		it.each([
			[409, 'TF401179: conflict', 'not-eligible'],
			[400, 'lastMergeSourceCommit does not match the source branch', 'not-eligible'],
			[
				400,
				'TF401028: The pull request cannot be completed because of a policy (PolicyViolation)',
				'policy-blocked',
			],
			[403, 'TF401027: You need the Git ContributeToPullRequest permission', 'policy-blocked'],
			[400, 'Invalid argument', 'provider-error'],
			[500, 'Internal error', 'provider-error'],
		])('classifies a %s completion refusal (%s) as %s', async (status, detail, outcome) => {
			vi.mocked(getAzureDevOpsPullRequestMergeState).mockResolvedValue(state());
			vi.mocked(completeAzureDevOpsPullRequest).mockRejectedValue(
				new AzureDevOpsApiError(status, 'PATCH', '/x', detail),
			);

			await expect(merge()).resolves.toMatchObject({ status: outcome });
		});

		// Issue #1116: Azure's pull request reports no "behind its target" count, so
		// the commit graph decides — after every eligibility check.
		describe('base freshness', () => {
			it('completes a head that contains its target branch, asking the graph about the current target', async () => {
				vi.mocked(getAzureDevOpsPullRequestMergeState)
					.mockResolvedValueOnce(state({ baseBranch: 'release/1.0' }))
					.mockResolvedValueOnce(
						state({ merged: true, state: 'closed', mergeCommitSha: MERGE_COMMIT }),
					);

				await expect(merge()).resolves.toMatchObject({ status: 'merged' });
				expect(isAzureDevOpsBaseContainedInHead).toHaveBeenCalledWith(
					'fabrikam/proj/web',
					'release/1.0',
					APPROVED,
				);
			});

			it('answers stale-base for a head missing target commits, without completing', async () => {
				vi.mocked(getAzureDevOpsPullRequestMergeState).mockResolvedValue(state());
				vi.mocked(isAzureDevOpsBaseContainedInHead).mockResolvedValue(false);

				await expect(merge()).resolves.toMatchObject({
					status: 'stale-base',
					message: expect.stringContaining('behind its target branch'),
				});
				expect(completeAzureDevOpsPullRequest).not.toHaveBeenCalled();
			});

			it('reports a failed graph read as provider-error, never as up to date', async () => {
				vi.mocked(getAzureDevOpsPullRequestMergeState).mockResolvedValue(state());
				vi.mocked(isAzureDevOpsBaseContainedInHead).mockRejectedValue(
					new AzureDevOpsApiError(500, 'GET', '/diffs/commits', 'boom'),
				);

				await expect(merge()).resolves.toMatchObject({ status: 'provider-error' });
				expect(completeAzureDevOpsPullRequest).not.toHaveBeenCalled();
			});

			it('never spends the graph read while Azure reports merge conflicts', async () => {
				vi.mocked(getAzureDevOpsPullRequestMergeState).mockResolvedValue(
					state({ mergeStatus: 'conflicts' }),
				);

				await expect(merge()).resolves.toMatchObject({ status: 'not-ready' });
				expect(isAzureDevOpsBaseContainedInHead).not.toHaveBeenCalled();
			});
		});

		it('is a provider-error, never a throw, when the recheck read fails', async () => {
			vi.mocked(getAzureDevOpsPullRequestMergeState).mockRejectedValue(new Error('boom'));

			await expect(merge()).resolves.toEqual({ status: 'provider-error', message: 'boom' });
		});

		it('is a provider-error, never a throw, when persona identities do not resolve', async () => {
			vi.mocked(resolveAzureDevOpsPersonaIdentities).mockRejectedValue(
				new Error('Failed to resolve Azure DevOps identity for reviewer token'),
			);

			await expect(merge()).resolves.toMatchObject({ status: 'provider-error' });
			expect(getAzureDevOpsPullRequestMergeState).not.toHaveBeenCalled();
		});
	});

	describe('updatePullRequestBranch', () => {
		it('is a declared unsupported, touching no credential', async () => {
			await expect(scm.updatePullRequestBranch(project, 17, 'abc')).resolves.toMatchObject({
				status: 'unsupported',
			});
			expect(getAzureDevOpsToken).not.toHaveBeenCalled();
		});
	});
});
