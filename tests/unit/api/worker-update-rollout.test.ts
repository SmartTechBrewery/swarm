import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Issue #940 — the staged rollout's advance state machine. The seam under test is
 * everything the pass reads and writes: the rollout row (through the lock), the
 * machines behind its members, their live sessions, their run state, the drain
 * write, and phase 1's fan-out. All mocked in the shape
 * `tests/unit/api/worker-update-fanout.test.ts` already mocks its three, because
 * what this module decides is *which* of them happen and in what order, never what
 * any of them then does.
 *
 * The lock is mocked as a pass-through that hands the body a snapshot and records
 * the writes, so a test states the durable state a rollout is in and reads back the
 * durable state it moved to — which is exactly what a later advance, in production,
 * would see.
 */
const {
	advanceUnderRolloutLock,
	createRollout,
	findAnyInProgressOwnerRollout,
	findInProgressInstallationRollout,
	findInProgressRolloutForOwner,
	findLatestInstallationRollout,
	findLatestRolloutForOwner,
	findRolloutHoldElsewhere,
	readRollout,
} = vi.hoisted(() => ({
	advanceUnderRolloutLock: vi.fn(),
	createRollout: vi.fn(),
	findAnyInProgressOwnerRollout: vi.fn(),
	findInProgressInstallationRollout: vi.fn(),
	findInProgressRolloutForOwner: vi.fn(),
	findLatestInstallationRollout: vi.fn(),
	findLatestRolloutForOwner: vi.fn(),
	findRolloutHoldElsewhere: vi.fn(),
	readRollout: vi.fn(),
}));
const {
	getWorkers,
	listAllWorkers,
	listWorkersForOwner,
	setWorkerDraining,
	withdrawWorkerUpdateRequest,
} = vi.hoisted(() => ({
	getWorkers: vi.fn(),
	listAllWorkers: vi.fn(),
	listWorkersForOwner: vi.fn(),
	setWorkerDraining: vi.fn(),
	withdrawWorkerUpdateRequest: vi.fn(),
}));
const { getLiveSessionForWorker, getRetainedSessionForWorker } = vi.hoisted(() => ({
	getLiveSessionForWorker: vi.fn(),
	getRetainedSessionForWorker: vi.fn(),
}));
const { deriveWorkerRunState } = vi.hoisted(() => ({ deriveWorkerRunState: vi.fn() }));
const { fanOutWorkerUpdate } = vi.hoisted(() => ({ fanOutWorkerUpdate: vi.fn() }));

vi.mock('@/db/repositories/workerUpdateRolloutsRepository.js', () => ({
	advanceUnderRolloutLock,
	createRollout,
	findAnyInProgressOwnerRollout,
	findInProgressInstallationRollout,
	findInProgressRolloutForOwner,
	findLatestInstallationRollout,
	findLatestRolloutForOwner,
	findRolloutHoldElsewhere,
	readRollout,
}));
vi.mock('@/identity/worker-service.js', () => ({
	getWorkers,
	listAllWorkers,
	listWorkersForOwner,
	setWorkerDraining,
	withdrawWorkerUpdateRequest,
}));
vi.mock('@/identity/worker-session-service.js', () => ({
	getLiveSessionForWorker,
	getRetainedSessionForWorker,
}));
vi.mock('@/identity/worker-enrollment-service.js', () => ({ deriveWorkerRunState }));
vi.mock('@/api/worker-update-fanout.js', () => ({ fanOutWorkerUpdate }));

import {
	advanceRollout,
	getInstallationRollout,
	getRolloutForOwner,
	startRollout,
} from '@/api/worker-update-rollout.js';
import { DEFAULT_WORKER_SUPPORTED_PHASES, type Worker } from '@/identity/worker.js';
import type {
	WorkerUpdateRollout,
	WorkerUpdateRolloutMember,
} from '@/identity/worker-update-rollout.js';

const OWNER_ID = '00000000-0000-4000-8000-0000000000aa';
/** A second operator, for the installation scope — the machines the rollout does not belong to. */
const OTHER_OWNER_ID = '00000000-0000-4000-8000-0000000000bb';
/** Who asked for the update on a machine's row (issue #922) — the rollout's own requester. */
const REQUESTER_ID = OWNER_ID;
const ROLLOUT_ID = '99999999-9999-4999-8999-999999999999';
const WORKER_A = '11111111-1111-4111-8111-111111111111';
const WORKER_B = '22222222-2222-4222-8222-222222222222';
const WORKER_C = '33333333-3333-4333-8333-333333333333';
const REQUEST_A = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-09-13T12:00:00Z');

function makeWorker(id: string, overrides: Partial<Worker> = {}): Worker {
	return {
		id,
		ownerUserId: OWNER_ID,
		displayName: `machine-${id.slice(0, 1)}`,
		capabilities: ['claude'],
		probedCapabilities: ['claude'],
		declaredCapabilities: null,
		supportedPhases: [...DEFAULT_WORKER_SUPPORTED_PHASES],
		repository: null,
		// In the pool unless a case says otherwise — the rollout is what drains it.
		drainingSince: null,
		update: null,
		version: null,
		worktreeSweep: null,
		build: { commit: 'aaaaaaa', dirty: false },
		supervision: 'unknown',
		createdAt: new Date(0),
		updatedAt: new Date(0),
		...overrides,
	};
}

/** A `workers` row carrying the answer a machine gave to the rollout's own request. */
function reported(
	id: string,
	status: 'applied' | 'adopted' | 'already-current' | 'failed' | 'refused' | 'declined',
	overrides: Partial<Worker> = {},
): Worker {
	return makeWorker(id, {
		drainingSince: new Date('2026-09-13T11:00:00Z'),
		update: {
			requestId: null,
			target: 'main',
			requestedAt: new Date('2026-09-13T11:05:00Z'),
			requestedByUserId: REQUESTER_ID,
			status,
			message: status === 'failed' ? 'npm ci exited 1' : 'restarting',
			reportedAt: new Date('2026-09-13T11:50:00Z'),
		},
		...overrides,
	});
}

function makeRollout(overrides: Partial<WorkerUpdateRollout> = {}): WorkerUpdateRollout {
	return {
		id: ROLLOUT_ID,
		requestedByUserId: OWNER_ID,
		scope: 'owner',
		target: 'main',
		waveSize: 1,
		status: 'in_progress',
		haltReason: null,
		createdAt: new Date(0),
		updatedAt: new Date(0),
		...overrides,
	};
}

function makeMember(
	workerId: string,
	position: number,
	overrides: Partial<WorkerUpdateRolloutMember> = {},
): WorkerUpdateRolloutMember {
	return {
		workerId,
		position,
		state: 'queued',
		requestId: null,
		outcome: null,
		message: null,
		drainedByRollout: false,
		fencingTokenAtSignal: null,
		buildCommitAtSignal: null,
		signalledAt: null,
		settledAt: null,
		...overrides,
	};
}

/** The member patches one advance wrote, keyed by worker — what the next one would read. */
const memberWrites = new Map<string, Partial<WorkerUpdateRolloutMember>>();
/** The rollout status writes one advance made, in order. */
const statusWrites: { status: string; haltReason?: string | null }[] = [];

/**
 * Stand the lock up over a given durable state. The body is run for real against a
 * snapshot and a writer that records, which is what makes these tests about the
 * decisions rather than about drizzle.
 */
function givenRollout(rollout: WorkerUpdateRollout, members: WorkerUpdateRolloutMember[]): void {
	advanceUnderRolloutLock.mockImplementation(
		async (
			_id: string,
			body: (
				loaded: { rollout: WorkerUpdateRollout; members: WorkerUpdateRolloutMember[] },
				write: {
					setMember(workerId: string, patch: Partial<WorkerUpdateRolloutMember>): Promise<void>;
					setStatus(status: string, haltReason?: string | null): Promise<void>;
				},
			) => Promise<unknown>,
		) =>
			body(
				{ rollout, members },
				{
					async setMember(workerId, patch) {
						memberWrites.set(workerId, { ...(memberWrites.get(workerId) ?? {}), ...patch });
					},
					async setStatus(status, haltReason) {
						statusWrites.push({ status, haltReason });
					},
				},
			),
	);
}

