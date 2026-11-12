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
	WipResolveProblemState,
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
	terminated: 'run terminated — move the card out of its start column and back to start a new run',
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

/**
 * The link to a waiting holder's `actionRunId` (issue #1379): the capped Review run
 * whose detail page carries Force re-review.
 */
export const WIP_ACTION_RUN_LABEL = 'Open review run to Force re-review';

/** What a Resolve problem attempt on a waiting holder concluded (issue #1428). */
const RESOLVE_PROBLEM_STATE_LABELS: Record<WipResolveProblemState, string> = {
	queued: 'Resolve problem: attempt queued',
	running: 'Resolve problem: attempt running',
	resolved: 'Resolve problem: resolved it',
	unresolved: 'Resolve problem: could not resolve it',
};

/**
 * The line a waiting holder carries once Resolve problem has made an attempt on its
 * current situation (issue #1428), or `undefined` when none exists.
 */
export function wipResolveProblemLabel(ticket: WipTicket): string | undefined {
	const attempt = ticket.resolveProblem;
	if (!attempt) return undefined;
	return RESOLVE_PROBLEM_STATE_LABELS[attempt.state] ?? `Resolve problem: ${attempt.state}`;
}

/** The link from that line to the attempt run. */
export const WIP_RESOLVE_PROBLEM_RUN_LABEL = 'Open attempt run';

/**
 * What a holder is doing, as one line: the phase it is in and whether it moves. A
 * holder carrying `actionRunId` is stopped after the Review that run is, whatever ran
 * since (a review-cap stop records no run of its own, issue #1379).
 */
export function wipTicketActivityLabel(ticket: WipTicket): string {
	if (ticket.state === 'waiting-on-operator' && ticket.actionRunId) {
		return `Stopped after ${stalledPhaseLabel('review')}`;
	}
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
