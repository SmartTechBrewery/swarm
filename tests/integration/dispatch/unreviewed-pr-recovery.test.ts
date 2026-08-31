import { and, asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getDb } from '../../../src/db/client.js';
import {
	claimDispatch,
	completeDispatch,
	createDispatch,
	type DispatchRow,
	getDispatchById,
	hasActiveDispatchForPullRequest,
	markDispatchRunning,
	recordDispatchResolution,
} from '../../../src/db/repositories/dispatchesRepository.js';
import {
	abandonReviewVerdict,
	listActiveReviewSlotsForPullRequest,
	markReviewVerdictSubmitted,
	reserveReviewVerdict,
} from '../../../src/db/repositories/reviewVerdictsRepository.js';
import { createRun } from '../../../src/db/repositories/runsRepository.js';
import { dispatches } from '../../../src/db/schema/dispatches.js';
import { recoverUnreviewedPullRequests } from '../../../src/dispatch/unreviewed-pr-recovery.js';
import type { SCMProviderManifest } from '../../../src/integrations/scm/manifest.js';
import { registerSCMProvider } from '../../../src/integrations/scm/registry.js';
import type { SwarmJob } from '../../../src/queue/jobs.js';
import type { AggregateCheckStatus, PullRequestDetails } from '../../../src/scm/types.js';
import { createFakeScmProvider } from '../../helpers/factories.js';
import { truncateAll } from '../helpers/db.js';
import { seedProject } from '../helpers/seed.js';

const PROJECT_ID = 'proj-review-recovery';
const REPO = 'jkwiecien/review-recovery-repo';
const OTHER_REPO = 'jkwiecien/review-recovery-other';
const PR = '116';
const HEAD = 'sha-green-head';

const listConflictCandidates = vi.fn<() => Promise<PullRequestDetails[]>>(async () => []);
const getAggregateCheckStatus = vi.fn<() => Promise<AggregateCheckStatus>>(async () => ({
	totalCount: 1,
	checkRuns: [{ name: 'build', status: 'completed', conclusion: 'success' }],
}));

function candidate(overrides: Partial<PullRequestDetails> = {}): PullRequestDetails {
	return {
		number: Number(PR),
		headBranch: `issue-${PR}`,
		headSha: HEAD,
		baseBranch: 'main',
		baseSha: 'sha-base',
		mergeable: true,
		authorLogin: 'operator',
		state: 'open',
		...overrides,
	};
}

/** The `implementation` run row the work-item origin gate requires. */
async function seedImplementationRun(): Promise<void> {
	await createRun({
		projectId: PROJECT_ID,
		repository: REPO,
		taskId: PR,
		phase: 'implementation',
	});
}

/**
 * A dispatch to own a review-verdict reservation. Issue #857 made the owner a
 * required argument of `reserveReviewVerdict` and gave `review_verdicts` a
 * foreign key to `dispatches`, so these cases cannot pass a synthetic id — they
 * care about the ledger's *state*, not about who holds it, but the holder has to
 * be a real row. Left in its default `pending` state, which is active, so a
 * `pending` slot seeded here still blocks exactly as it did before #857.
 */
let verdictOwnerSeq = 0;
async function seedVerdictOwner(): Promise<string> {
	verdictOwnerSeq += 1;
	const { dispatch } = await createDispatch({
		projectId: PROJECT_ID,
		jobPayload: { type: 'scm', providerId: 'github', projectId: PROJECT_ID } as SwarmJob,
		dedupKey: `verdict-owner-${verdictOwnerSeq}`,
		source: 'webhook',
	});
	return dispatch.id;
}

/**
 * Every recovery dispatch this project holds, terminal ones included — read
 * straight off the table because no repository read returns settled rows, and the
 * whole bound under test is about what a *spent* attempt permits next.
 */
async function recoveryDispatches(): Promise<DispatchRow[]> {
	return getDb()
		.select()
		.from(dispatches)
		.where(and(eq(dispatches.projectId, PROJECT_ID), eq(dispatches.source, 'synthetic')))
		.orderBy(asc(dispatches.createdAt));
}

