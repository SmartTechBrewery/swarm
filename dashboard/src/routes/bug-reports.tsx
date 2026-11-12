import { createRoute, useNavigate } from '@tanstack/react-router';
import { BugReportsPanel } from '@/components/bug-reports/bug-reports-panel.js';
import {
	BUG_REPORTS_PATH,
	bugReportsSearch,
	bugReportsSearchSchema,
} from '@/lib/bug-reports-nav.js';
import { rootRoute } from './__root.js';

/**
 * SWARM's own bug reports (issue #1443) — the sidebar's **Bug reports** entry, under
 * **Settings** in the General group. They were the `/settings` Issues tab until then
 * (issue #1390); that route redirects its old links here.
 *
 * Every signed-in user may open it: `bugReports.list` scopes what it lists to the
 * reports of the projects the viewer may read, plus installation-wide ones for an
 * instance administrator only.
 */
function BugReportsRouteComponent() {
	const navigate = useNavigate();
	const search = bugReportsRoute.useSearch();
	const goToReport = (reportId: string | undefined) => {
		navigate({ to: BUG_REPORTS_PATH, search: bugReportsSearch(reportId) });
	};

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Bug reports</h1>
				<p className="text-xs text-zinc-500 mt-1">
					Defects in SWARM itself, or in what it runs on, and their triage.
				</p>
			</div>
			<BugReportsPanel selectedReportId={search.report} onSelectReport={goToReport} />
		</div>
	);
}

export const bugReportsRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: BUG_REPORTS_PATH,
	validateSearch: (search) => bugReportsSearchSchema.parse(search),
	component: BugReportsRouteComponent,
});
