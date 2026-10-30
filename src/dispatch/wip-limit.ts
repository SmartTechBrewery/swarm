/**
 * The per-repository WIP limit (issue #1185) — at most `repositories[].wipLimit`
 * tickets in flight in one repository at a time.
 *
 * Three moves, each over SWARM's own durable state (`wip_slots`, `dispatches`) and
 * provider-neutral fields only, so no provider's board columns or URL shapes are read
 * (ai/RULES.md §2):
 *
 * - **Admit** ({@link admitTicket}) — a new ticket's start takes a slot, atomically,
 *   or is refused naming who holds them. `processJob` (`../worker/consumer.ts`) asks
 *   only for the two board-driven phases; every later phase of an admitted ticket and
 *   every pull request-driven phase never asks, so a ticket in flight can always get
 *   the job that finishes it. A refusal waits as an event-woken `wip-limit` pending
 *   dispatch.
 * - **Release** ({@link releaseTicketSlot}) — the ticket finished or left the
 *   pipeline: its pull request closed or merged (the `wip-release` trigger), its card
 *   reached Done or Backlog (`pm-status`), a dashboard Put back, or its start turned
 *   out to be blocked on a prerequisite. A ticket that leaves automation with no
 *   event SWARM observes is caught by the periodic slot sweep
 *   (`./wip-slot-sweep.ts`, issue #1189), and one the automation gate skips is
 *   released by `processJob` at once. Idempotent and best-effort.
 * - **Promote** ({@link promoteWipWaits}) — wake as many waiters as there are free
 *   slots, oldest first. Called on every release, and for every repository holding
 *   waiters by the reconciler ({@link promoteAllWipWaits}), which covers a lost
 *   wake-up and an operator raising a limit.
 *
 * Admission also **ranks** (issue #1191): a board-driven dispatch whose ticket
 * already holds a slot is in-flight work, not a new start, so
 * {@link rankAdmittedTicketDispatch} moves it up from the board rank to the one SCM
 * continuations hold — which is what lets the capacity every dispatch competes for
 * finish tickets before it starts new ones.
 */

import { findProjectRepository, resolveWipLimit } from '../config/project-repository.js';
import type { ProjectConfig } from '../config/schema.js';
import {
	listRepositoriesWithWipWaits,
	listWipLimitWaits,
	rankDispatch,
} from '../db/repositories/dispatchesRepository.js';
import {
	findProjectByIdFromDb,
	findProjectRecordByIdFromDb,
} from '../db/repositories/projectsRepository.js';
import {
	countWipSlots,
	type ReserveWipSlotResult,
	recordWipSlotPullRequest,
	releaseWipSlot,
	reserveWipSlot,
	type WipSlotHolder,
} from '../db/repositories/wipSlotsRepository.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { repositoryForJob, type SwarmJob } from '../queue/jobs.js';
import { IN_FLIGHT_JOB_PRIORITY, PM_BOARD_JOB_PRIORITY } from '../queue/producer.js';
import type { TriggerResult } from '../triggers/types.js';
import { publishDispatchWakeUp } from './dispatcher.js';
import { findTaskIdForPrBranch } from './pr-branch-task.js';

/** What freed a ticket's slot, for the release's log line. */
export type WipReleaseCause =
	| 'pull-request-merged'
	| 'pull-request-closed'
	| 'board-done'
	| 'board-backlog'
	| 'put-back'
	/** The ticket's start deferred on an unfinished prerequisite — it has not really started. */
	| 'dependency-wait'
	/** The slot sweep found the card no longer carries the automation label (issue #1189). */
	| 'label-removed'
	/** The slot sweep found the repository is no longer one of the project's (issue #1189). */
	| 'repository-removed'
	/** The automation-label or assignee gate skipped the ticket's board-driven dispatch. */
	| 'automation-skip';

/** The two board-driven phases — the only ones that ever ask for a slot. */
export type BoardTriggerResult = Extract<TriggerResult, { phase: 'planning' | 'implementation' }>;

/**
 * Admit a board-driven phase's ticket against its repository's WIP limit — the
 * scoped `project.repo`, the trigger's SCM-derived `taskId`, and the repository's
 * resolved limit. Throws on a datastore failure; the caller decides what that means.
 */
