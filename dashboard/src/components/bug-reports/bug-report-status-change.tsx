import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { buttonClass } from '@/components/ui/button.js';
import { trpc, trpcClient } from '@/lib/trpc.js';
import {
	BUG_REPORT_STATUSES,
	type BugReportStatus,
	type BugReportStatusFields,
	type SetBugReportStatusInput,
	SetBugReportStatusInputSchema,
	validateStatusChange,
} from '../../../../src/api/bug-reports.js';
import { bugReportStatusLabel, bugReportStatusTitle } from './bug-report-status-badge.js';

/**
 * Changing a bug report's status from the dashboard (issue #1443) — one report on its
 * detail view, or several selected in the list at once. Both call `bugReports.setStatus`
 * (`src/api/routers/bugReports.ts`), which applies the rules of `validateStatusChange`
 * (`src/api/bug-reports.ts`) and its own authorization, exactly as the MCP tool
 * `bug_report_set_status` does; a batch calls it once per report, so every report is
 * accepted or refused on its own and a refusal is named with the server's own words.
 *
 * Whether these controls are drawn at all is `canChangeBugReportStatus`'s decision
 * (`lib/bug-reports-nav.ts`); the router stays the enforcement point.
 */

const INPUT_CLASS =
	'block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 disabled:opacity-50 disabled:bg-zinc-950 disabled:border-zinc-800 disabled:text-zinc-500';
const LABEL_CLASS = 'block text-xs font-medium text-zinc-400';
const ERROR_BANNER_CLASS =
	'p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded';
const SUCCESS_BANNER_CLASS =
	'p-2.5 bg-emerald-950/20 border border-emerald-900/30 text-xs text-emerald-400 rounded';

/** What the status fields hold while being edited; `''` is "not chosen" / "not given". */
export interface StatusDraft {
	status: BugReportStatus | '';
	duplicateOfId: string;
	githubIssueUrl: string;
}

const EMPTY_DRAFT: StatusDraft = { status: '', duplicateOfId: '', githubIssueUrl: '' };

type StatusChange = Omit<SetBugReportStatusInput, 'reportId'>;

/**
 * The change a draft asks for, or why it cannot be sent yet (`message: null` when there
 * is nothing worth saying, e.g. no status chosen). A duplicate target is sent only with
 * `duplicate` and an issue link only with `ticketed` — the fields shown for them — and
 * an empty field is not sent, so a report keeps what it already has.
 */
export function draftChange(
	draft: StatusDraft,
): { ok: true; change: StatusChange } | { ok: false; message: string | null } {
	if (draft.status === '') return { ok: false, message: null };
	const duplicateOfId = draft.duplicateOfId.trim();
	const githubIssueUrl = draft.githubIssueUrl.trim();
	const change: StatusChange = {
		status: draft.status,
		...(draft.status === 'duplicate' && duplicateOfId !== '' ? { duplicateOfId } : {}),
		...(draft.status === 'ticketed' && githubIssueUrl !== '' ? { githubIssueUrl } : {}),
	};
	const parsed = SetBugReportStatusInputSchema.omit({ reportId: true }).safeParse(change);
	if (parsed.success) return { ok: true, change };
	const field = parsed.error.issues[0]?.path[0];
	return {
		ok: false,
		message:
			field === 'duplicateOfId'
				? 'The duplicated report must be named by its report ID.'
				: 'The GitHub issue link must be an https URL.',
	};
}

/**
 * The change a draft asks of one `report`, judged by the same `validateStatusChange` the
 * server runs. A change that changes nothing is never offered: it reads as not ready,
 * with no message, rather than as an error.
 */
export function reportDraftChange(
	report: BugReportStatusFields,
	draft: StatusDraft,
): { ok: true; change: StatusChange } | { ok: false; message: string | null } {
	const drafted = draftChange(draft);
	if (!drafted.ok) return drafted;
	const { change } = drafted;
	const decision = validateStatusChange(report, change);
	if (decision.ok) return drafted;
	const givesNothing = change.duplicateOfId === undefined && change.githubIssueUrl === undefined;
	if (change.status === report.status && givesNothing) return { ok: false, message: null };
	if (change.status === 'duplicate' && change.duplicateOfId === undefined) {
		return { ok: false, message: 'Name the report this one duplicates.' };
	}
	if (change.status === 'ticketed' && change.githubIssueUrl === undefined) {
		return { ok: false, message: 'Enter the GitHub issue this report became.' };
	}
	return { ok: false, message: decision.message };
}

