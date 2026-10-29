/**
 * The WIP-usage read model (issue #1192) — what the dashboard shows of each
 * repository's WIP limit (issue #1185): `in flight / limit`, how many new tickets
 * wait for a slot, and what every slot holder is doing — above all, which holders
 * are waiting on the **operator**, so a full limit never looks like a hung SWARM.
 *
 * Pure and connection-free, exactly like `./queued-runs.ts` and
 * `../dispatch/item-liveness.ts`: the repositories own the reads (`listWipSlots`,
 * `countWipLimitWaitsByRepository`, `listTaskActivitySince`,
 * `listActiveDispatchTaskRefs`) and everything here folds already-loaded rows.
 *
 * **"Waiting on the operator" is derived, never persisted.** It is the item-liveness
 * classifier's own verdict on the holder's units — its card (`work-item`, the slot's
 * task id) and, once a pull request-driven phase recorded one, its pull request
 * (`pull-request`, the slot's `pr_number`) — so it cannot drift from what the
 * Stalled view says about the same work, and nothing has to be un-set when the
 * ticket moves again. A holder's state, first match wins:
 *
 * 1. A live run in either unit → `running`.
 * 2. A non-terminal dispatch for either unit → `waiting-on-pipeline` (queued for a
 *    worker, a CI re-check, a retry inside its budget). Matched on the holder's own
 *    keys, not through a folded unit, so a ticket whose first dispatch is still
 *    waiting for a worker — no run row yet — reads as queued, not stalled. The
 *    ticket's own `wip-limit` wait is excluded: that is the wait this panel
 *    explains, not movement.
 * 3. The unit that moved last (the pull request on a tie) decides the rest. No run
 *    and no dispatch inside the lookback reads as liveness would read silence: `settling`
 *    for {@link ITEM_STALL_AFTER_MS} after the slot opened, `stalled` after.
 * 4. Its latest run `failed` with nothing queued → `waiting-on-operator` (`failed`):
 *    nothing will retry it.
 * 5. Liveness `awaiting-human` → `waiting-on-operator`, naming which recorded
 *    hand-off (`awaitingHumanCause`: review cap reached, plan awaiting greenlight,
 *    approved and awaiting merge).
 * 6. Liveness `stalled` → `waiting-on-operator` (`stalled`).
 * 7. Anything else (`handed-off`, `settling`, `merged`) → `waiting-on-pipeline`.
 *
 * Operator dismissals are deliberately **not** folded in: a dismissal hides a unit
 * from the Stalled view, but a ticket still holding a slot still blocks its
 * repository, and freeing that slot is exactly what the operator is needed for.
 */

import { z } from 'zod';
import type { ActiveDispatchTaskRef } from '../db/repositories/dispatchesRepository.js';
import type { TaskActivityRow } from '../db/repositories/runsRepository.js';
import type { WipSlotRow } from '../db/repositories/wipSlotsRepository.js';
import {
	AwaitingHumanCauseSchema,
	awaitingHumanCause,
	classifyItemLiveness,
	dispatchKey,
	foldLivenessUnits,
	ITEM_STALL_AFTER_MS,
	type ItemLivenessPolicy,
	type ItemLivenessUnit,
	livenessUnitKeysForDispatch,
} from '../dispatch/item-liveness.js';

/** What one slot holder is doing, as the operator needs to read it. */
export const WipTicketStateSchema = z.enum([
	'running',
	'waiting-on-pipeline',
	'waiting-on-operator',
]);
export type WipTicketState = z.infer<typeof WipTicketStateSchema>;

/** Why a `waiting-on-operator` holder waits on the operator. */
export const WipOperatorReasonSchema = z.enum([
	...AwaitingHumanCauseSchema.options,
	'stalled',
	'failed',
]);
export type WipOperatorReason = z.infer<typeof WipOperatorReasonSchema>;

