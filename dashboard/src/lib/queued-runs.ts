/**
 * Pure display helpers for the Queued section (issue #238). They only derive
 * label text and a stable key from an already-fetched {@link QueuedRun}; the
 * server owns the ordering (dispatch priority + FIFO), so nothing here re-sorts.
 * Kept side-effect-free so they can be unit-tested in the node environment,
 * matching the other `dashboard/src/lib/*.test.ts` helpers.
 */

import type {
	QueuedPhaseHint,
	QueuedReviewGateSourceEvent,
	QueuedRun,
	QueuedWaitReason,
} from '@/types/runs.js';
import { formatPhase } from './format.js';
import { parseWorkItemRef, workItemLabel } from './work-item.js';

const PR_DRIVEN_PHASES = new Set([
	'review',
	'respond-to-review',
	'respond-to-ci',
	'resolve-conflicts',
	'merge-automation',
]);

/**
 * Human-readable label for a job's best-effort phase hint. `board` covers both
 * Planning and Implementation (only distinguished at authoritative dispatch), so
 * it reads as such rather than pretending to know which one. Any hint not listed
 * falls back to {@link formatPhase} so a newly-added server hint still renders.
 */
const QUEUED_PHASE_LABELS: Record<QueuedPhaseHint, string> = {
	board: 'Board (Planning/Impl)',
	planning: 'Planning',
	implementation: 'Implementation',
	review: 'Review',
	'respond-to-review': 'Respond to review',
	'respond-to-ci': 'Respond to CI',
	'resolve-conflicts': 'Resolve conflicts',
	'merge-automation': 'Merge automation',
	unknown: 'Unknown',
};

export function queuedPhaseLabel(hint: QueuedPhaseHint): string {
	return QUEUED_PHASE_LABELS[hint] ?? formatPhase(hint);
}

/**
 * Human-readable label for a dispatch's wait reason (issue #284) — why a
 * queued item isn't running yet. Any reason not listed falls back to the raw
 * value so a newly-added server reason still renders.
 */
const QUEUED_WAIT_REASON_LABELS: Record<QueuedWaitReason, string> = {
	'project-capacity': 'waiting for a free project slot',
	'rate-limit': 'retrying after a rate limit',
	'agent-capacity': 'retrying after provider capacity',
	timeout: 'retrying after a timeout',
	'worker-shutdown': 'retrying after a worker restart',
	delivery: 'retrying result delivery',
	'worktree-exists': 'retrying after a worktree collision',
	stalled: 'retrying after a stalled response',
	recheck: 'waiting for checks to settle',
	// The two halves of the dispatch gate's wait, deliberately worded so an operator
	// can tell them apart at a glance (issue #607): the first clears on its own once a
	// machine is free, the second only when a human acts (grant sharing consent,
	// approve an enrollment, permit the phase, enroll a worker that runs the CLI).
	'worker-eligibility': 'waiting for an available worker',
	'worker-authorization': 'waiting for a worker to be authorized',
	// Deliberately names the *machine* rather than "a worker": every other worker in
	// the project may be free and it changes nothing, because this dispatch continues
	// work preserved on one specific machine (issue #567).
	'preserved-worker': 'waiting for the machine holding its preserved work',
	// Names the *task*, not a worker or a slot: this phase is next in the task's own
	// sequence and shares its checkout, so nothing but the phase ahead of it settling
	// ends the wait (issue #759). "Earlier" rather than "current" because since issue
	// #761 that phase may be *queued* rather than running — an Implementation waiting
	// on a Planning dispatch that has not started yet.
	'task-in-flight': "waiting for the task's earlier phase to finish",
	// Names the *pull request*, not a checkout: the phases that contend for a PR's head
	// branch run in separate worktrees on purpose (issue #850), so "waiting for that
	// checkout to free" would describe something that is not happening.
	'pr-in-flight': 'waiting for another phase of its pull request to finish',
	'manual-retry': 'manual retry',
	recovered: 'recovered after a restart',
};

export function queuedWaitReasonLabel(reason: QueuedWaitReason): string {
	return QUEUED_WAIT_REASON_LABELS[reason] ?? reason;
}

/**
 * A work-item reference for one queued job:
 * - resolved board jobs use the same Issue/PR label as the persisted Runs list;
 * - PR-driven GitHub jobs use the same `PR #<n>` label as that list;
 * - unresolved jobs show an honest em dash instead of an opaque node id.
 */
export function queuedWorkItemLabel(item: QueuedRun): string {
	const workItemRef = parseWorkItemRef(item.workItemUrl);
	if (workItemRef) return workItemLabel(workItemRef);
	if ((item.type === 'scm' || item.type === 'merge-automation') && item.prNumber)
		return `PR #${item.prNumber}`;
	return '—';
}

export function queuedWorkItemTitle(item: QueuedRun): string | undefined {
	return item.workItemTitle || undefined;
}

