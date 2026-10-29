/**
 * The WIP slot sweep (issue #1189) — the periodic pass that frees the slot of a
 * ticket which left automation without an event SWARM observes.
 *
 * Phase 1 (issue #1185) releases a slot on the events SWARM sees: the pull request
 * closing or merging, a human moving the card to Done or Backlog, a dashboard Put
 * back. A ticket can also leave by a road no event travels:
 *
 * - the automation label (`pipeline.automationLabel`) removed — no provider's label
 *   change is a trigger;
 * - the card moved to Done/Backlog by SWARM's **own** board credential (split
 *   children closed when a parent merge absorbed them), which ingress drops as
 *   self-authored;
 * - a lost board webhook;
 * - the slot's repository removed from the project.
 *
 * Left alone, each holds a slot forever and wedges its repository's next ticket. So
 * this re-reads every slot holder's card with the one-card `PMProvider.getWorkItem`
 * and releases through {@link releaseTicketSlot}, which also wakes the repository's
 * next waiter.
 *
 * **Fail closed.** `getWorkItem` has no typed not-found — it throws on anything it
 * cannot resolve — so a read that fails keeps the slot and is logged; a release is
 * only ever made on a positive answer read off the card (or off the project record,
 * for a removed repository). Holding a slot one pass too long costs a delay;
 * releasing one wrongly breaks the limit.
 *
 * **Bounded cost.** One `getWorkItem` per slot per pass, never `listWorkItems`
 * (ai/RULES.md §2, issue #735). The slot count is at most the sum of every
 * repository's `wipLimit`, so a pass is a handful of reads; each pass logs its count.
 *
 * Provider-agnostic: it reads only `WorkItem.statusKey` and `WorkItem.labels` (through
 * `hasAutomationLabel`). Lives under `src/dispatch/` beside `./base-branch-health.ts`,
 * whose shape it copies: work scheduled at the composition root
 * (`src/router/dispatcher.ts`), not by a phase.
 */

import { findProjectRepository, scopeProjectToRepository } from '../config/project-repository.js';
import type { ProjectRecord } from '../config/schema.js';
import { findProjectRecordByIdFromDb } from '../db/repositories/projectsRepository.js';
import { findBoardItemIdForTask } from '../db/repositories/runsRepository.js';
import { listWipSlots, type WipSlotRow } from '../db/repositories/wipSlotsRepository.js';
import { requireProjectPMProvider } from '../integrations/pm/registry.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { hasAutomationLabel, resolveAutomationLabel } from '../pm/automation-label.js';
import type { PMProvider, WorkItem } from '../pm/types.js';
import { releaseTicketSlot, type WipReleaseCause } from './wip-limit.js';

/**
 * How often the sweep runs. The latency it bounds is how long a ticket that left
 * automation silently keeps its repository's next ticket waiting, and a pass costs
 * one board read per held slot — so the base-branch health sweep's five minutes
 * (`BASE_BRANCH_HEALTH_SWEEP_INTERVAL_MS`) is the same trade-off at the same price.
 * Not configurable, on that sweep's precedent: release latency is not an operator dial.
 */
export const WIP_SLOT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

/** What the sweep can find on a card (or a project record) that frees its slot. */
export type WipSlotReleaseCause = Extract<
	WipReleaseCause,
	'label-removed' | 'board-done' | 'board-backlog' | 'repository-removed'
>;

/**
 * Whether a held slot should be freed, and why — pure, so every rule is testable
 * without I/O. `workItem` is the slot's card as read this pass, or `undefined` when
 * none was read; only a removed repository releases without one, since that answer
 * comes from the project record. `undefined` keeps the slot.
 *
 * The label rule applies only while the project gates on a label at all
 * (`resolveAutomationLabel` returns one): with the gate off, no label ever admitted
 * the ticket, so its absence frees nothing.
 */
export function wipSlotReleaseCause(
	slot: Pick<WipSlotRow, 'repository'>,
	workItem: WorkItem | undefined,
	project: ProjectRecord,
): WipSlotReleaseCause | undefined {
	if (!findProjectRepository(project, slot.repository)) return 'repository-removed';
	if (!workItem) return undefined;
	if (workItem.statusKey === 'done') return 'board-done';
	if (workItem.statusKey === 'backlog') return 'board-backlog';
	const label = resolveAutomationLabel(project.pipeline);
	if (label && !hasAutomationLabel(workItem, label)) return 'label-removed';
	return undefined;
}

