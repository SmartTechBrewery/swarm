/**
 * Is a held worktree lease *live*, or an orphan? (issue #427)
 *
 * The lease (`src/worktree/worktree-lease.ts`) is a bare Redis key with a 4h TTL
 * and an opaque token; it records *that* a checkout is claimed, never *who*
 * claimed it. So the provision-time collision gate (#367) could not tell a lease
 * a running phase depends on from one a crashed — or already-settled — run never
 * released, and treated both as `live-leased`. The orphan case then wedged every
 * later run for that task until the TTL expired, with no automatic recovery.
 *
 * This module answers the question the token cannot: does an owner for this
 * `(projectId, taskId)` still exist *in the database*? Liveness is derived there
 * rather than from the token because the token is not an id (`reuse()` writes the
 * literal `'1'`), so re-interpreting it would mark genuinely live resumed
 * checkouts as stale — exactly the regression the fix must not introduce.
 *
 * It fails CLOSED throughout: no identity for the asking run, or a database
 * error, reports "live", so the gate keeps #367's protection and never licenses
 * removing a checkout it is unsure about.
 */

import { hasExecutingDispatchForTask } from '../db/repositories/dispatchesRepository.js';
import { hasRunningRunForTask } from '../db/repositories/runsRepository.js';
import { logger } from '../lib/logger.js';

/** Injectable lookups for the liveness check; both default to the real repositories. */
export interface LeaseLivenessDeps {
	/** Whether another run for the task is `running`. */
	hasRunningRun?: (projectId: string, taskId: string, excludeRunId?: string) => Promise<boolean>;
	/** Whether another attempt for the task holds an executing (`leased`/`running`) dispatch. */
	hasExecutingDispatch?: (
		projectId: string,
		taskId: string,
		excludeRunId?: string,
	) => Promise<boolean>;
}

/**
 * Whether the task's worktree lease still has a live owner: another `running`
 * run, or another `leased`/`running` dispatch. `currentRunId` is excluded from
 * both — the asking attempt's run row is already `running` when it provisions, so
 * without excluding it every lease would look live (and a retry of a run that
 * crashed *holding* the lease reuses that same run id, which is precisely why its
 * own leftover lease must read as stale).
 *
 * Returns `true` (live — block) when `currentRunId` is absent or a lookup fails.
 */
export async function hasLiveWorktreeLeaseOwner(
	projectId: string,
	taskId: string,
	currentRunId: string | undefined,
	deps: LeaseLivenessDeps = {},
): Promise<boolean> {
	// Without our own identity we cannot exclude ourselves from the lookups, so
	// every answer would be "live" anyway. Keep #367's behaviour verbatim.
	if (!currentRunId) return true;

	const hasRunningRun = deps.hasRunningRun ?? hasRunningRunForTask;
	const hasExecutingDispatch = deps.hasExecutingDispatch ?? hasExecutingDispatchForTask;
	try {
		if (await hasRunningRun(projectId, taskId, currentRunId)) return true;
		return await hasExecutingDispatch(projectId, taskId, currentRunId);
	} catch (err) {
		logger.error('worktree lease liveness: lookup failed — failing closed (treating as live)', {
			projectId,
			taskId,
			currentRunId,
			error: String(err),
		});
		return true;
	}
}
