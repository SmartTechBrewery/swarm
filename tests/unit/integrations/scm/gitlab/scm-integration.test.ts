import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProjectConfig } from '../../../../helpers/factories.js';

vi.mock('@/integrations/scm/gitlab/client.js', () => ({
	// Pass-through so a probe inside the scope can observe the token that would
	// have been bound, without a real API call.
	withGitLabToken: vi.fn((_token: string, fn: () => Promise<unknown>): Promise<unknown> => fn()),
}));
vi.mock('@/integrations/scm/gitlab/credentials.js', () => ({
	getGitLabToken: vi.fn<(project: unknown, persona: string) => Promise<string>>(),
	getGitLabTokenOrNull: vi.fn<(project: unknown, persona: string) => Promise<string | null>>(),
}));
vi.mock('@/integrations/scm/gitlab/personas.js', () => ({
	resolveGitLabPersonaIdentities: vi.fn(),
	isSwarmGitLabActor: vi.fn(),
	getGitLabPersonaForLogin: vi.fn(),
}));

import { withGitLabToken } from '@/integrations/scm/gitlab/client.js';
import { getGitLabToken, getGitLabTokenOrNull } from '@/integrations/scm/gitlab/credentials.js';
import {
	getGitLabPersonaForLogin,
	isSwarmGitLabActor,
	resolveGitLabPersonaIdentities,
} from '@/integrations/scm/gitlab/personas.js';
import { GitLabSCMIntegration } from '@/integrations/scm/gitlab/scm-integration.js';
import type { ScmPersonaIdentities } from '@/scm/types.js';

const project = createMockProjectConfig();
const IDENTITIES: ScmPersonaIdentities = { implementer: 'swarm-impl', reviewer: 'swarm-rev' };

describe('GitLabSCMIntegration', () => {
	const scm = new GitLabSCMIntegration();

	beforeEach(() => {
		vi.mocked(getGitLabToken).mockReset();
		vi.mocked(getGitLabTokenOrNull).mockReset();
		vi.mocked(withGitLabToken).mockClear();
	});

	it('declares itself as the gitlab SCM provider', () => {
		expect(scm.type).toBe('gitlab');
		expect(scm.category).toBe('scm');
	});

	describe('hasIntegration', () => {
		it('is an OR over the two persona tokens', async () => {
			vi.mocked(getGitLabTokenOrNull).mockImplementation(async (_p, persona) =>
				persona === 'reviewer' ? 'token-rev' : null,
			);

			await expect(scm.hasIntegration(project)).resolves.toBe(true);
		});

		it('is false only when neither persona resolves', async () => {
			vi.mocked(getGitLabTokenOrNull).mockResolvedValue(null);

			await expect(scm.hasIntegration(project)).resolves.toBe(false);
		});
	});

	describe('hasPersonaToken', () => {
		it('reports per persona', async () => {
			vi.mocked(getGitLabTokenOrNull).mockImplementation(async (_p, persona) =>
				persona === 'implementer' ? 'token-impl' : null,
			);

			await expect(scm.hasPersonaToken(project, 'implementer')).resolves.toBe(true);
			await expect(scm.hasPersonaToken(project, 'reviewer')).resolves.toBe(false);
		});
	});

	describe('withPersonaCredentials', () => {
		it('binds the requested persona’s own token', async () => {
			vi.mocked(getGitLabToken).mockImplementation(async (_p, persona) =>
				persona === 'implementer' ? 'token-impl' : 'token-rev',
			);

			await scm.withPersonaCredentials(project, 'reviewer', async () => undefined);

			expect(vi.mocked(getGitLabToken)).toHaveBeenCalledWith(project, 'reviewer');
			expect(vi.mocked(withGitLabToken).mock.calls[0]?.[0]).toBe('token-rev');
		});

		it('runs fn inside the scope and returns its value', async () => {
			vi.mocked(getGitLabToken).mockResolvedValue('token-impl');

			await expect(
				scm.withPersonaCredentials(project, 'implementer', async () => 'done'),
			).resolves.toBe('done');
		});

		it('throws before running fn when the token is missing', async () => {
			vi.mocked(getGitLabToken).mockRejectedValue(new Error('No GitLab implementer token'));
			const fn = vi.fn(async () => 'never');

			await expect(scm.withPersonaCredentials(project, 'implementer', fn)).rejects.toThrow(
				/No GitLab implementer token/,
			);
			expect(fn).not.toHaveBeenCalled();
		});
	});

	describe('persona identity + actor resolution', () => {
		it('delegates identity resolution to the cached resolver', async () => {
			vi.mocked(resolveGitLabPersonaIdentities).mockResolvedValue(IDENTITIES);

			await expect(scm.resolvePersonaIdentities(project)).resolves.toEqual(IDENTITIES);
			expect(vi.mocked(resolveGitLabPersonaIdentities)).toHaveBeenCalledWith(project);
		});

		it('delegates actor → persona mapping', () => {
			vi.mocked(getGitLabPersonaForLogin).mockReturnValue('reviewer');

			expect(scm.personaForActor('swarm-rev', IDENTITIES)).toBe('reviewer');
			expect(vi.mocked(getGitLabPersonaForLogin)).toHaveBeenCalledWith('swarm-rev', IDENTITIES);
		});

		it('delegates the SWARM-actor check', () => {
			vi.mocked(isSwarmGitLabActor).mockReturnValue(true);

			expect(scm.isSwarmActor('swarm-impl', IDENTITIES)).toBe(true);
			expect(vi.mocked(isSwarmGitLabActor)).toHaveBeenCalledWith('swarm-impl', IDENTITIES);
		});
	});

	// Every contract method this phase leaves unbuilt must fail loudly and name its
	// follow-up phase — never return a misleading `null`/`[]`/no-op that a caller
	// would mistake for a real answer (issue #295).
	describe('deferred contract methods', () => {
		const deferred: Array<[method: string, phase: string, call: () => unknown]> = [
			['verifyWebhookSignature', 'phase 2/4', () => scm.verifyWebhookSignature()],
			['readWebhookRequest', 'phase 2/4', () => scm.readWebhookRequest()],
			['parseWebhookEvent', 'phase 2/4', () => scm.parseWebhookEvent()],
			['isSwarmGeneratedEvent', 'phase 2/4', () => scm.isSwarmGeneratedEvent()],
			['getPullRequest', 'phase 3/4', () => scm.getPullRequest()],
			['getPullRequestTitle', 'phase 3/4', () => scm.getPullRequestTitle()],
			['getAggregateCheckStatus', 'phase 3/4', () => scm.getAggregateCheckStatus()],
			['listConflictCandidates', 'phase 3/4', () => scm.listConflictCandidates()],
			['commentOnPullRequest', 'phase 4/4', () => scm.commentOnPullRequest()],
			['deliveryProvider', 'phase 4/4', () => scm.deliveryProvider()],
			['operatorDeliveryProvider', 'phase 4/4', () => scm.operatorDeliveryProvider()],
			['mergePullRequest', 'phase 4/4', () => scm.mergePullRequest()],
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
				expect(String(thrown)).toContain('issue #295');
			});
		}
	});
});
