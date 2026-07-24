import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScmDeliveryProvider } from '@/scm/delivery.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

// The in-process delivery provider is built by GitHubSCMIntegration; mock it at
// the module boundary so the control-plane branch never resolves a real PAT or
// hits GitHub. The transport wrapper (`@/scm/transport-delivery.js`) stays real
// — it's a pure function of the delegate + config.
const localDelegate: ScmDeliveryProvider = {
	commitIdentity: { name: 'ada', email: 'ada@users.noreply.github.com' },
	findPullRequest: vi.fn(),
	createPullRequest: vi.fn(),
	pushBranch: vi.fn(),
	submitReview: vi.fn().mockResolvedValue(1),
	postComment: vi.fn().mockResolvedValue(2),
};
const deliveryProvider = vi.fn(async () => localDelegate);
vi.mock('@/integrations/scm/github/scm-integration.js', () => ({
	GitHubSCMIntegration: class {
		deliveryProvider = deliveryProvider;
	},
}));

const { resolveScmDelivery } = await import('@/worker/consumer.js');

const project = createMockProjectConfig();

describe('resolveScmDelivery', () => {
	beforeEach(() => vi.clearAllMocks());
	afterEach(() => vi.unstubAllEnvs());

	it('returns a transport provider when both control-plane env vars are set', async () => {
		vi.stubEnv('SWARM_CONTROL_PLANE_URL', 'https://swarm.example');
		vi.stubEnv('SWARM_WORKER_CREDENTIAL', 'raw-worker-credential');

		const provider = await resolveScmDelivery(project, 'reviewer');

		expect(provider).toBeDefined();
		// Source ops delegate to the local provider (the operator's own token stays worker-side).
		expect(provider?.commitIdentity).toEqual(localDelegate.commitIdentity);
		expect(deliveryProvider).toHaveBeenCalledWith(project, 'reviewer');
	});

	it('returns undefined (in-process path, built lazily by the phase) when the URL is unset', async () => {
		vi.stubEnv('SWARM_CONTROL_PLANE_URL', '');
		vi.stubEnv('SWARM_WORKER_CREDENTIAL', 'raw-worker-credential');

		expect(await resolveScmDelivery(project, 'reviewer')).toBeUndefined();
		expect(deliveryProvider).not.toHaveBeenCalled();
	});

	it('returns undefined when the worker credential is unset even if a URL is set', async () => {
		vi.stubEnv('SWARM_CONTROL_PLANE_URL', 'https://swarm.example');
		vi.stubEnv('SWARM_WORKER_CREDENTIAL', '');

		expect(await resolveScmDelivery(project, 'implementer')).toBeUndefined();
		expect(deliveryProvider).not.toHaveBeenCalled();
	});
});
