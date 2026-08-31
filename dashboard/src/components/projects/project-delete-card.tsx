import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Modal, ModalFooter } from '@/components/ui/modal.js';
import { trpcClient } from '@/lib/trpc.js';

/**
 * **Delete project** (issue #854) — the removal half of a project's own Settings
 * tab. A project could be created and configured from the dashboard but never
 * removed there (issue #656 took the action off the `/projects` *list* and left the
 * detail screen without a replacement), so until now the only route to removing one
 * was a hand-written `DELETE FROM projects` against Postgres.
 *
 * A self-contained danger card, the same shape as
 * `workers/worker-delete-card.tsx` (issue #789), rendered at the end of the Settings
 * tab so it sits well clear of the identity/host-layout fields that tab's form saves
 * — a separate write it must not be mistaken for.
 *
 * It invents no gating rule of its own: the Settings tab is already in
 * `PROJECT_ADMIN_TABS` and the whole tab renders behind `ProjectAdminOnly`, which is
 * the same `projectAdmin` boundary `projects.delete` asserts server-side. Hiding the
 * control grants nothing — the server re-checks every caller.
 *
 * Destructive, cascading and unrecoverable, so it never happens on a single click.
 * The confirmation names the project, spells out everything the Postgres cascade
 * takes with it (the entire run history included), and stays disabled until the
 * operator types the project id back — a delete that destroys history should be
 * deliberate, not a reflex. Whatever the server refuses with — `FORBIDDEN`,
 * `NOT_FOUND`, or the `CONFLICT` it answers a project with runs in flight — is
 * rendered verbatim in the confirmation, which stays open.
 */

const DANGER_ENTRY_BUTTON_CLASS =
	'inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-red-200 bg-red-950/40 border border-red-900/50 rounded-md hover:bg-red-900/40 focus:outline-none focus:ring-1 focus:ring-red-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

const DANGER_PRIMARY_BUTTON_CLASS =
	'inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-red-600 rounded-md hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

const SECONDARY_BUTTON_CLASS =
	'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

const CONFIRM_FIELD_CLASS =
	'block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 font-mono focus:outline-none focus:ring-1 focus:ring-red-500 focus:border-red-500 transition-shadow disabled:opacity-50 disabled:cursor-not-allowed';

interface ProjectDeleteCardProps {
	projectId: string;
	/** The project's display name, so the confirmation names what is going. */
	projectName: string;
	/** Called once the project is gone — the route navigates away and drops its queries. */
	onDeleted: () => void;
}

export function ProjectDeleteCard({ projectId, projectName, onDeleted }: ProjectDeleteCardProps) {
	const [confirming, setConfirming] = useState(false);
	const [typedId, setTypedId] = useState('');

	const deleteMutation = useMutation({
		mutationFn: () => trpcClient.projects.delete.mutate({ id: projectId }),
		onSuccess: onDeleted,
	});

	const close = () => {
		setConfirming(false);
		setTypedId('');
		deleteMutation.reset();
	};

	const idConfirmed = typedId.trim() === projectId;

	return (
		<div className="space-y-4">
			<p className="text-sm text-zinc-400 leading-relaxed">
				Remove this project from SWARM entirely. Its configuration, its credentials and its whole
				run history go with it, and none of it can be restored — delete it once the work it
				automates is finished for good.
			</p>
			<button
				type="button"
				onClick={() => setConfirming(true)}
				className={DANGER_ENTRY_BUTTON_CLASS}
			>
				Delete project
			</button>

			<Modal
				open={confirming}
				onClose={() => {
					if (!deleteMutation.isPending) close();
				}}
				title="Delete this project?"
			>
				<div className="space-y-4">
					<p className="text-sm text-zinc-400 leading-relaxed">
						Deleting <span className="font-semibold text-zinc-200">{projectName}</span> removes it
						for good. This cannot be undone — nothing here is archived, and a replacement has to be
						created and configured from scratch.
					</p>
					<p className="text-sm text-zinc-400 leading-relaxed">Deleted with it:</p>
					<ul className="text-sm text-zinc-400 leading-relaxed list-disc pl-5 space-y-1">
						<li>its entire run history — every run and its logs, and the dispatches behind them</li>
						<li>its stored source-control and project-management credentials</li>
						<li>its members, and any pending requests to join it</li>
						<li>the review verdicts recorded against its runs</li>
						<li>
							every worker's enrollment in it, so no machine is routed work for this project again
						</li>
					</ul>
					<p className="text-sm text-zinc-400 leading-relaxed">
						The repository itself, its issues and its pull requests are untouched — SWARM only
						forgets that it automated them. Worktrees already created on a worker's disk stay there
						and have to be cleaned up by hand.
					</p>

					<div>
						<label
							htmlFor="project-delete-confirm"
							className="block text-xs font-medium text-zinc-400 mb-1.5"
						>
							Type <span className="font-mono text-zinc-200">{projectId}</span> to confirm
						</label>
						<input
							type="text"
							id="project-delete-confirm"
							value={typedId}
							onChange={(e) => setTypedId(e.target.value)}
							disabled={deleteMutation.isPending}
							autoComplete="off"
							placeholder={projectId}
							className={CONFIRM_FIELD_CLASS}
						/>
					</div>

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
								disabled={deleteMutation.isPending || !idConfirmed}
								className={DANGER_PRIMARY_BUTTON_CLASS}
							>
								{deleteMutation.isPending ? 'Deleting…' : 'Delete project'}
							</button>
						}
						secondary={
							<button
								type="button"
								onClick={close}
								disabled={deleteMutation.isPending}
								className={SECONDARY_BUTTON_CLASS}
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