/** One ticket holding a slot. */
export const WipTicketSchema = z.object({
	taskId: z.string(),
	workItemId: z.string().optional(),
	workItemTitle: z.string().optional(),
	workItemUrl: z.string().optional(),
	/** The phase whose admission opened the slot — `planning` or `implementation`. */
	openedPhase: z.string(),
	/** ISO 8601 — when the ticket took its slot. */
	openedAt: z.string(),
	state: WipTicketStateSchema,
	/** `waiting-on-operator` only. */
	operatorReason: WipOperatorReasonSchema.optional(),
	/** The phase of the latest run in the deciding unit, when there is one. */
	phase: z.string().optional(),
	/** The ticket's pull request, once a pull request-driven phase recorded one. */
	prNumber: z.string().optional(),
	/**
	 * That pull request's web URL in the project's own provider grammar, resolved by
	 * the API layer exactly as `runs.stalled` resolves `StalledItem.prUrl`.
	 */
	prUrl: z.string().optional(),
	/** ISO 8601 — when the deciding unit last moved, when it has run at all. */
	lastActivityAt: z.string().optional(),
});
export type WipTicket = z.infer<typeof WipTicketSchema>;

/** The `runs.wip` API/UI contract — Zod is the source of truth for this shape. */
export const WipUsageEntrySchema = z.object({
	projectId: z.string(),
	/** `owner/repo` — the scoped repository the slots were taken in. */
	repository: z.string(),
	/** The repository's resolved limit (`resolveWipLimit`). */
	limit: z.number().int().positive(),
	inFlight: z.number().int().nonnegative(),
	/** How many new tickets wait as `wip-limit` for a slot. */
	waiting: z.number().int().nonnegative(),
	/** The slot holders, oldest slot first. */
	tickets: z.array(WipTicketSchema),
});
export type WipUsageEntry = z.infer<typeof WipUsageEntrySchema>;

/** One repository's `wip-limit` waiter count (`countWipLimitWaitsByRepository`). */
export interface WipWaiterCount {
	projectId: string;
	repository: string;
	count: number;
}

export interface WipUsageInput {
	slots: readonly WipSlotRow[];
	waiters: readonly WipWaiterCount[];
	/** The repository's resolved limit — the caller holds the project records. */
	limitFor: (projectId: string, repository: string) => number;
	activity: readonly TaskActivityRow[];
	activeDispatches: readonly ActiveDispatchTaskRef[];
	/** Keyed by project id; a missing project gets the pipeline's own defaults. */
	policies: Readonly<Record<string, ItemLivenessPolicy>>;
	now?: Date;
}

/** Not a byte a project id, repository slug, or task id can contain. */
const KEY_SEPARATOR = '\u0000';

const DEFAULT_POLICY: ItemLivenessPolicy = {
	planningAutoAdvance: false,
	autoMergeRepositories: [],
};

function key(...parts: string[]): string {
	return parts.join(KEY_SEPARATOR);
}

interface HolderVerdict {
	state: WipTicketState;
	operatorReason?: WipOperatorReason;
	decidingUnit?: ItemLivenessUnit;
}

/**
 * The holder's state from its folded units — the rule list in this module's header.
 * `hasActiveDispatch` is matched on the holder's own keys rather than read off its
 * units: a unit exists only once a run does, and a first dispatch can wait for a
 * worker long before that.
 */
function classifyHolder(
	slot: WipSlotRow,
	units: readonly ItemLivenessUnit[],
	hasActiveDispatch: boolean,
	policy: ItemLivenessPolicy,
	now: Date,
): HolderVerdict {
	const decidingUnit = units.reduce<ItemLivenessUnit | undefined>((best, unit) => {
		if (!best) return unit;
		const delta = unit.lastActivityAt.getTime() - best.lastActivityAt.getTime();
		return delta > 0 || (delta === 0 && unit.unit === 'pull-request') ? unit : best;
	}, undefined);

	if (units.some((unit) => unit.liveRunCount > 0)) return { state: 'running', decidingUnit };
	if (hasActiveDispatch) return { state: 'waiting-on-pipeline', decidingUnit };
	if (!decidingUnit) {
		return now.getTime() - slot.openedAt.getTime() < ITEM_STALL_AFTER_MS
			? { state: 'waiting-on-pipeline' }
			: { state: 'waiting-on-operator', operatorReason: 'stalled' };
	}
	if (decidingUnit.latest.status === 'failed') {
		return { state: 'waiting-on-operator', operatorReason: 'failed', decidingUnit };
	}
	const liveness = classifyItemLiveness(decidingUnit, policy, now);
	if (liveness === 'awaiting-human') {
		const cause = awaitingHumanCause(decidingUnit, policy);
		return {
			state: 'waiting-on-operator',
			...(cause ? { operatorReason: cause } : {}),
			decidingUnit,
		};
	}
	if (liveness === 'stalled') {
		return { state: 'waiting-on-operator', operatorReason: 'stalled', decidingUnit };
	}
	return { state: 'waiting-on-pipeline', decidingUnit };
}

