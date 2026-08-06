import { useMutation } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { WorkItemCell } from '@/components/runs/work-item-cell.js';
import { Badge } from '@/components/ui/badge.js';
import { WorkerEnrollmentCard } from '@/components/workers/worker-enrollment-card.js';
import { formatPhase, formatRelativeTime } from '@/lib/format.js';
import { trpcClient } from '@/lib/trpc.js';
import { useDraftSync } from '@/lib/use-draft-sync.js';
import type { WorkerDetail } from '@/types/workers.js';

/**
 * One machine in full (issue #477) — where the Workers table is the scannable
 * index, this is where an operator understands and administers a single worker.
 * It is grouped into sections rather than a field dump: identity and owner,
 * connectivity, the two declared-capability axes, the active job, and one block
 * per project the machine is enrolled in ({@link WorkerEnrollmentCard}, which owns
 * the editable values and their authorization).
 *
 * **Self-declared facts are read-only.** A daemon declares its `capabilities` and
 * `supportedPhases` at handshake and re-declares them on every reconnect, so the
 * view reports them and never offers to edit them — an edit here would only make
 * the dashboard disagree with the machine until its next heartbeat.
 *
 * **The machine's own name is the one Identity-card fact that *is* editable** —
 * unlike the self-declared facts above, `displayName` is the owner's own label,
 * not something the daemon states, so there is nothing for an edit to disagree
 * with ({@link WorkerNameField}). Gated by `viewerIsOwner` exactly like the
 * enrollment card's owner-controlled values, and by the same strict-ownership
 * check server-side (`workers.rename`, no `instanceAdmin` override).
 *
 * **Nothing secret is on this surface**, by construction rather than by filtering:
 * its only source is the `workers.getById` read model, which names each safe field
 * explicitly, so no machine path, worker credential, credential hash, or project
 * PAT exists to leak. Enrolling the machine into a *new* project is deliberately
 * not here: offering a machine to a project is a different act from administering
 * an existing enrollment, and it stays with `swarm workers enroll` / the owner's
 * own flow.
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
			{phases.map((phase) => (
				<Badge key={phase}>{formatPhase(phase)}</Badge>
			))}
		</div>
	);
}

interface WorkerDetailViewProps {
	worker: WorkerDetail;
	/** Project id → display name, so an enrollment block names its project. */
	projectNames: Map<string, string>;
	/** Project id → repo, for the active job's provider reference. */
	projectRepos: Map<string, string>;
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
	projectRepos,
	projectDisabledPhases,
	onChanged,
}: WorkerDetailViewProps) {
	const ownerName = worker.owner?.displayName ?? 'the owner';

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
				<h2 className={SECTION_HEADING_CLASS}>Declared capabilities</h2>
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
				</div>
				<p className="text-xs text-zinc-500 mt-4">
					Declared by the machine's own daemon at handshake, on two independent axes. Reported here,
					never editable — editing them would make this screen disagree with the machine. A daemon
					on an older build can declare fewer phases than this one runs; which of them a project may
					actually give this machine is the enrollment's Allowed pipeline phases, below.
				</p>
			</div>

			<div className={CARD_CLASS}>
				<h2 className={SECTION_HEADING_CLASS}>Active job</h2>
				{worker.currentRun ? (
					<div className="space-y-2">
						<WorkItemCell
							run={worker.currentRun}
							repo={projectRepos.get(worker.currentRun.projectId)}
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

			<div className={CARD_CLASS}>
				<h2 className={SECTION_HEADING_CLASS}>Project enrollments</h2>
				{worker.enrollments.length === 0 ? (
					<p className="text-sm text-zinc-400">
						This machine is not enrolled in any project you can see. Offering it to a project is its
						owner's action — <span className="font-mono">swarm workers enroll</span>.
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
		</div>
	);
}
