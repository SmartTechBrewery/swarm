import { useMutation } from '@tanstack/react-query';
import { buttonClass } from '@/components/ui/button.js';
import { Modal, ModalFooter } from '@/components/ui/modal.js';
import { RolloutMemberList } from '@/components/workers/rollout-member-list.js';
import type { WorkerRollout } from '@/types/workers.js';

/** What `workers.startFleetUpdateForInstallation` answers with. */
export interface StartedRollout {
	/** `started`, `advanced`, or `no-machines` — the last of which records no rollout. */
	action: string;
	target: string;
	rollout: WorkerRollout | null;
}

/**
 * Confirm an installation-wide **staged rollout**, then show the one it started
 * (issue #1025) — the `/workers` toolbar's counterpart to
 * {@link WorkerUpdateDialog}, which stays the project-scoped action's.
 *
 * Its own component rather than a `scope` flag on that dialog, on the reasoning the
 * roster file already records for the two buttons: the copy, the mutation and the
 * success view all differ. In particular the shared confirmation body says that
 * *only machines their owners have already drained are asked, so this cannot take
 * capacity down* — which is true of the fan-out and false of a rollout, whose whole
 * method is to drain machines itself. Threading a flag through that sentence would
 * put the two claims one boolean apart.
 *
 * The success view is deliberately **not** the end of the story: a rollout advances
 * itself for as long as it takes, so what this shows is the first wave, and the
 * readout on `/workers` ({@link InstallationRolloutPanel}) is where it is watched from
 * there — including after a reload. Both render the same {@link RolloutMemberList},
 * so the two cannot describe one rollout differently.
 */
export function FleetRolloutDialog({
	open,
	onClose,
	target,
	startRollout,
}: {
	open: boolean;
	onClose: () => void;
	/** The build every machine is moved to: the control plane's own commit, read from the server. */
	target: string;
	/** The one mutation this dialog makes. */
	startRollout: () => Promise<StartedRollout>;
}) {
	const startMutation = useMutation({ mutationFn: startRollout });

	const close = () => {
		onClose();
		startMutation.reset();
	};

	return (
		<Modal
			open={open}
			onClose={() => {
				if (!startMutation.isPending) close();
			}}
			title="Update every worker on this installation?"
		>
			<div className="space-y-4">
				{startMutation.isSuccess ? (
					<StartedRolloutView started={startMutation.data} />
				) : (
					<FleetRolloutConfirmation target={target} />
				)}

				{startMutation.isError ? (
					// The server's own words, verbatim — the `FORBIDDEN` a non-administrator gets
					// names the command that stages this over their own machines instead, and the
					// `CONFLICT` a second rollout gets names where to read the one in the way.
					// Paraphrasing either would lose the remedy.
					<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
						{startMutation.error.message}
					</div>
				) : null}

				{startMutation.isSuccess ? (
					<ModalFooter
						primary={
							<button type="button" onClick={close} className={buttonClass('secondary')}>
								Close
							</button>
						}
						secondary={null}
					/>
				) : (
					<ModalFooter
						primary={
							<button
								type="button"
								onClick={() => startMutation.mutate()}
								disabled={startMutation.isPending}
								className={buttonClass('primary')}
							>
								{startMutation.isPending ? 'Starting…' : 'Start the rollout'}
							</button>
						}
						secondary={
							<button
								type="button"
								onClick={close}
								disabled={startMutation.isPending}
								className={buttonClass('secondary')}
							>
								Cancel
							</button>
						}
					/>
				)}
			</div>
		</Modal>
	);
}

/**
 * What the click is about to do — and it is genuinely more than an ask, so the copy
 * says what a rollout does rather than what the fan-out's does.
 *
 * Three things an operator has to know before pressing it: this takes machines out
 * of the pool itself, a bounded number at a time and never mid-phase; it checks each
 * machine came back on the new build before moving on, and stops the whole fleet on
 * one that did not; and every machine it drained goes back in the pool, a halt
 * included — which is the only reason an administrator may drain somebody else's
 * machine at all.
 */
function FleetRolloutConfirmation({ target }: { target: string }) {
	return (
		<>
			<p className="text-sm text-zinc-400 leading-relaxed">
				This stages a rollout over{' '}
				<strong className="text-zinc-200">
					every registered machine on this installation, including machines you do not own
				</strong>
				, moving each to <span className="font-mono text-zinc-200">{target.slice(0, 7)}</span> — the
				build this control plane is running.
			</p>
			<p className="text-sm text-zinc-400 leading-relaxed">
				It drains the machines itself, a bounded number at a time, and never interrupts a phase
				already running: a machine mid-job simply finishes first. Each one is then asked to move,
				and the rollout waits for it to come back on the new build before starting the next wave.
			</p>
			<p className="text-sm text-zinc-400 leading-relaxed">
				A machine that cannot take the build <strong className="text-zinc-200">halts</strong> the
				whole rollout — nothing further is drained or signalled, and there is no resume. Every
				machine it drained goes back in the dispatch pool once it is finished with it, on a halt as
				well, so no machine is left out of the pool for its owner to discover.
			</p>
			<p className="text-sm text-zinc-400 leading-relaxed">
				It then advances on its own. Watch it on this screen — the readout above the roster survives
				a reload.
			</p>
		</>
	);
}

/**
 * The rollout that was started, or advanced — the first wave rather than the final
 * answer, which is why the line under it points at the readout that outlives this
 * modal.
 */
function StartedRolloutView({ started }: { started: StartedRollout }) {
	if (!started.rollout) {
		return (
			<p className="text-sm text-zinc-400 leading-relaxed">
				No machines to move — nothing is registered on this installation, so no rollout was started.
			</p>
		);
	}

	return (
		<>
			<p className="text-sm text-zinc-400 leading-relaxed">
				{started.action === 'advanced' ? 'Advanced the rollout' : 'Started a rollout'} to{' '}
				<span className="font-mono text-zinc-200">{started.rollout.target.slice(0, 7)}</span> over{' '}
				{started.rollout.members.length}{' '}
				{started.rollout.members.length === 1 ? 'machine' : 'machines'}, {started.rollout.waveSize}{' '}
				at a time.
			</p>
			<RolloutMemberList members={started.rollout.members} />
			<p className="text-xs text-zinc-500 leading-relaxed">
				It advances on its own from here. Close this and watch it above the roster — that readout is
				live and survives a reload.
			</p>
		</>
	);
}
