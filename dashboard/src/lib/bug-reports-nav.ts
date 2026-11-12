import { z } from 'zod';
import { type ProjectRole, roleAtLeast } from '../../../src/identity/membership.js';

/**
 * Where SWARM's own bug reports live in the dashboard (issue #1443): their own page,
 * the sidebar's **Bug reports** entry under **Settings**. Until then they were the
 * `issues` tab of `/settings` (issue #1390), whose links `settings-nav.ts` redirects here.
 */
export const BUG_REPORTS_PATH = '/bug-reports';

/**
 * Search-param schema for {@link BUG_REPORTS_PATH}: the report shown in detail, so a
 * report is linkable as `/bug-reports?report=<id>` and Back returns to the list. A
 * malformed id degrades to none rather than throwing.
 */
export const bugReportsSearchSchema = z.object({
	report: z.string().uuid().optional().catch(undefined),
});

export type BugReportsSearch = z.infer<typeof bugReportsSearchSchema>;

/** Search state showing `reportId` in detail, or the list alone. */
export function bugReportsSearch(reportId: string | undefined): BugReportsSearch {
	return reportId === undefined ? {} : { report: reportId };
}

/** The slice of the signed-in user the status-change gate reads. */
export interface BugReportViewer {
	instanceAdmin: boolean;
}

/** One `projects.listMine` row: the role the viewer holds there, `null` without a membership. */
export interface BugReportViewerProject {
	id: string;
	role: ProjectRole | null;
}

/**
 * Whether the dashboard offers status controls for a report of `projectId` (`null`:
 * installation-wide) — the authorization `bugReports.setStatus` re-checks for itself
 * (`src/api/routers/bugReports.ts`): `member` on the report's project, any project for
 * an instance administrator, and an installation-wide report for an instance
 * administrator only. It decides what is *offered*; the router is the enforcement
 * point. An unresolved viewer or project list offers nothing, so no control flashes.
 */
export function canChangeBugReportStatus(
	projectId: string | null,
	viewer: BugReportViewer | null | undefined,
	projects: readonly BugReportViewerProject[] | undefined,
): boolean {
	if (!viewer) return false;
	if (viewer.instanceAdmin) return true;
	if (projectId === null) return false;
	const role = projects?.find((project) => project.id === projectId)?.role;
	return role != null && roleAtLeast(role, 'member');
}
