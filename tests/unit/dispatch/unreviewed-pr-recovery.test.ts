import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectConfig, ProjectRecord } from '@/config/schema.js';
import type { CreateDispatchInput, DispatchRow } from '@/db/repositories/dispatchesRepository.js';
import type { PullRequestReviewSlot } from '@/db/repositories/reviewVerdictsRepository.js';
import type { AggregateCheckStatus, PullRequestDetails } from '@/scm/types.js';
import type { SwarmManagedPrDecision } from '@/triggers/swarm-managed-pr.js';

/** A durable dispatch row, only as much of one as the recovery's bound actually reads. */
function dispatchRow(overrides: Partial<DispatchRow> = {}): DispatchRow {
	return { id: 'dispatch-1', state: 'pending', outcome: null, ...overrides } as DispatchRow;
}

const createAndPublishDispatch = vi.fn<
	(input: CreateDispatchInput) => Promise<{ dispatch: DispatchRow; created: boolean }>
>(async () => ({ dispatch: dispatchRow(), created: true }));
vi.mock('@/dispatch/dispatcher.js', () => ({
	createAndPublishDispatch: (input: CreateDispatchInput) => createAndPublishDispatch(input),
	deliveryDedupKey: (deliveryId: string) => `delivery:${deliveryId}`,
}));

const requireProjectSCMProvider = vi.fn((_project: ProjectConfig) => SCM);
vi.mock('@/integrations/scm/registry.js', () => ({
	requireProjectSCMProvider: (project: ProjectConfig) => requireProjectSCMProvider(project),
	// Also read by `ProjectConfigSchema`'s per-provider credential check (issue #628);
	// an empty registry skips it, which is what this suite's fixtures expect.
	listSCMProviders: () => [],
}));

const listAllProjectRecordsFromDb = vi.fn<() => Promise<ProjectRecord[]>>(async () => []);
vi.mock('@/db/repositories/projectsRepository.js', () => ({
	listAllProjectRecordsFromDb: () => listAllProjectRecordsFromDb(),
}));

const listActiveReviewSlotsForPullRequest = vi.fn<
	(projectId: string, repository: string, prNumber: string) => Promise<PullRequestReviewSlot[]>
>(async () => []);
vi.mock('@/db/repositories/reviewVerdictsRepository.js', async (importOriginal) => {
	// `REVIEW_VERDICT_CAP` is the real constant — the classifier's cap rule has to
	// stay pinned to the ledger's own number, not to a copy that could drift.
	const actual =
		await importOriginal<typeof import('@/db/repositories/reviewVerdictsRepository.js')>();
	return {
		REVIEW_VERDICT_CAP: actual.REVIEW_VERDICT_CAP,
		listActiveReviewSlotsForPullRequest: (
			projectId: string,
			repository: string,
			prNumber: string,
		) => listActiveReviewSlotsForPullRequest(projectId, repository, prNumber),
	};
});

const hasActiveDispatchForPullRequest = vi.fn<
	(projectId: string, repository: string, prNumber: string) => Promise<boolean>
>(async () => false);
vi.mock('@/db/repositories/dispatchesRepository.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/db/repositories/dispatchesRepository.js')>();
	return {
		ACTIVE_DISPATCH_STATES: actual.ACTIVE_DISPATCH_STATES,
		hasActiveDispatchForPullRequest: (projectId: string, repository: string, prNumber: string) =>
			hasActiveDispatchForPullRequest(projectId, repository, prNumber),
	};
});

const resolveSwarmManagedPr = vi.fn<
	(
		project: ProjectConfig,
		headBranch: string | undefined,
		trigger: string,
	) => Promise<SwarmManagedPrDecision>
>(async () => ({ managed: true, taskId: '42' }));
vi.mock('@/triggers/swarm-managed-pr.js', () => ({
	resolveSwarmManagedPr: (
		project: ProjectConfig,
		headBranch: string | undefined,
		trigger: string,
	) => resolveSwarmManagedPr(project, headBranch, trigger),
}));

