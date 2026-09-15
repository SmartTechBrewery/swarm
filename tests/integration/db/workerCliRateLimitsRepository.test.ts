import { beforeEach, describe, expect, it } from 'vitest';

import { createUser } from '../../../src/db/repositories/usersRepository.js';
import {
	listActiveCliRateLimitsForWorker,
	listActiveCliRateLimitsForWorkers,
	listActiveWorkerCliRateLimits,
	recordWorkerCliRateLimit,
} from '../../../src/db/repositories/workerCliRateLimitsRepository.js';
import { createWorker, removeWorker } from '../../../src/db/repositories/workersRepository.js';
import { truncateAll } from '../helpers/db.js';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const IN_AN_HOUR = new Date('2026-09-15T13:00:00.000Z');
const IN_TWO_HOURS = new Date('2026-09-15T14:00:00.000Z');
const AN_HOUR_AGO = new Date('2026-09-15T11:00:00.000Z');

/**
 * Issue #981's storage half: a cool-down is a fact about a **pair**, and it
 * releases itself. These pin both — that the key really is `(worker, CLI)` rather
 * than either half of it (the lesson `cli_quotas` learned the hard way in issue
 * #703), and that a lapsed row is invisible to the only read, which is what makes a
 * sweeper unnecessary.
 */
describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)(
	'workerCliRateLimitsRepository (integration)',
	() => {
		let workerId: string;
		let otherWorkerId: string;

		beforeEach(async () => {
			await truncateAll();
			const ada = await createUser({ identifier: 'ada@example.com', displayName: 'Ada' });
			workerId = (
				await createWorker({
					ownerUserId: ada.id,
					displayName: 'm5_pro',
					capabilities: ['claude', 'codex'],
					credentialHash: 'hash-1',
				})
			).id;
			otherWorkerId = (
				await createWorker({
					ownerUserId: ada.id,
					displayName: 'mini',
					capabilities: ['claude'],
					credentialHash: 'hash-2',
				})
			).id;
		});

		it('reads back a live record for the worker and CLI it was written against', async () => {
			await recordWorkerCliRateLimit({
				workerId,
				cli: 'claude',
				expiresAt: IN_AN_HOUR,
				observedAt: NOW,
				resetHint: 'resets at 1pm',
			});

			const live = await listActiveWorkerCliRateLimits([workerId], NOW);

			expect(live.get(workerId)?.get('claude')).toEqual(IN_AN_HOUR);
		});

		// What makes the record self-releasing: nothing clears it, the read simply
		// stops seeing it.
		it('does not return a record whose expiry has already passed', async () => {
			await recordWorkerCliRateLimit({
				workerId,
				cli: 'claude',
				expiresAt: AN_HOUR_AGO,
				observedAt: AN_HOUR_AGO,
			});

			expect(await listActiveWorkerCliRateLimits([workerId], NOW)).toEqual(new Map());
		});

		it('keeps two CLIs on one machine as two rows, re-recording only the one named', async () => {
			await recordWorkerCliRateLimit({
				workerId,
				cli: 'claude',
				expiresAt: IN_AN_HOUR,
				observedAt: NOW,
			});
			await recordWorkerCliRateLimit({
				workerId,
				cli: 'codex',
				expiresAt: IN_AN_HOUR,
				observedAt: NOW,
			});
			// Last observation wins, and only for the pair it names.
			await recordWorkerCliRateLimit({
				workerId,
				cli: 'claude',
				expiresAt: IN_TWO_HOURS,
				observedAt: NOW,
			});

			const clis = (await listActiveWorkerCliRateLimits([workerId], NOW)).get(workerId);
			expect(clis?.get('claude')).toEqual(IN_TWO_HOURS);
			expect(clis?.get('codex')).toEqual(IN_AN_HOUR);
		});

		// Issue #703's lesson, asserted rather than assumed: one machine's spent
		// allowance says nothing about another's.
		it('keeps two machines on one CLI as two independent rows', async () => {
			await recordWorkerCliRateLimit({
				workerId,
				cli: 'claude',
				expiresAt: IN_AN_HOUR,
				observedAt: NOW,
			});
			await recordWorkerCliRateLimit({
				workerId: otherWorkerId,
				cli: 'claude',
				expiresAt: IN_TWO_HOURS,
				observedAt: NOW,
			});

			const live = await listActiveWorkerCliRateLimits([workerId, otherWorkerId], NOW);
			expect(live.get(workerId)?.get('claude')).toEqual(IN_AN_HOUR);
			expect(live.get(otherWorkerId)?.get('claude')).toEqual(IN_TWO_HOURS);
		});

		it('answers an empty map for no workers at all', async () => {
			expect(await listActiveWorkerCliRateLimits([], NOW)).toEqual(new Map());
		});

		// Issue #988's read-model half. The operator surfaces need what the gate's map
		// throws away — which CLI, when it was observed, and the CLI's own words — but
		// they must inherit the same self-releasing filter, or the Workers screen would
		// keep naming a machine that is back and taking work.
		describe('listActiveCliRateLimitsForWorker', () => {
			it('returns the whole record, ordered by CLI, for one machine', async () => {
				await recordWorkerCliRateLimit({
					workerId,
					cli: 'codex',
					expiresAt: IN_TWO_HOURS,
					observedAt: NOW,
				});
				await recordWorkerCliRateLimit({
					workerId,
					cli: 'claude',
					expiresAt: IN_AN_HOUR,
					observedAt: NOW,
					resetHint: 'resets at 1pm',
				});
				// Another machine's cool-down is not this one's.
				await recordWorkerCliRateLimit({
					workerId: otherWorkerId,
					cli: 'claude',
					expiresAt: IN_TWO_HOURS,
					observedAt: NOW,
				});

				expect(await listActiveCliRateLimitsForWorker(workerId, NOW)).toEqual([
					{
						workerId,
						cli: 'claude',
						expiresAt: IN_AN_HOUR,
						observedAt: NOW,
						resetHint: 'resets at 1pm',
					},
					{ workerId, cli: 'codex', expiresAt: IN_TWO_HOURS, observedAt: NOW, resetHint: null },
				]);
			});

			// The same filter the gate's read applies: a lapsed row is invisible, so the
			// surface stops naming the machine without anything having to clear it.
			it('filters a lapsed record out, leaving the machine’s live one', async () => {
				await recordWorkerCliRateLimit({
					workerId,
					cli: 'claude',
					expiresAt: AN_HOUR_AGO,
					observedAt: AN_HOUR_AGO,
				});
				await recordWorkerCliRateLimit({
					workerId,
					cli: 'codex',
					expiresAt: IN_AN_HOUR,
					observedAt: NOW,
				});

				const live = await listActiveCliRateLimitsForWorker(workerId, NOW);
				expect(live.map((limit) => limit.cli)).toEqual(['codex']);
			});

			it('answers an empty list for a machine cooling on nothing', async () => {
				expect(await listActiveCliRateLimitsForWorker(workerId, NOW)).toEqual([]);
			});

			// The batched sibling the rosters read, which must agree with the single-worker
			// one rather than being a second definition of "live".
			it('groups a fleet’s live records by machine, and answers nothing for no machines', async () => {
				await recordWorkerCliRateLimit({
					workerId,
					cli: 'claude',
					expiresAt: IN_AN_HOUR,
					observedAt: NOW,
				});
				await recordWorkerCliRateLimit({
					workerId: otherWorkerId,
					cli: 'claude',
					expiresAt: AN_HOUR_AGO,
					observedAt: AN_HOUR_AGO,
				});

				const byWorker = await listActiveCliRateLimitsForWorkers([workerId, otherWorkerId], NOW);
				expect(byWorker.get(workerId)).toEqual(
					await listActiveCliRateLimitsForWorker(workerId, NOW),
				);
				expect(byWorker.get(otherWorkerId)).toBeUndefined();
				expect(await listActiveCliRateLimitsForWorkers([], NOW)).toEqual(new Map());
			});
		});

		it('cascades a deregistered worker’s records away with it', async () => {
			await recordWorkerCliRateLimit({
				workerId,
				cli: 'claude',
				expiresAt: IN_AN_HOUR,
				observedAt: NOW,
			});

			await removeWorker(workerId);

			expect(await listActiveWorkerCliRateLimits([workerId], NOW)).toEqual(new Map());
		});
	},
);
