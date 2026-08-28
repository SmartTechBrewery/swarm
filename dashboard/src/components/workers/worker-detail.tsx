import { useMutation } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { WorkItemCell } from '@/components/runs/work-item-cell.js';
import { Badge } from '@/components/ui/badge.js';
import { WorkerEnrollDialog } from '@/components/workers/worker-enroll-dialog.js';
import { WorkerEnrollmentCard } from '@/components/workers/worker-enrollment-card.js';
import { WorkerOperatorCredentialsCard } from '@/components/workers/worker-operator-credentials-card.js';
import { formatPhase, formatRelativeTime } from '@/lib/format.js';
import { sortPipelinePhases } from '@/lib/pipeline-phases.js';
import { trpcClient } from '@/lib/trpc.js';
import { useDraftSync } from '@/lib/use-draft-sync.js';
import type { WorkerDetail } from '@/types/workers.js';

/**
 * One machine in full (issue #477) — where the Workers table is the scannable
 * index, this is where an operator understands and administers a single worker.
 * It is grouped into sections rather than a field dump: identity and owner,
 * connectivity, what the daemon declares, the active job, and one block per
 * project the machine is enrolled in ({@link WorkerEnrollmentCard}, which owns the
 * editable values and their authorization).
 *
 * **Self-declared facts are read-only.** A daemon declares its `capabilities`,
 * `supportedPhases` and its checkout's `repository` (issue #687) at handshake and
 * re-declares them on every reconnect, so the view reports them and never offers to
 * edit them — an edit here would only make the dashboard disagree with the machine
 * until its next heartbeat. The checkout repository is here because it is the fact
 * an enrollment for a *different* repository is refused or suspended against (issue
 * #690), which the enrollment blocks below then name in full.
 *
 * **The machine's own name is the one Identity-card fact that *is* editable** —
 * unlike the self-declared facts above, `displayName` is the owner's own label,
 * not something the daemon states, so there is nothing for an edit to disagree
 * with ({@link WorkerNameField}). Gated by `viewerIsOwner` exactly like the
 * enrollment card's owner-controlled values, and by the same strict-ownership
 * check server-side (`workers.rename`, no `instanceAdmin` override).
 *
 * **Nothing secret is *read back* on this surface**, by construction rather than by
 * filtering: `workers.getById` names each safe field explicitly, so no machine path,
 * worker credential, credential hash, or project PAT exists to leak. Since issue #766
 * it does host one **write-only** secret field — the operator source-control
 * credential ({@link WorkerOperatorCredentialsCard}) — whose own read reports presence
 * and a last-updated time and never a value or a masked echo of one, so there is still
 * nothing here to reveal.
 *
 * **Offering the machine to a *new* project is here too** (issue #764), as the
 * owner's own action ({@link WorkerEnrollDialog}) over the same `workers.enroll`
 * the CLI calls — no new procedure and no new authorization. It is still a
 * different act from administering an existing enrollment, and it produces one:
 * the new enrollment starts pending with sharing consent off — so a project
 * administrator's approval and the owner's consent remain exactly where they were
 * — unless the owner also administers the chosen project, in which case both
 * approvals were already theirs and the server grants them at once (issue #784).
 */

const CARD_CLASS = 'border border-zinc-800 rounded-lg bg-panel/40 p-6 shadow-sm';
const SECTION_HEADING_CLASS =
	'text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4';
const LABEL_CLASS = 'block text-xs font-medium text-zinc-400';
const FIELD_CLASS =
	'block w-full max-w-xs px-3 py-1.5 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 disabled:opacity-50 disabled:bg-zinc-950 disabled:border-zinc-800 disabled:text-zinc-500';
const SECONDARY_BUTTON_CLASS =
	'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

