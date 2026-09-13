/**
 * User-initiated run cancellation — the durable, cross-process hand-off behind
 * the dashboard's "Terminate" action (issue #166).
 *
 * The dashboard and worker are separate host processes, so the dashboard can't
 * reach into the worker to kill an in-flight agent (and must never trust a PID
 * the browser hands it). Instead it records the intent in Redis, keyed by the
 * immutable SWARM run id, and notifies the worker:
 *
 *   - A **durable set** (`CANCELLATION_SET_KEY`) of run ids a user asked to
 *     terminate. Durable so a cancellation requested while the worker is between
 *     jobs — or restarting — is still honoured when the run is next examined
 *     ({@link isRunCancellationRequested}), rather than lost with a fired-once
 *     notification.
 *   - A **pub/sub notification** (`CANCELLATION_CHANNEL`) so a worker already
 *     running the matching agent aborts it *promptly* instead of only noticing
 *     on the next poll.
 *
 * Keying on the run id (not the task id) is deliberate: a task can be retried
 * into a *new* run, and a cancellation aimed at the old run must never terminate
 * the retry. The worker clears the entry once it has acted on it (and the
 * `retryNow` mutation clears it before re-running), so a re-run of a terminated
 * run starts clean.
 *
 * **Both writes are also the audit trail** (issue #913). The Redis records are
 * designed to be short-lived — the worker clears the marker *and* the origin the
 * moment it acts — so minutes after an incident nothing anywhere says a
 * cancellation was ever asked for. Both mutating calls therefore log one line
 * naming the run, its project, task and phase, the operator action behind the
 * call, and the recorded origin, which is the only record that outlives the
 * marker. Nothing secret goes on those lines, and `CancellationOrigin.actor` is
 * logged only when one was genuinely recorded — never guessed (issue #308).
 *
 * Own lazy ioredis client per process, mirroring `project-concurrency.ts` — the
 * dashboard publishes, the worker subscribes, both against the one shared Redis.
 */

import { Redis } from 'ioredis';
import { z } from 'zod';
import { requireEnv } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { parseRedisUrl } from '../lib/redis.js';

/** The durable set of run ids a user asked to terminate. */
const CANCELLATION_SET_KEY = 'swarm:run-cancellations';
/**
 * Companion hash of `runId -> CancellationOrigin` JSON, recorded only by the
 * supported dashboard/API `terminate` path (issue #308). A run id present in
 * {@link CANCELLATION_SET_KEY} with no matching field here is a marker-only
 * cancellation (an operator/process wrote the set entry directly) and must be
 * treated as unknown/external — this hash is never used to *decide* whether a
 * run is cancelled, only to describe one that already is.
 */
const CANCELLATION_ORIGIN_KEY = 'swarm:run-cancellation-origins';
/** Pub/sub channel carrying a just-requested run id for prompt worker abort. */
const CANCELLATION_CHANNEL = 'swarm:run-cancel';

// Redis EXEC reports individual command errors after preceding commands have
// already run. Validate both key types inside one script before changing either
// record, so a wrong-type companion key cannot leave a marker-only request.
//
// Both scripts return whether they actually *changed* the marker set (SADD/SREM's
// own reply) rather than a constant 1, which is what lets the audit lines below
// tell a cancellation that took effect from one that found nothing to cancel
// (issue #913): a request landing on a run already marked is a repeat, and a clear
// that removed nothing means the run settled with no cancellation pending.
const RECORD_CANCELLATION_SCRIPT = `
local setType = redis.call('TYPE', KEYS[1])['ok']
if setType ~= 'none' and setType ~= 'set' then
  return redis.error_reply('run-cancellation: cancellation marker key must be a set')
end

local originType = redis.call('TYPE', KEYS[2])['ok']
if originType ~= 'none' and originType ~= 'hash' then
  return redis.error_reply('run-cancellation: cancellation origin key must be a hash')
end

local added = redis.call('SADD', KEYS[1], ARGV[1])
redis.call('HSET', KEYS[2], ARGV[1], ARGV[2])
return added
`;

const CLEAR_CANCELLATION_SCRIPT = `
local setType = redis.call('TYPE', KEYS[1])['ok']
if setType ~= 'none' and setType ~= 'set' then
  return redis.error_reply('run-cancellation: cancellation marker key must be a set')
end

local originType = redis.call('TYPE', KEYS[2])['ok']
if originType ~= 'none' and originType ~= 'hash' then
  return redis.error_reply('run-cancellation: cancellation origin key must be a hash')
end

local removed = redis.call('SREM', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[2], ARGV[1])
return removed
`;