export async function admitTicket(
	project: ProjectConfig,
	trigger: BoardTriggerResult,
	dispatchId: string,
): Promise<ReserveWipSlotResult> {
	return reserveWipSlot({
		projectId: project.id,
		repository: project.repo,
		taskId: trigger.taskId,
		limit: resolveWipLimit(project),
		phase: trigger.phase,
		dispatchId,
		workItem: {
			id: trigger.workItem.id,
			title: trigger.workItem.title,
			url: trigger.workItem.url,
		},
	});
}

/**
 * Rank an admitted board-driven dispatch by what admission found (issue #1191). A
 * ticket that already held a slot is in-flight work, so its dispatch moves from
 * {@link PM_BOARD_JOB_PRIORITY} — the rank every board job is created with, before
 * anything knows whether its ticket holds a slot — to {@link IN_FLIGHT_JOB_PRIORITY},
 * and every later wait, defer and promotion of it then orders it with the ticket's
 * other in-flight work rather than behind new starts. A new ticket's start keeps the
 * board rank.
 *
 * Only a dispatch still at the board rank is touched: one an operator or another
 * path already ranked otherwise keeps that rank. Best-effort and fully swallowed —
 * the rank only orders contention, and must never fail the phase.
 */
export async function rankAdmittedTicketDispatch(
	dispatch: { id: string; priority: number },
	admission: { alreadyInFlight: boolean },
): Promise<void> {
	if (!admission.alreadyInFlight || dispatch.priority !== PM_BOARD_JOB_PRIORITY) return;
	try {
		await rankDispatch(dispatch.id, IN_FLIGHT_JOB_PRIORITY);
	} catch (err) {
		logger.debug('wip-limit: could not re-rank an in-flight ticket’s dispatch (continuing)', {
			dispatchId: dispatch.id,
			error: describeError(err),
		});
	}
}

/**
 * Record the pull request a ticket in flight opened onto its slot (issue #1192), so
 * the dashboard's WIP panel can follow the holder from its card onto that pull
 * request (`src/queue/wip-usage.ts`). Called by `processJob` once a pull
 * request-driven phase resolves; the ticket is the task id SWARM's own branch naming
 * maps the head branch back to (`findTaskIdForPrBranch`, issue #1247) — never a URL —
 * and a branch that is not a SWARM task branch, or a ticket holding no slot, records
 * nothing. Best-effort and fully
 * swallowed: it only feeds a read model, and must never fail the phase.
 */
export async function recordTicketPullRequest(
	project: ProjectConfig,
	pullRequest: { prNumber: string; prBranch: string },
): Promise<void> {
	const taskId = await findTaskIdForPrBranch(project, pullRequest.prBranch, { strict: true });
	if (!taskId) return;
	try {
		await recordWipSlotPullRequest(project.id, project.repo, taskId, pullRequest.prNumber);
	} catch (err) {
		logger.debug('wip-limit: could not record the ticket’s pull request (continuing)', {
			projectId: project.id,
			repository: project.repo,
			taskId,
			prNumber: pullRequest.prNumber,
			error: describeError(err),
		});
	}
}

/**
 * The operator-facing reason a refused start waits under — names the repository, the
 * count against the limit, and which tickets hold the slots.
 */
export function wipLimitWaitReason(
	repository: string,
	limit: number,
	holders: readonly WipSlotHolder[],
): string {
	const named = holders.map((holder) => `#${holder.taskId}`).join(', ');
	return `Repository '${repository}' is at its WIP limit (${holders.length}/${limit} tickets in flight${named ? `: ${named}` : ''}) — waiting for one to finish`;
}

/**
 * Free a ticket's slot and wake its repository's waiters. Idempotent — a ticket
 * holding no slot is a no-op that wakes nothing — and best-effort: it runs inside
 * trigger evaluation and dashboard mutations, which a datastore hiccup must never
 * fail, and the reconciler's sweep stays underneath. Returns whether a slot was freed.
 */
