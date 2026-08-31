import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/db/client.js';
import {
	ACTIVE_DISPATCH_STATES,
	cancelWaitingDispatch,
	claimDispatch,
	completeDispatch,
	createDispatch,
	type DispatchState,
	failDispatch,
	markDispatchRunning,
} from '../../../src/db/repositories/dispatchesRepository.js';
import {
	abandonReviewVerdict,
	getPriorSubmittedReview,
	getReviewVerdictByHead,
	getReviewVerdictByReviewId,
	getSubmittedReviewSlot,
	grantReviewCapOverride,
	markReviewVerdictSubmitted,
	REVIEW_VERDICT_CAP,
	reserveReviewVerdict,
} from '../../../src/db/repositories/reviewVerdictsRepository.js';
import { reviewVerdicts } from '../../../src/db/schema/reviewVerdicts.js';
import type { SwarmJob } from '../../../src/queue/jobs.js';
import { createMockScmWebhookJob } from '../../helpers/factories.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

// `review_verdicts.project_id` FKs `projects`, so every test needs a seeded project.
const PROJECT_ID = 'proj-review-verdicts';
const REPO = 'jkwiecien/review-verdicts-repo';
const PR = '17';
const LEASE_OWNER = 'test-worker:1';

const key = (headSha: string) => ({
	projectId: PROJECT_ID,
	repository: REPO,
	prNumber: PR,
	headSha,
});

/** States only reachable by actually executing the dispatch. */
const EXECUTED_STATES: readonly DispatchState[] = ['running', 'completed', 'failed'];

/**
 * A review dispatch driven to `state` through the real transitions — the owner a
 * reservation is taken on behalf of (issue #857). Deliberately seeds **no run
 * row**: the reservation is trigger-side and pre-run, which is the shape that
 * leaked in production.
 */
async function seedDispatch(state: DispatchState = 'leased'): Promise<string> {
	const { dispatch } = await createDispatch({
		projectId: PROJECT_ID,
		jobPayload: { ...createMockScmWebhookJob(), projectId: PROJECT_ID } as SwarmJob,
		source: 'manual',
		taskId: PR,
		phase: 'review',
		state: state === 'leased' || state === 'retry-scheduled' ? state : 'pending',
	});
	if (state === 'cancelled') await cancelWaitingDispatch(dispatch.id, 'cleared the queue');
	if (EXECUTED_STATES.includes(state)) {
		await claimDispatch(dispatch.id, LEASE_OWNER, 60_000);
		await markDispatchRunning(dispatch.id, undefined, new Date(Date.now() + 60_000), {
			taskId: PR,
			phase: 'review',
		});
	}
	if (state === 'completed') await completeDispatch(dispatch.id, 'phase-succeeded');
	if (state === 'failed') await failDispatch(dispatch.id, 'boom');
	return dispatch.id;
}

/** The `pending`/`abandoned`/`submitted` state of this PR/head's newest row. */
async function slotStates(headSha: string): Promise<string[]> {
	const rows = await getDb()
		.select({ state: reviewVerdicts.state })
		.from(reviewVerdicts)
		.where(
			and(
				eq(reviewVerdicts.projectId, PROJECT_ID),
				eq(reviewVerdicts.repository, REPO),
				eq(reviewVerdicts.prNumber, PR),
				eq(reviewVerdicts.headSha, headSha),
			),
		);
	return rows.map((row) => row.state);
}

describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)(
	'reviewVerdictsRepository (integration)',
	() => {
		// Every reservation is owned by a dispatch; the default one is `leased`, the
		// state the production trigger reserves from.
		let owner: string;

		beforeEach(async () => {
			await truncateAll();
			await seedProject({ id: PROJECT_ID, repo: REPO });
			owner = await seedDispatch('leased');
		});

		describe('reserveReviewVerdict', () => {
			it('reserves the first slot at ordinal 1', async () => {
				const reservation = await reserveReviewVerdict(key('sha-1'), owner);
				expect(reservation).toMatchObject({ status: 'reserved', ordinal: 1 });
			});

			it('reuses the same-head reservation on a retry instead of allocating a new ordinal', async () => {
				const first = await reserveReviewVerdict(key('sha-1'), owner);
				const retry = await reserveReviewVerdict(key('sha-1'), owner);
				expect(retry).toMatchObject({ status: 'reused', ordinal: 1, state: 'pending' });
				expect(retry).toMatchObject({ id: (first as { id: string }).id });
			});

			it('blocks a different head while another reservation for this PR is still pending', async () => {
				await reserveReviewVerdict(key('sha-1'), owner);
				const blocked = await reserveReviewVerdict(key('sha-2'), owner);
				expect(blocked).toMatchObject({ status: 'blocked', ordinal: 1 });
			});

			it('allocates the second slot once the first is submitted', async () => {
				await reserveReviewVerdict(key('sha-1'), owner);
				await markReviewVerdictSubmitted(key('sha-1'), { verdict: 'request-changes' });
				const second = await reserveReviewVerdict(key('sha-2'), owner);
				expect(second).toMatchObject({ status: 'reserved', ordinal: 2 });
			});

			it('still allocates the last slot at the cap (an initial review plus two re-reviews)', async () => {
				await reserveReviewVerdict(key('sha-1'), owner);
				await markReviewVerdictSubmitted(key('sha-1'), { verdict: 'request-changes' });
				await reserveReviewVerdict(key('sha-2'), owner);
				await markReviewVerdictSubmitted(key('sha-2'), { verdict: 'request-changes' });
				const third = await reserveReviewVerdict(key('sha-3'), owner);
				expect(third).toMatchObject({ status: 'reserved', ordinal: REVIEW_VERDICT_CAP });
			});

			it('rejects the reservation past the cap once every permitted verdict is submitted', async () => {
				for (let i = 1; i <= REVIEW_VERDICT_CAP; i++) {
					await reserveReviewVerdict(key(`sha-${i}`), owner);
					await markReviewVerdictSubmitted(key(`sha-${i}`), { verdict: 'request-changes' });
				}
				const past = await reserveReviewVerdict(key(`sha-${REVIEW_VERDICT_CAP + 1}`), owner);
				expect(past).toEqual({ status: 'capped' });
			});

			it('lets only one distinct head hold the single pending slot at a time', async () => {
				const reservations = await Promise.all(
					['sha-a', 'sha-b', 'sha-c', 'sha-d'].map((sha) => reserveReviewVerdict(key(sha), owner)),
				);
				const reserved = reservations.filter((r) => r.status === 'reserved');
				const blocked = reservations.filter((r) => r.status === 'blocked');
				// Exactly one reservation wins the race for the (single) pending slot;
				// every other concurrent distinct head is blocked behind it.
				expect(reserved).toHaveLength(1);
				expect(blocked).toHaveLength(3);
			});

			it('frees the ordinal for a fresh attempt once a pending reservation is abandoned', async () => {
				await reserveReviewVerdict(key('sha-1'), owner);
				await abandonReviewVerdict(key('sha-1'));
				// The abandoned head's own retry re-reserves ordinal 1, not ordinal 2 —
				// the failed attempt isn't charged against the cap.
				const retry = await reserveReviewVerdict(key('sha-1'), owner);
				expect(retry).toMatchObject({ status: 'reserved', ordinal: 1 });
				// A different head is blocked behind that *retry* — the one-pending-slot
				// rule, now held by the re-reservation rather than the abandoned row.
				const other = await reserveReviewVerdict(key('sha-2'), owner);
				expect(other).toMatchObject({ status: 'blocked', ordinal: 1 });
			});

			// Issue #856's live sequence, ledger half: a Review reserved for one head
			// was dropped as `no-trigger`, the PR moved to a new head, and until the
			// leaked `pending` row was handed back every later Review answered
			// `blocked`. With the hand-back, the new head reserves normally.
			it('lets a new head reserve once the previous head’s reservation is abandoned', async () => {
				await reserveReviewVerdict(key('sha-a'), owner);
				await abandonReviewVerdict(key('sha-a'));

				const newHead = await reserveReviewVerdict(key('sha-b'), owner);

				expect(newHead).toMatchObject({ status: 'reserved', ordinal: 1 });
			});
		});

		// Issue #857 — the class behind #856's single leak: a `pending` slot must not
		// outlive the dispatch it was taken for. Every hand-back is worker-side and
		// can be forgotten; the reservation itself is the one reader a leak harms, so
		// recovery lives here.
		describe('recovering a reservation whose dispatch settled (issue #857)', () => {
			it('recovers the incident’s exact shape — a trigger-side slot with no run row, dropped as no-trigger', async () => {
				// Reserved by a leased dispatch before any run row exists, exactly as the
				// `pr-review` trigger does, then dropped without ever reviewing.
				await reserveReviewVerdict(key('sha-1'), owner);
				expect(await completeDispatch(owner, 'no-trigger')).toBe(true);

				const newHead = await reserveReviewVerdict(key('sha-2'), await seedDispatch('leased'));

				expect(newHead).toMatchObject({ status: 'reserved', ordinal: 1 });
				expect(newHead).toMatchObject({
					recovered: { ordinal: 1, headSha: 'sha-1', dispatchId: owner },
				});
				expect(await slotStates('sha-1')).toEqual(['abandoned']);
			});

			it.each(
				ACTIVE_DISPATCH_STATES,
			)('never clears a slot whose dispatch is still %s', async (state) => {
				const live = await seedDispatch(state);
				await reserveReviewVerdict(key('sha-1'), live);

				const other = await reserveReviewVerdict(key('sha-2'), await seedDispatch('leased'));

				expect(other).toMatchObject({ status: 'blocked', ordinal: 1 });
				expect(await slotStates('sha-1')).toEqual(['pending']);
			});

			it.each([
				'completed',
				'failed',
				'cancelled',
			] as const)('recovers a slot whose dispatch settled as %s', async (state) => {
				const settled = await seedDispatch(state);
				// Reserved while the dispatch was still live, then settled under it.
				await getDb().insert(reviewVerdicts).values({
					projectId: PROJECT_ID,
					repository: REPO,
					prNumber: PR,
					headSha: 'sha-1',
					ordinal: 1,
					state: 'pending',
					dispatchId: settled,
				});

				const next = await reserveReviewVerdict(key('sha-2'), await seedDispatch('leased'));

				expect(next).toMatchObject({ status: 'reserved', ordinal: 1 });
				expect(await slotStates('sha-1')).toEqual(['abandoned']);
			});

			it('recovers a slot whose owner row is gone — a null dispatch_id backs nothing', async () => {
				await reserveReviewVerdict(key('sha-1'), owner);
				await getDb()
					.update(reviewVerdicts)
					.set({ dispatchId: null })
					.where(eq(reviewVerdicts.headSha, 'sha-1'));

				const next = await reserveReviewVerdict(key('sha-2'), await seedDispatch('leased'));

				expect(next).toMatchObject({ status: 'reserved', ordinal: 1 });
				expect(next).toMatchObject({ recovered: { ordinal: 1, dispatchId: null } });
			});

			it('never touches a submitted slot, whatever its dispatch did', async () => {
				await reserveReviewVerdict(key('sha-1'), owner);
				await markReviewVerdictSubmitted(key('sha-1'), { verdict: 'approve', reviewId: '77' });
				await completeDispatch(owner, 'phase-succeeded');

				const next = await reserveReviewVerdict(key('sha-2'), await seedDispatch('leased'));

				expect(next).toMatchObject({ status: 'reserved', ordinal: 2 });
				expect(next).not.toHaveProperty('recovered');
				expect(await getReviewVerdictByHead(PROJECT_ID, REPO, PR, 'sha-1')).toMatchObject({
					state: 'submitted',
					verdict: 'approve',
				});
			});

			it('re-points a reused pending slot at the dispatch now asking, so a live retry is not cleared', async () => {
				await reserveReviewVerdict(key('sha-1'), owner);
				// A manual retry mints a fresh dispatch row and reuses the same head's slot.
				const retry = await seedDispatch('leased');
				expect(await reserveReviewVerdict(key('sha-1'), retry)).toMatchObject({
					status: 'reused',
					state: 'pending',
				});
				// The original dispatch settling must not make the slot recoverable —
				// the retry that now owns it is still reviewing.
				await completeDispatch(owner, 'no-trigger');

				const other = await reserveReviewVerdict(key('sha-2'), await seedDispatch('leased'));

				expect(other).toMatchObject({ status: 'blocked', ordinal: 1 });
			});

			it('keeps the cap at three submitted verdicts — a recovered ordinal is not a spent one', async () => {
				for (const sha of ['sha-1', 'sha-2']) {
					await reserveReviewVerdict(key(sha), owner);
					await markReviewVerdictSubmitted(key(sha), { verdict: 'request-changes' });
				}
				// The leak: the third slot is reserved and its dispatch then dies.
				const leaked = await seedDispatch('leased');
				await reserveReviewVerdict(key('sha-3'), leaked);
				await completeDispatch(leaked, 'no-trigger');

				const recovered = await reserveReviewVerdict(key('sha-4'), await seedDispatch('leased'));
				expect(recovered).toMatchObject({ status: 'reserved', ordinal: REVIEW_VERDICT_CAP });
				await markReviewVerdictSubmitted(key('sha-4'), { verdict: 'request-changes' });

				// Three submitted verdicts in total, not four.
				expect(await reserveReviewVerdict(key('sha-5'), await seedDispatch('leased'))).toEqual({
					status: 'capped',
				});
			});

			it('does not spend an operator’s cap override', async () => {
				await reserveReviewVerdict(key('sha-1'), owner);
				await markReviewVerdictSubmitted(key('sha-1'), { verdict: 'request-changes' });
				expect(await grantReviewCapOverride(key('sha-1'))).toBe('granted');
				const leaked = await seedDispatch('leased');
				await reserveReviewVerdict(key('sha-2'), leaked);
				await completeDispatch(leaked, 'no-trigger');

				// Recovery frees the leaked ordinal, so this reservation is below the cap
				// and the grant is untouched.
				const next = await reserveReviewVerdict(key('sha-3'), await seedDispatch('leased'));

				expect(next).toMatchObject({ status: 'reserved', ordinal: 2 });
				expect(next).not.toHaveProperty('capOverride');
				expect(await getSubmittedReviewSlot(key('sha-1'))).toMatchObject({
					capOverrideConsumedAt: null,
				});
			});
		});

		describe('markReviewVerdictSubmitted', () => {
			it('is idempotent by natural key — repairs a crash between delivery and this write', async () => {
				await reserveReviewVerdict(key('sha-1'), owner);
				const first = await markReviewVerdictSubmitted(key('sha-1'), {
					verdict: 'approve',
					reviewId: '555',
				});
				const second = await markReviewVerdictSubmitted(key('sha-1'), {
					verdict: 'approve',
					reviewId: '555',
				});
				expect(first?.ordinal).toBe(1);
				expect(second?.ordinal).toBe(1);
				const record = await getReviewVerdictByReviewId(PROJECT_ID, REPO, '555');
				expect(record).toMatchObject({ ordinal: 1, state: 'submitted', verdict: 'approve' });
			});

			it('returns undefined when no reservation exists for this PR/head', async () => {
				const result = await markReviewVerdictSubmitted(key('never-reserved'), {
					verdict: 'approve',
				});
				expect(result).toBeUndefined();
			});

			it('submits only the active retry after an abandoned same-head reservation', async () => {
				await reserveReviewVerdict(key('sha-1'), owner);
				await abandonReviewVerdict(key('sha-1'));
				await reserveReviewVerdict(key('sha-1'), owner);

				const submitted = await markReviewVerdictSubmitted(key('sha-1'), {
					verdict: 'approve',
					reviewId: '555',
				});
				expect(submitted?.ordinal).toBe(1);

				const rows = await getDb()
					.select({ state: reviewVerdicts.state, reviewId: reviewVerdicts.reviewId })
					.from(reviewVerdicts)
					.where(
						and(
							eq(reviewVerdicts.projectId, PROJECT_ID),
							eq(reviewVerdicts.repository, REPO),
							eq(reviewVerdicts.prNumber, PR),
							eq(reviewVerdicts.headSha, 'sha-1'),
						),
					);
				expect(rows).toHaveLength(2);
				expect(rows).toEqual(
					expect.arrayContaining([
						{ state: 'abandoned', reviewId: null },
						{ state: 'submitted', reviewId: '555' },
					]),
				);

				const retry = await markReviewVerdictSubmitted(key('sha-1'), {
					verdict: 'approve',
					reviewId: '555',
				});
				expect(retry?.ordinal).toBe(1);
			});

			it('survives a fresh repository call — persisted across process lifecycle', async () => {
				await reserveReviewVerdict(key('sha-1'), owner);
				await markReviewVerdictSubmitted(key('sha-1'), {
					verdict: 'request-changes',
					reviewId: '9',
				});
				const record = await getReviewVerdictByHead(PROJECT_ID, REPO, PR, 'sha-1');
				expect(record).toMatchObject({
					ordinal: 1,
					state: 'submitted',
					verdict: 'request-changes',
					headSha: 'sha-1',
				});
			});
		});

		describe('abandonReviewVerdict', () => {
			it('only touches a pending record — never abandons a submitted verdict', async () => {
				await reserveReviewVerdict(key('sha-1'), owner);
				await markReviewVerdictSubmitted(key('sha-1'), { verdict: 'approve' });
				await abandonReviewVerdict(key('sha-1'));
				const record = await getReviewVerdictByHead(PROJECT_ID, REPO, PR, 'sha-1');
				expect(record?.state).toBe('submitted');
			});

			it('is a no-op when no reservation exists', async () => {
				await expect(abandonReviewVerdict(key('never-reserved'))).resolves.toBeUndefined();
			});
		});

		describe('getReviewVerdictByReviewId / getReviewVerdictByHead', () => {
			it('returns undefined for an unknown review id or head', async () => {
				expect(await getReviewVerdictByReviewId(PROJECT_ID, REPO, 'unknown')).toBeUndefined();
				expect(await getReviewVerdictByHead(PROJECT_ID, REPO, PR, 'unknown')).toBeUndefined();
			});
		});

		describe('getPriorSubmittedReview (issue #328)', () => {
			it('returns undefined when the PR has no submitted review yet', async () => {
				await reserveReviewVerdict(key('sha-1'), owner);
				expect(await getPriorSubmittedReview(PROJECT_ID, REPO, PR, 'sha-1')).toBeUndefined();
			});

			it("excludes the current head's own submitted slot — a same-head retry is not a re-review", async () => {
				await reserveReviewVerdict(key('sha-1'), owner);
				await markReviewVerdictSubmitted(key('sha-1'), { verdict: 'request-changes' });
				// Asked about the very head that was submitted → no *prior* review exists.
				expect(await getPriorSubmittedReview(PROJECT_ID, REPO, PR, 'sha-1')).toBeUndefined();
			});

			it('returns the earlier submitted verdict once a re-review head appears', async () => {
				await reserveReviewVerdict(key('sha-1'), owner);
				await markReviewVerdictSubmitted(key('sha-1'), { verdict: 'request-changes' });
				const prior = await getPriorSubmittedReview(PROJECT_ID, REPO, PR, 'sha-2');
				expect(prior).toMatchObject({
					ordinal: 1,
					state: 'submitted',
					verdict: 'request-changes',
					headSha: 'sha-1',
				});
			});

			it('ignores abandoned and pending slots — only submitted verdicts count', async () => {
				await reserveReviewVerdict(key('sha-1'), owner);
				await abandonReviewVerdict(key('sha-1'));
				await reserveReviewVerdict(key('sha-2'), owner); // pending, not submitted
				expect(await getPriorSubmittedReview(PROJECT_ID, REPO, PR, 'sha-3')).toBeUndefined();
			});

			it('returns the highest-ordinal prior verdict when two were submitted', async () => {
				await reserveReviewVerdict(key('sha-1'), owner);
				await markReviewVerdictSubmitted(key('sha-1'), { verdict: 'request-changes' });
				await reserveReviewVerdict(key('sha-2'), owner);
				await markReviewVerdictSubmitted(key('sha-2'), { verdict: 'approve' });
				const prior = await getPriorSubmittedReview(PROJECT_ID, REPO, PR, 'sha-3');
				expect(prior).toMatchObject({ ordinal: 2, verdict: 'approve', headSha: 'sha-2' });
			});
		});

		// Issue #511 — an operator's explicit "Force re-review" grant. It is the only
		// thing that can push a PR past `REVIEW_VERDICT_CAP`, and it is worth exactly
		// one slot.
		describe('operator cap overrides', () => {
			/** Submit every verdict the automatic cap allows, leaving the PR capped. */
			async function fillToCap(): Promise<void> {
				for (let i = 1; i <= REVIEW_VERDICT_CAP; i++) {
					await reserveReviewVerdict(key(`sha-${i}`), owner);
					await markReviewVerdictSubmitted(key(`sha-${i}`), { verdict: 'request-changes' });
				}
			}

			const cappedKey = () => key(`sha-${REVIEW_VERDICT_CAP}`);

			it('lets one more reservation through, at the next ordinal', async () => {
				await fillToCap();
				expect(await grantReviewCapOverride(cappedKey())).toBe('granted');

				const forced = await reserveReviewVerdict(key('sha-forced'), owner);
				expect(forced).toMatchObject({
					status: 'reserved',
					ordinal: REVIEW_VERDICT_CAP + 1,
					capOverride: true,
				});
			});

			it('is spent by that reservation, so one grant can never license two reviews', async () => {
				await fillToCap();
				await grantReviewCapOverride(cappedKey());
				await reserveReviewVerdict(key('sha-forced'), owner);
				await markReviewVerdictSubmitted(key('sha-forced'), { verdict: 'request-changes' });

				expect(await reserveReviewVerdict(key('sha-forced-2'), owner)).toEqual({
					status: 'capped',
				});
			});

			it('is idempotent — repeated clicks grant one slot, not one each', async () => {
				await fillToCap();
				expect(await grantReviewCapOverride(cappedKey())).toBe('granted');
				expect(await grantReviewCapOverride(cappedKey())).toBe('already-granted');

				await reserveReviewVerdict(key('sha-forced'), owner);
				await markReviewVerdictSubmitted(key('sha-forced'), { verdict: 'request-changes' });
				expect(await reserveReviewVerdict(key('sha-forced-2'), owner)).toEqual({
					status: 'capped',
				});
			});

			it('survives concurrent reservations racing for the single granted slot', async () => {
				await fillToCap();
				await grantReviewCapOverride(cappedKey());

				const reservations = await Promise.all(
					['sha-x', 'sha-y', 'sha-z'].map((sha) => reserveReviewVerdict(key(sha), owner)),
				);
				// One wins the granted slot; the rest are blocked behind it (a pending
				// slot exists) rather than each redeeming the same grant.
				expect(reservations.filter((r) => r.status === 'reserved')).toHaveLength(1);
				expect(reservations.filter((r) => r.status === 'blocked')).toHaveLength(2);
			});

			it('refuses to grant when the PR/head has no submitted verdict', async () => {
				await reserveReviewVerdict(key('sha-1'), owner);
				expect(await grantReviewCapOverride(key('sha-1'))).toBe('no-submitted-slot');
				expect(await grantReviewCapOverride(key('sha-unknown'))).toBe('no-submitted-slot');
			});

			it('changes nothing while no operator grants an override', async () => {
				await fillToCap();
				expect(await reserveReviewVerdict(key('sha-forced'), owner)).toEqual({ status: 'capped' });
			});
		});

		describe('getSubmittedReviewSlot (issue #511)', () => {
			it('returns the submitted slot with the review id the forced response needs', async () => {
				await reserveReviewVerdict(key('sha-1'), owner);
				await markReviewVerdictSubmitted(key('sha-1'), {
					verdict: 'request-changes',
					reviewId: '900123',
				});

				expect(await getSubmittedReviewSlot(key('sha-1'))).toMatchObject({
					ordinal: 1,
					verdict: 'request-changes',
					reviewId: '900123',
					capOverrideGrantedAt: null,
					capOverrideConsumedAt: null,
				});
			});

			it('ignores a slot that was only reserved, never submitted', async () => {
				await reserveReviewVerdict(key('sha-1'), owner);
				expect(await getSubmittedReviewSlot(key('sha-1'))).toBeUndefined();
			});
		});
	},
);
