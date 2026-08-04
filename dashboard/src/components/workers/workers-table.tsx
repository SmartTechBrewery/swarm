import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { WorkItemCell } from '@/components/runs/work-item-cell.js';
import { Modal, ModalFooter } from '@/components/ui/modal.js';
import { formatRelativeTime } from '@/lib/format.js';
import { trpc, trpcClient } from '@/lib/trpc.js';
import type {
	OwnerWorker,
	WorkerEnrollmentStatus,
	WorkerRosterEntry,
	WorkerRow,
} from '@/types/workers.js';

/**
 * The worker roster (issue #133): one row per worker the viewer may see, with
 * connectivity, declared CLI capabilities, the job it is executing, and — per
 * visible project — whether it is available for automatic dispatch.
 *
 * The one operable affordance (issue #282) is the owner-controlled **sharing
 * consent** switch, which the **Available** column is named for: it is actionable
 * only for an enrollment the signed-in operator *owns* — established by its
 * presence in `workers.listMine`, never inferred from a client-supplied owner
 * claim — and toggling it calls `workers.setConsent`, which re-checks ownership
 * server-side. Disabling opens a confirmation because it blocks *future*
 * automatic dispatch immediately; it never kills a running agent. Someone else's
 * worker shows the same switch **disabled**, so a project administrator can see
 * that an enrolled worker isn't shared without gaining a control over it.
 * Approval, routing, and machine lifecycle stay off this screen entirely.
 *
 * Consent state comes from `workers.roster` (readable by any project
 * `contributor`), so that unavailability is visible with no machine path, token,
 * or credential. The screen deliberately shows *less* than the roster read model
 * carries (issue #473): approval state, effective allowed CLIs, and per-project
 * busy/idle were dropped from the old Enrollment cell rather than crowding one
 * column with five unrelated facts — busy already reads off **Active job**.
 */

interface WorkersTableProps {
	workers: WorkerRow[];
	refetchInterval?: number;
}

/**
 * Fixed desktop column widths (issue #473). The table spans its container, and
 * the freed width goes to the Active job description — the one cell holding prose
 * — rather than to empty space on the right; everything else is sized to its own
 * content.
 */
const COLUMN_WIDTHS = {
	machine: 'w-[16%]',
	owner: 'w-[14%]',
	status: 'w-[18%]',
	capabilities: 'w-[12%]',
	activeJob: 'w-[30%]',
	available: 'w-[10%]',
};

/** A stable key for one `(worker, project)` enrollment across the roster/owner read models. */
function enrollmentKey(workerId: string, projectId: string): string {
	return `${workerId}::${projectId}`;
}

/** Online is a live status dot; offline stays neutral with its last-seen time beside it. */
function ConnectionCell({ worker }: { worker: WorkerRow }) {
	if (worker.connection === 'online') {
		return (
			<span className="inline-flex items-center gap-2 text-sm text-zinc-200">
				<span className="h-2 w-2 rounded-full bg-emerald-500 ring-4 ring-emerald-500/10" />
				Online
			</span>
		);
	}
	return (
		<span className="inline-flex items-center gap-2 text-sm text-zinc-400">
			<span className="h-2 w-2 rounded-full bg-zinc-600 ring-4 ring-zinc-600/10" />
			Offline
			<span
				className="text-xs text-zinc-500"
				title={worker.lastSeenAt ? new Date(worker.lastSeenAt).toLocaleString() : undefined}
			>
				{worker.lastSeenAt ? `· ${formatRelativeTime(worker.lastSeenAt)}` : '· Never connected'}
			</span>
		</span>
	);
}

/** An accessible on/off switch for sharing consent — read-only unless the viewer owns the worker. */
function ConsentSwitch({
	sharing,
	pending,
	readOnly,
	label,
	title,
	onToggle,
}: {
	sharing: boolean;
	pending: boolean;
	/** A worker the viewer doesn't own: the state is shown, the control is not offered. */
	readOnly: boolean;
	label: string;
	title: string;
	onToggle: (next: boolean) => void;
}) {
	const disabled = pending || readOnly;
	return (
		<button
			type="button"
			role="switch"
			aria-checked={sharing}
			aria-label={label}
			title={title}
			disabled={disabled}
			onClick={() => {
				if (!readOnly) onToggle(!sharing);
			}}
			className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-violet-500 focus:ring-offset-1 focus:ring-offset-panel disabled:cursor-not-allowed ${
				readOnly ? 'opacity-60' : 'disabled:opacity-50'
			} ${sharing ? 'bg-emerald-600' : 'bg-zinc-700'}`}
		>
			<span
				className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
					sharing ? 'translate-x-3.5' : 'translate-x-0.5'
				}`}
			/>
		</button>
	);
}

