import type { BadgeTone } from '@/components/ui/badge.js';

/**
 * The process-supervision vocabulary as **data**, in the shape
 * `./worker-update-dispositions.ts` already uses: what each word a machine can
 * declare about itself means, in one sentence, to the operator reading it.
 *
 * It exists because the explanation used to live in a paragraph of prose under the
 * card — the *same* paragraph whatever the machine had declared, so a machine that
 * reads `Not supervised` was handed a definition of all three states and had to find
 * its own in there. A value that describes itself is shown only to the person it
 * concerns.
 *
 * **Each sentence states the consequence, not the definition.** What an operator
 * needs on seeing `Not supervised` is that the machine cannot be updated from here,
 * which is the one thing the old prose never said outright.
 *
 * **Only the value an operator can act on carries a mark.** `unsupervised` is
 * `caution`; the other two are `neutral` and render as plain text, so a fleet of
 * machines that simply predate the field does not read as a fleet with a problem —
 * the rule `DeclaredSupervision` was written to and this vocabulary keeps.
 *
 * Stated rather than imported from `src/lib/worker-supervision.ts` — a browser
 * bundle does not pull in a server module — so keep it in step with
 * `WORKER_SUPERVISION_STATES` there. An unknown word is described, never dropped,
 * for the reason the dispositions give: a newer control plane may report one this
 * build has never heard of.
 */

/** What one supervision state means, and how firmly it should read. */
export interface WorkerSupervisionState {
	/** The operator-facing word; for an unrecognised state, the server's own. */
	label: string;
	/** `caution` only for the state an operator can act on; the rest are `neutral`. */
	tone: BadgeTone;
	/** One sentence saying what it means for this machine, shown on the value itself. */
	description: string;
}

const SUPERVISION_STATES: Record<string, WorkerSupervisionState> = {
	supervised: {
		label: 'Supervised',
		tone: 'neutral',
		description: 'Started by launchd or systemd, which will start it again if it stops.',
	},
	unsupervised: {
		label: 'Not supervised',
		tone: 'caution',
		description:
			"Nothing will start this worker again if it stops, so it can't be updated from here.",
	},
	unknown: {
		label: 'Unknown',
		tone: 'neutral',
		description:
			"SWARM can't tell — an older version of the worker, or a system it doesn't recognise.",
	},
};

/**
 * What a supervision state means. A word this build does not know keeps the server's
 * own spelling and reads as neutral — it is not this build's place to call it good or
 * bad — with no description beyond the word itself.
 */
export function describeWorkerSupervision(supervision: string): WorkerSupervisionState {
	return (
		SUPERVISION_STATES[supervision] ?? {
			label: supervision,
			tone: 'neutral',
			description: 'This control plane reported a supervision state this dashboard does not know.',
		}
	);
}
