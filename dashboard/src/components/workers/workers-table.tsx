import {
	type QueryClient,
	useMutation,
	useQueries,
	useQuery,
	useQueryClient,
} from '@tanstack/react-query';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';
import { WorkItemCell } from '@/components/runs/work-item-cell.js';
import { Badge } from '@/components/ui/badge.js';
import { buttonClass } from '@/components/ui/button.js';
import { Modal, ModalFooter } from '@/components/ui/modal.js';
import { ToggleSwitch } from '@/components/ui/toggle-switch.js';
import { WorkerBuildBadge, WorkerUpdatingBadge } from '@/components/workers/worker-build.js';
import { formatPhase, formatRelativeTime } from '@/lib/format.js';
import { viewerAdministersProject } from '@/lib/project-nav.js';
import { trpc, trpcClient } from '@/lib/trpc.js';
import { ENROLLMENT_STATUS_LABELS } from '@/lib/worker-enrollment-view.js';
import type {
	OwnerWorker,
	WorkerEnrollmentStatus,
	WorkerRosterEntry,
	WorkerRow,
} from '@/types/workers.js';

/**
 * The worker roster (issue #133): one row per worker the viewer may see, with
 * connectivity, effective CLI capabilities, the job it is executing, and — per
 * visible project — whether it is available for automatic dispatch.
 *
 * The first operable affordance (issue #282) is the owner-controlled **sharing
 * consent** switch, which the **Available** column is named for: it is actionable
 * only for an enrollment the signed-in operator *owns* — established by its
 * presence in `workers.listMine`, never inferred from a client-supplied owner
 * claim — and toggling it calls `workers.setConsent`, which re-checks ownership
 * server-side. Disabling opens a confirmation because it blocks *future*
 * automatic dispatch immediately; it never kills a running agent. Someone else's
 * worker shows the same switch **disabled**, so a project administrator can see
 * that an enrolled worker isn't shared without gaining a control over it.
 * Routing and machine lifecycle stay off this screen entirely.
 *
 * The second is the **Enrolled** column (issue #1035) — the *other* half of the
 * routability predicate (`status === 'active' && sharingConsent`), which is why it
 * reads immediately before **Available**. It is the same switch over the same
 * one-row-per-enrollment shape, and everything that differs about it follows from
 * the axis having a different owner: enrollment status is the **project
 * administrator's**, so the switch is actionable only where
 * `projects.viewerAccess` says the viewer administers *that enrollment's* project
 * — the same authorization `workers.setStatus`, the mutation it calls, re-checks
 * server-side — and read-only everywhere else, exactly as **Available** is for a
 * machine the viewer doesn't own. Suspending takes the same confirmation
 * disabling sharing does, because it has the identical consequence. Approving a
 * `pending` enrollment is *not* offered here: a third state cannot be an on/off
 * switch without reading as one of the two it isn't, so a pending enrollment
 * renders as a marker and its approval stays on the machine's own detail page,
 * where the administrator's other acts already live.
 *
 * Consent and enrollment status both come from `workers.roster` (readable by any
 * project `contributor`), so both are visible with no machine path, token,
 * or credential. The table deliberately shows *less* than the roster read model
 * carries (issue #473): approval state and per-project busy/idle were dropped
 * from the old Enrollment cell rather than crowding one column with five
 * unrelated facts — busy already reads off **Active job**. Those facts, and the
 * controls that administer them, now live one click away on the per-worker
 * detail view (issue #477): a row click opens it, so the table stays the
 * scannable index. **Enrolled** is not that cell coming back: it is one fact with
 * one control in a column of its own, on the same terms **Available** already
 * held, and the rest of what the old cell crowded in stays on the detail view.
 * Effective allowed CLIs stayed, but folded into
 * **Capabilities** as a cross-project union ({@link effectiveClis}) rather than
 * broken out per project — a per-project breakdown is what the detail view is
 * for.
 *
 * The *non*-operable additions since are the two **build marks** beside a machine's
 * name (`worker-build.tsx`). The first is staleness (issue #925): a machine whose
 * declared SWARM build is not the control plane's own carries an `Outdated` badge,
 * so "which workers are behind?" is answerable by scanning this table rather than by
 * asking each machine's operator. The second is an update still in flight (issue
 * #978): a machine with an outstanding request carries `Updating`, listed first
 * because it is the more recent fact and the one that explains the other. Both are
 * marks and nothing more — dispatch is unaffected — and they earn no column of their
 * own, because they are rare per-row exceptions rather than facts every row carries.
 * Which build, and what it is being compared against, are on the detail view.
 *
 * **They are shown together, never one instead of the other.** A machine waiting on
 * an update usually *is* on a differing build, and the two say different things:
 * `Outdated` that nobody has acted, `Updating` that somebody has. Hiding the first
 * while the second shows would make the table lie by omission for exactly the window
 * an operator is watching it.
 *
 * The **Draining marker** on the Status cell (issue #926) is the same kind of
 * addition: a machine an operator has taken out of the dispatch pool (issue #919) is
 * marked so "which machines are out of the pool?" is answerable by scanning this
 * table. Draining *is* acted on by dispatch, but not by this table — the control
 * that sets and clears it is the machine's own page, where machine-scoped controls
 * live.
 *
 * Navigation to that detail view is the **row** plus a named control on the
 * Machine cell (issue #752). It used to be a trailing `ChevronRight` cell of its
 * own, which spent a column on an arrow that only repeated what the whole
 * clickable row already did; the machine name — the row's identifying text — is
 * the affordance an operator aims at anyway, so it became the button. A
 * `role="button"` `<tr>` was not the alternative: it trips Biome a11y and is
 * worse for AT than a real control.
 *
 * The one *other* operable affordance is optional and belongs to the project
 * tab: with {@link WorkersTableProps.reorder} supplied, each row gains up/down
 * controls for the project's configured worker order (issue #750 phase 2).
 * Absent the prop there is no column at all, which is how `/workers` and a
 * non-administrator's project tab render — the order is still the server's
 * either way, and this table never re-sorts what it was handed.
 */