import { REVIEW_VERDICT_CAP } from '@/db/repositories/reviewVerdictsRepository.js';
import { ciNoFixRecoveryDeliveryId } from '@/dispatch/ci-no-fix-recovery.js';
import {
	classifyReviewLedgerForRecovery,
	MAX_RECOVERY_ATTEMPTS,
	recoverUnreviewedPullRequests,
	unreviewedPrRecoveryDeliveryId,
} from '@/dispatch/unreviewed-pr-recovery.js';
import { followUpReviewDeliveryId } from '@/pipeline/follow-up-review.js';
import {
	createFakeScmProvider,
	createMockProjectConfig,
	createMockProjectRecord,
	createMockProjectRepositoryPair,
	toProjectRecord,
} from '../../helpers/factories.js';

const PROJECT = createMockProjectConfig();

const listConflictCandidates =
	vi.fn<(project: ProjectConfig, baseBranch: string) => Promise<PullRequestDetails[]>>();
const getAggregateCheckStatus =
	vi.fn<(project: ProjectConfig, ref: string) => Promise<AggregateCheckStatus>>();
const SCM = createFakeScmProvider({ listConflictCandidates, getAggregateCheckStatus });

/** One green, mergeable, open candidate — the shape a stranded pull request presents. */
function candidate(overrides: Partial<PullRequestDetails> = {}): PullRequestDetails {
	return {
		number: 42,
		headBranch: 'issue-42',
		headSha: 'abc123',
		baseBranch: 'main',
		baseSha: 'base123',
		mergeable: true,
		authorLogin: 'operator',
		state: 'open',
		...overrides,
	};
}

function greenChecks(): AggregateCheckStatus {
	return {
		totalCount: 1,
		checkRuns: [{ name: 'build', status: 'completed', conclusion: 'success' }],
	};
}

/** The one dispatch the sweep created, read off the mocked call's own arguments. */
function createdDispatch(): CreateDispatchInput {
	expect(createAndPublishDispatch).toHaveBeenCalledTimes(1);
	return createAndPublishDispatch.mock.calls[0][0];
}

beforeEach(() => {
	listAllProjectRecordsFromDb.mockResolvedValue([toProjectRecord(PROJECT)]);
	listConflictCandidates.mockResolvedValue([candidate()]);
	getAggregateCheckStatus.mockResolvedValue(greenChecks());
	resolveSwarmManagedPr.mockResolvedValue({ managed: true, taskId: '42' });
	hasActiveDispatchForPullRequest.mockResolvedValue(false);
	listActiveReviewSlotsForPullRequest.mockResolvedValue([]);
	requireProjectSCMProvider.mockReturnValue(SCM);
	createAndPublishDispatch.mockResolvedValue({ dispatch: dispatchRow(), created: true });
});

describe('unreviewedPrRecoveryDeliveryId', () => {
	it('is deterministic for the same (project, PR, head, attempt)', () => {
		expect(unreviewedPrRecoveryDeliveryId(PROJECT, '42', 'abc123', 1)).toBe(
			unreviewedPrRecoveryDeliveryId(PROJECT, '42', 'abc123', 1),
		);
	});

	it('differs across heads, PRs, and attempts', () => {
		const base = unreviewedPrRecoveryDeliveryId(PROJECT, '42', 'abc123', 1);
		expect(base).not.toBe(unreviewedPrRecoveryDeliveryId(PROJECT, '42', 'def456', 1));
		expect(base).not.toBe(unreviewedPrRecoveryDeliveryId(PROJECT, '43', 'abc123', 1));
		expect(base).not.toBe(unreviewedPrRecoveryDeliveryId(PROJECT, '42', 'abc123', 2));
	});

	it('never contains a colon (BullMQ reserves it for key namespacing)', () => {
		expect(unreviewedPrRecoveryDeliveryId(PROJECT, '42', 'abc123', 1)).not.toContain(':');
	});

	// Two repositories of one project (issue #685): a shared key would have the
	// dispatch layer absorb the second repository's recovery as an already-recorded
	// repeat of the first's, and that pull request would stay stranded.
	it('differs across two repositories of one project', () => {
		const [android, backend] = createMockProjectRepositoryPair();
		expect(unreviewedPrRecoveryDeliveryId(android, '42', 'abc123', 1)).not.toBe(
			unreviewedPrRecoveryDeliveryId(backend, '42', 'abc123', 1),
		);
	});

	// Its own prefix, so the three synthetic re-entries into `pr-review` for one head
	// can never be absorbed into each other by the dispatch layer.
	it('never collides with a follow-up Review or a no-fix recovery for the same head', () => {
		const id = unreviewedPrRecoveryDeliveryId(PROJECT, '42', 'abc123', 1);
		expect(id).not.toBe(followUpReviewDeliveryId(PROJECT, '42', 'abc123'));
		expect(id).not.toBe(ciNoFixRecoveryDeliveryId(PROJECT, '42', 'abc123'));
	});
});

