import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PMProvider } from '@/pm/types.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

// The in-process PM provider is built by `createGitHubProjectsProvider`; mock it
// at the module boundary so the control-plane branch never resolves a real PM
// credential or hits GitHub. The transport wrapper (`@/pm/transport-delivery.js`)
// stays real — it's a pure function of the delegate + config.
const localDelegate: PMProvider = {
	type: 'github-projects',
	supportsAssignees: true,
	supportsDependencies: true,
	getWorkItem: vi.fn(),
	listWorkItems: vi.fn(),
	moveWorkItem: vi.fn().mockResolvedValue(undefined),
	addComment: vi.fn().mockResolvedValue('local-comment'),
	findComment: vi.fn(),
	createWorkItem: vi.fn(),
	updateWorkItem: vi.fn(),
	addLabel: vi.fn(),
	listBlockers: vi.fn(),
	addBlockedBy: vi.fn(),
};
const createGitHubProjectsProvider = vi.fn(() => localDelegate);
vi.mock('@/integrations/pm/github-projects/provider.js', () => ({
	createGitHubProjectsProvider,
}));

const { resolvePmDelivery } = await import('@/worker/consumer.js');

const project = createMockProjectConfig();

describe('resolvePmDelivery', () => {
	beforeEach(() => vi.clearAllMocks());
	afterEach(() => vi.unstubAllEnvs());

	it('returns a transport write delegate when both control-plane env vars are set', async () => {
		vi.stubEnv('SWARM_CONTROL_PLANE_URL', 'https://swarm.example');
		vi.stubEnv('SWARM_WORKER_CREDENTIAL', 'raw-worker-credential');

		const provider = resolvePmDelivery(project);

		expect(provider).toBeDefined();
		// Reads delegate to the in-process provider (built from the operator's local config).
		await provider?.getWorkItem('i1');
		expect(localDelegate.getWorkItem).toHaveBeenCalledWith('i1');
		expect(createGitHubProjectsProvider).toHaveBeenCalledWith(project);
	});

	it('returns undefined (in-process path, built by the phase) when the URL is unset', () => {
		vi.stubEnv('SWARM_CONTROL_PLANE_URL', '');
		vi.stubEnv('SWARM_WORKER_CREDENTIAL', 'raw-worker-credential');

		expect(resolvePmDelivery(project)).toBeUndefined();
		expect(createGitHubProjectsProvider).not.toHaveBeenCalled();
	});

	it('returns undefined when the worker credential is unset even if a URL is set', () => {
		vi.stubEnv('SWARM_CONTROL_PLANE_URL', 'https://swarm.example');
		vi.stubEnv('SWARM_WORKER_CREDENTIAL', '');

		expect(resolvePmDelivery(project)).toBeUndefined();
		expect(createGitHubProjectsProvider).not.toHaveBeenCalled();
	});
});
