import { beforeEach, describe, expect, it } from 'vitest';
// Registers the GitHub SCM manifest into `scmProviderRegistry` as a side effect —
// `forceReReview` resolves the project's SCM provider through the real registry,
// not an injected fake, so the registration has to actually run once per process.
import '../../../src/integrations/entrypoint.js';
import {
	claimDispatch,
	completeDispatch,
	getDispatchById,
	listWakeablePendingDispatches,
} from '../../../src/db/repositories/dispatchesRepository.js';
import {
	markReviewVerdictSubmitted,
	REVIEW_VERDICT_CAP,
	reserveReviewVerdict,
} from '../../../src/db/repositories/reviewVerdictsRepository.js';
import { completeRun, createRun } from '../../../src/db/repositories/runsRepository.js';
import { forceReReview } from '../../../src/dispatch/force-re-review.js';
import type { SwarmJob } from '../../../src/queue/jobs.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

const PROJECT_ID = 'proj-force-re-review';
const REPO = 'jkwiecien/force-re-review-repo';
const PR = '508';

/**
 * Reach the review-verdict cap for a PR the way the real Review phase does —
 * `REVIEW_VERDICT_CAP` reserve→submit cycles, each a `request-changes`
 * verdict — landing the last one at `headSha`. Mirrors
 * `tests/integration/db/reviewVerdictsRepository.test.ts`'s own build-up.
 */
async function reachCapAt(headSha: string, reviewId: string): Promise<void> {
	for (let i = 1; i < REVIEW_VERDICT_CAP; i++) {
		const sha = `${headSha}-precap-${i}`;
		await reserveReviewVerdict({
			projectId: PROJECT_ID,
			repository: REPO,
			prNumber: PR,
			headSha: sha,
		});
		await markReviewVerdictSubmitted(
			{ projectId: PROJECT_ID, repository: REPO, prNumber: PR, headSha: sha },
			{ verdict: 'request-changes', reviewId: `${reviewId}-${i}` },
		);
	}
	await reserveReviewVerdict({ projectId: PROJECT_ID, repository: REPO, prNumber: PR, headSha });
	await markReviewVerdictSubmitted(
		{ projectId: PROJECT_ID, repository: REPO, prNumber: PR, headSha },
		{ verdict: 'request-changes', reviewId },
	);
}

/** A capped, `manual-intervention-required` Review run — the state `forceReReview` recovers from. */
async function seedCappedReviewRun(headSha: string, reviewId: string): Promise<string> {
	await reachCapAt(headSha, reviewId);
	const jobPayload: SwarmJob = {
		type: 'scm',
		providerId: 'github',
		projectId: PROJECT_ID,
		event: {
			kind: 'checks',
			action: 'completed',
			repoFullName: REPO,
			workItemId: PR,
			isCommentEvent: false,
			headSha,
			prBranch: `issue-${PR}`,
		},
	};
	const runId = await createRun({
		projectId: PROJECT_ID,
		repository: REPO,
		taskId: PR,
		phase: 'review',
		prNumber: PR,
		jobPayload,
	});
	await completeRun(runId, {
		status: 'completed',
		reviewVerdict: 'request-changes',
		reviewOrdinal: REVIEW_VERDICT_CAP,
		reviewAutomationOutcome: 'manual-intervention-required',
	});
	return runId;
}

// Real Postgres (issue #511's own incident): a dispatch a stale worker refused
// completes `no-trigger` well before this module's `createAndPublishDispatch`
// call returns, so nothing here mocks the dedup-collision path the fix depends
// on — the whole point is to prove it against the actual unique-index/conflict
// behavior `dispatchesRepository.createDispatch` implements, not a stand-in for it.
describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)(
	'forceReReview chaining past a dead dispatch (integration, Postgres)',
	() => {
		beforeEach(async () => {
			await truncateAll();
			await seedProject({ id: PROJECT_ID, repo: REPO });
		});

		it('schedules a fresh dispatch on the first call', async () => {
			const runId = await seedCappedReviewRun('sha-first', 'review-first');

			const result = await forceReReview(runId);

			expect(result).toMatchObject({ capOverride: 'granted', dispatch: 'scheduled' });
			const dispatch = await getDispatchById(result.dispatchId);
			expect(dispatch?.state).toBe('pending');
		});

		it('chains a fresh dispatch once the first resolves dead, instead of reporting it as done', async () => {
			const runId = await seedCappedReviewRun('sha-dead', 'review-dead');

			// The real corrective attempt an operator's first click makes.
			const first = await forceReReview(runId);
			expect(first.dispatch).toBe('scheduled');

			// The actual incident: a worker claims it and settles it `no-trigger`
			// without ever starting Respond-to-review (a stale worker refusing the
			// synthetic event is one way there; this reproduces only the end state).
			await claimDispatch(first.dispatchId, 'test-worker', 60_000);
			await completeDispatch(first.dispatchId, 'no-trigger');

			// A second click must not report that dead dispatch as "already done".
			const second = await forceReReview(runId);

			expect(second).toMatchObject({
				capOverride: 'already-granted',
				dispatch: 'retried',
				previousAttemptOutcome: 'no-trigger',
			});
			expect(second.dispatchId).not.toBe(first.dispatchId);

			// The fresh dispatch is durably pending and actually wakeable — the
			// property that matters: a restarted worker would receive it.
			const wakeable = await listWakeablePendingDispatches();
			expect(wakeable.map((d) => d.id)).toContain(second.dispatchId);
			const originalStillDead = await getDispatchById(first.dispatchId);
			expect(originalStillDead).toMatchObject({ state: 'completed', outcome: 'no-trigger' });
		});

		it('does not duplicate work while a forced dispatch is still genuinely in flight', async () => {
			const runId = await seedCappedReviewRun('sha-active', 'review-active');

			const first = await forceReReview(runId);
			await claimDispatch(first.dispatchId, 'test-worker', 60_000);
			// Left `leased` — not completed at all — a corrective run genuinely in progress.

			const second = await forceReReview(runId);

			expect(second).toMatchObject({
				capOverride: 'already-granted',
				dispatch: 'already-scheduled',
				dispatchId: first.dispatchId,
			});
		});

		it('reports a genuinely successful forced cycle as completed, not retried', async () => {
			const runId = await seedCappedReviewRun('sha-success', 'review-success');

			const first = await forceReReview(runId);
			await claimDispatch(first.dispatchId, 'test-worker', 60_000);
			await completeDispatch(first.dispatchId, 'phase-succeeded');

			const second = await forceReReview(runId);

			expect(second).toMatchObject({
				capOverride: 'already-granted',
				dispatch: 'already-completed',
				dispatchId: first.dispatchId,
				dispatchOutcome: 'phase-succeeded',
			});
		});
	},
);
