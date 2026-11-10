/**
 * The `bugReports` router (issue #1383) — SWARM's own bug-report store
 * (`../bug-reports.ts` for the statuses and rules, `bugReportsRepository.ts` for the
 * tables). The operator MCP server's five bug-report tools wrap these procedures
 * (`src/mcp/tools/bug-reports.ts`); the dashboard's Issues tab (phase 2) reads them.
 *
 * **Authorization is `../authz.ts`'s alone**, as for every project-scoped procedure:
 *
 *  - A report with a project is that project's: reading it needs `contributor`
 *    (`canReadProject`), any write `member` (`canWriteProject`, the floor the run
 *    write tools need), and a non-member gets `NOT_FOUND` naming the report, never
 *    the project.
 *  - A report with no project is **installation-wide**, decided by
 *    `assertInstanceAdmin` — but refused as `NOT_FOUND` for anyone else, so its
 *    existence is not revealed. A scoped agent credential never reads or files one.
 *  - A `runId` (or `filedByRunId`) must be a run the caller can read, else it reads
 *    as `NOT_FOUND`, so a report can neither claim nor locate a run the caller cannot see.
 *
 * Every write has a `preview…` query gated exactly as it is and running the same
 * plan, which the MCP write tool runs first (its dry run and its pre-write check);
 * the mutation re-runs the whole plan rather than trusting the preview's.
 */

import { TRPCError } from '@trpc/server';

import {
	addBugReportOccurrence,
	type BugReportOccurrenceRow,
	type BugReportRow,
	getBugReport,
	insertBugReport,
	listBugReportOccurrences,
	listBugReports,
	type NewBugReport,
	type NewBugReportOccurrence,
	updateBugReportStatus,
} from '../../db/repositories/bugReportsRepository.js';
import { getRunByIdFromDb } from '../../db/repositories/runsRepository.js';
import type { ProjectRole } from '../../identity/membership.js';
import type { SwarmUser } from '../../identity/schema.js';
import {
	accessibleProjectScope,
	assertInstanceAdmin,
	assertProjectAccess,
	mayAccessProject,
} from '../authz.js';
import {
	type AddBugReportOccurrenceInput,
	AddBugReportOccurrenceInputSchema,
	type BugReportStatusPatch,
	type CreateBugReportInput,
	CreateBugReportInputSchema,
	GetBugReportInputSchema,
	ListBugReportsInputSchema,
	OPEN_BUG_REPORT_STATUSES,
	type SetBugReportStatusInput,
	SetBugReportStatusInputSchema,
	validateStatusChange,
} from '../bug-reports.js';
import { authedProcedure, router } from '../trpc.js';

/** The `assertInstanceAdmin` view name an installation-wide report is checked under. */
const INSTALLATION_VIEW = 'bug reports';

function reportNotFound(reportId: string): TRPCError {
	return new TRPCError({ code: 'NOT_FOUND', message: `Bug report "${reportId}" not found.` });
}

function badRequest(message: string): TRPCError {
	return new TRPCError({ code: 'BAD_REQUEST', message });
}

/** Whether `user` may see installation-wide reports — `assertInstanceAdmin`'s decision. */
function mayReadInstallationWide(user: SwarmUser): boolean {
	try {
		assertInstanceAdmin(user, INSTALLATION_VIEW);
		return true;
	} catch {
		return false;
	}
}

/**
 * Throw unless `user` may act on `report` at `minRole`: the report's project decides,
 * through `assertProjectAccess`; an installation-wide report needs an instance
 * administrator. Either refusal of a reader with no access reads as the report not
 * existing.
 */
async function assertBugReportAccess(
	user: SwarmUser,
	report: Pick<BugReportRow, 'id' | 'projectId'>,
	minRole: ProjectRole,
): Promise<void> {
	if (report.projectId !== null) {
		await assertProjectAccess(
			user,
			report.projectId,
			minRole,
			`Bug report "${report.id}" not found.`,
		);
		return;
	}
	if (!mayReadInstallationWide(user)) throw reportNotFound(report.id);
}

/** Whether `user` may read `report` — {@link assertBugReportAccess} at `contributor`, as a boolean. */
async function mayReadBugReport(
	user: SwarmUser,
	report: Pick<BugReportRow, 'projectId'>,
): Promise<boolean> {
	if (report.projectId !== null) return mayAccessProject(user, report.projectId, 'contributor');
	return mayReadInstallationWide(user);
}

/** The report `reportId`, once `user` is known to hold `minRole` on it. */
async function loadBugReport(
	user: SwarmUser,
	reportId: string,
	minRole: ProjectRole,
): Promise<BugReportRow> {
	const report = await getBugReport(reportId);
	if (!report) throw reportNotFound(reportId);
	await assertBugReportAccess(user, report, minRole);
	return report;
}

