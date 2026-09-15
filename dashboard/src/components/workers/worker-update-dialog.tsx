import { useMutation } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge.js';
import { buttonClass } from '@/components/ui/button.js';
import { Modal, ModalFooter } from '@/components/ui/modal.js';
import {
	describeWorkerUpdateDisposition,
	workerUpdateRemedies,
} from '@/lib/worker-update-dispositions.js';
import type { WorkerUpdateReport } from '@/types/workers.js';

/**
 * Confirm a **set-wide** update request, then render the report it answers with
 * (issue #1009) — the roster toolbar's counterpart to the worker detail view's
 * one-machine button, which deliberately has no confirmation: that one names its
 * machine on the screen the operator is standing on, while this one reaches
 * machines that are not on the screen at all.
 *
 * Two states in one `Modal`, in the shape `worker-delete-card.tsx` established: the
 * **confirmation** names the build, the set, and the fact that only already-drained
 * machines are asked, and the **report** replaces it once the mutation settles. They
 * are one modal rather than two because they are one act — the report is the answer
 * to the click, and sending the operator back to the roster to look for it would
 * lose the one thing they pressed the button to find out.
 *
 * **The report is the answer to one request, not a live view**, so nothing here
 * polls or refetches it: a machine's later outcome is the roster's `Updating` mark
 * and the runs list's to tell.
 *
 * Scope-agnostic on purpose — it is told its title, its copy, its target and how to
 * ask, and knows nothing about installations or projects — so the project-scoped
 * action reuses it rather than growing a second dialog that can drift from this
 * one's wording.
 */
export function WorkerUpdateDialog({
	open,
	onClose,
	title,
	confirmCopy,
	scopeNote,
	target,
	requestUpdate,
}: {
	open: boolean;
	onClose: () => void;
	title: string;
	/** What the set is, in the caller's own words — the one sentence that differs between scopes. */
	confirmCopy: ReactNode;
	/**
	 * One further sentence a scope needs and the shared copy cannot state — the
	 * project-scoped action's "a machine enrolled in several projects is moved for all
	 * of them", say. Rendered under the set it qualifies, and omitted entirely by a
	 * scope with nothing extra to say, so neither caller carries the other's caveat.
	 */
	scopeNote?: ReactNode;
	/** The build every machine is asked for: the control plane's own commit, read from the server. */
	target: string;
	/** The one mutation this dialog makes. The caller owns which procedure that is. */
	requestUpdate: () => Promise<WorkerUpdateReport>;
}) {
	const updateMutation = useMutation({ mutationFn: requestUpdate });

	const close = () => {
		onClose();
		updateMutation.reset();
	};

	return (
		<Modal
			open={open}
			onClose={() => {
				if (!updateMutation.isPending) close();
			}}
			title={title}
		>
			<div className="space-y-4">
				{updateMutation.isSuccess ? (
					<WorkerUpdateReportView report={updateMutation.data} />
				) : (
					<WorkerUpdateConfirmation
						confirmCopy={confirmCopy}
						scopeNote={scopeNote}
						target={target}
					/>
				)}

				{updateMutation.isError ? (
					// The server's own words, verbatim — the `FORBIDDEN` a non-administrator gets
					// says what the action is and which command moves their own machines instead,
					// and paraphrasing it here would lose the remedy.
					<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
						{updateMutation.error.message}
					</div>
				) : null}

				{updateMutation.isSuccess ? (
					// The report has nothing left to confirm, so its one action takes the footer's
					// leading slot (the `secondary` *variant* — there is no affirmative act here)
					// and nothing stands beside it.
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
								onClick={() => updateMutation.mutate()}
								disabled={updateMutation.isPending}
								className={buttonClass('primary')}
							>
								{updateMutation.isPending ? 'Asking…' : 'Ask them to update'}
							</button>
						}
						secondary={
							<button
								type="button"
								onClick={close}
								disabled={updateMutation.isPending}
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
 * What the click is about to do, before it does it: the build, the set, and the one
 * precondition that decides how much of that set is actually reached.
 *
 * The target is abbreviated the way `formatWorkerBuild` abbreviates a commit — this
 * is a bare ref rather than a build, so there is no `dirty` flag to format, exactly
 * as the detail view's own success line handles it.
 */
function WorkerUpdateConfirmation({
	confirmCopy,
	scopeNote,
	target,
}: {
	confirmCopy: ReactNode;
	scopeNote?: ReactNode;
	target: string;
}) {
	return (
		<>
			<p className="text-sm text-zinc-400 leading-relaxed">
				This asks {confirmCopy} to move its SWARM installation to{' '}
				<span className="font-mono text-zinc-200">{target.slice(0, 7)}</span> — the build this
				control plane is running — and restart its daemon.
			</p>
			{scopeNote ? <p className="text-sm text-zinc-400 leading-relaxed">{scopeNote}</p> : null}
			<p className="text-sm text-zinc-400 leading-relaxed">
				Only machines their owners have <strong>already drained</strong> are asked. One still in the
				dispatch pool, enrolled in no project, or running under no process supervisor is reported
				and left exactly as it is, so this cannot take capacity down. Each machine applies the
				update once it holds no in-flight phase.
			</p>
		</>
	);
}

/**
 * The answer: one line per machine with its owner and what became of it, then the
 * grouped remedy lines for the machines that were not asked.
 *
 * **Every machine the server named is listed**, including one whose disposition this
 * build has never heard of — `@/lib/worker-update-dispositions.js` falls back to the
 * server's own word rather than dropping the row, because a machine missing from the
 * report reads as a machine nobody asked.
 */
function WorkerUpdateReportView({ report }: { report: WorkerUpdateReport }) {
	const remedies = workerUpdateRemedies(report.workers);

	if (report.workers.length === 0) {
		return (
			<p className="text-sm text-zinc-400 leading-relaxed">
				No machines to ask — nothing was registered for this request to reach.
			</p>
		);
	}

	return (
		<>
			<p className="text-sm text-zinc-400 leading-relaxed">
				Requested <span className="font-mono text-zinc-200">{report.target.slice(0, 7)}</span> from{' '}
				{report.workers.length} {report.workers.length === 1 ? 'machine' : 'machines'}, as{' '}
				{report.requestedBy}.
			</p>
			<ul className="max-h-64 overflow-y-auto border border-zinc-800 rounded-lg bg-panel/20 divide-y divide-zinc-800/60">
				{report.workers.map((worker) => {
					const disposition = describeWorkerUpdateDisposition(worker.disposition);
					return (
						<li key={worker.workerId} className="flex items-center justify-between gap-3 px-3 py-2">
							<div className="min-w-0">
								<p className="text-sm text-zinc-200 font-mono truncate">{worker.displayName}</p>
								{/* An owner the server could not resolve is named as unknown rather than
								    silently attributed to nobody — the same reading the roster gives it. */}
								<p className="text-xs text-zinc-500 truncate">
									{worker.owner?.identifier ?? 'owner unknown'}
								</p>
							</div>
							<Badge tone={disposition.tone} title={disposition.description}>
								{disposition.label}
							</Badge>
						</li>
					);
				})}
			</ul>
			{remedies.length > 0 ? (
				<ul className="space-y-2">
					{remedies.map((remedy) => (
						<li key={remedy.disposition} className="text-xs text-zinc-400 leading-relaxed">
							{remedy.count} {remedy.count === 1 ? 'machine' : 'machines'} {remedy.summary}{' '}
							<span className="font-mono text-zinc-300">{remedy.command}</span> (
							{remedy.owners.join(', ')}). Run this again once they have.
						</li>
					))}
				</ul>
			) : null}
		</>
	);
}