/**
 * The member rows a **later** advance would load: the state this one started from
 * with only the patches that actually reached the row applied on top. Anything a
 * pass decided and kept in its own working copy is gone here, which is exactly the
 * difference these tests are for.
 */
function reloaded(members: WorkerUpdateRolloutMember[]): WorkerUpdateRolloutMember[] {
	return members.map((member) => ({ ...member, ...memberWrites.get(member.workerId) }));
}

/** The machines the pass will resolve behind its members. */
function givenWorkers(...workers: Worker[]): void {
	getWorkers.mockResolvedValue(workers);
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	memberWrites.clear();
	statusWrites.length = 0;
	for (const mock of [
		advanceUnderRolloutLock,
		createRollout,
		findAnyInProgressOwnerRollout,
		findInProgressInstallationRollout,
		findInProgressRolloutForOwner,
		findLatestInstallationRollout,
		findLatestRolloutForOwner,
		findRolloutHoldElsewhere,
		readRollout,
		getWorkers,
		listAllWorkers,
		listWorkersForOwner,
		setWorkerDraining,
		getLiveSessionForWorker,
		deriveWorkerRunState,
		fanOutWorkerUpdate,
	]) {
		mock.mockReset();
	}
	findAnyInProgressOwnerRollout.mockResolvedValue(undefined);
	findInProgressInstallationRollout.mockResolvedValue(undefined);
	findInProgressRolloutForOwner.mockResolvedValue(undefined);
	findLatestInstallationRollout.mockResolvedValue(undefined);
	findLatestRolloutForOwner.mockResolvedValue(undefined);
	// No other rollout holds any of these machines unless a test says one does.
	findRolloutHoldElsewhere.mockResolvedValue(undefined);
	getWorkers.mockResolvedValue([]);
	getLiveSessionForWorker.mockResolvedValue(undefined);
	// Heard from just now unless a test says otherwise, so the silence window never fires
	// by accident in a case that is about something else.
	getRetainedSessionForWorker.mockResolvedValue({ fencingToken: 1, lastHeartbeatAt: NOW });
	withdrawWorkerUpdateRequest.mockResolvedValue(undefined);
	deriveWorkerRunState.mockResolvedValue({ busy: false, currentRunId: null });
	fanOutWorkerUpdate.mockResolvedValue([]);
	// The drain write answers with the row as it now stands, which is what the fan-out
	// reads its eligibility from.
	setWorkerDraining.mockImplementation(async (id: string, draining: boolean) =>
		makeWorker(id, { drainingSince: draining ? NOW : null }),
	);
});

/** One fan-out entry, in the shape `fanOutWorkerUpdate` really answers with. */
function fanoutEntry(
	workerId: string,
	disposition: string,
	update: Partial<NonNullable<Worker['update']>> | null = { requestId: REQUEST_A },
) {
	return {
		workerId,
		displayName: `machine-${workerId.slice(0, 1)}`,
		disposition,
		update: update
			? {
					requestId: null,
					target: 'main',
					requestedAt: NOW,
					requestedByUserId: REQUESTER_ID,
					status: null,
					message: null,
					reportedAt: null,
					...update,
				}
			: null,
	};
}

