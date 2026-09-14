import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/db/client.js';
import { createUser } from '../../../src/db/repositories/usersRepository.js';
import {
	createEnrollment,
	getEnrollmentById,
} from '../../../src/db/repositories/workerEnrollmentsRepository.js';
import {
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

		/** A registered machine, drained — the only state the request write accepts. */
		async function freshWorker(name: string): Promise<string> {
			const created = await createWorker({
				ownerUserId: adaId,
				displayName: name,
				capabilities: ['claude'],
				credentialHash: `hash-${name}`,
			});
			await setWorkerDraining(created.id, true);
			return created.id;
		}

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

			const result = await requestWorkerUpdate(created.id, REQUEST_ID, 'main', adaId);

			expect(result.outcome).toBe('in-pool');
			expect((await getWorkerById(created.id))?.update).toBeNull();
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
