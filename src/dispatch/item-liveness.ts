/**
 * The item-liveness read model (issue #840) — the third read model beside Queue
 * (dispatch-centric) and Runs (run-centric), and the only one that answers
 * *"which work items have stopped progressing?"*.
 *
 * Pure and connection-free, exactly like `src/queue/queued-runs.ts`: the three
 * repositories own the DB-touching reads (`listTaskActivitySince`,
 * `listActiveDispatchTaskRefs`, `listStalledDismissals`) and everything here folds,
 * classifies, and orders already-loaded rows — so the semantics are unit-testable
 * without Postgres.
 *
 * **The classification is generic by construction.** In Postgres a work item that
 * has stopped moving looks like this: no `running` run, no non-terminal dispatch,
 * and nothing has touched it for hours. That is *also* exactly what a legitimately
 * waiting item looks like. The difference is whether some **recorded hand-off**
 * explains the silence — so `stalled` is the **default** and a unit steps back
 * from it only for a hand-off SWARM actually wrote on a row, or while it is still
 * inside {@link ITEM_STALL_AFTER_MS}. A stall from a cause nobody has seen yet
 * therefore falls straight through to `stalled`: nothing below enumerates a
 * failure mode, and adding one would be the wrong fix.
 *
 * **"Stalled" is a computed view, never a persisted status** (ai/ARCHITECTURE.md).
 * Nothing here writes; a unit stays listed until it actually moves, is dismissed by
 * an operator, or ages out of the caller's lookback window. Not to be confused with
 * the pre-existing `dispatches.wait_reason: 'stalled'`, which means one BullMQ
 * wake-up stalled and the dispatch is waiting to be re-run — a *non-terminal*
 * dispatch, so rule 1 below reads that unit as `active`.
 *
 * **An operator's dismissal is one of those recorded hand-offs** (issue #880), and
 * that is why it fits here rather than being filtered out afterwards: when SWARM
 * wrote nothing down because a human merged the pull request or closed the card,
 * the operator saying so *is* the record. It is still not a status on the unit —
 * `stalled_dismissals` is its own table, keyed on the unit and carrying the
 * `lastActivityAt` it was taken at, so the suppression is a **comparison** the view
 * re-derives on every read. A unit that moves again advances past that instant and
 * is reported normally, with nothing to un-set and no background job.
 *
 * The clock that comparison uses is *run activity*, and one edge follows from that
 * and is stated rather than fixed: a dismissed unit that gets a new dispatch which
 * is cancelled before producing any run leaves `lastActivityAt` unmoved and stays
 * dismissed. While that dispatch is non-terminal the unit is `active` anyway, and
 * any dispatch that actually runs advances `lastActivityAt` — so the gap is a
 * dispatch that starts and dies without a run, which this read model has no
 * activity row for by construction.
 */

import { z } from 'zod';
import type { ActiveDispatchTaskRef } from '../db/repositories/dispatchesRepository.js';
import type { TaskActivityRow } from '../db/repositories/runsRepository.js';

/**
 * How long a unit may be silent before its silence counts as a stall. The one
 * time-based rule, and deliberately the *last* one consulted: it is the grace
 * window for everything with real external latency — a check suite completing, a
 * board webhook echoing back, a self-enqueued hand-off being picked up.
 */
export const ITEM_STALL_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * How far back the candidate read looks. Bounds the cost of
 * `listTaskActivitySince` and stops years of finished history filling the view;
 * a unit silent for longer than this ages out rather than being reported forever.
 */
export const ITEM_ACTIVITY_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * What a liveness unit is, as an operator would recognise it:
 *
 * - `pull-request` — the four SCM-driven phases of one pull request, folded onto
 *   the PR itself.
 * - `work-item` — the two board-driven phases of one card.
 *
 * `runs.task_id` alone cannot be the unit: the trigger handlers mint a different
 * one per phase (`<pr>`, `<pr>-respond`, `<pr>-ci`, `<pr>-conflicts`), so grouping
 * on it would report a PR under review as stalled while its Respond-to-review run
 * — a *different* task id — is executing.
 */
export const ItemLivenessUnitKindSchema = z.enum(['pull-request', 'work-item']);
export type ItemLivenessUnitKind = z.infer<typeof ItemLivenessUnitKindSchema>;

