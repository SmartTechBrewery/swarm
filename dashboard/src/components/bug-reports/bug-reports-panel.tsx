import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft, Bug, ExternalLink } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { buttonClass } from '@/components/ui/button.js';
import { canChangeBugReportStatus } from '@/lib/bug-reports-nav.js';
import { formatRelativeTime } from '@/lib/format.js';
import { trpc } from '@/lib/trpc.js';
import { useCurrentUser } from '@/lib/use-current-user.js';
import {
	BUG_REPORT_STATUSES,
	type BugReportStatus,
	OPEN_BUG_REPORT_STATUSES,
} from '../../../../src/api/bug-reports.js';
import {
	BugReportStatusBadge,
	bugReportStatusLabel,
	bugReportStatusTitle,
} from './bug-report-status-badge.js';
import {
	type BatchOutcome,
	BugReportBatchStatusBar,
	BugReportStatusForm,
} from './bug-report-status-change.js';

const ERROR_BANNER_CLASS =
	'p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded';
const LINK_CLASS = 'text-violet-400 hover:text-violet-300 hover:underline';
const TH_CLASS = 'px-4 py-3';

/** Reports per page. */
export const BUG_REPORTS_PAGE_SIZE = 25;

/**
 * SWARM's own bug reports — defects in SWARM, or in what it runs on, that an agent or a
 * person recorded through the operator MCP server's bug-report tools (issue #1383). The
 * view was the General screen's read-only **Issues** tab (issue #1390); since issue
 * #1443 it is the `/bug-reports` page, and triage is possible here as well as through
 * MCP: one report's status on its detail view, or several selected in the list at once
 * (`./bug-report-status-change.tsx`). Filing and adding an occurrence stay MCP's.
 *
 * Every signed-in user sees the page. What it lists is `bugReports.list`'s decision
 * (`src/api/routers/bugReports.ts`): the reports of the projects the viewer may read,
 * plus installation-wide ones for an instance administrator only. A report the viewer
 * cannot read is `NOT_FOUND` from `bugReports.get`, which the detail view renders as
 * the server's own words. Status controls are drawn only for a report the viewer may
 * change (`canChangeBugReportStatus`), from `auth.me` and `projects.listMine`, which
 * also names each report's project.
 *
 * The status filter is local state, starting on the **Open** preset — the same
 * statuses the API lists when asked for none (`OPEN_BUG_REPORT_STATUSES`). The report
 * shown in detail lives in the URL (`?report=<id>`), so it is linkable and the
 * browser's Back returns to the list.
 */

/** A `bugReports.list`/`get` row as it arrives (no transformer: timestamps are strings). */
interface BugReportRow {
	id: string;
	title: string;
	description: string;
	status: string;
	projectId: string | null;
	duplicateOfId: string | null;
	githubIssueUrl: string | null;
	filedByUserIdentifier: string;
	filedByRunId: string | null;
	occurrenceCount: number;
	firstSeenAt: string;
	lastSeenAt: string;
}

/** A `bugReports.get` occurrence as it arrives. */
interface BugReportOccurrenceRow {
	id: string;
	runId: string | null;
	dispatchId: string | null;
	taskId: string | null;
	repository: string | null;
	prNumber: number | null;
	note: string | null;
	filedByUserIdentifier: string;
	filedByRunId: string | null;
	observedAt: string;
}

interface BugReportDetail {
	report: BugReportRow;
	occurrences: BugReportOccurrenceRow[];
	duplicateOf: Pick<BugReportRow, 'id' | 'title' | 'status'> | null;
}

/** The filter chips: the **Open** preset, every status, or one status. */
export type BugReportFilter = 'open' | 'all' | BugReportStatus;

/** The `status` a filter asks `bugReports.list` for. */
export function statusesForFilter(filter: BugReportFilter): BugReportStatus[] {
	if (filter === 'open') return [...OPEN_BUG_REPORT_STATUSES];
	if (filter === 'all') return [...BUG_REPORT_STATUSES];
	return [filter];
}

const FILTER_CHIPS: ReadonlyArray<{ filter: BugReportFilter; label: string; title: string }> = [
	{
		filter: 'open',
		label: 'Open',
		title: `Still wanting attention: ${OPEN_BUG_REPORT_STATUSES.map(bugReportStatusLabel).join(', ')}`,
	},
	{ filter: 'all', label: 'All', title: 'Every status, closed ones included' },
	...BUG_REPORT_STATUSES.map((status) => ({
		filter: status,
		label: bugReportStatusLabel(status),
		title: bugReportStatusTitle(status),
	})),
];

