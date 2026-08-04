import type { QueueOptions } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SwarmJob } from '@/queue/jobs.js';
import {
	createMockGitHubProjectsWebhookJob,
	createMockScmWebhookJob,
} from '../../helpers/factories.js';

// Mock BullMQ's Queue so nothing touches Redis — capture constructor args and
// the add()/close() calls the producer makes. Hoisted so the vi.mock factory
// (itself hoisted above imports) can reference them.
const { QueueMock, add, close, getDelayed, getWaiting, getPrioritized, fromId } = vi.hoisted(() => {
	// Typed with add()'s (name, data, opts) signature so `mock.calls[0]` is a
	// real tuple that destructures/indexes under typecheck (see ai/TESTING.md).
	const add =
		vi.fn<
			(
				name: string,
				data: unknown,
				opts?: { jobId?: string; delay?: number; priority?: number },
			) => Promise<unknown>
		>();
	const close = vi.fn();
	// Job shape covers what `clearPendingJobs` uses (`remove`); all optional so
	// a test supplies only the fields its assertion touches.
	type MockJob = {
		id?: string;
		remove?: () => Promise<void>;
		data?: { runId?: string; [key: string]: unknown };
	};
	const getDelayed = vi.fn<() => Promise<MockJob[]>>();
	const getWaiting = vi.fn<() => Promise<MockJob[]>>();
	const getPrioritized = vi.fn<() => Promise<MockJob[]>>();
	// `Job.fromId(queue, id)` — the lookup `removePendingJobById` uses. Resolves
	// a job exposing `getState`/`remove`, or `undefined` for a reaped/absent id.
	const fromId =
		vi.fn<
			(
				queue: unknown,
				jobId: string,
			) => Promise<{ getState: () => Promise<string>; remove: () => Promise<void> } | undefined>
		>();
	// Typed with the Queue constructor's (name, opts) signature so `mock.calls`
	// is a real tuple — untyped, vi.fn() infers a zero-arg call and indexing
	// `calls[0]` fails to typecheck.
	const QueueMock = vi.fn<
		(
			name: string,
			opts?: QueueOptions,
		) => {
			add: typeof add;
			close: typeof close;
			getDelayed: typeof getDelayed;
			getWaiting: typeof getWaiting;
			getPrioritized: typeof getPrioritized;
		}
	>(() => ({ add, close, getDelayed, getWaiting, getPrioritized }));
	return { QueueMock, add, close, getDelayed, getWaiting, getPrioritized, fromId };
});

vi.mock('bullmq', () => ({ Queue: QueueMock, Job: { fromId } }));

// The producer holds a lazy Queue singleton at module scope; resetModules gives
// each test a fresh one so "constructed once" assertions aren't cross-polluted.
beforeEach(() => {
	vi.resetModules();
	QueueMock.mockClear();
	add.mockReset();
	add.mockResolvedValue({ id: 'bull-assigned-id' });
	close.mockReset();
	close.mockResolvedValue(undefined);
	getDelayed.mockReset();
	getDelayed.mockResolvedValue([]);
	getWaiting.mockReset();
	getWaiting.mockResolvedValue([]);
	getPrioritized.mockReset();
	getPrioritized.mockResolvedValue([]);
	fromId.mockReset();
	fromId.mockResolvedValue(undefined);
	process.env.REDIS_URL = 'redis://localhost:6379';
});

