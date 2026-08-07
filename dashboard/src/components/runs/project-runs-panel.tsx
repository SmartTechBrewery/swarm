import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { EmptyRunsState } from '@/components/runs/empty-runs-state.js';
import { QueuedRunsSection } from '@/components/runs/queued-runs-section.js';
import { RunFilters } from '@/components/runs/run-filters.js';
import { RunsTable } from '@/components/runs/runs-table.js';
import { queuedListRefetchInterval, runsListRefetchInterval } from '@/lib/runs-refresh.js';
import { trpc } from '@/lib/trpc.js';
import type { RunPhaseFilter, RunRow, RunStatusFilter } from '@/types/runs.js';

const PAGE_SIZE = 20;

interface ProjectRunsPanelProps {
	projectId: string;
}

/**
 * The global `/runs` view scoped to a single project (issue #168): the same
 * table, filters, pagination, row navigation, and live-refresh behavior, but the
 * `projectId` is pinned so only this project's runs show. The Project column and
 * project selector are dropped (both redundant when scoped) via the shared
 * components' `showProject={false}`.
 *
 * Filter/pagination state lives in local component state rather than URL search
 * params — this is a tab inside the project detail page, not a standalone route.
 */
export function ProjectRunsPanel({ projectId }: ProjectRunsPanelProps) {
	const [status, setStatus] = useState<RunStatusFilter>();
	const [phase, setPhase] = useState<RunPhaseFilter>();
	const [page, setPage] = useState(1);

	const runsQuery = useQuery({
		...trpc.runs.list.queryOptions({
			projectId,
			status,
			phase,
			limit: PAGE_SIZE,
			offset: (page - 1) * PAGE_SIZE,
		}),
		refetchInterval: (query) => runsListRefetchInterval(query.state.data),
	});

	// Enqueued-but-not-yet-running work for this project (issue #238). Scoped to
	// `projectId`; the Project column is dropped since every row is this project.
	// `data.items` is the queue; `data.noTrigger` the board dispatches the server
	// proved start no phase (issue #570), which don't pace the poll.
	const queuedQuery = useQuery({
		...trpc.runs.queued.queryOptions({ projectId }),
		refetchInterval: (query) => queuedListRefetchInterval(query.state.data?.items),
	});

	const hasActiveFilters = !!(status || phase);

	// Any filter change resets to the first page, matching the global Runs view.
	const handleStatusChange = (next: string | undefined) => {
		setStatus(next as RunStatusFilter | undefined);
		setPage(1);
	};
	const handlePhaseChange = (next: string | undefined) => {
		setPhase(next as RunPhaseFilter | undefined);
		setPage(1);
	};
	const handleClearFilters = () => {
		setStatus(undefined);
		setPhase(undefined);
		setPage(1);
	};

	return (
		<div className="space-y-6">
			<RunFilters
				showProject={false}
				status={status}
				phase={phase}
				onProjectIdChange={() => {}}
				onStatusChange={handleStatusChange}
				onPhaseChange={handlePhaseChange}
				onClear={handleClearFilters}
			/>

			<QueuedRunsSection
				items={queuedQuery.data?.items ?? []}
				noTriggerItems={queuedQuery.data?.noTrigger ?? []}
				showProject={false}
				projectId={projectId}
			/>

			{runsQuery.isLoading ? (
				<div className="text-sm text-zinc-400">Loading runs history…</div>
			) : runsQuery.isError ? (
				<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
					{runsQuery.error.message}
				</div>
			) : runsQuery.data && runsQuery.data.data.length > 0 ? (
				<RunsTable
					showProject={false}
					runs={runsQuery.data.data as RunRow[]}
					totalCount={runsQuery.data.total}
					currentPage={page}
					pageSize={PAGE_SIZE}
					onPageChange={setPage}
				/>
			) : (
				<EmptyRunsState hasFilters={hasActiveFilters} onClear={handleClearFilters} />
			)}
		</div>
	);
}
