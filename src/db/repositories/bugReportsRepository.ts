/**
 * The `bug_reports` / `bug_report_occurrences` store (issue #1383). Nothing here
 * authorizes or decides a status rule: the `bugReports` router
 * (`src/api/routers/bugReports.ts`) does both, and passes this module the
 * already-authorized scope and the already-validated patch.
 */

import { and, count, desc, eq, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';

import { getDb } from '../client.js';
import { bugReportOccurrences, bugReports } from '../schema/bugReports.js';

export type BugReportRow = typeof bugReports.$inferSelect;
export type BugReportOccurrenceRow = typeof bugReportOccurrences.$inferSelect;

/** What filing a report writes; the counters and timestamps are the store's. */
export interface NewBugReport {
	title: string;
	description: string;
	status: string;
	projectId: string | null;
	filedByUserId: string;
	filedByUserIdentifier: string;
	filedByRunId: string | null;
}

/** What one occurrence records; `observedAt` defaults to now. */
export interface NewBugReportOccurrence {
	runId: string | null;
	dispatchId: string | null;
	taskId: string | null;
	repository: string | null;
	prNumber: number | null;
	note: string | null;
	filedByUserId: string;
	filedByUserIdentifier: string;
	filedByRunId: string | null;
	observedAt?: Date;
}

/** The most occurrences one read returns. */
export const MAX_OCCURRENCES_PER_READ = 200;

/**
 * File a report together with its first occurrence, in one transaction: the report's
 * count starts at 1 and its first and last seen times are that occurrence's.
 */
export async function insertBugReport(input: {
	report: NewBugReport;
	occurrence: NewBugReportOccurrence;
}): Promise<{ report: BugReportRow; occurrence: BugReportOccurrenceRow }> {
	const observedAt = input.occurrence.observedAt ?? new Date();
	return getDb().transaction(async (tx) => {
		const [report] = await tx
			.insert(bugReports)
			.values({
				...input.report,
				occurrenceCount: 1,
				firstSeenAt: observedAt,
				lastSeenAt: observedAt,
			})
			.returning();
		if (!report) throw new Error('bug_reports insert returned no row');
		const [occurrence] = await tx
			.insert(bugReportOccurrences)
			.values({ ...input.occurrence, reportId: report.id, observedAt })
			.returning();
		if (!occurrence) throw new Error('bug_report_occurrences insert returned no row');
		return { report, occurrence };
	});
}

/** `value` as a literal `ILIKE` substring pattern: `%`, `_` and `\` match themselves. */
function substringPattern(value: string): string {
	return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

export interface ListBugReportsFilter {
	statuses: readonly string[];
	/**
	 * The projects whose reports may be listed, or `null` for every project — the
	 * convention of `accessibleProjectScope` (`src/api/authz.ts`).
	 */
	projectIds: readonly string[] | null;
	/** Whether installation-wide reports (no project) are listed too. */
	includeInstallationWide: boolean;
	/** Case-insensitive substring of the title or the description. */
	query?: string;
	limit: number;
	offset: number;
}

/** Reports matching `filter`, most recently seen first, with the total matching count. */
export async function listBugReports(
	filter: ListBugReportsFilter,
): Promise<{ data: BugReportRow[]; total: number }> {
	const scope =
		filter.projectIds === null
			? filter.includeInstallationWide
				? undefined
				: isNotNull(bugReports.projectId)
			: or(
					filter.projectIds.length > 0
						? inArray(bugReports.projectId, [...filter.projectIds])
						: sql`false`,
					filter.includeInstallationWide ? isNull(bugReports.projectId) : sql`false`,
				);
	const pattern = filter.query === undefined ? undefined : substringPattern(filter.query);
	const where = and(
		filter.statuses.length > 0 ? inArray(bugReports.status, [...filter.statuses]) : sql`false`,
		scope,
		pattern === undefined
			? undefined
			: or(ilike(bugReports.title, pattern), ilike(bugReports.description, pattern)),
	);

	const db = getDb();
	const [data, [totalRow]] = await Promise.all([
		db
			.select()
			.from(bugReports)
			.where(where)
			.orderBy(desc(bugReports.lastSeenAt), desc(bugReports.id))
			.limit(filter.limit)
			.offset(filter.offset),
		db.select({ total: count() }).from(bugReports).where(where),
	]);
	return { data, total: totalRow?.total ?? 0 };
}

/** One report, or `undefined` when there is none with `id`. */
export async function getBugReport(id: string): Promise<BugReportRow | undefined> {
	const [row] = await getDb().select().from(bugReports).where(eq(bugReports.id, id)).limit(1);
	return row;
}

/** A report's occurrences, newest first, at most {@link MAX_OCCURRENCES_PER_READ}. */
export async function listBugReportOccurrences(
	reportId: string,
	options: { limit: number },
): Promise<BugReportOccurrenceRow[]> {
	return getDb()
		.select()
		.from(bugReportOccurrences)
		.where(eq(bugReportOccurrences.reportId, reportId))
		.orderBy(desc(bugReportOccurrences.observedAt), desc(bugReportOccurrences.id))
		.limit(Math.min(Math.max(options.limit, 1), MAX_OCCURRENCES_PER_READ));
}

/**
 * Record one more occurrence of a report, in one transaction: the row, plus the
 * report's count and last seen time. The report row is updated first, so concurrent
 * occurrences of one report serialize on its row lock. `undefined` when the report
 * does not exist (nothing is written).
 */
export async function addBugReportOccurrence(
	reportId: string,
	occurrence: NewBugReportOccurrence,
): Promise<{ report: BugReportRow; occurrence: BugReportOccurrenceRow } | undefined> {
	const observedAt = occurrence.observedAt ?? new Date();
	return getDb().transaction(async (tx) => {
		const [report] = await tx
			.update(bugReports)
			.set({
				occurrenceCount: sql`${bugReports.occurrenceCount} + 1`,
				lastSeenAt: observedAt,
				updatedAt: new Date(),
			})
			.where(eq(bugReports.id, reportId))
			.returning();
		if (!report) return undefined;
		const [row] = await tx
			.insert(bugReportOccurrences)
			.values({ ...occurrence, reportId, observedAt })
			.returning();
		if (!row) throw new Error('bug_report_occurrences insert returned no row');
		return { report, occurrence: row };
	});
}

/**
 * Write a validated status change. `statusChanged` stamps `status_changed_at`; a
 * change of the link or the duplicate target alone leaves it. `undefined` when the
 * report does not exist.
 */
export async function updateBugReportStatus(
	id: string,
	patch: {
		status: string;
		duplicateOfId: string | null;
		githubIssueUrl: string | null;
		statusChanged: boolean;
	},
): Promise<BugReportRow | undefined> {
	const now = new Date();
	const [row] = await getDb()
		.update(bugReports)
		.set({
			status: patch.status,
			duplicateOfId: patch.duplicateOfId,
			githubIssueUrl: patch.githubIssueUrl,
			updatedAt: now,
			...(patch.statusChanged ? { statusChangedAt: now } : {}),
		})
		.where(eq(bugReports.id, id))
		.returning();
	return row;
}

/**
 * The newest occurrence an agent run filed (`filed_by_run_id = runId`), or
 * `undefined` when it filed none — the Resolve problem settle's proof that the run
 * recorded what it found (issue #1395). Filing a report records its first
 * occurrence too, so one read covers both a new report and an added occurrence.
 */
export async function findOccurrenceFiledByRun(
	runId: string,
): Promise<Pick<BugReportOccurrenceRow, 'id' | 'reportId'> | undefined> {
	const rows = await getDb()
		.select({ id: bugReportOccurrences.id, reportId: bugReportOccurrences.reportId })
		.from(bugReportOccurrences)
		.where(eq(bugReportOccurrences.filedByRunId, runId))
		.orderBy(desc(bugReportOccurrences.observedAt))
		.limit(1);
	return rows[0];
}