/**
 * A unit's liveness. Every value but `stalled` names a hand-off SWARM recorded
 * (or a grace window still open); `stalled` is what is left when none applies.
 */
export const ItemLivenessStateSchema = z.enum([
	/** A live run, or a non-terminal dispatch — something is still due. */
	'active',
	/** Implementation opened a PR; the pull-request unit carries the work now. */
	'handed-off',
	/** Merge automation recorded `merged`. */
	'merged',
	/** SWARM recorded a hand-off to a person. */
	'awaiting-human',
	/** An operator declared this unit finished, and it has not moved since. */
	'dismissed',
	/** Silent, but not yet past {@link ITEM_STALL_AFTER_MS}. */
	'settling',
	'stalled',
]);
export type ItemLivenessState = z.infer<typeof ItemLivenessStateSchema>;

/**
 * One operator dismissal, as `listStalledDismissals` returns it (issue #880) — the
 * third input, playing the same role for the fold that {@link ActiveDispatchTaskRef}
 * plays: a per-unit fact loaded elsewhere and folded on here.
 *
 * `unit` is the enum rather than a bare string, so a row whose stored kind is not
 * one of the two fails at the boundary that parses it rather than silently matching
 * nothing.
 */
export interface ItemLivenessDismissal {
	projectId: string;
	repository: string;
	unit: ItemLivenessUnitKind;
	reference: string;
	/** The unit's own `lastActivityAt` at the instant it was dismissed. */
	lastActivityAt: Date;
}

/**
 * The two project policies the classification consults. Both mirror the
 * *effective* defaults the pipeline itself applies — `planning.autoAdvance`
 * defaults to `false` (`DEFAULT_AUTO_ADVANCE`, `src/pipeline/planning.ts`) and
 * `respondToReview.autoMerge` is opt-in (`!== true` skips it,
 * `src/worker/consumer.ts`) — so "unset" reads here exactly as the phase reads it.
 */
export interface ItemLivenessPolicy {
	/** `project.pipeline.planning.autoAdvance === true`. */
	planningAutoAdvance: boolean;
	/** `project.pipeline.respondToReview.autoMerge === true`. */
	autoMerge: boolean;
}

/** The `runs.stalled` API/UI contract — Zod is the source of truth for this shape. */
export const StalledItemSchema = z.object({
	projectId: z.string(),
	/** `owner/repo` — the run's own recorded repository (issue #683). */
	repository: z.string(),
	unit: ItemLivenessUnitKindSchema,
	/** The PR number for a `pull-request` unit, the task id for a `work-item` one. */
	reference: z.string(),
	/** The latest run's own `task_id` — what a worktree/branch is named for. */
	taskId: z.string(),
	/** The phase the unit stopped in. */
	phase: z.string(),
	runId: z.string(),
	runStatus: z.string(),
	prNumber: z.string().optional(),
	/**
	 * That pull request's **web** URL in the project's own source-control
	 * provider's grammar (`SCMProvider.pullRequestUrl`), resolved by the API layer
	 * (`src/api/routers/runs.ts`) — never assembled by a caller, which is how a
	 * GitLab or Bitbucket project's stalled row would otherwise be linked to
	 * `github.com`. Optional, and absent for exactly three reasons: the unit is a
	 * `work-item` (which links to its board card instead), the row carries no
	 * `prNumber`, or the project resolves no registered, runtime-ready provider —
	 * a view of stalled work must not fail over an unlinkable row.
	 */
	prUrl: z.string().optional(),
	prTitle: z.string().optional(),
	workItemId: z.string().optional(),
	workItemTitle: z.string().optional(),
	workItemUrl: z.string().optional(),
	/** ISO 8601 — when the unit last moved. */
	lastActivityAt: z.string(),
	stalledForMs: z.number().int().nonnegative(),
});
export type StalledItem = z.infer<typeof StalledItemSchema>;

/**
 * A folded liveness unit: the identity an operator recognises, plus the latest
 * run across every `task_id` that belongs to it and the aggregates of the rest.
 */
export interface ItemLivenessUnit {
	projectId: string;
	repository: string;
	unit: ItemLivenessUnitKind;
	reference: string;
	/** The latest run in the unit, by `lastActivityAt`. */
	latest: TaskActivityRow;
	lastActivityAt: Date;
	/** How many runs across the whole unit are still `running`. */
	liveRunCount: number;
	/** Whether a non-terminal dispatch resolved a task id belonging to this unit. */
	hasActiveDispatch: boolean;
	/**
	 * The activity instant an operator dismissed this unit at, or `null` when none
	 * did (issue #880). The unit is suppressed only while its own
	 * {@link ItemLivenessUnit.lastActivityAt} has not advanced past this.
	 */
	dismissedThrough: Date | null;
}

