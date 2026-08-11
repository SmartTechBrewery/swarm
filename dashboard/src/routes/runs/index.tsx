import { useQuery } from '@tanstack/react-query';
import { createRoute, useNavigate } from '@tanstack/react-router';
import { z } from 'zod';
import { InstanceAdminOnly } from '@/components/layout/instance-admin-only.js';
import { EmptyRunsState } from '@/components/runs/empty-runs-state.js';
import { QueuedRunsSection } from '@/components/runs/queued-runs-section.js';
import { RunFilters } from '@/components/runs/run-filters.js';
import { RunsTable } from '@/components/runs/runs-table.js';
import { queuedListRefetchInterval, runsListRefetchInterval } from '@/lib/runs-refresh.js';
import { trpc } from '@/lib/trpc.js';
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
 * The installation-wide Runs History screen: every project's runs and the whole
 * queue. It is an operator's view, so the route renders it behind
 * {@link InstanceAdminOnly} (see {@link RunsScreen}); a worker owner reads their
 * runs on the project detail page's Runs tab instead (issue #647).
 */
export function RunsRouteComponent() {
	const search = runsIndexRoute.useSearch() as RunsSearch;
	const navigate = useNavigate({ from: '/runs' });
	const currentPage = search.page ?? 1;

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
	const queuedQuery = useQuery({
		...trpc.runs.queued.queryOptions({ projectId: search.projectId || undefined }),
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

			<QueuedRunsSection
				items={queuedQuery.data?.items ?? []}
				noTriggerItems={queuedQuery.data?.noTrigger ?? []}
				projectId={search.projectId || undefined}
			/>

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

/**
 * What the route actually mounts (issue #647): the screen behind the
 * instance-admin gate. Denied, the screen never mounts, so neither `runs.list`
 * nor `runs.queued` is issued.
 */
export function RunsScreen() {
	return (
		<InstanceAdminOnly view="runs">
			<RunsRouteComponent />
		</InstanceAdminOnly>
	);
}

export const runsIndexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/runs',
	validateSearch: (search) => runsSearchSchema.parse(search),
	component: RunsScreen,
});
