import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createMockPmEvent,
	createMockProjectConfig,
	createMockScmEvent,
} from '../../helpers/factories.js';

// The seam's job is to shape the event into a SwarmJob and record it as a
// durable dispatch (issue #284) — mock the dispatcher and assert the record it
// creates. The producer stays mocked for the degraded mid-deploy fallback.
const { createAndPublishDispatch, enqueueJob } = vi.hoisted(() => ({
	createAndPublishDispatch: vi.fn(),
	enqueueJob: vi.fn(),
}));
vi.mock('@/dispatch/dispatcher.js', () => ({
	createAndPublishDispatch,
	deliveryDedupKey: (deliveryId: string) => `delivery:${deliveryId}`,
}));
vi.mock('@/queue/producer.js', () => ({
	enqueueJob,
	priorityFor: (job: { type: string }) => (job.type === 'pm' ? 10 : undefined),
}));

import { enqueuePmEvent, enqueueScmEvent } from '@/router/enqueue.js';

beforeEach(() => {
	createAndPublishDispatch.mockReset();
	createAndPublishDispatch.mockResolvedValue({ dispatch: { id: 'dispatch-1' }, created: true });
	enqueueJob.mockReset();
	enqueueJob.mockResolvedValue('bull-job-id');
});

describe('enqueueScmEvent', () => {
	it('records an scm dispatch carrying the provider id, event, project id, and delivery dedup identity', async () => {
		const event = createMockScmEvent();
		const project = createMockProjectConfig({ id: 'acme' });

		await enqueueScmEvent('github', event, project, 'delivery-1');

		expect(createAndPublishDispatch).toHaveBeenCalledWith({
			projectId: 'acme',
			jobPayload: {
				type: 'scm',
				providerId: 'github',
				projectId: 'acme',
				deliveryId: 'delivery-1',
				event,
			},
			dedupKey: 'delivery:delivery-1',
			priority: 0,
			source: 'webhook',
		});
		expect(enqueueJob).not.toHaveBeenCalled();
	});

	it('records no dedup identity when the delivery id is absent', async () => {
		const event = createMockScmEvent();
		const project = createMockProjectConfig();

		await enqueueScmEvent('github', event, project, undefined);

		expect(createAndPublishDispatch).toHaveBeenCalledWith(
			expect.objectContaining({ dedupKey: undefined }),
		);
	});

	it('is quiet about a deduplicated redelivery (existing dispatch, nothing enqueued twice)', async () => {
		createAndPublishDispatch.mockResolvedValue({
			dispatch: { id: 'dispatch-1' },
			created: false,
		});

		await expect(
			enqueueScmEvent('github', createMockScmEvent(), createMockProjectConfig(), 'delivery-1'),
		).resolves.toBeUndefined();
		expect(enqueueJob).not.toHaveBeenCalled();
	});

	it('falls back to a legacy queue job when the dispatch table is unavailable (mid-deploy)', async () => {
		createAndPublishDispatch.mockRejectedValue(new Error('relation "dispatches" does not exist'));
		const event = createMockScmEvent();
		const project = createMockProjectConfig({ id: 'acme' });

		await enqueueScmEvent('github', event, project, 'delivery-1');

		expect(enqueueJob).toHaveBeenCalledWith({
			type: 'scm',
			providerId: 'github',
			projectId: 'acme',
			deliveryId: 'delivery-1',
			event,
		});
	});
});

describe('enqueuePmEvent', () => {
	it('records a demoted pm dispatch carrying the provider id, event, project id, and dedup identity', async () => {
		const event = createMockPmEvent();
		const project = createMockProjectConfig({ id: 'acme' });

		await enqueuePmEvent('github-projects', event, project, 'delivery-2');

		expect(createAndPublishDispatch).toHaveBeenCalledWith({
			projectId: 'acme',
			jobPayload: {
				type: 'pm',
				providerId: 'github-projects',
				projectId: 'acme',
				deliveryId: 'delivery-2',
				event,
			},
			dedupKey: 'delivery:delivery-2',
			priority: 10,
			source: 'webhook',
		});
	});
});