/**
 * The reorder affordance for the project-scoped tab (issue #750 phase 2), passed
 * whole or not at all: the table renders the column only when a caller offers
 * one, so the global `/workers` screen and a non-administrator's project tab get
 * no controls rather than disabled ones for a thing they may not do.
 *
 * The table stays presentational — it neither mutates nor re-sorts. `onMove`
 * reports the intent; the order it renders next is whatever the server's response
 * put in the cache.
 */
export interface WorkersTableReorder {
	onMove: (workerId: string, direction: 'up' | 'down') => void;
	/**
	 * The worker a move is in flight for. Every control in the column is disabled
	 * while one is set, not just this row's: a second move would be computed
	 * against an order the server is in the middle of changing.
	 */
	pendingWorkerId?: string;
	/** A rejected move, surfaced inline on the row it was attempted from. */
	error?: { workerId: string; message: string } | null;
}

interface WorkersTableProps {
	workers: WorkerRow[];
	refetchInterval?: number;
	/**
	 * Opens one machine's detail view (issue #477). The table stays the scannable
	 * index and knows nothing about the router: the route passes a navigate
	 * callback, exactly as the Agent Configuration summary hands its phase rows one.
	 */
	onSelectWorker?: (workerId: string) => void;
	/** Present ⇒ each row can be moved in the project's worker order (issue #750 phase 2). */
	reorder?: WorkersTableReorder;
}

/**
 * Fixed desktop column widths (issue #473). The table spans its container, and
 * the freed width goes to the Active job description — the one cell holding prose
 * — rather than to empty space on the right; everything else is sized to its own
 * content. Status needs little: `Online` is two words and an offline row's
 * last-seen time wraps under it, so half its former width goes to Capabilities,
 * whose CLI chips otherwise wrap one-per-line for a three-CLI machine.
 *
 * Active job is also where the reorder column takes its width from, where the
 * removed row-open chevron's went (issue #752), and where **Enrolled**'s came from
 * (issue #1035): the prose cell absorbs and gives back spare width without any
 * other column changing size, so every variant of the table reads identically
 * column-for-column.
 *
 * **Enrolled** and **Available** are sized identically because they hold the same
 * thing — one switch per visible enrollment — and a pair of twins that differed in
 * width would read as a difference in what they carry. Nine percent rather than the
 * ten **Available** had alone: a switch is 36px, so the extra point bought nothing,
 * and the prose column is where it is worth more.
 */
const COLUMN_WIDTHS = {
	machine: 'w-[16%]',
	owner: 'w-[14%]',
	status: 'w-[9%]',
	capabilities: 'w-[20%]',
	activeJob: 'w-[23%]',
	activeJobWithReorder: 'w-[16%]',
	enrolled: 'w-[9%]',
	available: 'w-[9%]',
	// The two stacked-side-by-side reorder arrows — the narrowest column that fits them.
	reorder: 'w-[7%]',
};

/** Icon-button recipe for a row's reorder actions (ai/DESIGN_SYSTEM.md §4). */
const ROW_ACTION_CLASS =
	'p-1.5 rounded text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800/60 focus:outline-none focus:ring-1 focus:ring-violet-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

/** A stable key for one `(worker, project)` enrollment across the roster/owner read models. */
function enrollmentKey(workerId: string, projectId: string): string {
	return `${workerId}::${projectId}`;
}

/**
 * Two independent facts, stacked (issue #926). The first is heartbeat liveness:
 * online is a live status dot, offline stays neutral with its last-seen time beside
 * it. The second is whether an operator has taken the machine **out of the dispatch
 * pool** so it can be restarted (issue #919) — which is not a liveness fact at all,
 * so it is a marker *under* the first line rather than a third value of it: a
 * draining machine that is online is still Online, and is merely given no new work.
 * Amber, the tree's "operator attention, not an error" hue, for the same reason.
 */