/** A timestamp as relative text, with the absolute one on hover. */
function Timestamp({ value }: { value: string }) {
	return <span title={new Date(value).toLocaleString()}>{formatRelativeTime(value)}</span>;
}

function RunLink({ runId }: { runId: string }) {
	return (
		<Link
			to="/runs/$runId"
			params={{ runId }}
			className={`${LINK_CLASS} font-mono`}
			onClick={(event) => event.stopPropagation()}
		>
			{runId}
		</Link>
	);
}

function GitHubIssueLink({ url }: { url: string }) {
	return (
		<a
			href={url}
			target="_blank"
			rel="noopener noreferrer"
			className={`${LINK_CLASS} inline-flex items-center gap-1`}
			onClick={(event) => event.stopPropagation()}
		>
			GitHub issue
			<ExternalLink className="h-3 w-3" />
		</a>
	);
}

interface BugReportsPanelProps {
	/** The report shown in detail, from `?report=`; the list when absent. */
	selectedReportId?: string;
	/** Open a report in detail, or return to the list with `undefined`. */
	onSelectReport: (reportId: string | undefined) => void;
}

/** One `projects.listMine` row: the viewer's projects, and the role held on each. */
interface ViewerProject {
	id: string;
	name: string;
	role: 'projectAdmin' | 'member' | 'contributor' | null;
}

/** What the list and the detail view need to know about the viewer's projects. */
interface ProjectContext {
	projectLabel: (projectId: string | null) => string;
	mayChangeStatus: (projectId: string | null) => boolean;
}

export function BugReportsPanel({ selectedReportId, onSelectReport }: BugReportsPanelProps) {
	const viewer = useCurrentUser().data;
	const projectsQuery = useQuery(trpc.projects.listMine.queryOptions());
	const projects = projectsQuery.data as ViewerProject[] | undefined;
	const projectNames = new Map((projects ?? []).map((project) => [project.id, project.name]));
	const context: ProjectContext = {
		projectLabel: (projectId) =>
			projectId === null ? 'Installation' : (projectNames.get(projectId) ?? projectId),
		mayChangeStatus: (projectId) => canChangeBugReportStatus(projectId, viewer, projects),
	};

	return (
		<div className="border border-zinc-800 rounded-lg bg-panel/40 p-6 shadow-sm space-y-6">
			{selectedReportId === undefined ? (
				<BugReportList context={context} onSelectReport={onSelectReport} />
			) : (
				<BugReportDetailView
					reportId={selectedReportId}
					context={context}
					onSelectReport={onSelectReport}
				/>
			)}
		</div>
	);
}

/** The checkbox selecting one report, or all the changeable ones on the page. */
function SelectBox({
	label,
	checked,
	onChange,
}: {
	label: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
}) {
	return (
		<input
			type="checkbox"
			aria-label={label}
			checked={checked}
			onChange={(event) => onChange(event.target.checked)}
			onClick={(event) => event.stopPropagation()}
			className="h-4 w-4 accent-violet-600"
		/>
	);
}

/**
 * The list's selection for a batch status change: report ids, kept only while the
 * filter and page stay put. A batch leaves the reports it could not change selected.
 */
function useSelection() {
	const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
	const toggle = (ids: readonly string[], on: boolean) => {
		setSelected((current) => {
			const next = new Set(current);
			for (const id of ids) {
				if (on) next.add(id);
				else next.delete(id);
			}
			return next;
		});
	};
	return { selected, toggle, replace: setSelected };
}

