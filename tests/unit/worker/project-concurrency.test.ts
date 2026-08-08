import { beforeEach, describe, expect, it, vi } from 'vitest';

const evalScript =
	vi.fn<(script: string, numKeys: number, ...args: unknown[]) => Promise<number>>();
const on = vi.fn();
const redisClient = { eval: evalScript, on };
const RedisMock = vi.fn<(options: Record<string, unknown>) => typeof redisClient>(
	() => redisClient,
);

vi.mock('ioredis', () => ({ Redis: RedisMock }));

describe('project concurrency', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		process.env.REDIS_URL = 'redis://localhost:6379';
		evalScript.mockResolvedValue(1);
	});

	it('acquires atomically below and at the limit using one fail-fast client', async () => {
		const { acquireProjectSlot } = await import('@/worker/project-concurrency.js');

		expect(await acquireProjectSlot('alpha', 2)).toEqual({ acquired: true, tracked: true });
		evalScript.mockResolvedValueOnce(2);
		expect(await acquireProjectSlot('alpha', 2)).toEqual({ acquired: true, tracked: true });
		expect(evalScript).toHaveBeenCalledWith(
			expect.stringContaining('INCR'),
			1,
			'swarm:project-slots:alpha',
			2,
		);
		expect(RedisMock).toHaveBeenCalledOnce();
		expect(RedisMock.mock.calls[0][0]).toMatchObject({ maxRetriesPerRequest: 1 });
		expect(on).toHaveBeenCalledWith('error', expect.any(Function));
	});

	it('defers at the limit without ever incrementing over it', async () => {
		evalScript.mockResolvedValue(-1);
		const { acquireProjectSlot } = await import('@/worker/project-concurrency.js');

		expect(await acquireProjectSlot('alpha', 2)).toEqual({ acquired: false });
	});

	it('fails open when Redis cannot acquire', async () => {
		evalScript.mockRejectedValue(new Error('down'));
		const { acquireProjectSlot } = await import('@/worker/project-concurrency.js');

		expect(await acquireProjectSlot('alpha', 2)).toEqual({ acquired: true, tracked: false });
	});

	it('releases slots atomically via a single script call', async () => {
		const { releaseProjectSlot } = await import('@/worker/project-concurrency.js');

		await releaseProjectSlot('alpha');
		expect(evalScript).toHaveBeenCalledWith(
			expect.stringContaining('DECR'),
			1,
			'swarm:project-slots:alpha',
		);
	});

	it('swallows release failures', async () => {
		evalScript.mockRejectedValueOnce(new Error('down'));
		const { releaseProjectSlot } = await import('@/worker/project-concurrency.js');

		await expect(releaseProjectSlot('alpha')).resolves.toBeUndefined();
	});
});
