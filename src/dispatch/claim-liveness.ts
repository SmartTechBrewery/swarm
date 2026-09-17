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
 * message asserting the opposite of the truth. **The lease is what distinguishes
 * them**: a claim whose `leaseExpiresAt` has passed is one the reconciler is
 * already entitled to reap, so taking it over here adds no execution the sweep
 * was not about to license anyway — the only thing the operator gains by waiting
 * is the sweep's 5-minute cadence.
 *
 * **Transport silence is deliberately not the other half** (PR #1021 review, F1).
 * The retained session's `lastHeartbeatAt` answers "has this worker been quiet
 * past `offlineSilenceMs`?", which issue #827's termination settle and issue
 * #859's orphan reap both act on — but neither of them *re-dispatches* the phase,
 * and that is the whole difference. A phase runs independently of the heartbeat
 * loop and routinely outlives the session it was pushed on (issue #718,
 * `../transport/worker-client.ts`): a daemon partitioned from the control plane
 * keeps its agent running, keeps mutating the task worktree, and holds its
 * terminal result for the next session. Re-opening its unexpired claim on the
 * strength of that silence would run one pipeline phase twice, concurrently —
 * duplicate commits, pushes and reviews — for nothing worse than a network blip
 * that outlasted two minutes. Silence is a heuristic about the *transport*; only
 * the lease bounds the *execution*, so only the lease may license a take-over.
 *
 * Everything not provably reapable is therefore treated as genuinely executing,
 * which is the safe direction: refusing a retry costs the operator a wait, while
 * taking a live worker's claim away runs the phase twice.
 */

import {
	type DispatchRow,
	EXECUTING_DISPATCH_STATES,
} from '../db/repositories/dispatchesRepository.js';

/**
 * What an *active* dispatch's claim means for an operator action that wants to
 * re-open it:
 *
 *  - `waiting` — nothing holds it (`pending`/`retry-scheduled`); it is queued.
 *  - `executing` — a worker holds an unexpired claim, so the phase may genuinely
 *    be running there (or be one round trip from reporting).
 *  - `stale` — it holds a claim in `leased`/`running` whose lease has lapsed: the
 *    lease-expiry sweep's own verdict, reached without waiting for its cadence.
 */
export type DispatchClaimLiveness = 'waiting' | 'executing' | 'stale';

/** The columns {@link classifyDispatchClaim} reads — a whole row is never needed. */
export type DispatchClaim = Pick<DispatchRow, 'state' | 'leaseExpiresAt'>;

/**
 * Classify one **active** dispatch's claim. Terminal rows are not this function's
 * subject — callers reach it through `getActiveDispatchByRunId` — and would read
 * as `waiting`, which is why the caller, not this, decides they are unreachable.
 *
 * A claim carrying no lease at all reads `stale` for the same reason a lapsed one
 * does: nothing bounds it, so nothing would ever reap it. `claimDispatch` always
 * writes a lease, so this is a belt-and-braces leg rather than a shape seen live.
 */
export function classifyDispatchClaim(
	dispatch: DispatchClaim,
	now = new Date(),
): DispatchClaimLiveness {
	const executingStates: readonly string[] = EXECUTING_DISPATCH_STATES;
	if (!executingStates.includes(dispatch.state)) return 'waiting';
	if (!dispatch.leaseExpiresAt || dispatch.leaseExpiresAt.getTime() <= now.getTime()) {
		return 'stale';
	}
	return 'executing';
}
