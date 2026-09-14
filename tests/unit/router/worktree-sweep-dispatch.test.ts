import type { WSContext } from 'hono/ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectConfig } from '@/config/schema.js';
import type { Worker } from '@/identity/worker.js';
import type { WorkerEnrollment } from '@/identity/worker-enrollment.js';
import { deregisterConnection, registerConnection } from '@/router/worker-connections.js';
import {
	pushPendingWorktreeSweep,
	resendPendingWorktreeSweepToWorker,
	subscribeWorktreeSweepDispatch,
} from '@/router/worktree-sweep-dispatch.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

/**
 * The bridge from a recorded sweep request to a pushed frame (issue #955).
 *
 * Mocked like `worker-update-dispatch.test.ts` does, and for its reason: the Redis
 * subscription and the three Postgres reads are datastores, while the
 * connected-worker registry is the real one, because *which socket the frame lands
 * on* — and *what it says* — is the thing under test.
 */

const { subscribeToWorktreeSweepRequests, closeWorktreeSweepRedis } = vi.hoisted(() => ({
	subscribeToWorktreeSweepRequests:
		vi.fn<(onRequest: (workerId: string) => void) => { close: () => Promise<void> }>(),
	closeWorktreeSweepRedis: vi.fn<() => Promise<void>>(),
}));
vi.mock('@/queue/worker-sweeps.js', () => ({
	subscribeToWorktreeSweepRequests,
	closeWorktreeSweepRedis,
}));

const { getWorker } = vi.hoisted(() => ({
	getWorker: vi.fn<(id: string) => Promise<Worker | undefined>>(),
}));
vi.mock('@/identity/worker-service.js', () => ({ getWorker }));

const { listEnrollmentsForWorker } = vi.hoisted(() => ({
	listEnrollmentsForWorker: vi.fn<(workerId: string) => Promise<WorkerEnrollment[]>>(),
}));
vi.mock('@/db/repositories/workerEnrollmentsRepository.js', () => ({ listEnrollmentsForWorker }));

const { findProjectByIdFromDb } = vi.hoisted(() => ({
	findProjectByIdFromDb: vi.fn<(id: string) => Promise<ProjectConfig | undefined>>(),
}));
vi.mock('@/db/repositories/projectsRepository.js', () => ({ findProjectByIdFromDb }));

/** WebSocket `readyState`: OPEN. */
const OPEN = 1;

const WORKER_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OTHER_WORKER_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const REQUEST_ID = '77777777-7777-4777-8777-777777777777';

type FakeWs = WSContext & { send: ReturnType<typeof vi.fn>; readyState: number };

function fakeWs(): FakeWs {
	return { send: vi.fn(), close: vi.fn(), readyState: OPEN } as unknown as FakeWs;
}

function framesOn(ws: FakeWs): Array<Record<string, unknown>> {
	return ws.send.mock.calls.map((call) => JSON.parse(String(call[0])));
}

/** A worker row whose sweep state is whatever a case needs it to be. */
function workerWith(worktreeSweep: Worker['worktreeSweep']): Worker {
	return {
		id: WORKER_ID,
		ownerUserId: '22222222-2222-4222-8222-222222222222',
		displayName: 'ada-laptop',
		capabilities: ['claude'],
		probedCapabilities: ['claude'],
		declaredCapabilities: null,
		supportedPhases: ['review'],
		repository: null,
		drainingSince: null,
		build: null,
		update: null,
		worktreeSweep,
		createdAt: new Date(0),
		updatedAt: new Date(0),
	};
}

/** A request still awaiting an answer — what the push exists for. */
function pending(): Worker['worktreeSweep'] {
	return {
		requestId: REQUEST_ID,
		requestedAt: new Date('2026-09-13T10:05:00Z'),
		status: null,
		reportedAt: null,
		result: null,
	};
}

/** A request the machine has already answered: nothing is owed a push. */
function reported(): Worker['worktreeSweep'] {
	return {
		requestId: null,
		requestedAt: new Date('2026-09-13T10:05:00Z'),
		status: 'swept',
		reportedAt: new Date('2026-09-13T10:09:00Z'),
		result: {
			removed: [],
			removedCount: 0,
			keptLiveCount: 0,
			failedCount: 0,
			message: 'Swept 1 project(s): removed 0 abandoned checkout(s), kept 0 still in use.',
		},
	};
}