export async function releaseTicketSlot(
	projectId: string,
	repository: string,
	taskId: string,
	cause: WipReleaseCause,
): Promise<boolean> {
	try {
		const released = await releaseWipSlot(projectId, repository, taskId);
		if (!released) return false;
		logger.info('wip-limit: ticket left flight — slot released', {
			projectId,
			repository,
			taskId,
			cause,
		});
		await promoteWipWaits(projectId, repository);
		return true;
	} catch (err) {
		logger.warn('wip-limit: slot release failed (the reconciler will re-promote)', {
			projectId,
			repository,
			taskId,
			cause,
			error: describeError(err),
		});
		return false;
	}
}

/**
 * Free the slot of the ticket a dashboard **Put back** just returned to Backlog. Its
 * card move is made with the project's own board credential, so the board event it
 * produces is dropped at ingress as self-authored and `pm-status` never sees it —
 * hence an explicit release, made by the caller only once that move succeeded.
 *
 * The ticket is the job's scoped repository plus: for a board job, the dispatch's
 * recorded task id, or the card's own task reference when the dispatch never resolved
 * one; for a pull request job, the task id SWARM's branch naming maps its branch back
 * to (the dispatch's own task id there is the phase's suffixed one). Best-effort.
 */
export async function releasePutBackTicketSlot(
	projectId: string,
	job: SwarmJob,
	ticket: { dispatchTaskId: string | null; cardTaskRef?: string },
): Promise<boolean> {
	try {
		const project = await findProjectByIdFromDb(projectId, repositoryForJob(job));
		if (!project) return false;
		const taskId =
			job.type === 'scm'
				? await findTaskIdForPrBranch(project, job.event.prBranch, { strict: true })
				: (ticket.dispatchTaskId ?? ticket.cardTaskRef);
		if (!taskId) return false;
		return await releaseTicketSlot(projectId, project.repo, taskId, 'put-back');
	} catch (err) {
		logger.warn('wip-limit: could not resolve the ticket a Put back released', {
			projectId,
			error: describeError(err),
		});
		return false;
	}
}

/**
 * Wake as many of a repository's `wip-limit` waiters as it has free slots, in
 * admission order (`listWipLimitWaits`). Each woken dispatch re-enters `processJob`
 * and re-admits itself, so a waiter that loses a race simply re-defers; wake ids are
 * deterministic, so two concurrent promotions publish one job. Best-effort and fully
 * swallowed. Returns how many were woken.
 */
export async function promoteWipWaits(projectId: string, repository: string): Promise<number> {
	try {
		const waiting = await listWipLimitWaits(projectId, repository);
		if (waiting.length === 0) return 0;
		const record = await findProjectRecordByIdFromDb(projectId);
		// A repository the project no longer owns: wake every waiter, whose own claim
		// then fails it visibly (`requireProjectRepository`) rather than leaving it
		// parked on a limit nothing will ever free.
		const entry = record ? findProjectRepository(record, repository) : undefined;
		const free = entry
			? resolveWipLimit(entry) - (await countWipSlots(projectId, repository))
			: waiting.length;
		if (free <= 0) return 0;
		const woken = waiting.slice(0, free);
		for (const dispatch of woken) {
			await publishDispatchWakeUp(dispatch);
		}
		logger.info('wip-limit: slots free — woke tickets waiting to start', {
			projectId,
			repository,
			promoted: woken.length,
			taskIds: woken.map((row) => row.taskId),
		});
		return woken.length;
	} catch (err) {
		logger.warn('wip-limit: promotion failed', {
			projectId,
			repository,
			error: describeError(err),
		});
		return 0;
	}
}

/**
 * Re-promote every repository holding `wip-limit` waiters — the reconciler's repair
 * for a wake-up lost in a crash window, and how a **raised** limit takes effect
 * without waiting for the next release. Best-effort per repository.
 */
export async function promoteAllWipWaits(): Promise<number> {
	let promoted = 0;
	try {
		for (const { projectId, repository } of await listRepositoriesWithWipWaits()) {
			promoted += await promoteWipWaits(projectId, repository);
		}
	} catch (err) {
		logger.warn('wip-limit: reconciler promotion failed', { error: describeError(err) });
	}
	return promoted;
}