/** One labelled read-only field of the identity/connectivity grids. */
function Field({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
	return (
		<div>
			<span className={LABEL_CLASS}>{label}</span>
			<div
				className={`mt-1 text-sm text-zinc-200 break-words ${mono ? 'font-mono select-all' : ''}`}
			>
				{children}
			</div>
		</div>
	);
}

const EM_DASH = <span className="text-zinc-500">—</span>;

/**
 * The machine's own label, editable only by its owner (`workers.rename`, strict
 * ownership, no `instanceAdmin` override — mirrors the enrollment card's
 * {@link WorkerEnrollmentCard} controls). A non-owner sees the plain name, same
 * as every other Identity field. Draft-and-save rather than save-per-keystroke,
 * the same shape as the enrollment card's concurrency control: a free-text field
 * can't safely fire a mutation on every keystroke, and a draft re-syncs from the
 * server's value whenever it actually changes so the screen's polling can't
 * clobber a half-typed edit.
 */
function WorkerNameField({
	workerId,
	displayName,
	editable,
	onChanged,
}: {
	workerId: string;
	displayName: string;
	editable: boolean;
	onChanged: () => void;
}) {
	const [draft, setDraft] = useDraftSync(displayName, (name) => name);

	const renameMutation = useMutation({
		mutationFn: (nextDisplayName: string) =>
			trpcClient.workers.rename.mutate({ workerId, displayName: nextDisplayName }),
		onSuccess: onChanged,
	});

	if (!editable) return <>{displayName}</>;

	const trimmed = draft.trim();
	const unchanged = trimmed === displayName;
	const invalid = trimmed.length === 0;

	return (
		<div className="space-y-1.5">
			<div className="flex items-center gap-2">
				<input
					aria-label="Machine name"
					type="text"
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					disabled={renameMutation.isPending}
					maxLength={80}
					className={FIELD_CLASS}
				/>
				<button
					type="button"
					onClick={() => renameMutation.mutate(trimmed)}
					disabled={renameMutation.isPending || unchanged || invalid}
					className={SECONDARY_BUTTON_CLASS}
				>
					Save
				</button>
			</div>
			{renameMutation.isError ? (
				<p className="text-xs text-red-400">{renameMutation.error.message}</p>
			) : null}
		</div>
	);
}

function ConnectionState({ worker }: { worker: WorkerDetail }) {
	const online = worker.connection === 'online';
	return (
		<span className="inline-flex items-center gap-2 text-sm text-zinc-200">
			<span
				className={`h-2 w-2 rounded-full ${
					online
						? 'bg-emerald-500 ring-4 ring-emerald-500/10'
						: 'bg-zinc-600 ring-4 ring-zinc-600/10'
				}`}
			/>
			{online ? 'Online' : 'Offline'}
		</span>
	);
}

/**
 * The declared phase repertoire in full — the only screen that shows it, and every
 * phase on the same terms (issue #542). What it answers is version skew: a daemon
 * built before issue #536 declares five phases rather than six, and the dispatch
 * gate routes around the missing one instead of failing (issue #467).
 *
 * Rendered in the pipeline's own order ({@link sortPipelinePhases}, issue #548) —
 * never the order the daemon happened to declare, which differs between a same-host
 * worker and a remote DB-free daemon. That makes this list read the same way as the
 * enrollment's Allowed pipeline phases below it, so "what the machine declares" and
 * "what this project allows" can be compared line for line.
 */
function SupportedPhases({ phases }: { phases: string[] }) {
	if (phases.length === 0) {
		return (
			<p className="text-xs text-zinc-500">
				No phases declared — the dispatcher treats an undeclared repertoire as every phase.
			</p>
		);
	}
	return (
		<div className="flex flex-wrap gap-1">
			{sortPipelinePhases(phases).map((phase) => (
				<Badge key={phase}>{formatPhase(phase)}</Badge>
			))}
		</div>
	);
}

interface WorkerDetailViewProps {
	worker: WorkerDetail;
	/** Project id → display name, so an enrollment block names its project. */
	projectNames: Map<string, string>;
	/**
	 * Project id → the phases that project has turned off for every worker
	 * (`pipeline.<phase>.enabled: false`), so the Allowed-pipeline-phases control can
	 * say that a phase is off project-wide rather than offering a selection that
	 * could never take work (issue #509).
	 */
	projectDisabledPhases: Map<string, string[]>;
	/** Called after a mutation lands, so the caller refetches the authoritative view. */
	onChanged: () => void;
}

export function WorkerDetailView({
	worker,
	projectNames,
	projectDisabledPhases,
	onChanged,
}: WorkerDetailViewProps) {
	const ownerName = worker.owner?.displayName ?? 'the owner';
	const [enrollOpen, setEnrollOpen] = useState(false);

	return (
		<div className="space-y-6">
			<div className={CARD_CLASS}>
				<h2 className={SECTION_HEADING_CLASS}>Identity</h2>
				<div className="grid gap-4 grid-cols-1 md:grid-cols-2">
					<Field label="Machine">
						<WorkerNameField
							workerId={worker.workerId}
							displayName={worker.displayName}
							editable={worker.viewerIsOwner}
							onChanged={onChanged}
						/>
					</Field>
					<Field label="Worker ID" mono>
						{worker.workerId}
					</Field>
					<Field label="Owner">{worker.owner?.displayName ?? EM_DASH}</Field>
					<Field label="Owner identifier" mono>
						{worker.owner?.identifier ?? EM_DASH}
					</Field>
				</div>
			</div>

			<div className={CARD_CLASS}>
				<h2 className={SECTION_HEADING_CLASS}>Connectivity</h2>
				<div className="grid gap-4 grid-cols-1 md:grid-cols-2">
					<Field label="Connection">
						<ConnectionState worker={worker} />
					</Field>
					<Field label="Last seen">
						{worker.lastSeenAt ? (
							<span title={new Date(worker.lastSeenAt).toLocaleString()}>
								{formatRelativeTime(worker.lastSeenAt)}
							</span>
						) : (
							<span className="text-zinc-500">Never connected</span>
						)}
					</Field>
				</div>
				<p className="text-xs text-zinc-500 mt-4">
					Derived from the machine's heartbeat lease — the one liveness rule the dispatch gate
					reads. This screen polls, so the state stays current while it is open.
				</p>
			</div>

			<div className={CARD_CLASS}>
				<h2 className={SECTION_HEADING_CLASS}>Declared by the daemon</h2>
				<div className="grid gap-4 grid-cols-1 md:grid-cols-2">
					<Field label="Agent CLIs">
						{worker.capabilities.length === 0 ? (
							EM_DASH
						) : (
							<div className="flex flex-wrap gap-1">
								{worker.capabilities.map((cli) => (
									<Badge key={cli}>{cli}</Badge>
								))}
							</div>
						)}
					</Field>
					<Field label="Pipeline phases">
						<SupportedPhases phases={worker.supportedPhases} />
					</Field>
					<Field label="Checkout repository" mono>
						{worker.repository ?? EM_DASH}
					</Field>
				</div>
				<p className="text-xs text-zinc-500 mt-4">
					Declared by the machine's own daemon at handshake. Reported here, never editable — editing
					any of it would make this screen disagree with the machine. A daemon on an older build can
					declare fewer phases than this one runs; which of them a project may actually give this
					machine is the enrollment's Allowed pipeline phases, below. The checkout repository is the
					single repository this machine works in: a project for any other one cannot run here, and
					an unidentifiable checkout declares nothing.
				</p>
			</div>

			<div className={CARD_CLASS}>
				<h2 className={SECTION_HEADING_CLASS}>Active job</h2>
				{worker.currentRun ? (
					<div className="space-y-2">
						<WorkItemCell
							run={worker.currentRun}
							titleHref={`/runs/${worker.currentRun.runId}`}
							phaseLabel={formatPhase(worker.currentRun.phase)}
							variant="card"
						/>
						<p className="text-xs text-zinc-500">
							Running for{' '}
							{projectNames.get(worker.currentRun.projectId) ?? worker.currentRun.projectId}
						</p>
					</div>
				) : (
					<p className="text-sm text-zinc-400">Idle — no run assigned right now.</p>
				)}
			</div>

			{/* Worker-scoped state, so it sits above the per-project blocks — which are also
			    what decide which providers it lists. Owner-only, the same strict flag that
			    gates the rename field and the enroll entry point, and the server re-checks
			    the same rule on every procedure. */}
			{worker.viewerIsOwner ? (
				<div className={CARD_CLASS}>
					<h2 className={SECTION_HEADING_CLASS}>Operator source-control credential</h2>
					<WorkerOperatorCredentialsCard workerId={worker.workerId} />
				</div>
			) : null}

			<div className={CARD_CLASS}>
				<h2 className={SECTION_HEADING_CLASS}>Project enrollments</h2>
				{/* Kept a sibling of the heading rather than wrapped around it: the heading
				    stays the section's own accessible name, and the action reads as one of
				    the section's contents. */}
				{worker.viewerIsOwner ? (
					<div className="mb-4">
						<button
							type="button"
							onClick={() => setEnrollOpen(true)}
							className={SECONDARY_BUTTON_CLASS}
						>
							Enroll in a project
						</button>
					</div>
				) : null}
				{worker.enrollments.length === 0 ? (
					<p className="text-sm text-zinc-400">
						{worker.viewerIsOwner
							? 'This machine is not enrolled in any project yet. Offer it to one with Enroll in a project — it then waits for that project’s administrator to approve it.'
							: 'This machine is not enrolled in any project you can see. Offering it to a project is its owner’s action.'}
					</p>
				) : (
					<ul className="space-y-4">
						{worker.enrollments.map((enrollment) => (
							<WorkerEnrollmentCard
								key={enrollment.enrollmentId}
								enrollment={enrollment}
								workerName={worker.displayName}
								capabilities={worker.capabilities}
								supportedPhases={worker.supportedPhases}
								declaredRepository={worker.repository}
								projectDisabledPhases={projectDisabledPhases.get(enrollment.projectId) ?? []}
								projectName={projectNames.get(enrollment.projectId) ?? enrollment.projectId}
								viewerIsOwner={worker.viewerIsOwner}
								ownerName={ownerName}
								onChanged={onChanged}
							/>
						))}
					</ul>
				)}
			</div>

			{/* Last child of the page rather than inside the enrollments card, so an open
			    modal's DOM doesn't land inside that section's subtree. */}
			{worker.viewerIsOwner ? (
				<WorkerEnrollDialog
					open={enrollOpen}
					onOpenChange={setEnrollOpen}
					workerId={worker.workerId}
					workerName={worker.displayName}
					capabilities={worker.capabilities}
					enrolledProjectIds={worker.enrollments.map((enrollment) => enrollment.projectId)}
					onChanged={onChanged}
				/>
			) : null}
		</div>
	);
}
