import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProjectConfig } from '../../../../helpers/factories.js';

vi.mock('@/integrations/scm/bitbucket/client.js', () => ({
	// Pass-through so a probe inside the scope can observe the credential that
	// would have been bound, without a real API call.
	withBitbucketCredential: vi.fn(
		(_credential: string, fn: () => Promise<unknown>): Promise<unknown> => fn(),
	),
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

import { withBitbucketCredential } from '@/integrations/scm/bitbucket/client.js';
import {
	getBitbucketCredential,
	getBitbucketCredentialOrNull,
} from '@/integrations/scm/bitbucket/credentials.js';
import {
	getBitbucketPersonaForLogin,
	isSwarmBitbucketActor,
	resolveBitbucketPersonaIdentities,
} from '@/integrations/scm/bitbucket/personas.js';
import { BitbucketSCMIntegration } from '@/integrations/scm/bitbucket/scm-integration.js';
import type { ScmPersonaIdentities } from '@/scm/types.js';

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

	// Every contract method this phase leaves unbuilt must fail loudly and name its
	// follow-up phase — never return a misleading `null`/`[]`/no-op that a caller
	// would mistake for a real answer (issue #296).
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
				expect(String(thrown)).toContain('issue #296');
			});
		}
	});
});
