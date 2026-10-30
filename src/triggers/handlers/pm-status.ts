/**
 * PM board status-change trigger — SWARM's `pm:status-changed` equivalent
 * (ai/ARCHITECTURE.md "PM: GitHub Projects"), the analogue of Cascade's
 * per-list Trello/Linear status triggers. It's what starts the two PM-driven
 * pipeline phases: a card entering **Planning** starts Planning, a card
 * entering **In progress** starts Implementation (`src/pm/pipeline.ts`).
 *
 * Cascade ships a separate handler per board list because its webhook payload
 * carries the destination list, so each handler matches its own list directly.
 * SWARM can't: `docs/github-projects-v2-api.md` §5 warns the `projects_v2_item`
 * body doesn't carry a reliable new Status value, so the authoritative status
 * comes from a board re-read. Rather than register two handlers that each
 * re-read the same card (two GraphQL round-trips per event, one of them always
 * a wasted "not my phase" miss), this is **one** handler that re-reads once,
 * resolves which phase — if any — the card's Status starts, and dispatches it.
 *
 * Provider-agnostic throughout (issue #297): the board read goes through the
 * `PMProvider` the worker injected on the context (`ctx.pm`), the "is this worth
 * waking the pipeline for?" question goes to the project's `PMRouterAdapter`, and
 * the phase is resolved from the item's canonical `statusKey` — never from a board
 * option id (ai/RULES.md §2).
 *
 * A card re-read in the canonical `done` status starts no phase, but it does wake
 * the project's dependency waits (issue #1173): a blocker finishing — moved by a
 * human, by GitHub Projects' "item closed → Done" workflow, or closed on Jira or
 * Linear — is how a dependent learns it may start before its re-check timer.
 *
 * A card that enters a phase-starting column but names no task for this run's
 * repository is skipped, and since issue #1231 the skip is surfaced on the card
 * itself as a one-off SWARM notice rather than only in the router log
 * ({@link surfaceUnresolvableCard}).
 *
 * Loop prevention (a persona's own board moves must not re-fire the trigger)
 * already happened router-side (`PMRouterAdapter.isSelfAuthored`), so it isn't
 * repeated here. That covers the notice too: a comment is not a status change
 * (`PMRouterAdapter.isStatusChange`), and it carries the SWARM footer and marker,
 * so it can never re-enter this handler.
 */

import type { ProjectConfig } from '../../config/schema.js';
import { retireSupersededBoardPhases } from '../../dispatch/board-phase-retirement.js';
import { promoteDependencyWaits } from '../../dispatch/dispatcher.js';
import { releaseTicketSlot } from '../../dispatch/wip-limit.js';
import { requireProjectPMAdapter } from '../../integrations/pm/registry.js';
import { logger } from '../../lib/logger.js';
import { hasPlannedLabel, PLANNED_LABEL } from '../../pipeline/preplan.js';
import {
	isPhaseReportedStatusKey,
	type PipelinePhase,
	resolvePipelinePhaseForStatusKey,
} from '../../pm/pipeline.js';
import type { WorkItem } from '../../pm/types.js';
import { repoSlugsMatch } from '../../scm/repo-slug.js';
import { SWARM_GENERATED_FOOTER, swarmMarker } from '../../scm/swarm-origin.js';
import { recordStatusAndDetectChange } from '../pm-status-dedup.js';
import type { PmTriggerContext, TriggerContext, TriggerHandler, TriggerResult } from '../types.js';