describe('advanceRollout — taking a wave', () => {
	it('drains and signals at most waveSize machines, leaving the rest queued', async () => {
		givenRollout(makeRollout({ waveSize: 2 }), [
			makeMember(WORKER_A, 0),
			makeMember(WORKER_B, 1),
			makeMember(WORKER_C, 2),
		]);
		givenWorkers(makeWorker(WORKER_A), makeWorker(WORKER_B), makeWorker(WORKER_C));
		fanOutWorkerUpdate.mockResolvedValue([
			fanoutEntry(WORKER_A, 'requested'),
			fanoutEntry(WORKER_B, 'requested'),
		]);

		const view = await advanceRollout(ROLLOUT_ID);

		// Only the wave is taken out of the pool — the third machine is untouched, which
		// is the whole point of a bounded wave.
		expect(setWorkerDraining.mock.calls.map(([id, draining]) => [id, draining])).toEqual([
			[WORKER_A, true],
			[WORKER_B, true],
		]);
		expect(fanOutWorkerUpdate).toHaveBeenCalledExactlyOnceWith(
			[expect.objectContaining({ id: WORKER_A }), expect.objectContaining({ id: WORKER_B })],
			'main',
			// Issue #922 — the rollout's own requester, not whoever's tick advanced it.
			OWNER_ID,
		);
		expect(view?.members.map((member) => member.state)).toEqual([
			'signalled',
			'signalled',
			'queued',
		]);
		// Written to the row, not only to the pass's own copy — the next advance reads
		// durable state and nothing else.
		expect(memberWrites.get(WORKER_A)).toMatchObject({ state: 'signalled', requestId: REQUEST_A });
		expect(memberWrites.has(WORKER_C)).toBe(false);
	});

	// Draining never interrupts a run: a machine mid-phase waits in the wave rather
	// than being asked to restart under it.
	it('does not signal a machine that is still running a job', async () => {
		givenRollout(makeRollout({ waveSize: 2 }), [makeMember(WORKER_A, 0), makeMember(WORKER_B, 1)]);
		givenWorkers(makeWorker(WORKER_A), makeWorker(WORKER_B));
		deriveWorkerRunState.mockImplementation(async (id: string) => ({
			busy: id === WORKER_B,
			currentRunId: id === WORKER_B ? 'run-1' : null,
		}));
		fanOutWorkerUpdate.mockResolvedValue([fanoutEntry(WORKER_A, 'requested')]);

		const view = await advanceRollout(ROLLOUT_ID);

		expect(fanOutWorkerUpdate).toHaveBeenCalledExactlyOnceWith(
			[expect.objectContaining({ id: WORKER_A })],
			'main',
			OWNER_ID,
		);
		expect(view?.members.map((member) => member.state)).toEqual(['signalled', 'draining']);
	});

	// Issue #971 — a machine enrolled in no project settles rather than waits. Unlike
	// `in-pool`, which `reassertDrain` makes all but unreachable and which is therefore
	// left to be re-asked, nothing about advancing the rollout would ever change this
	// answer, so a waiting member would hold the wave open forever.
	it('settles a member enrolled in no project as skipped, and completes', async () => {
		givenRollout(makeRollout(), [makeMember(WORKER_A, 0)]);
		givenWorkers(makeWorker(WORKER_A));
		fanOutWorkerUpdate.mockResolvedValue([fanoutEntry(WORKER_A, 'no-project', null)]);

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.members[0]).toMatchObject({
			state: 'skipped',
			message: 'the machine is enrolled in no project',
		});
		expect(view?.members[0].settledAt).toBeInstanceOf(Date);
		// The rollout drained it and is not going to move it, so it goes back in the pool.
		expect(setWorkerDraining).toHaveBeenCalledWith(WORKER_A, false);
		expect(view?.rollout.status).toBe('completed');
	});

	// Issue #997 — word for word `no-project`'s reasoning: a machine that declared no
	// process supervisor will start its daemon again is reachable here, and nothing
	// about advancing the rollout would ever change that answer, so a waiting member
	// would hold the wave open forever.
	it('settles a member that declared it is unsupervised as skipped, and completes', async () => {
		givenRollout(makeRollout(), [makeMember(WORKER_A, 0)]);
		givenWorkers(makeWorker(WORKER_A, { supervision: 'unsupervised' }));
		fanOutWorkerUpdate.mockResolvedValue([fanoutEntry(WORKER_A, 'unsupervised', null)]);

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.members[0]).toMatchObject({
			state: 'skipped',
			message:
				'the machine is not under a process supervisor, so it would not come back from an update',
		});
		expect(view?.members[0].settledAt).toBeInstanceOf(Date);
		// The rollout drained it and is not going to move it, so it goes back in the pool.
		expect(setWorkerDraining).toHaveBeenCalledWith(WORKER_A, false);
		expect(view?.rollout.status).toBe('completed');
	});

	// It settles well, not badly, exactly as `no-project` does: a machine nothing would
	// restart is not a bad build, so it must not halt the wave for everybody else.
	it('does not halt the rollout for a member that declared it is unsupervised', async () => {
		givenRollout(makeRollout({ waveSize: 2 }), [makeMember(WORKER_A, 0), makeMember(WORKER_B, 1)]);
		givenWorkers(makeWorker(WORKER_A, { supervision: 'unsupervised' }), makeWorker(WORKER_B));
		fanOutWorkerUpdate.mockResolvedValue([
			fanoutEntry(WORKER_A, 'unsupervised', null),
			fanoutEntry(WORKER_B, 'requested'),
		]);

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.rollout.status).toBe('in_progress');
		expect(view?.members.map((member) => member.state)).toEqual(['skipped', 'signalled']);
	});

	// It settles well, not badly: a machine that cannot be recorded against a project is
	// not a bad build, so it must not halt the rollout for everybody else.
	it('does not halt the rollout for a member enrolled in no project', async () => {
		givenRollout(makeRollout({ waveSize: 2 }), [makeMember(WORKER_A, 0), makeMember(WORKER_B, 1)]);
		givenWorkers(makeWorker(WORKER_A), makeWorker(WORKER_B));
		fanOutWorkerUpdate.mockResolvedValue([
			fanoutEntry(WORKER_A, 'no-project', null),
			fanoutEntry(WORKER_B, 'requested'),
		]);

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.rollout.status).toBe('in_progress');
		expect(view?.members.map((member) => member.state)).toEqual(['skipped', 'signalled']);
	});

	// The rollout borrows a drain; it does not create one it will later undo.
	it('records that it drained a machine only when that machine was in the pool', async () => {
		givenRollout(makeRollout({ waveSize: 2 }), [makeMember(WORKER_A, 0), makeMember(WORKER_B, 1)]);
		givenWorkers(
			makeWorker(WORKER_A),
			makeWorker(WORKER_B, { drainingSince: new Date('2026-09-01T00:00:00Z') }),
		);
		fanOutWorkerUpdate.mockResolvedValue([
			fanoutEntry(WORKER_A, 'requested'),
			fanoutEntry(WORKER_B, 'requested'),
		]);

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.members.map((member) => member.drainedByRollout)).toEqual([true, false]);
	});

	// The next wave is gated on the previous one *settling*, not on it being signalled.
	it('starts no new wave while a member is still in flight', async () => {
		givenRollout(makeRollout({ waveSize: 1 }), [
			makeMember(WORKER_A, 0, { state: 'signalled', requestId: REQUEST_A, drainedByRollout: true }),
			makeMember(WORKER_B, 1),
		]);
		givenWorkers(
			makeWorker(WORKER_A, {
				drainingSince: NOW,
				update: {
					requestId: REQUEST_A,
					target: 'main',
					requestedAt: NOW,
					requestedByUserId: REQUESTER_ID,
					status: null,
					message: null,
					reportedAt: null,
				},
			}),
			makeWorker(WORKER_B),
		);

		const view = await advanceRollout(ROLLOUT_ID);

		expect(fanOutWorkerUpdate).not.toHaveBeenCalled();
		expect(view?.members.map((member) => member.state)).toEqual(['signalled', 'queued']);
	});

	// A member decided the instant it is asked produces no update report and no
	// handshake, so nothing but the periodic tick could reach the machine behind it —
	// a whole minute of waiting for an answer no machine was ever going to give. The
	// wave bound is per wave, not per pass, so the pass takes another one.
	it('takes another wave in the same advance when the first settled without being signalled', async () => {
		givenRollout(makeRollout({ waveSize: 1 }), [makeMember(WORKER_A, 0), makeMember(WORKER_B, 1)]);
		givenWorkers(makeWorker(WORKER_A, { supervision: 'unsupervised' }), makeWorker(WORKER_B));
		fanOutWorkerUpdate
			.mockResolvedValueOnce([fanoutEntry(WORKER_A, 'unsupervised', null)])
			.mockResolvedValueOnce([fanoutEntry(WORKER_B, 'requested')]);

		const view = await advanceRollout(ROLLOUT_ID);

		// Two waves, one machine each: the bound held, the pass simply did not end on
		// the wave that evaporated.
		expect(fanOutWorkerUpdate).toHaveBeenCalledTimes(2);
		expect(view?.members.map((member) => member.state)).toEqual(['skipped', 'signalled']);
		expect(view?.rollout.status).toBe('in_progress');
	});

	// The measured shape (2026-09-18): four machines in a row declaring no supervisor,
	// which used to cost four ticks and now costs none.
	it('walks through a run of members that all settle at once, and completes', async () => {
		givenRollout(makeRollout({ waveSize: 1 }), [
			makeMember(WORKER_A, 0),
			makeMember(WORKER_B, 1),
			makeMember(WORKER_C, 2),
		]);
		givenWorkers(
			makeWorker(WORKER_A, { supervision: 'unsupervised' }),
			makeWorker(WORKER_B, { supervision: 'unsupervised' }),
			makeWorker(WORKER_C, { supervision: 'unsupervised' }),
		);
		fanOutWorkerUpdate
			.mockResolvedValueOnce([fanoutEntry(WORKER_A, 'unsupervised', null)])
			.mockResolvedValueOnce([fanoutEntry(WORKER_B, 'unsupervised', null)])
			.mockResolvedValueOnce([fanoutEntry(WORKER_C, 'unsupervised', null)]);

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.members.map((member) => member.state)).toEqual(['skipped', 'skipped', 'skipped']);
		// Every one of them was drained and put straight back, and the rollout finished
		// in this single pass rather than over three ticks.
		expect(view?.rollout.status).toBe('completed');
	});
});

/**
 * The rollout is advanced by the operator, one pass at a time, so the pass that
 * takes a machine into a wave is almost never the pass that settles it. Everything a
 * wave decides therefore has to survive being written down and read back — above all
 * `drainedByRollout`, which can only be decided *before* the rollout drains the
 * machine and can never be re-derived afterwards.
 */
describe('advanceRollout — what one advance leaves for the next', () => {
	it('undrains a machine it took from the pool, settled by a later advance', async () => {
		const queued = [makeMember(WORKER_A, 0)];
		givenRollout(makeRollout(), queued);
		givenWorkers(makeWorker(WORKER_A));
		fanOutWorkerUpdate.mockResolvedValue([fanoutEntry(WORKER_A, 'requested')]);

		await advanceRollout(ROLLOUT_ID);

		// The drain decision is on the row, not only in the pass that reached it.
		expect(memberWrites.get(WORKER_A)).toMatchObject({
			state: 'signalled',
			drainedByRollout: true,
		});

		// Second advance: the machine has applied and is restarting.
		const signalled = reloaded(queued);
		givenRollout(makeRollout(), signalled);
		givenWorkers(reported(WORKER_A, 'applied'));
		expect(signalled[0]).toMatchObject({ state: 'signalled', drainedByRollout: true });

		await advanceRollout(ROLLOUT_ID);

		// Third advance: it is back, on a commit it was not on before.
		const verifying = reloaded(signalled);
		givenRollout(makeRollout(), verifying);
		givenWorkers(reported(WORKER_A, 'applied', { build: { commit: 'bbbbbbb', dirty: false } }));
		getLiveSessionForWorker.mockResolvedValue({ fencingToken: 8 });
		expect(verifying[0]).toMatchObject({ state: 'verifying', drainedByRollout: true });

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.members[0].state).toBe('done');
		expect(setWorkerDraining).toHaveBeenCalledWith(WORKER_A, false);
	});

	// A busy machine is drained by one advance and asked by another, so the pass that
	// signals it is already looking at a machine this rollout has drained — the only
	// record of who drained it is the one the first pass wrote.
	it('keeps the drain it owns over a machine that stays busy across advances', async () => {
		const queued = [makeMember(WORKER_A, 0)];
		givenRollout(makeRollout(), queued);
		givenWorkers(makeWorker(WORKER_A));
		deriveWorkerRunState.mockResolvedValue({ busy: true, currentRunId: 'run-1' });

		await advanceRollout(ROLLOUT_ID);

		expect(setWorkerDraining).toHaveBeenCalledWith(WORKER_A, true);
		expect(fanOutWorkerUpdate).not.toHaveBeenCalled();
		expect(memberWrites.get(WORKER_A)).toMatchObject({
			state: 'draining',
			drainedByRollout: true,
		});

		// Second advance: the run has finished, and the machine is drained — by this
		// rollout, which is a fact no snapshot taken now could still tell it.
		const draining = reloaded(queued);
		givenRollout(makeRollout(), draining);
		givenWorkers(makeWorker(WORKER_A, { drainingSince: NOW }));
		deriveWorkerRunState.mockResolvedValue({ busy: false, currentRunId: null });
		fanOutWorkerUpdate.mockResolvedValue([fanoutEntry(WORKER_A, 'requested')]);

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.members[0]).toMatchObject({ state: 'signalled', drainedByRollout: true });

		// Third advance: it had the build already, so it settles and goes back in the pool.
		const signalled = reloaded(draining);
		givenRollout(makeRollout(), signalled);
		givenWorkers(reported(WORKER_A, 'already-current'));

		await advanceRollout(ROLLOUT_ID);

		expect(setWorkerDraining).toHaveBeenCalledWith(WORKER_A, false);
	});

	// The operator's own drain is theirs; the rollout borrowed the machine, it did not
	// take it out of the pool, so no later advance may put it back.
	it('never undrains a machine the operator had already drained', async () => {
		const queued = [makeMember(WORKER_A, 0)];
		givenRollout(makeRollout(), queued);
		givenWorkers(makeWorker(WORKER_A, { drainingSince: new Date('2026-09-01T00:00:00Z') }));
		fanOutWorkerUpdate.mockResolvedValue([fanoutEntry(WORKER_A, 'requested')]);

		await advanceRollout(ROLLOUT_ID);

		expect(memberWrites.get(WORKER_A)).toMatchObject({ drainedByRollout: false });

		const signalled = reloaded(queued);
		givenRollout(makeRollout(), signalled);
		givenWorkers(reported(WORKER_A, 'already-current'));

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.members[0].state).toBe('done');
		expect(setWorkerDraining).not.toHaveBeenCalledWith(WORKER_A, false);
	});
});

