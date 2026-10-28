import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/identity/worker-scm-credential.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/identity/worker-scm-credential.js')>()),
	requireWorkerScmCredential: vi.fn(),
}));

import { DEFAULT_WORKER_SUPPORTED_PHASES, type Worker } from '@/identity/worker.js';
import {
	MissingWorkerScmCredentialError,
	requireWorkerScmCredential,
} from '@/identity/worker-scm-credential.js';
import type { SCMProviderManifest } from '@/integrations/scm/manifest.js';
import {
	_resetSCMProviderRegistryForTesting,
	registerSCMProvider,
} from '@/integrations/scm/registry.js';
import { buildOperatorScmDelivery } from '@/router/worker-delivery.js';
import type { ScmDeliveryProvider } from '@/scm/delivery.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

const WORKER: Worker = {
	id: '11111111-1111-4111-8111-111111111111',
	ownerUserId: '22222222-2222-4222-8222-222222222222',
	displayName: 'ada-laptop',
	capabilities: ['claude'],
	probedCapabilities: ['claude'],
	declaredCapabilities: null,
	supportedPhases: [...DEFAULT_WORKER_SUPPORTED_PHASES],
	repositories: [],
	hostname: null,
	drainingSince: null,
	update: null,
	version: null,
	worktreeSweep: null,
	build: null,
	supervision: 'unknown',
	createdAt: new Date('2026-01-01T00:00:00Z'),
	updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const DELIVERY = { postComment: vi.fn() } as unknown as ScmDeliveryProvider;

/** A manifest stand-in whose provider builds an operator delivery provider. */
function fakeManifest(id: string): SCMProviderManifest {
	return {
		id,
		label: id,
		category: 'scm',
		credentialRoles: [
			{ role: 'reviewer', envVarKey: `${id.toUpperCase()}_TOKEN_REVIEWER` },
			{ role: 'webhookSecret', envVarKey: `${id.toUpperCase()}_WEBHOOK_SECRET` },
		],
		provider: { id, operatorDeliveryProvider: vi.fn().mockResolvedValue(DELIVERY) },
	} as unknown as SCMProviderManifest;
}

/**
 * The implementer persona on `POST /worker/delivery/pr-comment` (issue #1152): the
 * requesting worker's stored operator credential for the project's SCM provider —
 * the account that worker pushed the fix as — never the router's env.
 */
describe('buildOperatorScmDelivery', () => {
	let github: SCMProviderManifest;
	let bitbucket: SCMProviderManifest;

	beforeEach(() => {
		_resetSCMProviderRegistryForTesting();
		github = fakeManifest('github');
		bitbucket = fakeManifest('bitbucket');
		registerSCMProvider(github);
		registerSCMProvider(bitbucket);
		vi.mocked(requireWorkerScmCredential).mockReset();
	});

	afterEach(() => vi.unstubAllEnvs());

	it("resolves the requesting worker's credential for the provider the project targets", async () => {
		vi.mocked(requireWorkerScmCredential).mockResolvedValue('bb-app-password');
		const project = createMockProjectConfig({
			id: 'bb-project',
			scm: 'bitbucket',
			repo: 'acme/app',
		});

		await expect(buildOperatorScmDelivery(project, WORKER)).resolves.toBe(DELIVERY);
		expect(requireWorkerScmCredential).toHaveBeenCalledWith({
			workerId: WORKER.id,
			workerName: 'ada-laptop',
			scmProviderId: 'bitbucket',
		});
		expect(bitbucket.provider.operatorDeliveryProvider).toHaveBeenCalledWith(
			'acme/app',
			'bb-app-password',
		);
		expect(github.provider.operatorDeliveryProvider).not.toHaveBeenCalled();
	});

	it("ignores the router's SWARM_OPERATOR_GH_TOKEN", async () => {
		vi.stubEnv('SWARM_OPERATOR_GH_TOKEN', 'ghp_router_env');
		vi.mocked(requireWorkerScmCredential).mockResolvedValue('ghp_worker_stored');
		const project = createMockProjectConfig({ scm: 'github' });

		await buildOperatorScmDelivery(project, WORKER);

		expect(github.provider.operatorDeliveryProvider).toHaveBeenCalledWith(
			project.repo,
			'ghp_worker_stored',
		);
	});

	it('propagates a missing credential as the typed error, building nothing', async () => {
		const missing = new MissingWorkerScmCredentialError(WORKER.id, 'ada-laptop', 'github', 'none');
		vi.mocked(requireWorkerScmCredential).mockRejectedValue(missing);
		const project = createMockProjectConfig({ scm: 'github' });

		await expect(buildOperatorScmDelivery(project, WORKER)).rejects.toBe(missing);
		expect(github.provider.operatorDeliveryProvider).not.toHaveBeenCalled();
	});
});