function BugReportList({
	context,
	onSelectReport,
}: {
	context: ProjectContext;
	onSelectReport: (reportId: string) => void;
}) {
	const { projectLabel, mayChangeStatus } = context;
	const [filter, setFilter] = useState<BugReportFilter>('open');
	const [page, setPage] = useState(1);
	const selection = useSelection();
	const [outcome, setOutcome] = useState<BatchOutcome | null>(null);
	const listQuery = useQuery(
		trpc.bugReports.list.queryOptions({
			status: statusesForFilter(filter),
			limit: BUG_REPORTS_PAGE_SIZE,
			offset: (page - 1) * BUG_REPORTS_PAGE_SIZE,
		}),
	);

	const goTo = (nextFilter: BugReportFilter, nextPage: number) => {
		setFilter(nextFilter);
		setPage(nextPage);
		selection.replace(new Set());
		setOutcome(null);
	};
	const selectFilter = (next: BugReportFilter) => goTo(next, 1);

	const reports = (listQuery.data?.data ?? []) as unknown as BugReportRow[];
	const changeable = reports.filter((report) => mayChangeStatus(report.projectId));
	const selectedReports = changeable.filter((report) => selection.selected.has(report.id));
	const allSelected = changeable.length > 0 && selectedReports.length === changeable.length;
	const total = listQuery.data?.total ?? 0;
	const totalPages = Math.max(1, Math.ceil(total / BUG_REPORTS_PAGE_SIZE));
	const startIdx = (page - 1) * BUG_REPORTS_PAGE_SIZE + 1;
	const endIdx = Math.min(page * BUG_REPORTS_PAGE_SIZE, total);

	return (
		<>
			<div>
				<h2 className="text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4">
					Reports
				</h2>
				<p className="text-xs text-zinc-400">
					SWARM's own bug reports: defects in SWARM, or in what it runs on, that an agent or a
					person recorded through the operator MCP server. Each report counts every time it was
					observed. You see the reports of the projects you can read; installation-wide reports are
					shown to installation admins only. Reports are filed through MCP; a member of a report's
					project changes its status here — select several to change them at once — or through MCP.
				</p>
			</div>

			<fieldset className="flex flex-wrap gap-2">
				<legend className="sr-only">Status</legend>
				{FILTER_CHIPS.map((chip) => (
					<button
						key={chip.filter}
						type="button"
						aria-pressed={filter === chip.filter}
						title={chip.title}
						onClick={() => selectFilter(chip.filter)}
						className={buttonClass(filter === chip.filter ? 'primary' : 'secondary', 'xs')}
					>
						{chip.label}
					</button>
				))}
			</fieldset>

			<BugReportBatchStatusBar
				selected={selectedReports}
				outcome={outcome}
				onDone={(result) => {
					setOutcome(result);
					selection.replace(new Set(result.refused.map((report) => report.id)));
				}}
				onClear={() => selection.replace(new Set())}
			/>

			{listQuery.isLoading ? (
				<div className="text-sm text-zinc-400">Loading bug reports…</div>
			) : listQuery.isError ? (
				<div className={ERROR_BANNER_CLASS}>
					Failed to load bug reports: {listQuery.error.message}
				</div>
			) : reports.length === 0 ? (
				<div className="flex flex-col items-center gap-3 rounded-lg border border-zinc-800 bg-panel/20 p-8 text-center">
					<Bug className="w-12 h-12 stroke-1 text-zinc-700" />
					<p className="text-sm text-zinc-400">No bug reports match this filter.</p>
				</div>
			) : (
				<>
					<div className="border border-zinc-800 rounded-md overflow-hidden bg-panel/20 shadow-sm">
						<table className="w-full table-fixed text-left border-collapse">
							<thead>
								<tr className="bg-zinc-800/30 border-b border-zinc-800 text-xs uppercase tracking-wider text-zinc-400 font-semibold">
									{changeable.length > 0 && (
										<th className={`${TH_CLASS} w-12`}>
											<SelectBox
												label="Select all on this page"
												checked={allSelected}
												onChange={(on) =>
													selection.toggle(
														changeable.map((report) => report.id),
														on,
													)
												}
											/>
										</th>
									)}
									<th className={TH_CLASS}>Title</th>
									<th className={`${TH_CLASS} w-36`}>Status</th>
									<th className={`${TH_CLASS} w-36 hidden md:table-cell`}>Project</th>
									<th className={`${TH_CLASS} w-20 hidden md:table-cell`}>Seen</th>
									<th className={`${TH_CLASS} w-32 hidden md:table-cell`}>First seen</th>
									<th className={`${TH_CLASS} w-32`}>Last seen</th>
									<th className={`${TH_CLASS} w-36 hidden md:table-cell`}>Issue</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-zinc-800/60">
								{reports.map((report) => (
									<tr
										key={report.id}
										data-testid="bug-report-row"
										onClick={() => onSelectReport(report.id)}
										className="hover:bg-zinc-800/40 transition-colors cursor-pointer"
									>
										{changeable.length > 0 && (
											<td className="px-4 py-3 text-sm">
												{mayChangeStatus(report.projectId) && (
													<SelectBox
														label={`Select "${report.title}"`}
														checked={selection.selected.has(report.id)}
														onChange={(on) => selection.toggle([report.id], on)}
													/>
												)}
											</td>
										)}
										<td className="px-4 py-3 text-sm">
											<button
												type="button"
												onClick={(event) => {
													event.stopPropagation();
													onSelectReport(report.id);
												}}
												title={report.title}
												className="block w-full truncate text-left font-medium text-zinc-100 hover:text-violet-300 focus:outline-none focus:ring-1 focus:ring-violet-500 rounded"
											>
												{report.title}
											</button>
										</td>
										<td className="px-4 py-3 text-sm">
											<BugReportStatusBadge status={report.status} />
										</td>
										<td className="px-4 py-3 text-sm text-zinc-300 font-mono truncate hidden md:table-cell">
											{projectLabel(report.projectId)}
										</td>
										<td
											className="px-4 py-3 text-sm text-zinc-400 font-mono hidden md:table-cell"
											title="occurrences"
										>
											{report.occurrenceCount}×
										</td>
										<td className="px-4 py-3 text-sm text-zinc-400 hidden md:table-cell">
											<Timestamp value={report.firstSeenAt} />
										</td>
										<td className="px-4 py-3 text-sm text-zinc-400">
											<Timestamp value={report.lastSeenAt} />
										</td>
										<td className="px-4 py-3 text-sm hidden md:table-cell">
											{report.githubIssueUrl ? (
												<GitHubIssueLink url={report.githubIssueUrl} />
											) : (
												<span className="text-zinc-600">—</span>
											)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>

					<div className="flex flex-col gap-3 text-xs text-zinc-400 sm:flex-row sm:items-center sm:justify-between">
						<div>
							Showing <span className="font-semibold text-zinc-200">{startIdx}</span> to{' '}
							<span className="font-semibold text-zinc-200">{endIdx}</span> of{' '}
							<span className="font-semibold text-zinc-200">{total}</span> reports
						</div>
						<div className="flex items-center justify-between gap-2 sm:justify-end">
							<button
								type="button"
								onClick={() => goTo(filter, page - 1)}
								disabled={page === 1}
								className={buttonClass('secondary', 'sm')}
							>
								Previous
							</button>
							<span className="px-2">
								Page {page} of {totalPages}
							</span>
							<button
								type="button"
								onClick={() => goTo(filter, page + 1)}
								disabled={page >= totalPages}
								className={buttonClass('secondary', 'sm')}
							>
								Next
							</button>
						</div>
					</div>
				</>
			)}
		</>
	);
}

/** One labelled fact in the detail view's summary grid. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div>
			<dt className="text-xs font-medium text-zinc-400">{label}</dt>
			<dd className="mt-1 text-sm text-zinc-200">{children}</dd>
		</div>
	);
}

/** Where an occurrence was observed: its run as a link, the rest as text. */
function OccurrenceContext({ occurrence }: { occurrence: BugReportOccurrenceRow }) {
	const parts: ReactNode[] = [];
	if (occurrence.runId) {
		parts.push(
			<span key="run">
				Run <RunLink runId={occurrence.runId} />
			</span>,
		);
	}
	if (occurrence.dispatchId) {
		parts.push(
			<span key="dispatch">
				Dispatch <span className="font-mono text-zinc-300">{occurrence.dispatchId}</span>
			</span>,
		);
	}
	if (occurrence.prNumber !== null) {
		parts.push(
			<span key="pr">
				PR <span className="font-mono text-zinc-300">#{occurrence.prNumber}</span>
			</span>,
		);
	}
	if (occurrence.taskId) {
		parts.push(
			<span key="task">
				Task <span className="font-mono text-zinc-300">{occurrence.taskId}</span>
			</span>,
		);
	}
	if (occurrence.repository) {
		parts.push(
			<span key="repository" className="font-mono text-zinc-300 break-all">
				{occurrence.repository}
			</span>,
		);
	}
	if (parts.length === 0) return <span className="text-zinc-600">—</span>;
	return <div className="flex flex-col gap-0.5">{parts}</div>;
}

function BugReportDetailView({
	reportId,
	context,
	onSelectReport,
}: {
	reportId: string;
	context: ProjectContext;
	onSelectReport: (reportId: string | undefined) => void;
}) {
	const { projectLabel, mayChangeStatus } = context;
	const detailQuery = useQuery(trpc.bugReports.get.queryOptions({ reportId }));

	const backButton = (
		<button
			type="button"
			onClick={() => onSelectReport(undefined)}
			className={buttonClass('secondary', 'sm')}
		>
			<ArrowLeft className="h-3.5 w-3.5" />
			All bug reports
		</button>
	);

	if (detailQuery.isLoading) {
		return (
			<div className="space-y-4">
				{backButton}
				<div className="text-sm text-zinc-400">Loading the bug report…</div>
			</div>
		);
	}

	if (detailQuery.isError || !detailQuery.data) {
		return (
			<div className="space-y-4">
				{backButton}
				<div className={ERROR_BANNER_CLASS}>
					Failed to load the bug report: {detailQuery.error?.message ?? 'no data'}
				</div>
			</div>
		);
	}

	const { report, occurrences, duplicateOf } = detailQuery.data as unknown as BugReportDetail;

	return (
		<div className="space-y-6">
			<div>{backButton}</div>

			<div className="space-y-3">
				<div className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-800 pb-2">
					<h2 className="min-w-0 break-words text-sm font-semibold text-zinc-200">
						{report.title}
					</h2>
					<BugReportStatusBadge status={report.status} className="shrink-0" />
				</div>
				<p className="whitespace-pre-wrap break-words text-sm text-zinc-300">
					{report.description}
				</p>
			</div>

			<dl className="grid grid-cols-1 md:grid-cols-3 gap-4">
				<Fact label="Report ID">
					<span className="font-mono break-all select-all">{report.id}</span>
				</Fact>
				<Fact label="Project">
					<span className="font-mono">{projectLabel(report.projectId)}</span>
				</Fact>
				<Fact label="Filed by">
					<span className="font-mono break-all">{report.filedByUserIdentifier}</span>
					{report.filedByRunId && (
						<span className="block text-xs text-zinc-400 mt-0.5">
							from run <RunLink runId={report.filedByRunId} />
						</span>
					)}
				</Fact>
				<Fact label="GitHub issue">
					{report.githubIssueUrl ? (
						<GitHubIssueLink url={report.githubIssueUrl} />
					) : (
						<span className="text-zinc-500">None</span>
					)}
				</Fact>
				<Fact label="Seen">
					<span className="font-mono">{report.occurrenceCount}×</span>
				</Fact>
				<Fact label="First seen">
					<Timestamp value={report.firstSeenAt} />
				</Fact>
				<Fact label="Last seen">
					<Timestamp value={report.lastSeenAt} />
				</Fact>
				{report.status === 'duplicate' && (
					<Fact label="Duplicate of">
						{duplicateOf ? (
							<button
								type="button"
								onClick={() => onSelectReport(duplicateOf.id)}
								className={`${LINK_CLASS} text-left`}
							>
								{duplicateOf.title}
							</button>
						) : (
							<span className="text-zinc-500">A report you cannot see</span>
						)}
					</Fact>
				)}
			</dl>

			{mayChangeStatus(report.projectId) && (
				<BugReportStatusForm
					key={`${report.status}|${report.duplicateOfId}|${report.githubIssueUrl}`}
					report={report}
				/>
			)}

			<div className="space-y-2">
				<h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
					Occurrences
				</h3>
				{occurrences.length < report.occurrenceCount && (
					<p className="text-xs text-zinc-500">
						Showing the newest {occurrences.length} of {report.occurrenceCount}.
					</p>
				)}
				<div className="border border-zinc-800 rounded-md overflow-hidden bg-panel/20 shadow-sm">
					<table className="w-full table-fixed text-left border-collapse">
						<thead>
							<tr className="bg-zinc-800/30 border-b border-zinc-800 text-xs uppercase tracking-wider text-zinc-400 font-semibold">
								<th className={`${TH_CLASS} w-32`}>Observed</th>
								<th className={`${TH_CLASS} w-48`}>Where</th>
								<th className={TH_CLASS}>Note</th>
								<th className={`${TH_CLASS} w-48 hidden md:table-cell`}>Filed by</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-zinc-800/60">
							{occurrences.map((occurrence) => (
								<tr key={occurrence.id} data-testid="bug-report-occurrence">
									<td className="px-4 py-3 text-sm text-zinc-400 align-top">
										<Timestamp value={occurrence.observedAt} />
									</td>
									<td className="px-4 py-3 text-xs text-zinc-400 align-top">
										<OccurrenceContext occurrence={occurrence} />
									</td>
									<td className="px-4 py-3 text-sm text-zinc-300 align-top whitespace-pre-wrap break-words">
										{occurrence.note ?? <span className="text-zinc-600">—</span>}
									</td>
									<td className="px-4 py-3 text-xs text-zinc-400 align-top hidden md:table-cell">
										<span className="font-mono break-all">{occurrence.filedByUserIdentifier}</span>
										{occurrence.filedByRunId && (
											<span className="block mt-0.5">
												from run <RunLink runId={occurrence.filedByRunId} />
											</span>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</div>
		</div>
	);
}
