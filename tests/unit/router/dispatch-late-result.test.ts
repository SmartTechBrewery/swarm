import type { WSContext } from 'hono/ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/identity/worker-scm-credential.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/identity/worker-scm-credential.js')>()),
	requireWorkerScmCredential: vi.fn(),
}));

import type { DispatchRow } from '@/db/repositories/dispatchesRepository.js';
import { requireWorkerScmCredential } from '@/identity/worker-scm-credential.js';
import type { SCMProviderManifest } from '@/integrations/scm/manifest.js';
import {
	_resetSCMProviderRegistryForTesting,
	registerSCMProvider,
} from '@/integrations/scm/registry.js';
import type { SwarmJob } from '@/queue/jobs.js';
import {
	awaitDispatchResult,
	deliverDispatchResult,
	failOrphanedDispatchResultWait,
	isDispatchOrphanedFrom,
	resolveDispatchStreamTarget,
	takeOverOrphanedDispatch,
} from '@/router/dispatch-results.js';
import { createControlPlaneDispatchDeps } from '@/router/dispatcher.js';
import { endOrphanTrustAtClaim } from '@/router/transport-loss-reaper.js';
import { deregisterConnection, registerConnection } from '@/router/worker-connections.js';
import { DeliveryDeferredError } from '@/scm/delivery.js';
import type { TaskExecutionResult } from '@/transport/protocol.js';
import type { DispatchPhaseContext } from '@/worker/consumer.js';
import type { DispatchSelection } from '@/worker/eligibility-gate.js';
import {
	createMockPmWebhookJob,
	createMockProjectConfig,
	createMockWorkItem,
} from '../../helpers/factories.js';

/**
 * The control-plane executor's two transport-loss additions (issue #1076): a dispatch
 * carrying an adopted late result settles with it and pushes nothing, and a push back
 * to the worker an earlier attempt was orphaned on waits for its answer to the stop.
 */

const DISPATCH_ID = 'ee14c88f-1f88-4b64-a740-4c308ec011e5';
const RUN_ID = '8bb1eb3f-5097-41f7-98fb-eda865b2656b';
const LOST_WORKER_ID = '55555555-5555-4555-8555-555555555555';
const RETRY_WORKER_ID = '66666666-6666-4666-8666-666666666666';

function selectionFor(workerId: string, workerName: string): DispatchSelection {
	return {
		workerId,
		workerName,
		ownerUserId: 'user-1',
		target: { cli: 'claude' },
		targetIndex: 0,
		cli: 'claude',
		skippedClis: [],
	};
}

const LATE_SUCCESS = {
	type: 'task-execution-result' as const,
	dispatchId: DISPATCH_ID,
	status: 'succeeded' as const,
	phase: 'planning' as const,
	taskId: '568',
	exitCode: 0,
	durationMs: 1_500_000,
	movedTo: 'todo' as const,
	advancedItemIds: ['ITEM_587'],
} satisfies TaskExecutionResult;

function context(selection: DispatchSelection, job: SwarmJob): DispatchPhaseContext {
	const workItem = createMockWorkItem({ id: 'ITEM_568' });
	return {
		trigger: { phase: 'planning', taskId: '568', workItem },
		project: createMockProjectConfig({ scm: 'github' }),
		resolution: { globalDefaults: undefined, selection },
		job,
		runId: undefined,
		signal: new AbortController().signal,
		implementationUnplanned: false,
		dispatch: { id: DISPATCH_ID } as DispatchRow,
	};
}

type FakeWs = WSContext & { send: ReturnType<typeof vi.fn>; readyState: number };

function fakeWs(): FakeWs {
	return { send: vi.fn(), close: vi.fn(), readyState: 1 } as unknown as FakeWs;
}