describe('advanceRollout — settling what a machine reported', () => {
	function signalled(overrides: Partial<WorkerUpdateRolloutMember> = {}) {
		return makeMember(WORKER_A, 0, {
			state: 'signalled',
			requestId: REQUEST_A,
			drainedByRollout: true,
			fencingTokenAtSignal: 7,
			buildCommitAtSignal: 'aaaaaaa',
			signalledAt: new Date('2026-09-13T11:05:00Z'),
			...overrides,
		});
	}

	it('moves a machine that applied on to verification rather than settling it', async () => {
		givenRollout(makeRollout(), [signalled(), makeMember(WORKER_B, 1)]);
		givenWorkers(reported(WORKER_A, 'applied'), makeWorker(WORKER_B));

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.members[0]).toMatchObject({ state: 'verifying', outcome: 'applied' });
		// Still in flight, so the second machine is not drained.
		expect(setWorkerDraining).not.toHaveBeenCalled();
		expect(view?.members[1].state).toBe('queued');
	});

	// A peer on the same machine did the fetch and this daemon is restarting onto what
	// it landed (issue #973) — a success, and one that still has to come back.
	it('moves a machine that adopted a peer build on to verification too', async () => {
		givenRollout(makeRollout(), [signalled(), makeMember(WORKER_B, 1)]);
		givenWorkers(reported(WORKER_A, 'adopted'), makeWorker(WORKER_B));

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.members[0]).toMatchObject({ state: 'verifying', outcome: 'adopted' });
		expect(setWorkerDraining).not.toHaveBeenCalled();
		expect(view?.members[1].state).toBe('queued');
	});

	// Nothing was installed and nothing restarted, so there is nothing to come back from.
	it('settles already-current at once and returns the machine to the pool', async () => {
		givenRollout(makeRollout(), [signalled()]);
		givenWorkers(reported(WORKER_A, 'already-current'));

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.members[0]).toMatchObject({ state: 'done', outcome: 'already-current' });
		expect(setWorkerDraining).toHaveBeenCalledWith(WORKER_A, false);
		expect(statusWrites).toEqual([{ status: 'completed', haltReason: undefined }]);
	});

	it.each([
		'failed',
		'refused',
		'declined',
	] as const)('halts the whole rollout when a machine reports %s, quoting the machine', async (status) => {
		givenRollout(makeRollout(), [signalled(), makeMember(WORKER_B, 1)]);
		givenWorkers(reported(WORKER_A, status), makeWorker(WORKER_B));

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.rollout.status).toBe('halted');
		expect(view?.rollout.haltReason).toContain(status);
		expect(view?.members[0]).toMatchObject({ state: 'failed', outcome: status });
		// Nothing further is drained or signalled, and the untouched machine is settled
		// as skipped rather than left looking like it is still coming.
		expect(fanOutWorkerUpdate).not.toHaveBeenCalled();
		expect(view?.members[1].state).toBe('skipped');
	});

	// The machine that could not take the build is exactly the one an operator has to
	// look at, so it stays out of the pool.
	it('leaves a failed machine drained while returning the untouched ones', async () => {
		givenRollout(makeRollout(), [
			signalled(),
			makeMember(WORKER_B, 1, { state: 'draining', drainedByRollout: true }),
		]);
		givenWorkers(reported(WORKER_A, 'failed'), makeWorker(WORKER_B, { drainingSince: NOW }));

		await advanceRollout(ROLLOUT_ID);

		expect(setWorkerDraining).not.toHaveBeenCalledWith(WORKER_A, false);
		expect(setWorkerDraining).toHaveBeenCalledWith(WORKER_B, false);
	});

	// A machine another session re-targeted has nothing left for *this* rollout to
	// verify — and nothing has said the build is bad, so it must not halt.
	it('skips a member whose request another session replaced, without halting', async () => {
		givenRollout(makeRollout(), [signalled()]);
		givenWorkers(
			makeWorker(WORKER_A, {
				drainingSince: NOW,
				update: {
					requestId: '77777777-7777-4777-8777-777777777777',
					target: 'some-other-branch',
					requestedAt: NOW,
					requestedByUserId: REQUESTER_ID,
					status: null,
					message: null,
					reportedAt: null,
				},
			}),
		);

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.members[0].state).toBe('skipped');
		expect(view?.rollout.status).toBe('completed');
	});
});

