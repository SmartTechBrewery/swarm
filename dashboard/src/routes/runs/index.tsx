import { useQuery } from '@tanstack/react-query';
import { createRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { EmptyRunsState } from '@/components/runs/empty-runs-state.js';
import { QueuedRunsSection } from '@/components/runs/queued-runs-section.js';
import { RunFilters } from '@/components/runs/run-filters.js';
import { RunsTable } from '@/components/runs/runs-table.js';
import { canViewInstanceWide } from '@/lib/instance-admin.js';
import { queuedListRefetchInterval, runsListRefetchInterval } from '@/lib/runs-refresh.js';
import { trpc } from '@/lib/trpc.js';
import { useCurrentUser } from '@/lib/use-current-user.js';
import { type RunRow, runPhaseFilterSchema, runStatusFilterSchema } from '@/types/runs.js';
import { rootRoute } from '../__root.js';

const PAGE_SIZE = 20;

const runsSearchSchema = z.object({
	projectId: z.string().optional(),
	status: runStatusFilterSchema.optional(),
	phase: runPhaseFilterSchema.optional(),
	page: z.number().int().positive().optional(),
});

type RunsSearch = z.infer<typeof runsSearchSchema>;

/**
 * The cross-project Runs History screen. Open to every signed-in user since
 * issue #821: the runs table is bounded server-side to the projects the caller
 * belongs to (`runs.list`, `src/api/routers/runs.ts`), so a member sees all of
 * their own work in one place while an instance administrator still sees the
 * whole installation. It used to render behind `InstanceAdminOnly` (issue #647),
 * which is why a member had to open one project at a time to see any run at all.
 *
 * The queue below it did *not* move: `runs.queued` is still installation-wide and
 * instance-admin-only, so the section is rendered — and its query issued — only
 * for an administrator. Scoping the queue the same way is a separate change.
 */
export function RunsRouteComponent() {
	const search = runsIndexRoute.useSearch() as RunsSearch;
	const navigate = useNavigate({ from: '/runs' });
	const currentPage = search.page ?? 1;
	const { data: currentUser } = useCurrentUser();
	const canReadQueue = canViewInstanceWide(currentUser);

	const handleFilterChange = (updates: Partial<RunsSearch>) => {
		navigate({
			search: (old: any) => {
				const next = { ...old, ...updates };
				if (!('page' in updates)) {
					next.page = undefined;
				}
				return next;
			},
		});
	};

	const handleClearFilters = () => {
		navigate({
			search: () => ({}),
		});
	};

	const runsQuery = useQuery({
		...trpc.runs.list.queryOptions({
			projectId: search.projectId || undefined,
			status: search.status || undefined,
			phase: search.phase || undefined,
			limit: PAGE_SIZE,
			offset: (currentPage - 1) * PAGE_SIZE,
		}),
		refetchInterval: (query) => runsListRefetchInterval(query.state.data),
	});

	// Enqueued-but-not-yet-running work (issue #238). Independent of the runs
	// table's status/phase filters — only the project scope applies — and never
	// gates the table below. The response is server-partitioned into the queue
	// itself and the board dispatches proven to start no phase (issue #570); only
	// the former paces the poll.
	//
	// Only issued for a caller the unscoped queue is actually available to
	// (issue #821): without a `projectId` it is instance-admin-only, so a member
	// opening this screen would otherwise poll a guaranteed `FORBIDDEN`. Picking a
	// project in the filters makes it a project-scoped read their membership
	// already covers, so the query runs for anyone once one is chosen.
	const queuedQuery = useQuery({
		...trpc.runs.queued.queryOptions({ projectId: search.projectId || undefined }),
		enabled: canReadQueue || !!search.projectId,
		refetchInterval: (query) => queuedListRefetchInterval(query.state.data?.items),
	});

	const hasActiveFilters = !!(search.projectId || search.status || search.phase);

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Runs History</h1>
			</div>

			<RunFilters
				projectId={search.projectId}
				status={search.status}
				phase={search.phase}
				onProjectIdChange={(projectId) => handleFilterChange({ projectId })}
				onStatusChange={(status) => handleFilterChange({ status: status as RunsSearch['status'] })}
				onPhaseChange={(phase) => handleFilterChange({ phase: phase as RunsSearch['phase'] })}
				onClear={handleClearFilters}
			/>

			{(canReadQueue || search.projectId) && (
				<QueuedRunsSection
					items={queuedQuery.data?.items ?? []}
					noTriggerItems={queuedQuery.data?.noTrigger ?? []}
					projectId={search.projectId || undefined}
				/>
			)}

			{runsQuery.isLoading ? (
				<div className="text-sm text-zinc-400">Loading runs history…</div>
			) : runsQuery.isError ? (
				<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
					{runsQuery.error.message}
				</div>
			) : runsQuery.data && runsQuery.data.data.length > 0 ? (
				<RunsTable
					runs={runsQuery.data.data as RunRow[]}
					totalCount={runsQuery.data.total}
					currentPage={currentPage}
					pageSize={PAGE_SIZE}
					onPageChange={(page) => handleFilterChange({ page })}
				/>
			) : (
				<EmptyRunsState hasFilters={hasActiveFilters} onClear={handleClearFilters} />
			)}
		</div>
	);
}

export const runsIndexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/runs',
	validateSearch: (search) => runsSearchSchema.parse(search),
	component: RunsRouteComponent,
});