describe('enqueueJob', () => {
	it('creates the queue on QUEUE_NAME with the parsed Redis connection', async () => {
		const { enqueueJob } = await import('@/queue/producer.js');
		await enqueueJob(createMockScmWebhookJob());

		expect(QueueMock).toHaveBeenCalledOnce();
		const [name, opts] = QueueMock.mock.calls[0];
		expect(name).toBe('swarm-jobs');
		expect(opts).toMatchObject({ connection: { host: 'localhost', port: 6379 } });
	});

	it('configures the load-bearing default job options', async () => {
		const { enqueueJob } = await import('@/queue/producer.js');
		await enqueueJob(createMockScmWebhookJob());

		const [, opts] = QueueMock.mock.calls[0];
		// The retry-safety + Redis-hygiene story hinges on these exact values —
		// lock them against accidental regression (see producer.ts rationale).
		expect(opts).toMatchObject({
			defaultJobOptions: {
				attempts: 3,
				backoff: { type: 'exponential', delay: 5_000 },
				removeOnComplete: { age: 24 * 60 * 60, count: 100 },
				removeOnFail: { age: 7 * 24 * 60 * 60 },
			},
		});
	});

	it('adds an scm job named by its type, using deliveryId as the job id', async () => {
		const { enqueueJob } = await import('@/queue/producer.js');
		const job = createMockScmWebhookJob();

		const id = await enqueueJob(job);

		expect(add).toHaveBeenCalledWith('scm', job, { jobId: job.deliveryId });
		expect(id).toBe('bull-assigned-id');
	});

	it('adds a github-projects job named by its type, demoted below the default priority', async () => {
		const { enqueueJob } = await import('@/queue/producer.js');
		const job = createMockGitHubProjectsWebhookJob();

		await enqueueJob(job);

		// PM-board jobs (planning/implementation) must not queue ahead of a
		// review-lifecycle (`scm`) job — see priorityFor's rationale.
		expect(add).toHaveBeenCalledWith('github-projects', job, {
			jobId: job.deliveryId,
			priority: 10,
		});
	});

	it('leaves an scm job at the default (unset) priority', async () => {
		const { enqueueJob } = await import('@/queue/producer.js');
		const job = createMockScmWebhookJob();

		await enqueueJob(job);

		const [, , opts] = add.mock.calls[0];
		expect(opts).not.toHaveProperty('priority');
	});

	it('demotes a work-item invalidation job because it dispatches Planning', async () => {
		const { enqueueJob } = await import('@/queue/producer.js');
		const job = createMockScmWebhookJob({
			event: {
				...createMockScmWebhookJob().event,
				kind: 'work-item',
				action: 'edited',
				workItemBodyChanged: true,
			},
		});

		await enqueueJob(job);

		expect(add).toHaveBeenCalledWith('scm', job, {
			jobId: job.deliveryId,
			priority: 10,
		});
	});

	// A dispatch/run row written before issue #385 still carries the legacy
	// envelope (`type: 'github'`), and every manual-retry and reconciler path hands
	// that raw `jsonb` to `priorityFor`. Without normalizing first it matches
	// neither arm and falls through to `priority: 0` — BullMQ's *highest* — so a
	// resurrected board job would dequeue ahead of PR review-lifecycle jobs.
	it('demotes a legacy pre-#385 work-item envelope read straight from jsonb', async () => {
		const { enqueueJob } = await import('@/queue/producer.js');
		const legacy = {
			type: 'github',
			projectId: 'swarm',
			deliveryId: 'delivery-legacy',
			event: {
				eventType: 'issues',
				action: 'labeled',
				repoFullName: 'SmartTechBrewery/swarm',
				workItemId: '42',
				isCommentEvent: false,
				labelName: 'swarm-replan',
			},
		} as unknown as SwarmJob;

		await enqueueJob(legacy);

		expect(add).toHaveBeenCalledWith('github', legacy, {
			jobId: 'delivery-legacy',
			priority: 10,
		});
	});

	it('omits the job id when the event carries no deliveryId', async () => {
		const { enqueueJob } = await import('@/queue/producer.js');
		const { deliveryId: _dropped, ...job } = createMockScmWebhookJob();

		await enqueueJob(job);

		expect(add).toHaveBeenCalledWith('scm', job, undefined);
	});

	it('reuses the one queue singleton across enqueues', async () => {
		const { enqueueJob } = await import('@/queue/producer.js');
		await enqueueJob(createMockScmWebhookJob());
		await enqueueJob(createMockGitHubProjectsWebhookJob());

		expect(QueueMock).toHaveBeenCalledOnce();
		expect(add).toHaveBeenCalledTimes(2);
	});

	it('throws if REDIS_URL is unset (config error surfaces at first enqueue)', async () => {
		process.env.REDIS_URL = '';
		const { enqueueJob } = await import('@/queue/producer.js');

		await expect(enqueueJob(createMockScmWebhookJob())).rejects.toThrow(/REDIS_URL/);
		expect(QueueMock).not.toHaveBeenCalled();
	});
});