/** One pass's tally, for its log line and its tests. */
export interface WipSlotSweepResult {
	/** Slots held when the pass started. */
	slots: number;
	/** `getWorkItem` calls made — never more than `slots`. */
	reads: number;
	released: number;
	/** Slots kept because their card or project could not be read or resolved. */
	unreadable: number;
}

/** Re-check one slot against its card. Never throws. */
async function sweepSlot(
	record: ProjectRecord,
	slot: WipSlotRow,
	provider: PMProvider,
	result: WipSlotSweepResult,
): Promise<void> {
	const context = {
		projectId: slot.projectId,
		repository: slot.repository,
		taskId: slot.taskId,
		workItemId: slot.workItemId ?? undefined,
	};
	let workItemId = slot.workItemId ?? undefined;
	try {
		workItemId ??= await findBoardItemIdForTask(slot.projectId, slot.taskId);
	} catch (err) {
		logger.warn('wip slot sweep: could not look up the card behind a slot — keeping it', {
			...context,
			error: describeError(err),
		});
		result.unreadable += 1;
		return;
	}
	if (!workItemId) {
		logger.info('wip slot sweep: no card is recorded for this slot — keeping it', context);
		result.unreadable += 1;
		return;
	}

	let workItem: WorkItem;
	try {
		result.reads += 1;
		workItem = await provider.getWorkItem(workItemId);
	} catch (err) {
		logger.warn('wip slot sweep: card read failed — keeping the slot', {
			...context,
			workItemId,
			error: describeError(err),
		});
		result.unreadable += 1;
		return;
	}

	const cause = wipSlotReleaseCause(slot, workItem, record);
	if (cause && (await releaseTicketSlot(slot.projectId, slot.repository, slot.taskId, cause))) {
		result.released += 1;
	}
}

/** Re-check every slot one project holds in one repository. Never throws. */
async function sweepRepository(
	record: ProjectRecord,
	repository: string,
	slots: readonly WipSlotRow[],
	result: WipSlotSweepResult,
): Promise<void> {
	if (!findProjectRepository(record, repository)) {
		// Answered by the record itself, so no card is read.
		for (const slot of slots) {
			const cause = wipSlotReleaseCause(slot, undefined, record);
			if (cause && (await releaseTicketSlot(record.id, repository, slot.taskId, cause))) {
				result.released += 1;
			}
		}
		return;
	}

	let provider: PMProvider;
	try {
		provider = requireProjectPMProvider(scopeProjectToRepository(record, repository));
	} catch (err) {
		logger.warn('wip slot sweep: no PM provider for this project — keeping its slots', {
			projectId: record.id,
			repository,
			error: describeError(err),
		});
		result.unreadable += slots.length;
		return;
	}
	for (const slot of slots) {
		await sweepSlot(record, slot, provider, result);
	}
}

/** Group rows by a key, keeping first-seen order. */
function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const row of rows) {
		const group = groups.get(key(row));
		if (group) group.push(row);
		else groups.set(key(row), [row]);
	}
	return groups;
}

/**
 * One sweep pass over every held slot. Each project is loaded once and each
 * repository's provider resolved once; a failing card, repository or project never
 * stops the pass, and this never throws — an unhandled rejection out of a bare
 * `setInterval` callback would take the router down.
 */
export async function sweepWipSlots(): Promise<WipSlotSweepResult> {
	const result: WipSlotSweepResult = { slots: 0, reads: 0, released: 0, unreadable: 0 };
	try {
		const slots = await listWipSlots();
		result.slots = slots.length;
		if (slots.length === 0) return result;

		for (const [projectId, projectSlots] of groupBy(slots, (slot) => slot.projectId)) {
			try {
				const record = await findProjectRecordByIdFromDb(projectId);
				if (!record) {
					// The slots cascade away with their project row; nothing to free here.
					result.unreadable += projectSlots.length;
					continue;
				}
				for (const [repository, repositorySlots] of groupBy(
					projectSlots,
					(slot) => slot.repository,
				)) {
					await sweepRepository(record, repository, repositorySlots, result);
				}
			} catch (err) {
				logger.warn('wip slot sweep: project pass failed — continuing the sweep', {
					projectId,
					error: describeError(err),
				});
			}
		}
		logger.info('wip slot sweep: pass complete', { ...result });
	} catch (err) {
		logger.error('wip slot sweep: sweep failed (continuing)', { error: describeError(err) });
	}
	return result;
}
