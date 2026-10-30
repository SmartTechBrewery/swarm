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
vi.mock('@/db/repositories/runsRepository.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/db/repositories/runsRepository.js')>()),
	updateRunJobPayload: vi.fn(),
}));

import type { DispatchRow } from '@/db/repositories/dispatchesRepository.js';
import { updateRunJobPayload } from '@/db/repositories/runsRepository.js';
import { requireWorkerScmCredential } from '@/identity/worker-scm-credential.js';
import type { SCMProviderManifest } from '@/integrations/scm/manifest.js';
import {
	_resetSCMProviderRegistryForTesting,
	registerSCMProvider,
} from '@/integrations/scm/registry.js';
import { isRunCancellationRequested } from '@/queue/cancellation.js';
import type { SwarmJob } from '@/queue/jobs.js';
import { deliverDispatchProgress, deliverDispatchResult } from '@/router/dispatch-results.js';
import { createControlPlaneDispatchDeps } from '@/router/dispatcher.js';
import { deregisterConnection, registerConnection } from '@/router/worker-connections.js';
import type { TaskProgress } from '@/transport/protocol.js';
import type { DispatchPhaseContext } from '@/worker/consumer.js';
import type { DispatchSelection } from '@/worker/eligibility-gate.js';
import {
	createMockPmWebhookJob,
	createMockProjectConfig,
	createMockWorkItem,
} from '../../helpers/factories.js';

/**
 * The control-plane half of "a task's branch is decided once" (issue #1241, review of
 * #1243 F3): a `branch-provisioned` frame naming the decided branch records it as the
 * run's `taskBranch` — on the run row's payload and on the in-flight job a deferral
 * derives its retry payload from — and a frame naming none leaves a stored one intact.
 */

const DISPATCH_ID = 'b0f7d0d2-3c1e-4c43-9a6e-0d6f3b0b8e11';
const RUN_ID = 'c4a1f6e0-2b8d-4f4e-8a55-6f0c2e9d7a12';
const WORKER_ID = '77777777-7777-4777-8777-777777777777';

const SELECTION: DispatchSelection = {
	workerId: WORKER_ID,
	workerName: 'karolina_swarm',
	ownerUserId: 'user-1',
	target: { cli: 'claude' },
	targetIndex: 0,
	cli: 'claude',
	skippedClis: [],
};

function context(job: SwarmJob): DispatchPhaseContext {
	return {
		trigger: { phase: 'implementation', taskId: 'VT-1538', workItem: createMockWorkItem() },
		project: createMockProjectConfig({ scm: 'github' }),
		resolution: { globalDefaults: undefined, selection: SELECTION },
		job,
		runId: RUN_ID,
		signal: new AbortController().signal,
		implementationUnplanned: false,
		dispatch: { id: DISPATCH_ID } as DispatchRow,
	};
}

function provisioned(branch?: string, commitSubject?: string): TaskProgress {
	return {
		type: 'task-progress',
		dispatchId: DISPATCH_ID,
		phase: 'implementation',
		taskId: 'VT-1538',
		state: 'branch-provisioned',
		...(branch ? { branch } : {}),
		...(commitSubject ? { commitSubject } : {}),
	};
}

type FakeWs = WSContext & { send: ReturnType<typeof vi.fn>; readyState: number };

