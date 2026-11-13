import { and, asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectConfig } from '../../../src/config/schema.js';
import { getDb } from '../../../src/db/client.js';
import {
	cancelWaitingDispatch,
	claimDispatch,
	completeDispatch,
	createDispatch,
	type DispatchRow,
	failDispatch,
	getDispatchById,
	hasActiveDispatchForPullRequest,
	markDispatchRunning,
	recordDispatchResolution,
} from '../../../src/db/repositories/dispatchesRepository.js';
import {
	abandonReviewVerdict,
	listActiveReviewSlotsForPullRequest,
	markReviewVerdictSubmitted,
	markReviewVerdictSuperseded,
	REVIEW_SUPERSEDED_CAP,
	REVIEW_VERDICT_CAP,
	reserveReviewVerdict,
} from '../../../src/db/repositories/reviewVerdictsRepository.js';
import {
	completeRun,
	createRun,
	getRunByIdFromDb,
	updateReviewMergeOutcome,
} from '../../../src/db/repositories/runsRepository.js';
import { dispatches } from '../../../src/db/schema/dispatches.js';
import { supersedeApprovalsParkedAtHead } from '../../../src/dispatch/base-push-supersession.js';
import {
	classifyReviewLedgerForRecovery,
	recoverUnreviewedPullRequests,
} from '../../../src/dispatch/unreviewed-pr-recovery.js';
import type { SCMProviderManifest } from '../../../src/integrations/scm/manifest.js';
import { registerSCMProvider } from '../../../src/integrations/scm/registry.js';
import type { SwarmJob } from '../../../src/queue/jobs.js';
import type { AggregateCheckStatus, PullRequestDetails } from '../../../src/scm/types.js';
import {
	createFakeScmProvider,
	createMockProjectConfig,
	createMockScmEvent,
	createMockScmWebhookJob,
} from '../../helpers/factories.js';
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
		merged: false,
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
 * Settle a verdict owner without it ever producing a run — the three terminal
 * shapes a leaked `pending` slot was observed behind (issue #1105).
 */
async function settleVerdictOwner(
	id: string,
	state: 'completed' | 'failed' | 'cancelled',
): Promise<void> {
	if (state === 'cancelled') {
		expect(await cancelWaitingDispatch(id, 'test: cancelled before it ran')).not.toBeNull();
		return;
	}
	expect(await claimDispatch(id, 'test-owner', 60_000)).not.toBeNull();
	const settled =
		state === 'completed'
			? await completeDispatch(id, 'skipped-duplicate')
			: await failDispatch(id, 'test: failed before it ran');
	expect(settled).toBe(true);
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
						// Its owner is still in `createDispatch`'s default `pending` state;
						// only a `pending` slot's liveness is read anywhere (issue #1038).
						dispatchActive: true,
						// Nothing has stamped it (issue #1079), so it still counts toward
						// `REVIEW_VERDICT_CAP`.
						superseded: false,
					},
				]);
			});

			// Issue #1038: the run-detail read model has to tell a Review in flight from
			// the relic of a dispatch that died without submitting, so the projection
			// carries the owner's liveness — the same question `reserveReviewVerdict`
			// asks inside its lock, answered here in the one read.
			it('reports a pending slot live only while its owning dispatch is', async () => {
				const owner = await seedVerdictOwner();
				await reserveReviewVerdict(
					{ projectId: PROJECT_ID, repository: REPO, prNumber: PR, headSha: 'sha-1' },
					owner,
				);

				expect(await listActiveReviewSlotsForPullRequest(PROJECT_ID, REPO, PR)).toMatchObject([
					{ ordinal: 1, state: 'pending', dispatchActive: true },
				]);

				await cancelWaitingDispatch(owner, 'test: settled without submitting');

				expect(await listActiveReviewSlotsForPullRequest(PROJECT_ID, REPO, PR)).toMatchObject([
					{ ordinal: 1, state: 'pending', dispatchActive: false },
				]);

				// And the same answer when the owner is gone entirely: the foreign key
				// nulls `dispatch_id`, which the left join leaves as no state at all.
				await getDb().delete(dispatches).where(eq(dispatches.id, owner));

				expect(await listActiveReviewSlotsForPullRequest(PROJECT_ID, REPO, PR)).toMatchObject([
					{ ordinal: 1, state: 'pending', dispatchActive: false },
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

			// Criterion 5, asserted rather than assumed: the sweep never steps over a
			// *live* `pending` slot — its owner here is a `pending` dispatch, still due to run.
			it('does not recover while a review is pending at an earlier head', async () => {
				await reserveReviewVerdict(
					{ projectId: PROJECT_ID, repository: REPO, prNumber: PR, headSha: 'sha-earlier' },
					await seedVerdictOwner(),
				);

				await recoverUnreviewedPullRequests();

				expect(await recoveryDispatches()).toHaveLength(0);
			});

			// Issue #1105: a slot leaked by a dispatch that settled without a Review —
			// `under-control-mobile#115`'s dropped duplicate, and the `failed`/`cancelled`
			// relics beside it — must not stall the pull request at any later head.
			it.each([
				['completed', HEAD],
				['completed', 'sha-earlier'],
				['failed', HEAD],
				['failed', 'sha-earlier'],
				['cancelled', HEAD],
				['cancelled', 'sha-earlier'],
			] as const)('recovers a pull request whose only pending slot belongs to a %s dispatch, at %s', async (state, headSha) => {
				const owner = await seedVerdictOwner();
				await reserveReviewVerdict(
					{ projectId: PROJECT_ID, repository: REPO, prNumber: PR, headSha },
					owner,
				);
				await settleVerdictOwner(owner, state);

				await recoverUnreviewedPullRequests();

				expect(await recoveryDispatches()).toHaveLength(1);
				// The sweep writes no ledger rows: freeing the relic is the re-entered
				// handler's reservation's job (#857, or same-head reuse).
				expect(await listActiveReviewSlotsForPullRequest(PROJECT_ID, REPO, PR)).toMatchObject([
					{ ordinal: 1, state: 'pending', headSha, dispatchActive: false },
				]);
			});

			it('does not recover a pull request that already has a submitted verdict at this head', async () => {
				const key = { projectId: PROJECT_ID, repository: REPO, prNumber: PR, headSha: HEAD };
				await reserveReviewVerdict(key, await seedVerdictOwner());
				await markReviewVerdictSubmitted(key, { verdict: 'approve', reviewId: 'review-head' });

				await recoverUnreviewedPullRequests();

				expect(await recoveryDispatches()).toHaveLength(0);
			});

			// Issue #1079's backstop, end to end: three submitted verdicts used to stop
			// the sweep outright, and the pull request stayed green, mergeable and
			// unreviewed until an operator forced a review. Once merge automation has
			// stamped them superseded, the same fixture is handed back to Review.
			it('recovers a pull request whose spent slots were all superseded', async () => {
				const slotKey = (headSha: string) => ({
					projectId: PROJECT_ID,
					repository: REPO,
					prNumber: PR,
					headSha,
				});
				for (let i = 1; i <= REVIEW_VERDICT_CAP; i++) {
					await reserveReviewVerdict(slotKey(`sha-${i}`), await seedVerdictOwner());
					await markReviewVerdictSubmitted(slotKey(`sha-${i}`), { verdict: 'approve' });
				}

				await recoverUnreviewedPullRequests();
				expect(await recoveryDispatches()).toHaveLength(0);

				for (let i = 1; i <= REVIEW_VERDICT_CAP; i++) {
					expect(await markReviewVerdictSuperseded(slotKey(`sha-${i}`))).toBe(true);
				}

				await recoverUnreviewedPullRequests();
				expect(await recoveryDispatches()).toHaveLength(1);
			});

			it('publishes the recovery as a wakeable pending dispatch', async () => {
				await recoverUnreviewedPullRequests();

				const [row] = await recoveryDispatches();
				const dispatch = await getDispatchById(row.id);
				expect(dispatch).toMatchObject({ state: 'pending', phase: 'review', taskId: PR });
			});
		});

		// Issue #1445: approvals merge automation refused (red checks, `not-eligible`)
		// stayed parked at the refused head and kept spending `REVIEW_VERDICT_CAP`
		// slots after SWARM's own base merge had replaced that head — `#2254` and
		// `#2245` stopped capped, green, mergeable and unreviewed.
		describe('approvals parked at a head SWARM’s own base merge replaced (issue #1445)', () => {
			let project: ProjectConfig;
			const slotKey = (headSha: string) => ({
				projectId: PROJECT_ID,
				repository: REPO,
				prNumber: PR,
				headSha,
			});

			beforeEach(async () => {
				await seedImplementationRun();
				project = createMockProjectConfig({ id: PROJECT_ID, repo: REPO, scm: 'github' });
			});

			/** A submitted verdict at `headSha` in the ledger. */
			async function submitVerdict(
				headSha: string,
				verdict: 'approve' | 'request-changes',
			): Promise<void> {
				await reserveReviewVerdict(slotKey(headSha), await seedVerdictOwner());
				await markReviewVerdictSubmitted(slotKey(headSha), { verdict });
			}

			/**
			 * The Review run behind a verdict: it reviewed `reviewed`, and its merge
			 * generation stopped at `parkedAt` with `outcome` — on another head when the
			 * merge advanced onto an updated head (issue #874) and was refused there.
			 */
			async function reviewRun(opts: {
				reviewed: string;
				parkedAt: string;
				verdict?: 'approve' | 'request-changes';
				outcome?: string;
			}): Promise<string> {
				const id = await createRun({
					projectId: PROJECT_ID,
					repository: REPO,
					taskId: PR,
					phase: 'review',
					prNumber: PR,
					jobPayload: createMockScmWebhookJob({
						event: createMockScmEvent({ repoFullName: REPO, headSha: opts.reviewed }),
					}),
				});
				await completeRun(id, {
					status: 'completed',
					engine: 'claude',
					reviewVerdict: opts.verdict ?? 'approve',
				});
				await updateReviewMergeOutcome(id, {
					status: opts.outcome ?? 'not-eligible',
					message: 'refused: the head fails its checks',
					attempt: 0,
					approvedHeadSha: opts.parkedAt,
				});
				return id;
			}

			/** A Resolve-conflicts push (or a branch update) moving the head off `fromHeadSha`. */
			function basePushFrom(fromHeadSha: string): Promise<number> {
				return supersedeApprovalsParkedAtHead({
					project,
					prNumber: PR,
					fromHeadSha,
					cause: 'resolve-conflicts',
				});
			}

			async function ledgerAt(headSha: string) {
				return classifyReviewLedgerForRecovery(
					await listActiveReviewSlotsForPullRequest(PROJECT_ID, REPO, PR),
					headSha,
				);
			}

			// `#2254`: request-changes at A; an approval of X whose merge advanced onto
			// B and was refused red there; the no-fix hand-back's approval of B, refused
			// too. Resolve-conflicts then moved the pull request from B to C.
			it('frees both approvals parked at B, so the sweep reviews C and it is no longer capped', async () => {
				await submitVerdict('sha-a', 'request-changes');
				await submitVerdict('sha-x', 'approve');
				const advanced = await reviewRun({ reviewed: 'sha-x', parkedAt: 'sha-b' });
				await submitVerdict('sha-b', 'approve');
				const handBack = await reviewRun({ reviewed: 'sha-b', parkedAt: 'sha-b' });

				expect(await ledgerAt(HEAD)).toBe('capped');
				await recoverUnreviewedPullRequests();
				expect(await recoveryDispatches()).toHaveLength(0);

				expect(await basePushFrom('sha-b')).toBe(2);

				expect(await listActiveReviewSlotsForPullRequest(PROJECT_ID, REPO, PR)).toMatchObject([
					{ headSha: 'sha-a', superseded: false },
					{ headSha: 'sha-x', superseded: true },
					{ headSha: 'sha-b', superseded: true },
				]);
				expect((await getRunByIdFromDb(advanced))?.reviewSupersededAt).toBeInstanceOf(Date);
				expect((await getRunByIdFromDb(handBack))?.reviewSupersededAt).toBeInstanceOf(Date);
				expect(await ledgerAt(HEAD)).toBe('recover');

				await recoverUnreviewedPullRequests();
				const recoveries = await recoveryDispatches();
				expect(recoveries).toHaveLength(1);
				expect(recoveries[0].jobPayload).toMatchObject({ event: { headSha: HEAD } });

				// The Review of C gets a slot — it is no longer capped, so its approval
				// reaches merge automation as any other does.
				expect(await reserveReviewVerdict(slotKey(HEAD), await seedVerdictOwner())).toMatchObject({
					status: 'reserved',
				});
			});

			// `#2245`: three approvals at three successive heads, each refused and each
			// followed by a Resolve-conflicts push.
			it('ends recoverable after approvals refused at three successive heads', async () => {
				for (const head of ['sha-1', 'sha-2', 'sha-3']) {
					await submitVerdict(head, 'approve');
					await reviewRun({ reviewed: head, parkedAt: head });
					expect(await basePushFrom(head)).toBe(1);
				}

				expect(await ledgerAt(HEAD)).toBe('recover');
				await recoverUnreviewedPullRequests();
				expect(await recoveryDispatches()).toHaveLength(1);
			});

			// The #511 loop guard: request-changes verdicts are never stamped, so a
			// base push buys a request-changes loop nothing.
			it('still stops three request-changes verdicts at the verdict cap', async () => {
				for (const head of ['sha-1', 'sha-2', 'sha-3']) {
					await submitVerdict(head, 'request-changes');
					await reviewRun({ reviewed: head, parkedAt: head, verdict: 'request-changes' });
				}

				expect(await basePushFrom('sha-3')).toBe(0);

				expect(await ledgerAt(HEAD)).toBe('capped');
				expect(await reserveReviewVerdict(slotKey(HEAD), await seedVerdictOwner())).toMatchObject({
					status: 'capped',
					reason: 'verdict-cap',
				});
			});

			// The #1079 bound: a head SWARM keeps moving still stops at
			// `REVIEW_SUPERSEDED_CAP`.
			it('still stops a head superseded again and again at the superseded bound', async () => {
				for (let i = 1; i <= REVIEW_SUPERSEDED_CAP; i++) {
					await submitVerdict(`sha-${i}`, 'approve');
					await reviewRun({ reviewed: `sha-${i}`, parkedAt: `sha-${i}` });
					expect(await basePushFrom(`sha-${i}`)).toBe(1);
				}

				expect(await ledgerAt(HEAD)).toBe('capped');
				expect(await reserveReviewVerdict(slotKey(HEAD), await seedVerdictOwner())).toMatchObject({
					status: 'capped',
					reason: 'superseded-bound',
				});
			});

			it('leaves an approval whose merge is still waiting, or merged, counting', async () => {
				await submitVerdict('sha-1', 'approve');
				await reviewRun({ reviewed: 'sha-1', parkedAt: 'sha-1', outcome: 'not-ready' });
				await submitVerdict('sha-2', 'approve');
				await reviewRun({ reviewed: 'sha-2', parkedAt: 'sha-2', outcome: 'merged' });

				expect(await basePushFrom('sha-1')).toBe(0);
				expect(await basePushFrom('sha-2')).toBe(0);
				expect(await listActiveReviewSlotsForPullRequest(PROJECT_ID, REPO, PR)).toMatchObject([
					{ headSha: 'sha-1', superseded: false },
					{ headSha: 'sha-2', superseded: false },
				]);
			});
		});
	},
);
