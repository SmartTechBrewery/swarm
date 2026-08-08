import { Redis } from 'ioredis';
import { requireEnv } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { parseRedisUrl } from '../lib/redis.js';

const KEY_NS = 'swarm:project-slots:';

// Both scripts run as a single atomic Redis operation, so a concurrent
// acquire/release for the same key can never interleave with the read + write
// pair below it — the failure mode a plain incr/decr pair would allow.
const ACQUIRE_SCRIPT = `
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
if count >= tonumber(ARGV[1]) then
  return -1
end
return redis.call('INCR', KEYS[1])
`;

const RELEASE_SCRIPT = `
local count = redis.call('DECR', KEYS[1])
if count < 0 then
  redis.call('SET', KEYS[1], '0')
  return 0
end
return count
`;

let redisInstance: Redis | null = null;

export type SlotAcquisition = { acquired: false } | { acquired: true; tracked: boolean };

function getRedis(): Redis {
	if (!redisInstance) {
		redisInstance = new Redis({
			...parseRedisUrl(requireEnv('REDIS_URL')),
			maxRetriesPerRequest: 1,
		});
		redisInstance.on('error', (err) => {
			logger.warn('project-concurrency: Redis connection error', { error: String(err) });
		});
	}
	return redisInstance;
}

/**
 * Atomically reserve one of a project's slots. Redis failures fail open because
 * the worker-global BullMQ concurrency still bounds total load.
 */
export async function acquireProjectSlot(
	projectId: string,
	limit: number,
): Promise<SlotAcquisition> {
	const key = `${KEY_NS}${projectId}`;
	try {
		const redis = getRedis();
		const count = (await redis.eval(ACQUIRE_SCRIPT, 1, key, limit)) as number;
		if (count < 0) {
			logger.debug('project-concurrency: at limit, deferring', { projectId, limit });
			return { acquired: false };
		}
		return { acquired: true, tracked: true };
	} catch (err) {
		logger.error('project-concurrency: Redis error — failing open (running uncapped)', {
			projectId,
			error: String(err),
		});
		return { acquired: true, tracked: false };
	}
}

export async function releaseProjectSlot(projectId: string): Promise<void> {
	const key = `${KEY_NS}${projectId}`;
	try {
		const redis = getRedis();
		await redis.eval(RELEASE_SCRIPT, 1, key);
	} catch (err) {
		logger.warn('project-concurrency: release failed', { projectId, error: String(err) });
	}
}