/** The run `runId`, once `user` is known to read its project; `NOT_FOUND` otherwise. */
async function loadReadableRun(user: SwarmUser, runId: string): Promise<{ projectId: string }> {
	const notFound = `Run with ID "${runId}" not found`;
	const run = await getRunByIdFromDb(runId);
	if (!run) throw new TRPCError({ code: 'NOT_FOUND', message: notFound });
	await assertProjectAccess(user, run.projectId, 'contributor', notFound);
	return run;
}

/** The occurrence `input` describes, filed by `user`. */
function occurrenceFrom(
	user: SwarmUser,
	input: Pick<
		CreateBugReportInput,
		'runId' | 'dispatchId' | 'taskId' | 'repository' | 'prNumber' | 'note' | 'filedByRunId'
	>,
): NewBugReportOccurrence {
	return {
		runId: input.runId ?? null,
		dispatchId: input.dispatchId ?? null,
		taskId: input.taskId ?? null,
		repository: input.repository ?? null,
		prNumber: input.prNumber ?? null,
		note: input.note ?? null,
		filedByUserId: user.id,
		filedByUserIdentifier: user.identifier,
		filedByRunId: input.filedByRunId ?? null,
	};
}

export interface CreatePlan {
	projectId: string | null;
	report: NewBugReport;
	occurrence: NewBugReportOccurrence;
}

/**
 * Authorize and resolve a report filing: its project is `projectId`, else `runId`'s
 * project, else none (installation-wide, instance administrators only). A `runId` in
 * another project than the `projectId` named is refused.
 */
async function planCreate(user: SwarmUser, input: CreateBugReportInput): Promise<CreatePlan> {
	if (input.projectId !== undefined) {
		await assertProjectAccess(user, input.projectId, 'member');
	}
	let projectId = input.projectId ?? null;
	if (input.runId !== undefined) {
		const run = await loadReadableRun(user, input.runId);
		if (projectId !== null && run.projectId !== projectId) {
			throw badRequest(`Run "${input.runId}" is not a run of project "${projectId}".`);
		}
		if (projectId === null) {
			await assertProjectAccess(user, run.projectId, 'member');
			projectId = run.projectId;
		}
	}
	if (projectId === null && !mayReadInstallationWide(user)) {
		throw new TRPCError({
			code: 'FORBIDDEN',
			message:
				'An installation-wide bug report (no `projectId` or `runId`) can be filed by instance administrators only. Name the project it was observed in.',
		});
	}
	if (input.filedByRunId !== undefined) await loadReadableRun(user, input.filedByRunId);
	return {
		projectId,
		report: {
			title: input.title,
			description: input.description,
			status: input.status ?? 'new',
			projectId,
			filedByUserId: user.id,
			filedByUserIdentifier: user.identifier,
			filedByRunId: input.filedByRunId ?? null,
		},
		occurrence: occurrenceFrom(user, input),
	};
}

/** What adding an occurrence would do, as `previewAddOccurrence` reports it. */
export interface AddOccurrencePreview {
	projectId: string | null;
	report: Pick<BugReportRow, 'id' | 'title' | 'status'>;
	occurrenceCount: { from: number; to: number };
	occurrence: NewBugReportOccurrence;
	/** Set when the report is closed or a duplicate: the occurrence is still recorded. */
	warning?: string;
	/** A duplicate's original — the report the occurrence might belong on instead. */
	duplicateOfId?: string;
}

/**
 * Authorize and resolve an occurrence: `member` on the report, and a `runId` the
 * caller can read in the report's own project (any readable run, for an
 * installation-wide report).
 */
async function planAddOccurrence(
	user: SwarmUser,
	input: AddBugReportOccurrenceInput,
): Promise<AddOccurrencePreview> {
	const report = await loadBugReport(user, input.reportId, 'member');
	if (input.runId !== undefined) {
		const run = await loadReadableRun(user, input.runId);
		if (report.projectId !== null && run.projectId !== report.projectId) {
			throw badRequest(
				`Run "${input.runId}" is not a run of project "${report.projectId}", which bug report "${report.id}" belongs to.`,
			);
		}
	}
	if (input.filedByRunId !== undefined) await loadReadableRun(user, input.filedByRunId);
	const closed = !(OPEN_BUG_REPORT_STATUSES as readonly string[]).includes(report.status);
	return {
		projectId: report.projectId,
		report: { id: report.id, title: report.title, status: report.status },
		occurrenceCount: { from: report.occurrenceCount, to: report.occurrenceCount + 1 },
		occurrence: occurrenceFrom(user, input),
		...(closed ? { warning: `report is ${report.status}` } : {}),
		...(report.status === 'duplicate' && report.duplicateOfId !== null
			? { duplicateOfId: report.duplicateOfId }
			: {}),
	};
}

/** What a status change would do, as `previewSetStatus` reports it. */
export interface SetStatusPreview {
	projectId: string | null;
	change: { from: string; to: string };
	githubIssueUrl: { from: string | null; to: string | null };
	duplicateOfId: { from: string | null; to: string | null };
}

