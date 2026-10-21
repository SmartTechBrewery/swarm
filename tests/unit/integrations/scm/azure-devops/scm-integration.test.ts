import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProjectConfig } from '../../../../helpers/factories.js';

vi.mock('@/integrations/scm/azure-devops/client.js', () => ({
	// Pass-through so a probe inside the scope can observe the token that would have
	// been bound, without a real API call.
	withAzureDevOpsToken: vi.fn((_pat: string, fn: () => Promise<unknown>): Promise<unknown> => fn()),
}));
vi.mock('@/integrations/scm/azure-devops/credentials.js', () => ({
	getAzureDevOpsToken: vi.fn<(project: unknown, persona: string) => Promise<string>>(),
	getAzureDevOpsTokenOrNull: vi.fn<(project: unknown, persona: string) => Promise<string | null>>(),
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
import { AzureDevOpsSCMIntegration } from '@/integrations/scm/azure-devops/scm-integration.js';
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

	// Every contract method this phase leaves unbuilt must fail loudly and name its
	// follow-up phase — never return a misleading `null`/`[]`/no-op that a caller would
	// mistake for a real answer (issue #1089).
	describe('deferred contract methods', () => {
		const deferred: Array<[method: string, phase: string, call: () => unknown]> = [
			['verifyWebhookSignature', 'phase 3/6', () => scm.verifyWebhookSignature()],
			['readWebhookRequest', 'phase 3/6', () => scm.readWebhookRequest()],
			['parseWebhookEvent', 'phase 3/6', () => scm.parseWebhookEvent()],
			['isSwarmGeneratedEvent', 'phase 3/6', () => scm.isSwarmGeneratedEvent()],
			['getPullRequest', 'phase 4/6', () => scm.getPullRequest()],
			['getPullRequestTitle', 'phase 4/6', () => scm.getPullRequestTitle()],
			['pullRequestUrl', 'phase 4/6', () => scm.pullRequestUrl()],
			['getBranchHead', 'phase 4/6', () => scm.getBranchHead()],
			['getAggregateCheckStatus', 'phase 4/6', () => scm.getAggregateCheckStatus()],
			['listPullRequestsForCommit', 'phase 4/6', () => scm.listPullRequestsForCommit()],
			['listConflictCandidates', 'phase 4/6', () => scm.listConflictCandidates()],
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
