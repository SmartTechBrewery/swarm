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
	getAzureDevOpsPullRequestTitle: vi.fn(),
	getAzureDevOpsBranchHead: vi.fn(),
	getAzureDevOpsCommitChecks: vi.fn(),
	listAzureDevOpsPullRequestsForCommit: vi.fn(),
	listActiveAzureDevOpsPullRequestsForBase: vi.fn(),
}));
vi.mock('@/integrations/scm/azure-devops/personas.js', () => ({
	resolveAzureDevOpsPersonaIdentities: vi.fn(),
	isSwarmAzureDevOpsActor: vi.fn(),
	getAzureDevOpsPersonaForLogin: vi.fn(),
}));

import { withAzureDevOpsToken } from '@/integrations/scm/azure-devops/client.js';
import {
	getAzureDevOpsToken,
	getAzureDevOpsTokenOrNull,
} from '@/integrations/scm/azure-devops/credentials.js';
import {
	getAzureDevOpsPersonaForLogin,
	isSwarmAzureDevOpsActor,
	resolveAzureDevOpsPersonaIdentities,
} from '@/integrations/scm/azure-devops/personas.js';
import {
	getAzureDevOpsBranchHead,
	getAzureDevOpsCommitChecks,
	getAzureDevOpsPullRequest,
	getAzureDevOpsPullRequestTitle,
	listActiveAzureDevOpsPullRequestsForBase,
	listAzureDevOpsPullRequestsForCommit,
} from '@/integrations/scm/azure-devops/pull-requests.js';
import { AzureDevOpsSCMIntegration } from '@/integrations/scm/azure-devops/scm-integration.js';
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

	// Every contract method this phase leaves unbuilt must fail loudly and name its
	// follow-up phase — never return a misleading `null`/`[]`/no-op that a caller would
	// mistake for a real answer (issue #1089).
	describe('deferred contract methods', () => {
		const deferred: Array<[method: string, phase: string, call: () => unknown]> = [
			['commentOnPullRequest', 'phase 5/6', () => scm.commentOnPullRequest()],
			['deliveryProvider', 'phase 5/6', () => scm.deliveryProvider()],
			['operatorDeliveryProvider', 'phase 5/6', () => scm.operatorDeliveryProvider()],
			['mergePullRequest', 'phase 5/6', () => scm.mergePullRequest()],
			['updatePullRequestBranch', 'phase 5/6', () => scm.updatePullRequestBranch()],
		];

		for (const [method, phase, call] of deferred) {
			it(`${method} throws naming itself and ${phase}`, async () => {
				// Sync methods throw, async ones reject — assert on whichever happens.
				const thrown = await Promise.resolve()
					.then(call)
					.then(
						() => null,
						(err: unknown) => err,
					);

				expect(String(thrown)).toContain(`${method}() is not implemented yet`);
				expect(String(thrown)).toContain(phase);
				expect(String(thrown)).toContain('issue #1089');
			});
		}
	});
});