describe('classifyReviewLedgerForRecovery', () => {
	function slot(overrides: Partial<PullRequestReviewSlot> = {}): PullRequestReviewSlot {
		return {
			ordinal: 1,
			state: 'submitted',
			headSha: 'abc123',
			capOverrideGrantedAt: null,
			capOverrideConsumedAt: null,
			...overrides,
		};
	}

	it('reports a submitted slot at this head as already reviewed', () => {
		expect(classifyReviewLedgerForRecovery([slot()], 'abc123')).toBe('reviewed-at-head');
	});

	it('reports a pending slot at this head as a review in flight', () => {
		expect(classifyReviewLedgerForRecovery([slot({ state: 'pending' })], 'abc123')).toBe(
			'review-in-flight',
		);
	});

	// The #856/#857 boundary: a leaked reservation is indistinguishable from a live
	// one here, and criterion 5 forbids disturbing a Review that is in flight.
	it('reports a pending slot at another head as a review in flight', () => {
		expect(
			classifyReviewLedgerForRecovery([slot({ state: 'pending', headSha: 'older' })], 'abc123'),
		).toBe('review-in-flight');
	});

	// `rover#116`'s shape (no slot at the head, no run row) and `swarm#860`'s
	// (the failed run abandoned its slot, and the repository read filters
	// `abandoned` out) both reach the classifier as an empty live ledger.
	it('recovers when the ledger holds no live slot for this pull request', () => {
		expect(classifyReviewLedgerForRecovery([], 'abc123')).toBe('recover');
	});

	// An earlier head that was reviewed and answered does not itself block a later
	// one — only a pending slot or a spent cap does.
	it("recovers at a new head once an earlier head's review is submitted", () => {
		expect(classifyReviewLedgerForRecovery([slot({ headSha: 'older' })], 'abc123')).toBe('recover');
	});

	it('refuses once the verdict cap is spent with no override granted', () => {
		const slots = Array.from({ length: REVIEW_VERDICT_CAP }, (_, i) =>
			slot({ ordinal: i + 1, headSha: `head-${i}` }),
		);
		expect(classifyReviewLedgerForRecovery(slots, 'abc123')).toBe('capped');
	});

	// Issue #511: a granted, unconsumed override is what lets a forced continuation
	// whose follow-up Review died still be rescued. Only `reserveReviewVerdict`
	// spends it — this read only observes it.
	it('recovers past the cap on an unconsumed operator override, but not a consumed one', () => {
		const slots = Array.from({ length: REVIEW_VERDICT_CAP }, (_, i) =>
			slot({ ordinal: i + 1, headSha: `head-${i}` }),
		);
		const granted = new Date();
		slots[REVIEW_VERDICT_CAP - 1] = {
			...slots[REVIEW_VERDICT_CAP - 1],
			capOverrideGrantedAt: granted,
		};
		expect(classifyReviewLedgerForRecovery(slots, 'abc123')).toBe('recover');

		slots[REVIEW_VERDICT_CAP - 1] = {
			...slots[REVIEW_VERDICT_CAP - 1],
			capOverrideConsumedAt: new Date(),
		};
		expect(classifyReviewLedgerForRecovery(slots, 'abc123')).toBe('capped');
	});
});

