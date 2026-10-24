/**
 * PM status-change deduplication, Redis-backed — mirrors
 * `review-dispatch-dedup.ts`'s pattern, for a gap that dedup opened up rather
 * than closed.
 *
 * `GitHubProjectsRouterAdapter.isStatusChange` accepts the `reordered` action
 * so a Kanban board's actual drag-and-drop (which fires `reordered`, not
 * `edited` — see that file's comment) reaches the pipeline. But `reordered`
 * also fires on a *pure* within-column reorder that carries no Status change
 * at all — GitHub's payload has no `changes.field_value` to filter on there,
 * so `pm-status.ts`'s `matches` gate can't rule that case out the way it can
 * for `edited`. Without this guard, every such reorder would re-dispatch
 * whatever phase the item's current Status already started — a duplicate
 * Claude Code run for an in-progress task, or a duplicate plan comment.
 *
 * Unlike `review-dispatch-dedup.ts`'s "claim once, ever" semantics (a PR+SHA is
 * immutable), this tracks the *last observed status* per item and reports a
 * change only when the freshly re-read status differs from it. The caller
 * records **every** status it observes — including ones that start no phase
 * (Backlog, In progress, In review, Done) — not just the phase-start ones it
 * dispatches on. That total record is what makes a genuine return to a status
 * dispatch again: leaving "ToDo" for "Backlog" and dragging back to "ToDo"
 * records `Backlog` in between, so the return reads as a real change. Only a
 * same-status no-op (a within-column reorder, or a duplicate webhook delivery)
 * reports "unchanged". "Observes" means a board event: a resumed dispatch
 * (`resumePmPhase` — a deferred retry, or a lost worker's adopted late result)
 * replays its phase's original event, so it records nothing and is not deduped
 * either. Recording the column its own phase has since moved the card to would
 * make SWARM's self-enqueued next phase read as "unchanged" (issue #1121).
 *
 * Recording *every* observed status — rather than only the phase-start statuses
 * actually dispatched — is deliberate, and fixes a class of silently-stuck
 * retries. Earlier this tracked only the last *dispatched* status, so any move
 * to a non-phase status was invisible here: an item dispatched to "ToDo", then
 * dragged to "Backlog" (or auto-moved to "In progress" as a pickup report) and
 * back to "ToDo", read as the *same* last-dispatched "ToDo" and got skipped —
 * the intended "move it out and back to retry" recovery never fired. Observing
 * the intermediate status closes that gap.
 *
 * The stored value still carries a TTL (mirroring `review-dispatch-dedup.ts`'s
 * `EX`) as a backstop for the one case the observed-status record can't cover:
 * an item that *never leaves* a phase-start status. Confirmed live, a failed
 * Implementation run (agy's `-p` argument-order bug — see
 * `src/harness/agent-cli.ts`) left an item sitting in "ToDo" with "ToDo"
 * already recorded, so re-dropping it on "ToDo" *without* moving it out first
 * looks identical to a within-column reorder. Without a TTL that would block
 * every retry of an in-place item forever; with it, the record lapses after a
 * quiet window and the next drop dispatches. It's generous on purpose — only
 * needs to outlast a burst of near-simultaneous `reordered` events from one
 * drag gesture (milliseconds) — but note it is refreshed on every observation,
 * so an item repeatedly re-dropped on the same status inside the window stays
 * deduped; move it out and back (the primary recovery path above) to retry
 * immediately.
 *
 * `SET key val EX ttl GET` (Redis 6.2+), not a `GET` followed by a separate
 * conditional `SET`: confirmed live, one drag-to-Planning gesture fires both a
 * `reordered` and an `edited` webhook event for the same item, landing as two
 * concurrent trigger evaluations that both re-read the same fresh status. A
 * plain `GET` then `SET` has a window between the two round trips where both
 * callers read the same stale "previous" value before either writes, so both
 * see a status change and both dispatch — two `provision()` calls racing for
 * one worktree (confirmed live: taskId 83's `planning` phase double-dispatched
 * this way and the second `git worktree add` failed with "already exists").
 * The atomic `GET` form sets the new value and returns the prior one in a
 * single round trip, so Redis itself serializes concurrent callers: whichever
 * one Redis processes second sees the *other's* just-written value as
 * "previous", not the stale one, so at most one of them ever sees a genuine
 * change.
 */

import { Redis } from 'ioredis';
import { requireEnv } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { parseRedisUrl } from '../lib/redis.js';

const KEY_NS = 'swarm:pm-status-dedup:';

/** Backstop window for an item that never leaves a phase-start status — see the module doc above for why this needs a TTL at all. */
const DEDUP_TTL_SEC = 5 * 60;

let redisInstance: Redis | null = null;

/**
 * Lazy singleton, same rationale and `maxRetriesPerRequest` override as
 * `review-dispatch-dedup.ts`'s `getRedis`: pays the connection cost only once
 * a dispatch decision is actually needed, and fails fast (rather than hanging)
 * when Redis is unreachable so the call site can fail closed promptly.
 */
function getRedis(): Redis {
	if (!redisInstance) {
		redisInstance = new Redis({
			...parseRedisUrl(requireEnv('REDIS_URL')),
			maxRetriesPerRequest: 1,
		});
		redisInstance.on('error', (err) => {
			logger.warn('pm-status dedup: Redis connection error', { error: String(err) });
		});
	}
	return redisInstance;
}

/**
 * Record `statusId` as the latest status observed for `itemNodeId` and report
 * whether it is a *change* from the last one observed. Returns `true` when the
 * status differs from the stored value — including the item's very first
 * observation (no stored value yet) — and `false` when it matches (a
 * within-column reorder, or a duplicate webhook delivery).
 *
 * Call this for **every** status a board event observes (a resumed dispatch
 * observes none — see the module doc), not only the phase-start ones the
 * caller dispatches on: recording the statuses in between (Backlog, In
 * progress, …) is exactly what lets a return to a phase-start status read as a
 * real change rather than a same-status no-op (see the module doc above). The
 * "does this status start a phase?" decision stays with the caller; this
 * function only answers "did the status change?".
 *
 * Fails closed on Redis errors, matching `review-dispatch-dedup.ts`'s posture:
 * reporting "no change" (so the caller skips a legitimate dispatch) is cheaper
 * than risking a duplicate one, and the board keeps generating webhook events
 * as the user keeps interacting with it, so a transient failure isn't a
 * permanently stuck item — the next event gets another chance once Redis
 * recovers.
 */
export async function recordStatusAndDetectChange(
	itemNodeId: string,
	statusId: string,
): Promise<boolean> {
	const key = `${KEY_NS}${itemNodeId}`;
	try {
		const previous = await getRedis().set(key, statusId, 'EX', DEDUP_TTL_SEC, 'GET');
		if (previous === statusId) {
			logger.debug('pm-status dedup: status unchanged since last observation, skipping', {
				itemNodeId,
				statusId,
			});
			return false;
		}
		return true;
	} catch (err) {
		logger.error('pm-status dedup: Redis call failed — failing closed', {
			itemNodeId,
			statusId,
			error: String(err),
		});
		return false;
	}
}
