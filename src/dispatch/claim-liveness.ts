/**
 * "Is anything actually honouring this dispatch's claim?" — the judgement a
 * manual retry has to make before it refuses an operator (issue #1017), kept
 * beside the other shared policy judgements in this folder (`./dead-dispatch.ts`)
 * for the same reason: two callers must not drift apart about it.
 *
 * A dispatch in `leased`/`running` looks, from the row alone, exactly the same
 * whether a worker is mid-phase against it or a claim was abandoned when the
 * control plane and the daemon lost each other mid-hand-off. Until the
 * lease-expiry sweep (`failExpiredDispatchLeases`, on `./reconciler.ts`) reaches
 * it, both read as "active", and "Retry now" refused the second case with a
 * message asserting the opposite of the truth. Two facts distinguish them, and
 * neither is a new notion of staleness:
 *
 *  - **The lease.** A claim whose `leaseExpiresAt` has passed is one the
 *    reconciler is already entitled to reap; the only thing the operator gains by
 *    waiting is the sweep's cadence.
 *  - **The worker's silence.** The same heuristic issues #827 and #859 settled on
 *    — the retained session row's `lastHeartbeatAt` read as *last seen*, against
 *    the {@link offlineSilenceMs} grace. {@link isWorkerConfirmedSilent} is
 *    literally the predicate #827 wrote, moved here so this path and the
 *    offline-termination settle (`../router/dispatch-cancellation.ts`) share one
 *    definition.
 *
 * Everything else is treated as genuinely executing, which is the safe direction:
 * refusing a retry costs the operator a wait, while taking a live worker's claim
 * away runs the phase twice.
 */

import {
	type DispatchRow,
	EXECUTING_DISPATCH_STATES,
} from '../db/repositories/dispatchesRepository.js';
import {
	getLiveSessionForWorker,
	getRetainedSessionForWorker,
	resolveHeartbeatTtlMs,
} from '../identity/worker-session-service.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { offlineSilenceMs } from '../router/worker-liveness.js';

/**
 * Whether the worker has been silent long enough that nothing is going to report
 * this dispatch's result (issue #827, moved here by issue #1017).
 *
 * Deliberately *not* "has no live session": `releaseSession` runs on every
 * `/worker/stream` close (`../router/worker-transport.ts`), so
 * `getLiveSessionForWorker` answers `undefined` the instant a socket drops — for a
 * worker whose phase is still executing just as much as for a dead one. The
 * retained row is what distinguishes them: it survives release precisely so
 * `lastHeartbeatAt` can be read as *last seen* (`getRetainedSessionForWorker`), and
 * only a worker silent past {@link offlineSilenceMs} qualifies. A worker that never
 * handshook at all has no silence to measure and never qualifies either.
 *
 * This is a liveness heuristic, not proof the phase stopped — so callers re-run it
 * before anything is settled, and it fails *safe*: an unreadable row throws to the
 * caller, which leaves the decision to whatever backstop it already had.
 */
export async function isWorkerConfirmedSilent(
	workerId: string,
	now = new Date(),
): Promise<boolean> {
	const ttlMs = resolveHeartbeatTtlMs();
	if (await getLiveSessionForWorker(workerId, ttlMs)) return false;
	const retained = await getRetainedSessionForWorker(workerId);
	if (!retained) return false;
	return now.getTime() - retained.lastHeartbeatAt.getTime() >= offlineSilenceMs(ttlMs);
}

/**
 * What an *active* dispatch's claim means for an operator action that wants to
 * re-open it:
 *
 *  - `waiting` — nothing holds it (`pending`/`retry-scheduled`); it is queued.
 *  - `executing` — a worker holds an unexpired claim and is not silent, so the
 *    phase may genuinely be running there (or be one round trip from reporting).
 *  - `stale` — it holds a claim in `leased`/`running` that no live worker is
 *    honouring: the lease has lapsed, or the machine it is bound to has gone
 *    silent past the grace.
 */
export type DispatchClaimLiveness = 'waiting' | 'executing' | 'stale';

/** The columns {@link classifyDispatchClaim} reads — a whole row is never needed. */
export type DispatchClaim = Pick<DispatchRow, 'state' | 'leaseExpiresAt' | 'selectedWorkerId'>;

/**
 * Classify one **active** dispatch's claim. Terminal rows are not this function's
 * subject — callers reach it through `getActiveDispatchByRunId` — and would read
 * as `waiting`, which is why the caller, not this, decides they are unreachable.
 *
 * Order matters and is the cheap-first order as well as the correct one: a
 * non-executing state needs no reads at all, a lapsed lease is decided off the row,
 * and only a live-looking claim pays for the two session reads. A dispatch claimed
 * without a selected worker (the unfederated in-process path binds no session) has
 * no silence to measure, so the lease is the whole answer for it.
 *
 * Fails **closed**: a session read that throws reports `executing`, so an infra
 * hiccup costs the operator a wait rather than licensing a second run of a phase.
 */
export async function classifyDispatchClaim(
	dispatch: DispatchClaim,
	now = new Date(),
): Promise<DispatchClaimLiveness> {
	const executingStates: readonly string[] = EXECUTING_DISPATCH_STATES;
	if (!executingStates.includes(dispatch.state)) return 'waiting';
	if (!dispatch.leaseExpiresAt || dispatch.leaseExpiresAt.getTime() <= now.getTime()) {
		return 'stale';
	}
	if (!dispatch.selectedWorkerId) return 'executing';
	try {
		return (await isWorkerConfirmedSilent(dispatch.selectedWorkerId, now)) ? 'stale' : 'executing';
	} catch (error) {
		logger.warn('dispatch claim liveness: could not read the worker session — assuming executing', {
			workerId: dispatch.selectedWorkerId,
			error: describeError(error),
		});
		return 'executing';
	}
}