function ConnectionCell({ worker }: { worker: WorkerRow }) {
	return (
		<div className="space-y-1.5">
			{worker.connection === 'online' ? (
				<span className="inline-flex items-center gap-2 text-sm text-zinc-200">
					<span className="h-2 w-2 rounded-full bg-emerald-500 ring-4 ring-emerald-500/10" />
					Online
				</span>
			) : (
				// Wrapping, not one line: the narrow Status column (see COLUMN_WIDTHS) fits
				// the word and its dot, and drops the last-seen time onto a second line.
				<span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-zinc-400">
					<span className="h-2 w-2 rounded-full bg-zinc-600 ring-4 ring-zinc-600/10" />
					Offline
					<span
						className="text-xs text-zinc-500"
						title={worker.lastSeenAt ? new Date(worker.lastSeenAt).toLocaleString() : undefined}
					>
						{worker.lastSeenAt ? `· ${formatRelativeTime(worker.lastSeenAt)}` : '· Never connected'}
					</span>
				</span>
			)}
			{worker.drainingSince ? (
				<div>
					<Badge
						tone="caution"
						title={`Out of the dispatch pool since ${formatRelativeTime(worker.drainingSince)} — no new work is given to this machine`}
					>
						Draining
					</Badge>
				</div>
			) : null}
		</div>
	);
}

/**
 * The CLIs at least one visible enrollment actually allows — a subset of the
 * machine's declared `capabilities`. Declared-but-unallowed CLIs (e.g. a
 * machine that speaks three but is only enrolled with one turned on) never ran
 * here and would mislead an operator scanning the roster for what a project can
 * actually dispatch. Preserves `capabilities`' own order rather than the
 * enrollments' insertion order, so the chips read the same as the worker detail
 * screen's declared-capabilities list. Empty for an un-enrolled machine — no
 * project has allowed anything on it yet.
 */
function effectiveClis(worker: WorkerRow): string[] {
	const allowed = new Set(
		worker.enrollments
			.filter((enrollment) => enrollment.status === 'active')
			.flatMap((enrollment) => enrollment.allowedClis),
	);
	return worker.capabilities.filter((cli) => allowed.has(cli));
}

/**
 * What the machine can run: the CLIs at least one visible enrollment allows — the
 * *effective* set ({@link effectiveClis}), not the raw declared capabilities.
 *
 * No phase is listed here (issue #542). This column used to lead with an amber
 * `PLANNING` badge, on the argument that Planning was the one capability an
 * operator could not infer from the machine's tooling because a DB-free remote
 * daemon refused it; issue #536 made every daemon run every phase, so the badge
 * distinguished nothing while still reading as though Planning were a special,
 * differently-trusted thing. The declared phase repertoire — which still varies
 * across daemon builds (issue #467) — is on the worker detail screen, in full and
 * with no phase promoted over another.
 */
function CapabilitiesCell({ worker }: { worker: WorkerRow }) {
	const clis = effectiveClis(worker);
	if (clis.length === 0) {
		return <span className="text-sm text-zinc-500">—</span>;
	}
	return (
		<div className="flex flex-wrap gap-1">
			{clis.map((cli) => (
				<Badge key={cli}>{cli}</Badge>
			))}
		</div>
	);
}

/**
 * One boolean of one `(worker, project)` enrollment, as the shared design-system
 * switch (`components/ui/toggle-switch.tsx`, the one the Agent Configuration phase
 * toggles use), so a switch looks and behaves the same everywhere. Shared by both
 * switch columns — **Available**'s sharing consent and **Enrolled**'s enrollment
 * status — which differ in who may operate them and in nothing else the control
 * itself can see.
 *
 * Read-only for a viewer who may not change *this* value: it renders disabled, with
 * the `title` saying whose it is. `readOnly` is re-checked in `onChange` as well as
 * being passed to `disabled`, so a disabled switch cannot report an intent even if
 * something contrives to click it.
 */