/**
 * Authorize and validate a status change: `member` on the report, the rules of
 * `validateStatusChange`, and a duplicate target that exists and that the caller may read.
 */
async function planSetStatus(
	user: SwarmUser,
	input: SetBugReportStatusInput,
): Promise<{ report: BugReportRow; patch: BugReportStatusPatch; preview: SetStatusPreview }> {
	const report = await loadBugReport(user, input.reportId, 'member');
	const decision = validateStatusChange(report, input);
	if (!decision.ok) throw badRequest(decision.message);
	const { patch } = decision;
	if (patch.duplicateOfId !== null && patch.duplicateOfId !== report.duplicateOfId) {
		const target = await getBugReport(patch.duplicateOfId);
		if (!target || !(await mayReadBugReport(user, target))) {
			throw reportNotFound(patch.duplicateOfId);
		}
	}
	return {
		report,
		patch,
		preview: {
			projectId: report.projectId,
			change: { from: report.status, to: patch.status },
			githubIssueUrl: { from: report.githubIssueUrl, to: patch.githubIssueUrl },
			duplicateOfId: { from: report.duplicateOfId, to: patch.duplicateOfId },
		},
	};
}

export const bugReportsRouter = router({
	/**
	 * Reports, most recently seen first, as `{ data, total }`. Every project the
	 * caller may read (plus installation-wide reports for an instance administrator),
	 * or `projectId`'s alone. No `status` lists the open ones.
	 */
	list: authedProcedure.input(ListBugReportsInputSchema).query(async ({ ctx, input }) => {
		const statuses =
			input.status === undefined
				? [...OPEN_BUG_REPORT_STATUSES]
				: Array.isArray(input.status)
					? input.status
					: [input.status];
		let projectIds: readonly string[] | null;
		let includeInstallationWide: boolean;
		if (input.projectId !== undefined) {
			await assertProjectAccess(ctx.user, input.projectId, 'contributor');
			projectIds = [input.projectId];
			includeInstallationWide = false;
		} else {
			projectIds = await accessibleProjectScope(ctx.user);
			includeInstallationWide = mayReadInstallationWide(ctx.user);
		}
		return listBugReports({
			statuses,
			projectIds,
			includeInstallationWide,
			query: input.query,
			limit: input.limit,
			offset: input.offset,
		});
	}),

	/**
	 * One report with its newest occurrences, and the report it duplicates — named only
	 * when the caller may read it, otherwise `null`.
	 */
	get: authedProcedure.input(GetBugReportInputSchema).query(
		async ({
			ctx,
			input,
		}): Promise<{
			report: BugReportRow;
			occurrences: BugReportOccurrenceRow[];
			duplicateOf: Pick<BugReportRow, 'id' | 'title' | 'status'> | null;
		}> => {
			const report = await loadBugReport(ctx.user, input.reportId, 'contributor');
			const occurrences = await listBugReportOccurrences(report.id, {
				limit: input.occurrenceLimit,
			});
			const target =
				report.duplicateOfId === null ? undefined : await getBugReport(report.duplicateOfId);
			const duplicateOf =
				target && (await mayReadBugReport(ctx.user, target))
					? { id: target.id, title: target.title, status: target.status }
					: null;
			return { report, occurrences, duplicateOf };
		},
	),

	// Read-only, gated exactly as `create`: the report and first occurrence it would write.
	previewCreate: authedProcedure
		.input(CreateBugReportInputSchema)
		.query(async ({ ctx, input }) => planCreate(ctx.user, input)),

	create: authedProcedure.input(CreateBugReportInputSchema).mutation(async ({ ctx, input }) => {
		const plan = await planCreate(ctx.user, input);
		return insertBugReport({ report: plan.report, occurrence: plan.occurrence });
	}),

	// Read-only, gated exactly as `addOccurrence`.
	previewAddOccurrence: authedProcedure
		.input(AddBugReportOccurrenceInputSchema)
		.query(async ({ ctx, input }) => planAddOccurrence(ctx.user, input)),

	addOccurrence: authedProcedure
		.input(AddBugReportOccurrenceInputSchema)
		.mutation(async ({ ctx, input }) => {
			const plan = await planAddOccurrence(ctx.user, input);
			const added = await addBugReportOccurrence(input.reportId, plan.occurrence);
			if (!added) throw reportNotFound(input.reportId);
			return added;
		}),

	// Read-only, gated exactly as `setStatus`.
	previewSetStatus: authedProcedure
		.input(SetBugReportStatusInputSchema)
		.query(async ({ ctx, input }) => (await planSetStatus(ctx.user, input)).preview),

	setStatus: authedProcedure
		.input(SetBugReportStatusInputSchema)
		.mutation(async ({ ctx, input }) => {
			const { report, patch } = await planSetStatus(ctx.user, input);
			const updated = await updateBugReportStatus(report.id, {
				...patch,
				statusChanged: patch.status !== report.status,
			});
			if (!updated) throw reportNotFound(report.id);
			return updated;
		}),
});
