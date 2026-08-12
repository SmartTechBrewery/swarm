import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getDb } from '../../../src/db/client.js';
import { createRun } from '../../../src/db/repositories/runsRepository.js';
import { createUser } from '../../../src/db/repositories/usersRepository.js';
import {
	createEnrollment,
	getEnrollment,
	getEnrollmentById,
	listEnrollmentsForProject,
	listEnrollmentsForWorker,
	removeEnrollment,
	setEnrollmentSharingConsent,
	updateEnrollmentConstraints,
	updateEnrollmentStatus,
} from '../../../src/db/repositories/workerEnrollmentsRepository.js';
import {
	acquireLease,
	setCurrentRun,
} from '../../../src/db/repositories/workerSessionsRepository.js';
import { createWorker } from '../../../src/db/repositories/workersRepository.js';
import { workerProjectEnrollments } from '../../../src/db/schema/workerProjectEnrollments.js';
import { workerSessions } from '../../../src/db/schema/workerSessions.js';
import { workers } from '../../../src/db/schema/workers.js';
import {
	DEFAULT_ENROLLMENT_ALLOWED_PHASES,
	isRoutable,
} from '../../../src/identity/worker-enrollment.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

const TTL = 60_000;
const PROJECT_A = 'proj-enroll-a';
const PROJECT_B = 'proj-enroll-b';

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)(
	'workerEnrollmentsRepository (integration)',
	() => {
		let adaId: string;
		let workerA: string;
		let workerB: string;

		beforeEach(async () => {
			await truncateAll();
			await seedProject({ id: PROJECT_A, repo: 'jkwiecien/enroll-a' });
			await seedProject({ id: PROJECT_B, repo: 'jkwiecien/enroll-b' });
			adaId = (await createUser({ identifier: 'ada@example.com', displayName: 'Ada' })).id;
			workerA = (
				await createWorker({
					ownerUserId: adaId,
					displayName: 'ada-laptop',
					capabilities: ['claude', 'codex'],
					credentialHash: 'hash-a',
				})
			).id;
			workerB = (
				await createWorker({
					ownerUserId: adaId,
					displayName: 'ada-desktop',
					capabilities: ['claude'],
					credentialHash: 'hash-b',
				})
			).id;
		});

		function enroll(workerId: string, projectId: string, overrides = {}) {
			return createEnrollment({
				workerId,
				projectId,
				status: 'active',
				allowedClis: ['claude'],
				allowedPhases: ['implementation'],
				concurrencyAllocation: 1,
				sharingConsent: true,
				...overrides,
			});
		}

		describe('create / get / list', () => {
			it('creates and reads back an enrollment by id and by (worker, project)', async () => {
				const created = await enroll(workerA, PROJECT_A);
				expect(created.status).toBe('active');
				expect(created.allowedClis).toEqual(['claude']);

				expect(await getEnrollmentById(created.id)).toMatchObject({ id: created.id });
				expect(await getEnrollment(workerA, PROJECT_A)).toMatchObject({ id: created.id });
			});

			it('rejects a second enrollment for the same (worker, project) with 23505', async () => {
				await enroll(workerA, PROJECT_A);
				// drizzle wraps the pg error; the unique-violation code lives on the cause.
				await expect(enroll(workerA, PROJECT_A)).rejects.toMatchObject({
					cause: expect.objectContaining({ code: '23505' }),
				});
			});

			it('lists a worker’s enrollments across projects', async () => {
				await enroll(workerA, PROJECT_A);
				await enroll(workerA, PROJECT_B);
				const list = await listEnrollmentsForWorker(workerA);
				expect(list.map((e) => e.projectId).sort()).toEqual([PROJECT_A, PROJECT_B]);
			});
		});

		describe('project isolation', () => {
			it('a worker enrolled only in A never appears in B’s roster', async () => {
				await enroll(workerA, PROJECT_A);
				const rosterA = await listEnrollmentsForProject(PROJECT_A);
				const rosterB = await listEnrollmentsForProject(PROJECT_B);
				expect(rosterA.map((e) => e.workerId)).toEqual([workerA]);
				expect(rosterB).toEqual([]);
			});
		});

		describe('revocation flips isRoutable without deleting the worker/session', () => {
			it('suspending the enrollment makes it not routable, worker + session intact', async () => {
				const created = await enroll(workerA, PROJECT_A);
				await acquireLease(workerA, TTL); // a live session exists for the worker
				expect(isRoutable(created)).toBe(true);

				const suspended = await updateEnrollmentStatus(created.id, 'suspended');
				expect(suspended?.status).toBe('suspended');
				expect(suspended && isRoutable(suspended)).toBe(false);

				// The enrollment row, the worker, and the session all survive the revoke.
				expect(await getEnrollmentById(created.id)).toMatchObject({ status: 'suspended' });
				const workerRows = await getDb().select().from(workers).where(eq(workers.id, workerA));
				expect(workerRows).toHaveLength(1);
				const sessionRows = await getDb()
					.select()
					.from(workerSessions)
					.where(eq(workerSessions.workerId, workerA));
				expect(sessionRows).toHaveLength(1);
			});

			it('revoking sharing consent makes it not routable, worker + session intact', async () => {
				const created = await enroll(workerA, PROJECT_A);
				await acquireLease(workerA, TTL);
				expect(isRoutable(created)).toBe(true);

				const revoked = await setEnrollmentSharingConsent(created.id, false);
				// Still active (not deleted, not suspended) — only consent changed.
				expect(revoked?.status).toBe('active');
				expect(revoked && isRoutable(revoked)).toBe(false);

				const sessionRows = await getDb()
					.select()
					.from(workerSessions)
					.where(eq(workerSessions.workerId, workerA));
				expect(sessionRows).toHaveLength(1);
			});

			it('re-granting consent on an active enrollment restores routability', async () => {
				const created = await enroll(workerA, PROJECT_A, { sharingConsent: false });
				expect(isRoutable(created)).toBe(false);
				const regranted = await setEnrollmentSharingConsent(created.id, true);
				expect(regranted && isRoutable(regranted)).toBe(true);
			});
		});

		describe('updateConstraints', () => {
			it('updates allowed CLIs, phases and concurrency, leaving the rest intact', async () => {
				const created = await enroll(workerA, PROJECT_A);
				const updated = await updateEnrollmentConstraints(created.id, {
					allowedClis: ['claude', 'codex'],
					allowedPhases: ['review', 'implementation'],
					concurrencyAllocation: 3,
				});
				expect(updated).toMatchObject({
					allowedClis: ['claude', 'codex'],
					allowedPhases: ['review', 'implementation'],
					concurrencyAllocation: 3,
					status: 'active',
				});
			});

			// Issue #509: the phase selection is the owner's alone, so widening it must not
			// disturb the CLI constraint, the allocation, or the approval state.
			it('changes only the phase selection when that is the whole patch', async () => {
				const created = await enroll(workerA, PROJECT_A, { concurrencyAllocation: 2 });
				const updated = await updateEnrollmentConstraints(created.id, {
					allowedPhases: ['planning'],
				});
				expect(updated).toMatchObject({
					allowedPhases: ['planning'],
					allowedClis: created.allowedClis,
					concurrencyAllocation: 2,
					status: 'active',
					sharingConsent: true,
				});
			});
		});

		describe('remove', () => {
			it('removes an enrollment and reports whether one existed', async () => {
				const created = await enroll(workerA, PROJECT_A);
				expect(await removeEnrollment(created.id)).toBe(true);
				expect(await getEnrollmentById(created.id)).toBeUndefined();
				expect(await removeEnrollment(created.id)).toBe(false);
			});
		});

		describe('cascade deletes', () => {
			it('drops an enrollment when its worker is deleted', async () => {
				const created = await enroll(workerB, PROJECT_A);
				await getDb().delete(workers).where(eq(workers.id, workerB));
				expect(await getEnrollmentById(created.id)).toBeUndefined();
			});

			it('drops an enrollment when its project is deleted', async () => {
				const created = await enroll(workerA, PROJECT_A);
				const { projects } = await import('../../../src/db/schema/projects.js');
				await getDb().delete(projects).where(eq(projects.id, PROJECT_A));
				expect(await getEnrollmentById(created.id)).toBeUndefined();
			});
		});

		describe('busy/current-run precondition (Phase-2 session join)', () => {
			it('a live session pointing at a running run is what a roster derives busy from', async () => {
				await enroll(workerA, PROJECT_A);
				const session = await acquireLease(workerA, TTL);
				const runId = await createRun({
					projectId: PROJECT_A,
					repository: 'jkwiecien/enroll-a',
					taskId: 't-busy',
					phase: 'implementation',
				});
				expect(await setCurrentRun(workerA, session.fencingToken, runId, TTL)).toBe(true);

				// The session now carries the running run — the exact state
				// deriveWorkerRunState reads to report the worker busy.
				const sessionRows = await getDb()
					.select()
					.from(workerSessions)
					.where(eq(workerSessions.workerId, workerA));
				expect(sessionRows[0]?.currentRunId).toBe(runId);
			});
		});

		describe('table row shape', () => {
			it('persists the columns the schema declares', async () => {
				const created = await enroll(workerA, PROJECT_A, {
					status: 'pending',
					allowedClis: ['codex'],
					allowedPhases: ['implementation'],
					concurrencyAllocation: 2,
					sharingConsent: false,
				});
				const [row] = await getDb()
					.select()
					.from(workerProjectEnrollments)
					.where(eq(workerProjectEnrollments.id, created.id));
				expect(row).toMatchObject({
					workerId: workerA,
					projectId: PROJECT_A,
					status: 'pending',
					allowedClis: ['codex'],
					allowedPhases: ['implementation'],
					concurrencyAllocation: 2,
					sharingConsent: false,
				});
			});

			// The migration backfills existing rows with this default, so a row written
			// without a phase selection must permit every phase — which is what keeps
			// dispatch behaviour identical for enrollments that predate issue #509.
			it('defaults allowed_phases to every phase when the insert names none', async () => {
				const [row] = await getDb()
					.insert(workerProjectEnrollments)
					.values({
						workerId: workerA,
						projectId: PROJECT_A,
						status: 'active',
						allowedClis: ['claude'],
						concurrencyAllocation: 1,
						sharingConsent: true,
					})
					.returning();
				expect(row.allowedPhases).toEqual([...DEFAULT_ENROLLMENT_ALLOWED_PHASES]);
			});
		});
	},
);