interface AvailabilityCellProps {
	worker: WorkerRow;
	projectNames: Map<string, string>;
	rosterByKey: Map<string, WorkerRosterEntry>;
	ownedEnrollmentIdByKey: Map<string, string>;
	pendingEnrollmentId: string | undefined;
	inlineErrorEnrollmentId: string | undefined;
	errorMessage: string | null;
	onToggle: (args: {
		enrollmentId: string;
		projectId: string;
		workerName: string;
		projectName: string;
		next: boolean;
	}) => void;
}

/**
 * Availability for automatic dispatch, one switch per visible enrollment: the
 * consent state, actionable for a worker the viewer owns and read-only otherwise.
 * The project each switch belongs to is carried by its accessible name and
 * tooltip rather than a repeated label — a worker is usually enrolled in one
 * project, and naming it in the cell is what made the old column unreadable.
 *
 * A switch is withheld entirely while the project's roster query is loading or
 * failed: consent is unknown then, and rendering an "off" switch would state
 * something the server never said.
 */
function AvailabilityCell({
	worker,
	projectNames,
	rosterByKey,
	ownedEnrollmentIdByKey,
	pendingEnrollmentId,
	inlineErrorEnrollmentId,
	errorMessage,
	onToggle,
}: AvailabilityCellProps) {
	if (worker.enrollments.length === 0) {
		return <span className="text-sm text-zinc-500">—</span>;
	}
	return (
		<ul className="space-y-2">
			{worker.enrollments.map((enrollment) => {
				const key = enrollmentKey(worker.workerId, enrollment.projectId);
				const roster = rosterByKey.get(key);
				const projectName = projectNames.get(enrollment.projectId) ?? enrollment.projectId;
				const ownedEnrollmentId = ownedEnrollmentIdByKey.get(key);
				if (!roster) {
					return (
						<li key={enrollment.projectId}>
							<span className="text-sm text-zinc-500" title="Sharing state unavailable">
								—
							</span>
						</li>
					);
				}
				return (
					<li key={enrollment.projectId} className="space-y-1">
						<ConsentSwitch
							sharing={roster.sharingConsent}
							pending={ownedEnrollmentId !== undefined && pendingEnrollmentId === ownedEnrollmentId}
							readOnly={ownedEnrollmentId === undefined}
							label={
								ownedEnrollmentId
									? `Share ${worker.displayName} with ${projectName}`
									: `Sharing of ${worker.displayName} with ${projectName}`
							}
							title={
								ownedEnrollmentId
									? `Share ${worker.displayName} with ${projectName}`
									: `Only ${worker.owner?.displayName ?? 'the owner'} can change sharing for ${projectName}`
							}
							onToggle={(next) => {
								if (!ownedEnrollmentId) return;
								onToggle({
									enrollmentId: ownedEnrollmentId,
									projectId: enrollment.projectId,
									workerName: worker.displayName,
									projectName,
									next,
								});
							}}
						/>
						{ownedEnrollmentId !== undefined &&
						inlineErrorEnrollmentId === ownedEnrollmentId &&
						errorMessage ? (
							<div className="text-[10px] text-red-400">{errorMessage}</div>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}

interface ConfirmTarget {
	enrollmentId: string;
	projectId: string;
	workerName: string;
	projectName: string;
}

export function WorkersTable({ workers, refetchInterval }: WorkersTableProps) {
	const queryClient = useQueryClient();

	// Resolve projects the same way RunsTable does — names for the consent
	// switches' accessible labels, repo for an active job's PR link. The roster
	// falls back to the raw project id when this auxiliary lookup is unavailable.
	const projectsQuery = useQuery(trpc.projects.list.queryOptions());
	const projectNames = new Map(projectsQuery.data?.map((p) => [p.id, p.name]) ?? []);
	const projectRepos = new Map(projectsQuery.data?.map((p) => [p.id, p.repo]) ?? []);

	// The signed-in operator's own workers — presence here is what authorizes an
	// actionable consent switch for an enrollment.
	const mineQuery = useQuery({
		...trpc.workers.listMine.queryOptions(),
		refetchInterval,
	});

	// Every project any visible worker is enrolled in is, by construction, one the
	// viewer may access (the server strips inaccessible enrollments), so a roster
	// query per project is authorized. This supplies consent state for all viewers,
	// including a project admin looking at others' workers.
	const projectIds = [...new Set(workers.flatMap((w) => w.enrollments.map((e) => e.projectId)))];
	const rosterQueries = useQueries({
		queries: projectIds.map((projectId) => ({
			...trpc.workers.roster.queryOptions({ projectId }),
			refetchInterval,
		})),
	});

	const rosterByKey = new Map<string, WorkerRosterEntry>();
	rosterQueries.forEach((query) => {
		for (const entry of query.data ?? []) {
			rosterByKey.set(enrollmentKey(entry.workerId, entry.projectId), entry);
		}
	});

	const ownedEnrollmentIdByKey = new Map<string, string>();
	for (const owned of mineQuery.data ?? []) {
		for (const enrollment of owned.enrollments) {
			ownedEnrollmentIdByKey.set(
				enrollmentKey(owned.workerId, enrollment.projectId),
				enrollment.enrollmentId,
			);
		}
	}

	const [confirmTarget, setConfirmTarget] = useState<ConfirmTarget | null>(null);

	const consentMutation = useMutation({
		mutationFn: (variables: { enrollmentId: string; projectId: string; sharingConsent: boolean }) =>
			trpcClient.workers.setConsent.mutate({
				enrollmentId: variables.enrollmentId,
				sharingConsent: variables.sharingConsent,
			}),
		onSuccess: (updated, variables) => {
			// Reflect the new consent (and the derived routable state) immediately in
			// both canonical caches so the row flips before the refetch lands…
			// The write path returns the raw enrollment row, whose id is the
			// enrollment id the read models expose as `enrollmentId`.
			patchRosterCache(variables.projectId, updated.id, updated.sharingConsent, updated.status);
			patchMineCache(updated.id, updated.sharingConsent, updated.status);
			// …then invalidate both for authoritative reconciliation.
			queryClient.invalidateQueries({
				queryKey: trpc.workers.roster.queryOptions({ projectId: variables.projectId }).queryKey,
			});
			queryClient.invalidateQueries({
				queryKey: trpc.workers.listMine.queryOptions().queryKey,
			});
			setConfirmTarget(null);
		},
	});

	function patchRosterCache(
		projectId: string,
		enrollmentId: string,
		sharingConsent: boolean,
		status: WorkerEnrollmentStatus,
	) {
		queryClient.setQueryData<WorkerRosterEntry[]>(
			trpc.workers.roster.queryOptions({ projectId }).queryKey,
			(old) =>
				old?.map((entry) =>
					entry.enrollmentId === enrollmentId
						? { ...entry, sharingConsent, isRoutable: status === 'active' && sharingConsent }
						: entry,
				),
		);
	}

	function patchMineCache(
		enrollmentId: string,
		sharingConsent: boolean,
		status: WorkerEnrollmentStatus,
	) {
		queryClient.setQueryData<OwnerWorker[]>(trpc.workers.listMine.queryOptions().queryKey, (old) =>
			old?.map((owned) => ({
				...owned,
				enrollments: owned.enrollments.map((enrollment) =>
					enrollment.enrollmentId === enrollmentId
						? { ...enrollment, sharingConsent, isRoutable: status === 'active' && sharingConsent }
						: enrollment,
				),
			})),
		);
	}

	function handleToggle(args: {
		enrollmentId: string;
		projectId: string;
		workerName: string;
		projectName: string;
		next: boolean;
	}) {
		if (args.next) {
			// Enabling has no destructive consequence — apply it directly.
			consentMutation.mutate({
				enrollmentId: args.enrollmentId,
				projectId: args.projectId,
				sharingConsent: true,
			});
			return;
		}
		// Disabling blocks future dispatch — confirm first.
		setConfirmTarget({
			enrollmentId: args.enrollmentId,
			projectId: args.projectId,
			workerName: args.workerName,
			projectName: args.projectName,
		});
	}

	function confirmDisable() {
		if (!confirmTarget) return;
		consentMutation.mutate({
			enrollmentId: confirmTarget.enrollmentId,
			projectId: confirmTarget.projectId,
			sharingConsent: false,
		});
	}

	const pendingEnrollmentId = consentMutation.isPending
		? consentMutation.variables?.enrollmentId
		: undefined;
	// Surface an inline (non-modal) error only for a failed *enable*; a failed
	// disable is shown inside its confirmation dialog, which stays open.
	const inlineErrorEnrollmentId =
		consentMutation.isError && consentMutation.variables?.sharingConsent === true && !confirmTarget
			? consentMutation.variables?.enrollmentId
			: undefined;

	return (
		<div className="border border-zinc-800 rounded-md overflow-hidden bg-panel/20 shadow-sm">
			<table className="w-full table-fixed text-left border-collapse">
				<colgroup>
					<col className={COLUMN_WIDTHS.machine} />
					<col className={COLUMN_WIDTHS.owner} />
					<col className={COLUMN_WIDTHS.status} />
					<col className={COLUMN_WIDTHS.capabilities} />
					<col className={COLUMN_WIDTHS.activeJob} />
					<col className={COLUMN_WIDTHS.available} />
				</colgroup>
				<thead>
					<tr className="bg-zinc-800/30 border-b border-zinc-800">
						<th className="px-3 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
							Machine
						</th>
						<th className="px-3 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
							Owner
						</th>
						<th className="px-3 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
							Status
						</th>
						<th className="px-3 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
							Capabilities
						</th>
						<th className="px-3 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
							Active job
						</th>
						<th className="px-3 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
							Available
						</th>
					</tr>
				</thead>
				<tbody className="divide-y divide-zinc-800/60">
					{workers.map((worker) => (
						<tr key={worker.workerId} className="hover:bg-zinc-800/40 transition-colors">
							<td className="px-3 py-3 align-top text-sm font-medium text-zinc-100 break-words">
								{worker.displayName}
							</td>
							<td className="px-3 py-3 align-top text-sm text-zinc-300 break-words">
								{worker.owner ? (
									<span title={worker.owner.identifier}>{worker.owner.displayName}</span>
								) : (
									<span className="text-zinc-500">—</span>
								)}
							</td>
							<td className="px-3 py-3 align-top">
								<ConnectionCell worker={worker} />
							</td>
							<td className="px-3 py-3 align-top">
								<div className="flex flex-wrap gap-1">
									{worker.capabilities.length > 0 ? (
										worker.capabilities.map((cli) => (
											<span
												key={cli}
												className="px-2 py-0.5 text-[10px] uppercase font-mono font-bold tracking-wider bg-zinc-850 text-zinc-400 rounded border border-zinc-800"
											>
												{cli}
											</span>
										))
									) : (
										<span className="text-sm text-zinc-500">—</span>
									)}
								</div>
							</td>
							<td className="px-3 py-3 align-top text-sm">
								{worker.currentRun ? (
									// The same description `/runs` gives the run, with the title
									// linking to its detail page — the run id itself is a UUID and
									// says nothing about the work (issue #473).
									<WorkItemCell
										run={worker.currentRun}
										repo={projectRepos.get(worker.currentRun.projectId)}
										titleHref={`/runs/${worker.currentRun.runId}`}
									/>
								) : (
									<span className="text-zinc-500">—</span>
								)}
							</td>
							<td className="px-3 py-3 align-top">
								<AvailabilityCell
									worker={worker}
									projectNames={projectNames}
									rosterByKey={rosterByKey}
									ownedEnrollmentIdByKey={ownedEnrollmentIdByKey}
									pendingEnrollmentId={pendingEnrollmentId}
									inlineErrorEnrollmentId={inlineErrorEnrollmentId}
									errorMessage={consentMutation.error?.message ?? null}
									onToggle={handleToggle}
								/>
							</td>
						</tr>
					))}
				</tbody>
			</table>

			<Modal
				open={!!confirmTarget}
				onClose={() => {
					if (!consentMutation.isPending) setConfirmTarget(null);
				}}
				title="Stop sharing this worker?"
			>
				<div className="space-y-4">
					<p className="text-sm text-zinc-400 leading-relaxed">
						Disabling sharing for{' '}
						<span className="font-semibold text-zinc-200">{confirmTarget?.workerName}</span> on{' '}
						<span className="font-mono text-zinc-300">{confirmTarget?.projectName}</span> blocks{' '}
						<span className="text-zinc-200">future automatic dispatch</span> immediately. It{' '}
						<span className="text-zinc-200">does not stop a run already in progress</span> — the
						current run finishes normally.
					</p>

					{consentMutation.isError && confirmTarget ? (
						<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
							{consentMutation.error.message}
						</div>
					) : null}

					<ModalFooter
						primary={
							<button
								type="button"
								onClick={confirmDisable}
								disabled={consentMutation.isPending}
								className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-red-600 rounded-md hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
							>
								{consentMutation.isPending ? 'Stopping…' : 'Stop sharing'}
							</button>
						}
						secondary={
							<button
								type="button"
								onClick={() => setConfirmTarget(null)}
								disabled={consentMutation.isPending}
								className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
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
