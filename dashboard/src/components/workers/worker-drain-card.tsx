import { useMutation } from '@tanstack/react-query';
import { formatRelativeTime } from '@/lib/format.js';
import { trpcClient } from '@/lib/trpc.js';

/**
 * **Pool membership** (issue #926, the dashboard half of issue #919) — draining a
 * machine so it can be restarted without failing the run it is executing. Stopping a
 * worker mid-phase kills the agent CLI it is running and settles that dispatch
 * terminally `failed`, so the safe order is: take the machine out of the dispatch
 * pool, let it finish what it has, restart, put it back.
 *
 * A self-contained owner-only card, the same shape as `worker-delete-card.tsx` — one
 * mutation and its own error rendering, so `WorkerDetailView` doesn't grow another
 * concern. The server re-checks the same strict ownership (`workers.setDraining`, no
 * `instanceAdmin` override: taking your own machine out of the pool is the machine
 * operator's call, not an administrative one).
 *
 * **Deliberately not destructive, so deliberately no confirmation modal** — unlike
 * the delete card next to it. Draining takes effect from the next dispatch, touches
 * nothing already in flight, and is undone by the very button that replaces it, so a
 * single click with an immediately visible, reversible effect is the honest control;
 * a modal would dress a reversible operator state up as a danger.
 *
 * It answers "is it safe to restart *yet*?" from the two facts that decide it: this
 * machine is given no new work (it is draining), and `isRunning` says whether the
 * old work has finished. That is a read of the detail view's own active job — the
 * server derives busy state from run lifecycle and is the authority, which is also
 * why a mutation error is rendered verbatim rather than pre-empted here.
 *
 * **Busy-ness is the run's presence, never its title.** A PR-driven phase (review,
 * respond-to-review, respond-to-ci, resolve-conflicts) has no backing board card and
 * so no work-item title, so a card that read busy-ness off a title called an actively
 * running machine idle and invited the restart that fails its run. The title is copy
 * alone: when it is unavailable the card still says to wait, just without a name.
 */

const DRAIN_PANEL_CLASS =
	'p-3 bg-amber-950/20 border border-amber-900/30 text-xs text-amber-200 rounded space-y-1';

const SECONDARY_BUTTON_CLASS =
	'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * What the draining panel says about the work the machine started before the drain.
 * Three cases, in the order they must be decided: still running and named, still
 * running with no title resolved — which is every PR-driven phase, and reads as a
 * wait rather than as idleness — and genuinely idle.
 */
function restartReadiness(isRunning: boolean, currentRunTitle: string | null): string {
	if (!isRunning) return 'Idle — safe to restart now.';
	if (currentRunTitle) {
		return `Still running “${currentRunTitle}” — wait for it to finish before restarting.`;
	}
	return 'Still running a job — wait for it to finish before restarting.';
}

interface WorkerDrainCardProps {
	workerId: string;
	/** ISO 8601 when an operator drained the machine; `null` while it is in the pool. */
	drainingSince: string | null;
	/**
	 * Whether the machine is executing a job right now — the one fact that decides
	 * whether restarting it is safe. Read from the *presence* of the detail view's
	 * active run, never from the title below, which a PR-driven run does not have.
	 */
	isRunning: boolean;
	/** What that job is, when it has a resolved title — copy for the wait message only. */
	currentRunTitle: string | null;
	/** Called once the flag is flipped — the detail route refetches the authoritative view. */
	onChanged: () => void;
}

export function WorkerDrainCard({
	workerId,
	drainingSince,
	isRunning,
	currentRunTitle,
	onChanged,
}: WorkerDrainCardProps) {
	const drainMutation = useMutation({
		mutationFn: (draining: boolean) =>
			trpcClient.workers.setDraining.mutate({ workerId, draining }),
		onSuccess: onChanged,
	});

	return (
		<div className="space-y-4">
			{drainingSince ? (
				<>
					<div className={DRAIN_PANEL_CLASS}>
						<p className="font-semibold" title={new Date(drainingSince).toLocaleString()}>
							Draining since {formatRelativeTime(drainingSince)}
						</p>
						<p>{restartReadiness(isRunning, currentRunTitle)}</p>
					</div>
					<p className="text-sm text-zinc-400 leading-relaxed">
						This machine is out of the dispatch pool and is given no new work. It stays out across
						its own restart — a reconnecting daemon does not rejoin the pool — so put it back
						yourself once it is running again.
					</p>
					<button
						type="button"
						onClick={() => drainMutation.mutate(false)}
						disabled={drainMutation.isPending}
						className={SECONDARY_BUTTON_CLASS}
					>
						{drainMutation.isPending ? 'Returning…' : 'Return to the pool'}
					</button>
				</>
			) : (
				<>
					<p className="text-sm text-zinc-400 leading-relaxed">
						This machine is in the dispatch pool. Draining takes it out: it finishes what it is
						running, is given no new work, and can then be restarted without failing a run. Work
						that would have come here is deferred to another eligible machine rather than failed,
						and returning the machine to the pool undoes it.
					</p>
					<button
						type="button"
						onClick={() => drainMutation.mutate(true)}
						disabled={drainMutation.isPending}
						className={SECONDARY_BUTTON_CLASS}
					>
						{drainMutation.isPending ? 'Draining…' : 'Drain worker'}
					</button>
				</>
			)}

			{drainMutation.isError ? (
				<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
					{drainMutation.error.message}
				</div>
			) : null}
		</div>
	);
}
