/**
 * Whether a deferred run is backed by a dispatch that does not name it (issue
 * #1049): a retried Review — or Respond-to-CI — whose trigger deferred to its own
 * coalesced recheck. That recheck carries no `runId` by design and re-adopts the
 * run once it dispatches, so it is found by the coalesce key the handler
 * scheduled it under, rebuilt from the run's own stored event.
 *
 * One module so the run detail's "is this deferred run backed?" read
 * (`../api/routers/runs.ts`) and the reconciler's orphan backfill
 * (`./reconciler.ts`, issue #1210) answer the question identically.
 */

import { hasActiveDispatchForCoalesceKeys } from '../db/repositories/dispatchesRepository.js';
import type { RunRow } from '../db/repositories/runsRepository.js';
import { reviewRecheckCoalesceKeys } from '../triggers/review-recheck-keys.js';

/**
 * Whether a `pr-review` recheck for this run's own pull request head is still
 * active — the unlinked dispatch a retried Review or Respond-to-CI run waits on
 * (issue #1049). Only those two phases are ever left waiting on one, and only
 * with an SCM event naming the head.
 */
export async function awaitsReviewRecheck(
	run: Pick<RunRow, 'phase' | 'repository' | 'prNumber' | 'jobPayload'>,
): Promise<boolean> {
	if (run.phase !== 'review' && run.phase !== 'respond-to-ci') return false;
	const payload = run.jobPayload;
	if (!run.repository || !run.prNumber || payload?.type !== 'scm') return false;
	return hasActiveDispatchForCoalesceKeys(
		reviewRecheckCoalesceKeys(run.repository, run.prNumber, payload.event),
	);
}
