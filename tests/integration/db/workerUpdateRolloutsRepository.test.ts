import { beforeEach, describe, expect, it } from 'vitest';

import { createUser } from '../../../src/db/repositories/usersRepository.js';
import { createWorker } from '../../../src/db/repositories/workersRepository.js';
import {
	advanceUnderRolloutLock,
	createRollout,
	findInProgressRolloutForOwner,
	listAdvanceableRollouts,
	listAdvanceableRolloutsForOwner,
} from '../../../src/db/repositories/workerUpdateRolloutsRepository.js';
import type {
	WorkerUpdateRolloutMemberState,
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
		): Promise<string> {
			const created = await createRollout({
				requestedByUserId: ownerUserId,
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
	},
);
