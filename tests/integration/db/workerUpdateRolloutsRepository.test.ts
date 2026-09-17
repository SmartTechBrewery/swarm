import { beforeEach, describe, expect, it } from 'vitest';

import { closeDb } from '../../../src/db/client.js';
import { createUser } from '../../../src/db/repositories/usersRepository.js';
import { createWorker } from '../../../src/db/repositories/workersRepository.js';
import {
	advanceUnderRolloutLock,
	createRollout,
	findAdvanceableInstallationRollout,
	findAnyInProgressOwnerRollout,
	findInProgressInstallationRollout,
	findInProgressRolloutForOwner,
	findLatestInstallationRollout,
	findLatestRolloutForOwner,
	findRolloutHoldElsewhere,
	listAdvanceableRollouts,
	listAdvanceableRolloutsForOwner,
} from '../../../src/db/repositories/workerUpdateRolloutsRepository.js';
import type {
	WorkerUpdateRolloutMemberState,
	WorkerUpdateRolloutScope,
	WorkerUpdateRolloutStatus,
} from '../../../src/identity/worker-update-rollout.js';
import { truncateAll } from '../helpers/db.js';

/**
 * Issue #1023's read predicate, pinned where the SQL is. "Advanceable" is what the
 * two triggers select through (`src/router/worker-rollout-advance.ts`), and the
 * property that matters is the one a halt used to break: a rollout that stopped with
 * machines still committed to it stays selectable until every one of them has
 * settled, because settling well is the only thing that returns a drained machine to
 * the dispatch pool.
 *
 * `in_progress` is deliberately unconditional — a rollout cut off before
 * `completeIfSettled` wrote `completed` must still be reachable, or the partial
 * unique index blocks its owner's next rollout forever.
 *
 * Issue #1024's two partial unique indexes and its scope-narrowed reads are pinned
 * here for the same reason: both uniqueness rules are decided by an index rather than
 * by a read, so the only honest place to state them is against real SQL.
 */
describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)(
	'workerUpdateRolloutsRepository (integration)',
	() => {
		let adaId: string;
		let graceId: string;
		let adaWorkerId: string;
		let graceWorkerId: string;

		beforeEach(async () => {
			await truncateAll();
			const ada = await createUser({ identifier: 'ada@example.com', displayName: 'Ada' });
			const grace = await createUser({ identifier: 'grace@example.com', displayName: 'Grace' });
			adaId = ada.id;
			graceId = grace.id;
			adaWorkerId = (
				await createWorker({
					ownerUserId: adaId,
					displayName: 'ada-laptop',
					capabilities: ['claude'],
					credentialHash: 'hash-ada',
				})
			).id;
			graceWorkerId = (
				await createWorker({
					ownerUserId: graceId,
					displayName: 'grace-mini',
					capabilities: ['claude'],
					credentialHash: 'hash-grace',
				})
			).id;
		});

		/**
		 * One rollout in a stated durable state. The status and the member states are
		 * written through the very writer an advance uses, so nothing here reaches past
		 * the repository's own surface to arrange a row.
		 */
		async function givenRollout(
			ownerUserId: string,
			workerId: string,
			status: WorkerUpdateRolloutStatus,
			memberStates: WorkerUpdateRolloutMemberState[],
			scope: WorkerUpdateRolloutScope = 'owner',
		): Promise<string> {
			const created = await createRollout({
				requestedByUserId: ownerUserId,
				scope,
				target: 'main',
				waveSize: 1,
				workerIds: [workerId],
			});
			await advanceUnderRolloutLock(created.rollout.id, async (_loaded, write) => {
				for (const state of memberStates) await write.setMember(workerId, { state });
				if (status !== 'in_progress') await write.setStatus(status, 'the build was bad');
			});
			return created.rollout.id;
		}

		function ids(rollouts: { id: string }[]): string[] {
			return rollouts.map((rollout) => rollout.id);
		}

		it('selects a rollout in progress that still has members to move', async () => {
			const id = await givenRollout(adaId, adaWorkerId, 'in_progress', ['draining']);

			expect(ids(await listAdvanceableRollouts())).toEqual([id]);
		});

		// The mirror of the halted case: a rollout cut off between its last member
		// settling and `completeIfSettled` must still be reachable, or nothing ever writes
		// `completed` and the partial unique index blocks its owner's next rollout forever.
		it('selects a rollout in progress whose every member has already settled', async () => {
			const id = await givenRollout(adaId, adaWorkerId, 'in_progress', ['done']);

			expect(ids(await listAdvanceableRollouts())).toEqual([id]);
		});

		// The defect this predicate exists for: the member is committed and its machine is
		// out of the dispatch pool, and only a later advance settles it.
		it('selects a halted rollout that still holds an unsettled member', async () => {
			const id = await givenRollout(adaId, adaWorkerId, 'halted', ['verifying']);

			expect(ids(await listAdvanceableRollouts())).toEqual([id]);
		});

		it('selects a halted rollout whose member is merely draining', async () => {
			const id = await givenRollout(adaId, adaWorkerId, 'halted', ['draining']);

			expect(ids(await listAdvanceableRollouts())).toEqual([id]);
		});

		// Once every member has settled there is nothing left to decide, so the halted
		// rollout drops out of the sweep by itself rather than being swept forever.
		it('ignores a halted rollout whose every member has settled', async () => {
			await givenRollout(adaId, adaWorkerId, 'halted', ['failed']);

			expect(await listAdvanceableRollouts()).toEqual([]);
		});

		it('never selects a completed rollout', async () => {
			await givenRollout(adaId, adaWorkerId, 'completed', ['done']);

			expect(await listAdvanceableRollouts()).toEqual([]);
		});

		it('scopes the owner read to that owner’s own rollouts', async () => {
			const adaRollout = await givenRollout(adaId, adaWorkerId, 'halted', ['signalled']);
			const graceRollout = await givenRollout(graceId, graceWorkerId, 'in_progress', ['queued']);

			expect(ids(await listAdvanceableRolloutsForOwner(adaId))).toEqual([adaRollout]);
			expect(ids(await listAdvanceableRolloutsForOwner(graceId))).toEqual([graceRollout]);
		});

		// An owner has at most one `in_progress` rollout, but the halted rows are exempt
		// from that index, so the owner read is a list — and it answers oldest first, the
		// order the sweep uses too.
		it('answers an owner’s halted and live rollouts together, oldest first', async () => {
			const older = await givenRollout(adaId, adaWorkerId, 'halted', ['signalled']);
			const newer = await givenRollout(adaId, adaWorkerId, 'in_progress', ['queued']);

			expect(ids(await listAdvanceableRolloutsForOwner(adaId))).toEqual([older, newer]);
			expect(ids(await listAdvanceableRollouts())).toEqual([older, newer]);
		});

		// "Start a new one is the way past a halt" rests on this staying narrow: widening
		// the advance reads must not make a halted rollout block its owner's next one.
		it('still reports no rollout in progress when the owner’s only one has halted', async () => {
			await givenRollout(adaId, adaWorkerId, 'halted', ['verifying']);

			expect(await findInProgressRolloutForOwner(adaId)).toBeUndefined();
		});

		/**
		 * The other half of issue #1023, and the reason it needed one: because a halted
		 * rollout no longer blocks its owner's next one *and* now goes on advancing, two
		 * of an operator's rollouts routinely hold the same machine. The drain is then
		 * handed between them rather than undrained under whichever is still using it,
		 * which rests entirely on this read answering "does anyone else still hold it".
		 */
		describe('findRolloutHoldElsewhere', () => {
			it('answers undefined when no other rollout has the machine', async () => {
				const only = await givenRollout(adaId, adaWorkerId, 'halted', ['signalled']);

				expect(await findRolloutHoldElsewhere(adaWorkerId, only)).toBeUndefined();
			});

			it('finds the hold of a rollout that has committed to the machine', async () => {
				const older = await givenRollout(adaId, adaWorkerId, 'halted', ['signalled']);
				const newer = await givenRollout(adaId, adaWorkerId, 'in_progress', ['draining']);

				expect(await findRolloutHoldElsewhere(adaWorkerId, newer)).toEqual({
					drainedByRollout: false,
				});
				expect(await findRolloutHoldElsewhere(adaWorkerId, older)).toEqual({
					drainedByRollout: false,
				});
			});

			// The hand-off's own question: whoever settles last must know the drain is a
			// rollout's to give back rather than the operator's to keep.
			it('reports a hold that took the machine out of the pool itself', async () => {
				const older = await createRollout({
					requestedByUserId: adaId,
					scope: 'owner',
					target: 'main',
					waveSize: 1,
					workerIds: [adaWorkerId],
				});
				await advanceUnderRolloutLock(older.rollout.id, async (_loaded, write) => {
					await write.setMember(adaWorkerId, { state: 'signalled', drainedByRollout: true });
					await write.setStatus('halted', 'the build was bad');
				});
				const newer = await givenRollout(adaId, adaWorkerId, 'in_progress', ['draining']);

				expect(await findRolloutHoldElsewhere(adaWorkerId, newer)).toEqual({
					drainedByRollout: true,
				});
			});

			// A `queued` member is not a hold: the rollout has not reached it, drained
			// nothing for it and owes nothing on it — the same line `takeNextWave` draws.
			it('ignores a rollout that has only queued the machine', async () => {
				const older = await givenRollout(adaId, adaWorkerId, 'halted', ['signalled']);
				await givenRollout(adaId, adaWorkerId, 'in_progress', ['queued']);

				expect(await findRolloutHoldElsewhere(adaWorkerId, older)).toBeUndefined();
			});

			// And a settled one is not a hold either, which is what makes the answer fall
			// back to undefined by itself as the other rollout finishes.
			it('ignores a rollout that has settled the machine', async () => {
				const older = await givenRollout(adaId, adaWorkerId, 'halted', ['signalled']);
				await givenRollout(adaId, adaWorkerId, 'in_progress', ['draining', 'done']);

				expect(await findRolloutHoldElsewhere(adaWorkerId, older)).toBeUndefined();
			});

			it('never answers with another machine’s hold', async () => {
				const adaRollout = await givenRollout(adaId, adaWorkerId, 'halted', ['signalled']);
				await givenRollout(graceId, graceWorkerId, 'in_progress', ['draining']);

				expect(await findRolloutHoldElsewhere(adaWorkerId, adaRollout)).toBeUndefined();
			});
		});

		/**
		 * The two uniqueness rules of issue #1024, pinned where the SQL is. Both are
		 * decided by a partial unique index rather than by a read, so the fact under test
		 * is the `23505` — and the fact that the *other* rule does not also fire, since
		 * "an owner rollout and an installation rollout can coexist as rows" is exactly
		 * what the narrowed owner index buys, and what makes the policy (not the index)
		 * the thing that refuses to create the second one.
		 */
		describe('the two partial unique indexes', () => {
			function startRolloutRow(ownerUserId: string, scope: WorkerUpdateRolloutScope) {
				return createRollout({
					requestedByUserId: ownerUserId,
					scope,
					target: 'main',
					waveSize: 1,
					workerIds: [],
				});
			}

			/**
			 * Assert the insert is refused by an index, then **drop the connection pool**.
			 *
			 * The pool has to go because `node-postgres` leaves a pooled client's extended
			 * protocol desynchronized after a query that errored *inside* a transaction: the
			 * next query on that client answers with the previous one's result, silently, so
			 * every later test in the file would read someone else's rows. `getDb()` rebuilds
			 * the pool lazily from `DATABASE_URL`, so this costs one reconnect and nothing
			 * else. It is a driver behaviour, not a fact about the rollout schema — but it is
			 * the reason these two cases end the way they do rather than carrying on.
			 */
			async function expectRefusedByIndex(insert: Promise<unknown>): Promise<void> {
				await expect(insert).rejects.toThrowError(
					expect.objectContaining({ cause: expect.objectContaining({ code: '23505' }) }),
				);
				await closeDb();
			}

			it('refuses a second live installation-wide rollout', async () => {
				await startRolloutRow(adaId, 'installation');

				// A *different* operator's, so nothing but the installation index can refuse it.
				await expectRefusedByIndex(startRolloutRow(graceId, 'installation'));
			});

			it('refuses a second live rollout for the same owner', async () => {
				await startRolloutRow(adaId, 'owner');

				await expectRefusedByIndex(startRolloutRow(adaId, 'owner'));
			});

			// The narrowing: an administrator's installation-wide rollout must not consume
			// the per-owner slot their own fleet rollout needs. The two coexist as *rows*;
			// it is `startRollout`'s cross-scope read, not this index, that refuses the
			// second one in practice.
			it('lets an owner rollout and an installation rollout coexist as rows', async () => {
				const owned = await startRolloutRow(adaId, 'owner');
				const installation = await startRolloutRow(adaId, 'installation');

				expect(owned.rollout.scope).toBe('owner');
				expect(installation.rollout.scope).toBe('installation');
			});

			// A halted installation-wide rollout is exempt, exactly as a halted owner one
			// is — which is what makes "start a new one" the way past a halt for both.
			it('lets a new installation rollout start once the last one halted', async () => {
				await givenRollout(adaId, adaWorkerId, 'halted', ['verifying'], 'installation');

				await expect(startRolloutRow(graceId, 'installation')).resolves.toMatchObject({
					rollout: { scope: 'installation', status: 'in_progress' },
				});
			});
		});

		/**
		 * The scope-narrowed reads (issue #1024). An installation-wide rollout carries the
		 * administrator who started it in `requested_by_user_id`, so every owner read has
		 * to exclude it or that administrator's own owner-scoped surfaces answer with a
		 * rollout over machines they do not own.
		 */
		describe('scope-narrowed reads', () => {
			it('keeps an administrator’s installation rollout out of their owner reads', async () => {
				const installation = await createRollout({
					requestedByUserId: adaId,
					scope: 'installation',
					target: 'main',
					waveSize: 1,
					workerIds: [adaWorkerId, graceWorkerId],
				});

				expect(await findInProgressRolloutForOwner(adaId)).toBeUndefined();
				expect(await findLatestRolloutForOwner(adaId)).toBeUndefined();
				expect((await findInProgressInstallationRollout())?.id).toBe(installation.rollout.id);
				expect((await findLatestInstallationRollout())?.id).toBe(installation.rollout.id);
			});

			it('keeps an owner rollout out of the installation reads', async () => {
				await givenRollout(adaId, adaWorkerId, 'in_progress', ['draining']);

				expect(await findInProgressInstallationRollout()).toBeUndefined();
				expect(await findLatestInstallationRollout()).toBeUndefined();
				expect(await findAdvanceableInstallationRollout()).toBeUndefined();
			});

			// The cross-scope refusal's own read: one example of an owner mid-rollout, and
			// never an installation-wide row.
			it('answers the cross-scope read with any owner’s live rollout', async () => {
				const graceRollout = await givenRollout(graceId, graceWorkerId, 'in_progress', ['queued']);

				expect((await findAnyInProgressOwnerRollout())?.id).toBe(graceRollout);
			});

			it('answers the cross-scope read with nothing when only halted owner rollouts exist', async () => {
				await givenRollout(adaId, adaWorkerId, 'halted', ['verifying']);

				expect(await findAnyInProgressOwnerRollout()).toBeUndefined();
			});

			// The trigger read: a halted installation rollout still owing an answer stays
			// selectable, because a machine it drained belongs to somebody who never asked.
			it('selects a halted installation rollout that still holds an unsettled member', async () => {
				const id = await givenRollout(
					adaId,
					graceWorkerId,
					'halted',
					['verifying'],
					'installation',
				);

				expect((await findAdvanceableInstallationRollout())?.id).toBe(id);
			});

			it('stops selecting an installation rollout once its every member has settled', async () => {
				await givenRollout(adaId, graceWorkerId, 'halted', ['failed'], 'installation');

				expect(await findAdvanceableInstallationRollout()).toBeUndefined();
			});

			// The tick is deliberately scope-blind: a rollout worth advancing is worth
			// advancing whatever it is over.
			it('sweeps both scopes through the unscoped advanceable read', async () => {
				const owned = await givenRollout(adaId, adaWorkerId, 'in_progress', ['draining']);
				const installation = await givenRollout(
					graceId,
					graceWorkerId,
					'in_progress',
					['draining'],
					'installation',
				);

				expect(ids(await listAdvanceableRollouts())).toEqual([owned, installation]);
			});
		});
	},
);
