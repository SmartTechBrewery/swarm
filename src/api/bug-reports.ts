/**
 * SWARM's own **bug reports** (issue #1383) — the shared vocabulary of the store:
 * the statuses and what each means, the procedures' input shapes, and the rules a
 * status change must satisfy.
 *
 * A bug report records a defect *in SWARM itself* (or in what it runs on) that an
 * agent or a person observed: its title and description, the project it was seen
 * in (none for an installation-wide one), and every **occurrence** — the run,
 * dispatch, pull request or task it was observed on. Reports are triaged through
 * {@link BUG_REPORT_STATUSES}; turning one into a GitHub issue happens outside
 * SWARM and is then recorded as `ticketed` with the issue's link.
 *
 * Browser-safe on purpose: this module imports Zod alone — no database, no node
 * built-in, not even `@trpc/server` (the dashboard does not depend on it) — so the
 * dashboard's Issues tab (phase 2) reads the very same statuses and schemas the API
 * enforces. That is why {@link validateStatusChange} returns its refusal instead of
 * throwing a `TRPCError`; the router (`./routers/bugReports.ts`) throws it.
 */

import { z } from 'zod';

/** Every status a bug report can be in, in triage order. */
export const BUG_REPORT_STATUSES = [
	'new',
	'confirmed',
	'environmental',
	'duplicate',
	'ticketed',
	'resolved',
	'dismissed',
] as const;

export const BugReportStatusSchema = z.enum(BUG_REPORT_STATUSES);
export type BugReportStatus = z.infer<typeof BugReportStatusSchema>;

/**
 * The statuses of a report still wanting attention — what a list shows when it is
 * asked for no status. `duplicate`, `resolved` and `dismissed` are closed.
 */
export const OPEN_BUG_REPORT_STATUSES = [
	'new',
	'confirmed',
	'environmental',
	'ticketed',
] as const satisfies readonly BugReportStatus[];

/**
 * The statuses a report may be filed in. The others describe what triage decided
 * about an existing report (a duplicate of which, the issue it became), so they are
 * reached through a status change only.
 */
export const INITIAL_BUG_REPORT_STATUSES = [
	'new',
	'confirmed',
	'environmental',
] as const satisfies readonly BugReportStatus[];

/** One line on what each status means — reused by the MCP tool descriptions and docs. */
export const BUG_REPORT_STATUS_DESCRIPTIONS: Record<BugReportStatus, string> = {
	new: 'filed, not yet looked at',
	confirmed: 'reproduced or otherwise confirmed as a defect in SWARM',
	environmental:
		'cause outside SWARM (network, CLI quota, Docker, a machine); potentially not actionable',
	duplicate: 'the same problem as another report, named by `duplicateOfId` (closed)',
	ticketed: 'turned into a GitHub issue, linked by `githubIssueUrl`',
	resolved: 'fixed (closed)',
	dismissed: 'not a defect, or not worth acting on (closed)',
};

/** The most rows one list or occurrence read returns. */
export const BUG_REPORT_PAGE_MAX = 200;

const reportId = z.string().uuid();

/** An `https:` URL — the only kind a report's issue link may be. */
const httpsUrl = z
	.string()
	.url()
	.refine((value) => new URL(value).protocol === 'https:', 'The issue link must be an https URL.');

/**
 * Where an occurrence was observed, plus who observed it: every field optional. A
 * `runId` places the occurrence in that run's project; `filedByRunId` is the agent
 * run that is filing (the caller states it; it must be a run the caller can read).
 */
const occurrenceContextFields = {
	runId: z.string().min(1).optional(),
	dispatchId: z.string().min(1).optional(),
	prNumber: z.number().int().positive().optional(),
	taskId: z.string().min(1).optional(),
	repository: z.string().min(1).optional(),
	note: z.string().trim().min(1).max(10_000).optional(),
	filedByRunId: z.string().min(1).optional(),
};

/** `bugReports.list`'s input. No `status` means the {@link OPEN_BUG_REPORT_STATUSES}. */
export const ListBugReportsInputSchema = z.object({
	projectId: z.string().min(1).optional(),
	status: z.union([BugReportStatusSchema, z.array(BugReportStatusSchema).min(1)]).optional(),
	/** Case-insensitive substring of the title or the description. */
	query: z.string().trim().min(1).max(200).optional(),
	limit: z.number().int().positive().max(BUG_REPORT_PAGE_MAX).default(50),
	offset: z.number().int().nonnegative().default(0),
});
export type ListBugReportsInput = z.infer<typeof ListBugReportsInputSchema>;

