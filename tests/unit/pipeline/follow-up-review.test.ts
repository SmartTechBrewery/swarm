import { describe, expect, it, vi } from 'vitest';

const createAndPublishDispatch = vi.fn(async (input: { jobPayload: unknown }) => ({
	dispatch: { id: 'dispatch-1', jobPayload: input.jobPayload },
	created: true,
}));
const enqueueJob = vi.fn(async (input: { jobPayload: unknown; dedupKey?: string }) =>
	createAndPublishDispatch(input),
);
vi.mock('@/dispatch/dispatcher.js', () => ({
	createAndPublishDispatch: (input: { jobPayload: unknown; dedupKey?: string }) =>
		enqueueJob(input),
	deliveryDedupKey: (deliveryId: string) => `delivery:${deliveryId}`,
}));

const requireProjectSCMProvider = vi.fn((_project?: unknown) => ({ type: 'github' as const }));
vi.mock('@/integrations/scm/registry.js', () => ({
	requireProjectSCMProvider: (project: unknown) => requireProjectSCMProvider(project),
	// Also read by `ProjectConfigSchema`'s per-provider credential check (issue #628);
	// an empty registry skips it, which is what this suite's fixtures expect.
	listSCMProviders: () => [],
}));

import {
	followUpReviewDeliveryId,
	scheduleFollowUpReviewDefault,
} from '@/pipeline/follow-up-review.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

const PROJECT = createMockProjectConfig();

describe('followUpReviewDeliveryId', () => {
	it('is deterministic for the same (project, PR, head)', () => {
		expect(followUpReviewDeliveryId(PROJECT, '42', 'abc123')).toBe(
			followUpReviewDeliveryId(PROJECT, '42', 'abc123'),
		);
	});

	it('differs when the head SHA changes — a follow-up-follow-up must not collide', () => {
		expect(followUpReviewDeliveryId(PROJECT, '42', 'abc123')).not.toBe(
			followUpReviewDeliveryId(PROJECT, '42', 'def456'),
		);
	});

	it('differs across PRs', () => {
		expect(followUpReviewDeliveryId(PROJECT, '42', 'abc123')).not.toBe(
			followUpReviewDeliveryId(PROJECT, '43', 'abc123'),
		);
	});

	it('never contains a colon (BullMQ reserves it for key namespacing)', () => {
		expect(followUpReviewDeliveryId(PROJECT, '42', 'abc123')).not.toContain(':');
	});
});

describe('scheduleFollowUpReviewDefault', () => {
	it('enqueues a synthetic checks-completed event carrying the new head, keyed by a deterministic delivery id', async () => {
		enqueueJob.mockClear();
		requireProjectSCMProvider.mockClear();

		await scheduleFollowUpReviewDefault({
			project: PROJECT,
			prNumber: '42',
			prBranch: 'issue-42',
			headSha: 'newsha123',
		});

		expect(requireProjectSCMProvider).toHaveBeenCalledWith(PROJECT);
		expect(enqueueJob).toHaveBeenCalledExactlyOnceWith({
			projectId: PROJECT.id,
			source: 'synthetic',
			dedupKey: `delivery:${followUpReviewDeliveryId(PROJECT, '42', 'newsha123')}`,
			jobPayload: {
				type: 'scm',
				providerId: 'github',
				projectId: PROJECT.id,
				deliveryId: followUpReviewDeliveryId(PROJECT, '42', 'newsha123'),
				event: {
					kind: 'checks',
					action: 'completed',
					repoFullName: PROJECT.repo,
					workItemId: '42',
					isCommentEvent: false,
					headSha: 'newsha123',
					prBranch: 'issue-42',
				},
			},
		});
	});

	it('re-enqueuing the same (project, PR, head) reuses the same dedup identity — the dispatch layer absorbs the repeat', async () => {
		enqueueJob.mockClear();

		const input = { project: PROJECT, prNumber: '42', prBranch: 'issue-42', headSha: 'newsha123' };
		await scheduleFollowUpReviewDefault(input);
		await scheduleFollowUpReviewDefault(input);

		const [firstCall, secondCall] = enqueueJob.mock.calls;
		expect((firstCall[0] as { dedupKey: string }).dedupKey).toBe(
			(secondCall[0] as { dedupKey: string }).dedupKey,
		);
	});

	it('carries no check-run data of its own — a no-CI project relies entirely on the pr-review handler policy', async () => {
		// This module only ever builds and dedups the delivery; whether a fixed
		// response on a PR with zero checks reaches Review is decided by
		// `decideAggregateCheckOutcome`'s `pipeline.review.checks` policy once the
		// `pr-review` handler re-queries live check state for this event
		// (see `tests/unit/triggers/handlers/review.test.ts`'s "if-present" cases,
		// issue #274) — never by anything encoded on this synthetic event.
		enqueueJob.mockClear();

		await scheduleFollowUpReviewDefault({
			project: PROJECT,
			prNumber: '42',
			prBranch: 'issue-42',
			headSha: 'newsha123',
		});

		const [input] = enqueueJob.mock.calls[0];
		const job = (input as { jobPayload: { event: object } }).jobPayload;
		expect(Object.keys(job.event).sort()).toEqual(
			[
				'action',
				'headSha',
				'isCommentEvent',
				'kind',
				'prBranch',
				'repoFullName',
				'workItemId',
			].sort(),
		);
	});
});
