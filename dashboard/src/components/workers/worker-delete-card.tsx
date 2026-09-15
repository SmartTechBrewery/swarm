import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { buttonClass } from '@/components/ui/button.js';
import { Modal, ModalFooter } from '@/components/ui/modal.js';
import { trpcClient } from '@/lib/trpc.js';

/**
 * **Delete worker** (issue #789) — the retirement half of "a machine is paired with
 * one repository, for life". A worker's `SWARM_WORKER_REPO_ROOT` checkout binds it
 * to exactly one repository for its whole connected life, so re-pairing it is not a
 * thing that exists; freeing the operator up for a new machine/repository pairing is
 * deleting this one and registering a fresh worker.
 *
 * A self-contained owner-only card, the same shape as
 * `worker-operator-credentials-card.tsx` — worker-scoped state rendered by
 * `WorkerDetailView` behind `viewerIsOwner`, so the detail view doesn't grow a third
 * concern of its own. The server re-checks the same strict ownership
 * (`workers.remove`, no `instanceAdmin` override).
 *
 * Destructive and cascading, so it never happens on a single click: the confirmation
 * names in full what goes with the machine (its enrollments, its stored operator
 * source-control credential, its live session) and what does *not* (runs it already
 * produced, which stay in history), because none of that is recoverable afterwards.
 *
 * The mid-run warning here is advisory only — this component reads the viewer-scoped
 * detail view, while the server derives busy state from run lifecycle and refuses a
 * mid-run deletion with `CONFLICT`. That refusal is rendered verbatim in the
 * confirmation rather than pre-empted, so the server stays the authority.
 */

interface WorkerDeleteCardProps {
	workerId: string;
	workerName: string;
	/** The enrollment count the viewer can see, for the confirmation's cascade copy. */
	enrollmentCount: number;
	/** The job this machine is running right now, so the modal can name it. */
	currentRunTitle: string | null;
	/** Called once the worker is gone — the route navigates away and drops its query. */
	onDeleted: () => void;
}

export function WorkerDeleteCard({
	workerId,
	workerName,
	enrollmentCount,
	currentRunTitle,
	onDeleted,
}: WorkerDeleteCardProps) {
	const [confirming, setConfirming] = useState(false);

	const deleteMutation = useMutation({
		mutationFn: () => trpcClient.workers.remove.mutate({ workerId }),
		onSuccess: onDeleted,
	});

	const close = () => {
		setConfirming(false);
		deleteMutation.reset();
	};

	return (
		<div className="space-y-4">
			<p className="text-sm text-zinc-400 leading-relaxed">
				This machine works in one repository checkout, for as long as it is registered — a different
				repository means a different worker. Delete it once its checkout is retired, or to free
				yourself up to register a fresh machine for another repository.
			</p>
			<button
				type="button"
				onClick={() => setConfirming(true)}
				className={buttonClass('dangerOutline')}
			>
				Delete worker
			</button>

			<Modal
				open={confirming}
				onClose={() => {
					if (!deleteMutation.isPending) close();
				}}
				title="Delete this worker?"
			>
				<div className="space-y-4">
					<p className="text-sm text-zinc-400 leading-relaxed">
						Deleting <span className="font-semibold text-zinc-200">{workerName}</span> removes its
						registration for good. This cannot be undone — a replacement has to be registered and
						enrolled from scratch.
					</p>
					<p className="text-sm text-zinc-400 leading-relaxed">Deleted with it:</p>
					<ul className="text-sm text-zinc-400 leading-relaxed list-disc pl-5 space-y-1">
						<li>
							{enrollmentCount > 0
								? `its ${enrollmentCount} project ${enrollmentCount === 1 ? 'enrollment' : 'enrollments'}, so no project can route work to it again`
								: 'its project enrollments, if it holds any'}
						</li>
						<li>its stored operator source-control credential</li>
						<li>
							its session — the daemon is disconnected and cannot reconnect with the credential it
							holds
						</li>
					</ul>
					<p className="text-sm text-zinc-400 leading-relaxed">
						Runs this machine already produced stay in run history, still attributed to its owner. A
						run waiting on a checkout preserved <em>on</em> this machine keeps waiting — reset and
						restart it to move it onto another worker.
					</p>

					{currentRunTitle ? (
						<div className="p-2.5 bg-amber-950/20 border border-amber-900/30 text-xs text-amber-200 rounded">
							This machine is running “{currentRunTitle}” right now. Deletion is refused while a run
							is in flight — wait for it to finish, or stop the run first.
						</div>
					) : null}

					{deleteMutation.isError ? (
						<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
							{deleteMutation.error.message}
						</div>
					) : null}

					<ModalFooter
						primary={
							<button
								type="button"
								onClick={() => deleteMutation.mutate()}
								disabled={deleteMutation.isPending}
								className={buttonClass('danger')}
							>
								{deleteMutation.isPending ? 'Deleting…' : 'Delete worker'}
							</button>
						}
						secondary={
							<button
								type="button"
								onClick={close}
								disabled={deleteMutation.isPending}
								className={buttonClass('secondary')}
							>
								Cancel
							</button>
						}
					/>
				</div>
			</Modal>
		</div>
	);
}