/** Task-id suffixes the trigger handlers derive from a PR number, longest first. */
const PR_TASK_ID_SUFFIXES = ['-conflicts', '-respond', '-ci'] as const;

/** Phases whose dispatch is always about a pull request. */
const PULL_REQUEST_PHASES = new Set([
	'review',
	'respond-to-review',
	'respond-to-ci',
	'resolve-conflicts',
	'merge-automation',
]);

/** Phases whose dispatch is always about a board card. */
const BOARD_PHASES = new Set(['planning', 'implementation']);

/** Not a byte a project id, repository slug, or task id can contain. */
const KEY_SEPARATOR = '\u0000';

/** `<pr>` for a suffixed PR task id, `null` for anything else. */
function stripPullRequestTaskSuffix(taskId: string): string | null {
	for (const suffix of PR_TASK_ID_SUFFIXES) {
		if (taskId.length > suffix.length && taskId.endsWith(suffix)) {
			return taskId.slice(0, -suffix.length);
		}
	}
	return null;
}

function unitKey(
	projectId: string,
	repository: string,
	unit: ItemLivenessUnitKind,
	reference: string,
): string {
	return [projectId, repository, unit, reference].join(KEY_SEPARATOR);
}

/**
 * The repository-blind key an active dispatch is matched on. A `dispatches` row
 * records no repository (`src/db/schema/dispatches.ts`), so the match is by
 * `(project, unit, reference)` alone: in a project spanning several repositories
 * a dispatch for one repo's PR #42 also suppresses a stall report for another's.
 * That is conservative in the safe direction — an active dispatch can only ever
 * *remove* a unit from the report, never invent one.
 */
function dispatchKey(projectId: string, unit: ItemLivenessUnitKind, reference: string): string {
	return [projectId, unit, reference].join(KEY_SEPARATOR);
}

/**
 * The unit one run's activity row belongs to. `pr_number` is authoritative — the
 * dispatcher writes it for every PR-driven phase (`tryCreateRun`) — and the task
 * id's own suffix is the fallback, so a PR-phase row that somehow recorded no PR
 * number still folds onto its pull request rather than splitting off as a card of
 * its own.
 */
export function livenessUnitForRun(row: TaskActivityRow): {
	unit: ItemLivenessUnitKind;
	reference: string;
} {
	if (row.prNumber) return { unit: 'pull-request', reference: row.prNumber };
	const stripped = stripPullRequestTaskSuffix(row.taskId);
	if (stripped) return { unit: 'pull-request', reference: stripped };
	return { unit: 'work-item', reference: row.taskId };
}

/** The grouping key of one run's activity row — `(project, repository, unit)`. */
export function livenessUnitKeyForRun(row: TaskActivityRow): string {
	const { unit, reference } = livenessUnitForRun(row);
	return unitKey(row.projectId, row.repository, unit, reference);
}

/**
 * The {@link dispatchKey}s a non-terminal dispatch could belong to. Folding a
 * dispatch needs no URL parsing and no payload shape: the suffixes are string
 * derivations of the PR number, so `-ci`/`-respond`/`-conflicts` strip back to the
 * pull request, and `dispatch.phase` (written together with `dispatch.taskId` when
 * a claim resolves the trigger) disambiguates a bare `<n>`.
 *
 * A dispatch whose `phase` is still null maps to **both** candidate keys —
 * conservative in the same safe direction as {@link dispatchKey}: it can only
 * suppress a stall report, never invent one.
 */
export function livenessUnitKeysForDispatch(ref: ActiveDispatchTaskRef): string[] {
	const stripped = stripPullRequestTaskSuffix(ref.taskId);
	if (stripped) return [dispatchKey(ref.projectId, 'pull-request', stripped)];
	if (ref.phase !== null && BOARD_PHASES.has(ref.phase)) {
		return [dispatchKey(ref.projectId, 'work-item', ref.taskId)];
	}
	if (ref.phase !== null && PULL_REQUEST_PHASES.has(ref.phase)) {
		return [dispatchKey(ref.projectId, 'pull-request', ref.taskId)];
	}
	return [
		dispatchKey(ref.projectId, 'pull-request', ref.taskId),
		dispatchKey(ref.projectId, 'work-item', ref.taskId),
	];
}