describe('control-plane executePhase — branch-provisioned frame (issue #1241)', () => {
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
		vi.mocked(requireWorkerScmCredential).mockReset().mockResolvedValue('operator-credential');
		vi.mocked(isRunCancellationRequested).mockReset().mockResolvedValue(false);
		vi.mocked(updateRunJobPayload).mockReset().mockResolvedValue(undefined);
		ws = { send: vi.fn(), close: vi.fn(), readyState: 1 } as unknown as FakeWs;
		registerConnection(WORKER_ID, ws);
	});
	afterEach(() => {
		deregisterConnection(WORKER_ID, ws);
	});

	/** Push the assignment, deliver one progress frame, then settle the run. */
	async function runWithProgress(job: SwarmJob, frame: TaskProgress): Promise<void> {
		const running = executePhase(context(job));
		await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());

		deliverDispatchProgress(frame, WORKER_ID);
		await vi.waitFor(() => expect(updateRunJobPayload).toHaveBeenCalled());

		deliverDispatchResult(
			{
				type: 'task-execution-result',
				dispatchId: DISPATCH_ID,
				status: 'succeeded',
				phase: 'implementation',
				taskId: 'VT-1538',
				exitCode: 0,
				durationMs: 1_000,
			},
			WORKER_ID,
		);
		await running;
	}

	it('records the decided branch on the run payload and on the in-flight job', async () => {
		const job: SwarmJob = { ...createMockPmWebhookJob(), dispatchId: DISPATCH_ID };

		await runWithProgress(job, provisioned('VT-1538/pierwsza-strona-testowa'));

		expect(updateRunJobPayload).toHaveBeenCalledWith(
			RUN_ID,
			expect.objectContaining({
				implementationBranchProvisioned: true,
				taskBranch: 'VT-1538/pierwsza-strona-testowa',
			}),
		);
		// The object a deferral of this attempt re-derives its retry payload from.
		expect(job.taskBranch).toBe('VT-1538/pierwsza-strona-testowa');
	});

	// Issue #1242: the decided commit subject is stored with the run the same way.
	it('records the decided commit subject on the run payload and on the in-flight job', async () => {
		const job: SwarmJob = { ...createMockPmWebhookJob(), dispatchId: DISPATCH_ID };

		await runWithProgress(job, provisioned(undefined, 'VT-1538 Add the starting page'));

		expect(updateRunJobPayload).toHaveBeenCalledWith(
			RUN_ID,
			expect.objectContaining({ commitSubject: 'VT-1538 Add the starting page' }),
		);
		expect(job.commitSubject).toBe('VT-1538 Add the starting page');
	});

	// Review of #1245 F1: at delivery the branch and the commit subject arrive as two
	// frames back to back. Each write replaces the whole payload, so a first write that
	// lands last must not drop the commit subject the second one recorded.
	it('writes back-to-back frames in order, the last carrying both values', async () => {
		const job: SwarmJob = { ...createMockPmWebhookJob(), dispatchId: DISPATCH_ID };
		let releaseFirst: () => void = () => {};
		vi.mocked(updateRunJobPayload).mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					releaseFirst = resolve;
				}),
		);
		const running = executePhase(context(job));
		await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());

		deliverDispatchProgress(provisioned('VT-1538/pierwsza-strona-testowa'), WORKER_ID);
		deliverDispatchProgress(provisioned(undefined, 'VT-1538 Add the starting page'), WORKER_ID);
		await vi.waitFor(() => expect(updateRunJobPayload).toHaveBeenCalledTimes(1));
		// The second write waits for the first rather than racing it.
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(updateRunJobPayload).toHaveBeenCalledTimes(1);

		releaseFirst();
		await vi.waitFor(() => expect(updateRunJobPayload).toHaveBeenCalledTimes(2));
		expect(vi.mocked(updateRunJobPayload).mock.lastCall?.[1]).toMatchObject({
			taskBranch: 'VT-1538/pierwsza-strona-testowa',
			commitSubject: 'VT-1538 Add the starting page',
		});

		deliverDispatchResult(
			{
				type: 'task-execution-result',
				dispatchId: DISPATCH_ID,
				status: 'succeeded',
				phase: 'implementation',
				taskId: 'VT-1538',
				exitCode: 0,
				durationMs: 1_000,
			},
			WORKER_ID,
		);
		await running;
	});

	it('carries the job’s stored commit subject to the worker', async () => {
		const job: SwarmJob = {
			...createMockPmWebhookJob(),
			dispatchId: DISPATCH_ID,
			commitSubject: 'VT-1538 Add the first page',
		};

		await runWithProgress(job, provisioned());

		expect(JSON.parse(String(ws.send.mock.calls[0][0]))).toMatchObject({
			type: 'task-assignment',
			commitSubject: 'VT-1538 Add the first page',
		});
	});

	it('leaves a stored taskBranch intact when the frame names none', async () => {
		const job: SwarmJob = {
			...createMockPmWebhookJob(),
			dispatchId: DISPATCH_ID,
			taskBranch: 'VT-1538/stored-earlier',
		};

		await runWithProgress(job, provisioned());

		expect(updateRunJobPayload).toHaveBeenCalledWith(
			RUN_ID,
			expect.objectContaining({
				implementationBranchProvisioned: true,
				taskBranch: 'VT-1538/stored-earlier',
			}),
		);
		expect(job.taskBranch).toBe('VT-1538/stored-earlier');
		// …and the pushed assignment carried the stored branch to the worker.
		expect(JSON.parse(String(ws.send.mock.calls[0][0]))).toMatchObject({
			type: 'task-assignment',
			taskBranch: 'VT-1538/stored-earlier',
		});
	});
});