function toTicket(slot: WipSlotRow, verdict: HolderVerdict): WipTicket {
	const latest = verdict.decidingUnit?.latest;
	return WipTicketSchema.parse({
		taskId: slot.taskId,
		...(slot.workItemId ? { workItemId: slot.workItemId } : {}),
		...(slot.workItemTitle ? { workItemTitle: slot.workItemTitle } : {}),
		...(slot.workItemUrl ? { workItemUrl: slot.workItemUrl } : {}),
		openedPhase: slot.openedPhase,
		openedAt: slot.openedAt.toISOString(),
		state: verdict.state,
		...(verdict.operatorReason ? { operatorReason: verdict.operatorReason } : {}),
		...(latest ? { phase: latest.phase } : {}),
		...(slot.prNumber ? { prNumber: slot.prNumber } : {}),
		...(verdict.decidingUnit
			? { lastActivityAt: verdict.decidingUnit.lastActivityAt.toISOString() }
			: {}),
	});
}

/**
 * The read model's entry point: one entry per `(project, repository)` holding a slot
 * or a `wip-limit` waiter, ordered by project then repository, each holder
 * classified by the rules above.
 */
export function toWipUsage(input: WipUsageInput): WipUsageEntry[] {
	const now = input.now ?? new Date();
	const activeDispatches = input.activeDispatches.filter((ref) => ref.waitReason !== 'wip-limit');
	const activeDispatchKeys = new Set(
		activeDispatches.flatMap((ref) => livenessUnitKeysForDispatch(ref)),
	);
	const units = new Map<string, ItemLivenessUnit>();
	for (const unit of foldLivenessUnits(input.activity, activeDispatches, [])) {
		units.set(key(unit.projectId, unit.repository, unit.unit, unit.reference), unit);
	}

	const entries = new Map<string, WipUsageEntry>();
	const entryFor = (projectId: string, repository: string): WipUsageEntry => {
		const entryKey = key(projectId, repository);
		let entry = entries.get(entryKey);
		if (!entry) {
			entry = {
				projectId,
				repository,
				limit: input.limitFor(projectId, repository),
				inFlight: 0,
				waiting: 0,
				tickets: [],
			};
			entries.set(entryKey, entry);
		}
		return entry;
	};

	const slots = [...input.slots].sort(
		(a, b) => a.openedAt.getTime() - b.openedAt.getTime() || a.taskId.localeCompare(b.taskId),
	);
	for (const slot of slots) {
		const entry = entryFor(slot.projectId, slot.repository);
		const holderUnits = [
			units.get(key(slot.projectId, slot.repository, 'work-item', slot.taskId)),
			slot.prNumber
				? units.get(key(slot.projectId, slot.repository, 'pull-request', slot.prNumber))
				: undefined,
		].filter((unit): unit is ItemLivenessUnit => unit !== undefined);
		const hasActiveDispatch =
			activeDispatchKeys.has(dispatchKey(slot.projectId, 'work-item', slot.taskId)) ||
			(slot.prNumber !== null &&
				activeDispatchKeys.has(dispatchKey(slot.projectId, 'pull-request', slot.prNumber)));
		const policy = input.policies[slot.projectId] ?? DEFAULT_POLICY;
		entry.inFlight += 1;
		entry.tickets.push(
			toTicket(slot, classifyHolder(slot, holderUnits, hasActiveDispatch, policy, now)),
		);
	}
	for (const waiter of input.waiters) {
		if (waiter.count > 0) entryFor(waiter.projectId, waiter.repository).waiting += waiter.count;
	}

	return [...entries.values()]
		.map((entry) => WipUsageEntrySchema.parse(entry))
		.sort(
			(a, b) => a.projectId.localeCompare(b.projectId) || a.repository.localeCompare(b.repository),
		);
}