describe('advanceRollout — a signalled machine that stops answering', () => {
	/** A member asked and still waiting: its `workers` row carries the rollout's own request. */
	function signalled(overrides: Partial<WorkerUpdateRolloutMember> = {}) {
		return makeMember(WORKER_A, 0, {
			state: 'signalled',
			requestId: REQUEST_A,
			drainedByRollout: true,
			signalledAt: new Date('2026-09-13T11:05:00Z'),
			...overrides,
		});
	}

	/** The machine's row, with this rollout's request still outstanding and unanswered. */
	function waiting(): Worker {
		return makeWorker(WORKER_A, {
			drainingSince: new Date('2026-09-13T11:00:00Z'),
			update: {
				requestId: REQUEST_A,
				target: 'main',
				requestedAt: new Date('2026-09-13T11:05:00Z'),
				requestedByUserId: REQUESTER_ID,
				status: null,
				message: null,
				reportedAt: null,
			},
		});
	}

	/** Offline, and last heard from this many minutes before the pass. */
	function silentFor(minutes: number): void {
		getLiveSessionForWorker.mockResolvedValue(undefined);
		getRetainedSessionForWorker.mockResolvedValue({
			fencingToken: 1,
			lastHeartbeatAt: new Date(NOW.getTime() - minutes * 60_000),
		});
	}

	// The whole point: before this, such a member waited for ever and its machine stayed
	// out of the dispatch pool with only a manual undrain — by its owner — to recover it.
	it('settles it and puts the machine back in the pool once it has been silent too long', async () => {
		givenRollout(makeRollout(), [signalled()]);
		givenWorkers(waiting());
		silentFor(6);

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.members[0].state).toBe('skipped');
		expect(setWorkerDraining).toHaveBeenCalledWith(WORKER_A, false);
	});

	// A machine nobody can reach has said nothing about the build, so stopping the fleet
	// over it would turn one dead laptop into a stalled rollout.
	it('does not halt the rollout, and does not count the machine as done', async () => {
		givenRollout(makeRollout(), [signalled()]);
		givenWorkers(waiting());
		silentFor(6);

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.rollout.haltReason).toBeNull();
		expect(view?.rollout.status).not.toBe('halted');
		expect(view?.members[0].state).not.toBe('done');
		expect(view?.members[0].state).not.toBe('failed');
	});

	// Without this the machine is handed the very request it gave up on, by
	// `resendPendingWorkerUpdateToWorker`, while it is back in the dispatch pool — so it
	// would exit to apply an update with work already dispatched to it.
	it('withdraws the outstanding request it gave up on', async () => {
		givenRollout(makeRollout(), [signalled()]);
		givenWorkers(waiting());
		silentFor(6);

		await advanceRollout(ROLLOUT_ID);

		expect(withdrawWorkerUpdateRequest).toHaveBeenCalledWith(WORKER_A, REQUEST_A);
	});

	// Slowness is not the failure being caught: the apply itself happens in this state,
	// and a machine holding its session is answerable however long its build takes.
	it('leaves a machine that still holds a session alone, however long it has been', async () => {
		givenRollout(makeRollout(), [signalled()]);
		givenWorkers(waiting());
		getLiveSessionForWorker.mockResolvedValue({ fencingToken: 1 });
		getRetainedSessionForWorker.mockResolvedValue({
			fencingToken: 1,
			lastHeartbeatAt: new Date(NOW.getTime() - 60 * 60_000),
		});

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.members[0].state).toBe('signalled');
		expect(withdrawWorkerUpdateRequest).not.toHaveBeenCalled();
		expect(setWorkerDraining).not.toHaveBeenCalledWith(WORKER_A, false);
	});

	// The daemon exits and reconnects as a matter of course, and a supervisor restarts a
	// crashed one within seconds, so a brief absence must not end the wait.
	it('keeps waiting on a machine that has only just gone quiet', async () => {
		givenRollout(makeRollout(), [signalled()]);
		givenWorkers(waiting());
		silentFor(2);

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.members[0].state).toBe('signalled');
		expect(withdrawWorkerUpdateRequest).not.toHaveBeenCalled();
	});

	// A machine that never connected at all has no heartbeat to measure from, so the
	// instant it was signalled is what the window runs from.
	it('measures from the signal for a machine that has never connected', async () => {
		givenRollout(makeRollout(), [signalled({ signalledAt: new Date(NOW.getTime() - 6 * 60_000) })]);
		givenWorkers(waiting());
		getLiveSessionForWorker.mockResolvedValue(undefined);
		getRetainedSessionForWorker.mockResolvedValue(undefined);

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.members[0].state).toBe('skipped');
		expect(setWorkerDraining).toHaveBeenCalledWith(WORKER_A, false);
	});

	// The drain is the rollout's to return only where the rollout took it.
	it('never undrains a machine the operator had drained themselves', async () => {
		givenRollout(makeRollout(), [signalled({ drainedByRollout: false })]);
		givenWorkers(waiting());
		silentFor(6);

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.members[0].state).toBe('skipped');
		expect(setWorkerDraining).not.toHaveBeenCalledWith(WORKER_A, false);
	});
});

describe('advanceRollout — verifying that a machine came back on the new build', () => {
	function verifying(overrides: Partial<WorkerUpdateRolloutMember> = {}) {
		return makeMember(WORKER_A, 0, {
			state: 'verifying',
			requestId: null,
			outcome: 'applied',
			drainedByRollout: true,
			fencingTokenAtSignal: 7,
			buildCommitAtSignal: 'aaaaaaa',
			signalledAt: new Date('2026-09-13T11:05:00Z'),
			...overrides,
		});
	}

	it('settles a machine whose daemon took a fresh lease on a new commit, and undrains it', async () => {
		givenRollout(makeRollout(), [verifying()]);
		givenWorkers(reported(WORKER_A, 'applied', { build: { commit: 'bbbbbbb', dirty: false } }));
		getLiveSessionForWorker.mockResolvedValue({ fencingToken: 8 });

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.members[0].state).toBe('done');
		expect(setWorkerDraining).toHaveBeenCalledWith(WORKER_A, false);
		expect(view?.rollout.status).toBe('completed');
	});

	// The come-back verdict is about the machine, not about which daemon on it paid for
	// the fetch, so an adopting one settles by exactly the same two facts.
	it('settles a machine that adopted a peer build once it comes back on it', async () => {
		givenRollout(makeRollout(), [verifying({ outcome: 'adopted' })]);
		givenWorkers(reported(WORKER_A, 'adopted', { build: { commit: 'bbbbbbb', dirty: false } }));
		getLiveSessionForWorker.mockResolvedValue({ fencingToken: 8 });

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.members[0].state).toBe('done');
		expect(setWorkerDraining).toHaveBeenCalledWith(WORKER_A, false);
		expect(view?.rollout.status).toBe('completed');
	});

	// The lease alone answers "came back", not "came back on the new build": a machine
	// that returned itself to its last known good build (issue #934) bumps the token too.
	it('halts when the machine comes back on the very build it was asked to leave', async () => {
		givenRollout(makeRollout(), [verifying()]);
		givenWorkers(reported(WORKER_A, 'applied', { build: { commit: 'aaaaaaa', dirty: false } }));
		getLiveSessionForWorker.mockResolvedValue({ fencingToken: 8 });

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.rollout.status).toBe('halted');
		expect(view?.rollout.haltReason).toContain('aaaaaaa');
		expect(view?.members[0].state).toBe('failed');
	});

	it('keeps waiting while the machine is inside its come-back window', async () => {
		givenRollout(makeRollout(), [verifying()]);
		givenWorkers(reported(WORKER_A, 'applied'));
		// Reported `applied` ten minutes before "now" minus a margin — still restarting.
		vi.setSystemTime(new Date('2026-09-13T11:55:00Z'));

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.members[0].state).toBe('verifying');
		expect(view?.rollout.status).toBe('in_progress');
	});

	// A build that cannot start says nothing at all, so silence has to be the verdict.
	it('halts when the machine never comes back inside the window', async () => {
		givenRollout(makeRollout(), [verifying(), makeMember(WORKER_B, 1)]);
		givenWorkers(reported(WORKER_A, 'applied'), makeWorker(WORKER_B));
		vi.setSystemTime(new Date('2026-09-13T13:00:00Z'));

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.rollout.status).toBe('halted');
		expect(view?.rollout.haltReason).toContain('has not come back');
		expect(view?.members.map((member) => member.state)).toEqual(['failed', 'skipped']);
	});

	// No live session at signal time means there was no token to beat, so any live
	// session afterwards is the daemon that came back.
	it('accepts any live session when there was no fencing token at signal time', async () => {
		givenRollout(makeRollout(), [
			verifying({ fencingTokenAtSignal: null, buildCommitAtSignal: null }),
		]);
		givenWorkers(reported(WORKER_A, 'applied', { build: null }));
		getLiveSessionForWorker.mockResolvedValue({ fencingToken: 1 });

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.members[0].state).toBe('done');
	});
});

