import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentCliResult } from '@/harness/agent-cli.js';
import type { ScmDeliveryProvider } from '@/scm/delivery.js';

// Mock the phase orchestrators so the test observes exactly what `runAssignedPhase`
// forwards, without provisioning worktrees or running an agent.
const { runRespondToCiPhase, runResolveConflictsPhase } = vi.hoisted(() => ({
	runRespondToCiPhase: vi.fn(),
	runResolveConflictsPhase: vi.fn(),
}));
vi.mock('@/pipeline/respond-to-ci.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/pipeline/respond-to-ci.js')>()),
	runRespondToCiPhase,
}));
vi.mock('@/pipeline/resolve-conflicts.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/pipeline/resolve-conflicts.js')>()),
	runResolveConflictsPhase,
}));

// The concrete PM provider is the one thing `runAssignedPhase` constructs; stub it
// so no GitHub/DB dependency is pulled in when a board-driven phase resolves it.
const { createGitHubProjectsProvider } = vi.hoisted(() => ({
	createGitHubProjectsProvider: vi.fn(() => ({ tag: 'default-pm' })),
}));
vi.mock('@/integrations/pm/github-projects/provider.js', () => ({ createGitHubProjectsProvider }));

import { runAssignedPhase } from '@/worker/consumer.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

function agentResult(): AgentCliResult {
	return {
		cli: 'claude',
		exitCode: 0,
		signal: null,
		stdout: '',
		stderr: '',
		durationMs: 1,
		timedOut: false,
		aborted: false,
		outputTruncated: false,
	};
}

function stubDelivery(): ScmDeliveryProvider {
	return {
		commitIdentity: { name: 'op', email: 'op@example.com' },
		findPullRequest: async () => undefined,
		createPullRequest: async () => ({ number: 1, url: 'u' }),
		pushBranch: async () => {},
		submitReview: async () => 1,
		postComment: async () => 1,
	};
}

const baseInputs = () => ({
	taskId: '17',
	project: createMockProjectConfig(),
	resumeDelivery: false,
	runAgent: vi.fn(async () => agentResult()) as never,
	prNumber: '99',
	prBranch: 'issue-17',
	headSha: 'deadbeef',
});

describe('runAssignedPhase injection seam', () => {
	beforeEach(() => {
		runRespondToCiPhase.mockReset();
		runResolveConflictsPhase.mockReset();
		createGitHubProjectsProvider.mockClear();
		runRespondToCiPhase.mockResolvedValue({ outcome: 'fixed', agent: agentResult() });
		runResolveConflictsPhase.mockResolvedValue({ outcome: 'resolved', agent: agentResult() });
	});

	it('forwards an injected delivery + agentToken to respond-to-ci as delivery + getToken', async () => {
		const delivery = stubDelivery();
		await runAssignedPhase({
			...baseInputs(),
			phase: 'respond-to-ci',
			delivery,
			agentToken: 'op-tok',
		});

		const opts = runRespondToCiPhase.mock.calls[0][0];
		expect(opts.delivery).toBe(delivery);
		expect(typeof opts.getToken).toBe('function');
		await expect(opts.getToken()).resolves.toBe('op-tok');
	});

	it('forwards an injected delivery to resolve-conflicts', async () => {
		const delivery = stubDelivery();
		await runAssignedPhase({
			...baseInputs(),
			phase: 'resolve-conflicts',
			baseBranch: 'main',
			baseSha: 'cafe',
			delivery,
		});

		expect(runResolveConflictsPhase.mock.calls[0][0].delivery).toBe(delivery);
	});

	it('omitting the injected fields preserves the default path (no delivery, no getToken)', async () => {
		await runAssignedPhase({ ...baseInputs(), phase: 'respond-to-ci' });

		const opts = runRespondToCiPhase.mock.calls[0][0];
		expect(opts.delivery).toBeUndefined();
		expect(opts.getToken).toBeUndefined();
	});
});
