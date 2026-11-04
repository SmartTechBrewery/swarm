/**
 * The daemon's half of verifying a runtime version a **launcher-run worker** was
 * moved to (issue #1303) — the runtime twin of `./build-verification.ts`, which stays
 * as it is for clone-based workers.
 *
 * `./runtime-update.ts` records the move as a pending-verification record in the
 * worker's own `state.json` (`../launcher/worker-profile.ts`), and the launcher
 * (`../launcher/main.ts`) counts every start of the new version against it *before*
 * handing its process over — so, unlike a clone, this daemon has no start to count:
 * by the time any of its code runs, the count is already on disk. What is left here
 * is the two moments only a running daemon can see:
 *
 * - **The first session** — {@link createRuntimeHandshakePromotion}. A session is the
 *   proof the record was waiting for, so it makes the version this daemon was started
 *   on the worker's last known good one and clears the record. Guarded, because
 *   `onSession` fires on every reconnect and only the first one of a process is news.
 *   The version the worker was moved from is then no longer needed to go back to, so
 *   every runtime version no worker on this host names any more is removed
 *   (`pruneRuntimes`, issue #1304) — best effort, off the session's path.
 * - **A handshake the control plane rejects outright** —
 *   {@link returnRuntimeAfterFatalHandshake}. A protocol mismatch, a capability
 *   rejection or a refused credential is this version saying it cannot serve this
 *   control plane, and no restart changes that. So it spends the whole start budget at
 *   once and ends the process; the launcher's next start then goes back to the version
 *   the worker was moved from instead of waiting the counter out.
 *
 * "The version this daemon was started on" is `state.json`'s `lastRuntimeVersion`,
 * which the launcher writes immediately before it starts the daemon, in the same
 * vocabulary — a runtime directory's name — as the record itself.
 *
 * Nothing is reported from here. The control plane learns which build a worker came
 * back on from the `build` its next handshake declares, exactly as for a clone.
 */

import { pruneRuntimes } from '../launcher/runtime-store.js';
import {
	MAX_FAILED_STARTS,
	type RuntimePendingVerification,
	readWorkerState,
	referencedRuntimeVersions,
	updateWorkerState,
} from '../launcher/worker-profile.js';
import { describeError } from '../lib/errors.js';
import { logger as defaultLogger } from '../lib/logger.js';
import { isFatalHandshakeRejection } from './worker-client.js';
import type { UpdateLogger } from './worker-update.js';

export interface RuntimeVerificationOptions {
	/** This launcher-run worker's id (`SWARM_WORKER_ID`): whose `state.json` to read. */
	workerId: string;
	/** Injectable so tests never touch the real home directory. */
	homeDir?: string;
	/** Released before the process ends — the daemon's own teardown. */
	shutdown?: () => Promise<void> | void;
	/** Ends the process; defaults to `process.exit`. */
	exit?: (code: number) => void;
	logger?: UpdateLogger;
}

/**
 * The record awaiting proof of the version this daemon was started on, or `null` —
 * including when there is no readable state, or the record names another version.
 */
function pendingForThisVersion(
	options: RuntimeVerificationOptions,
): RuntimePendingVerification | null {
	const state = readWorkerState(options.workerId, options.homeDir);
	const pending = state?.pendingVerification;
	return pending && pending.version === state.lastRuntimeVersion ? pending : null;
}

/**
 * The `onSession` half: promote the version this daemon was started on the first time
 * it establishes a session, and do nothing on every reconnect after that. Never
 * throws — a promotion that cannot be written is logged, and the launcher then counts
 * on, which is the conservative direction.
 */
export function createRuntimeHandshakePromotion(
	options: RuntimeVerificationOptions,
): () => Promise<void> {
	let promoted = false;
	return async () => {
		if (promoted) return;
		promoted = true;
		const logger = options.logger ?? defaultLogger;
		try {
			const pending = pendingForThisVersion(options);
			if (!pending) return;
			const recorded = updateWorkerState(
				options.workerId,
				{ lastKnownGoodVersion: pending.version, pendingVerification: null },
				options.homeDir,
			);
			if (!recorded) return;
			logger.info('runtime version verified — promoting it to last known good', {
				workerId: options.workerId,
				version: pending.version,
				previousVersion: pending.previousVersion,
			});
		} catch (err) {
			logger.error('recording a verified runtime version failed', {
				workerId: options.workerId,
				error: describeError(err),
			});
			return;
		}
		await pruneAbandonedRuntimes(options, logger);
	};
}

/**
 * Remove the runtime versions no worker on this host names now that the promotion
 * has let go of the version this worker was moved from (issue #1304). Best effort,
 * and never throws: the session is unaffected by anything it fails at.
 */
async function pruneAbandonedRuntimes(
	options: RuntimeVerificationOptions,
	logger: UpdateLogger,
): Promise<void> {
	try {
		const pruned = await pruneRuntimes({
			homeDir: options.homeDir,
			keep: () => referencedRuntimeVersions(options.homeDir),
		});
		for (const version of pruned.removed)
			logger.info('removed a runtime version no worker on this host uses any more', {
				workerId: options.workerId,
				version,
			});
		if (pruned.withheld) logger.warn(pruned.withheld, { workerId: options.workerId });
	} catch (err) {
		logger.error('removing unused runtime versions failed', {
			workerId: options.workerId,
			error: describeError(err),
		});
	}
}

/**
 * Give up on the version this daemon was started on because the control plane
 * rejected its handshake outright — when there is a pending record for that to be
 * about.
 *
 * Resolves `true` when this daemon is on its way out, `false` when the error is not
 * that kind of rejection or nothing was being verified, in which case the caller
 * handles it exactly as it did before.
 */
export async function returnRuntimeAfterFatalHandshake(
	err: unknown,
	options: RuntimeVerificationOptions,
): Promise<boolean> {
	if (!isFatalHandshakeRejection(err)) return false;
	const logger = options.logger ?? defaultLogger;
	let pending: RuntimePendingVerification | null;
	try {
		pending = pendingForThisVersion(options);
		if (!pending) return false;
		const spent = { ...pending, failedStarts: Math.max(pending.failedStarts, MAX_FAILED_STARTS) };
		if (!updateWorkerState(options.workerId, { pendingVerification: spent }, options.homeDir))
			return false;
	} catch (recordErr) {
		logger.error('recording a rejected runtime version failed', {
			workerId: options.workerId,
			error: describeError(recordErr),
		});
		return false;
	}
	logger.error(
		'the control plane rejected this runtime version outright — the launcher starts the previous one next',
		{
			workerId: options.workerId,
			version: pending.version,
			previousVersion: pending.previousVersion,
			error: describeError(err),
		},
	);
	try {
		await options.shutdown?.();
	} catch (shutdownErr) {
		// Exited through, as `./build-verification.ts` does: the session lease expires on
		// its own TTL, where a daemon left running on an abandoned version would not.
		logger.error('releasing the worker session before giving up on a runtime version failed', {
			error: describeError(shutdownErr),
		});
	}
	(options.exit ?? ((code: number) => process.exit(code)))(0);
	return true;
}