// Real Postgres + Redis/BullMQ, on `dispatcher.test.ts`'s double gate: the whole
// point of this suite is the dedup-key conflict and the dead-attempt walk against
// the actual unique index, plus the two new reads against real rows — none of which
// a stand-in proves. The provider is a fake manifest registered into this file's own
// module registry (no `entrypoint.js` import), so nothing reaches GitHub.
describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE || !process.env.SWARM_TEST_REDIS_AVAILABLE)(
	'unreviewed-pull-request recovery (integration, Postgres + Redis/BullMQ)',
	() => {
		beforeEach(async () => {
			await truncateAll();
			await seedProject({ id: PROJECT_ID, repo: REPO, scm: 'github' });
			listConflictCandidates.mockResolvedValue([candidate()]);
			getAggregateCheckStatus.mockResolvedValue({
				totalCount: 1,
				checkRuns: [{ name: 'build', status: 'completed', conclusion: 'success' }],
			});
		});

		registerSCMProvider({
			id: 'github',
			label: 'GitHub',
			category: 'scm',
			runtimeReady: true,
			webhookRoute: '/github/webhook',
			credentialRoles: [
				{ role: 'reviewer', envVarKey: 'GITHUB_TOKEN_REVIEWER' },
				{ role: 'webhookSecret', envVarKey: 'GITHUB_WEBHOOK_SECRET' },
			],
			provider: createFakeScmProvider({ listConflictCandidates, getAggregateCheckStatus }),
		} as unknown as SCMProviderManifest);

		describe('listActiveReviewSlotsForPullRequest', () => {
			it('returns live slots in ordinal order and excludes abandoned ones', async () => {
				const key = { projectId: PROJECT_ID, repository: REPO, prNumber: PR };
				await reserveReviewVerdict({ ...key, headSha: 'sha-1' }, await seedVerdictOwner());
				await markReviewVerdictSubmitted(
					{ ...key, headSha: 'sha-1' },
					{ verdict: 'request-changes', reviewId: 'review-1' },
				);
				await reserveReviewVerdict({ ...key, headSha: 'sha-2' }, await seedVerdictOwner());
				await abandonReviewVerdict({ ...key, headSha: 'sha-2' });

				const slots = await listActiveReviewSlotsForPullRequest(PROJECT_ID, REPO, PR);

				expect(slots).toEqual([
					{
						ordinal: 1,
						state: 'submitted',
						headSha: 'sha-1',
						capOverrideGrantedAt: null,
						capOverrideConsumedAt: null,
					},
				]);
			});

			it('does not bleed across two repositories of one project', async () => {
				await reserveReviewVerdict(
					{ projectId: PROJECT_ID, repository: OTHER_REPO, prNumber: PR, headSha: 'sha-1' },
					await seedVerdictOwner(),
				);

				expect(await listActiveReviewSlotsForPullRequest(PROJECT_ID, REPO, PR)).toEqual([]);
				expect(await listActiveReviewSlotsForPullRequest(PROJECT_ID, OTHER_REPO, PR)).toHaveLength(
					1,
				);
			});
		});

		describe('hasActiveDispatchForPullRequest', () => {
			/**
			 * A dispatch that has already resolved its trigger — the only kind carrying
			 * `repository`/`pr_number`, and so the only kind this read can see.
			 */
			async function seedResolvedDispatch(
				state: 'pending' | 'leased' | 'running' | 'retry-scheduled' | 'completed',
				repository = REPO,
			): Promise<string> {
				const { dispatch } = await createDispatch({
					projectId: PROJECT_ID,
					jobPayload: { type: 'scm', providerId: 'github', projectId: PROJECT_ID } as SwarmJob,
					dedupKey: `seed-${state}-${repository}`,
					source: 'webhook',
					// `createDispatch` only opens the three enqueueable states; `running` is
					// reached the way production reaches it, through the claim.
					state: state === 'running' || state === 'completed' ? 'pending' : state,
				});
				const resolution = {
					taskId: PR,
					phase: 'review' as const,
					pullRequest: { repository, prNumber: PR },
				};
				await recordDispatchResolution(dispatch.id, resolution);
				if (state === 'running') {
					await claimDispatch(dispatch.id, 'test-owner', 60_000);
					await markDispatchRunning(
						dispatch.id,
						undefined,
						new Date(Date.now() + 60_000),
						resolution,
					);
				}
				if (state === 'completed') await completeDispatch(dispatch.id, 'phase-succeeded');
				return dispatch.id;
			}

			it.each([
				'pending',
				'leased',
				'running',
				'retry-scheduled',
			] as const)('is true for a %s dispatch', async (state) => {
				await seedResolvedDispatch(state);
				expect(await hasActiveDispatchForPullRequest(PROJECT_ID, REPO, PR)).toBe(true);
			});

			it('is false once the dispatch is terminal', async () => {
				await seedResolvedDispatch('completed');
				expect(await hasActiveDispatchForPullRequest(PROJECT_ID, REPO, PR)).toBe(false);
			});

			it('is repository-scoped', async () => {
				await seedResolvedDispatch('running', OTHER_REPO);
				expect(await hasActiveDispatchForPullRequest(PROJECT_ID, REPO, PR)).toBe(false);
			});
		});

		describe('the sweep', () => {
			beforeEach(async () => {
				await seedImplementationRun();
			});

			// `swarm#860`'s live shape: the Review ran, failed terminally, and correctly
			// abandoned its ledger slot, leaving the PR green, mergeable and unreviewed.
			it('recovers a pull request whose Review died leaving an abandoned slot — exactly once', async () => {
				const key = { projectId: PROJECT_ID, repository: REPO, prNumber: PR, headSha: HEAD };
				await reserveReviewVerdict(key, await seedVerdictOwner());
				await abandonReviewVerdict(key);

				await recoverUnreviewedPullRequests();
				expect(await recoveryDispatches()).toHaveLength(1);

				// A second pass finds the attempt-1 key already taken and still in flight.
				await recoverUnreviewedPullRequests();
				expect(await recoveryDispatches()).toHaveLength(1);
			});

			it('spends the next attempt only once the previous one produced no Review', async () => {
				await recoverUnreviewedPullRequests();
				const [first] = await recoveryDispatches();

				// Settled without ever starting a Review — the attempt is spent, so the
				// next index is legitimately available.
				await completeDispatch(first.id, 'no-trigger');
				await recoverUnreviewedPullRequests();
				const afterDead = await recoveryDispatches();
				expect(afterDead).toHaveLength(2);

				// This one actually produced a Review, so no further attempt may be minted.
				const second = afterDead.find((row) => row.id !== first.id);
				await completeDispatch(second?.id ?? '', 'phase-succeeded');
				await recoverUnreviewedPullRequests();
				expect(await recoveryDispatches()).toHaveLength(2);
			});

			// The #856/#857 boundary, asserted rather than assumed: freeing a leaked
			// reservation is their job; this sweep must never step over a `pending` slot.
			it('does not recover while a review is pending at an earlier head', async () => {
				await reserveReviewVerdict(
					{ projectId: PROJECT_ID, repository: REPO, prNumber: PR, headSha: 'sha-earlier' },
					await seedVerdictOwner(),
				);

				await recoverUnreviewedPullRequests();

				expect(await recoveryDispatches()).toHaveLength(0);
			});

			it('does not recover a pull request that already has a submitted verdict at this head', async () => {
				const key = { projectId: PROJECT_ID, repository: REPO, prNumber: PR, headSha: HEAD };
				await reserveReviewVerdict(key, await seedVerdictOwner());
				await markReviewVerdictSubmitted(key, { verdict: 'approve', reviewId: 'review-head' });

				await recoverUnreviewedPullRequests();

				expect(await recoveryDispatches()).toHaveLength(0);
			});

			it('publishes the recovery as a wakeable pending dispatch', async () => {
				await recoverUnreviewedPullRequests();

				const [row] = await recoveryDispatches();
				const dispatch = await getDispatchById(row.id);
				expect(dispatch).toMatchObject({ state: 'pending', phase: 'review', taskId: PR });
			});
		});
	},
);
