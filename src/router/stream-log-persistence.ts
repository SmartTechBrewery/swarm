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
 * runs on the control plane). Doing it here for every worker — the control-plane
 * host's own included, which since issue #551 runs the same DB-free entrypoint
 * over loopback — is what stops the same run producing output on one machine and
 * nothing on another, and means no line is ever written twice.
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
 *
 * **What moving the write here costs: output does not survive a lost session.**
 * The worker-local batcher this replaces flushed and *awaited* its DB write in a
 * `finally`, so a run's lines were durable on the worker's own machine whatever
 * happened to the socket. Now the only route to durability is the assignment sink,
 * which drops a `stream-log` frame whenever no session is live
 * (`../transport/worker-client.ts`) — while the phase itself keeps running, because
 * the assignment handler is independent of the heartbeat loop. So a socket lost
 * mid-phase (a dropped connection, a router restart) loses that run's remaining
 * output, and a session lost early loses all of it: the run page stays blank for
 * exactly the attempt an operator most wants to read.
 *
 * That is accepted here rather than solved, deliberately: output is unbounded, so a
 * replay buffer for it would be a memory liability with no correctness payoff, and
 * what is lost is diagnostic. **Since issue #718 that is genuinely all that is
 * lost.** The sentence this paragraph used to rest on — the terminal
 * `TaskExecutionResult` rides the same dead sink, so the dispatch fails and is
 * re-pushed regardless — was false: nothing re-pushes a dispatch already
 * `state='running'`, so the run settled on the back-channel timer as a worker
 * timeout however well it had gone. The sink now spans sessions for that one frame
 * (a bounded, one-per-dispatch queue), so a lost session costs a window of output
 * and not the run's outcome.
 *
 * **What issue #723 adds is legibility, not replay.** The lost window stays lost —
 * nothing here buffers or re-requests it — but the control plane knows the moment
 * the socket closes and the moment one opens, so it annotates the gap it cannot
 * fill: {@link persistControlPlaneNote} writes one line into the run's own output
 * stream on loss and one on restore. That is what stops "working normally, output
 * discarded" from reading exactly like "dead" — a run whose output merely stopped
 * arriving now says so, on the same chain and in the same column as the output it
 * interrupts.
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
 * Queue one append behind whatever is already writing for `runId`. The single
 * definition of "on the run's chain", so a control-plane note and a streamed batch
 * cannot interleave — they are the same kind of write to the same reader.
 */
function appendOnRunChain(runId: string, events: RunOutputEventInput[]): void {
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

/**
 * Append one `stream-log` frame's lines to its run's output stream. Returns
 * immediately — the write runs on the run's chain. A frame with no `runId` (a
 * dispatch with no run row) is skipped: there is nothing to attach the rows to.
 */
export function persistStreamLog(frame: StreamLog, runId: string | undefined): void {
	if (!runId) {
		logger.debug('dispatch has no run row — dropping its streamed output', {
			dispatchId: frame.dispatchId,
		});
		return;
	}
	appendOnRunChain(
		runId,
		frame.lines.map((line) => ({
			stream: line.stream,
			content: line.content,
			emittedAt: parseEmittedAt(line.emittedAt),
		})),
	);
}

/**
 * The three things the control plane has to say about a run whose output it stopped
 * receiving (issue #723, extended by #859). Kept here, next to the sink that writes
 * them, so the *user-visible* strings have one definition — the same reason
 * `stillRunningLine` lives in `../worker/live-output.ts` rather than at its emit
 * site, and phrased in the same plain register, since on the run page they sit in
 * the same column.
 *
 * The third is the one that closes the pair: the drop note promises output resumes
 * "when it reconnects", so a transport that never comes back has to correct that
 * promise in the run's own stream rather than leave it standing
 * (`./transport-loss-reaper.ts`).
 */
export const TRANSPORT_LOST_NOTE =
	'Transport session to the worker running this phase dropped — output is paused until it reconnects.';
export const TRANSPORT_RESTORED_NOTE = 'Transport session restored — output resumes.';
export const TRANSPORT_LOST_ORPHAN_NOTE =
	'Transport session to the worker never returned — this phase was terminated and the pull request, task and capacity it held were released.';

/**
 * Write one control-plane-authored line into a run's output stream. Unlike every
 * other row in `run_output_events` this one is not the agent's — it is what the
 * router observed *about* the run — so it goes on `stderr`, which the run page
 * already renders as its own thing (`dashboard/.../live-output-viewer.tsx`) rather
 * than as another line the agent printed.
 *
 * Ordered and non-blocking on the same terms as {@link persistStreamLog}: it queues
 * on the run's own append chain, so it lands between the batches it actually
 * separates rather than racing them, and it returns immediately so the socket
 * handler that observed the disconnect never waits on Postgres. A dispatch with no
 * run row has nothing to annotate, and a failed write is swallowed — a missing note
 * must not take the socket down.
 */
export function persistControlPlaneNote(runId: string | undefined, content: string): void {
	if (!runId) return;
	appendOnRunChain(runId, [{ stream: 'stderr', content: `${content}\n`, emittedAt: new Date() }]);
}