/**
 * A cancellation's recorded origin (issue #308) — additive, structured data
 * alongside the neutral {@link RUN_CANCELLED_MESSAGE}. At minimum distinguishes
 * the supported dashboard/API termination action from an unknown/external
 * marker; never inferred from the mere existence of the durable set entry.
 * `actor` is only ever set when real caller identity was available at the API
 * boundary (there is no per-user auth today — see `terminate` in
 * `src/api/routers/runs.ts`), so it stays absent rather than guessed.
 */
export const CancellationOriginSchema = z.object({
	source: z.enum(['dashboard', 'api']),
	actor: z.string().optional(),
	/** ISO 8601 timestamp of the request. */
	requestedAt: z.string(),
	requestId: z.string().optional(),
});
export type CancellationOrigin = z.infer<typeof CancellationOriginSchema>;

/** The run a cancellation call concerns, named the way an incident review needs it. */
interface RunCancellationSubject {
	projectId: string;
	taskId: string;
	phase: string;
}

/**
 * A cancellation request's audit context (issue #913) — the run it names plus the
 * operator action behind it: `'terminate'` for the dashboard/API Terminate
 * action, `'reset'` for the agent stop "Reset & restart" performs first. It is
 * deliberately separate from {@link CancellationOrigin}, which is *stored* and
 * shown in the UI: this describes the code path that asked, a fact the caller
 * always knows, so it never has to stand in for an actor nobody established.
 */
export interface RunCancellationRequestContext extends RunCancellationSubject {
	action: 'terminate' | 'reset';
}

/**
 * The same for a clear: which lifecycle step dropped the marker — a run settling
 * terminally, a manual retry of the same row, or a reset clearing it before it
 * restarts the phase.
 */
export interface RunCancellationClearContext extends RunCancellationSubject {
	action: 'run-settled' | 'retry' | 'reset';
}

/**
 * The `error`/message a cancelled run records — its terminal reason. Neutral by
 * design (issue #305): the durable marker this module tracks proves only that a
 * cancellation was requested, not who requested it, so the wording must not
 * assert an unverified actor or origin.
 */
export const RUN_CANCELLED_MESSAGE = 'Run cancelled after a cancellation request.';

let redisInstance: Redis | null = null;

function getRedis(): Redis {
	if (!redisInstance) {
		redisInstance = new Redis({
			...parseRedisUrl(requireEnv('REDIS_URL')),
			maxRetriesPerRequest: 1,
		});
		redisInstance.on('error', (err) => {
			logger.warn('run-cancellation: Redis connection error', { error: String(err) });
		});
	}
	return redisInstance;
}

/**
 * Record a user's intent to terminate `runId` and notify any worker running it.
 * The set write is the durable source of truth; the publish is best-effort
 * prompt notification (a worker not currently subscribed still honours the set
 * entry when it next examines the run). Throws if the durable write fails — the
 * caller (the `terminate` mutation) surfaces that so the user knows the request
 * didn't land.
 *
 * `origin` is recorded atomically as a companion structure ({@link getRunCancellationOrigin})
 * alongside the durable set entry. The script validates both destination key
 * types before writing, so either both records are changed or the request fails.
 *
 * `context` is not stored — it is what the audit line says (issue #913). Both
 * records here are cleared the moment the worker acts on them, so this log line
 * is the only lasting answer to "what asked for this, and through which surface".
 * A request that fails to record logs the same fields at `error` before it
 * rethrows, because an asked-for cancellation that never landed is exactly as
 * worth knowing about as one that did.
 */
export async function requestRunCancellation(
	runId: string,
	origin: CancellationOrigin,
	context: RunCancellationRequestContext,
): Promise<void> {
	const redis = getRedis();
	// `actor` and `requestId` are optional on the origin and stay `undefined` when
	// none was recorded — both log formats drop an undefined value, so an absent
	// actor reads as absent rather than as a guessed one.
	const audit = {
		runId,
		projectId: context.projectId,
		taskId: context.taskId,
		phase: context.phase,
		action: context.action,
		originSource: origin.source,
		originActor: origin.actor,
		requestedAt: origin.requestedAt,
		requestId: origin.requestId,
	};

	let recorded: unknown;
	try {
		recorded = await redis.eval(
			RECORD_CANCELLATION_SCRIPT,
			2,
			CANCELLATION_SET_KEY,
			CANCELLATION_ORIGIN_KEY,
			runId,
			JSON.stringify(origin),
		);
	} catch (err) {
		logger.error('run cancellation requested but not recorded', {
			...audit,
			error: String(err),
		});
		throw err;
	}

	logger.info('run cancellation requested', {
		...audit,
		// `already-pending` is a repeat — a second Terminate click, or a reset of a
		// run that is already terminating — which is otherwise indistinguishable
		// from the request that actually created the marker once it is cleared.
		marker: recorded === 1 ? 'recorded' : 'already-pending',
	});

	try {
		await redis.publish(CANCELLATION_CHANNEL, runId);
	} catch (err) {
		// The durable set entry already landed; a failed notification only costs
		// promptness (the worker still catches it on its own start-check), so log
		// and continue rather than failing the whole termination.
		logger.warn('run-cancellation: failed to publish cancellation notification', {
			runId,
			error: String(err),
		});
	}
}

