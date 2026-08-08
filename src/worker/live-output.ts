/**
 * Live run output — the user-visible "this run is still alive" heartbeat.
 *
 * The DB batcher that used to live here retired with the in-process BullMQ
 * executor (issue #553): a run is dispatched over the worker transport, streams
 * its lines up, and the control plane persists them
 * (`../router/stream-log-persistence.ts`). What remains is the heartbeat's
 * cadence and its rendered line, which the transport executor's own wrapper
 * (`../transport/assignment-execution.ts`) emits — kept here, shared, so the
 * *user-visible* string has one definition.
 */

/**
 * How long a Claude run may stay silent before the live log says so. Claude can
 * work for minutes without emitting a readable event (one long tool call), and
 * on the run page that is indistinguishable from a hung process — the failure
 * mode issue #356 was filed for. Kept an internal constant rather than a
 * setting: it exists to make "alive" legible, not to be tuned. Claude-only
 * because the other CLIs' output behavior is unchanged by that issue.
 */
export const HEARTBEAT_MS = 30_000;

/** The line a silent Claude run emits. */
export function stillRunningLine(): string {
	return `Still running — no output for ${HEARTBEAT_MS / 1_000}s.`;
}