/**
 * The whole Planning gate (issue #737): a card entering Planning starts a Planning
 * run **unless it already carries `planned`**. To re-plan, an operator removes the
 * label and moves the card Backlog → Planning.
 *
 * One rule, on a label that was already being written and never read. It replaces a
 * gate keyed on the preplan contract embedded in a split child's description
 * (`src/pipeline/preplan.ts`) plus a `swarm:split-child` label, an operator override
 * label (`swarm:replan`) that invalidated the contract, and a `preplan-invalidated`
 * trigger that existed to observe those label/body edits in place — the last of
 * which never fired at all, since such edits arrive on the `issues` webhook event
 * the repository does not subscribe to.
 *
 * The contract did not go away, it stopped being a gate: a dispatched run still
 * reuses a split child's embedded plan instead of spending an agent
 * (`evaluatePreplan`, consumed by `runPlanningPhase`). What that costs here is
 * nothing, because a prepared child is labelled `planned` *before* the split moves
 * it to Planning, so this gate stops the dispatch first.
 *
 * A deferred phase resuming from its original event (`resumePmPhase`) is exempt: it
 * has already been dispatched once and is retrying, and by then its own run may well
 * have applied the label.
 */
function isAlreadyPlanned(
	phase: string | null,
	workItem: WorkItem,
	resumePmPhase?: string,
): boolean {
	if (phase !== 'planning' || resumePmPhase) return false;
	if (!hasPlannedLabel(workItem)) return false;
	logger.info('pm-status: item already carries the planned label — skipping planning dispatch', {
		itemId: workItem.id,
		label: PLANNED_LABEL,
	});
	return true;
}

/**
 * The pipeline phase a re-read item's status starts, or `undefined` for a status
 * that starts none. The provider already translated its opaque native status into
 * the canonical pipeline key on the way out of the board read, so this stays a
 * key→phase lookup and never touches a board option id (ai/RULES.md §2). An item
 * whose status maps to no canonical key carries none, which is the same
 * "not applicable" answer.
 */
function resolvePhaseForItem(workItem: WorkItem): PipelinePhase | undefined {
	return workItem.statusKey ? resolvePipelinePhaseForStatusKey(workItem.statusKey) : undefined;
}

/**
 * The worktree task id this card names, or `undefined` when it names none *for
 * this run's repository*.
 *
 * The provider resolved the card's SCM artifact from its own linkage — both
 * halves of it: the number (`WorkItem.taskRef`) and the repository that numbers
 * it (`WorkItem.taskRepository`). Shared code never regexes a GitHub-shaped URL
 * for either (ai/RULES.md §2, ai/ARCHITECTURE.md "Task identity").
 *
 * Deciding whether that repository is the one *this run* is for is this handler's
 * job, not the provider's: a provider is built from a config scoped to one
 * repository and so carries no list of the project's repositories (issue #710),
 * while `project` is already scoped to the repository the job routed to (issue
 * #686 phase 2). Compared through `repoSlugsMatch` rather than `===`, so a config
 * entry's casing or a `.git` suffix cannot refuse a card that ingress routed on
 * the same terms (issue #688).
 *
 * Logs nothing: it is resolved before the phase gate (issue #909, so the
 * retirement below can key on it even for a column that starts no phase), and the
 * operator-facing warning belongs on the dispatch path alone — otherwise a
 * Backlog or Done move of a draft card would start warning.
 */
function resolveTaskIdForItem(workItem: WorkItem, project: ProjectConfig): string | undefined {
	const artifactRepository = workItem.taskRepository;
	return artifactRepository && repoSlugsMatch(artifactRepository, project.repo)
		? workItem.taskRef
		: undefined;
}

/** The inputs one unresolvable-card notice is written from, and keyed on. */
export interface UnresolvableCardNotice {
	phase: PipelinePhase;
	/** The run's own scoped project repository. */
	repository: string;
	/**
	 * The repository the card's linked artifact is in, when that is *not*
	 * `repository`; absent when the card names no artifact at all.
	 */
	artifactRepository?: string;
}

const PHASE_NAMES: Readonly<Record<PipelinePhase, string>> = {
	planning: 'Planning',
	implementation: 'Implementation',
};

/**
 * The idempotency marker of an unresolvable-card notice (issue #1231): one notice
 * per phase, run repository, reason and foreign artifact repository, so dragging
 * the card back and forth does not repost it while a different problem — another
 * phase, or a card re-linked into yet another repository — still gets its own.
 */
