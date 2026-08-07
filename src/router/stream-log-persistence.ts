/**
 * Server-side persistence of a transport-dispatched run's live output — the
 * control-plane half of "see what a run is doing while it runs" for a worker
 * reached over the transport (ADR-003 §2).
 *
 * The worker streams; the control plane persists. A worker batches every agent
 * line into a `stream-log` frame (`../transport/assignment-execution.ts`) and this
 * module writes those lines to `run_output_events`, which is what the run detail
 * page polls. It lives here rather than on the worker because writing that table
 * needs a resource a federated worker must not and cannot hold — a database
 * connection (ADR-004 §2: an operation needing a resource the worker cannot hold
 * runs on the control plane). Doing it for *every* worker rather than only the
 * DB-free one is what stops the same run producing output on one machine and
 * nothing on another; the same-host executor therefore no longer persists locally
 * (`../worker/transport-client.ts`), so no line is written twice.
 *
 * Writing is fire-and-forget — the socket frame handler
 * (`./worker-transport.ts`) must never block on Postgres — but **ordered per
 * run**: appends for one run queue behind each other on a per-`runId` promise
 * chain, exactly as the worker-local batcher's `pending` chain does
 * (`../worker/live-output.ts`), so two batches can never interleave. A failed
 * write is logged and swallowed: losing a log line must not take the socket down.
 *
 * The retention cap is not enforced here — `appendRunOutputEvents` takes the run
 * row's lock, clips the boundary event and records `outputTruncated` itself. Once
 * a run is capped, later frames are dropped by that repository call; the control
 * plane has no way to tell the worker to stop streaming, and bounded socket
 * chatter is cheaper than the protocol change a backpressure signal would need.
 */

import {
	appendRunOutputEvents,
	type RunOutputEventInput,
} from '../db/repositories/runsRepository.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { StreamLog } from '../transport/protocol.js';

/**
 * runId → the tail of that run's append chain. Module-private, and self-pruning:
 * a chain deletes its own entry once it settles as the tail, so a long-lived
 * router does not accumulate one entry per run it has ever seen.
 */
const chains = new Map<string, Promise<void>>();

/**
 * The wire carries an ISO-8601 instant; the column takes a `Date`. An
 * unparseable value falls back to "now" rather than handing Postgres an invalid
 * date and failing the whole batch — the line itself is still worth keeping, and
 * its arrival time is within a batch window of when it was emitted.
 */
function parseEmittedAt(value: string): Date {
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

/**
 * Append one `stream-log` frame's lines to its run's output stream. Returns
 * immediately — the write runs on the run's chain. A frame with no `runId` (a
 * dispatch with no run row) is skipped: there is nothing to attach the rows to.
 */
export function persistStreamLog(frame: StreamLog): void {
	const { runId } = frame;
	if (!runId) {
		logger.debug('stream-log frame carries no run id — dropping its output', {
			dispatchId: frame.dispatchId,
		});
		return;
	}
	const events: RunOutputEventInput[] = frame.lines.map((line) => ({
		stream: line.stream,
		content: line.content,
		emittedAt: parseEmittedAt(line.emittedAt),
	}));
	const next: Promise<void> = (chains.get(runId) ?? Promise.resolve())
		.then(() => appendRunOutputEvents(runId, events))
		.catch((err) => {
			logger.error('Failed to persist streamed run output (continuing)', {
				runId,
				error: describeError(err),
			});
		})
		.finally(() => {
			// Identity-checked, so a settled chain can't evict a later batch's tail.
			if (chains.get(runId) === next) chains.delete(runId);
		});
	chains.set(runId, next);
}
