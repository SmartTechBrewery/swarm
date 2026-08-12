/**
 * `runAssignedPhase` must forward `runId` to **every** phase (issue #427).
 *
 * The stale-lease take-over is only reachable when the provisioning phase can
 * name its own run: without it `hasLiveWorktreeLeaseOwner` fails closed and the
 * run wedges as `live-leased`, exactly as it did before the fix. The phases all
 * pass `runId` on to `worktrees.provision`, so this switch is the single place the
 * whole mechanism can silently be lost — and it was, for five of the six phases,
 * because nothing asserted the hand-off. One case per phase, so a new phase that
 * forgets it fails here rather than in production.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentCliResult } from '@/harness/agent-cli.js';
import type { AssignedPhaseInputs } from '@/worker/consumer.js';

const {
	runPlanningPhase,
	runImplementationPhase,
	runReviewPhase,
	runRespondToReviewPhase,
	runRespondToCiPhase,
	runResolveConflictsPhase,
} = vi.hoisted(() => ({
	runPlanningPhase: vi.fn(),
	runImplementationPhase: vi.fn(),
	runReviewPhase: vi.fn(),
	runRespondToReviewPhase: vi.fn(),
	runRespondToCiPhase: vi.fn(),
	runResolveConflictsPhase: vi.fn(),
}));

vi.mock('@/pipeline/planning.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/pipeline/planning.js')>()),
	runPlanningPhase,
}));
vi.mock('@/pipeline/implementation.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/pipeline/implementation.js')>()),
	runImplementationPhase,
}));
vi.mock('@/pipeline/review.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/pipeline/review.js')>()),
	runReviewPhase,
}));
vi.mock('@/pipeline/respond-to-review.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/pipeline/respond-to-review.js')>()),
	runRespondToReviewPhase,
}));
vi.mock('@/pipeline/respond-to-ci.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/pipeline/respond-to-ci.js')>()),
	runRespondToCiPhase,
}));
vi.mock('@/pipeline/resolve-conflicts.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/pipeline/resolve-conflicts.js')>()),
	runResolveConflictsPhase,
}));

// The one concrete provider `runAssignedPhase` constructs; stubbed so a
// board-driven phase pulls in no GitHub/DB dependency.
const { createGitHubProjectsProvider } = vi.hoisted(() => ({
	createGitHubProjectsProvider: vi.fn(() => ({ tag: 'default-pm' })),
}));
vi.mock('@/integrations/pm/github-projects/provider.js', () => ({ createGitHubProjectsProvider }));

import { runAssignedPhase } from '@/worker/consumer.js';
import {
	createMockPhaseRecovery,
	createMockProjectConfig,
	createMockWorkItem,
} from '../../helpers/factories.js';

const RUN_ID = 'f1e2d3c4-b5a6-4978-8899-aabbccddeeff';

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

/** Every field any phase branch validates, so each case differs only by `phase`. */
const baseInputs = () => ({
	taskId: '17',
	project: createMockProjectConfig(),
	repository: 'SmartTechBrewery/run-repo',
	workItem: createMockWorkItem(),
	runId: RUN_ID,
	recovery: createMockPhaseRecovery(),
	runAgent: vi.fn(async () => agentResult()) as never,
	prNumber: '99',
	prBranch: 'issue-17',
	headSha: 'deadbeef',
	baseBranch: 'main',
	baseSha: 'cafe',
	reviewId: '4242',
});

const PHASES: { phase: AssignedPhaseInputs['phase']; spy: ReturnType<typeof vi.fn> }[] = [
	{ phase: 'planning', spy: runPlanningPhase },
	{ phase: 'implementation', spy: runImplementationPhase },
	{ phase: 'review', spy: runReviewPhase },
	{ phase: 'respond-to-review', spy: runRespondToReviewPhase },
	{ phase: 'respond-to-ci', spy: runRespondToCiPhase },
	{ phase: 'resolve-conflicts', spy: runResolveConflictsPhase },
];

describe('runAssignedPhase runId threading (issue #427)', () => {
	beforeEach(() => {
		for (const { spy } of PHASES) {
			spy.mockReset().mockResolvedValue({ outcome: 'fixed', agent: agentResult() });
		}
		createGitHubProjectsProvider.mockClear();
	});

	for (const { phase, spy } of PHASES) {
		it(`forwards runId to the ${phase} phase`, async () => {
			await runAssignedPhase({ ...baseInputs(), phase } as AssignedPhaseInputs);

			expect(spy).toHaveBeenCalledOnce();
			expect(spy.mock.calls[0][0].runId).toBe(RUN_ID);
		});
	}

	it('forwards no runId when the dispatch carries none, keeping the fail-closed gate', async () => {
		const { runId: _dropped, ...withoutRunId } = baseInputs();
		await runAssignedPhase({ ...withoutRunId, phase: 'review' } as AssignedPhaseInputs);

		expect(runReviewPhase.mock.calls[0][0].runId).toBeUndefined();
	});
});