export function unresolvableCardMarker(notice: UnresolvableCardNotice): string {
	const reason = notice.artifactRepository
		? `other-repository:${notice.artifactRepository}`
		: 'no-task';
	return swarmMarker('unresolvable-card', `${notice.phase}:${notice.repository}:${reason}`);
}

/**
 * The notice posted on a card that entered a phase-starting column but names no
 * task this run can key a worktree on (issue #1231). It says which phase could
 * not start, why, and what to do — worded provider-neutrally, since the card may
 * be on any board and its artifact on any source-control provider.
 */
export function unresolvableCardCommentBody(notice: UnresolvableCardNotice): string {
	const { repository, artifactRepository } = notice;
	const phase = PHASE_NAMES[notice.phase];
	const reason = artifactRepository
		? `its linked source-control artifact is in \`${artifactRepository}\`, not this project repository \`${repository}\`.`
		: 'it names no task SWARM can run: it has no linked source-control artifact, and the board provider offers none of its own.';
	const fix = artifactRepository
		? `Link the card to an issue in \`${repository}\` instead — or, if the work belongs in \`${artifactRepository}\`, make that the project's repository (for example after a rename) — then move the card out of this column and back in.`
		: `Link the card to an issue in \`${repository}\`, then move the card out of this column and back in.`;
	return [
		`### SWARM could not start ${phase}`,
		'',
		`This card entered a column that starts the **${phase}** phase, but ${reason}`,
		'',
		`**Nothing was started.** ${fix}`,
		'',
		'---',
		SWARM_GENERATED_FOOTER,
		unresolvableCardMarker(notice),
	].join('\n');
}

/**
 * Post {@link unresolvableCardCommentBody} on the card (issue #1231), so an
 * operator who moved it sees why nothing happened instead of a card that silently
 * does nothing. Idempotent on {@link unresolvableCardMarker}, following
 * `surfaceProseAdvisory` (`src/pipeline/dependency-guard.ts`).
 *
 * Only for a genuine move: a resumed phase replays its original event and records
 * no status change, so it posts nothing.
 *
 * Best-effort: any provider failure is logged and swallowed, so the skip stays a
 * skip. A GitHub Projects draft card has no backing issue to comment on, so its
 * `addComment` throws and that case stays log-only.
 */