/** The status select plus the input `duplicate` and `ticketed` each ask for. */
function StatusFields({
	idPrefix,
	draft,
	onChange,
	disabled,
	issueUrlPlaceholder,
	chooseFirst,
}: {
	idPrefix: string;
	draft: StatusDraft;
	onChange: (draft: StatusDraft) => void;
	disabled: boolean;
	issueUrlPlaceholder: string;
	/** Start on an empty "Choose a status…" option rather than a status. */
	chooseFirst: boolean;
}) {
	return (
		<div className="grid grid-cols-1 gap-3 md:grid-cols-2">
			<div className="space-y-1">
				<label htmlFor={`${idPrefix}-status`} className={LABEL_CLASS}>
					New status
				</label>
				<select
					id={`${idPrefix}-status`}
					value={draft.status}
					disabled={disabled}
					onChange={(event) =>
						onChange({ ...draft, status: event.target.value as BugReportStatus | '' })
					}
					className={INPUT_CLASS}
				>
					{chooseFirst && <option value="">Choose a status…</option>}
					{BUG_REPORT_STATUSES.map((status) => (
						<option key={status} value={status} title={bugReportStatusTitle(status)}>
							{bugReportStatusLabel(status)}
						</option>
					))}
				</select>
			</div>
			{draft.status === 'duplicate' && (
				<div className="space-y-1">
					<label htmlFor={`${idPrefix}-duplicate-of`} className={LABEL_CLASS}>
						Duplicate of (report ID)
					</label>
					<input
						id={`${idPrefix}-duplicate-of`}
						value={draft.duplicateOfId}
						disabled={disabled}
						onChange={(event) => onChange({ ...draft, duplicateOfId: event.target.value })}
						placeholder="00000000-0000-0000-0000-000000000000"
						className={`${INPUT_CLASS} font-mono`}
					/>
				</div>
			)}
			{draft.status === 'ticketed' && (
				<div className="space-y-1">
					<label htmlFor={`${idPrefix}-issue-url`} className={LABEL_CLASS}>
						GitHub issue URL
					</label>
					<input
						id={`${idPrefix}-issue-url`}
						type="url"
						value={draft.githubIssueUrl}
						disabled={disabled}
						onChange={(event) => onChange({ ...draft, githubIssueUrl: event.target.value })}
						placeholder={issueUrlPlaceholder}
						className={`${INPUT_CLASS} font-mono`}
					/>
				</div>
			)}
		</div>
	);
}

function invalidateBugReports(queryClient: ReturnType<typeof useQueryClient>) {
	return queryClient.invalidateQueries(trpc.bugReports.pathFilter());
}

/**
 * One report's status change, on its detail view. Mount it keyed on the report's
 * status fields: a change that lands refetches the report, which re-keys the form and
 * starts the next change from the new status.
 */
export function BugReportStatusForm({ report }: { report: BugReportStatusFields }) {
	const queryClient = useQueryClient();
	const [draft, setDraft] = useState<StatusDraft>({
		...EMPTY_DRAFT,
		status: report.status as BugReportStatus,
	});
	const mutation = useMutation({
		mutationFn: (change: StatusChange) =>
			trpcClient.bugReports.setStatus.mutate({ reportId: report.id, ...change }),
		onSuccess: () => invalidateBugReports(queryClient),
	});
	const planned = reportDraftChange(report, draft);

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (planned.ok) mutation.mutate(planned.change);
	};

	return (
		<form onSubmit={submit} aria-label="Change status" className="space-y-3">
			<h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
				Change status
			</h3>
			<StatusFields
				idPrefix="bug-report-status"
				draft={draft}
				onChange={(next) => {
					setDraft(next);
					mutation.reset();
				}}
				disabled={mutation.isPending}
				issueUrlPlaceholder={report.githubIssueUrl ?? 'https://github.com/owner/repo/issues/1'}
				chooseFirst={false}
			/>
			{!planned.ok && planned.message && <p className="text-xs text-zinc-400">{planned.message}</p>}
			{mutation.isError && (
				<div role="alert" className={ERROR_BANNER_CLASS}>
					Status not changed: {mutation.error.message}
				</div>
			)}
			<button
				type="submit"
				disabled={!planned.ok || mutation.isPending}
				className={buttonClass('primary', 'sm')}
			>
				{mutation.isPending ? 'Changing…' : 'Change status'}
			</button>
		</form>
	);
}