export function queuedWorkItemUrl(item: QueuedRun): string | undefined {
	if (item.workItemUrl) return item.workItemUrl;
	if (
		(item.type === 'scm' || item.type === 'merge-automation') &&
		item.repo &&
		item.prNumber &&
		PR_DRIVEN_PHASES.has(item.phaseHint)
	) {
		return `https://github.com/${item.repo}/pull/${item.prNumber}`;
	}
	return undefined;
}

/** Stable React key for a queued row — the BullMQ job id is unique per pending job. */
export function queuedRunKey(item: QueuedRun): string {
	return item.jobId;
}

/** One source event folded into a grouped review-gate row, for diagnostics display. */
export interface QueuedReviewGateSourceEventDisplay {
	jobId: string;
	sourceEvent: QueuedReviewGateSourceEvent;
	sourceAction?: string;
	recheckAttempt?: number;
	/** The read-failure recheck budget's own counter (issue #742), shown beside `recheckAttempt`. */
	readFailureRecheckAttempt?: number;
}

/**
 * One row for the Queued table (issue #275): a plain queued job rendered
 * one-to-one, or several pending review-gate jobs for the same PR + head SHA
 * folded into one logical row. `representative` is always the *first* source
 * job in the supplied order — the same job {@link queuedRunKey} and the Put
 * back action key off, so grouping never changes which underlying job an
 * action targets.
 */
export interface QueuedDisplayRow {
	representative: QueuedRun;
	/** True once a second (or later) source event has joined this row's group. */
	isReviewGateGroup: boolean;
	/** One entry per source event folded into this row; empty when the job carries no review-gate metadata. */
	sourceEvents: QueuedReviewGateSourceEventDisplay[];
	/**
	 * Extra fresh board dispatches for the *same* card folded into this row beyond
	 * the representative (issue #366). 0 for any non-board or single-dispatch row.
	 * A single board-card interaction fans out into several dispatches — the two
	 * `projects_v2_item` webhooks a drag fires (`reordered` + `edited`) plus the
	 * synthetic Planning→Implementation self-enqueue — none of which share a
	 * delivery-id dedup key, so the queue would otherwise list the same card two
	 * or three times. The dispatches are harmless (each re-reads authoritative
	 * board state at claim time and the redundant ones no-op), so this collapses
	 * only the *display*, leaving the dispatch flow untouched.
	 */
	boardDuplicateCount: number;
}

/** Grouping identity for a review-gate job: same project, repo, PR, and head SHA never split across rows. */
function reviewGateGroupKey(item: QueuedRun): string | null {
	if (!item.reviewGate || !item.repo || !item.prNumber) return null;
	return [item.projectId, item.repo, item.prNumber, item.reviewGate.headSha].join(':');
}

/**
 * Grouping identity for a *fresh* board (PM status) dispatch: same project and
 * work-item node id fold into one row (issue #366). Only unresolved board
 * dispatches (`phaseHint === 'board'`) with no backing run are folded — a
 * dispatch that already resolved a phase (`planning`/`implementation`) or owns a
 * `runId` (a capacity-blocked continuation or a deferred/resuming run) is a
 * distinct, legitimate unit of work and always renders on its own row.
 */
function boardGroupKey(item: QueuedRun): string | null {
	if (item.type !== 'pm') return null;
	if (item.phaseHint !== 'board') return null;
	if (item.runId) return null;
	if (!item.workItemNodeId) return null;
	return [item.projectId, item.workItemNodeId].join(':');
}

function toSourceEventDisplay(item: QueuedRun): QueuedReviewGateSourceEventDisplay {
	// Only called once `item.reviewGate` has already been checked truthy.
	const gate = item.reviewGate as NonNullable<QueuedRun['reviewGate']>;
	return {
		jobId: item.jobId,
		sourceEvent: gate.sourceEvent,
		sourceAction: gate.sourceAction,
		recheckAttempt: gate.recheckAttempt,
		readFailureRecheckAttempt: gate.readFailureRecheckAttempt,
	};
}

/**
 * Turn the server's already-ordered `runs.queued` rows into display rows,
 * folding two kinds of duplicate into one logical row:
 *
 * - **Review-gate jobs** — raw `pull-request`/`checks` lifecycle events
 *   hinting `review` (see {@link QueuedRun.reviewGate}) that share the same
 *   project, repo, PR number, and head SHA.
 * - **Fresh board dispatches** — the several dispatches one board-card
 *   interaction fans out into for the same card (issue #366), keyed on project
 *   and work-item node id (see {@link boardGroupKey}).
 *
 * Every other job renders one row per job, exactly as before. A row's position
 * is the position of the first job that started its group, so this never
 * reorders the server's dispatch order; it only folds later duplicates into an
 * earlier row. The two group kinds are mutually exclusive (review-gate is an
 * `scm` job, board is a `pm` job), so a job joins at most one.
 */
