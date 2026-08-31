/**
 * How long a worker has to have been quiet before the control plane may act as if
 * it is *gone* rather than merely mid-blip. One number, one justification, shared
 * by the two places that need it:
 *
 * - the bounded settle for an operator termination the router could not push to a
 *   worker that has since gone silent (issue #827, `./dispatch-cancellation.ts`);
 * - the reap of a dispatch whose `/worker/stream` dropped and never came back
 *   (issue #859, `./transport-loss-reaper.ts`).
 *
 * They read it against different evidence — a retained session's `lastHeartbeatAt`
 * there, an observed socket close here — but both are answering the same question,
 * so the window must not drift apart between them.
 *
 * Deliberately dependency-free: the heartbeat TTL is passed in, so callers resolve
 * it from `../identity/worker-session-service.js` themselves and this module stays
 * a pure function of its argument.
 */

/**
 * Floor on how long a worker must have been silent before its missing live session
 * reads as *gone* rather than as a socket that simply closed. A daemon that is up
 * heartbeats every `heartbeatTtlMs / 3` (`heartbeatCadenceMs`) and, if its socket
 * drops, reconnects on a ladder capped at a jittered 30s
 * (`DEFAULT_BACKOFF.maxMs`) — both in `../transport/worker-client.ts`. Two minutes
 * clears the wider of those by 4x, so an ordinary blip never qualifies.
 */
const OFFLINE_SILENCE_FLOOR_MS = 120_000;

/**
 * The silence that makes a worker *probably gone*: twice the configured heartbeat
 * TTL — the window `getLiveSessionForWorker` itself measures liveness over — but
 * never below {@link OFFLINE_SILENCE_FLOOR_MS}, so shortening the TTL cannot shrink
 * this below the reconnect ladder and start settling live phases.
 */
export function offlineSilenceMs(heartbeatTtlMs: number): number {
	return Math.max(2 * heartbeatTtlMs, OFFLINE_SILENCE_FLOOR_MS);
}