describe('advanceRollout — after a halt', () => {
	it('drains and signals nothing further, and stands the queued machines down', async () => {
		givenRollout(makeRollout({ status: 'halted', haltReason: 'worker reported failed' }), [
			makeMember(WORKER_A, 0, { state: 'failed', outcome: 'failed', settledAt: NOW }),
			makeMember(WORKER_B, 1),
			makeMember(WORKER_C, 2),
		]);
		givenWorkers(makeWorker(WORKER_A), makeWorker(WORKER_B), makeWorker(WORKER_C));

		const view = await advanceRollout(ROLLOUT_ID);

		expect(fanOutWorkerUpdate).not.toHaveBeenCalled();
		expect(setWorkerDraining).not.toHaveBeenCalledWith(WORKER_B, true);
		expect(view?.members.map((member) => member.state)).toEqual(['failed', 'skipped', 'skipped']);
		// Halted is terminal: nothing promotes it to completed, however the rest settle.
		expect(view?.rollout.status).toBe('halted');
		expect(statusWrites).toEqual([]);
	});

	// A machine mid-flight when the rollout stopped still has an answer worth recording.
	it('goes on settling a member that was already signalled', async () => {
		givenRollout(makeRollout({ status: 'halted', haltReason: 'worker reported failed' }), [
			makeMember(WORKER_A, 0, {
				state: 'signalled',
				requestId: REQUEST_A,
				drainedByRollout: true,
			}),
		]);
		givenWorkers(reported(WORKER_A, 'already-current'));

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.members[0].state).toBe('done');
		expect(setWorkerDraining).toHaveBeenCalledWith(WORKER_A, false);
	});

	// The state the stranding was actually observed in (issue #1023): a member left
	// `verifying` by the halt is the one whose machine has already been taken out of the
	// pool and restarted, so nothing but a later advance can put it back.
	it('goes on verifying a member that was already applying, and returns it to the pool', async () => {
		givenRollout(makeRollout({ status: 'halted', haltReason: 'worker reported failed' }), [
			makeMember(WORKER_A, 0, {
				state: 'verifying',
				outcome: 'applied',
				drainedByRollout: true,
				fencingTokenAtSignal: 7,
				buildCommitAtSignal: 'aaaaaaa',
				signalledAt: new Date('2026-09-13T11:05:00Z'),
			}),
		]);
		givenWorkers(reported(WORKER_A, 'applied', { build: { commit: 'bbbbbbb', dirty: false } }));
		getLiveSessionForWorker.mockResolvedValue({ fencingToken: 8 });

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.members[0].state).toBe('done');
		expect(setWorkerDraining).toHaveBeenCalledWith(WORKER_A, false);
		// Halted stays halted: settling its last member never promotes it to completed.
		expect(view?.rollout.status).toBe('halted');
		expect(statusWrites).toEqual([]);
	});

	// The hazard the halted rollout's new advanceability opens (issue #1023): a halt
	// never blocks the operator's next rollout, so the replacement one is routinely
	// holding a machine this one has not finished settling. Undraining there would put a
	// machine that is mid-update back in the dispatch pool.
	it('settles a member the newer rollout has taken over without returning it to the pool', async () => {
		givenRollout(makeRollout({ status: 'halted', haltReason: 'worker reported failed' }), [
			makeMember(WORKER_A, 0, {
				state: 'signalled',
				requestId: REQUEST_A,
				drainedByRollout: true,
			}),
		]);
		// The machine's own row now carries the *newer* rollout's request id, which is
		// what makes this member `skipped` rather than answered.
		givenWorkers(
			makeWorker(WORKER_A, {
				drainingSince: new Date('2026-09-13T11:00:00Z'),
				update: {
					requestId: '77777777-7777-4777-8777-777777777777',
					target: 'v3',
					requestedAt: new Date('2026-09-13T11:40:00Z'),
					requestedByUserId: REQUESTER_ID,
					status: null,
					message: null,
					reportedAt: null,
				},
			}),
		);
		findRolloutHoldElsewhere.mockResolvedValue({ drainedByRollout: false });

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.members[0].state).toBe('skipped');
		expect(findRolloutHoldElsewhere).toHaveBeenCalledWith(WORKER_A, ROLLOUT_ID);
		expect(setWorkerDraining).not.toHaveBeenCalledWith(WORKER_A, false);
	});

	// The same rule for the other committed state: a member that came back on the new
	// build settles `done` on its own merits, and still leaves the drain alone.
	it('settles a verifying member well without undraining a machine another rollout holds', async () => {
		givenRollout(makeRollout({ status: 'halted', haltReason: 'worker reported failed' }), [
			makeMember(WORKER_A, 0, {
				state: 'verifying',
				outcome: 'applied',
				drainedByRollout: true,
				fencingTokenAtSignal: 7,
				buildCommitAtSignal: 'aaaaaaa',
				signalledAt: new Date('2026-09-13T11:05:00Z'),
			}),
		]);
		givenWorkers(reported(WORKER_A, 'applied', { build: { commit: 'bbbbbbb', dirty: false } }));
		getLiveSessionForWorker.mockResolvedValue({ fencingToken: 8 });
		findRolloutHoldElsewhere.mockResolvedValue({ drainedByRollout: false });

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.members[0].state).toBe('done');
		expect(setWorkerDraining).not.toHaveBeenCalledWith(WORKER_A, false);
	});
});

describe('advanceRollout — a machine two of the owner’s rollouts hold', () => {
	// The other half of the hand-off (issue #1023). The newer rollout takes a machine the
	// halted one still has drained: that drain is a rollout's, not the operator's, so it
	// is inherited rather than left behind — otherwise nobody would ever put the machine
	// back and the stranding this issue fixes would simply move one rollout along.
	it('inherits the drain of a machine another rollout took out of the pool', async () => {
		givenRollout(makeRollout(), [makeMember(WORKER_A, 0)]);
		givenWorkers(makeWorker(WORKER_A, { drainingSince: new Date('2026-09-13T11:00:00Z') }));
		findRolloutHoldElsewhere.mockResolvedValue({ drainedByRollout: true });
		fanOutWorkerUpdate.mockResolvedValue([fanoutEntry(WORKER_A, 'requested')]);

		await advanceRollout(ROLLOUT_ID);

		expect(findRolloutHoldElsewhere).toHaveBeenCalledWith(WORKER_A, ROLLOUT_ID);
		expect(memberWrites.get(WORKER_A)).toMatchObject({ drainedByRollout: true });
	});

	// An operator's own drain is still never inherited: no rollout holds the machine, so
	// the drain is theirs and stays theirs.
	it('leaves the operator’s own drain alone when no other rollout holds the machine', async () => {
		givenRollout(makeRollout(), [makeMember(WORKER_A, 0)]);
		givenWorkers(makeWorker(WORKER_A, { drainingSince: new Date('2026-09-13T11:00:00Z') }));
		findRolloutHoldElsewhere.mockResolvedValue(undefined);
		fanOutWorkerUpdate.mockResolvedValue([fanoutEntry(WORKER_A, 'requested')]);

		await advanceRollout(ROLLOUT_ID);

		expect(memberWrites.get(WORKER_A)).toMatchObject({ drainedByRollout: false });
	});

	// A machine still in the pool is plainly this rollout's to drain and to give back, so
	// the cross-rollout question is never asked at all.
	it('does not ask who holds a machine that is still in the pool', async () => {
		givenRollout(makeRollout(), [makeMember(WORKER_A, 0)]);
		givenWorkers(makeWorker(WORKER_A));
		fanOutWorkerUpdate.mockResolvedValue([fanoutEntry(WORKER_A, 'requested')]);

		await advanceRollout(ROLLOUT_ID);

		expect(findRolloutHoldElsewhere).not.toHaveBeenCalled();
		expect(memberWrites.get(WORKER_A)).toMatchObject({ drainedByRollout: true });
	});

	// Whichever of the two settles last is the one that puts the machine back: once the
	// other rollout has finished with it, there is no hold and the undrain happens.
	it('returns the machine to the pool once no other rollout holds it', async () => {
		givenRollout(makeRollout({ status: 'halted', haltReason: 'worker reported failed' }), [
			makeMember(WORKER_A, 0, {
				state: 'signalled',
				requestId: REQUEST_A,
				drainedByRollout: true,
			}),
		]);
		givenWorkers(reported(WORKER_A, 'already-current'));
		findRolloutHoldElsewhere.mockResolvedValue(undefined);

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.members[0].state).toBe('done');
		expect(setWorkerDraining).toHaveBeenCalledWith(WORKER_A, false);
	});
});