describe('enqueueDispatchWakeUp', () => {
	it('adds the wake-up under its deterministic job id with the given delay', async () => {
		const { enqueueDispatchWakeUp } = await import('@/queue/producer.js');
		const job = createMockScmWebhookJob();

		await enqueueDispatchWakeUp(job, 'dispatch_abc_w2', 60_000);

		expect(add).toHaveBeenCalledWith('scm', job, {
			jobId: 'dispatch_abc_w2',
			delay: 60_000,
		});
	});

	it('omits the delay for an immediately-due wake-up', async () => {
		const { enqueueDispatchWakeUp } = await import('@/queue/producer.js');
		const job = createMockScmWebhookJob();

		await enqueueDispatchWakeUp(job, 'dispatch_abc_w0', 0);

		const [, , opts] = add.mock.calls[0];
		expect(opts).toEqual({ jobId: 'dispatch_abc_w0' });
	});

	it('demotes a github-projects wake-up below the default priority', async () => {
		const { enqueueDispatchWakeUp } = await import('@/queue/producer.js');
		const job = createMockGitHubProjectsWebhookJob();

		await enqueueDispatchWakeUp(job, 'dispatch_board_w0', 0);

		expect(add).toHaveBeenCalledWith('github-projects', job, {
			jobId: 'dispatch_board_w0',
			priority: 10,
		});
	});

	// The reconciler's `republishWakeUps` repairs *every* wakeable dispatch on
	// startup, legacy rows included, so the wake-up path needs the same demotion.
	it('demotes a legacy pre-#385 work-item wake-up', async () => {
		const { enqueueDispatchWakeUp } = await import('@/queue/producer.js');
		const legacy = {
			type: 'github',
			projectId: 'swarm',
			event: {
				eventType: 'issues',
				action: 'labeled',
				repoFullName: 'SmartTechBrewery/swarm',
				workItemId: '42',
				isCommentEvent: false,
				labelName: 'swarm-replan',
			},
		} as unknown as SwarmJob;

		await enqueueDispatchWakeUp(legacy, 'dispatch_legacy_w0', 0);

		const [, , opts] = add.mock.calls[0];
		expect(opts).toEqual({ jobId: 'dispatch_legacy_w0', priority: 10 });
	});
});

describe('removePendingJobById', () => {
	it('removes a pending (delayed) job and returns true', async () => {
		const remove = vi.fn().mockResolvedValue(undefined);
		fromId.mockResolvedValue({ getState: async () => 'delayed', remove });
		const { removePendingJobById } = await import('@/queue/producer.js');

		await expect(removePendingJobById('dispatch_abc_w1')).resolves.toBe(true);
		expect(remove).toHaveBeenCalledOnce();
	});

	it('returns false without removing when the job is active or finished', async () => {
		const remove = vi.fn().mockResolvedValue(undefined);
		fromId.mockResolvedValue({ getState: async () => 'active', remove });
		const { removePendingJobById } = await import('@/queue/producer.js');

		await expect(removePendingJobById('dispatch_abc_w1')).resolves.toBe(false);
		expect(remove).not.toHaveBeenCalled();
	});

	it('returns false when no job matches the id', async () => {
		fromId.mockResolvedValue(undefined);
		const { removePendingJobById } = await import('@/queue/producer.js');

		await expect(removePendingJobById('dispatch_missing_w0')).resolves.toBe(false);
	});
});

describe('clearPendingJobs', () => {
	it('removes every waiting, prioritized, and delayed job without touching active work', async () => {
		const removeWaiting = vi.fn().mockResolvedValue(undefined);
		const removePrioritized = vi.fn().mockResolvedValue(undefined);
		const removeDelayed = vi.fn().mockResolvedValue(undefined);
		getWaiting.mockResolvedValue([{ remove: removeWaiting }]);
		getPrioritized.mockResolvedValue([{ remove: removePrioritized }]);
		getDelayed.mockResolvedValue([{ remove: removeDelayed }]);
		const { clearPendingJobs } = await import('@/queue/producer.js');

		await expect(clearPendingJobs()).resolves.toBe(3);

		expect(removeWaiting).toHaveBeenCalledOnce();
		expect(removePrioritized).toHaveBeenCalledOnce();
		expect(removeDelayed).toHaveBeenCalledOnce();
	});
});

describe('closeQueue', () => {
	it('closes the queue once it has been created', async () => {
		const { enqueueJob, closeQueue } = await import('@/queue/producer.js');
		await enqueueJob(createMockScmWebhookJob());

		await closeQueue();

		expect(close).toHaveBeenCalledOnce();
	});

	it('is a no-op when nothing was ever enqueued', async () => {
		const { closeQueue } = await import('@/queue/producer.js');

		await expect(closeQueue()).resolves.toBeUndefined();
		expect(close).not.toHaveBeenCalled();
	});

	it('recreates the queue on the next enqueue after a close', async () => {
		const { enqueueJob, closeQueue } = await import('@/queue/producer.js');
		await enqueueJob(createMockScmWebhookJob());
		await closeQueue();
		await enqueueJob(createMockScmWebhookJob());

		expect(QueueMock).toHaveBeenCalledTimes(2);
	});
});
