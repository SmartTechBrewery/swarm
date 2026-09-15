import type { BadgeTone } from '@/components/ui/badge.js';

/**
 * The fan-out's disposition vocabulary as **data** (issue #1009) — what each word
 * the control plane can report about one machine means to the operator who pressed
 * the button, and what the ones it refused ask them to do about it.
 *
 * It lives in `lib/` rather than in the dialog that renders it for the reason every
 * other helper here does: the dashboard package tests a pure helper in a node
 * environment, and both the installation-wide action and the project-scoped one
 * read the same words. Stated rather than imported from
 * `src/api/worker-update-fanout.ts` — a browser bundle does not pull in a server
 * module — so keep it in step with `WORKER_UPDATE_FANOUT_DISPOSITIONS` there.
 *
 * **An unknown word is described, never dropped.** `src/cli/commands/workers.ts`
 * reads dispositions as a plain string on exactly this rule: a newer control plane
 * may report a word this build has never heard of, and a machine missing from the
 * report reads as a machine nobody asked — the one wrong answer here. So the lookup
 * always answers, falling back to the word itself.
 */

/** What one disposition means, and how firmly it should read. */
export interface WorkerUpdateDisposition {
	/** The operator-facing word; for an unknown disposition, the server's own. */
	label: string;
	/** `positive` for a machine that was asked, `caution` for one that was not. */
	tone: BadgeTone;
	/** One sentence saying what became of the machine, shown beside its name. */
	description: string;
}

const DISPOSITIONS: Record<string, WorkerUpdateDisposition> = {
	requested: {
		label: 'Requested',
		tone: 'positive',
		description: 'Asked, and the request is on its way to a machine that is connected.',
	},
	'queued-offline': {
		label: 'Queued',
		tone: 'positive',
		description: 'Asked while offline — the request waits until the machine reconnects.',
	},
	'in-pool': {
		label: 'Not asked',
		tone: 'caution',
		description: 'Still in the dispatch pool, so it was left alone.',
	},
	'no-project': {
		label: 'Not asked',
		tone: 'caution',
		description: 'Enrolled in no project, so there is nowhere to record the update.',
	},
	unsupervised: {
		label: 'Not asked',
		tone: 'caution',
		description: 'No process supervisor would start it again, so it was left alone.',
	},
	'already-asked': {
		label: 'Already asked',
		tone: 'positive',
		description: 'A request for this same build is already outstanding, and was left as it is.',
	},
	answered: {
		label: 'Answered',
		tone: 'positive',
		description: 'It already reported an outcome for this build, so it was not asked again.',
	},
};

/**
 * What `disposition` means. A word this build does not know keeps the server's own
 * spelling and reads as neutral — it is not this build's place to call it good or
 * bad — with no description beyond the word itself.
 */
export function describeWorkerUpdateDisposition(disposition: string): WorkerUpdateDisposition {
	return (
		DISPOSITIONS[disposition] ?? {
			label: disposition,
			tone: 'neutral',
			description: 'This control plane reported a disposition this dashboard does not know.',
		}
	);
}

/**
 * A remedy line for one *refusal* disposition — the dashboard's voice for what
 * `swarm workers request-update` prints under its own table, so `in-pool` and
 * `no-project` reach the operator who pressed the button rather than only a log.
 *
 * Grouped rather than per machine on the CLI's own reasoning: the three refusals are
 * things the person who pressed the button mostly cannot fix themselves, so what they
 * need is the count, who to ask, and the one command that fixes it — repeated once
 * per machine it would be noise.
 */
export interface WorkerUpdateRemedy {
	disposition: string;
	/** Reads straight after "N machines", so it starts mid-sentence and takes no verb of its own. */
	summary: string;
	/** The command that makes those machines askable, run by whoever the summary names. */
	command: string;
}

/**
 * The three refusals the fan-out reports, in the order
 * `printInstallationUpdateRequest` prints them: the drain first (the one switch that
 * stays the machine owner's), then the enrollment, then the supervisor — which is
 * the order of how far from the operator the fix lives.
 */
const REMEDIES: WorkerUpdateRemedy[] = [
	{
		disposition: 'in-pool',
		summary:
			'still in the dispatch pool and so not asked — draining is the machine owner’s own call, so ask them to run:',
		command: 'swarm workers drain <worker-id>',
	},
	{
		disposition: 'no-project',
		summary:
			'enrolled in no project and so not asked — an update is recorded as a run in the machine’s own project, so enroll each one first:',
		command: 'swarm workers enroll <worker-id> <project-id>',
	},
	{
		disposition: 'unsupervised',
		summary:
			'not under a process supervisor and so not asked — an update is applied by exiting, so ask their owners to install the daemon under launchd, on the machine itself:',
		command: 'swarm-worker-agent install',
	},
];

/** One remedy line and the machines it is about. */
export interface WorkerUpdateRemedyGroup extends WorkerUpdateRemedy {
	/** The owners to go and ask, deduplicated; "their owner" stands in for an unresolved one. */
	owners: string[];
	count: number;
}

/**
 * The remedy lines a report earns — one per refusal disposition that actually
 * occurred, and none at all for a report where every machine was asked.
 */
export function workerUpdateRemedies(
	entries: { disposition: string; owner: { identifier: string } | null }[],
): WorkerUpdateRemedyGroup[] {
	const groups: WorkerUpdateRemedyGroup[] = [];
	for (const remedy of REMEDIES) {
		const refused = entries.filter((entry) => entry.disposition === remedy.disposition);
		if (refused.length === 0) continue;
		groups.push({
			...remedy,
			count: refused.length,
			owners: [...new Set(refused.map((entry) => entry.owner?.identifier ?? 'their owner'))],
		});
	}
	return groups;
}