export function groupQueuedRuns(items: QueuedRun[]): QueuedDisplayRow[] {
	const rowByGroupKey = new Map<string, QueuedDisplayRow>();
	const rows: QueuedDisplayRow[] = [];

	for (const item of items) {
		const reviewKey = reviewGateGroupKey(item);
		const boardKey = reviewKey ? null : boardGroupKey(item);
		const key = reviewKey ?? boardKey;
		const existingRow = key ? rowByGroupKey.get(key) : undefined;
		if (existingRow) {
			if (reviewKey) {
				existingRow.isReviewGateGroup = true;
				existingRow.sourceEvents.push(toSourceEventDisplay(item));
			} else {
				existingRow.boardDuplicateCount += 1;
			}
			continue;
		}

		const row: QueuedDisplayRow = {
			representative: item,
			isReviewGateGroup: false,
			sourceEvents: item.reviewGate ? [toSourceEventDisplay(item)] : [],
			boardDuplicateCount: 0,
		};
		rows.push(row);
		if (key) rowByGroupKey.set(key, row);
	}

	return rows;
}

/**
 * Guards mirroring {@link boardGroupKey} for a *fresh* board display row — a
 * `pm` dispatch still hinting `board` with no backing run — but
 * joined on the resolved backing work-item URL (the one field a `runs.queued`
 * row and a `runs.list` row share) instead of the opaque board node id.
 */
function isFreshBoardRowWithActiveRun(
	row: QueuedDisplayRow,
	activeWorkItemUrls: ReadonlySet<string>,
): boolean {
	const item = row.representative;
	if (item.type !== 'pm') return false;
	if (item.phaseHint !== 'board') return false;
	if (item.runId) return false;
	if (!item.workItemUrl) return false;
	return activeWorkItemUrls.has(item.workItemUrl);
}

/**
 * Hide a fresh board queued row whose card already has a Planning/Implementation
 * run *in progress* (issue #421) — the fan-out one step past #366/#387. One
 * board-card interaction enqueues several dispatches for the same card; when the
 * worker claims one it leaves the waiting set and becomes a run in the Runs
 * table, while its leftover sibling dispatches stay `pending` and linger here
 * until they no-op at claim time. {@link groupQueuedRuns} can only dedupe within
 * the queued list, so it can't see the running run (a claimed dispatch is no
 * longer in `runs.queued`). This joins the two read models by exact backing
 * work-item URL and drops the duplicate *display* row only — it never touches
 * the dispatch flow (the leftover siblings still no-op harmlessly at claim time).
 *
 * Only fresh board rows are eligible (same guards as {@link boardGroupKey}): a
 * row that owns a `runId` (its own deferred/continuation run), an unresolved row
 * (no URL to match on), and any non-board row are always kept.
 */
export function hideBoardRowsWithActiveRun(
	rows: QueuedDisplayRow[],
	activeWorkItemUrls: ReadonlySet<string>,
): QueuedDisplayRow[] {
	if (activeWorkItemUrls.size === 0) return rows;
	return rows.filter((row) => !isFreshBoardRowWithActiveRun(row, activeWorkItemUrls));
}

/**
 * The wording of the collapsed group holding the board dispatches the server
 * proved cannot start a phase (issue #570) — kept out of the queue itself, but
 * counted so a pile-up of them is never invisible.
 */
export function noTriggerGroupLabel(count: number): string {
	return count === 1
		? '1 board event that starts no phase'
		: `${count} board events that start no phase`;
}

/** Why a no-trigger row is listed apart from the queue rather than dropped. */
export const NO_TRIGGER_GROUP_EXPLANATION =
	'Recorded and queued as usual — each re-reads its card and settles as a no-trigger once a worker reaches it. Board changes SWARM itself makes (a card moved to In progress as a status report) and pure housekeeping (filing a card, reordering a column) land here.';

const REVIEW_GATE_SOURCE_LABELS: Record<QueuedReviewGateSourceEvent, string> = {
	'pull-request': 'Pull request',
	checks: 'Checks',
};

/**
 * Compact diagnostic label for one source event folded into a review-gate group.
 * The two recheck budgets (issue #742) are shown as separate counters rather
 * than one number: `recheck #N` is CI still settling, `provider retry #N` is a
 * source-control read that never answered being outlasted, and an operator
 * watching a row wait needs to know which of the two it is.
 */
export function reviewGateSourceEventLabel(event: QueuedReviewGateSourceEventDisplay): string {
	const base = REVIEW_GATE_SOURCE_LABELS[event.sourceEvent];
	const action = event.sourceAction ? ` · ${event.sourceAction}` : '';
	const recheck = event.recheckAttempt !== undefined ? ` · recheck #${event.recheckAttempt}` : '';
	const providerRetry =
		event.readFailureRecheckAttempt !== undefined
			? ` · provider retry #${event.readFailureRecheckAttempt}`
			: '';
	return `${base}${action}${recheck}${providerRetry}`;
}

/** The wording a grouped review-gate row uses instead of claiming a Review agent is queued. */
export const REVIEW_GATE_GROUP_LABEL = 'Awaiting review decision/checks';