describe('startRollout', () => {
	it('records the caller’s own machines in list order and advances the first wave', async () => {
		const workers = [makeWorker(WORKER_A), makeWorker(WORKER_B)];
		listWorkersForOwner.mockResolvedValue(workers);
		createRollout.mockResolvedValue({ rollout: makeRollout(), members: [] });
		givenRollout(makeRollout(), [makeMember(WORKER_A, 0), makeMember(WORKER_B, 1)]);
		givenWorkers(...workers);
		fanOutWorkerUpdate.mockResolvedValue([fanoutEntry(WORKER_A, 'requested')]);

		const result = await startRollout({
			ownerUserId: OWNER_ID,
			scope: 'owner',
			target: 'main',
			waveSize: 1,
		});

		expect(createRollout).toHaveBeenCalledExactlyOnceWith({
			requestedByUserId: OWNER_ID,
			scope: 'owner',
			target: 'main',
			waveSize: 1,
			workerIds: [WORKER_A, WORKER_B],
		});
		expect(result.outcome).toBe('started');
		// Starting one *is* draining and signalling its first wave, not recording an intent.
		expect(fanOutWorkerUpdate).toHaveBeenCalledOnce();
	});

	it('defaults the wave to one machine when none is given', async () => {
		listWorkersForOwner.mockResolvedValue([makeWorker(WORKER_A)]);
		createRollout.mockResolvedValue({ rollout: makeRollout(), members: [] });
		givenRollout(makeRollout(), [makeMember(WORKER_A, 0)]);
		givenWorkers(makeWorker(WORKER_A));

		await startRollout({ ownerUserId: OWNER_ID, scope: 'owner', target: 'main' });

		expect(createRollout).toHaveBeenCalledWith(expect.objectContaining({ waveSize: 1 }));
	});

	// Re-running the command is how an operator advances a rollout, so asking for the
	// build it is already moving to must never be an error.
	it('advances the rollout already in progress for this same target', async () => {
		findInProgressRolloutForOwner.mockResolvedValue(makeRollout());
		givenRollout(makeRollout(), [makeMember(WORKER_A, 0)]);
		givenWorkers(makeWorker(WORKER_A));

		const result = await startRollout({ ownerUserId: OWNER_ID, scope: 'owner', target: 'main' });

		expect(result.outcome).toBe('advanced');
		expect(createRollout).not.toHaveBeenCalled();
		expect(listWorkersForOwner).not.toHaveBeenCalled();
	});

	// Two rollouts over the same machines would drain and undrain each other's members.
	it('refuses a different target while one is in progress', async () => {
		findInProgressRolloutForOwner.mockResolvedValue(makeRollout({ target: 'main' }));
		readRollout.mockResolvedValue({ rollout: makeRollout({ target: 'main' }), members: [] });

		const result = await startRollout({
			ownerUserId: OWNER_ID,
			scope: 'owner',
			target: 'fix/hotfix',
		});

		expect(result.outcome).toBe('conflict');
		expect(createRollout).not.toHaveBeenCalled();
	});

	it('records nothing at all for an operator who owns no machines', async () => {
		listWorkersForOwner.mockResolvedValue([]);

		const result = await startRollout({ ownerUserId: OWNER_ID, scope: 'owner', target: 'main' });

		expect(result.outcome).toBe('no-machines');
		expect(createRollout).not.toHaveBeenCalled();
	});

	// The partial unique index, not the read above it, is what decides "one at a time" —
	// so the loser of a dead heat answers exactly as arriving second would.
	it('re-resolves against the winner when two calls race the insert', async () => {
		listWorkersForOwner.mockResolvedValue([makeWorker(WORKER_A)]);
		createRollout.mockRejectedValue(Object.assign(new Error('duplicate key'), { code: '23505' }));
		findInProgressRolloutForOwner.mockResolvedValueOnce(undefined).mockResolvedValue(makeRollout());
		givenRollout(makeRollout(), [makeMember(WORKER_A, 0)]);
		givenWorkers(makeWorker(WORKER_A));

		const result = await startRollout({ ownerUserId: OWNER_ID, scope: 'owner', target: 'main' });

		expect(result.outcome).toBe('advanced');
	});
});

describe('getRolloutForOwner', () => {
	it('answers the owner’s latest rollout whatever its status', async () => {
		findLatestRolloutForOwner.mockResolvedValue(makeRollout({ status: 'halted' }));
		readRollout.mockResolvedValue({
			rollout: makeRollout({ status: 'halted', haltReason: 'bad build' }),
			members: [makeMember(WORKER_A, 0, { state: 'failed' })],
		});
		givenWorkers(makeWorker(WORKER_A));

		const view = await getRolloutForOwner(OWNER_ID);

		expect(view?.rollout.haltReason).toBe('bad build');
		expect(view?.members[0].displayName).toBe('machine-1');
		// Reading never advances: nothing is drained, signalled or written.
		expect(advanceUnderRolloutLock).not.toHaveBeenCalled();
		expect(setWorkerDraining).not.toHaveBeenCalled();
	});

	it('answers null for an operator who has never started one', async () => {
		expect(await getRolloutForOwner(OWNER_ID)).toBeNull();
	});
});

/**
 * The installation-scoped rollout (issue #1024) — the same state machine over
 * `listAllWorkers()`. What this suite owns is the three things the scope actually
 * decides: which machines are named, whether a `failed` member goes back in the
 * dispatch pool, and that neither scope may start while the other is moving.
 * Everything else is the suites above, unchanged and deliberately not re-tested.
 */
describe('startRollout — installation scope', () => {
	// The membership difference, and the only one: every registered machine, whoever
	// owns it, in one contiguous block per owner.
	it('names every machine on the installation, grouped by owner', async () => {
		const workers = [
			makeWorker(WORKER_A, { ownerUserId: OTHER_OWNER_ID }),
			makeWorker(WORKER_B, { ownerUserId: OWNER_ID }),
			makeWorker(WORKER_C, { ownerUserId: OTHER_OWNER_ID }),
		];
		listAllWorkers.mockResolvedValue(workers);
		createRollout.mockResolvedValue({
			rollout: makeRollout({ scope: 'installation' }),
			members: [],
		});
		givenRollout(makeRollout({ scope: 'installation' }), [makeMember(WORKER_B, 0)]);
		givenWorkers(...workers);

		const result = await startRollout({
			ownerUserId: OWNER_ID,
			scope: 'installation',
			target: 'main',
		});

		expect(listWorkersForOwner).not.toHaveBeenCalled();
		expect(createRollout).toHaveBeenCalledExactlyOnceWith({
			// Who asked, which is no longer the same fact as whose machines these are.
			requestedByUserId: OWNER_ID,
			scope: 'installation',
			target: 'main',
			waveSize: 1,
			// One block per owner; `listAllWorkers`' own order holds inside each block.
			workerIds: [WORKER_B, WORKER_A, WORKER_C],
		});
		expect(result.outcome).toBe('started');
	});

	it('answers an installation with no machines honestly, recording nothing', async () => {
		listAllWorkers.mockResolvedValue([]);

		const result = await startRollout({
			ownerUserId: OWNER_ID,
			scope: 'installation',
			target: 'main',
		});

		expect(result.outcome).toBe('no-machines');
		expect(createRollout).not.toHaveBeenCalled();
	});

	// Re-asking for the build it is already moving to advances it, exactly as the
	// owner-scoped one does — and it looks the live installation rollout up by scope,
	// never through whoever happens to be calling.
	it('advances the installation rollout already moving to this target', async () => {
		findInProgressInstallationRollout.mockResolvedValue(makeRollout({ scope: 'installation' }));
		givenRollout(makeRollout({ scope: 'installation' }), [makeMember(WORKER_A, 0)]);
		givenWorkers(makeWorker(WORKER_A));

		const result = await startRollout({
			ownerUserId: OTHER_OWNER_ID,
			scope: 'installation',
			target: 'main',
		});

		expect(result.outcome).toBe('advanced');
		expect(findInProgressRolloutForOwner).not.toHaveBeenCalled();
		expect(createRollout).not.toHaveBeenCalled();
	});

	it('refuses a different target while the installation rollout is in progress', async () => {
		findInProgressInstallationRollout.mockResolvedValue(
			makeRollout({ scope: 'installation', target: 'main' }),
		);
		readRollout.mockResolvedValue({
			rollout: makeRollout({ scope: 'installation', target: 'main' }),
			members: [],
		});

		const result = await startRollout({
			ownerUserId: OWNER_ID,
			scope: 'installation',
			target: 'fix/hotfix',
		});

		expect(result.outcome).toBe('conflict');
		expect(createRollout).not.toHaveBeenCalled();
	});
});

/**
 * The cross-scope refusal (issue #1024). An installation-wide rollout names every
 * machine, so it overlaps *every* owner-scoped one, and two rollouts holding the same
 * machine would drain and undrain each other's members. No single key expresses
 * "no rollout of the other scope exists", so this is a read rather than an index.
 */
