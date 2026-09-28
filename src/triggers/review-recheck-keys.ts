/**
 * The coalesce keys the `pr-review` trigger (`handlers/review.ts`) schedules its
 * own rechecks under — one module so the handler that writes them and the readers
 * that look them up can never drift apart.
 *
 * A recheck is deliberately not linked to any run by dispatch (issue #1049: a
 * dispatch owning the run would collide with any other attempt re-adopting it on
 * `uq_dispatches_active_run`), so a run a retry left `deferred` on one is found by
 * the only thing the two share — this key, rebuilt from the run's own stored event
 * ({@link reviewRecheckCoalesceKeys}).
 */

import type { ScmEvent, ScmEventKind } from '../scm/events.js';

/** The aggregate-check recheck for one pull request head. */
export function checkRecheckCoalesceKey(repo: string, prNumber: string, headSha: string): string {
	return `check-suite:${repo}:${prNumber}:${headSha}`;
}

/**
 * The mergeability recheck for one pull request head. Keyed on the event kind as
 * well: a PR-updated event intentionally never dispatches Review while a completed
 * checks event can, so a later PR-updated delivery must not replace the follow-up
 * Review's dispatch-capable recheck.
 */
export function mergeabilityRecheckCoalesceKey(
	repo: string,
	prNumber: string,
	headSha: string,
	eventKind: ScmEventKind,
): string {
	return `review-mergeability:${repo}:${prNumber}:${headSha}:${eventKind}`;
}

/**
 * Every recheck key the `pr-review` trigger could have scheduled while evaluating
 * `event` for `prNumber` in `repo` — empty when the event carries no head, which
 * the handler never schedules a recheck for.
 */
export function reviewRecheckCoalesceKeys(
	repo: string,
	prNumber: string,
	event: Pick<ScmEvent, 'kind' | 'headSha'>,
): string[] {
	if (!event.headSha) return [];
	return [
		checkRecheckCoalesceKey(repo, prNumber, event.headSha),
		mergeabilityRecheckCoalesceKey(repo, prNumber, event.headSha, event.kind),
	];
}