describe('recoverUnreviewedPullRequests', () => {
	it('hands a green, mergeable, unreviewed pull request back to Review', async () => {
		await recoverUnreviewedPullRequests();

		const input = createdDispatch();
		expect(input).toMatchObject({
			projectId: PROJECT.id,
			source: 'synthetic',
			taskId: '42',
			phase: 'review',
		});
		// Read the id off the call's own arguments rather than recomputing the hash
		// (ai/TESTING.md): that asserts the wiring, not that sha256 is deterministic.
		const payload = input.jobPayload as Extract<typeof input.jobPayload, { type: 'scm' }>;
		expect(input.dedupKey).toBe(`delivery:${payload.deliveryId}`);
		expect(payload).toMatchObject({
			type: 'scm',
			providerId: 'github',
			projectId: PROJECT.id,
			event: {
				kind: 'checks',
				action: 'completed',
				repoFullName: PROJECT.repo,
				workItemId: '42',
				isCommentEvent: false,
				headSha: 'abc123',
				prBranch: 'issue-42',
			},
		});
		// No held-claim marker: the handler must take the PR+SHA claim itself, which is
		// what makes a race with a real webhook resolve to exactly one Review. And no
		// `ciNoFixRecovery` — this head is green, not an adjudicated red.
		expect(payload).not.toHaveProperty('ciNoFixRecovery');
		expect(payload).not.toHaveProperty('continuationDispatchClaimed');
	});

	it('sweeps every repository of a multi-repository project under its own dedup key', async () => {
		const record = createMockProjectRecord({
			id: 'acme',
			repositories: [{ repo: 'acme/android' }, { repo: 'acme/backend' }],
		});
		listAllProjectRecordsFromDb.mockResolvedValue([record]);

		await recoverUnreviewedPullRequests();

		expect(createAndPublishDispatch).toHaveBeenCalledTimes(2);
		const [first, second] = createAndPublishDispatch.mock.calls.map(([input]) => input);
		expect(first.dedupKey).not.toBe(second.dedupKey);
	});

	describe('leaves alone', () => {
		it('a project with Review disabled — without asking the provider for candidates', async () => {
			listAllProjectRecordsFromDb.mockResolvedValue([
				toProjectRecord(
					createMockProjectConfig({
						pipeline: { review: { enabled: false }, respondToReview: { enabled: false } },
					}),
				),
			]);

			await recoverUnreviewedPullRequests();

			expect(listConflictCandidates).not.toHaveBeenCalled();
			expect(createAndPublishDispatch).not.toHaveBeenCalled();
		});

		it('a project whose SCM provider cannot be resolved — and still sweeps the next one', async () => {
			const other = createMockProjectConfig({ id: 'other', repo: 'acme/other' });
			listAllProjectRecordsFromDb.mockResolvedValue([
				toProjectRecord(PROJECT),
				toProjectRecord(other),
			]);
			requireProjectSCMProvider.mockImplementationOnce(() => {
				throw new Error('project states no SCM provider');
			});

			await recoverUnreviewedPullRequests();

			expect(createdDispatch().projectId).toBe('other');
		});

		it('a repository whose pull-request list read fails — and still sweeps the next one', async () => {
			const other = createMockProjectConfig({ id: 'other', repo: 'acme/other' });
			listAllProjectRecordsFromDb.mockResolvedValue([
				toProjectRecord(PROJECT),
				toProjectRecord(other),
			]);
			listConflictCandidates.mockRejectedValueOnce(new Error('502 from the provider'));

			await recoverUnreviewedPullRequests();

			expect(createdDispatch().projectId).toBe('other');
		});

		it.each([
			['a closed pull request', candidate({ state: 'closed' })],
			['a conflicting pull request', candidate({ mergeable: false })],
			['a pull request whose mergeability is still unknown', candidate({ mergeable: null })],
		])('%s', async (_label, pr) => {
			listConflictCandidates.mockResolvedValue([pr]);

			await recoverUnreviewedPullRequests();

			expect(createAndPublishDispatch).not.toHaveBeenCalled();
		});

		it.each([
			['a branch outside the project prefix', { managed: false, reason: 'not-a-task-branch' }],
			['a task branch SWARM never implemented', { managed: false, reason: 'no-run', taskId: '42' }],
			['a pull request whose ownership could not be decided', 'error'],
		] as const)('%s', async (_label, decision) => {
			resolveSwarmManagedPr.mockResolvedValue(decision as SwarmManagedPrDecision);

			await recoverUnreviewedPullRequests();

			expect(createAndPublishDispatch).not.toHaveBeenCalled();
		});

		// Criterion 5's "a writing phase holding it (#850)" and "an in-flight Review":
		// any non-terminal dispatch for this pull request means something is still due.
		it('a pull request with an active dispatch of any phase', async () => {
			hasActiveDispatchForPullRequest.mockResolvedValue(true);

			await recoverUnreviewedPullRequests();

			expect(createAndPublishDispatch).not.toHaveBeenCalled();
			expect(getAggregateCheckStatus).not.toHaveBeenCalled();
		});

		it.each([
			['already reviewed at this head', 'submitted' as const, 'abc123'],
			['a review in flight at this head', 'pending' as const, 'abc123'],
			['a review in flight at another head', 'pending' as const, 'older'],
		])('%s', async (_label, state, headSha) => {
			listActiveReviewSlotsForPullRequest.mockResolvedValue([
				{ ordinal: 1, state, headSha, capOverrideGrantedAt: null, capOverrideConsumedAt: null },
			]);

			await recoverUnreviewedPullRequests();

			expect(createAndPublishDispatch).not.toHaveBeenCalled();
			expect(getAggregateCheckStatus).not.toHaveBeenCalled();
		});

		// Criterion 5's "CI still running" — and the reason the sweep must not spend an
		// attempt on it: nothing has gone wrong yet.
		it('a pull request whose checks have not all completed', async () => {
			getAggregateCheckStatus.mockResolvedValue({
				totalCount: 2,
				checkRuns: [
					{ name: 'build', status: 'completed', conclusion: 'success' },
					{ name: 'e2e', status: 'in_progress', conclusion: null },
				],
			});

			await recoverUnreviewedPullRequests();

			expect(createAndPublishDispatch).not.toHaveBeenCalled();
		});

		// A red belongs to Respond-to-CI and to #841's hand-back, not here.
		it('a pull request whose checks failed', async () => {
			getAggregateCheckStatus.mockResolvedValue({
				totalCount: 1,
				checkRuns: [{ name: 'build', status: 'completed', conclusion: 'failure' }],
			});

			await recoverUnreviewedPullRequests();

			expect(createAndPublishDispatch).not.toHaveBeenCalled();
		});

		it('a pull request whose aggregate check read failed', async () => {
			getAggregateCheckStatus.mockRejectedValue(new Error('checks API is down'));

			await recoverUnreviewedPullRequests();

			expect(createAndPublishDispatch).not.toHaveBeenCalled();
		});
	});

	// The policy is the project's, read here exactly as the handler reads it.
	it('recovers a zero-check pull request when the project opts into `if-present`', async () => {
		listAllProjectRecordsFromDb.mockResolvedValue([
			toProjectRecord(createMockProjectConfig({ pipeline: { review: { checks: 'if-present' } } })),
		]);
		getAggregateCheckStatus.mockResolvedValue({ totalCount: 0, checkRuns: [] });

		await recoverUnreviewedPullRequests();

		expect(createAndPublishDispatch).toHaveBeenCalledTimes(1);
	});

	describe('the recovery bound', () => {
		it('creates nothing while the first attempt is still in flight', async () => {
			createAndPublishDispatch.mockResolvedValue({
				dispatch: dispatchRow({ state: 'running' }),
				created: false,
			});

			await recoverUnreviewedPullRequests();

			expect(createAndPublishDispatch).toHaveBeenCalledTimes(1);
		});

		// A dispatch that produced a Review is never dead, so its attempt is not
		// re-spendable and the #235 cap is never approached from here.
		it('creates nothing when the first attempt actually produced a Review', async () => {
			createAndPublishDispatch.mockResolvedValue({
				dispatch: dispatchRow({ state: 'completed', outcome: 'phase-succeeded' }),
				created: false,
			});

			await recoverUnreviewedPullRequests();

			expect(createAndPublishDispatch).toHaveBeenCalledTimes(1);
		});

		it('moves to the next attempt key once an attempt resolved without a Review', async () => {
			createAndPublishDispatch
				.mockResolvedValueOnce({
					dispatch: dispatchRow({ state: 'completed', outcome: 'no-trigger' }),
					created: false,
				})
				.mockResolvedValueOnce({ dispatch: dispatchRow({ id: 'dispatch-2' }), created: true });

			await recoverUnreviewedPullRequests();

			expect(createAndPublishDispatch).toHaveBeenCalledTimes(2);
			const [first, second] = createAndPublishDispatch.mock.calls.map(([input]) => input);
			expect(first.dedupKey).not.toBe(second.dedupKey);
		});

		it('stops after every permitted attempt is spent', async () => {
			createAndPublishDispatch.mockResolvedValue({
				dispatch: dispatchRow({ state: 'failed', outcome: null }),
				created: false,
			});

			await recoverUnreviewedPullRequests();

			expect(createAndPublishDispatch).toHaveBeenCalledTimes(MAX_RECOVERY_ATTEMPTS);
		});
	});
});