describe('startRollout — one scope at a time', () => {
	it('refuses an installation rollout while any owner’s is in progress', async () => {
		const blocking = makeRollout({ requestedByUserId: OTHER_OWNER_ID, target: 'v3' });
		findAnyInProgressOwnerRollout.mockResolvedValue(blocking);
		readRollout.mockResolvedValue({ rollout: blocking, members: [makeMember(WORKER_A, 0)] });
		givenWorkers(makeWorker(WORKER_A));

		const result = await startRollout({
			ownerUserId: OWNER_ID,
			scope: 'installation',
			target: 'main',
		});

		expect(result.outcome).toBe('blocked-by-other-scope');
		// The rollout that is in the way, so the caller can say where to go and look.
		expect(result.outcome === 'blocked-by-other-scope' && result.view.rollout.target).toBe('v3');
		expect(listAllWorkers).not.toHaveBeenCalled();
		expect(createRollout).not.toHaveBeenCalled();
	});

	it('refuses an owner rollout while the installation one is in progress', async () => {
		const blocking = makeRollout({ scope: 'installation', target: 'v3' });
		findInProgressInstallationRollout.mockResolvedValue(blocking);
		readRollout.mockResolvedValue({ rollout: blocking, members: [makeMember(WORKER_A, 0)] });
		givenWorkers(makeWorker(WORKER_A));

		const result = await startRollout({ ownerUserId: OWNER_ID, scope: 'owner', target: 'main' });

		expect(result.outcome).toBe('blocked-by-other-scope');
		expect(listWorkersForOwner).not.toHaveBeenCalled();
		expect(createRollout).not.toHaveBeenCalled();
	});

	// A rollout that finished between the two reads must not refuse anything: the
	// refusal is about a rollout that is moving, and that one no longer is.
	it('carries on when the blocking rollout has gone between the two reads', async () => {
		findInProgressInstallationRollout.mockResolvedValue(makeRollout({ scope: 'installation' }));
		readRollout.mockResolvedValue(undefined);
		listWorkersForOwner.mockResolvedValue([makeWorker(WORKER_A)]);
		createRollout.mockResolvedValue({ rollout: makeRollout(), members: [] });
		givenRollout(makeRollout(), [makeMember(WORKER_A, 0)]);
		givenWorkers(makeWorker(WORKER_A));

		const result = await startRollout({ ownerUserId: OWNER_ID, scope: 'owner', target: 'main' });

		expect(result.outcome).toBe('started');
	});

	// The refusal is only ever about a rollout that is still *moving*. A halted one of
	// the other scope must not refuse a new rollout, exactly as a halted owner rollout
	// never refuses its owner's next — which is why the question is asked of the
	// in-progress read and of nothing wider.
	it('asks only whether a rollout of the other scope is in progress', async () => {
		listAllWorkers.mockResolvedValue([makeWorker(WORKER_A)]);
		createRollout.mockResolvedValue({
			rollout: makeRollout({ scope: 'installation' }),
			members: [],
		});
		givenRollout(makeRollout({ scope: 'installation' }), [makeMember(WORKER_A, 0)]);
		givenWorkers(makeWorker(WORKER_A));

		const result = await startRollout({
			ownerUserId: OWNER_ID,
			scope: 'installation',
			target: 'main',
		});

		expect(findAnyInProgressOwnerRollout).toHaveBeenCalledOnce();
		expect(result.outcome).toBe('started');
	});
});

/**
 * The one behaviour the two scopes differ on (issue #1024): an installation-scoped
 * rollout drained a machine belonging to somebody who never asked for it, so it puts
 * **every** machine it drained back — a member that settled `failed` included.
 * Leaving one drained would be the standing administrative drain issue #919 refused.
 */
describe('advanceRollout — a failed member of an installation rollout', () => {
	/** A member mid-flight, drained by this rollout, whose machine reported `failed`. */
	function givenFailingMember(scope: 'owner' | 'installation'): void {
		givenRollout(makeRollout({ scope }), [
			makeMember(WORKER_A, 0, { state: 'signalled', requestId: REQUEST_A, drainedByRollout: true }),
		]);
		givenWorkers(reported(WORKER_A, 'failed'));
	}

	it('goes back in the dispatch pool, unlike an owner-scoped rollout’s', async () => {
		givenFailingMember('installation');

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.members[0].state).toBe('failed');
		// It still halts — releasing the machine is not forgiving the build.
		expect(view?.rollout.status).toBe('halted');
		expect(setWorkerDraining).toHaveBeenCalledWith(WORKER_A, false);
	});

	it('stays drained for the operator to look at when the rollout is their own', async () => {
		givenFailingMember('owner');

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.members[0].state).toBe('failed');
		expect(view?.rollout.status).toBe('halted');
		expect(setWorkerDraining).not.toHaveBeenCalledWith(WORKER_A, false);
	});

	// The headline criterion, in the state the stranding is actually reachable in: the
	// rollout has already halted, and the machine it is still holding belongs to
	// somebody else. A member that applied and never came back settles `failed` — and
	// an installation rollout must still hand that machine back.
	it('leaves nothing drained once a halted installation rollout’s members settle', async () => {
		givenRollout(
			makeRollout({ scope: 'installation', status: 'halted', haltReason: 'bad build' }),
			[
				makeMember(WORKER_A, 0, {
					state: 'verifying',
					outcome: 'applied',
					drainedByRollout: true,
					fencingTokenAtSignal: 7,
					buildCommitAtSignal: 'aaaaaaa',
					signalledAt: new Date('2026-09-13T11:05:00Z'),
				}),
			],
		);
		// Reported `applied` at 11:50 and nothing since — well past the come-back window.
		givenWorkers(reported(WORKER_A, 'applied', { ownerUserId: OTHER_OWNER_ID }));
		vi.setSystemTime(new Date('2026-09-13T13:00:00Z'));

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.members[0]).toMatchObject({
			state: 'failed',
			message: 'applied the update and never came back',
		});
		expect(setWorkerDraining).toHaveBeenCalledWith(WORKER_A, false);
	});

	// The third `failed` verdict, for completeness: a machine that came back on the
	// build it was asked to leave.
	it('releases a member that came back on the build it was asked to leave', async () => {
		givenRollout(makeRollout({ scope: 'installation' }), [
			makeMember(WORKER_A, 0, {
				state: 'verifying',
				outcome: 'applied',
				drainedByRollout: true,
				fencingTokenAtSignal: 7,
				buildCommitAtSignal: 'aaaaaaa',
				signalledAt: new Date('2026-09-13T11:05:00Z'),
			}),
		]);
		givenWorkers(reported(WORKER_A, 'applied', { build: { commit: 'aaaaaaa', dirty: false } }));
		getLiveSessionForWorker.mockResolvedValue({ fencingToken: 8 });

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.members[0].state).toBe('failed');
		expect(setWorkerDraining).toHaveBeenCalledWith(WORKER_A, false);
	});

	// A machine the *operator* had drained for their own reasons is still never
	// undrained: the release is of the rollout's own drain, not of anybody's.
	it('does not undrain a failed machine the rollout never drained itself', async () => {
		givenRollout(makeRollout({ scope: 'installation' }), [
			makeMember(WORKER_A, 0, {
				state: 'signalled',
				requestId: REQUEST_A,
				drainedByRollout: false,
			}),
		]);
		givenWorkers(reported(WORKER_A, 'failed'));

		const view = await advanceRollout(ROLLOUT_ID);

		expect(view?.members[0].state).toBe('failed');
		expect(setWorkerDraining).not.toHaveBeenCalledWith(WORKER_A, false);
	});
});

describe('getInstallationRollout', () => {
	it('answers the latest installation rollout, labelled with each machine’s owner', async () => {
		findLatestInstallationRollout.mockResolvedValue(makeRollout({ scope: 'installation' }));
		readRollout.mockResolvedValue({
			rollout: makeRollout({ scope: 'installation', status: 'halted', haltReason: 'bad build' }),
			members: [makeMember(WORKER_A, 0, { state: 'failed' }), makeMember(WORKER_B, 1)],
		});
		// The second machine's row has gone — the FK cascade is on its way through.
		givenWorkers(makeWorker(WORKER_A, { ownerUserId: OTHER_OWNER_ID }));

		const view = await getInstallationRollout();

		expect(view?.rollout.haltReason).toBe('bad build');
		expect(view?.members.map((member) => member.ownerUserId)).toEqual([OTHER_OWNER_ID, null]);
		// Reading never advances: nothing is drained, signalled or written.
		expect(advanceUnderRolloutLock).not.toHaveBeenCalled();
		expect(setWorkerDraining).not.toHaveBeenCalled();
	});

	it('answers null when no installation-wide rollout has ever run', async () => {
		expect(await getInstallationRollout()).toBeNull();
	});
});
