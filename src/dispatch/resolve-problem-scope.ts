/**
 * Which "Waiting on you" slot holders Resolve problem takes on (issue #1425).
 *
 * The WIP panel (`../queue/wip-usage.ts`) names why each `waiting-on-operator`
 * holder waits on a person. Resolve problem's sweep (`./resolve-problem-trigger.ts`)
 * reads that same classification and attempts only the reasons listed in scope
 * here. Every other reason is a deliberate hand-off to a person, and stays theirs.
 *
 * The table is exhaustive over {@link WipOperatorReason}: a new reason fails to
 * compile until it is classified here, with its reason when it is excluded.
 */

import type { WipOperatorReason } from '../queue/wip-usage.js';

/** Whether Resolve problem takes on one "Waiting on you" reason, and why not. */
export type ResolveProblemReasonScope = { inScope: true } | { inScope: false; reason: string };

/** Every "Waiting on you" reason, classified. */
export const RESOLVE_PROBLEM_WAITING_SCOPE = {
	stalled: { inScope: true },
	failed: { inScope: true },
	terminated: {
		inScope: false,
		reason:
			'A user terminated the run: that is an operator’s own stop, and restarting it (moving the card out of its column and back) is their call.',
	},
	'review-cap-reached': {
		inScope: false,
		reason:
			'The review cap is a safety stop SWARM placed on purpose; granting another review, or merging, is a person’s decision.',
	},
	'plan-awaiting-greenlight': {
		inScope: false,
		reason: 'The plan waits for the operator’s greenlight, a deliberate human gate.',
	},
	'approved-awaiting-merge': {
		inScope: false,
		reason: 'The approved pull request waits for a person to merge it, a deliberate human gate.',
	},
} as const satisfies Record<WipOperatorReason, ResolveProblemReasonScope>;

/** Why a holder with no recorded reason is never attempted. */
const NO_REASON: ResolveProblemReasonScope = {
	inScope: false,
	reason:
		'The holder waits on a person with no recorded hand-off, so there is nothing to diagnose.',
};

/** The scope of one holder's reason; a holder with none is excluded. */
export function resolveProblemScopeFor(
	reason: WipOperatorReason | undefined,
): ResolveProblemReasonScope {
	return reason ? RESOLVE_PROBLEM_WAITING_SCOPE[reason] : NO_REASON;
}