function EnrollmentSwitch({
	checked,
	pending,
	readOnly,
	label,
	title,
	onToggle,
}: {
	checked: boolean;
	pending: boolean;
	/** A value the viewer may not change: the state is shown, the control is not offered. */
	readOnly: boolean;
	label: string;
	title: string;
	onToggle: (next: boolean) => void;
}) {
	return (
		<ToggleSwitch
			checked={checked}
			label={label}
			title={title}
			disabled={pending || readOnly}
			onChange={() => {
				if (!readOnly) onToggle(!checked);
			}}
		/>
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
						<EnrollmentSwitch
							checked={roster.sharingConsent}
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

interface EnrolledCellProps {
	worker: WorkerRow;
	projectNames: Map<string, string>;
	rosterByKey: Map<string, WorkerRosterEntry>;
	/** The visible projects the viewer administers — see {@link WorkersTable}'s access reads. */
	administeredProjectIds: ReadonlySet<string>;
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
 * Enrollment status, one switch per visible enrollment (issue #1035): on is
 * `active`, off is `suspended`, and the switch is actionable only for a project the
 * viewer administers. Same shape, labelling and read-only treatment as
 * {@link AvailabilityCell} beside it — the two columns are the two halves of the
 * dispatch gate's own predicate, so they have to read as one kind of thing.
 *
 * **A `pending` enrollment is a marker, not a switch.** The axis has three states
 * and a switch has two, so rendering one would put a never-approved enrollment on
 * the side of either "enrolled" or "suspended" — and it is neither. The badge states
 * the third state instead, and the act that resolves it (approval, a different
 * mutation) stays on the machine's detail page rather than being smuggled into a
 * switch that would then mean two things.
 *
 * A switch is withheld entirely while the project's roster query is loading or
 * failed, for {@link AvailabilityCell}'s reason: the status is unknown then, and an
 * off switch would state a suspension the server never reported.
 */
function EnrolledCell({
	worker,
	projectNames,
	rosterByKey,
	administeredProjectIds,
	pendingEnrollmentId,
	inlineErrorEnrollmentId,
	errorMessage,
	onToggle,
}: EnrolledCellProps) {
	if (worker.enrollments.length === 0) {
		return <span className="text-sm text-zinc-500">—</span>;
	}
	return (
		<ul className="space-y-2">
			{worker.enrollments.map((enrollment) => {
				const roster = rosterByKey.get(enrollmentKey(worker.workerId, enrollment.projectId));
				const projectName = projectNames.get(enrollment.projectId) ?? enrollment.projectId;
				if (!roster) {
					return (
						<li key={enrollment.projectId}>
							<span className="text-sm text-zinc-500" title="Enrollment status unavailable">
								—
							</span>
						</li>
					);
				}
				if (roster.status === 'pending') {
					return (
						<li key={enrollment.projectId}>
							<Badge
								tone="caution"
								title={`${ENROLLMENT_STATUS_LABELS.pending} — neither enrolled nor suspended. A ${projectName} administrator approves it on this machine's own page.`}
							>
								Pending
							</Badge>
						</li>
					);
				}
				const canAdminister = administeredProjectIds.has(enrollment.projectId);
				return (
					<li key={enrollment.projectId} className="space-y-1">
						<EnrollmentSwitch
							checked={roster.status === 'active'}
							pending={pendingEnrollmentId === roster.enrollmentId}
							readOnly={!canAdminister}
							label={`Enrollment of ${worker.displayName} in ${projectName}`}
							title={
								canAdminister
									? `Suspend or reactivate ${worker.displayName}'s enrollment in ${projectName}`
									: `Only a ${projectName} administrator can suspend or reactivate this enrollment`
							}
							onToggle={(next) =>
								onToggle({
									enrollmentId: roster.enrollmentId,
									projectId: enrollment.projectId,
									workerName: worker.displayName,
									projectName,
									next,
								})
							}
						/>
						{inlineErrorEnrollmentId === roster.enrollmentId && errorMessage ? (
							<div className="text-[10px] text-red-400">{errorMessage}</div>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}

/**
 * One row's position in the project's worker order (issue #750 phase 2). The
 * controls name the machine rather than its rank — a rank read out of a cell is
 * ambiguous the moment the row moves, and the roster's rows are already told
 * apart by their machine names everywhere else on this screen.
 *
 * Both arrows are rendered on every row and *disabled* at the boundaries rather
 * than omitted, so the column keeps one shape and a control never disappears out
 * from under a pointer mid-reorder.
 */
function ReorderCell({
	worker,
	index,
	total,
	reorder,
}: {
	worker: WorkerRow;
	index: number;
	total: number;
	reorder: WorkersTableReorder;
}) {
	const moving = reorder.pendingWorkerId !== undefined;
	const error = reorder.error?.workerId === worker.workerId ? reorder.error.message : null;
	return (
		<>
			<div className="flex items-center justify-end gap-1">
				<button
					type="button"
					onClick={(event) => {
						event.stopPropagation();
						reorder.onMove(worker.workerId, 'up');
					}}
					disabled={moving || index === 0}
					aria-label={`Move ${worker.displayName} up`}
					className={ROW_ACTION_CLASS}
				>
					<ChevronUp className="h-4 w-4" aria-hidden="true" />
				</button>
				<button
					type="button"
					onClick={(event) => {
						event.stopPropagation();
						reorder.onMove(worker.workerId, 'down');
					}}
					disabled={moving || index === total - 1}
					aria-label={`Move ${worker.displayName} down`}
					className={ROW_ACTION_CLASS}
				>
					<ChevronDown className="h-4 w-4" aria-hidden="true" />
				</button>
			</div>
			{error ? <div className="mt-1 text-right text-[10px] text-red-400">{error}</div> : null}
		</>
	);
}

/**
 * What one enrollment write leaves in the two canonical caches. Both writes patch
 * **both** fields plus the derived verdict, whichever of the two they changed: the
 * write path returns the whole enrollment row, so restating the status on a consent
 * change (and the consent on a status change) says what the server just said rather
 * than guessing, and the **Enrolled** and **Available** columns can never disagree
 * in the window before the reconciling refetch lands.
 */
interface EnrollmentWriteResult {
	enrollmentId: string;
	sharingConsent: boolean;
	status: WorkerEnrollmentStatus;
}

/** The project roster entry that write produces, with the routing verdict re-derived. */
function patchRosterCache(
	queryClient: QueryClient,
	projectId: string,
	written: EnrollmentWriteResult,
) {
	queryClient.setQueryData<WorkerRosterEntry[]>(
		trpc.workers.roster.queryOptions({ projectId }).queryKey,
		(old) =>
			old?.map((entry) =>
				entry.enrollmentId === written.enrollmentId ? { ...entry, ...patched(written) } : entry,
			),
	);
}

/** The same write, in the owner's own view of their machines. */
function patchMineCache(queryClient: QueryClient, written: EnrollmentWriteResult) {
	queryClient.setQueryData<OwnerWorker[]>(trpc.workers.listMine.queryOptions().queryKey, (old) =>
		old?.map((owned) => ({
			...owned,
			enrollments: owned.enrollments.map((enrollment) =>
				enrollment.enrollmentId === written.enrollmentId
					? { ...enrollment, ...patched(written) }
					: enrollment,
			),
		})),
	);
}

/** The fields both caches take from a write — `isRoutable` is the gate's own predicate. */
function patched({ sharingConsent, status }: EnrollmentWriteResult) {
	return { sharingConsent, status, isRoutable: status === 'active' && sharingConsent };
}

/**
 * A reduce-availability action waiting on its confirmation. Both kinds block
 * *future* automatic dispatch the moment they land and neither touches a run in
 * flight, which is why they share one dialog and one copy — the worker detail view
 * pairs them for the same reason (`worker-enrollment-card.tsx`).
 */
interface ConfirmTarget {
	kind: 'stop-sharing' | 'suspend';
	enrollmentId: string;
	projectId: string;
	workerName: string;
	projectName: string;
}

/**
 * What the shared confirmation's danger button says: which of the two acts it is
 * about to make, or that it is making it. A helper rather than a nested ternary in
 * the attribute, so each of the four readings stays one legible phrase.
 */
function reduceAvailabilityConfirmLabel(suspending: boolean, pending: boolean): string {
	if (suspending) return pending ? 'Suspending…' : 'Suspend enrollment';
	return pending ? 'Stopping…' : 'Stop sharing';
}

/**
 * The state one switch column reports back to its cell: which enrollment's control
 * is busy, and which one failed somewhere the failure can actually be read.
 *
 * An inline (non-modal) error is surfaced only for the *restoring* direction —
 * enabling sharing, reactivating an enrollment — because the reducing direction goes
 * through the confirmation dialog, which stays open and states the message itself.
 * Written once for both columns rather than twice, since the two axes differ only in
 * which of their own variables counts as restoring.
 */
function switchFeedback<Variables extends { enrollmentId: string }>(
	mutation: {
		isPending: boolean;
		isError: boolean;
		error: { message: string } | null;
		variables: Variables | undefined;
	},
	restoring: (variables: Variables) => boolean,
	/**
	 * The enrollment whose confirmation is open, if any — that one's failure has a
	 * dialog of its own to be reported in. Scoped to the enrollment rather than a bare
	 * "a dialog is open", because one mutation serves both directions on every row:
	 * suppressing on the open dialog alone would swallow an unrelated row's failure,
	 * which {@link confirmFeedback} is no longer willing to report either.
	 */
	confirmingEnrollmentId: string | undefined,
): {
	pendingEnrollmentId: string | undefined;
	inlineErrorEnrollmentId: string | undefined;
	errorMessage: string | null;
} {
	const variables = mutation.variables;
	const reportsInline =
		mutation.isError &&
		variables !== undefined &&
		restoring(variables) &&
		confirmingEnrollmentId !== variables.enrollmentId;
	return {
		pendingEnrollmentId: mutation.isPending ? variables?.enrollmentId : undefined,
		inlineErrorEnrollmentId: reportsInline ? variables?.enrollmentId : undefined,
		errorMessage: mutation.error?.message ?? null,
	};
}

/**
 * Which of the two writes an open confirmation belongs to, as the shared dialog needs
 * to read it. Resolved here rather than in the table body so the dialog always
 * reports the mutation it is actually about.
 *
 * "Actually about" is the enrollment as well as the kind: the same mutation also
 * carries the *direct* direction — reactivating, re-enabling sharing — for every other
 * row, so a dialog that read the mutation's bare pending/error state would report a
 * write it never asked for (claiming "Suspending…" over an unrelated reactivation, and
 * disabling its own buttons for the duration). Until this target's own write is sent,
 * the dialog reports nothing.
 */
function confirmFeedback(
	target: ConfirmTarget | null,
	consent: {
		isPending: boolean;
		error: { message: string } | null;
		variables: { enrollmentId: string } | undefined;
	},
	status: {
		isPending: boolean;
		error: { message: string } | null;
		variables: { enrollmentId: string } | undefined;
	},
): { pending: boolean; errorMessage: string | null } {
	const responsible = target?.kind === 'suspend' ? status : consent;
	if (!target || responsible.variables?.enrollmentId !== target.enrollmentId) {
		return { pending: false, errorMessage: null };
	}
	return { pending: responsible.isPending, errorMessage: responsible.error?.message ?? null };
}

/**
 * The confirmation both reduce-availability actions share — revoking sharing
 * consent (issue #282) and suspending an enrollment (issue #1035). Their
 * consequence is identical, future dispatch stops now and the run in flight is
 * untouched, so only the verb, the heading and the confirm label differ; the worker
 * detail view pairs the same two for the same reason.
 *
 * The caller decides *which* mutation the open dialog belongs to and hands over its
 * pending and error state, so this component never has to know there are two.
 */
function ReduceAvailabilityConfirm({
	target,
	pending,
	errorMessage,
	onCancel,
	onConfirm,
}: {
	/** The action awaiting confirmation, or `null` when none is — which is also "closed". */
	target: ConfirmTarget | null;
	pending: boolean;
	errorMessage: string | null;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	const suspending = target?.kind === 'suspend';
	return (
		<Modal
			open={target !== null}
			onClose={() => {
				if (!pending) onCancel();
			}}
			title={suspending ? 'Suspend this enrollment?' : 'Stop sharing this worker?'}
		>
			<div className="space-y-4">
				<p className="text-sm text-zinc-400 leading-relaxed">
					{suspending ? 'Suspending ' : 'Disabling sharing for '}
					<span className="font-semibold text-zinc-200">{target?.workerName}</span> on{' '}
					<span className="font-mono text-zinc-300">{target?.projectName}</span> blocks{' '}
					<span className="text-zinc-200">future automatic dispatch</span> immediately. It{' '}
					<span className="text-zinc-200">does not stop a run already in progress</span> — the
					current run finishes normally.
				</p>

				{errorMessage ? (
					<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
						{errorMessage}
					</div>
				) : null}

				<ModalFooter
					primary={
						<button
							type="button"
							onClick={onConfirm}
							disabled={pending}
							className={buttonClass('danger')}
						>
							{reduceAvailabilityConfirmLabel(suspending, pending)}
						</button>
					}
					secondary={
						<button
							type="button"
							onClick={onCancel}
							disabled={pending}
							className={buttonClass('secondary')}
						>
							Cancel
						</button>
					}
				/>
			</div>
		</Modal>
	);
}

export function WorkersTable({
	workers,
	refetchInterval,
	onSelectWorker,
	reorder,
}: WorkersTableProps) {
	const queryClient = useQueryClient();

	// Resolve projects the same way RunsTable does — names for the consent switches'
	// accessible labels. The roster falls back to the raw project id when this
	// auxiliary lookup is unavailable; an active job's PR link needs nothing from it,
	// coming from the run's own repository (issue #691).
	const projectsQuery = useQuery(trpc.projects.list.queryOptions());
	const projectNames = new Map(projectsQuery.data?.map((p) => [p.id, p.name]) ?? []);

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

	// Which of those projects the viewer administers (issue #1035) — what authorizes
	// an actionable **Enrolled** switch, the way `workers.listMine` authorizes an
	// actionable **Available** one. It is the server-declared `projects.viewerAccess`
	// capability, the same read the project screen decides its administrator tabs from
	// and the same rule `workers.setStatus` re-checks on every call; never a role
	// inferred client-side, and never `projects.list` membership, which reports
	// nothing for an `instanceAdmin` who administers every project without a
	// membership row. One query per visible project, authorized for the reason the
	// roster reads above are.
	//
	// Deliberately *not* polled, unlike those: consent and enrollment status move
	// under an open roster, a viewer's role on a project does not. It fails closed
	// while it loads ({@link viewerAdministersProject}), so a control never flashes in
	// for someone the server would refuse.
	const viewerAccessQueries = useQueries({
		queries: projectIds.map((projectId) => trpc.projects.viewerAccess.queryOptions({ projectId })),
	});
	const administeredProjectIds = new Set(
		projectIds.filter((_, index) => viewerAdministersProject(viewerAccessQueries[index]?.data)),
	);

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

	/**
	 * A confirmation is dismissed by its **own** write landing, never by any other.
	 * Both columns share one `confirmTarget` and each column's mutation also serves a
	 * direct, unconfirmed toggle on every other row, so an unconditional dismissal let
	 * a reactivation (or a sharing enable) completing anywhere close a dialog the
	 * operator had since opened for a different enrollment — discarding a confirmed
	 * intent without ever sending its write. Matching on both the kind and the
	 * enrollment is what makes "its own" precise; the state updater reads the current
	 * target rather than the one captured when the write was sent.
	 */
	function dismissConfirmed(kind: ConfirmTarget['kind'], enrollmentId: string) {
		setConfirmTarget((current) =>
			current?.kind === kind && current.enrollmentId === enrollmentId ? null : current,
		);
	}

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
			const written = {
				enrollmentId: updated.id,
				sharingConsent: updated.sharingConsent,
				status: updated.status,
			};
			patchRosterCache(queryClient, variables.projectId, written);
			patchMineCache(queryClient, written);
			// …then invalidate both for authoritative reconciliation.
			queryClient.invalidateQueries({
				queryKey: trpc.workers.roster.queryOptions({ projectId: variables.projectId }).queryKey,
			});
			queryClient.invalidateQueries({
				queryKey: trpc.workers.listMine.queryOptions().queryKey,
			});
			// Only the revoking direction ever came from the dialog.
			if (!variables.sharingConsent) {
				dismissConfirmed('stop-sharing', variables.enrollmentId);
			}
		},
	});

	// Suspend/reactivate (issue #1035) — the **existing** `workers.setStatus`, reached
	// from a second place rather than reimplemented: no new endpoint, and the
	// `projectAdmin` rule is re-checked there whatever this table offered. Its own
	// mutation rather than a branch inside the consent one, so each switch reports
	// only its own pending and error state, exactly as the detail view keeps its
	// controls' outcomes apart.
	const statusMutation = useMutation({
		mutationFn: (variables: {
			enrollmentId: string;
			projectId: string;
			status: 'active' | 'suspended';
		}) =>
			trpcClient.workers.setStatus.mutate({
				enrollmentId: variables.enrollmentId,
				status: variables.status,
			}),
		onSuccess: (updated, variables) => {
			const written = {
				enrollmentId: updated.id,
				sharingConsent: updated.sharingConsent,
				status: updated.status,
			};
			patchRosterCache(queryClient, variables.projectId, written);
			patchMineCache(queryClient, written);
			queryClient.invalidateQueries({
				queryKey: trpc.workers.roster.queryOptions({ projectId: variables.projectId }).queryKey,
			});
			queryClient.invalidateQueries({
				queryKey: trpc.workers.listMine.queryOptions().queryKey,
			});
			// Only suspension ever came from the dialog; a reactivation is sent directly.
			if (variables.status === 'suspended') {
				dismissConfirmed('suspend', variables.enrollmentId);
			}
		},
	});

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
			kind: 'stop-sharing',
			enrollmentId: args.enrollmentId,
			projectId: args.projectId,
			workerName: args.workerName,
			projectName: args.projectName,
		});
	}

	function handleStatusToggle(args: {
		enrollmentId: string;
		projectId: string;
		workerName: string;
		projectName: string;
		next: boolean;
	}) {
		if (args.next) {
			// Reactivating only restores dispatch — nothing to warn about.
			statusMutation.mutate({
				enrollmentId: args.enrollmentId,
				projectId: args.projectId,
				status: 'active',
			});
			return;
		}
		// Suspending blocks future dispatch, the same consequence disabling sharing
		// has — so it takes the same confirmation rather than landing on one click.
		setConfirmTarget({
			kind: 'suspend',
			enrollmentId: args.enrollmentId,
			projectId: args.projectId,
			workerName: args.workerName,
			projectName: args.projectName,
		});
	}

	function confirmReduceAvailability() {
		if (!confirmTarget) return;
		if (confirmTarget.kind === 'suspend') {
			statusMutation.mutate({
				enrollmentId: confirmTarget.enrollmentId,
				projectId: confirmTarget.projectId,
				status: 'suspended',
			});
			return;
		}
		consentMutation.mutate({
			enrollmentId: confirmTarget.enrollmentId,
			projectId: confirmTarget.projectId,
			sharingConsent: false,
		});
	}

	const confirmingEnrollmentId = confirmTarget?.enrollmentId;
	const consentFeedback = switchFeedback(
		consentMutation,
		(variables) => variables.sharingConsent,
		confirmingEnrollmentId,
	);
	const statusFeedback = switchFeedback(
		statusMutation,
		(variables) => variables.status === 'active',
		confirmingEnrollmentId,
	);
	const confirm = confirmFeedback(confirmTarget, consentMutation, statusMutation);

	return (
		<div className="border border-zinc-800 rounded-md overflow-hidden bg-panel/20 shadow-sm">
			<table className="w-full table-fixed text-left border-collapse">
				<colgroup>
					<col className={COLUMN_WIDTHS.machine} />
					<col className={COLUMN_WIDTHS.owner} />
					<col className={COLUMN_WIDTHS.status} />
					<col className={COLUMN_WIDTHS.capabilities} />
					<col className={reorder ? COLUMN_WIDTHS.activeJobWithReorder : COLUMN_WIDTHS.activeJob} />
					<col className={COLUMN_WIDTHS.enrolled} />
					<col className={COLUMN_WIDTHS.available} />
					{reorder ? <col className={COLUMN_WIDTHS.reorder} /> : null}
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
						{/* Enrolled before Available: the dispatch gate's own predicate reads
						    `status === 'active' && sharingConsent`, and the approval is the
						    precondition the consent sits inside. */}
						<th className="px-3 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
							Enrolled
						</th>
						<th className="px-3 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
							Available
						</th>
						{reorder ? (
							<th className="px-3 py-3">
								<span className="sr-only">Reorder</span>
							</th>
						) : null}
					</tr>
				</thead>
				<tbody className="divide-y divide-zinc-800/60">
					{workers.map((worker, index) => (
						// Mouse users can click anywhere on the row; keyboard/AT users reach
						// the explicit button on the Machine cell, which carries the
						// accessible name and focus (a role="button" <tr> trips Biome a11y
						// and is worse for AT than a real control). The in-row controls and
						// links stop propagation, so they still do their own thing.
						<tr
							key={worker.workerId}
							onClick={() => onSelectWorker?.(worker.workerId)}
							className={`hover:bg-zinc-800/40 focus-within:bg-zinc-800/40 transition-colors ${
								onSelectWorker ? 'cursor-pointer' : ''
							}`}
						>
							<td className="px-3 py-3 align-top text-sm font-medium text-zinc-100 break-words">
								{/* The build marks sit beside the name rather than in a column of their
								    own (issues #925, #978): COLUMN_WIDTHS is a hand-tuned budget, and
								    these are rare per-row exceptions, not facts every row carries. */}
								<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
									{onSelectWorker ? (
										<button
											type="button"
											onClick={(event) => {
												event.stopPropagation();
												onSelectWorker(worker.workerId);
											}}
											aria-label={`Open ${worker.displayName} details`}
											className="text-left break-words rounded hover:text-white focus:outline-none focus:ring-1 focus:ring-violet-500 transition-colors"
										>
											{worker.displayName}
										</button>
									) : (
										worker.displayName
									)}
									<WorkerUpdatingBadge update={worker.update} />
									<WorkerBuildBadge buildIsCurrent={worker.buildIsCurrent} />
								</div>
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
								<CapabilitiesCell worker={worker} />
							</td>
							<td className="px-3 py-3 align-top text-sm">
								{worker.currentRun ? (
									// The same description `/runs` gives the run, with the title
									// linking to its detail page — the run id itself is a UUID and
									// says nothing about the work (issue #473). The phase leads the
									// line here because this table has no Phase column of its own.
									<WorkItemCell
										run={worker.currentRun}
										titleHref={`/runs/${worker.currentRun.runId}`}
										phaseLabel={formatPhase(worker.currentRun.phase)}
									/>
								) : (
									<span className="text-zinc-500">—</span>
								)}
							</td>
							<td className="px-3 py-3 align-top">
								<EnrolledCell
									worker={worker}
									projectNames={projectNames}
									rosterByKey={rosterByKey}
									administeredProjectIds={administeredProjectIds}
									pendingEnrollmentId={statusFeedback.pendingEnrollmentId}
									inlineErrorEnrollmentId={statusFeedback.inlineErrorEnrollmentId}
									errorMessage={statusFeedback.errorMessage}
									onToggle={handleStatusToggle}
								/>
							</td>
							<td className="px-3 py-3 align-top">
								<AvailabilityCell
									worker={worker}
									projectNames={projectNames}
									rosterByKey={rosterByKey}
									ownedEnrollmentIdByKey={ownedEnrollmentIdByKey}
									pendingEnrollmentId={consentFeedback.pendingEnrollmentId}
									inlineErrorEnrollmentId={consentFeedback.inlineErrorEnrollmentId}
									errorMessage={consentFeedback.errorMessage}
									onToggle={handleToggle}
								/>
							</td>
							{reorder ? (
								<td className="px-3 py-3 align-top">
									<ReorderCell
										worker={worker}
										index={index}
										total={workers.length}
										reorder={reorder}
									/>
								</td>
							) : null}
						</tr>
					))}
				</tbody>
			</table>

			<ReduceAvailabilityConfirm
				target={confirmTarget}
				pending={confirm.pending}
				errorMessage={confirm.errorMessage}
				onCancel={() => setConfirmTarget(null)}
				onConfirm={confirmReduceAvailability}
			/>
		</div>
	);
}