function enrollment(overrides: Partial<WorkerEnrollment> = {}): WorkerEnrollment {
	return {
		id: '99999999-9999-4999-8999-999999999999',
		workerId: WORKER_ID,
		projectId: 'swarm',
		status: 'active',
		allowedClis: ['claude'],
		allowedPhases: ['review'],
		concurrencyAllocation: 1,
		orderIndex: 0,
		sharingConsent: true,
		createdAt: new Date(0),
		updatedAt: new Date(0),
		...overrides,
	};
}

let connections: Array<{ workerId: string; ws: FakeWs }> = [];

function connect(workerId: string): FakeWs {
	const ws = fakeWs();
	registerConnection(workerId, ws);
	connections.push({ workerId, ws });
	return ws;
}

beforeEach(() => {
	subscribeToWorktreeSweepRequests.mockReset();
	closeWorktreeSweepRedis.mockReset();
	closeWorktreeSweepRedis.mockResolvedValue(undefined);
	getWorker.mockReset();
	listEnrollmentsForWorker.mockReset();
	listEnrollmentsForWorker.mockResolvedValue([enrollment()]);
	findProjectByIdFromDb.mockReset();
	findProjectByIdFromDb.mockImplementation(async (id: string) =>
		id === 'swarm'
			? createMockProjectConfig({ worktreeRetention: { abandonedAfterDays: 21 } })
			: undefined,
	);
	connections = [];
});

afterEach(() => {
	// The registry is module-level and real, so every test cleans up after itself.
	for (const { workerId, ws } of connections) deregisterConnection(workerId, ws);
});

describe('pushPendingWorktreeSweep', () => {
	it('pushes the pending request to that worker and nobody else', async () => {
		const target = connect(WORKER_ID);
		const bystander = connect(OTHER_WORKER_ID);
		getWorker.mockResolvedValue(workerWith(pending()));

		await expect(pushPendingWorktreeSweep(WORKER_ID)).resolves.toBe(true);

		expect(framesOn(target)).toEqual([
			{
				type: 'worktree-sweep',
				requestId: REQUEST_ID,
				projects: [
					{ projectId: 'swarm', worktreeRoot: '.swarm-workspaces', abandonedAfterDays: 21 },
				],
			},
		]);
		expect(framesOn(bystander)).toEqual([]);
	});

	// The channel carries a worker id and nothing else, so what a machine is asked to
	// sweep is whatever it is enrolled in *now* — not what it was when the request was
	// recorded, which may have been days earlier.
	it('builds the frame from the enrollments the machine has now', async () => {
		const ws = connect(WORKER_ID);
		getWorker.mockResolvedValue(workerWith(pending()));
		listEnrollmentsForWorker.mockResolvedValue([
			enrollment(),
			enrollment({ id: 'other', projectId: 'cascade' }),
		]);
		findProjectByIdFromDb.mockImplementation(async (id: string) =>
			createMockProjectConfig({ id, worktreeRoot: `.${id}-trees` }),
		);

		await pushPendingWorktreeSweep(WORKER_ID);

		expect(framesOn(ws)[0].projects).toEqual([
			{ projectId: 'swarm', worktreeRoot: '.swarm-trees', abandonedAfterDays: 10 },
			{ projectId: 'cascade', worktreeRoot: '.cascade-trees', abandonedAfterDays: 10 },
		]);
	});

	// Approval is the project side's acceptance of this machine; an enrollment that
	// never got it names a project this machine was never offered to.
	it('skips an enrollment the project never approved', async () => {
		const ws = connect(WORKER_ID);
		getWorker.mockResolvedValue(workerWith(pending()));
		listEnrollmentsForWorker.mockResolvedValue([
			enrollment({ status: 'pending' }),
			enrollment({ id: 'suspended', projectId: 'cascade', status: 'suspended' }),
		]);

		await expect(pushPendingWorktreeSweep(WORKER_ID)).resolves.toBe(false);
		expect(framesOn(ws)).toEqual([]);
	});

	// Sharing consent governs whether the project may be given *work* here, and a
	// sweep gives it none — a machine whose owner stopped offering it is exactly where
	// abandoned checkouts pile up.
	it('still sweeps a project whose sharing consent has been revoked', async () => {
		const ws = connect(WORKER_ID);
		getWorker.mockResolvedValue(workerWith(pending()));
		listEnrollmentsForWorker.mockResolvedValue([enrollment({ sharingConsent: false })]);

		await expect(pushPendingWorktreeSweep(WORKER_ID)).resolves.toBe(true);
		expect(framesOn(ws)[0].projects).toHaveLength(1);
	});

	// Nothing here knows what `worktreeRoot` a deleted project used, and guessing one
	// would name a directory on somebody's machine.
	it('skips an enrollment whose project no longer exists', async () => {
		const ws = connect(WORKER_ID);
		getWorker.mockResolvedValue(workerWith(pending()));
		listEnrollmentsForWorker.mockResolvedValue([
			enrollment({ projectId: 'deleted' }),
			enrollment({ id: 'live', projectId: 'swarm' }),
		]);

		await pushPendingWorktreeSweep(WORKER_ID);

		expect(framesOn(ws)[0].projects).toEqual([
			{ projectId: 'swarm', worktreeRoot: '.swarm-workspaces', abandonedAfterDays: 21 },
		]);
	});

	it('pushes nothing when the machine has no approved enrollment at all', async () => {
		const ws = connect(WORKER_ID);
		getWorker.mockResolvedValue(workerWith(pending()));
		listEnrollmentsForWorker.mockResolvedValue([]);

		await expect(pushPendingWorktreeSweep(WORKER_ID)).resolves.toBe(false);
		expect(framesOn(ws)).toEqual([]);
	});

	it('pushes nothing when the request has already been answered', async () => {
		const ws = connect(WORKER_ID);
		getWorker.mockResolvedValue(workerWith(reported()));

		await expect(pushPendingWorktreeSweep(WORKER_ID)).resolves.toBe(false);
		expect(framesOn(ws)).toEqual([]);
	});

	it('pushes nothing when nobody has asked this machine to sweep', async () => {
		const ws = connect(WORKER_ID);
		getWorker.mockResolvedValue(workerWith(null));

		await expect(pushPendingWorktreeSweep(WORKER_ID)).resolves.toBe(false);
		expect(framesOn(ws)).toEqual([]);
	});

	it('answers false for an unknown worker rather than throwing', async () => {
		getWorker.mockResolvedValue(undefined);

		await expect(pushPendingWorktreeSweep(WORKER_ID)).resolves.toBe(false);
	});

	// A machine that is away keeps its request: nothing is armed or settled on a
	// missed push, because an unanswered sweep leaves it working exactly as it was.
	it('leaves the request pending when the worker has no socket here', async () => {
		getWorker.mockResolvedValue(workerWith(pending()));

		await expect(pushPendingWorktreeSweep(WORKER_ID)).resolves.toBe(false);
	});
});