/** `bugReports.get`'s input. */
export const GetBugReportInputSchema = z.object({
	reportId,
	occurrenceLimit: z.number().int().positive().max(BUG_REPORT_PAGE_MAX).default(50),
});

/**
 * `bugReports.create`'s (and `previewCreate`'s) input. With no `projectId`, a
 * `runId` places the report in its run's project; with neither, the report is
 * installation-wide.
 */
export const CreateBugReportInputSchema = z.object({
	title: z.string().trim().min(1).max(200),
	description: z.string().trim().min(1).max(20_000),
	projectId: z.string().min(1).optional(),
	status: z.enum(INITIAL_BUG_REPORT_STATUSES).optional(),
	...occurrenceContextFields,
});
export type CreateBugReportInput = z.infer<typeof CreateBugReportInputSchema>;

/** `bugReports.addOccurrence`'s (and `previewAddOccurrence`'s) input. */
export const AddBugReportOccurrenceInputSchema = z.object({
	reportId,
	...occurrenceContextFields,
});
export type AddBugReportOccurrenceInput = z.infer<typeof AddBugReportOccurrenceInputSchema>;

/** `bugReports.setStatus`'s (and `previewSetStatus`'s) input. */
export const SetBugReportStatusInputSchema = z.object({
	reportId,
	status: BugReportStatusSchema,
	duplicateOfId: reportId.optional(),
	githubIssueUrl: httpsUrl.optional(),
});
export type SetBugReportStatusInput = z.infer<typeof SetBugReportStatusInputSchema>;

/** The part of a report a status change reads and writes. */
export interface BugReportStatusFields {
	id: string;
	status: string;
	duplicateOfId: string | null;
	githubIssueUrl: string | null;
}

/** What a status change writes. */
export interface BugReportStatusPatch {
	status: BugReportStatus;
	duplicateOfId: string | null;
	githubIssueUrl: string | null;
}

/**
 * Whether `input` may change `report`'s status, and the patch it writes:
 *
 *  - `duplicate` needs a `duplicateOfId` (or keeps the one the report already has),
 *    never the report itself; any other status clears it, and naming one with any
 *    other status is refused.
 *  - `ticketed` needs a `githubIssueUrl` unless the report already has one. A link
 *    given with any other status is stored too, and a stored link is kept.
 *  - Re-setting the current status with nothing else changed is refused, so a call
 *    that changes nothing is never recorded as a change.
 *
 * Whether the duplicate target exists, and is the caller's to read, is the router's
 * check.
 */
export function validateStatusChange(
	report: BugReportStatusFields,
	input: Pick<SetBugReportStatusInput, 'status' | 'duplicateOfId' | 'githubIssueUrl'>,
): { ok: true; patch: BugReportStatusPatch } | { ok: false; message: string } {
	let duplicateOfId: string | null = null;
	if (input.status === 'duplicate') {
		duplicateOfId =
			input.duplicateOfId ?? (report.status === 'duplicate' ? report.duplicateOfId : null);
		if (!duplicateOfId) {
			return { ok: false, message: 'Status "duplicate" needs `duplicateOfId`.' };
		}
		if (duplicateOfId === report.id) {
			return { ok: false, message: 'A bug report cannot be a duplicate of itself.' };
		}
	} else if (input.duplicateOfId !== undefined) {
		return {
			ok: false,
			message: `\`duplicateOfId\` is accepted only with status "duplicate", not "${input.status}".`,
		};
	}

	const githubIssueUrl = input.githubIssueUrl ?? report.githubIssueUrl;
	if (input.status === 'ticketed' && !githubIssueUrl) {
		return { ok: false, message: 'Status "ticketed" needs `githubIssueUrl`.' };
	}

	const patch: BugReportStatusPatch = { status: input.status, duplicateOfId, githubIssueUrl };
	if (
		patch.status === report.status &&
		patch.duplicateOfId === report.duplicateOfId &&
		patch.githubIssueUrl === report.githubIssueUrl
	) {
		return { ok: false, message: `The bug report is already "${report.status}".` };
	}
	return { ok: true, patch };
}
