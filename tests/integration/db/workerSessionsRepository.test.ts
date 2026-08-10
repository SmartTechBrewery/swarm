import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { getDb } from '../../../src/db/client.js';
import { createRun } from '../../../src/db/repositories/runsRepository.js';
import { createUser } from '../../../src/db/repositories/usersRepository.js';
import {
	acquireLease,
	getLiveSession,
	getRetainedSession,
	heartbeat,
	releaseLease,
	setCurrentRun,
} from '../../../src/db/repositories/workerSessionsRepository.js';
import { createWorker } from '../../../src/db/repositories/workersRepository.js';
import { runs } from '../../../src/db/schema/runs.js';
import { workerSessions } from '../../../src/db/schema/workerSessions.js';
import { workers } from '../../../src/db/schema/workers.js';
import { WorkerSessionHeldError } from '../../../src/identity/worker-session.js';
import { validateFencingToken } from '../../../src/identity/worker-session-service.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

const TTL = 60_000;
const PROJECT_ID = 'proj-worker-sessions';

/** Push a worker's session heartbeat far enough into the past that it is expired under `TTL`. */
async function expireSession(workerId: string): Promise<void> {
	await getDb()
		.update(workerSessions)
		.set({ lastHeartbeatAt: new Date(Date.now() - 10 * TTL) })
		.where(eq(workerSessions.workerId, workerId));
}

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)(
	'workerSessionsRepository (integration)',
	() => {
		let adaId: string;
		let workerA: string;
		let workerB: string;

		beforeEach(async () => {
			await truncateAll();
			await seedProject({ id: PROJECT_ID, repo: 'jkwiecien/worker-sessions-repo' });
			adaId = (await createUser({ identifier: 'ada@example.com', displayName: 'Ada' })).id;
			workerA = (
				await createWorker({
					ownerUserId: adaId,
					displayName: 'ada-laptop',
					capabilities: ['claude'],
					credentialHash: 'hash-a',
				})
			).id;
			workerB = (
				await createWorker({
					ownerUserId: adaId,
					displayName: 'ada-desktop',
					capabilities: ['codex'],
					credentialHash: 'hash-b',
				})
			).id;
		});

		describe('acquireLease', () => {
			it('inserts the first session at fencing token 1', async () => {
				const session = await acquireLease(workerA, TTL);
				expect(session.workerId).toBe(workerA);
				expect(session.fencingToken).toBe(1);
				expect(session.currentRunId).toBeNull();
				expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
			});

			// The "a genuinely competing second daemon is still refused" case: it holds the
			// same credential but not the lease's `sessionId`/`fencingToken`, so it presents
			// no proof of possession and hits the liveness refusal unchanged (issue #608).
			it('rejects a second acquire while a live session is held', async () => {
				await acquireLease(workerA, TTL);
				await expect(acquireLease(workerA, TTL)).rejects.toBeInstanceOf(WorkerSessionHeldError);
				// Still exactly one row for the worker.
				const rows = await getDb()
					.select()
					.from(workerSessions)
					.where(eq(workerSessions.workerId, workerA));
				expect(rows).toHaveLength(1);
			});

			it('lets exactly one of two concurrent acquires win', async () => {
				const results = await Promise.allSettled([
					acquireLease(workerA, TTL),
					acquireLease(workerA, TTL),
				]);
				const fulfilled = results.filter((r) => r.status === 'fulfilled');
				const rejected = results.filter((r) => r.status === 'rejected');
				expect(fulfilled).toHaveLength(1);
				expect(rejected).toHaveLength(1);
				expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
					WorkerSessionHeldError,
				);
			});

			it('re-acquires an expired session with a bumped fencing token, reusing one row', async () => {
				const first = await acquireLease(workerA, TTL);
				expect(first.fencingToken).toBe(1);

				await expireSession(workerA);

				const second = await acquireLease(workerA, TTL);
				expect(second.fencingToken).toBe(2);
				// The expired lease was replaced in place, not duplicated.
				const rows = await getDb()
					.select()
					.from(workerSessions)
					.where(eq(workerSessions.workerId, workerA));
				expect(rows).toHaveLength(1);
			});

			it('re-acquires after a graceful release, bumping the fencing token to 2 and reusing one row', async () => {
				const first = await acquireLease(workerA, TTL);
				expect(first.fencingToken).toBe(1);
				expect(await releaseLease(workerA, first.fencingToken)).toBe(true);
				expect(await getLiveSession(workerA, TTL)).toBeUndefined();

				const second = await acquireLease(workerA, TTL);
				// Released row is retained, so the re-acquire bumps fencing token to 2.
				expect(second.fencingToken).toBe(2);
			});

			it('proves a pre-release token cannot heartbeat, set a run, or validate after reacquisition', async () => {
				const first = await acquireLease(workerA, TTL);
				expect(await releaseLease(workerA, first.fencingToken)).toBe(true);

				// Pre-release token cannot perform operations while released.
				expect(await heartbeat(workerA, first.fencingToken, TTL)).toBe(false);
				expect(await validateFencingToken(workerA, first.fencingToken, TTL)).toBe(false);

				const runId = await createRun({
					projectId: PROJECT_ID,
					taskId: 'w-released',
					phase: 'implementation',
				});
				expect(await setCurrentRun(workerA, first.fencingToken, runId, TTL)).toBe(false);

				// Reacquire lease -> gets fencing token 2.
				const second = await acquireLease(workerA, TTL);
				expect(second.fencingToken).toBe(2);

				// Pre-release token (1) STILL cannot heartbeat, set a run, or validate after reacquisition.
				expect(await heartbeat(workerA, first.fencingToken, TTL)).toBe(false);
				expect(await setCurrentRun(workerA, first.fencingToken, runId, TTL)).toBe(false);
				expect(await validateFencingToken(workerA, first.fencingToken, TTL)).toBe(false);

				// The new holder's token (2) works.
				expect(await validateFencingToken(workerA, second.fencingToken, TTL)).toBe(true);
				expect(await heartbeat(workerA, second.fencingToken, TTL)).toBe(true);
				expect(await setCurrentRun(workerA, second.fencingToken, runId, TTL)).toBe(true);
			});

			// Issue #608: a router restart never releases the leases of the sockets it held,
			// so a reconnecting daemon meets its own live row. Presenting the lease it
			// already holds is what stops the TTL from bounding that outage.
			describe('reclaiming a live lease (issue #608)', () => {
				it('hands a live lease back to its own holder with a bumped token, reusing one row', async () => {
					const first = await acquireLease(workerA, TTL);
					expect(first.fencingToken).toBe(1);

					const reclaimed = await acquireLease(workerA, TTL, {
						sessionId: first.id,
						fencingToken: first.fencingToken,
					});

					// The lease is live again from this instant, on the same row, with the
					// fencing counter moved forward.
					expect(reclaimed.id).toBe(first.id);
					expect(reclaimed.fencingToken).toBe(2);
					expect(reclaimed.lastHeartbeatAt.getTime()).toBeGreaterThanOrEqual(
						first.lastHeartbeatAt.getTime(),
					);
					expect(await getLiveSession(workerA, TTL)).toMatchObject({ fencingToken: 2 });
					const rows = await getDb()
						.select()
						.from(workerSessions)
						.where(eq(workerSessions.workerId, workerA));
					expect(rows).toHaveLength(1);
				});

				it('refuses a reclaim carrying a stale fencing token', async () => {
					const first = await acquireLease(workerA, TTL);
					const reclaimed = await acquireLease(workerA, TTL, {
						sessionId: first.id,
						fencingToken: first.fencingToken,
					});
					expect(reclaimed.fencingToken).toBe(2);

					// The superseded holder still remembers token 1 — the row has moved past it.
					await expect(
						acquireLease(workerA, TTL, { sessionId: first.id, fencingToken: 1 }),
					).rejects.toBeInstanceOf(WorkerSessionHeldError);
					expect(await getLiveSession(workerA, TTL)).toMatchObject({ fencingToken: 2 });
				});

				it('refuses a reclaim naming a different session id', async () => {
					const first = await acquireLease(workerA, TTL);

					await expect(
						acquireLease(workerA, TTL, {
							sessionId: '99999999-9999-4999-8999-999999999999',
							fencingToken: first.fencingToken,
						}),
					).rejects.toBeInstanceOf(WorkerSessionHeldError);
					expect(await getLiveSession(workerA, TTL)).toMatchObject({
						id: first.id,
						fencingToken: 1,
					});
				});

				it('leaves the superseded holder unable to heartbeat, attach a run, or validate', async () => {
					const first = await acquireLease(workerA, TTL);
					const runId = await createRun({
						projectId: PROJECT_ID,
						taskId: 'w-reclaim-fencing',
						phase: 'implementation',
					});

					const reclaimed = await acquireLease(workerA, TTL, {
						sessionId: first.id,
						fencingToken: first.fencingToken,
					});

					expect(await heartbeat(workerA, first.fencingToken, TTL)).toBe(false);
					expect(await setCurrentRun(workerA, first.fencingToken, runId, TTL)).toBe(false);
					expect(await validateFencingToken(workerA, first.fencingToken, TTL)).toBe(false);
					// ...while the reclaiming holder's token works.
					expect(await heartbeat(workerA, reclaimed.fencingToken, TTL)).toBe(true);
					expect(await validateFencingToken(workerA, reclaimed.fencingToken, TTL)).toBe(true);
				});

				it('clears the run the reclaimed lease was carrying rather than inheriting it', async () => {
					const first = await acquireLease(workerA, TTL);
					const runId = await createRun({
						projectId: PROJECT_ID,
						taskId: 'w-reclaim-run',
						phase: 'implementation',
					});
					expect(await setCurrentRun(workerA, first.fencingToken, runId, TTL)).toBe(true);

					const reclaimed = await acquireLease(workerA, TTL, {
						sessionId: first.id,
						fencingToken: first.fencingToken,
					});

					expect(reclaimed.currentRunId).toBeNull();
					expect((await getLiveSession(workerA, TTL))?.currentRunId).toBeNull();
				});

				it('lets exactly one of two concurrent reclaims of the same lease win', async () => {
					const first = await acquireLease(workerA, TTL);
					const proof = { sessionId: first.id, fencingToken: first.fencingToken };

					const results = await Promise.allSettled([
						acquireLease(workerA, TTL, proof),
						acquireLease(workerA, TTL, proof),
					]);

					const fulfilled = results.filter((r) => r.status === 'fulfilled');
					const rejected = results.filter((r) => r.status === 'rejected');
					expect(fulfilled).toHaveLength(1);
					expect(rejected).toHaveLength(1);
					expect(
						(fulfilled[0] as PromiseFulfilledResult<{ fencingToken: number }>).value.fencingToken,
					).toBe(2);
					expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
						WorkerSessionHeldError,
					);
				});
			});

			it('gives two different workers of one user independent live sessions', async () => {
				const a = await acquireLease(workerA, TTL);
				const b = await acquireLease(workerB, TTL);
				expect(a.fencingToken).toBe(1);
				expect(b.fencingToken).toBe(1);
				expect(await getLiveSession(workerA, TTL)).toMatchObject({ workerId: workerA });
				expect(await getLiveSession(workerB, TTL)).toMatchObject({ workerId: workerB });
			});
		});

		describe('heartbeat', () => {
			it('refreshes a live session with the matching token', async () => {
				const session = await acquireLease(workerA, TTL);
				expect(await heartbeat(workerA, session.fencingToken, TTL)).toBe(true);
			});

			it('rejects a heartbeat with the old token after the lease was replaced (stale fencing)', async () => {
				const first = await acquireLease(workerA, TTL);
				await expireSession(workerA);
				const second = await acquireLease(workerA, TTL);
				expect(second.fencingToken).toBe(2);

				// The replaced daemon still holds token 1 — its heartbeat must be rejected...
				expect(await heartbeat(workerA, first.fencingToken, TTL)).toBe(false);
				// ...while the new holder's token still works.
				expect(await heartbeat(workerA, second.fencingToken, TTL)).toBe(true);
			});

			it('rejects a heartbeat once the lease has expired', async () => {
				const session = await acquireLease(workerA, TTL);
				await expireSession(workerA);
				expect(await heartbeat(workerA, session.fencingToken, TTL)).toBe(false);
			});
		});

		describe('releaseLease', () => {
			it('does not release with a non-matching token', async () => {
				const session = await acquireLease(workerA, TTL);
				expect(await releaseLease(workerA, session.fencingToken + 99)).toBe(false);
				expect(await getLiveSession(workerA, TTL)).toMatchObject({ workerId: workerA });
			});
		});

		describe('setCurrentRun', () => {
			it('attaches and clears a run on a live, current-token session', async () => {
				const session = await acquireLease(workerA, TTL);
				const runId = await createRun({
					projectId: PROJECT_ID,
					taskId: 'w-1',
					phase: 'implementation',
				});

				expect(await setCurrentRun(workerA, session.fencingToken, runId, TTL)).toBe(true);
				expect((await getLiveSession(workerA, TTL))?.currentRunId).toBe(runId);

				expect(await setCurrentRun(workerA, session.fencingToken, null, TTL)).toBe(true);
				expect((await getLiveSession(workerA, TTL))?.currentRunId).toBeNull();
			});

			it('rejects a run-attach with a stale token', async () => {
				const session = await acquireLease(workerA, TTL);
				const runId = await createRun({
					projectId: PROJECT_ID,
					taskId: 'w-2',
					phase: 'implementation',
				});
				expect(await setCurrentRun(workerA, session.fencingToken + 1, runId, TTL)).toBe(false);
			});

			it('nulls current_run_id when the referenced run is deleted (ON DELETE SET NULL)', async () => {
				const session = await acquireLease(workerA, TTL);
				const runId = await createRun({
					projectId: PROJECT_ID,
					taskId: 'w-3',
					phase: 'implementation',
				});
				await setCurrentRun(workerA, session.fencingToken, runId, TTL);

				await getDb().delete(runs).where(eq(runs.id, runId));

				// The session survives; only its run pointer is cleared.
				expect((await getLiveSession(workerA, TTL))?.currentRunId).toBeNull();
			});
		});

		describe('getRetainedSession', () => {
			it('is undefined for a worker that never acquired a lease', async () => {
				expect(await getRetainedSession(workerA)).toBeUndefined();
			});

			it('keeps the last heartbeat after expiry, while the live lookup reports offline', async () => {
				const session = await acquireLease(workerA, TTL);
				const heartbeatAt = (await getRetainedSession(workerA))?.lastHeartbeatAt;
				expect(heartbeatAt).toBeInstanceOf(Date);

				await expireSession(workerA);

				expect(await getLiveSession(workerA, TTL)).toBeUndefined();
				const retained = await getRetainedSession(workerA);
				// Still the same row (same fencing token), now carrying the expired heartbeat
				// the dashboard shows as "last seen".
				expect(retained?.fencingToken).toBe(session.fencingToken);
				expect(retained?.lastHeartbeatAt.getTime()).toBeLessThan(heartbeatAt!.getTime());
			});

			it('survives a graceful release, so a cleanly stopped worker keeps a last-seen value', async () => {
				const session = await acquireLease(workerA, TTL);
				expect(await releaseLease(workerA, session.fencingToken)).toBe(true);

				expect(await getLiveSession(workerA, TTL)).toBeUndefined();
				expect(await getRetainedSession(workerA)).toMatchObject({
					workerId: workerA,
					fencingToken: session.fencingToken,
				});
			});
		});

		describe('cascade delete', () => {
			it('drops a session when its worker is deleted', async () => {
				await acquireLease(workerA, TTL);
				await getDb().delete(workers).where(eq(workers.id, workerA));

				const rows = await getDb()
					.select()
					.from(workerSessions)
					.where(eq(workerSessions.workerId, workerA));
				expect(rows).toHaveLength(0);
			});
		});
	},
);
