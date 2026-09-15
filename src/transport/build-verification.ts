/**
 * Returning a machine to its last known good SWARM build when the one it was
 * updated to cannot get a word in (issue #934).
 *
 * This is the daemon's half of the pending-verification record
 * `../worker/self-update.ts` keeps: that module owns the transitions on it, this one
 * owns *when* they happen — the same split of mechanism from policy `./worker-update.ts`
 * keeps for the apply itself.
 *
 * It exists because the update channel is one-way once it has been used. A machine
 * whose new build cannot handshake has no socket, so there is nothing left to push a
 * corrective update down; the control plane sees a worker that went away and nothing
 * more. Every other outcome in this feature is reported to the control plane and
 * recovered from there — this one can only be recovered by the machine itself, which
 * is why it is not optional.
 *
 * Three moments, in the order a bad build meets them:
 *
 * - **Process start** — {@link verifyStartupBuild}, the first thing the process does,
 *   before it reads its environment, locks its checkout or opens the transport —
 *   and, crucially, before the daemon's module graph is loaded at all. It counts this
 *   start against the build being verified and, once too many in a row have failed,
 *   returns the install root to the last known good build and ends the process so the
 *   supervisor starts it there. Counting at *start* rather than on an observed failure
 *   is what makes a build that dies before reaching any code of its own recoverable:
 *   the count is already on disk by the time it dies. The budget it is measured
 *   against is `MAX_FAILED_STARTS` *plus* the peers that adopted this build, because
 *   the record is keyed on the install root while the failure it describes is one
 *   daemon's: on a shared install root the peers' own healthy restarts land on this
 *   same counter, and spending the budget on them would roll a working machine back
 *   (issue #973). That guarantee is why
 *   `./connect-entry.ts` is a bootstrap that reaches `./worker-main.ts` through a
 *   dynamic import, and why this module keeps its own static imports down to the state
 *   mechanism — ESM evaluates static imports before any module body, so anything
 *   reachable from here is something a bad build could throw in *ahead* of the count.
 * - **The first handshake** — {@link createHandshakePromotion}. A session is the
 *   proof the record was waiting for, so it promotes the build and clears the record,
 *   and every start after that is an ordinary one. Guarded, because `onSession` fires
 *   on every reconnect and only the first one of a process is news.
 * - **A handshake the control plane rejects outright** —
 *   {@link returnAfterFatalHandshake}. A protocol mismatch, a capability rejection or
 *   a refused credential is this build saying it cannot serve this control plane, and
 *   no restart changes that, so the return happens at once rather than waiting the
 *   counter out.
 *
 * **A return that itself fails leaves the machine down and loud** rather than
 * crash-looping quietly: the record stays, the reason is logged as an error naming
 * the install root and the step that failed, and the process ends non-zero. A later
 * start attempts the return again, which is the lesser of the two evils — clearing
 * the record instead would send the machine back into the build that could not start.
 *
 * Nothing is reported from here. The control plane learns which build a machine came
 * back on the way it learns every other one: from the `build` its next handshake
 * declares (issue #918).
 */

import { describeError } from '../lib/errors.js';
import { logger as defaultLogger } from '../lib/logger.js';
import {
	type CommandRunner,
	MAX_FAILED_STARTS,
	type PendingVerification,
	readPendingVerification,
	recordFailedStart,
	recordSuccessfulHandshake,
	returnToLastKnownGood,
} from '../worker/self-update.js';
import type { UpdateLogger } from './worker-update.js';

export interface BuildVerificationOptions {
	/** Defaults to the SWARM install root — see `../worker/self-update.ts` for why that anchor. */
	installRoot?: string;
	/** Injectable so tests never touch the real home directory. */
	homeDir?: string;
	/** The subprocess seam a return runs on; defaults to the production runner. */
	run?: CommandRunner;
	/** Defaults to {@link MAX_FAILED_STARTS}. */
	maxFailedStarts?: number;
	/**
	 * Released before the process ends — the daemon's own teardown, when it has one to
	 * run. There is none at startup, where nothing is held yet.
	 */
	shutdown?: () => Promise<void> | void;
	/** Ends the process once the install root has been returned; defaults to `process.exit`. */
	exit?: (code: number) => void;
	logger?: UpdateLogger;
}

/**
 * Count this process's start against a build that has not handshaked yet, and return
 * the install root to the last known good build once too many starts in a row have
 * failed.
 *
 * Resolves `true` when this daemon must not continue — it has ended the process — and
 * `false` on the ordinary path, which is every start on a machine with no update
 * awaiting proof.
 *
 * The counter is on disk before this resolves either way, so whatever the daemon does
 * next — including dying in the very next statement — has already been counted.
 */
