import type { BadgeTone } from '@/components/ui/badge.js';

/**
 * A staged fleet update's two vocabularies as **data** (issue #1025) — where one
 * machine stands inside a rollout, and what the rollout as a whole is doing — in the
 * exact shape `./worker-update-dispositions.ts` states the fan-out's own words in,
 * and for the same reasons.
 *
 * It lives in `lib/` rather than in the panel that renders it because the dashboard
 * package tests a pure helper in a node environment, and because two surfaces read
 * the same words: the `/workers` readout and the dialog that starts the rollout.
 * Stated rather than imported from `src/identity/worker-update-rollout.ts` — a
 * browser bundle does not pull in a server module — so keep it in step with
 * `WORKER_UPDATE_ROLLOUT_MEMBER_STATES` and `WORKER_UPDATE_ROLLOUT_STATUSES` there.
 *
 * **An unknown word is described, never dropped.** `src/cli/commands/workers.ts`
 * reads both vocabularies as plain strings on exactly this rule: a newer control
 * plane may report a word this build has never heard of, and a machine missing from
 * the readout reads as a machine the rollout never named — the one wrong answer
 * here. So both lookups always answer, falling back to the server's own word.
 */

/** What one member state means, and how firmly it should read. */
export interface RolloutMemberStateCopy {
	/** The operator-facing word; for an unknown state, the server's own. */
	label: string;
	/**
	 * `positive` only for the machine that actually came back on the new build,
	 * `caution` for one the rollout settled without moving, `negative` for the failure
	 * that halts it, and `neutral` while it is still in flight — a machine mid-wave is
	 * not yet good or bad news.
	 */
	tone: BadgeTone;
	/** One sentence saying where the machine stands, shown beside its name. */
	description: string;
}

const MEMBER_STATES: Record<string, RolloutMemberStateCopy> = {
	queued: {
		label: 'Queued',
		tone: 'neutral',
		description: 'Named by the rollout and still in the dispatch pool — its wave has not come up.',
	},
	draining: {
		label: 'Draining',
		tone: 'neutral',
		description:
			'Taken out of the dispatch pool, and the rollout is waiting for it to finish whatever it is running.',
	},
	signalled: {
		label: 'Signalled',
		tone: 'neutral',
		description: 'Idle and asked to move — waiting for the machine’s own report.',
	},
	verifying: {
		label: 'Verifying',
		tone: 'neutral',
		description: 'It reported the update applied; waiting for it to come back on the new build.',
	},
	done: {
		label: 'Done',
		tone: 'positive',
		description: 'It came back on the new build, and is back in the dispatch pool.',
	},
	// Settled *without being moved*, which is a different fact from `done` and must
	// never read as one: the machine is on the build it started on.
	skipped: {
		label: 'Skipped',
		tone: 'caution',
		description:
			'Settled without being moved — it is still on the build it had, and nothing failed.',
	},
	failed: {
		label: 'Failed',
		tone: 'negative',
		description: 'It could not take the build. This is what halts the rollout.',
	},
};

/**
 * What a member `state` means. A word this build does not know keeps the server's
 * own spelling and reads as neutral — it is not this build's place to call it good
 * or bad — with no description beyond saying so.
 */
export function describeRolloutMemberState(state: string): RolloutMemberStateCopy {
	return (
		MEMBER_STATES[state] ?? {
			label: state,
			tone: 'neutral',
			description: 'This control plane reported a state this dashboard does not know.',
		}
	);
}

/** What the rollout as a whole is doing. */
export interface RolloutStatusCopy {
	label: string;
	tone: BadgeTone;
	description: string;
}

const STATUSES: Record<string, RolloutStatusCopy> = {
	in_progress: {
		label: 'In progress',
		tone: 'neutral',
		description:
			'Still moving — it drains, signals, verifies and returns machines to the pool by itself.',
	},
	halted: {
		label: 'Halted',
		tone: 'negative',
		description:
			'It stopped itself on a bad build. Nothing further is drained or signalled, and there is no resume — fix the build and start a new rollout.',
	},
	completed: {
		label: 'Completed',
		tone: 'positive',
		description: 'Every machine settled, none of them badly.',
	},
};

/** What a rollout `status` means, with the same fallback the member states have. */
export function describeRolloutStatus(status: string): RolloutStatusCopy {
	return (
		STATUSES[status] ?? {
			label: status,
			tone: 'neutral',
			description: 'This control plane reported a status this dashboard does not know.',
		}
	);
}

/**
 * The tally under the member list: how many machines stand in each state, in the
 * rollout's own progression order, so a fleet is read without counting rows.
 *
 * A state this build has never heard of is still counted, after the known ones and
 * alphabetically among themselves — the same tolerance `summariseRollout`
 * (`src/cli/commands/workers.ts`) prints its own tally with, and for the same
 * reason: an uncounted machine is a machine missing from the total.
 */
const MEMBER_STATE_ORDER = [
	'queued',
	'draining',
	'signalled',
	'verifying',
	'done',
	'skipped',
	'failed',
];

/** One `{ state, count }` per state present, ordered as {@link MEMBER_STATE_ORDER} says. */
export function tallyRolloutMemberStates(
	members: { state: string }[],
): { state: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const member of members) {
		counts.set(member.state, (counts.get(member.state) ?? 0) + 1);
	}
	const known = MEMBER_STATE_ORDER.filter((state) => counts.has(state));
	const unknown = [...counts.keys()].filter((state) => !MEMBER_STATE_ORDER.includes(state)).sort();
	return [...known, ...unknown].map((state) => ({ state, count: counts.get(state) ?? 0 }));
}