async function surfaceUnresolvableCard(
	ctx: PmTriggerContext,
	workItem: WorkItem,
	phase: PipelinePhase,
	statusChanged: boolean,
): Promise<void> {
	if (!statusChanged) return;
	const artifactRepository = workItem.taskRepository;
	const notice: UnresolvableCardNotice = {
		phase,
		repository: ctx.project.repo,
		...(artifactRepository && !repoSlugsMatch(artifactRepository, ctx.project.repo)
			? { artifactRepository }
			: {}),
	};
	try {
		if (await ctx.pm.findComment(workItem.id, unresolvableCardMarker(notice))) return;
		await ctx.pm.addComment(workItem.id, unresolvableCardCommentBody(notice));
	} catch (err) {
		logger.warn('pm-status: could not post the unresolvable-card notice', {
			itemId: workItem.id,
			phase,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

/**
 * Record a board event's freshly re-read status in the status dedup and report
 * whether it changed. A resumed dispatch (`resumePmPhase` — a deferred retry, or
 * a lost worker's adopted late result, issue #1076) replays the event that
 * started its phase rather than observing one, so it records nothing (issue
 * #1121): by now its own phase may have moved the card on — a late Planning
 * result lands with the card already in ToDo — and recording that would make
 * SWARM's own follow-up for the move (`selfEnqueueNextPhase`) read as
 * "unchanged" and never start the next phase. Neither consumer of the answer
 * reads it on a resume.
 */
async function observeStatus(ctx: PmTriggerContext, statusId: string): Promise<boolean> {
	if (ctx.resumePmPhase) return false;
	return recordStatusAndDetectChange(ctx.event.itemId, statusId);
}

/**
 * Make the card's current column the single source of truth for which
 * board-driven phase is queued for it (issue #909): retire whatever board-driven
 * phase an *earlier* move left waiting, so only the phase this column calls for
 * — if it calls for one — is left queued.
 *
 * Four conditions each carry one acceptance criterion, and a handler reaching
 * into the dispatch layer for this is precedented (`./review.ts` already imports
 * `scheduleCoalescedDispatch`). The retirement itself fails open, so nothing here
 * can fail an otherwise-good board dispatch.
 */
async function applyColumnToQueue(
	ctx: PmTriggerContext,
	workItem: WorkItem,
	taskId: string | undefined,
	statusChanged: boolean,
	keepPhase: PipelinePhase | undefined,
): Promise<void> {
	// A deferred phase resuming from its original event is not a board move: it was
	// dispatched once already and is retrying its own work.
	if (ctx.resumePmPhase) return;
	// A within-column reorder retires nothing, on the existing gate.
	if (!statusChanged) return;
	// Nothing to key on — a draft card, or one linked into a repository this run is
	// not for.
	if (!taskId) return;
	// A phase's own status report retires nothing: Implementation moves its card to
	// In progress to report the pickup, which says nothing about which phase an
	// operator wants (`PM_PHASE_REPORTED_STATUS_KEYS`).
	if (isPhaseReportedStatusKey(workItem.statusKey)) return;

	await retireSupersededBoardPhases({
		projectId: ctx.project.id,
		taskId,
		keepPhase,
		excludeDispatchId: ctx.dispatchId,
	});
}

/**
 * Wake the project's dependency waits when this card has just entered `done`
 * (issue #1173) — a blocker finishing, observed on the board. Project-wide and
 * keyed on no task id, because a blocker can be a card in another of the project's
 * repositories or one with no SCM artifact at all; the dependency gate re-reads the
 * blockers, so a dependent still blocked by something else simply re-defers. A
 * resumed phase and an unchanged status are not a card arriving in `done`. The
 * promotion fails open, so nothing here can fail the board event.
 */
async function wakeDependentsOfDoneItem(
	ctx: PmTriggerContext,
	workItem: WorkItem,
	statusChanged: boolean,
): Promise<void> {
	if (ctx.resumePmPhase || !statusChanged || workItem.statusKey !== 'done') return;
	await promoteDependencyWaits(ctx.project.id, 'board-done');
}

/**
 * Free the ticket's repository WIP slot when its card has just entered `done` or
 * `backlog` (issue #1185): finished, or taken off the pipeline by a human. Same guards
 * as {@link wakeDependentsOfDoneItem} — a resumed phase and an unchanged status are
 * not a card arriving there — plus a task id, which is the slot's key, resolved
 * against this run's own repository. Idempotent and fail-open, like the promotion.
 */
async function releaseSlotOfFinishedItem(
	ctx: PmTriggerContext,
	workItem: WorkItem,
	taskId: string | undefined,
	statusChanged: boolean,
): Promise<void> {
	if (ctx.resumePmPhase || !statusChanged || !taskId) return;
	if (workItem.statusKey !== 'done' && workItem.statusKey !== 'backlog') return;
	await releaseTicketSlot(
		ctx.project.id,
		ctx.project.repo,
		taskId,
		workItem.statusKey === 'done' ? 'board-done' : 'board-backlog',
	);
}

/**
 * Build the PM status-change trigger handler.
 *
 * `matches` is a cheap synchronous shape gate (is this a state change on this
 * project's board?), delegated to the provider's own `isStatusChange` — the one
 * place that answers it, shared with the router's ingress filter. The
 * authoritative "which phase?" decision happens in `handle`, which re-reads the
 * item and returns `null` — the registry's "looked closer, not for me" — when the
 * card's status doesn't start a PM-driven phase.
 */
export function createPmStatusTrigger(): TriggerHandler {
	return {
		name: 'pm-status-changed',
		description: 'Starts Planning / Implementation when a board card enters that status',

		matches(ctx: TriggerContext): boolean {
			if (ctx.source !== 'pm') return false;
			// Deferred PM phases resume from the original event after the phase's
			// status report moved the card to In progress, so the normal status gate
			// must not discard the retry.
			if (ctx.resumePmPhase) return true;
			return requireProjectPMAdapter(ctx.project).isStatusChange(ctx.event, ctx.project);
		},

		async handle(ctx: TriggerContext): Promise<TriggerResult | null> {
			if (ctx.source !== 'pm') return null;
			const { event, pm } = ctx;

			// Authoritative re-read — never trust a status lifted from the webhook body
			// (docs/github-projects-v2-api.md §5 step 4).
			const workItem = await pm.getWorkItem(event.itemId);

			if (!workItem.statusId) {
				logger.debug('pm-status: item has no resolvable status — skipping', {
					itemId: event.itemId,
				});
				return null;
			}

			// Record the freshly re-read status as this item's latest observed status
			// and learn whether it *changed*. Done for every status a board event
			// observes — including ones that start no phase (backlog, inProgress, …),
			// before the phase gate below — so that a departure to such a status is
			// remembered: leaving "ToDo" and dragging back later then reads as a
			// genuine change rather than a same-status no-op that gets silently
			// skipped (`pm-status-dedup.ts`).
			const statusChanged = await observeStatus(ctx, workItem.statusId);

			const phase = ctx.resumePmPhase ?? resolvePhaseForItem(workItem);

			// Resolved here rather than below the phase gate because the retirement is
			// keyed on it even when the card's new column starts nothing at all.
			const taskId = resolveTaskIdForItem(workItem, ctx.project);

			// The card's current column is now the single source of truth for which
			// board-driven phase is queued for it (issue #909). Applied before every
			// gate below, so that a column starting no phase — and a Planning column
			// whose card already carries `planned` — retire by the same rule rather
			// than needing one of their own.
			await applyColumnToQueue(ctx, workItem, taskId, statusChanged, phase);
			// `done` starts no phase, so this runs before the phase gate below.
			await wakeDependentsOfDoneItem(ctx, workItem, statusChanged);
			await releaseSlotOfFinishedItem(ctx, workItem, taskId, statusChanged);

			if (!phase) {
				// A valid board status that simply doesn't start a phase (backlog, todo,
				// inReview, done) — a "not for me" miss, not an error.
				logger.debug('pm-status: status does not start a PM-driven phase — skipping', {
					itemId: event.itemId,
					statusId: workItem.statusId,
					statusKey: workItem.statusKey,
				});
				return null;
			}

			if (isAlreadyPlanned(phase, workItem, ctx.resumePmPhase)) {
				return null;
			}

			// Second line of defense against the `moved` action's blind spot (see
			// `PMRouterAdapter.isStatusChange`): a pure within-column reorder re-reads
			// the same status every time, so this is the check that actually stops it
			// from re-dispatching the same phase over and over.
			if (!ctx.resumePmPhase && !statusChanged) {
				return null;
			}

			if (!taskId) {
				// No backing SCM artifact *for this repository* to key the worktree on — a
				// draft item, a board with no SCM linkage at all, or a card whose linkage
				// points somewhere this run is not for. Can't run a phase without it; drop
				// rather than throw (a draft card isn't a failed job), and name both
				// repositories so a mis-linked card is diagnosable rather than
				// indistinguishable from a draft. The same diagnosis goes on the card
				// itself (issue #1231).
				logger.warn('pm-status: work item has no backing SCM artifact reference — skipping', {
					itemId: event.itemId,
					url: workItem.url,
					phase,
					taskRef: workItem.taskRef,
					artifactRepository: workItem.taskRepository,
					repository: ctx.project.repo,
				});
				await surfaceUnresolvableCard(ctx, workItem, phase, statusChanged);
				return null;
			}

			logger.debug('pm-status: dispatching pipeline phase', {
				itemId: event.itemId,
				taskId,
				phase,
				resumed: Boolean(ctx.resumePmPhase),
			});
			return { phase, taskId, workItem };
		},
	};
}
