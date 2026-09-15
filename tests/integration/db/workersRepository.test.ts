import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/db/client.js';
import { deleteProjectFromDb } from '../../../src/db/repositories/projectsRepository.js';
import { createUser } from '../../../src/db/repositories/usersRepository.js';
import {
	createEnrollment,
	getEnrollmentById,
} from '../../../src/db/repositories/workerEnrollmentsRepository.js';
import {
	adoptOutstandingWorkerUpdateRequest,
	createWorker,
	findWorkerByCredentialHash,
	getWorkerById,
	getWorkersByIds,
	listAllWorkers,
	listWorkersForOwner,
	recordWorkerUpdateReport,
	recordWorktreeSweepReport,
	removeWorker,
	requestWorkerUpdate,
	requestWorktreeSweep,
	setWorkerDeclaredCapabilities,
	setWorkerDraining,
	updateWorkerCapabilities,
	updateWorkerDisplayName,
	updateWorkerSupportedPhases,
	type WorkerUpdateRequestOutcome,
} from '../../../src/db/repositories/workersRepository.js';
import { dispatches } from '../../../src/db/schema/dispatches.js';
import { runs } from '../../../src/db/schema/runs.js';
import { users } from '../../../src/db/schema/users.js';
import { workerProjectEnrollments } from '../../../src/db/schema/workerProjectEnrollments.js';
import type { AgentCli } from '../../../src/harness/agent-cli.js';
import {
	type Worker,
	WorkerCapabilityNotProbedError,
	WorkerCapabilityReductionError,
	type WorktreeSweepResult,
} from '../../../src/identity/worker.js';
import { AllowedClisNotCapableError } from '../../../src/identity/worker-enrollment.js';
import type { WorkerSupervision } from '../../../src/lib/worker-supervision.js';
import { ALL_TRIGGER_PHASES, type TriggerPhase } from '../../../src/triggers/types.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)('workersRepository (integration)', () => {
	let adaId: string;
	let graceId: string;

	beforeEach(async () => {
		await truncateAll();
		adaId = (await createUser({ identifier: 'ada@example.com', displayName: 'Ada' })).id;
		graceId = (await createUser({ identifier: 'grace@example.com', displayName: 'Grace' })).id;
	});

	describe('createWorker / getWorkerById', () => {
		it('round-trips a created worker with generated id/timestamps and no credential hash', async () => {
			const created = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-laptop',
				capabilities: ['claude', 'codex'],
				credentialHash: 'hash-a',
			});

			expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
			expect(created.ownerUserId).toBe(adaId);
			expect(created.displayName).toBe('ada-laptop');
			expect(created.capabilities).toEqual(['claude', 'codex']);
			expect(created.createdAt).toBeInstanceOf(Date);
			expect(created.updatedAt).toBeInstanceOf(Date);
			// The credential hash never enters the domain read model.
			expect(created).not.toHaveProperty('credentialHash');

			expect(await getWorkerById(created.id)).toEqual(created);
		});

		it('returns undefined for an unknown id', async () => {
			expect(await getWorkerById('00000000-0000-4000-8000-000000000000')).toBeUndefined();
		});
	});

	// The batched form the runs list labels a page of rows with (issue #523).
	describe('getWorkersByIds', () => {
		it('resolves the requested workers and silently omits the ids it cannot', async () => {
			const ada = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-laptop',
				capabilities: ['claude'],
				credentialHash: 'hash-a',
			});
			const grace = await createWorker({
				ownerUserId: graceId,
				displayName: 'grace-desktop',
				capabilities: ['codex'],
				credentialHash: 'hash-b',
			});

			const found = await getWorkersByIds([
				ada.id,
				'00000000-0000-4000-8000-000000000000',
				grace.id,
			]);

			expect(found.map((worker) => worker.displayName).sort()).toEqual([
				'ada-laptop',
				'grace-desktop',
			]);
			// The credential hash never enters the domain read model here either.
			expect(found.every((worker) => !('credentialHash' in worker))).toBe(true);
		});

		it('reads nothing at all for an empty id list', async () => {
			await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-laptop',
				capabilities: ['claude'],
				credentialHash: 'hash-a',
			});

			expect(await getWorkersByIds([])).toEqual([]);
		});
	});

	describe('unique constraints', () => {
		it('rejects a duplicate (owner, displayName) with a unique violation', async () => {
			await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-laptop',
				capabilities: ['claude'],
				credentialHash: 'hash-a',
			});
			await expect(
				createWorker({
					ownerUserId: adaId,
					displayName: 'ada-laptop',
					capabilities: ['codex'],
					credentialHash: 'hash-b',
				}),
			).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23505' }) });
		});

		it('allows a different owner to reuse the same display name', async () => {
			await createWorker({
				ownerUserId: adaId,
				displayName: 'shared-name',
				capabilities: ['claude'],
				credentialHash: 'hash-a',
			});
			const graces = await createWorker({
				ownerUserId: graceId,
				displayName: 'shared-name',
				capabilities: ['codex'],
				credentialHash: 'hash-b',
			});
			expect(graces.ownerUserId).toBe(graceId);
		});

		it('rejects a duplicate credential hash with a unique violation', async () => {
			await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-laptop',
				capabilities: ['claude'],
				credentialHash: 'shared-hash',
			});
			await expect(
				createWorker({
					ownerUserId: graceId,
					displayName: 'grace-laptop',
					capabilities: ['codex'],
					credentialHash: 'shared-hash',
				}),
			).rejects.toMatchObject({ cause: expect.objectContaining({ code: '23505' }) });
		});
	});

	describe('findWorkerByCredentialHash', () => {
		it('resolves a worker by its credential hash and returns undefined for an unknown hash', async () => {
			const created = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-laptop',
				capabilities: ['claude'],
				credentialHash: 'hash-a',
			});
			expect(await findWorkerByCredentialHash('hash-a')).toEqual(created);
			expect(await findWorkerByCredentialHash('unknown-hash')).toBeUndefined();
		});
	});

	// Issue #467 — the phase axis, against real Postgres. The unit tests mock the
	// repository, so only these can catch a wrong `.set()` payload, a missing column
	// default, or a jsonb round-trip problem.
	describe('supportedPhases', () => {
		it('gives a newly created worker every phase', async () => {
			const created = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-fresh',
				capabilities: ['claude'],
				credentialHash: 'hash-fresh',
			});

			// Asserted against the runtime constant, not a literal: this fails the moment
			// `TriggerPhase` grows without `createWorker` following, which is exactly the
			// drift that would otherwise refuse the new phase on capable workers.
			expect(created.supportedPhases).toEqual([...ALL_TRIGGER_PHASES]);
			expect((await getWorkerById(created.id))?.supportedPhases).toEqual([...ALL_TRIGGER_PHASES]);
		});

		it('writes a narrowed set, and leaves it untouched when capabilities change alone', async () => {
			const created = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-dbfree',
				capabilities: ['claude'],
				credentialHash: 'hash-dbfree',
			});
			const narrowed: TriggerPhase[] = ['implementation', 'review'];

			await updateWorkerCapabilities(created.id, ['claude'], narrowed);
			expect((await getWorkerById(created.id))?.supportedPhases).toEqual(narrowed);

			// The `swarm workers set-cli` shape: no phases passed, so the narrowed set must
			// survive rather than being reset to the every-phase default.
			await updateWorkerCapabilities(created.id, ['claude', 'codex']);
			const after = await getWorkerById(created.id);
			expect(after?.capabilities).toEqual(['claude', 'codex']);
			expect(after?.supportedPhases).toEqual(narrowed);
		});

		it('rolls the phase write back with the capability write when a reduction is refused', async () => {
			await seedProject({ id: 'proj-phase-tx', repo: 'SmartTechBrewery/repo-phase-tx' });
			const worker = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-tx',
				capabilities: ['claude', 'codex'],
				credentialHash: 'hash-tx',
			});
			await createEnrollment({
				workerId: worker.id,
				projectId: 'proj-phase-tx',
				status: 'active',
				allowedClis: ['codex'],
				allowedPhases: ['implementation'],
				concurrencyAllocation: 1,
				sharingConsent: true,
			});

			// The enrollment still requires codex, so this whole call must fail — and the
			// phase set it also carried must not have landed (the same-transaction claim).
			await expect(
				updateWorkerCapabilities(worker.id, ['claude'], ['implementation']),
			).rejects.toThrow(WorkerCapabilityReductionError);

			expect((await getWorkerById(worker.id))?.supportedPhases).toEqual([...ALL_TRIGGER_PHASES]);
		});

		it('replaces the phase set alone, without touching capabilities', async () => {
			const created = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-phases-only',
				capabilities: ['claude', 'codex'],
				credentialHash: 'hash-phases-only',
			});
			await updateWorkerCapabilities(created.id, ['claude', 'codex'], ['implementation']);

			// The in-process host worker's declaration path: it must be able to widen a row
			// a previous DB-free run narrowed, or `planning` would be refused there forever.
			const widened = await updateWorkerSupportedPhases(created.id, [...ALL_TRIGGER_PHASES]);
			expect(widened?.supportedPhases).toEqual([...ALL_TRIGGER_PHASES]);
			expect(widened?.capabilities).toEqual(['claude', 'codex']);
		});

		it('returns undefined when replacing the phase set of a missing id', async () => {
			expect(
				await updateWorkerSupportedPhases('00000000-0000-4000-8000-000000000000', [
					'implementation',
				]),
			).toBeUndefined();
		});

		// Issue #509: the daemon keeps refreshing its own declaration on every reconnect,
		// and neither of the two declaration paths may overwrite the owner's per-project
		// selection — nor be refused because of it (a narrowing reconnect must land).
		it('leaves an enrollment’s allowed phases untouched when the daemon re-declares', async () => {
			await seedProject({ id: 'proj-phase-keep', repo: 'SmartTechBrewery/repo-phase-keep' });
			const worker = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-phase-keep',
				capabilities: ['claude'],
				credentialHash: 'hash-phase-keep',
			});
			const enrollment = await createEnrollment({
				workerId: worker.id,
				projectId: 'proj-phase-keep',
				status: 'active',
				allowedClis: ['claude'],
				allowedPhases: ['planning', 'implementation'],
				concurrencyAllocation: 1,
				sharingConsent: true,
			});

			await updateWorkerSupportedPhases(worker.id, ['implementation']);
			expect((await getEnrollmentById(enrollment.id))?.allowedPhases).toEqual([
				'planning',
				'implementation',
			]);

			await updateWorkerCapabilities(worker.id, ['claude'], ['review']);
			expect((await getWorkerById(worker.id))?.supportedPhases).toEqual(['review']);
			expect((await getEnrollmentById(enrollment.id))?.allowedPhases).toEqual([
				'planning',
				'implementation',
			]);
		});
	});

	// Issue #687 — the daemon-declared checkout identity, against real Postgres. The
	// unit tests mock the repository, so only these can catch a wrong `.set()` payload,
	// a column that is not nullable, or the three-valued argument collapsing.
	describe('repository', () => {
		it('leaves a newly registered worker with no declaration', async () => {
			const created = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-fresh-repo',
				capabilities: ['claude'],
				credentialHash: 'hash-fresh-repo',
			});

			// Registering a machine is not declaring a checkout — only a connecting daemon
			// can state which repository it holds.
			expect(created.repository).toBeNull();
			expect((await getWorkerById(created.id))?.repository).toBeNull();
		});

		it('persists a declaration, leaves it alone when omitted, and clears it on null', async () => {
			const created = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-declares',
				capabilities: ['claude'],
				credentialHash: 'hash-declares',
			});

			await updateWorkerCapabilities(created.id, ['claude'], undefined, 'smarttechbrewery/swarm');
			expect((await getWorkerById(created.id))?.repository).toBe('smarttechbrewery/swarm');

			// The `swarm workers set-cli` shape: no repository passed, so the declaration must
			// survive rather than be cleared by a caller that knows nothing about checkouts.
			await updateWorkerCapabilities(created.id, ['claude', 'codex']);
			const after = await getWorkerById(created.id);
			expect(after?.capabilities).toEqual(['claude', 'codex']);
			expect(after?.repository).toBe('smarttechbrewery/swarm');

			// An explicit null is a handshake from a daemon that declared none: the stale
			// statement is cleared rather than left standing.
			await updateWorkerCapabilities(created.id, ['claude', 'codex'], undefined, null);
			expect((await getWorkerById(created.id))?.repository).toBeNull();
		});

		it('rolls the repository write back with the capability write when a reduction is refused', async () => {
			await seedProject({ id: 'proj-repo-tx', repo: 'SmartTechBrewery/repo-repo-tx' });
			const worker = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-repo-tx',
				capabilities: ['claude', 'codex'],
				credentialHash: 'hash-repo-tx',
			});
			await createEnrollment({
				workerId: worker.id,
				projectId: 'proj-repo-tx',
				status: 'active',
				allowedClis: ['codex'],
				allowedPhases: ['implementation'],
				concurrencyAllocation: 1,
				sharingConsent: true,
			});

			// The enrollment still requires codex, so the whole call must fail — and the
			// declaration it also carried must not have landed (the same-transaction claim).
			await expect(
				updateWorkerCapabilities(worker.id, ['claude'], undefined, 'smarttechbrewery/swarm'),
			).rejects.toThrow(WorkerCapabilityReductionError);

			expect((await getWorkerById(worker.id))?.repository).toBeNull();
		});
	});

	// Issue #919 — the draining flag against real Postgres. The unit tests mock the
	// repository, so only these can catch the `coalesce` not being idempotent, the
	// column not being nullable, or `now()` not landing at all.
	describe('setWorkerDraining', () => {
		async function freshWorker(name: string): Promise<string> {
			const created = await createWorker({
				ownerUserId: adaId,
				displayName: name,
				capabilities: ['claude'],
				credentialHash: `hash-${name}`,
			});
			return created.id;
		}

		it('leaves a newly registered worker in the pool', async () => {
			const id = await freshWorker('ada-pool');
			expect((await getWorkerById(id))?.drainingSince).toBeNull();
		});

		it('records the instant a machine was taken out of the pool', async () => {
			const id = await freshWorker('ada-drain');

			const drained = await setWorkerDraining(id, true);

			expect(drained?.drainingSince).toBeInstanceOf(Date);
			expect((await getWorkerById(id))?.drainingSince).toEqual(drained?.drainingSince);
		});

		// The idempotence an operator polling with `swarm workers drain` depends on:
		// re-running it must not restart the "draining since" clock.
		it('keeps the original instant when a draining machine is drained again', async () => {
			const id = await freshWorker('ada-redrain');
			const first = await setWorkerDraining(id, true);

			const second = await setWorkerDraining(id, true);

			expect(second?.drainingSince).toEqual(first?.drainingSince);
		});

		it('clears the flag, returning the machine to the pool', async () => {
			const id = await freshWorker('ada-undrain');
			await setWorkerDraining(id, true);

			const undrained = await setWorkerDraining(id, false);

			expect(undrained?.drainingSince).toBeNull();
			expect((await getWorkerById(id))?.drainingSince).toBeNull();
		});

		// A drain taken after an undrain is a *new* statement, so it starts a new clock.
		it('starts a fresh clock when a machine is drained again after an undrain', async () => {
			const id = await freshWorker('ada-recycle');
			const first = await setWorkerDraining(id, true);
			await setWorkerDraining(id, false);

			const second = await setWorkerDraining(id, true);

			expect(second?.drainingSince).not.toEqual(first?.drainingSince);
		});

		it('returns undefined for an unknown worker — a not-found, not an error', async () => {
			expect(await setWorkerDraining('99999999-9999-4999-8999-999999999999', true)).toBeUndefined();
		});

		// The handshake path writes only the daemon-declared columns, which is what makes
		// a drain sticky across the restart it was taken for.
		it('survives a handshake refreshing the daemon-declared columns', async () => {
			const id = await freshWorker('ada-sticky');
			const drained = await setWorkerDraining(id, true);

			await updateWorkerCapabilities(id, ['claude'], [...ALL_TRIGGER_PHASES], 'acme/api');

			const after = await getWorkerById(id);
			expect(after?.drainingSince).toEqual(drained?.drainingSince);
			expect(after?.repository).toBe('acme/api');
		});
	});

	// Issue #933 — the self-update request and its report, which are six columns
	// read back as one value. Only a real database catches the id-matched `WHERE`
	// silently matching nothing, or a report clearing the target it describes.
	//
	// Since issue #921 the request write also carries the draining precondition in its
	// own `WHERE`, which is the other thing only a real database settles: that the
	// eligibility test and the write are one statement, so no caller can record a
	// request onto a machine an `undrain` has returned to the dispatch pool.
	describe('requestWorkerUpdate / recordWorkerUpdateReport', () => {
		const REQUEST_ID = '66666666-6666-4666-8666-666666666666';
		const OTHER_REQUEST_ID = '77777777-7777-4777-8777-777777777777';

		/** Narrow an outcome to the row a *recorded* request wrote back. */
		function recorded(result: WorkerUpdateRequestOutcome): Worker {
			if (result.outcome !== 'requested') {
				throw new Error(`expected a recorded request, got '${result.outcome}'`);
			}
			return result.worker;
		}

		/** The project every machine below is enrolled in — what its update run hangs off. */
		const UPDATE_PROJECT_ID = 'proj-worker-update';

		/**
		 * A registered machine, drained **and enrolled** — the only state the request
		 * write accepts. The enrollment is the second half since issue #971: the request
		 * also creates a `runs` row scoped to the machine's project, so a machine holding
		 * none is refused before anything is written.
		 */
		async function freshWorker(name: string): Promise<string> {
			const created = await createWorker({
				ownerUserId: adaId,
				displayName: name,
				capabilities: ['claude'],
				credentialHash: `hash-${name}`,
			});
			await createEnrollment({
				workerId: created.id,
				projectId: UPDATE_PROJECT_ID,
				status: 'active',
				allowedClis: ['claude'],
				allowedPhases: [...ALL_TRIGGER_PHASES],
				concurrencyAllocation: 1,
				sharingConsent: true,
			});
			await setWorkerDraining(created.id, true);
			return created.id;
		}

		/**
		 * Re-declare how a machine is supervised (issue #997), the one way it ever
		 * changes: the daemon states it at handshake, which is the same write that
		 * re-declares its CLIs. A machine that has never connected stays `unknown`, which
		 * is what {@link freshWorker} leaves behind.
		 */
		async function declareSupervision(
			workerId: string,
			supervision: WorkerSupervision,
		): Promise<void> {
			await updateWorkerCapabilities(
				workerId,
				['claude'],
				undefined,
				undefined,
				undefined,
				supervision,
			);
		}

		/** The `worker-update` dispatch rows this machine has, oldest first. */
		async function updateDispatchesFor(workerId: string) {
			return await getDb()
				.select()
				.from(dispatches)
				.where(
					and(
						eq(dispatches.phase, 'worker-update'),
						sql`${dispatches.jobPayload} ->> 'workerId' = ${workerId}`,
					),
				)
				.orderBy(asc(dispatches.createdAt));
		}

		/** The `worker-update` run rows this machine has, newest first. */
		async function updateRunsFor(workerId: string) {
			return await getDb()
				.select()
				.from(runs)
				.where(and(eq(runs.workerId, workerId), eq(runs.kind, 'worker-update')))
				.orderBy(desc(runs.startedAt));
		}

		beforeEach(async () => {
			await seedProject({ id: UPDATE_PROJECT_ID, repo: 'jkwiecien/worker-update' });
		});

		it('leaves a newly registered worker with no request and no outcome', async () => {
			const id = await freshWorker('ada-no-update');
			expect((await getWorkerById(id))?.update).toBeNull();
		});

		it('records a request as pending, with no outcome yet', async () => {
			const id = await freshWorker('ada-update');

			const requested = recorded(await requestWorkerUpdate(id, REQUEST_ID, 'main', adaId));

			expect(requested.update).toMatchObject({
				requestId: REQUEST_ID,
				target: 'main',
				status: null,
				message: null,
				reportedAt: null,
			});
			expect(requested.update?.requestedAt).toBeInstanceOf(Date);
			expect((await getWorkerById(id))?.update).toEqual(requested.update);
		});

		// The precondition, decided by the write rather than by whoever called it: a
		// machine in the dispatch pool would be given new work while it waited to
		// restart, so nothing is recorded and the row is handed back untouched for the
		// caller to word its own refusal from.
		it('refuses a machine that is not draining, writing nothing', async () => {
			const created = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-in-pool',
				capabilities: ['claude'],
				credentialHash: 'hash-ada-in-pool',
			});
			// Enrolled, so the refusal under test is the draining one and not issue #971's.
			await createEnrollment({
				workerId: created.id,
				projectId: UPDATE_PROJECT_ID,
				status: 'active',
				allowedClis: ['claude'],
				allowedPhases: [...ALL_TRIGGER_PHASES],
				concurrencyAllocation: 1,
				sharingConsent: true,
			});

			const result = await requestWorkerUpdate(created.id, REQUEST_ID, 'main', adaId);

			expect(result.outcome).toBe('in-pool');
			expect((await getWorkerById(created.id))?.update).toBeNull();
			expect(await updateRunsFor(created.id)).toHaveLength(0);
		});

		// The race the predicate closes: drained, read as eligible, then returned to the
		// pool before the write. The request must not land.
		it('refuses a machine undrained after it was read as eligible', async () => {
			const id = await freshWorker('ada-undrained');
			await setWorkerDraining(id, false);

			const result = await requestWorkerUpdate(id, REQUEST_ID, 'main', adaId);

			expect(result.outcome).toBe('in-pool');
			expect((await getWorkerById(id))?.update).toBeNull();
		});

		// Undraining does not erase a request that was legitimately made while the
		// machine was drained — only a *new* one is refused.
		it('leaves a request already recorded standing when the machine is undrained', async () => {
			const id = await freshWorker('ada-undrain-after');
			await requestWorkerUpdate(id, REQUEST_ID, 'main', adaId);

			await setWorkerDraining(id, false);

			expect((await getWorkerById(id))?.update).toMatchObject({
				requestId: REQUEST_ID,
				target: 'main',
			});
			expect((await requestWorkerUpdate(id, OTHER_REQUEST_ID, 'v2', adaId)).outcome).toBe(
				'in-pool',
			);
		});

		// The report clears the pending marker and keeps the target: an outcome naming
		// no build answers nothing.
		it('records an outcome, clears the pending marker, and keeps the target', async () => {
			const id = await freshWorker('ada-report');
			await requestWorkerUpdate(id, REQUEST_ID, 'main', adaId);

			const reported = await recordWorkerUpdateReport(id, REQUEST_ID, 'applied', 'Applied.');

			expect(reported?.update).toMatchObject({
				requestId: null,
				target: 'main',
				status: 'applied',
				message: 'Applied.',
			});
			expect(reported?.update?.reportedAt).toBeInstanceOf(Date);
		});

		// The id match is what stops a report for a superseded request from un-pending
		// the one an operator has since made.
		it('ignores a report naming a request the row has moved on from', async () => {
			const id = await freshWorker('ada-superseded');
			await requestWorkerUpdate(id, REQUEST_ID, 'main', adaId);
			await requestWorkerUpdate(id, OTHER_REQUEST_ID, 'v2', adaId);

			const stale = await recordWorkerUpdateReport(id, REQUEST_ID, 'applied', 'Applied.');

			expect(stale).toBeUndefined();
			expect((await getWorkerById(id))?.update).toMatchObject({
				requestId: OTHER_REQUEST_ID,
				target: 'v2',
				status: null,
			});
		});

		it('ignores a duplicate report of a request already answered', async () => {
			const id = await freshWorker('ada-duplicate');
			await requestWorkerUpdate(id, REQUEST_ID, 'main', adaId);
			await recordWorkerUpdateReport(id, REQUEST_ID, 'failed', "'npm ci' failed.");

			const repeat = await recordWorkerUpdateReport(id, REQUEST_ID, 'applied', 'Applied.');

			expect(repeat).toBeUndefined();
			expect((await getWorkerById(id))?.update).toMatchObject({
				status: 'failed',
				message: "'npm ci' failed.",
			});
		});

		// Re-targeting is the only form of cancel this phase has, so a fresh request
		// must not leave the previous one's verdict standing beside it.
		it('clears a previous outcome when the machine is asked again', async () => {
			const id = await freshWorker('ada-retarget');
			await requestWorkerUpdate(id, REQUEST_ID, 'main', adaId);
			await recordWorkerUpdateReport(id, REQUEST_ID, 'refused', 'The install root is dirty.');

			const again = recorded(await requestWorkerUpdate(id, OTHER_REQUEST_ID, 'v2', adaId));

			expect(again.update).toMatchObject({
				requestId: OTHER_REQUEST_ID,
				target: 'v2',
				status: null,
				message: null,
				reportedAt: null,
			});
		});

		// Issue #922 — who asked is recorded on the row, because the requester and the
		// machine's owner stopped being the same person once an installation
		// administrator could ask a machine they do not own. Only a real database settles
		// that the FK holds and that the value survives the report that clears the
		// pending marker beside it.
		it('records who asked, and keeps it when the machine reports back', async () => {
			const admin = await createUser({ identifier: 'root@example.com', displayName: 'Root' });
			const id = await freshWorker('ada-asked-by-admin');

			const requested = recorded(await requestWorkerUpdate(id, REQUEST_ID, 'main', admin.id));
			expect(requested.update?.requestedByUserId).toBe(admin.id);

			await recordWorkerUpdateReport(id, REQUEST_ID, 'declined', 'Not opted in.');

			// The report is the machine's answer to *that* request, so the requester it
			// names is still the one the outcome belongs to.
			expect((await getWorkerById(id))?.update).toMatchObject({
				requestedByUserId: admin.id,
				status: 'declined',
			});
		});

		// Re-asking re-attributes: the row carries one request, so the requester beside
		// it must be the one who made the request now outstanding — never the previous.
		it('re-attributes the request when somebody else asks next', async () => {
			const admin = await createUser({ identifier: 'root2@example.com', displayName: 'Root' });
			const id = await freshWorker('ada-reattributed');
			await requestWorkerUpdate(id, REQUEST_ID, 'main', admin.id);

			const again = recorded(await requestWorkerUpdate(id, OTHER_REQUEST_ID, 'v2', adaId));

			expect(again.update?.requestedByUserId).toBe(adaId);
		});

		it('returns a not-found for an unknown worker — not an error', async () => {
			const unknown = '99999999-9999-4999-8999-999999999999';
			expect(await requestWorkerUpdate(unknown, REQUEST_ID, 'main', adaId)).toEqual({
				outcome: 'not-found',
			});
			expect(
				await recordWorkerUpdateReport(unknown, REQUEST_ID, 'applied', 'Applied.'),
			).toBeUndefined();
		});

		// The same stickiness `draining_since` has, and for the same reason: this is the
		// operator's request, not a fact the daemon re-declares on connect.
		it('survives a handshake refreshing the daemon-declared columns', async () => {
			const id = await freshWorker('ada-update-sticky');
			const requested = recorded(await requestWorkerUpdate(id, REQUEST_ID, 'main', adaId));

			await updateWorkerCapabilities(id, ['claude'], [...ALL_TRIGGER_PHASES], 'acme/api');

			expect((await getWorkerById(id))?.update).toEqual(requested.update);
		});

		// Issue #971 — the request and its run are one transaction, so only a real
		// database settles that the row lands beside the request, scoped to the machine's
		// own project and naming the machine and the build.
		describe('the run it records (issue #971)', () => {
			it('creates one running run for the machine, naming its project and target', async () => {
				const id = await freshWorker('ada-run');

				const result = await requestWorkerUpdate(id, REQUEST_ID, 'main', adaId);

				if (result.outcome !== 'requested') throw new Error(`got '${result.outcome}'`);
				const [run] = await updateRunsFor(id);
				expect(run.id).toBe(result.runId);
				expect(run).toMatchObject({
					kind: 'worker-update',
					phase: 'worker-update',
					status: 'running',
					projectId: UPDATE_PROJECT_ID,
					workerId: id,
					workerUserId: adaId,
					maintenanceRequestId: REQUEST_ID,
					maintenanceTarget: 'main',
				});
				// None of the pipeline coordinates: it acts on no repository, provisions no
				// worktree, and has no session to resume.
				expect(run.repository).toBeNull();
				expect(run.taskId).toBeNull();
				expect(run.agentSessionId).toBeNull();
				expect(run.jobPayload).toBeNull();
				expect(run.workItemId).toBeNull();
				expect(run.prNumber).toBeNull();
			});

			// Without this the previous request's run would stay `running` forever: its own
			// report answers `recorded: false` and never closes it.
			it('settles the previous run as superseded when the machine is re-targeted', async () => {
				const id = await freshWorker('ada-run-retarget');
				await requestWorkerUpdate(id, REQUEST_ID, 'main', adaId);

				await requestWorkerUpdate(id, OTHER_REQUEST_ID, 'v2', adaId);

				const rows = await updateRunsFor(id);
				expect(rows).toHaveLength(2);
				const byRequest = Object.fromEntries(rows.map((row) => [row.maintenanceRequestId, row]));
				expect(byRequest[REQUEST_ID]).toMatchObject({ status: 'failed' });
				expect(byRequest[REQUEST_ID].error).toContain('Superseded');
				expect(byRequest[OTHER_REQUEST_ID]).toMatchObject({ status: 'running' });
			});

			it('settles the run the report names, keeping the machine and the build on it', async () => {
				const id = await freshWorker('ada-run-report');
				await requestWorkerUpdate(id, REQUEST_ID, 'main', adaId);

				await recordWorkerUpdateReport(id, REQUEST_ID, 'applied', 'Applied.');

				const [run] = await updateRunsFor(id);
				expect(run).toMatchObject({
					status: 'completed',
					error: null,
					maintenanceTarget: 'main',
					workerId: id,
				});
				expect(run.completedAt).toBeInstanceOf(Date);
			});

			// The report is authoritative for the request it names, so the run is settled
			// even when the `workers` row has moved on and answers `recorded: false`.
			it('settles a superseded request’s run even though the worker row ignores it', async () => {
				const id = await freshWorker('ada-run-stale');
				await requestWorkerUpdate(id, REQUEST_ID, 'main', adaId);
				await requestWorkerUpdate(id, OTHER_REQUEST_ID, 'v2', adaId);

				const stale = await recordWorkerUpdateReport(id, REQUEST_ID, 'failed', "'npm ci' failed.");

				expect(stale).toBeUndefined();
				const rows = await updateRunsFor(id);
				const superseded = rows.find((row) => row.maintenanceRequestId === REQUEST_ID);
				// Corrected, not left saying it was superseded: the machine did answer.
				expect(superseded).toMatchObject({ status: 'failed', error: "'npm ci' failed." });
			});

			// The boundary the issue states outright: nothing at all is written, because
			// there is no project for the run to hang off.
			it('refuses a machine enrolled in no project, writing neither request nor run', async () => {
				const created = await createWorker({
					ownerUserId: adaId,
					displayName: 'ada-orphan',
					capabilities: ['claude'],
					credentialHash: 'hash-ada-orphan',
				});
				await setWorkerDraining(created.id, true);

				const result = await requestWorkerUpdate(created.id, REQUEST_ID, 'main', adaId);

				expect(result.outcome).toBe('no-project');
				expect((await getWorkerById(created.id))?.update).toBeNull();
				expect(await updateRunsFor(created.id)).toHaveLength(0);
			});

			// Issue #997, phase 2/2 — the third precondition, and the same all-or-nothing
			// boundary: the daemon applies an update by exiting, so a machine that declared
			// nothing will start it again is answered before the row write and nothing at
			// all is created for it.
			it('refuses a machine that declared it is unsupervised, writing nothing', async () => {
				const id = await freshWorker('ada-unsupervised');
				await declareSupervision(id, 'unsupervised');

				const result = await requestWorkerUpdate(id, REQUEST_ID, 'main', adaId);

				expect(result.outcome).toBe('unsupervised');
				expect((await getWorkerById(id))?.update).toBeNull();
				expect(await updateRunsFor(id)).toHaveLength(0);
				expect(await updateDispatchesFor(id)).toHaveLength(0);
			});

			// Never refused, anywhere: `unknown` is what a daemon predating the declaration
			// and a machine that has never connected both say, so treating it as a refusal
			// would let a fact SWARM could not establish block an operator who knows better.
			// A freshly registered machine is already `unknown`, which is why every other
			// case in this block is accepted.
			it.each([
				'unknown',
				'supervised',
			] as const)('asks a machine declaring %s exactly as before', async (supervision) => {
				const id = await freshWorker(`ada-${supervision}`);
				await declareSupervision(id, supervision);

				const result = await requestWorkerUpdate(id, REQUEST_ID, 'main', adaId);

				expect(result.outcome).toBe('requested');
				expect((await getWorkerById(id))?.update).toMatchObject({ requestId: REQUEST_ID });
			});

			// Ordered behind the draining snapshot, exactly as the fan-out's own snapshot
			// check orders the pair: the drain is the remedy the operator has to reach for
			// either way, so the two forms never word one machine's state differently.
			it('answers in-pool for a machine that is both in the pool and unsupervised', async () => {
				const id = await freshWorker('ada-both');
				await declareSupervision(id, 'unsupervised');
				await setWorkerDraining(id, false);

				expect((await requestWorkerUpdate(id, REQUEST_ID, 'main', adaId)).outcome).toBe('in-pool');
				expect((await getWorkerById(id))?.update).toBeNull();
			});

			// The machine is this run's whole subject, and `runs.worker_id` is
			// ON DELETE SET NULL — so retiring the machine, which is exactly when its update
			// history gets read, must not be what erases which machine each row was about.
			it('goes on naming its machine after that machine is removed', async () => {
				const id = await freshWorker('ada-run-retired');
				await requestWorkerUpdate(id, REQUEST_ID, 'main', adaId);
				await recordWorkerUpdateReport(id, REQUEST_ID, 'applied', 'Applied.');

				expect(await removeWorker(id)).toBe(true);

				const [run] = await getDb()
					.select()
					.from(runs)
					.where(eq(runs.maintenanceRequestId, REQUEST_ID));
				expect(run.workerId).toBeNull();
				expect(run.maintenanceMachine).toBe('ada-run-retired');
				// The rest of what it says is untouched, so the row still reads as a whole.
				expect(run).toMatchObject({
					status: 'completed',
					maintenanceTarget: 'main',
					workerUserId: adaId,
				});
			});

			// A rename is not backfilled: the row names the machine as it was when asked.
			it('names the machine as it stood when it was asked, not as renamed since', async () => {
				const id = await freshWorker('ada-run-renamed');
				await requestWorkerUpdate(id, REQUEST_ID, 'main', adaId);

				await updateWorkerDisplayName(id, 'ada-run-renamed-later');

				const [run] = await updateRunsFor(id);
				expect(run.maintenanceMachine).toBe('ada-run-renamed');
			});

			// Deleting the project cascades the run away; the machine's later report must
			// still be recorded rather than throwing on a row that is gone.
			it('survives its project being deleted, and still records the report', async () => {
				const id = await freshWorker('ada-run-cascade');
				await requestWorkerUpdate(id, REQUEST_ID, 'main', adaId);

				await deleteProjectFromDb(UPDATE_PROJECT_ID);

				expect(await updateRunsFor(id)).toHaveLength(0);
				const reported = await recordWorkerUpdateReport(id, REQUEST_ID, 'applied', 'Applied.');
				expect(reported?.update).toMatchObject({ status: 'applied' });
			});
		});

		// Issue #972 — the durable unit that *delivers* the request, written in the same
		// transaction as the row and the run for the reason #971 gave for the run: a
		// recorded request with no dispatch is a request nothing will ever deliver.
		describe('the dispatch it enqueues (issue #972)', () => {
			it('creates one pending dispatch ranked ahead of waiting work, linked to the run', async () => {
				const id = await freshWorker('ada-dispatch');

				const result = await requestWorkerUpdate(id, REQUEST_ID, 'main', adaId);

				if (result.outcome !== 'requested') throw new Error(`got '${result.outcome}'`);
				const rows = await updateDispatchesFor(id);
				expect(rows).toHaveLength(1);
				expect(rows[0].id).toBe(result.dispatch.id);
				expect(rows[0]).toMatchObject({
					state: 'pending',
					phase: 'worker-update',
					source: 'manual',
					projectId: UPDATE_PROJECT_ID,
					runId: result.runId,
					dedupKey: `worker-update:${REQUEST_ID}`,
					attempt: 0,
				});
				// The whole point of the issue: it outranks everything already queued, and
				// the column takes a negative with no migration.
				expect(rows[0].priority).toBeLessThan(0);
				expect(rows[0].jobPayload).toMatchObject({
					type: 'worker-update',
					workerId: id,
					requestId: REQUEST_ID,
					target: 'main',
				});
			});

			// Without this the previous request's dispatch would sit in the queue waiting
			// to push a build the row has moved off.
			it('supersedes the previous dispatch when the machine is re-targeted', async () => {
				const id = await freshWorker('ada-dispatch-retarget');
				await requestWorkerUpdate(id, REQUEST_ID, 'main', adaId);

				await requestWorkerUpdate(id, OTHER_REQUEST_ID, 'v2', adaId);

				const rows = await updateDispatchesFor(id);
				expect(rows).toHaveLength(2);
				expect(rows[0]).toMatchObject({
					state: 'cancelled',
					dedupKey: `worker-update:${REQUEST_ID}`,
				});
				expect(rows[0].lastError).toContain('Superseded');
				expect(rows[1]).toMatchObject({
					state: 'pending',
					dedupKey: `worker-update:${OTHER_REQUEST_ID}`,
				});
			});

			// The same all-or-nothing boundary the run has: a machine with no project has
			// nothing written at all.
			it('writes no dispatch for a machine enrolled in no project', async () => {
				const created = await createWorker({
					ownerUserId: adaId,
					displayName: 'ada-dispatch-orphan',
					capabilities: ['claude'],
					credentialHash: 'hash-ada-dispatch-orphan',
				});
				await setWorkerDraining(created.id, true);

				expect((await requestWorkerUpdate(created.id, REQUEST_ID, 'main', adaId)).outcome).toBe(
					'no-project',
				);
				expect(await updateDispatchesFor(created.id)).toHaveLength(0);
			});

			// The other refusal: still in the dispatch pool, so the write is declined by
			// its own `WHERE` and none of the three rows is created.
			it('writes no dispatch for a machine that is not draining', async () => {
				const id = await freshWorker('ada-dispatch-in-pool');
				await setWorkerDraining(id, false);

				expect((await requestWorkerUpdate(id, REQUEST_ID, 'main', adaId)).outcome).toBe('in-pool');
				expect(await updateDispatchesFor(id)).toHaveLength(0);
			});
		});

		// Issue #972's upgrade boundary. Before it, a request lived on the `workers` row
		// alone and the reconnect hook pushed it directly; that hook now wakes a dispatch,
		// so a request an older control plane recorded and never delivered would have
		// nothing to wake. Only a real database settles this one: what it does turns on
		// the dispatch's dedup key and on the `runs` row the request may or may not have.
		describe('adoptOutstandingWorkerUpdateRequest (issue #972)', () => {
			/** Roll a machine's state back to what a pre-#972 control plane would have left. */
			async function dropDispatch(workerId: string): Promise<void> {
				await getDb()
					.delete(dispatches)
					.where(sql`${dispatches.jobPayload} ->> 'workerId' = ${workerId}`);
			}

			/** …and back to pre-#971, where the request had no run either. */
			async function dropRun(workerId: string): Promise<void> {
				await getDb().delete(runs).where(eq(runs.workerId, workerId));
			}

			it('writes the missing dispatch and links it to the run the request already has', async () => {
				const id = await freshWorker('ada-adopt');
				const requested = await requestWorkerUpdate(id, REQUEST_ID, 'main', adaId);
				if (requested.outcome !== 'requested') throw new Error(`got '${requested.outcome}'`);
				await dropDispatch(id);

				const adopted = await adoptOutstandingWorkerUpdateRequest(id);

				expect(adopted).toBeDefined();
				expect(adopted).toMatchObject({
					state: 'pending',
					phase: 'worker-update',
					source: 'manual',
					projectId: UPDATE_PROJECT_ID,
					// The run the operator is already looking at, not a second one.
					runId: requested.runId,
					dedupKey: `worker-update:${REQUEST_ID}`,
				});
				expect(adopted?.priority).toBeLessThan(0);
				expect(adopted?.jobPayload).toMatchObject({
					type: 'worker-update',
					workerId: id,
					requestId: REQUEST_ID,
					target: 'main',
				});
				expect(await updateDispatchesFor(id)).toHaveLength(1);
				expect(await updateRunsFor(id)).toHaveLength(1);
			});

			// A request older than #971 has no run at all: the dispatch is what will
			// deliver it, so the record of that delivery starts here rather than nowhere.
			it('creates the run too when the request predates issue #971', async () => {
				const id = await freshWorker('ada-adopt-no-run');
				await requestWorkerUpdate(id, REQUEST_ID, 'main', adaId);
				await dropDispatch(id);
				await dropRun(id);

				const adopted = await adoptOutstandingWorkerUpdateRequest(id);

				const runRows = await updateRunsFor(id);
				expect(runRows).toHaveLength(1);
				expect(runRows[0]).toMatchObject({
					kind: 'worker-update',
					phase: 'worker-update',
					status: 'running',
					maintenanceRequestId: REQUEST_ID,
					maintenanceTarget: 'main',
					maintenanceMachine: 'ada-adopt-no-run',
				});
				expect(adopted?.runId).toBe(runRows[0].id);
			});

			// The ordinary path since the issue: the request already carries its dispatch
			// out of the transaction that recorded it, so a reconnect writes nothing.
			it('writes nothing when the request already has its dispatch', async () => {
				const id = await freshWorker('ada-adopt-noop');
				await requestWorkerUpdate(id, REQUEST_ID, 'main', adaId);

				expect(await adoptOutstandingWorkerUpdateRequest(id)).toBeUndefined();
				expect(await updateDispatchesFor(id)).toHaveLength(1);
			});

			// Idempotent on the dedup key in *any* state, so a machine that reconnects
			// after its update was delivered never collects a second dispatch for it.
			it('writes nothing when the request’s dispatch has already been settled', async () => {
				const id = await freshWorker('ada-adopt-settled');
				await requestWorkerUpdate(id, REQUEST_ID, 'main', adaId);
				await getDb()
					.update(dispatches)
					.set({ state: 'completed', outcome: 'worker-update-pushed', completedAt: new Date() })
					.where(sql`${dispatches.jobPayload} ->> 'workerId' = ${id}`);

				expect(await adoptOutstandingWorkerUpdateRequest(id)).toBeUndefined();
				expect(await updateDispatchesFor(id)).toHaveLength(1);
			});

			it('is idempotent across repeated reconnects', async () => {
				const id = await freshWorker('ada-adopt-twice');
				await requestWorkerUpdate(id, REQUEST_ID, 'main', adaId);
				await dropDispatch(id);

				const first = await adoptOutstandingWorkerUpdateRequest(id);
				const second = await adoptOutstandingWorkerUpdateRequest(id);

				expect(first).toBeDefined();
				expect(second).toBeUndefined();
				expect(await updateDispatchesFor(id)).toHaveLength(1);
				expect(await updateRunsFor(id)).toHaveLength(1);
			});

			// `update_request_id` is cleared by the report, so an answered request is not
			// outstanding — reconnecting must not resurrect it.
			it('writes nothing once the machine has reported an outcome', async () => {
				const id = await freshWorker('ada-adopt-answered');
				await requestWorkerUpdate(id, REQUEST_ID, 'main', adaId);
				await recordWorkerUpdateReport(id, REQUEST_ID, 'applied', 'Applied.');
				await dropDispatch(id);

				expect(await adoptOutstandingWorkerUpdateRequest(id)).toBeUndefined();
				expect(await updateDispatchesFor(id)).toHaveLength(0);
			});

			it('writes nothing for a machine nobody has asked to update', async () => {
				const id = await freshWorker('ada-adopt-unasked');

				expect(await adoptOutstandingWorkerUpdateRequest(id)).toBeUndefined();
				expect(await updateDispatchesFor(id)).toHaveLength(0);
			});

			// The same boundary `requestWorkerUpdate` answers `no-project` for: nothing to
			// hang the run and the dispatch off.
			it('writes nothing for a machine enrolled in no project', async () => {
				const id = await freshWorker('ada-adopt-orphan');
				await requestWorkerUpdate(id, REQUEST_ID, 'main', adaId);
				await dropDispatch(id);
				await getDb()
					.delete(workerProjectEnrollments)
					.where(eq(workerProjectEnrollments.workerId, id));

				expect(await adoptOutstandingWorkerUpdateRequest(id)).toBeUndefined();
				expect(await updateDispatchesFor(id)).toHaveLength(0);
			});

			it('writes nothing for an unknown machine rather than throwing', async () => {
				const unknown = '00000000-0000-4000-8000-0000000000ff';
				await expect(adoptOutstandingWorkerUpdateRequest(unknown)).resolves.toBeUndefined();
			});
		});
	});

	// Issue #955/#956 — the abandoned-worktree sweep's own five columns. What only a
	// real database settles is which of them a *request* writes: since the fleet is
	// asked weekly by a timer nobody is watching, a request that cleared the reported
	// outcome would blank `swarm workers sweeps` for every machine that had not
	// answered the latest ask.
	describe('requestWorktreeSweep / recordWorktreeSweepReport', () => {
		const REQUEST_ID = '66666666-6666-4666-8666-666666666666';
		const OTHER_REQUEST_ID = '77777777-7777-4777-8777-777777777777';

		function sweepResult(overrides: Partial<WorktreeSweepResult> = {}): WorktreeSweepResult {
			return {
				removed: [
					{
						projectId: 'swarm',
						taskId: '901',
						path: '/home/ada/swarm/.swarm-workspaces/task-901',
						lastTouchedAt: '2026-08-20T09:00:00.000Z',
						ageDays: 18,
						hadUncommittedChanges: false,
						hadUnpushedCommits: true,
					},
				],
				removedCount: 1,
				keptLiveCount: 0,
				failedCount: 0,
				message: 'Swept 1 project(s): removed 1 abandoned checkout(s), kept 0 still in use.',
				...overrides,
			};
		}

		/**
		 * A registered machine. No draining here, unlike the update request above: a
		 * sweep disturbs no in-flight run, which is what makes the weekly schedule
		 * possible at all.
		 */
		async function freshWorker(name: string): Promise<string> {
			const created = await createWorker({
				ownerUserId: adaId,
				displayName: name,
				capabilities: ['claude'],
				credentialHash: `hash-${name}`,
			});
			return created.id;
		}

		it('leaves a newly registered worker with no request and no outcome', async () => {
			const id = await freshWorker('ada-no-sweep');
			expect((await getWorkerById(id))?.worktreeSweep).toBeNull();
		});

		it('records a request as pending, with no outcome yet', async () => {
			const id = await freshWorker('ada-sweep');

			const requested = await requestWorktreeSweep(id, REQUEST_ID);

			expect(requested?.worktreeSweep).toMatchObject({
				requestId: REQUEST_ID,
				status: null,
				reportedAt: null,
				result: null,
			});
			expect((await getWorkerById(id))?.worktreeSweep).toEqual(requested?.worktreeSweep);
		});

		it('records an outcome and clears the pending marker', async () => {
			const id = await freshWorker('ada-sweep-report');
			await requestWorktreeSweep(id, REQUEST_ID);

			const reported = await recordWorktreeSweepReport(id, REQUEST_ID, 'swept', sweepResult());

			expect(reported?.worktreeSweep).toMatchObject({
				requestId: null,
				status: 'swept',
				result: { removedCount: 1 },
			});
			expect(reported?.worktreeSweep?.reportedAt).toBeInstanceOf(Date);
		});

		// The property the weekly schedule depends on (issue #956): asking replaces the
		// request pair and nothing else, so a machine asleep when the signal went out
		// still reads as what it last swept rather than as never swept.
		it('keeps the reported outcome when the machine is asked again', async () => {
			const id = await freshWorker('ada-sweep-again');
			await requestWorktreeSweep(id, REQUEST_ID);
			const answered = await recordWorktreeSweepReport(id, REQUEST_ID, 'swept', sweepResult());

			const again = await requestWorktreeSweep(id, OTHER_REQUEST_ID);

			expect(again?.worktreeSweep).toMatchObject({
				requestId: OTHER_REQUEST_ID,
				status: 'swept',
				reportedAt: answered?.worktreeSweep?.reportedAt,
				result: { removedCount: 1 },
			});
			// …and the retained outcome answers the *earlier* request, which is what the
			// two instants say when read together.
			const sweep = (await getWorkerById(id))?.worktreeSweep;
			expect(sweep?.reportedAt?.getTime()).toBeLessThanOrEqual(sweep?.requestedAt.getTime() ?? 0);
		});

		// The new answer is what replaces the retained one — the question never does.
		it('replaces the retained outcome when the next report lands', async () => {
			const id = await freshWorker('ada-sweep-replaced');
			await requestWorktreeSweep(id, REQUEST_ID);
			await recordWorktreeSweepReport(id, REQUEST_ID, 'swept', sweepResult());
			await requestWorktreeSweep(id, OTHER_REQUEST_ID);

			await recordWorktreeSweepReport(
				id,
				OTHER_REQUEST_ID,
				'swept',
				sweepResult({ removed: [], removedCount: 0, message: 'nothing was old enough' }),
			);

			expect((await getWorkerById(id))?.worktreeSweep).toMatchObject({
				requestId: null,
				result: { removedCount: 0, message: 'nothing was old enough' },
			});
		});

		// The id match, as on the update side: a report for a request the row has moved
		// on from must not un-pend the one now outstanding — nor overwrite the outcome
		// standing beside it.
		it('ignores a report naming a request the row has moved on from', async () => {
			const id = await freshWorker('ada-sweep-superseded');
			await requestWorktreeSweep(id, REQUEST_ID);
			await recordWorktreeSweepReport(id, REQUEST_ID, 'swept', sweepResult());
			await requestWorktreeSweep(id, OTHER_REQUEST_ID);

			const stale = await recordWorktreeSweepReport(
				id,
				REQUEST_ID,
				'failed',
				sweepResult({ failedCount: 1, message: 'the worktree root was unreadable' }),
			);

			expect(stale).toBeUndefined();
			expect((await getWorkerById(id))?.worktreeSweep).toMatchObject({
				requestId: OTHER_REQUEST_ID,
				status: 'swept',
				result: { removedCount: 1 },
			});
		});

		it('returns a not-found for an unknown worker — not an error', async () => {
			const unknown = '99999999-9999-4999-8999-999999999999';
			expect(await requestWorktreeSweep(unknown, REQUEST_ID)).toBeUndefined();
			expect(
				await recordWorktreeSweepReport(unknown, REQUEST_ID, 'swept', sweepResult()),
			).toBeUndefined();
		});
	});

	// Issue #918 — the build declaration, which is one domain value across two
	// columns. Only a real database catches the pair going half-set.
	describe('build', () => {
		it('leaves a newly registered worker with no declaration', async () => {
			const created = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-fresh-build',
				capabilities: ['claude'],
				credentialHash: 'hash-fresh-build',
			});

			// Registering a machine is not declaring a build — only the program that
			// connects knows its own.
			expect(created.build).toBeNull();
			expect((await getWorkerById(created.id))?.build).toBeNull();
		});

		it('persists both columns, leaves them alone when omitted, and clears both on null', async () => {
			const build = { commit: '9f3a1b2c4d5e6f70819a2b3c4d5e6f7081920a3b', dirty: true };
			const created = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-declares-build',
				capabilities: ['claude'],
				credentialHash: 'hash-declares-build',
			});

			await updateWorkerCapabilities(created.id, ['claude'], undefined, undefined, build);
			expect((await getWorkerById(created.id))?.build).toEqual(build);

			// The `swarm workers set-cli` shape again: a caller that knows nothing about
			// builds must not clear one.
			await updateWorkerCapabilities(created.id, ['claude', 'codex']);
			const after = await getWorkerById(created.id);
			expect(after?.capabilities).toEqual(['claude', 'codex']);
			expect(after?.build).toEqual(build);

			// A handshake from a daemon that declared none clears *both* columns, so the
			// pair is never left half-set.
			await updateWorkerCapabilities(created.id, ['claude', 'codex'], undefined, undefined, null);
			expect((await getWorkerById(created.id))?.build).toBeNull();
		});
	});

	describe('updateWorkerCapabilities', () => {
		it('changes the capability set', async () => {
			const created = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-laptop',
				capabilities: ['claude'],
				credentialHash: 'hash-a',
			});
			const updated = await updateWorkerCapabilities(created.id, ['antigravity', 'codex']);
			expect(updated?.capabilities).toEqual(['antigravity', 'codex']);
			expect((await getWorkerById(created.id))?.capabilities).toEqual(['antigravity', 'codex']);
		});

		it('returns undefined for a missing id', async () => {
			expect(
				await updateWorkerCapabilities('00000000-0000-4000-8000-000000000000', ['claude']),
			).toBeUndefined();
		});

		it('rejects a capability reduction when an enrollment requires a CLI being removed', async () => {
			await seedProject({ id: 'proj-repo-test', repo: 'jkwiecien/repo-test' });
			const worker = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-multi-cli',
				capabilities: ['claude', 'codex'],
				credentialHash: 'hash-multi',
			});
			await createEnrollment({
				workerId: worker.id,
				projectId: 'proj-repo-test',
				status: 'active',
				allowedClis: ['claude'],
				allowedPhases: ['implementation'],
				concurrencyAllocation: 1,
				sharingConsent: true,
			});

			await expect(updateWorkerCapabilities(worker.id, ['codex'])).rejects.toThrow(
				WorkerCapabilityReductionError,
			);

			// Worker capabilities remain unchanged
			const rechecked = await getWorkerById(worker.id);
			expect(rechecked?.capabilities).toEqual(['claude', 'codex']);
		});

		it('allows capability expansion and compatible reductions when existing enrollments remain subsets', async () => {
			await seedProject({ id: 'proj-compat-test', repo: 'jkwiecien/compat-test' });
			const worker = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-compat',
				capabilities: ['claude', 'codex', 'antigravity'],
				credentialHash: 'hash-compat',
			});
			await createEnrollment({
				workerId: worker.id,
				projectId: 'proj-compat-test',
				status: 'active',
				allowedClis: ['claude'],
				allowedPhases: ['implementation'],
				concurrencyAllocation: 1,
				sharingConsent: true,
			});

			// Compatible reduction: removing 'antigravity' (not required by enrollment)
			const reduced = await updateWorkerCapabilities(worker.id, ['claude', 'codex']);
			expect(reduced?.capabilities).toEqual(['claude', 'codex']);

			// Expansion: adding 'antigravity' back
			const expanded = await updateWorkerCapabilities(worker.id, [
				'claude',
				'codex',
				'antigravity',
			]);
			expect(expanded?.capabilities).toEqual(['claude', 'codex', 'antigravity']);
		});

		it('serializes capability reduction against concurrent enrollment creation without breaking the invariant', async () => {
			await seedProject({ id: 'proj-race-test', repo: 'jkwiecien/race-test' });
			const worker = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-race',
				capabilities: ['claude', 'codex'],
				credentialHash: 'hash-race',
			});

			const [enrollRes, capRes] = await Promise.allSettled([
				createEnrollment({
					workerId: worker.id,
					projectId: 'proj-race-test',
					status: 'active',
					allowedClis: ['codex'],
					allowedPhases: ['implementation'],
					concurrencyAllocation: 1,
					sharingConsent: true,
				}),
				updateWorkerCapabilities(worker.id, ['claude']),
			]);

			// One transaction must succeed and one must be rejected
			const succeeded = [enrollRes, capRes].filter((r) => r.status === 'fulfilled');
			const rejected = [enrollRes, capRes].filter((r) => r.status === 'rejected');

			expect(succeeded).toHaveLength(1);
			expect(rejected).toHaveLength(1);

			if (capRes.status === 'fulfilled') {
				// Capability reduction to ['claude'] won, enrollment with ['codex'] was rejected
				expect(enrollRes.status).toBe('rejected');
				expect((enrollRes as PromiseRejectedResult).reason).toBeInstanceOf(
					AllowedClisNotCapableError,
				);
			} else {
				// Enrollment with ['codex'] won, capability reduction to ['claude'] was rejected
				expect(capRes.status === 'rejected').toBe(true);
				expect((capRes as PromiseRejectedResult).reason).toBeInstanceOf(
					WorkerCapabilityReductionError,
				);
			}

			// Verify invariant holds in database: active enrollment's allowedClis is a subset of worker capabilities
			const finalWorker = await getWorkerById(worker.id);
			const enrollments = await getDb()
				.select()
				.from(workerProjectEnrollments)
				.where(eq(workerProjectEnrollments.workerId, worker.id));

			const workerCapSet = new Set(finalWorker?.capabilities ?? []);
			for (const enrollment of enrollments) {
				for (const cli of enrollment.allowedClis as AgentCli[]) {
					expect(workerCapSet.has(cli)).toBe(true);
				}
			}
		});
	});

	// Issue #783 — the acceptance criteria, at the storage layer: a declaration is the
	// owner's durable statement, and the probe a handshake writes no longer erases it.
	describe('setWorkerDeclaredCapabilities', () => {
		async function seedWorker(capabilities: AgentCli[], hash: string) {
			return createWorker({
				ownerUserId: adaId,
				displayName: `ada-${hash}`,
				capabilities,
				credentialHash: hash,
			});
		}

		it('survives a handshake that re-probes a different set — the whole point', async () => {
			const worker = await seedWorker(['claude', 'codex'], 'hash-declare-durable');
			await setWorkerDeclaredCapabilities(worker.id, ['claude']);

			// The daemon reconnects and reports everything it found, as it always does.
			const afterHandshake = await updateWorkerCapabilities(worker.id, [
				'claude',
				'codex',
				'antigravity',
			]);

			// The probe is recorded honestly...
			expect(afterHandshake?.probedCapabilities).toEqual(['claude', 'codex', 'antigravity']);
			// ...and the declaration still decides what the worker is routable on.
			expect(afterHandshake?.capabilities).toEqual(['claude']);
			expect(afterHandshake?.declaredCapabilities).toEqual(['claude']);
			expect((await getWorkerById(worker.id))?.capabilities).toEqual(['claude']);
		});

		it('refuses a declaration naming a CLI this machine has never probed, leaving the row alone', async () => {
			const worker = await seedWorker(['claude'], 'hash-declare-unprobed');

			await expect(setWorkerDeclaredCapabilities(worker.id, ['claude', 'codex'])).rejects.toThrow(
				WorkerCapabilityNotProbedError,
			);

			const rechecked = await getWorkerById(worker.id);
			expect(rechecked?.declaredCapabilities).toBeNull();
			expect(rechecked?.capabilities).toEqual(['claude']);
		});

		it('refuses a declaration dropping a CLI an active enrollment requires, leaving the row alone', async () => {
			await seedProject({ id: 'proj-declare-drop', repo: 'jkwiecien/declare-drop' });
			const worker = await seedWorker(['claude', 'codex'], 'hash-declare-drop');
			await createEnrollment({
				workerId: worker.id,
				projectId: 'proj-declare-drop',
				status: 'active',
				allowedClis: ['codex'],
				allowedPhases: ['implementation'],
				concurrencyAllocation: 1,
				sharingConsent: true,
			});

			await expect(setWorkerDeclaredCapabilities(worker.id, ['claude'])).rejects.toThrow(
				WorkerCapabilityReductionError,
			);

			const rechecked = await getWorkerById(worker.id);
			expect(rechecked?.declaredCapabilities).toBeNull();
			expect(rechecked?.capabilities).toEqual(['claude', 'codex']);
		});

		it('clears the declaration with null, making the probe effective again', async () => {
			const worker = await seedWorker(['claude', 'codex'], 'hash-declare-clear');
			await setWorkerDeclaredCapabilities(worker.id, ['claude']);
			expect((await getWorkerById(worker.id))?.capabilities).toEqual(['claude']);

			const cleared = await setWorkerDeclaredCapabilities(worker.id, null);

			expect(cleared?.declaredCapabilities).toBeNull();
			expect(cleared?.capabilities).toEqual(['claude', 'codex']);
		});

		// The other half of the rule: a declaration outranks a re-probe, but a CLI the
		// probe proved absent (`ENOENT`, issue #559) is still never dispatched.
		it('intersects a declaration with a probe that narrows below it', async () => {
			const worker = await seedWorker(['claude', 'codex'], 'hash-declare-narrow');
			await setWorkerDeclaredCapabilities(worker.id, ['claude', 'codex']);

			const afterHandshake = await updateWorkerCapabilities(worker.id, ['claude']);

			expect(afterHandshake?.capabilities).toEqual(['claude']);
			expect(afterHandshake?.declaredCapabilities).toEqual(['claude', 'codex']);
		});

		it('409s a narrowing probe only when an enrollment needed the CLI it dropped', async () => {
			await seedProject({ id: 'proj-declare-409', repo: 'jkwiecien/declare-409' });
			const worker = await seedWorker(['claude', 'codex'], 'hash-declare-409');
			await createEnrollment({
				workerId: worker.id,
				projectId: 'proj-declare-409',
				status: 'active',
				allowedClis: ['claude'],
				allowedPhases: ['implementation'],
				concurrencyAllocation: 1,
				sharingConsent: true,
			});
			await setWorkerDeclaredCapabilities(worker.id, ['claude', 'codex']);

			// Dropping `codex`: still effective for `claude`, which is all the enrollment needs.
			expect((await updateWorkerCapabilities(worker.id, ['claude']))?.capabilities).toEqual([
				'claude',
			]);
			// Dropping `claude` too: nothing effective is left for the enrollment.
			await expect(updateWorkerCapabilities(worker.id, ['codex'])).rejects.toThrow(
				WorkerCapabilityReductionError,
			);
		});

		it('returns undefined for a missing id', async () => {
			expect(
				await setWorkerDeclaredCapabilities('00000000-0000-4000-8000-000000000000', ['claude']),
			).toBeUndefined();
		});

		it('reports the raw probe column as probedCapabilities whether or not anything is declared', async () => {
			const worker = await seedWorker(['claude', 'codex'], 'hash-declare-probed');
			expect(worker.probedCapabilities).toEqual(['claude', 'codex']);
			expect(worker.declaredCapabilities).toBeNull();

			const declared = await setWorkerDeclaredCapabilities(worker.id, ['codex']);
			expect(declared?.probedCapabilities).toEqual(['claude', 'codex']);
			expect(declared?.capabilities).toEqual(['codex']);
		});
	});

	describe('updateWorkerDisplayName', () => {
		it('changes the display name', async () => {
			const created = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-laptop',
				capabilities: ['claude'],
				credentialHash: 'hash-rename',
			});
			const updated = await updateWorkerDisplayName(created.id, 'ada-desktop');
			expect(updated?.displayName).toBe('ada-desktop');
			expect((await getWorkerById(created.id))?.displayName).toBe('ada-desktop');
		});

		it('returns undefined for a missing id', async () => {
			expect(
				await updateWorkerDisplayName('00000000-0000-4000-8000-000000000000', 'new-name'),
			).toBeUndefined();
		});

		it('rejects with a unique violation when the owner already has another worker by that name', async () => {
			await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-laptop',
				capabilities: ['claude'],
				credentialHash: 'hash-rename-a',
			});
			const second = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-desktop',
				capabilities: ['claude'],
				credentialHash: 'hash-rename-b',
			});

			await expect(updateWorkerDisplayName(second.id, 'ada-laptop')).rejects.toThrow();
		});
	});

	describe('removeWorker', () => {
		it('removes a worker and reports whether one existed', async () => {
			const created = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-laptop',
				capabilities: ['claude'],
				credentialHash: 'hash-a',
			});
			expect(await removeWorker(created.id)).toBe(true);
			expect(await getWorkerById(created.id)).toBeUndefined();
			expect(await removeWorker(created.id)).toBe(false);
		});
	});

	describe('listWorkersForOwner', () => {
		it("returns only that owner's workers, oldest first", async () => {
			const first = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-laptop',
				capabilities: ['claude'],
				credentialHash: 'hash-a',
			});
			const second = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-desktop',
				capabilities: ['codex'],
				credentialHash: 'hash-b',
			});
			await createWorker({
				ownerUserId: graceId,
				displayName: 'grace-laptop',
				capabilities: ['claude'],
				credentialHash: 'hash-c',
			});

			const adas = await listWorkersForOwner(adaId);
			expect(adas.map((w) => w.id)).toEqual([first.id, second.id]);
			expect(await listWorkersForOwner(graceId)).toHaveLength(1);
		});

		it('returns an empty array for an owner with no workers', async () => {
			expect(await listWorkersForOwner(adaId)).toEqual([]);
		});
	});

	describe('listAllWorkers', () => {
		it('returns every owner’s workers oldest first, still without a credential hash', async () => {
			const first = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-laptop',
				capabilities: ['claude'],
				credentialHash: 'hash-a',
			});
			const second = await createWorker({
				ownerUserId: graceId,
				displayName: 'grace-laptop',
				capabilities: ['codex'],
				credentialHash: 'hash-b',
			});

			const all = await listAllWorkers();

			expect(all.map((w) => w.id)).toEqual([first.id, second.id]);
			for (const worker of all) {
				expect(worker).not.toHaveProperty('credentialHash');
			}
		});

		it('returns an empty array when nothing is registered', async () => {
			expect(await listAllWorkers()).toEqual([]);
		});
	});

	describe('cascade deletes', () => {
		it('drops a worker when its owner is deleted', async () => {
			const created = await createWorker({
				ownerUserId: adaId,
				displayName: 'ada-laptop',
				capabilities: ['claude'],
				credentialHash: 'hash-a',
			});

			await getDb().delete(users).where(eq(users.id, adaId));

			expect(await getWorkerById(created.id)).toBeUndefined();
		});
	});
});