/** A report a batch change is made on: its id, and its title to name a refusal by. */
export interface BatchReport {
	id: string;
	title: string;
}

/** What one batch change did: how many reports changed, and every refusal. */
export interface BatchOutcome {
	changed: number;
	refused: Array<BatchReport & { message: string }>;
}

/** Set `change` on every report, one `setStatus` each, collecting each refusal. */
export async function changeStatuses(
	reports: readonly BatchReport[],
	change: StatusChange,
): Promise<BatchOutcome> {
	const results = await Promise.allSettled(
		reports.map((report) =>
			trpcClient.bugReports.setStatus.mutate({ reportId: report.id, ...change }),
		),
	);
	const refused = reports.flatMap((report, index) => {
		const result = results[index];
		if (result?.status !== 'rejected') return [];
		const reason = result.reason as { message?: unknown } | undefined;
		const message = typeof reason?.message === 'string' ? reason.message : String(reason);
		return [{ ...report, message }];
	});
	return { changed: reports.length - refused.length, refused };
}

function BatchOutcomeBanner({ outcome }: { outcome: BatchOutcome }) {
	return (
		<div className="space-y-2" data-testid="bug-report-batch-outcome">
			{outcome.changed > 0 && (
				<div role="status" className={SUCCESS_BANNER_CLASS}>
					Changed the status of {outcome.changed} {outcome.changed === 1 ? 'report' : 'reports'}.
				</div>
			)}
			{outcome.refused.length > 0 && (
				<div role="alert" className={ERROR_BANNER_CLASS}>
					<p>
						{outcome.refused.length} {outcome.refused.length === 1 ? 'report was' : 'reports were'}{' '}
						not changed and {outcome.refused.length === 1 ? 'stays' : 'stay'} selected:
					</p>
					<ul className="mt-1 list-disc pl-5">
						{outcome.refused.map((report) => (
							<li key={report.id}>
								<span className="font-semibold">{report.title}</span>: {report.message}
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

/**
 * The list's batch status change, over the reports selected on the current page. After
 * it runs, `onDone` receives the outcome — the list keeps the refused reports selected —
 * and every bug-report query is refetched, so a changed report shows its new status, or
 * leaves the list when it no longer matches the filter.
 */
export function BugReportBatchStatusBar({
	selected,
	outcome,
	onDone,
	onClear,
}: {
	selected: readonly BatchReport[];
	outcome: BatchOutcome | null;
	onDone: (outcome: BatchOutcome) => void;
	onClear: () => void;
}) {
	const queryClient = useQueryClient();
	const [draft, setDraft] = useState<StatusDraft>(EMPTY_DRAFT);
	const mutation = useMutation({
		mutationFn: (change: StatusChange) => changeStatuses(selected, change),
		onSuccess: async (result) => {
			onDone(result);
			await invalidateBugReports(queryClient);
		},
	});
	const planned = draftChange(draft);

	const submit = (event: FormEvent) => {
		event.preventDefault();
		if (planned.ok && selected.length > 0) mutation.mutate(planned.change);
	};

	return (
		<div className="space-y-3">
			{outcome && <BatchOutcomeBanner outcome={outcome} />}
			{selected.length > 0 && (
				<form
					onSubmit={submit}
					aria-label="Change status of the selected reports"
					className="space-y-3 rounded-md border border-zinc-800 bg-panel/20 p-4"
				>
					<div className="flex items-center justify-between gap-2">
						<span className="text-xs font-semibold text-zinc-200">{selected.length} selected</span>
						<button
							type="button"
							onClick={onClear}
							disabled={mutation.isPending}
							className={buttonClass('secondary', 'xs')}
						>
							Clear selection
						</button>
					</div>
					<StatusFields
						idPrefix="bug-report-batch"
						draft={draft}
						onChange={setDraft}
						disabled={mutation.isPending}
						issueUrlPlaceholder="Empty keeps each report's own link"
						chooseFirst
					/>
					{!planned.ok && planned.message && (
						<p className="text-xs text-zinc-400">{planned.message}</p>
					)}
					<button
						type="submit"
						disabled={!planned.ok || mutation.isPending}
						className={buttonClass('primary', 'sm')}
					>
						{mutation.isPending
							? 'Changing…'
							: `Change status of ${selected.length} ${selected.length === 1 ? 'report' : 'reports'}`}
					</button>
				</form>
			)}
		</div>
	);
}
