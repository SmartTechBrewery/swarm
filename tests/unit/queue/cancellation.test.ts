import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ioredis so nothing touches Redis — capture the set/publish/subscribe calls
// the cancellation module makes. Mirrors the project-concurrency test's shape.
const {
	sadd,
	srem,
	sismember,
	hset,
	hget,
	hdel,
	publish,
	subscribe,
	quit,
	subOn,
	evalScript,
	RedisMock,
} = vi.hoisted(() => {
	const sadd = vi.fn();
	const srem = vi.fn();
	const sismember = vi.fn();
	const hset = vi.fn();
	const hget = vi.fn();
	const hdel = vi.fn();
	const publish = vi.fn();
	const subscribe = vi.fn();
	const quit = vi.fn();
	const disconnect = vi.fn();
	const on = vi.fn();
	const subOn = vi.fn();
	const evalScript = vi.fn();

	const subscriberClient = { on: subOn, subscribe, quit, disconnect };
	const redisClient = {
		sadd,
		srem,
		sismember,
		hset,
		hget,
		hdel,
		publish,
		on,
		quit,
		disconnect,
		duplicate: () => subscriberClient,
		eval: evalScript,
	};
	const RedisMock = vi.fn(() => redisClient);

	return {
		sadd,
		srem,
		sismember,
		hset,
		hget,
		hdel,
		publish,
		subscribe,
		quit,
		subOn,
		evalScript,
		RedisMock,
	};
});

vi.mock('ioredis', () => ({ Redis: RedisMock }));

// The audit lines (issue #913) are the whole point of both mutating calls, so the
// logger is mocked rather than left to console.
const { loggerInfo, loggerWarn, loggerError } = vi.hoisted(() => ({
	loggerInfo: vi.fn(),
	loggerWarn: vi.fn(),
	loggerError: vi.fn(),
}));
vi.mock('@/lib/logger.js', () => ({
	logger: { info: loggerInfo, warn: loggerWarn, error: loggerError, debug: vi.fn() },
}));

const ORIGIN = { source: 'dashboard' as const, requestedAt: '2026-07-19T00:00:00.000Z' };
const REQUEST_CONTEXT = {
	action: 'terminate' as const,
	projectId: 'proj-1',
	taskId: '21',
	phase: 'implementation',
};
const CLEAR_CONTEXT = {
	action: 'run-settled' as const,
	projectId: 'proj-1',
	taskId: '21',
	phase: 'implementation',
};