/**
 * Classify one folded unit. The first rule that matches wins, and every rule but
 * the last names a hand-off *recorded on a row* — never a failure mode. Read the
 * list that way: it is not an enumeration of the ways work can break, and it must
 * not become one.
 *
 * 1. `liveRunCount > 0` or an active dispatch → `active`. This covers three of the
 *    four kinds of legitimate waiting for free, because all three are non-terminal
 *    dispatch rows: a capacity-blocked dispatch (`wait_reason: 'project-capacity'`),
 *    a dependency-gated one (`'task-in-flight'`/`'recheck'`), and a bounded retry
 *    still inside its budget (`state: 'retry-scheduled'`).
 * 2. An operator's dismissal the unit has not moved past → `dismissed` (issue #880).
 *    After `active` on purpose: a unit with a live run or a non-terminal dispatch is
 *    genuinely active whatever an operator said earlier. Before the recorded
 *    hand-offs, because an operator's explicit statement is the strongest record
 *    there is. The comparison is `<=`, not `<`: the record stores the instant the
 *    operator saw, so equality is "it has not moved since".
 * 3. A `completed` Implementation carrying `produced_pr_url` → `handed-off`. That
 *    URL is the durable record that Implementation created the artifact CI and
 *    Review continue from, so the fourth kind — *waiting on CI* — is a recorded
 *    hand-off rather than a timer guess. (Rule 8 absorbs an ordinary check-suite
 *    wait on the pull-request unit itself.)
 * 4. `review_merge_outcome = 'merged'` → `merged`.
 * 5. `review_automation_outcome = 'manual-intervention-required'` → the review-cap
 *    stop (issues #235/#328): SWARM's own design stops here and asks for a person.
 * 6. A `completed` Planning run on a project that does not auto-advance → the plan
 *    is waiting for a greenlight (ai/ARCHITECTURE.md "Pipeline phases").
 * 7. A `completed` Review whose verdict was `approve`, where the merge either
 *    recorded an outcome or was never automated. It deliberately does **not** rest
 *    an approval with a *null* `review_merge_outcome` while auto-merge is on: that
 *    is a merge dispatch that should have written an outcome and did not — a stall,
 *    and exactly the shape of the incidents this read model exists for.
 * 8. Still inside {@link ITEM_STALL_AFTER_MS} → `settling`.
 * 9. Otherwise → `stalled`.
 */
export function classifyItemLiveness(
	unit: ItemLivenessUnit,
	policy: ItemLivenessPolicy,
	now: Date,
): ItemLivenessState {
	if (unit.liveRunCount > 0 || unit.hasActiveDispatch) return 'active';

	if (unit.dismissedThrough && unit.lastActivityAt.getTime() <= unit.dismissedThrough.getTime()) {
		return 'dismissed';
	}

	const latest = unit.latest;
	const completed = latest.status === 'completed';
	if (completed && latest.phase === 'implementation' && latest.producedPrUrl) return 'handed-off';
	if (latest.reviewMergeOutcome === 'merged') return 'merged';
	if (latest.reviewAutomationOutcome === 'manual-intervention-required') return 'awaiting-human';
	if (completed && latest.phase === 'planning' && !policy.planningAutoAdvance) {
		return 'awaiting-human';
	}
	if (
		completed &&
		latest.phase === 'review' &&
		latest.reviewVerdict === 'approve' &&
		(latest.reviewMergeOutcome !== null || !policy.autoMerge)
	) {
		return 'awaiting-human';
	}

	if (now.getTime() - unit.lastActivityAt.getTime() < ITEM_STALL_AFTER_MS) return 'settling';
	return 'stalled';
}

/**
 * Fold the per-`task_id` activity rows onto liveness units: a pull-request unit
 * takes the latest run across its up-to-four task ids and sums their live-run
 * counts, and a board card takes its own.
 */