export async function verifyStartupBuild(options: BuildVerificationOptions = {}): Promise<boolean> {
	const logger = options.logger ?? defaultLogger;
	const pending = recordFailedStart(options);
	if (!pending) return false;
	const maxFailedStarts = options.maxFailedStarts ?? MAX_FAILED_STARTS;
	// The counter is a fact about the install root and the budget is a fact about a
	// daemon, and on a shared install root those differ (issue #973): every peer that
	// adopted this build restarts into it once, and every one of those starts lands on
	// this same record. Each adopter recorded itself when it took its licence to
	// restart, so adding them back is what keeps this measuring one daemon failing
	// `maxFailedStarts` starts in a row rather than a machine's worth of peers coming
	// up healthily. On a machine with one daemon `adoptingPeers` is 0 and this is the
	// constant it always was.
	const budget = maxFailedStarts + pending.adoptingPeers;
	const meta = {
		commit: pending.commit,
		previousCommit: pending.previousCommit,
		failedStarts: pending.failedStarts,
		maxFailedStarts,
		adoptingPeers: pending.adoptingPeers,
		failedStartBudget: budget,
	};
	if (pending.failedStarts >= budget) {
		logger.error('giving up on the updated SWARM build — it never handshaked', meta);
		return performReturn(options, logger, pending);
	}
	if (pending.failedStarts === 1) {
		// The ordinary restart into a freshly applied build, about to prove itself in the
		// next few seconds — not something to alarm an operator with.
		logger.info('starting on a freshly applied SWARM build — it proves itself by connecting', meta);
	} else {
		logger.warn('starting again on a SWARM build that has still not connected once', meta);
	}
	return false;
}

/**
 * The `onSession` half: promote the build this process is running the first time it
 * establishes a session, and do nothing on every reconnect after that.
 */
export function createHandshakePromotion(options: BuildVerificationOptions = {}): () => void {
	let promoted = false;
	return () => {
		if (promoted) return;
		promoted = true;
		recordSuccessfulHandshake(options);
	};
}

/**
 * Return to the last known good build because the control plane rejected this one's
 * handshake outright — and there is a build awaiting proof for that to be about.
 *
 * Resolves `true` when this daemon is on its way out, `false` when the error is not
 * that kind of rejection or nothing was being verified, in which case the caller
 * handles it exactly as it did before.
 */
export async function returnAfterFatalHandshake(
	err: unknown,
	options: BuildVerificationOptions = {},
): Promise<boolean> {
	// Loaded on demand, not at the top of the file, so this module carries none of the
	// transport's own module graph: `./connect-entry.ts` imports it statically to count
	// a start before the daemon exists, and every module reachable from here is one
	// more place a bad build could throw at import time and bypass that counter. There
	// is no cost — this function is only ever reached from a live transport, so
	// `./worker-client.ts` is already evaluated and the import resolves from cache.
	const { isFatalHandshakeRejection } = await import('./worker-client.js');
	if (!isFatalHandshakeRejection(err)) return false;
	const pending = readPendingVerification(options);
	if (!pending) return false;
	const logger = options.logger ?? defaultLogger;
	logger.error('the control plane rejected the updated SWARM build outright', {
		commit: pending.commit,
		previousCommit: pending.previousCommit,
		error: describeError(err),
	});
	return performReturn(options, logger, pending);
}

/** The return both triggers share, and the exit code each outcome earns. */
async function performReturn(
	options: BuildVerificationOptions,
	logger: UpdateLogger,
	pending: PendingVerification,
): Promise<boolean> {
	const outcome = await returnToLastKnownGood(options);
	if (outcome.status === 'nothing-pending') {
		// Reachable when the record stopped naming this build between the read above and
		// the lock the return takes: an operator cleared it, or — on a shared install root
		// — a peer daemon landed a newer build of its own (issue #935). Either answer wins
		// over this one: carry on rather than rebuilding the machine out from under it.
		logger.warn('nothing left to return from — carrying on', { commit: pending.commit });
		return false;
	}
	if (outcome.status === 'failed') {
		logger.error('returning to the last known good SWARM build failed — this machine is down', {
			stage: outcome.stage,
			reason: outcome.reason,
			outputTail: outcome.outputTail,
		});
		await endProcess(options, logger, 1);
		return true;
	}
	logger.info('returned to the last known good SWARM build — restarting into it', {
		commit: outcome.commit,
		abandonedCommit: outcome.abandonedCommit,
	});
	await endProcess(options, logger, 0);
	return true;
}

/**
 * Release whatever the daemon is holding, then end the process. A failed release is
 * logged and exited through, exactly as `./worker-update.ts` does for a restart: the
 * session lease expires on its own TTL, where a daemon left running on code that is
 * no longer under it would not.
 */
async function endProcess(
	options: BuildVerificationOptions,
	logger: UpdateLogger,
	code: number,
): Promise<void> {
	try {
		await options.shutdown?.();
	} catch (err) {
		logger.error('releasing the worker session before returning to a build failed', {
			error: describeError(err),
		});
	}
	(options.exit ?? ((exitCode: number) => process.exit(exitCode)))(code);
}
