import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge.js';
import { RolloutMemberList } from '@/components/workers/rollout-member-list.js';
import { canViewInstanceWide } from '@/lib/instance-admin.js';
import { trpc } from '@/lib/trpc.js';
import { useCurrentUser } from '@/lib/use-current-user.js';
import { describeRolloutStatus } from '@/lib/worker-rollout-states.js';
import { WORKERS_REFETCH_MS } from '@/lib/workers-refresh.js';
import type { WorkerRollout } from '@/types/workers.js';

/**
 * Where the installation's staged fleet update stands (issue #1025) — the readout
 * beside the `/workers` toolbar's **Update all workers** button, which starts one.
 *
 * **It is a page, not a modal.** A rollout advances itself (issue #941): it drains,
 * signals, verifies and returns machines to the pool for as long as it takes, so the
 * one-shot report the fan-out could answer with is the wrong shape for it — the
 * operator who pressed the button closes the tab, comes back, and has to be able to
 * read where the fleet got to. So this polls on {@link WORKERS_REFETCH_MS}, the
 * roster's own cadence, and is mounted on the screen rather than inside the dialog,
 * which is what makes it survive a reload.
 *
 * **A finished rollout folds itself away.** The readout is permanent — there is no
 * dismissing it, because the last rollout is how an operator answers "what build is
 * this fleet on" — but a `completed` one has nothing left to watch, so it collapses
 * to its own heading and can be opened again from there. The fold is a default rather
 * than a rule: an operator who opens a finished report keeps it open, and one who
 * folds a live rollout away keeps it folded, for as long as it is the same rollout.
 * A halted one is never folded by default, since it is the one status that is waiting
 * on somebody.
 *
 * **It renders nothing at all when no rollout has ever run**, and nothing while the
 * viewer is unresolved — `/workers` is an operator's screen first, and an empty
 * panel saying "no rollout" would be a permanent fixture explaining a thing that has
 * never happened.
 *
 * `workers.fleetUpdateStatusForInstallation` is an `instanceAdmin`'s read and the
 * server refuses anyone else outright, so the query is gated on
 * `canViewInstanceWide` — failing closed while the session loads, which is that
 * predicate's own contract — and a viewer who may not see this never issues the
 * read. The gate is a decision about what to *offer*; when the server refuses
 * anyway, its refusal is rendered verbatim rather than paraphrased, because it names
 * the command that reads the caller's own machines instead.
 */
export function InstallationRolloutPanel() {
	const currentUser = useCurrentUser();
	const mayRead = canViewInstanceWide(currentUser.data);
	const rolloutQuery = useQuery({
		...trpc.workers.fleetUpdateStatusForInstallation.queryOptions(),
		enabled: mayRead,
		refetchInterval: WORKERS_REFETCH_MS,
	});

	if (!mayRead) return null;
	if (rolloutQuery.isError) {
		return (
			<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
				{rolloutQuery.error.message}
			</div>
		);
	}
	// Nothing to say: no rollout has ever run, or the first read is still in flight.
	// Both are silence rather than a placeholder, for the reason above.
	const rollout = rolloutQuery.data?.rollout;
	if (!rollout) return null;

	// Keyed on the rollout so a newly started one is a fresh readout: whether the
	// operator had folded the *previous* rollout away says nothing about this one, and
	// carrying that choice over would open a finished rollout or hide a live one.
	return <RolloutReadout key={rollout.id} rollout={rollout} />;
}

/**
 * The rollout itself: what it is moving every machine to and how, why it stopped if
 * it did, and one line per machine.
 *
 * The heading carries the three facts an operator reads first — the target build,
 * the status, and how much capacity one wave can take down — and the halt reason sits
 * directly under them, because on a halted rollout it is the only thing that explains
 * every state below it.
 */
function RolloutReadout({ rollout }: { rollout: WorkerRollout }) {
	const status = describeRolloutStatus(rollout.status);
	const finished = rollout.status === 'completed';
	// `null` until the operator says otherwise, so the default is free to follow the
	// rollout: a live one is open, and it folds itself away the moment it completes.
	// Once they have chosen, their choice wins and a poll cannot undo it — a report
	// they opened to read must not snap shut under them on the next refetch.
	const [override, setOverride] = useState<boolean | null>(null);
	const expanded = override ?? !finished;

	return (
		<section className="border border-zinc-800 rounded-lg bg-panel/40 p-6 shadow-sm space-y-4">
			<div className="space-y-2">
				<button
					type="button"
					aria-expanded={expanded}
					onClick={() => setOverride(!expanded)}
					className="flex w-full flex-wrap items-center gap-3 text-left"
				>
					{expanded ? (
						<ChevronDown className="h-4 w-4 shrink-0 text-zinc-500" />
					) : (
						<ChevronRight className="h-4 w-4 shrink-0 text-zinc-500" />
					)}
					{/* A finished rollout is named for what it now is — a report of the last one
					    — while a live or halted one keeps the present tense. A halt is deliberately
					    not called a report: it is the one status an operator has to act on. */}
					<h2 className="text-sm font-semibold text-zinc-200">
						{finished ? 'Last fleet update report' : 'Installation fleet update'}
					</h2>
					<Badge tone={status.tone} title={status.description}>
						{status.label}
					</Badge>
				</button>
				{expanded ? (
					<p className="text-xs text-zinc-400">
						Moving every registered machine to{' '}
						<span className="font-mono text-zinc-200">{rollout.target.slice(0, 7)}</span>,{' '}
						{rollout.waveSize} {rollout.waveSize === 1 ? 'machine' : 'machines'} per wave. It drains
						each machine itself, never interrupting a phase already running, and puts every machine
						it drained back in the dispatch pool when it is finished with it.
					</p>
				) : null}
			</div>

			{expanded && rollout.status === 'halted' ? (
				// A halt is final and its reason is the machine's own words, so it gets the
				// error banner rather than a line of helper text: nothing further is drained
				// or signalled until somebody fixes the build and starts a new rollout.
				<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded space-y-1">
					<p>{rollout.haltReason ?? 'Halted, with no reason recorded.'}</p>
					<p className="text-red-400/70">
						No further machine is drained or signalled. There is no resume — fix the build and start
						a new fleet update. Machines it had already committed to go on settling, and each
						returns to the pool as it does.
					</p>
				</div>
			) : null}

			{expanded ? <RolloutMemberList members={rollout.members} framed={false} /> : null}
		</section>
	);
}
