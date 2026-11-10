import type { WSContext } from 'hono/ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/identity/worker-scm-credential.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/identity/worker-scm-credential.js')>()),
	requireWorkerScmCredential: vi.fn(),
}));
vi.mock('@/queue/cancellation.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/queue/cancellation.js')>()),
	isRunCancellationRequested: vi.fn(),
}));
vi.mock('@/identity/agent-access-token-service.js', () => ({
	mintRunBoundAgentToken: vi.fn(),
	revokeRunBoundAgentTokens: vi.fn(),
}));

import type { DispatchRow } from '@/db/repositories/dispatchesRepository.js';
import { mintRunBoundAgentToken } from '@/identity/agent-access-token-service.js';
import { requireWorkerScmCredential } from '@/identity/worker-scm-credential.js';
import type { SCMProviderManifest } from '@/integrations/scm/manifest.js';
import {
	_resetSCMProviderRegistryForTesting,
	registerSCMProvider,
} from '@/integrations/scm/registry.js';
import { isRunCancellationRequested } from '@/queue/cancellation.js';
import type { SwarmJob } from '@/queue/jobs.js';
import { deliverDispatchResult } from '@/router/dispatch-results.js';
import { createControlPlaneDispatchDeps } from '@/router/dispatcher.js';
import { deregisterConnection, registerConnection } from '@/router/worker-connections.js';
import type { TaskAssignment } from '@/transport/protocol.js';
import type { TriggerResult } from '@/triggers/types.js';
import type { DispatchPhaseContext } from '@/worker/consumer.js';
import type { DispatchSelection } from '@/worker/eligibility-gate.js';
import {
	createMockPmWebhookJob,
	createMockProjectConfig,
	createMockWorkItem,
} from '../../helpers/factories.js';

/**
 * The control-plane half of a Resolve problem dispatch (issue #1395): the assignment
 * carries the run-bound operator MCP credential — and only this phase's does — needs
 * no operator SCM credential, and the report the worker hands back reaches the settle.
 */

const DISPATCH_ID = 'b0f7d0d2-3c1e-4c43-9a6e-0d6f3b0b8e11';
const RUN_ID = 'c4a1f6e0-2b8d-4f4e-8a55-6f0c2e9d7a12';
const FAILED_RUN_ID = '33333333-3333-4333-8333-333333333333';
const WORKER_ID = '77777777-7777-4777-8777-777777777777';

const SELECTION: DispatchSelection = {
	workerId: WORKER_ID,
	workerName: 'karolina_swarm',
	ownerUserId: 'owner-1',
	target: { cli: 'claude' },
	targetIndex: 0,
	cli: 'claude',
	skippedClis: [],
};

const RESOLVE_PROBLEM: TriggerResult = {
	phase: 'resolve-problem',
	taskId: '17',
	failedRunId: FAILED_RUN_ID,
	failedRun: {
		id: FAILED_RUN_ID,
		phase: 'implementation',
		taskId: '17',
		error: 'the failure under investigation',
	},
};

const PROJECT = createMockProjectConfig({
	scm: 'github',
	pipeline: { resolveProblem: { enabled: true, maxWriteActions: 4 } },
});

function context(trigger: TriggerResult, job: SwarmJob): DispatchPhaseContext {
	return {
		trigger,
		project: PROJECT,
		resolution: { globalDefaults: undefined, selection: SELECTION },
		job,
		runId: RUN_ID,
		signal: new AbortController().signal,
		implementationUnplanned: false,
		dispatch: { id: DISPATCH_ID } as DispatchRow,
	};
}

type FakeWs = WSContext & { send: ReturnType<typeof vi.fn>; readyState: number };

describe('control-plane executePhase — Resolve problem (issue #1395)', () => {
	const { executePhase } = createControlPlaneDispatchDeps();
	let ws: FakeWs;

	beforeEach(() => {
		_resetSCMProviderRegistryForTesting();
		registerSCMProvider({
			id: 'github',
			label: 'github',
			category: 'scm',
			credentialRoles: [
				{ role: 'reviewer', envVarKey: 'GITHUB_TOKEN_REVIEWER' },
				{ role: 'webhookSecret', envVarKey: 'GITHUB_WEBHOOK_SECRET' },
			],
			provider: { id: 'github' },
		} as unknown as SCMProviderManifest);
		vi.stubEnv('WEBHOOK_CALLBACK_BASE_URL', 'https://swarm.example.com');
		vi.mocked(requireWorkerScmCredential).mockReset().mockResolvedValue('operator-credential');
		vi.mocked(isRunCancellationRequested).mockReset().mockResolvedValue(false);
		vi.mocked(mintRunBoundAgentToken)
			.mockReset()
			.mockResolvedValue({ token: 'run-bound-token' } as never);
		ws = { send: vi.fn(), close: vi.fn(), readyState: 1 } as unknown as FakeWs;
		registerConnection(WORKER_ID, ws);
	});
	afterEach(() => {
		deregisterConnection(WORKER_ID, ws);
		vi.unstubAllEnvs();
	});

	/** Run the phase, answer it with `result`, and return the pushed frame. */
	async function run(
		trigger: TriggerResult,
		job: SwarmJob,
		result: Record<string, unknown> = {},
	): Promise<{ frame: TaskAssignment; outcome: Awaited<ReturnType<typeof executePhase>> }> {
		const running = executePhase(context(trigger, job));
		await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());
		const frame = JSON.parse(ws.send.mock.calls[0][0] as string) as TaskAssignment;
		deliverDispatchResult(
			{
				type: 'task-execution-result',
				dispatchId: DISPATCH_ID,
				status: 'succeeded',
				phase: trigger.phase,
				taskId: trigger.taskId,
				exitCode: 0,
				durationMs: 1_000,
				...result,
			},
			WORKER_ID,
		);
		return { frame, outcome: await running };
	}

	it('carries the minted run-bound MCP credential and no operator SCM credential', async () => {
		const job: SwarmJob = {
			type: 'resolve-problem',
			projectId: PROJECT.id,
			failedRunId: FAILED_RUN_ID,
			dispatchId: DISPATCH_ID,
		};
		const report = {
			outcome: 'resolved' as const,
			bugReportId: 'report-1',
			actions: [],
			summary: 'Nothing needed doing.',
		};

		const { frame, outcome } = await run(RESOLVE_PROBLEM, job, { resolveProblem: report });

		expect(frame.swarmMcp).toEqual({
			url: 'https://swarm.example.com/operator/mcp',
			token: 'run-bound-token',
		});
		expect(frame.operatorCredential).toBeUndefined();
		expect(requireWorkerScmCredential).not.toHaveBeenCalled();
		expect(mintRunBoundAgentToken).toHaveBeenCalledWith(
			expect.objectContaining({
				holderUserId: 'owner-1',
				projectId: PROJECT.id,
				runId: RUN_ID,
				maxWriteActions: 4,
			}),
		);
		expect(frame.systemPrompt).toContain('the failure under investigation');
		expect(frame.systemPrompt).toContain(`filedByRunId: "${RUN_ID}"`);
		expect(outcome.resolveProblem).toEqual(report);
	});

	it('carries no MCP credential on any other phase', async () => {
		const job: SwarmJob = { ...createMockPmWebhookJob(), dispatchId: DISPATCH_ID };
		const { frame } = await run(
			{ phase: 'implementation', taskId: '17', workItem: createMockWorkItem() },
			job,
		);

		expect(frame.swarmMcp).toBeUndefined();
		expect(frame.operatorCredential).toBe('operator-credential');
		expect(mintRunBoundAgentToken).not.toHaveBeenCalled();
	});
});