describe('run cancellation', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		process.env.REDIS_URL = 'redis://localhost:6379';
		sadd.mockResolvedValue(1);
		srem.mockResolvedValue(1);
		sismember.mockResolvedValue(0);
		hset.mockResolvedValue(1);
		hget.mockResolvedValue(null);
		hdel.mockResolvedValue(1);
		publish.mockResolvedValue(1);
		subscribe.mockResolvedValue(1);
		quit.mockResolvedValue('OK');
		evalScript.mockResolvedValue(1);
	});

	describe('requestRunCancellation', () => {
		it('records the run id and its origin in one script before publishing a notification', async () => {
			const { requestRunCancellation } = await import('@/queue/cancellation.js');

			await requestRunCancellation('run-1', ORIGIN, REQUEST_CONTEXT);

			expect(evalScript).toHaveBeenCalledWith(
				expect.stringContaining("redis.call('SADD', KEYS[1], ARGV[1])"),
				2,
				'swarm:run-cancellations',
				'swarm:run-cancellation-origins',
				'run-1',
				JSON.stringify(ORIGIN),
			);
			expect(publish).toHaveBeenCalledWith('swarm:run-cancel', 'run-1');
		});

		// The Redis records are cleared the moment the worker acts, so this line is
		// the only lasting answer to "what asked for this, and through which surface".
		it('logs the run, its project/task/phase and the recorded origin', async () => {
			const { requestRunCancellation } = await import('@/queue/cancellation.js');

			await requestRunCancellation('run-1', ORIGIN, REQUEST_CONTEXT);

			expect(loggerInfo).toHaveBeenCalledWith('run cancellation requested', {
				runId: 'run-1',
				projectId: 'proj-1',
				taskId: '21',
				phase: 'implementation',
				action: 'terminate',
				originSource: 'dashboard',
				originActor: undefined,
				requestedAt: '2026-07-19T00:00:00.000Z',
				requestId: undefined,
				marker: 'recorded',
			});
		});

		it('never invents an actor for an origin that recorded none (issue #308)', async () => {
			const { requestRunCancellation } = await import('@/queue/cancellation.js');

			await requestRunCancellation('run-1', ORIGIN, REQUEST_CONTEXT);

			const context = loggerInfo.mock.calls[0]?.[1] as Record<string, unknown>;
			expect(context.originActor).toBeUndefined();
			// `undefined` is dropped by both log formats, so nothing reads as an actor.
			expect(JSON.stringify(context)).not.toContain('originActor');
		});

		it('marks a request that landed on an already-pending marker as a repeat', async () => {
			evalScript.mockResolvedValueOnce(0);
			const { requestRunCancellation } = await import('@/queue/cancellation.js');

			await requestRunCancellation('run-1', ORIGIN, REQUEST_CONTEXT);

			expect(loggerInfo).toHaveBeenCalledWith(
				'run cancellation requested',
				expect.objectContaining({ marker: 'already-pending' }),
			);
		});

		it('still resolves when the notification publish fails (set write already landed)', async () => {
			publish.mockRejectedValueOnce(new Error('down'));
			const { requestRunCancellation } = await import('@/queue/cancellation.js');

			await expect(
				requestRunCancellation('run-1', ORIGIN, REQUEST_CONTEXT),
			).resolves.toBeUndefined();
			expect(evalScript).toHaveBeenCalled();
		});

		it('throws without publishing when the script rejects an invalid destination key', async () => {
			evalScript.mockRejectedValueOnce(new Error('cancellation origin key must be a hash'));
			const { requestRunCancellation } = await import('@/queue/cancellation.js');

			await expect(requestRunCancellation('run-1', ORIGIN, REQUEST_CONTEXT)).rejects.toThrow(
				'cancellation origin key must be a hash',
			);
			expect(publish).not.toHaveBeenCalled();
		});

		it('logs the same audit fields when the request could not be recorded at all', async () => {
			evalScript.mockRejectedValueOnce(new Error('down'));
			const { requestRunCancellation } = await import('@/queue/cancellation.js');

			await expect(requestRunCancellation('run-1', ORIGIN, REQUEST_CONTEXT)).rejects.toThrow(
				'down',
			);
			expect(loggerError).toHaveBeenCalledWith(
				'run cancellation requested but not recorded',
				expect.objectContaining({
					runId: 'run-1',
					projectId: 'proj-1',
					taskId: '21',
					phase: 'implementation',
					action: 'terminate',
					originSource: 'dashboard',
				}),
			);
			expect(loggerInfo).not.toHaveBeenCalled();
		});
	});

	describe('isRunCancellationRequested', () => {
		it('returns true when the run id is a member of the set', async () => {
			sismember.mockResolvedValue(1);
			const { isRunCancellationRequested } = await import('@/queue/cancellation.js');

			expect(await isRunCancellationRequested('run-1')).toBe(true);
			expect(sismember).toHaveBeenCalledWith('swarm:run-cancellations', 'run-1');
		});

		it('returns false when the run id is not present', async () => {
			sismember.mockResolvedValue(0);
			const { isRunCancellationRequested } = await import('@/queue/cancellation.js');

			expect(await isRunCancellationRequested('run-1')).toBe(false);
		});

		it('fails safe to false on a Redis read error (never spuriously terminates)', async () => {
			sismember.mockRejectedValue(new Error('down'));
			const { isRunCancellationRequested } = await import('@/queue/cancellation.js');

			expect(await isRunCancellationRequested('run-1')).toBe(false);
		});
	});

	describe('clearRunCancellation', () => {
		it('removes the run id and its recorded origin in one script', async () => {
			const { clearRunCancellation } = await import('@/queue/cancellation.js');

			await clearRunCancellation('run-1', CLEAR_CONTEXT);
			expect(evalScript).toHaveBeenCalledWith(
				expect.stringContaining("redis.call('SREM', KEYS[1], ARGV[1])"),
				2,
				'swarm:run-cancellations',
				'swarm:run-cancellation-origins',
				'run-1',
			);
		});

		// This is where the cancellation's own record is destroyed, so it is where the
		// fact that one took effect goes on the log instead (issue #913).
		it('logs the cancellation that actually took effect', async () => {
			const { clearRunCancellation } = await import('@/queue/cancellation.js');

			await clearRunCancellation('run-1', CLEAR_CONTEXT);

			expect(loggerInfo).toHaveBeenCalledWith('run cancellation cleared', {
				runId: 'run-1',
				projectId: 'proj-1',
				taskId: '21',
				phase: 'implementation',
				action: 'run-settled',
			});
		});

		it('stays silent for a clear that found nothing to cancel', async () => {
			evalScript.mockResolvedValueOnce(0);
			const { clearRunCancellation } = await import('@/queue/cancellation.js');

			await clearRunCancellation('run-1', CLEAR_CONTEXT);

			expect(loggerInfo).not.toHaveBeenCalled();
		});

		it('swallows a clear failure', async () => {
			evalScript.mockRejectedValueOnce(new Error('down'));
			const { clearRunCancellation } = await import('@/queue/cancellation.js');

			await expect(clearRunCancellation('run-1', CLEAR_CONTEXT)).resolves.toBeUndefined();
			expect(loggerWarn).toHaveBeenCalledWith(
				'run-cancellation: failed to clear cancellation state',
				expect.objectContaining({ runId: 'run-1', projectId: 'proj-1', action: 'run-settled' }),
			);
		});
	});

	describe('getRunCancellationOrigin', () => {
		it('returns the recorded origin when one was stored', async () => {
			hget.mockResolvedValue(JSON.stringify(ORIGIN));
			const { getRunCancellationOrigin } = await import('@/queue/cancellation.js');

			expect(await getRunCancellationOrigin('run-1')).toEqual(ORIGIN);
			expect(hget).toHaveBeenCalledWith('swarm:run-cancellation-origins', 'run-1');
		});

		it('returns null for a marker-only cancellation (no origin ever recorded)', async () => {
			hget.mockResolvedValue(null);
			const { getRunCancellationOrigin } = await import('@/queue/cancellation.js');

			expect(await getRunCancellationOrigin('run-1')).toBeNull();
		});

		it('returns null and never throws on malformed JSON', async () => {
			hget.mockResolvedValue('{not json');
			const { getRunCancellationOrigin } = await import('@/queue/cancellation.js');

			expect(await getRunCancellationOrigin('run-1')).toBeNull();
		});

		it('returns null for a record that fails schema validation', async () => {
			hget.mockResolvedValue(JSON.stringify({ source: 'not-a-real-source' }));
			const { getRunCancellationOrigin } = await import('@/queue/cancellation.js');

			expect(await getRunCancellationOrigin('run-1')).toBeNull();
		});

		it('fails safe to null on a Redis read error', async () => {
			hget.mockRejectedValue(new Error('down'));
			const { getRunCancellationOrigin } = await import('@/queue/cancellation.js');

			expect(await getRunCancellationOrigin('run-1')).toBeNull();
		});
	});

	describe('subscribeToRunCancellations', () => {
		it('subscribes on a duplicated connection and invokes the callback for a matching message', async () => {
			const { subscribeToRunCancellations } = await import('@/queue/cancellation.js');
			const onCancel = vi.fn();

			subscribeToRunCancellations(onCancel);

			expect(subscribe).toHaveBeenCalledWith('swarm:run-cancel');
			// Drive the registered 'message' handler as ioredis would.
			const handler = subOn.mock.calls.find((c) => c[0] === 'message')?.[1] as (
				channel: string,
				message: string,
			) => void;
			handler('swarm:run-cancel', 'run-42');
			expect(onCancel).toHaveBeenCalledWith('run-42');
		});

		it('ignores messages from other channels', async () => {
			const { subscribeToRunCancellations } = await import('@/queue/cancellation.js');
			const onCancel = vi.fn();

			subscribeToRunCancellations(onCancel);
			const handler = subOn.mock.calls.find((c) => c[0] === 'message')?.[1] as (
				channel: string,
				message: string,
			) => void;
			handler('some-other-channel', 'run-42');
			expect(onCancel).not.toHaveBeenCalled();
		});

		it('closes the subscriber connection', async () => {
			const { subscribeToRunCancellations } = await import('@/queue/cancellation.js');

			const subscription = subscribeToRunCancellations(vi.fn());
			await subscription.close();
			expect(quit).toHaveBeenCalled();
		});
	});

	describe('RUN_CANCELLED_MESSAGE', () => {
		it('is neutral — it never asserts who or where a cancellation came from', async () => {
			const { RUN_CANCELLED_MESSAGE } = await import('@/queue/cancellation.js');

			expect(RUN_CANCELLED_MESSAGE).toBe('Run cancelled after a cancellation request.');
			expect(RUN_CANCELLED_MESSAGE.toLowerCase()).not.toContain('user');
			expect(RUN_CANCELLED_MESSAGE.toLowerCase()).not.toContain('dashboard');
		});
	});
});
