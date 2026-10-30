/**
 * Pure display helpers for the Tickets in progress section (issue #1192; named "WIP"
 * until #1204). They only derive keys, labels, and the run-description shape from an
 * already-fetched {@link WipUsageEntry}; the server owns the counting and the
 * classification — including whether a holder waits on the operator — so nothing
 * here re-decides it.
 */

import type { WorkItemCellRun } from '@/components/runs/work-item-cell.js';
import type {
	WipOperatorReason,
	WipPipelineReason,
	WipTicket,
	WipUsageEntry,
} from '@/types/runs.js';
import { stalledPhaseLabel } from './stalled-items.js';

/** Not a byte a project id or repository slug can contain. */
const KEY_SEPARATOR = '\u0000';

/** Stable React key for one repository's entry. */
export function wipUsageKey(entry: WipUsageEntry): string {
	return [entry.projectId, entry.repository].join(KEY_SEPARATOR);
}

/** `2 / 3 in flight` — the repository's headline. */
export function wipInFlightLabel(entry: WipUsageEntry): string {
	return `${entry.inFlight} / ${entry.limit} in flight`;
}

/** What the operator is waited on for, in their own terms. */
const OPERATOR_REASON_LABELS: Record<WipOperatorReason, string> = {
	'plan-awaiting-greenlight': 'plan is waiting for your greenlight',
	'approved-awaiting-merge': 'approved — waiting for you to merge',
	'review-cap-reached': 'review cap reached — needs a person',
	stalled: 'stalled — nothing is due',
	failed: 'latest run failed and nothing will retry it',
};

export function wipOperatorReasonLabel(reason: WipOperatorReason): string {
	return OPERATOR_REASON_LABELS[reason] ?? reason;
}

/** Why the pipeline is still on it, when there is something more specific to say. */
const PIPELINE_REASON_LABELS: Record<WipPipelineReason, string> = {
	'waiting-for-checks': 'Waiting for CI — Review starts when the checks finish',
};

export function wipPipelineReasonLabel(reason: WipPipelineReason): string {
	return PIPELINE_REASON_LABELS[reason] ?? reason;
}

/** What a holder is doing, as one line: the phase it is in and whether it moves. */
export function wipTicketActivityLabel(ticket: WipTicket): string {
	const phase = ticket.phase ? stalledPhaseLabel(ticket.phase) : undefined;
	switch (ticket.state) {
		case 'running':
			return phase ? `${phase} running` : 'Running';
		case 'waiting-on-pipeline':
			return phase ? `Waiting on the pipeline after ${phase}` : 'Waiting on the pipeline';
		default:
			return phase ? `Stopped after ${phase}` : 'No run yet';
	}
}

/**
 * Adapt a holder onto {@link WorkItemCellRun}, so it is described exactly like a run
 * of its card (`ai/DESIGN_SYSTEM.md` "Describing a run's work"). The phase is the one
 * that opened the slot — always board-driven — so the cell names the card, and the
 * pull request is linked beside it rather than in its place.
 */
export function wipTicketRun(ticket: WipTicket, repository: string): WorkItemCellRun {
	return {
		taskId: ticket.taskId,
		repository,
		phase: ticket.openedPhase,
		workItemId: ticket.workItemId ?? null,
		workItemTitle: ticket.workItemTitle ?? null,
		workItemUrl: ticket.workItemUrl ?? null,
		prNumber: null,
		prTitle: null,
	};
}

/** The section's heading — the operator's word for what it lists, not "WIP" (issue #1204). */
export const WIP_SECTION_TITLE = 'Tickets in progress';

/** Why the section lists what it lists — shown once, under the header. */
export const WIP_SECTION_EXPLANATION =
	'Tickets holding a WIP slot. A new ticket starts only when one of these is merged, closed or put back.';
