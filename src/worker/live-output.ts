/**
 * Live run output — the worker-side half of "see what a run is doing while it
 * runs". It wraps {@link runAgentCli} so every line the CLI emits is batched
 * into `run_output_events` as it arrives, which is what the run page polls.
 *
 * This is the **in-process BullMQ** path's batcher, and only that path's: a run
 * dispatched over the worker transport streams its lines instead and the control
 * plane persists them (`../router/stream-log-persistence.ts`), so neither
 * transport executor composes this wrapper.
 *
 * The harness decides *what* a line says (Claude's protocol stream is decoded
 * into readable progress there — `src/harness/claude-stream.ts`); this module
 * only decides when those lines are written, and bounds both the batching and
 * the total it will persist.
 */

import { appendRunOutputEvents, MAX_RUN_OUTPUT_BYTES } from '../db/repositories/runsRepository.js';
import { runAgentCli } from '../harness/agent-cli.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/** Batch window and size — a chatty run writes at most ~10 statements/second. */
const BATCH_MS = 100;
const BATCH_SIZE = 100;

/**
 * How long a Claude run may stay silent before the live log says so. Claude can
 * work for minutes without emitting a readable event (one long tool call), and
 * on the run page that is indistinguishable from a hung process — the failure
 * mode issue #356 was filed for. Kept an internal constant rather than a
 * setting: it exists to make "alive" legible, not to be tuned. Claude-only
 * because the other CLIs' output behavior is unchanged by that issue.
 */
const HEARTBEAT_MS = 30_000;

export function createLiveOutputRunner(runId: string | undefined): typeof runAgentCli {
	if (!runId) {
		return runAgentCli;
	}
	return async (options) => {
		let pending = Promise.resolve();
		let queuedBytes = 0;
		let reachedOutputLimit = false;
		let timer: NodeJS.Timeout | undefined;
		let heartbeatTimer: NodeJS.Timeout | undefined;
		let queue: Array<{ stream: 'stdout' | 'stderr'; content: string; emittedAt: Date }> = [];
		const flush = (): void => {
			if (timer) clearTimeout(timer);
			timer = undefined;
			const batch = queue;
			queue = [];
			if (batch.length === 0) return;
			pending = pending
				.then(() => appendRunOutputEvents(runId, batch))
				.catch((err) =>
					logger.error('Failed to persist live run output (continuing)', {
						runId,
						error: describeError(err),
					}),
				);
		};
		const append = (stream: 'stdout' | 'stderr', line: string): void => {
			if (reachedOutputLimit) return;
			const content = `${line}\n`;
			queuedBytes += Buffer.byteLength(content);
			queue.push({ stream, content, emittedAt: new Date() });
			// Keep the boundary event: the repository clips it and records that
			// retention was truncated. Dropping it here leaves the UI unaware.
			if (queuedBytes > MAX_RUN_OUTPUT_BYTES) {
				reachedOutputLimit = true;
				flush();
				return;
			}
			if (queue.length >= BATCH_SIZE) flush();
			else timer ??= setTimeout(flush, BATCH_MS);
		};
		const stopHeartbeat = (): void => {
			if (heartbeatTimer) clearTimeout(heartbeatTimer);
			heartbeatTimer = undefined;
		};
		const armHeartbeat = (): void => {
			if (options.cli !== 'claude') return;
			stopHeartbeat();
			heartbeatTimer = setTimeout(() => {
				append('stdout', `Still running — no output for ${HEARTBEAT_MS / 1_000}s.`);
				armHeartbeat();
			}, HEARTBEAT_MS);
		};

		armHeartbeat();
		try {
			return await runAgentCli({
				...options,
				onStdout: (line) => {
					armHeartbeat();
					options.onStdout?.(line);
					append('stdout', line);
				},
				onStderr: (line) => {
					armHeartbeat();
					options.onStderr?.(line);
					append('stderr', line);
				},
			});
		} finally {
			// Also on the throwing paths (a spawn failure, a cancelled run): whatever
			// the run managed to say before it died is the most useful output there is.
			stopHeartbeat();
			flush();
			await pending;
		}
	};
}