describe('control-plane executePhase and the transport-loss recovery (issue #1076)', () => {
	const { executePhase } = createControlPlaneDispatchDeps();

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
	});
	afterEach(() => {
		takeOverOrphanedDispatch(DISPATCH_ID, LOST_WORKER_ID);
	});

	it('settles an adopted late result without pushing anything', async () => {
		const selection = selectionFor(LOST_WORKER_ID, 'karolina_swarm');
		const job: SwarmJob = {
			...createMockPmWebhookJob(),
			dispatchId: DISPATCH_ID,
			adoptedResult: { result: LATE_SUCCESS, selection },
		};

		const result = await executePhase(context(selection, job));

		expect(result).toMatchObject({
			agent: { cli: 'claude', exitCode: 0, durationMs: 1_500_000, timedOut: false },
			movedTo: 'todo',
			advancedItemIds: ['ITEM_587'],
		});
		// No credential resolved, no wait registered: nothing was pushed.
		expect(requireWorkerScmCredential).not.toHaveBeenCalled();
		expect(resolveDispatchStreamTarget(DISPATCH_ID)).toBeUndefined();
	});

	it('stops the trusted orphan on its lost worker before pushing the retry elsewhere', async () => {
		// The reap left Planning orphaned on the lost worker, trusted while its retry waits.
		const reaped = awaitDispatchResult(DISPATCH_ID, {
			workerId: LOST_WORKER_ID,
			runId: RUN_ID,
			phase: 'planning',
			taskId: '568',
		});
		failOrphanedDispatchResultWait(DISPATCH_ID, 'transport lost');
		reaped.dispose();
		const lost = fakeWs();
		registerConnection(LOST_WORKER_ID, lost);
		expect(isDispatchOrphanedFrom(LOST_WORKER_ID, DISPATCH_ID)).toBe(false);

		// The retry's worker is not connected, so the push itself defers — but the
		// takeover has already happened.
		const job: SwarmJob = { ...createMockPmWebhookJob(), dispatchId: DISPATCH_ID };
		await expect(
			executePhase(context(selectionFor(RETRY_WORKER_ID, 'm5_pro'), job)),
		).rejects.toBeInstanceOf(DeliveryDeferredError);

		expect(lost.send).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(lost.send.mock.calls[0][0]))).toMatchObject({
			type: 'task-cancel',
			dispatchId: DISPATCH_ID,
			runId: RUN_ID,
			phase: 'planning',
			taskId: '568',
		});
		expect(isDispatchOrphanedFrom(LOST_WORKER_ID, DISPATCH_ID)).toBe(true);
		deregisterConnection(LOST_WORKER_ID, lost);
	});

	/** Planning orphaned on the lost worker, which is back, and the retry just claimed. */
	function claimedWithConnectedOrphan(): FakeWs {
		const reaped = awaitDispatchResult(DISPATCH_ID, {
			workerId: LOST_WORKER_ID,
			runId: RUN_ID,
			phase: 'planning',
			taskId: '568',
		});
		failOrphanedDispatchResultWait(DISPATCH_ID, 'transport lost');
		reaped.dispose();
		const lost = fakeWs();
		registerConnection(LOST_WORKER_ID, lost);
		endOrphanTrustAtClaim(DISPATCH_ID);
		expect(JSON.parse(String(lost.send.mock.calls[0][0]))).toMatchObject({
			type: 'task-cancel',
			dispatchId: DISPATCH_ID,
		});
		return lost;
	}

	// The re-review of #1078: the claim stops a connected orphan, and the stop is answered
	// under the same dispatch id. A retry pushed back to that worker must not be settled
	// by that answer.
	it('waits for the stopped worker’s answer before pushing the retry back to it', async () => {
		const lost = claimedWithConnectedOrphan();
		const job: SwarmJob = { ...createMockPmWebhookJob(), dispatchId: DISPATCH_ID };
		const running = executePhase(context(selectionFor(LOST_WORKER_ID, 'karolina_swarm'), job));

		// Nothing is pushed or awaited until the worker answers the stop.
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(lost.send).toHaveBeenCalledTimes(1);
		expect(resolveDispatchStreamTarget(DISPATCH_ID)).toBeUndefined();

		// The answer is dropped as the orphan's last frame; only then is the retry pushed.
		expect(
			deliverDispatchResult(
				{ ...LATE_SUCCESS, status: 'failed', error: 'cancelled', cancelled: true },
				LOST_WORKER_ID,
			),
		).toBe(false);
		await vi.waitFor(() => expect(lost.send).toHaveBeenCalledTimes(2));
		expect(JSON.parse(String(lost.send.mock.calls[1][0]))).toMatchObject({
			type: 'task-assignment',
			dispatchId: DISPATCH_ID,
		});
		expect(resolveDispatchStreamTarget(DISPATCH_ID)).toMatchObject({ workerId: LOST_WORKER_ID });
		expect(isDispatchOrphanedFrom(LOST_WORKER_ID, DISPATCH_ID)).toBe(false);

		failOrphanedDispatchResultWait(DISPATCH_ID, 'transport lost');
		await expect(running).rejects.toMatchObject({ failure: { kind: 'transport-lost' } });
		takeOverOrphanedDispatch(DISPATCH_ID);
		deregisterConnection(LOST_WORKER_ID, lost);
	});

	it('defers the retry when the stopped worker never answers', async () => {
		vi.useFakeTimers();
		try {
			const lost = claimedWithConnectedOrphan();
			const job: SwarmJob = { ...createMockPmWebhookJob(), dispatchId: DISPATCH_ID };
			const running = executePhase(context(selectionFor(LOST_WORKER_ID, 'karolina_swarm'), job));
			const settled = expect(running).rejects.toBeInstanceOf(DeliveryDeferredError);

			await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

			await settled;
			expect(lost.send).toHaveBeenCalledTimes(1);
			expect(resolveDispatchStreamTarget(DISPATCH_ID)).toBeUndefined();
			deregisterConnection(LOST_WORKER_ID, lost);
		} finally {
			vi.useRealTimers();
		}
	});

	it('records the selection on the wait, so a later reap can adopt that worker’s late result', async () => {
		const retry = fakeWs();
		registerConnection(RETRY_WORKER_ID, retry);
		const selection = selectionFor(RETRY_WORKER_ID, 'm5_pro');
		const job: SwarmJob = { ...createMockPmWebhookJob(), dispatchId: DISPATCH_ID };
		const running = executePhase(context(selection, job));

		await vi.waitFor(() => expect(retry.send).toHaveBeenCalledTimes(1));
		// The reap: the wait ends as a `transport-lost` deferral, which the executor
		// raises for the shared failure path to defer.
		failOrphanedDispatchResultWait(DISPATCH_ID, 'transport lost');
		await expect(running).rejects.toMatchObject({ failure: { kind: 'transport-lost' } });
		const orphanedHook = vi.fn();
		deliverDispatchResult(LATE_SUCCESS, RETRY_WORKER_ID, orphanedHook);

		expect(orphanedHook).toHaveBeenCalledWith(
			expect.objectContaining({ workerId: RETRY_WORKER_ID, selection, trusted: true }),
			LATE_SUCCESS,
		);
		deregisterConnection(RETRY_WORKER_ID, retry);
	});
});
