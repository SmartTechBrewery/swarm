import { describe, expect, it, vi } from 'vitest';

const enqueueJob = vi.fn(async (input: { jobPayload: unknown; dedupKey?: string }) => ({
	dispatch: { id: 'dispatch-1', jobPayload: input.jobPayload },
	created: true,
}));
vi.mock('@/dispatch/dispatcher.js', () => ({
	createAndPublishDispatch: (input: { jobPayload: unknown; dedupKey?: string }) =>
		enqueueJob(input),
	deliveryDedupKey: (deliveryId: string) => `delivery:${deliveryId}`,
}));

const refreshReviewDispatchClaim = vi.fn(async (_key: string, _ttlSec: number) => {});
vi.mock('@/triggers/review-dispatch-dedup.js', () => ({
	buildReviewDispatchKey: (repo: string, prNumber: string, headSha: string) =>
		`${repo}:${prNumber}:${headSha}`,
	refreshReviewDispatchClaim: (key: string, ttlSec: number) =>
		refreshReviewDispatchClaim(key, ttlSec),
}));

const requireProjectSCMProvider = vi.fn((_project?: unknown) => ({ type: 'github' as const }));
vi.mock('@/integrations/scm/registry.js', () => ({
	requireProjectSCMProvider: (project: unknown) => requireProjectSCMProvider(project),
	// Also read by `ProjectConfigSchema`'s per-provider credential check (issue #628);
	// an empty registry skips it, which is what this suite's fixtures expect.
	listSCMProviders: () => [],
}));

import {
	ciNoFixRecoveryDeliveryId,
	scheduleCiNoFixRecovery,
} from '@/dispatch/ci-no-fix-recovery.js';
import { followUpReviewDeliveryId } from '@/pipeline/follow-up-review.js';
import {
	createMockProjectConfig,
	createMockProjectRepositoryPair,
} from '../../helpers/factories.js';

const PROJECT = createMockProjectConfig();

describe('ciNoFixRecoveryDeliveryId', () => {
	it('is deterministic for the same (project, PR, head)', () => {
		expect(ciNoFixRecoveryDeliveryId(PROJECT, '42', 'abc123')).toBe(
			ciNoFixRecoveryDeliveryId(PROJECT, '42', 'abc123'),
		);
	});

	it('differs when the head SHA changes — a later no-fix on the same PR must not collide', () => {
		expect(ciNoFixRecoveryDeliveryId(PROJECT, '42', 'abc123')).not.toBe(
			ciNoFixRecoveryDeliveryId(PROJECT, '42', 'def456'),
		);
	});

	it('differs across PRs', () => {
		expect(ciNoFixRecoveryDeliveryId(PROJECT, '42', 'abc123')).not.toBe(
			ciNoFixRecoveryDeliveryId(PROJECT, '43', 'abc123'),
		);
	});

	it('never contains a colon (BullMQ reserves it for key namespacing)', () => {
		expect(ciNoFixRecoveryDeliveryId(PROJECT, '42', 'abc123')).not.toContain(':');
	});

	// Two repositories of one project (issue #685). This keys a *durable dispatch*
	// row, so a shared key would have the dispatch layer absorb the second
	// repository's recovery as an already-recorded repeat of the first's — and that
	// PR would never be handed back to Review.
	it('differs across two repositories of one project', () => {
		const [android, backend] = createMockProjectRepositoryPair();
		expect(ciNoFixRecoveryDeliveryId(android, '42', 'abc123')).not.toBe(
			ciNoFixRecoveryDeliveryId(backend, '42', 'abc123'),
		);
	});

	// Its own prefix, so the two synthetic re-entries into `pr-review` for one head
	// can never be absorbed into each other by the dispatch layer.
	it('never collides with a follow-up Review for the same (project, PR, head)', () => {
		expect(ciNoFixRecoveryDeliveryId(PROJECT, '42', 'abc123')).not.toBe(
			followUpReviewDeliveryId(PROJECT, '42', 'abc123'),
		);
	});
});

describe('scheduleCiNoFixRecovery', () => {
	const input = { project: PROJECT, prNumber: '42', prBranch: 'issue-42', headSha: 'abc123' };

	it('enqueues one synthetic checks-completed event carrying the recovery marker', async () => {
		enqueueJob.mockClear();
		requireProjectSCMProvider.mockClear();

		await scheduleCiNoFixRecovery(input);

		expect(requireProjectSCMProvider).toHaveBeenCalledWith(PROJECT);
		expect(enqueueJob).toHaveBeenCalledExactlyOnceWith({
			projectId: PROJECT.id,
			source: 'synthetic',
			dedupKey: `delivery:${ciNoFixRecoveryDeliveryId(PROJECT, '42', 'abc123')}`,
			jobPayload: {
				type: 'scm',
				providerId: 'github',
				projectId: PROJECT.id,
				deliveryId: ciNoFixRecoveryDeliveryId(PROJECT, '42', 'abc123'),
				ciNoFixRecovery: true,
				event: {
					kind: 'checks',
					action: 'completed',
					repoFullName: PROJECT.repo,
					workItemId: '42',
					isCommentEvent: false,
					headSha: 'abc123',
					prBranch: 'issue-42',
				},
			},
		});
	});

	// The claim is handed *over*, not handed back: releasing it would let a
	// delayed sibling check event for this same head take the freed slot and start
	// a second CI fix on an already-adjudicated red, leaving the recovery to fail
	// its own claim — and its deterministic delivery id then absorbs the second
	// run's recovery, so no Review would ever run. Refreshing keeps the slot
	// closed to every event but the marked recovery, which reuses it.
	it('refreshes — never releases — the PR+SHA review-dispatch claim before enqueuing', async () => {
		enqueueJob.mockClear();
		refreshReviewDispatchClaim.mockClear();

		await scheduleCiNoFixRecovery(input);

		expect(refreshReviewDispatchClaim).toHaveBeenCalledExactlyOnceWith(
			`${PROJECT.repo}:42:abc123`,
			expect.any(Number),
		);
		expect(refreshReviewDispatchClaim.mock.invocationCallOrder[0] as number).toBeLessThan(
			enqueueJob.mock.invocationCallOrder[0] as number,
		);
	});

	// A recovery that has to wait out a lagging checks/mergeability read re-enters
	// the handler on the `state-pending` recheck cadence (20 × 30s), carrying the
	// marker — and so still reusing this claim. A TTL shorter than that chain would
	// hand the slot back to a delayed sibling mid-wait.
	it("holds the claim long enough to outlast the handler's state-pending recheck chain", async () => {
		refreshReviewDispatchClaim.mockClear();

		await scheduleCiNoFixRecovery(input);

		const [, ttlSec] = refreshReviewDispatchClaim.mock.calls[0] as [string, number];
		expect(ttlSec).toBeGreaterThan((20 * 30_000) / 1000);
	});

	it('re-enqueuing the same (project, PR, head) reuses the same dedup identity — the dispatch layer absorbs the repeat', async () => {
		enqueueJob.mockClear();

		await scheduleCiNoFixRecovery(input);
		await scheduleCiNoFixRecovery(input);

		const [firstCall, secondCall] = enqueueJob.mock.calls;
		expect((firstCall[0] as { dedupKey: string }).dedupKey).toBe(
			(secondCall[0] as { dedupKey: string }).dedupKey,
		);
	});
});