describe('resendPendingWorktreeSweepToWorker', () => {
	// The notification fires once, so the socket opening is where a request recorded
	// while the machine was away is stated again.
	it('pushes a pending request when the worker reconnects', async () => {
		const ws = connect(WORKER_ID);
		getWorker.mockResolvedValue(workerWith(pending()));

		resendPendingWorktreeSweepToWorker(WORKER_ID);
		await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());

		expect(framesOn(ws)[0]).toMatchObject({ type: 'worktree-sweep', requestId: REQUEST_ID });
	});

	// Fire-and-forget by contract: the transport's connection hooks stay synchronous,
	// so a socket that just opened must never fail on this.
	it('swallows a failed read rather than throwing into the socket-open hook', async () => {
		connect(WORKER_ID);
		getWorker.mockRejectedValue(new Error('database is down'));

		expect(() => resendPendingWorktreeSweepToWorker(WORKER_ID)).not.toThrow();
		await vi.waitFor(() => expect(getWorker).toHaveBeenCalled());
	});
});

describe('subscribeWorktreeSweepDispatch', () => {
	it('turns each notification into a push to the worker it names', async () => {
		const ws = connect(WORKER_ID);
		getWorker.mockResolvedValue(workerWith(pending()));
		let notify: ((workerId: string) => void) | undefined;
		subscribeToWorktreeSweepRequests.mockImplementation((onRequest) => {
			notify = onRequest;
			return { close: async () => {} };
		});

		const subscription = subscribeWorktreeSweepDispatch();
		notify?.(WORKER_ID);
		await vi.waitFor(() => expect(ws.send).toHaveBeenCalled());

		expect(framesOn(ws)[0]).toMatchObject({ type: 'worktree-sweep' });
		await subscription.close();
	});

	// Both halves, not just the subscriber: it is a duplicate of the shared client, so
	// quitting only the duplicate leaves the router on an open Redis socket.
	it('closes the subscriber and the shared client so the router can shut down cleanly', async () => {
		const close = vi.fn().mockResolvedValue(undefined);
		subscribeToWorktreeSweepRequests.mockReturnValue({ close });

		await subscribeWorktreeSweepDispatch().close();

		expect(close).toHaveBeenCalledTimes(1);
		expect(closeWorktreeSweepRedis).toHaveBeenCalledTimes(1);
	});
});