/**
 * The recorded origin for `runId`'s cancellation, when one was durably stored
 * by {@link requestRunCancellation}. `null` for a marker-only cancellation (the
 * durable set entry exists but no origin was ever recorded — an operator/process
 * wrote it directly), for a run never cancelled, and on a malformed/unreadable
 * record — fails safe rather than displaying a guessed origin.
 */
export async function getRunCancellationOrigin(runId: string): Promise<CancellationOrigin | null> {
	try {
		const raw = await getRedis().hget(CANCELLATION_ORIGIN_KEY, runId);
		if (!raw) return null;
		const parsed = CancellationOriginSchema.safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : null;
	} catch (err) {
		logger.warn('run-cancellation: failed to read cancellation origin — treating as unknown', {
			runId,
			error: String(err),
		});
		return null;
	}
}

/**
 * Whether a user asked to terminate `runId`. Read by the worker at run start and
 * when a run fails, to tell a user-termination abort apart from a worker-shutdown
 * one. Fails safe: a Redis read error resolves `false` (treat as not cancelled)
 * so a transient blip never spuriously terminates a healthy run.
 */
export async function isRunCancellationRequested(runId: string): Promise<boolean> {
	try {
		return (await getRedis().sismember(CANCELLATION_SET_KEY, runId)) === 1;
	} catch (err) {
		logger.warn('run-cancellation: failed to read cancellation state — assuming not cancelled', {
			runId,
			error: String(err),
		});
		return false;
	}
}

/**
 * Clear `runId`'s cancellation entry (and any recorded origin) once it has been
 * acted on (the worker after terminating the run, `retryNow` before re-running
 * it), so a later re-run of the same row isn't terminated by a stale request and
 * doesn't inherit a stale origin. Best-effort: a failed clear only risks a
 * redundant no-op abort of an already-terminal run, so log and continue.
 *
 * This is where a cancellation's record is destroyed, so it is also where the
 * fact that one *took effect* is put on the log instead (issue #913). Only a
 * clear that actually removed a pending marker logs: the worker clears on every
 * terminal outcome, so logging the no-ops too would bury the one line an incident
 * review is looking for under a line per run.
 */
export async function clearRunCancellation(
	runId: string,
	context: RunCancellationClearContext,
): Promise<void> {
	try {
		const redis = getRedis();
		const cleared = await redis.eval(
			CLEAR_CANCELLATION_SCRIPT,
			2,
			CANCELLATION_SET_KEY,
			CANCELLATION_ORIGIN_KEY,
			runId,
		);
		if (cleared === 1) {
			logger.info('run cancellation cleared', {
				runId,
				projectId: context.projectId,
				taskId: context.taskId,
				phase: context.phase,
				action: context.action,
			});
		}
	} catch (err) {
		logger.warn('run-cancellation: failed to clear cancellation state', {
			runId,
			projectId: context.projectId,
			taskId: context.taskId,
			phase: context.phase,
			action: context.action,
			error: String(err),
		});
	}
}

/**
 * Subscribe to prompt cancellation notifications, invoking `onCancel(runId)` for
 * each one. ioredis requires a dedicated connection in subscriber mode (it can't
 * also run normal commands), so this duplicates the shared client. Returns an
 * async closer the worker calls on shutdown. Best-effort delivery: the durable
 * set (`isRunCancellationRequested`) is the guarantee; this is the low-latency
 * path on top of it.
 */
export function subscribeToRunCancellations(onCancel: (runId: string) => void): {
	close: () => Promise<void>;
} {
	const subscriber = getRedis().duplicate();
	subscriber.on('error', (err) => {
		logger.warn('run-cancellation: subscriber connection error', { error: String(err) });
	});
	subscriber.subscribe(CANCELLATION_CHANNEL).catch((err) => {
		logger.error('run-cancellation: failed to subscribe to cancellation channel', {
			error: String(err),
		});
	});
	subscriber.on('message', (channel, message) => {
		if (channel === CANCELLATION_CHANNEL && message) onCancel(message);
	});
	return {
		close: async () => {
			try {
				await subscriber.quit();
			} catch {
				subscriber.disconnect();
			}
		},
	};
}

/** Close the shared client — called from process shutdown so the socket frees. */
export async function closeRunCancellationRedis(): Promise<void> {
	if (redisInstance) {
		try {
			await redisInstance.quit();
		} catch {
			redisInstance.disconnect();
		}
		redisInstance = null;
	}
}