export function foldLivenessUnits(
	activity: readonly TaskActivityRow[],
	activeDispatches: readonly ActiveDispatchTaskRef[],
	dismissals: readonly ItemLivenessDismissal[],
): ItemLivenessUnit[] {
	const activeKeys = new Set<string>();
	for (const ref of activeDispatches) {
		for (const key of livenessUnitKeysForDispatch(ref)) activeKeys.add(key);
	}

	// Indexed on the **full** unit key, deliberately *not* the repository-blind
	// {@link dispatchKey}: a dismissal is an explicit operator statement about one
	// row, so it must not leak across the repositories of a multi-repo project the
	// way a conservative dispatch match is allowed to. Where two dismissals somehow
	// name the same unit, the later instant wins — the unique index makes that
	// unreachable from the repository, and taking the max keeps the fold total.
	const dismissedThrough = new Map<string, Date>();
	for (const dismissal of dismissals) {
		const key = unitKey(
			dismissal.projectId,
			dismissal.repository,
			dismissal.unit,
			dismissal.reference,
		);
		const existing = dismissedThrough.get(key);
		if (!existing || dismissal.lastActivityAt.getTime() > existing.getTime()) {
			dismissedThrough.set(key, dismissal.lastActivityAt);
		}
	}

	const units = new Map<string, ItemLivenessUnit>();
	for (const row of activity) {
		const { unit, reference } = livenessUnitForRun(row);
		const key = unitKey(row.projectId, row.repository, unit, reference);
		const existing = units.get(key);
		if (!existing) {
			units.set(key, {
				projectId: row.projectId,
				repository: row.repository,
				unit,
				reference,
				latest: row,
				lastActivityAt: row.lastActivityAt,
				liveRunCount: row.liveRunCount,
				hasActiveDispatch: activeKeys.has(dispatchKey(row.projectId, unit, reference)),
				dismissedThrough: dismissedThrough.get(key) ?? null,
			});
			continue;
		}
		existing.liveRunCount += row.liveRunCount;
		if (row.lastActivityAt.getTime() > existing.lastActivityAt.getTime()) {
			existing.latest = row;
			existing.lastActivityAt = row.lastActivityAt;
		}
	}
	return [...units.values()];
}

function toStalledItem(unit: ItemLivenessUnit, now: Date): StalledItem {
	const latest = unit.latest;
	return StalledItemSchema.parse({
		projectId: unit.projectId,
		repository: unit.repository,
		unit: unit.unit,
		reference: unit.reference,
		taskId: latest.taskId,
		phase: latest.phase,
		runId: latest.runId,
		runStatus: latest.status,
		...(latest.prNumber ? { prNumber: latest.prNumber } : {}),
		...(latest.prTitle ? { prTitle: latest.prTitle } : {}),
		...(latest.workItemId ? { workItemId: latest.workItemId } : {}),
		...(latest.workItemTitle ? { workItemTitle: latest.workItemTitle } : {}),
		...(latest.workItemUrl ? { workItemUrl: latest.workItemUrl } : {}),
		lastActivityAt: unit.lastActivityAt.toISOString(),
		stalledForMs: Math.max(0, now.getTime() - unit.lastActivityAt.getTime()),
	});
}

/**
 * The read model's entry point: fold the three bounded reads onto liveness units,
 * classify each one, and report only the `stalled` ones — longest-silent first,
 * so the operator's first row is the item that has been stuck longest.
 *
 * `dismissals` is required rather than defaulted, on both this and
 * {@link foldLivenessUnits}: a forgotten call site must be a compile error, not a
 * silently unsuppressed view. It sits ahead of the defaulted `now` because both
 * production call sites rely on that default.
 *
 * `policies` is keyed by project id; a project missing from it falls back to the
 * pipeline's own defaults (neither auto-advance nor auto-merge), which is what an
 * unconfigured project actually does.
 */
export function toStalledItems(
	activity: readonly TaskActivityRow[],
	activeDispatches: readonly ActiveDispatchTaskRef[],
	policies: Readonly<Record<string, ItemLivenessPolicy>>,
	dismissals: readonly ItemLivenessDismissal[],
	now: Date = new Date(),
): StalledItem[] {
	const stalled: StalledItem[] = [];
	for (const unit of foldLivenessUnits(activity, activeDispatches, dismissals)) {
		const policy = policies[unit.projectId] ?? {
			planningAutoAdvance: false,
			autoMerge: false,
		};
		if (classifyItemLiveness(unit, policy, now) !== 'stalled') continue;
		stalled.push(toStalledItem(unit, now));
	}
	return stalled.sort((a, b) => b.stalledForMs - a.stalledForMs);
}
