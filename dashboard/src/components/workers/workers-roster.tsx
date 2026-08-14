import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Server } from 'lucide-react';
import { WorkersTable } from '@/components/workers/workers-table.js';
import { trpc, trpcClient } from '@/lib/trpc.js';
import { WORKERS_REFETCH_MS } from '@/lib/workers-refresh.js';
import type { WorkerRow } from '@/types/workers.js';

interface WorkersRosterProps {
	/**
	 * Scope the roster to one project (issue #574) — the project detail page's
	 * Workers tab. Omitted on `/workers`, which shows every machine the viewer may
	 * see. Scoping is the *server's* (`workers.list`'s optional `projectId`), so
	 * enrollments elsewhere, machines enrolled in no project at all, and an active
	 * job in another project never reach the browser — and a viewer who may not
	 * access the project gets NOT_FOUND rather than a roster.
	 */
	projectId?: string;
	/**
	 * Offer the project's worker-order controls (issue #750 phase 2). The route
	 * passes the server-declared `projects.viewerAccess` capability, which fails
	 * closed while it loads, so the controls never flash in for a non-administrator;
	 * `workers.reorderProjectWorker` re-checks `projectAdmin` regardless. Ignored
	 * without a `projectId`: there is no order to change on the global screen.
	 */
	canReorder?: boolean;
}

/**
 * The worker roster body (issue #133) — the query plus its loading, error,
 * empty, and populated states — shared verbatim by the `/workers` screen and the
 * project detail page's Workers tab (issue #574). One component rather than two
 * panels, so the scoped view *is* the global experience (consent switch, current
 * job, capabilities, row navigation, poll cadence) rather than a re-implementation
 * of it that can drift.
 *
 * The one thing the scoped view has that the global one does not is the reorder
 * mutation (issue #750 phase 2), which lives here rather than in the table
 * because this is the component that already knows the project and owns the
 * `workers.list` cache the new order lands in.
 *
 * Polling, not realtime — {@link WORKERS_REFETCH_MS} is comfortably below the
 * default 60s heartbeat TTL. Authorization lives entirely on the server
 * (`workers.list`/`roster`/`listMine`/`setConsent`/`reorderProjectWorker`); this
 * renders and mutates only what those procedures allow.
 */
export function WorkersRoster({ projectId, canReorder = false }: WorkersRosterProps) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	// `undefined` rather than a no-argument call: the two variants stay on distinct
	// query keys, so a project tab never reads the global roster out of the cache.
	const workersQueryOptions = trpc.workers.list.queryOptions(projectId ? { projectId } : undefined);
	const workersQuery = useQuery({
		...workersQueryOptions,
		refetchInterval: WORKERS_REFETCH_MS,
	});

	// A row click opens that machine's detail view (issue #477). The selection is a
	// route param, not table state, so the deep link works and Back returns here.
	const openWorker = (workerId: string) => {
		navigate({ to: '/workers/$workerId', params: { workerId } });
	};

	const reorderMutation = useMutation({
		mutationFn: (variables: { workerId: string; direction: 'up' | 'down' }) => {
			if (!projectId) throw new Error('Reordering needs a project.');
			return trpcClient.workers.reorderProjectWorker.mutate({ projectId, ...variables });
		},
		onSuccess: (result) => {
			// Apply the order the server just returned before the refetch lands, so the
			// row visibly moves on click…
			queryClient.setQueryData<WorkerRow[]>(workersQueryOptions.queryKey, (old) =>
				old ? sortByWorkerIds(old, result.workerIds) : old,
			);
			// …then reconcile against the authoritative read model.
			queryClient.invalidateQueries({ queryKey: workersQueryOptions.queryKey });
		},
	});

	// Withheld unless both hold: the global screen has no project order, and a
	// non-administrator may not change one.
	const reorder =
		canReorder && projectId
			? {
					onMove: (workerId: string, direction: 'up' | 'down') =>
						reorderMutation.mutate({ workerId, direction }),
					pendingWorkerId: reorderMutation.isPending
						? reorderMutation.variables?.workerId
						: undefined,
					error:
						reorderMutation.isError && reorderMutation.variables
							? {
									workerId: reorderMutation.variables.workerId,
									message: reorderMutation.error.message,
								}
							: null,
				}
			: undefined;

	if (workersQuery.isLoading) {
		return <div className="text-sm text-zinc-400">Loading workers…</div>;
	}
	if (workersQuery.isError) {
		return (
			<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
				{workersQuery.error.message}
			</div>
		);
	}
	if (workersQuery.data && workersQuery.data.length > 0) {
		return (
			<WorkersTable
				workers={workersQuery.data as WorkerRow[]}
				refetchInterval={WORKERS_REFETCH_MS}
				onSelectWorker={openWorker}
				reorder={reorder}
			/>
		);
	}
	return (
		<div className="border border-zinc-800 rounded-lg bg-panel/20 p-8 text-center space-y-2">
			<Server className="w-12 h-12 stroke-1 text-zinc-700 mx-auto" />
			<p className="text-sm text-zinc-400">No workers to show.</p>
			<p className="text-xs text-zinc-500">
				A machine appears here once it is registered with{' '}
				<span className="font-mono">swarm workers register</span> and enrolled in{' '}
				{projectId ? 'this project' : 'a project you can access'}.
			</p>
		</div>
	);
}

/**
 * Re-sequence the cached rows to the worker-id order `reorderProjectWorker`
 * returned. A row the response doesn't name keeps its relative position at the
 * end rather than vanishing — the two lists come from the same project, so that
 * only happens if the roster changed under the move, and the invalidation right
 * after settles it either way.
 */
function sortByWorkerIds(rows: WorkerRow[], workerIds: string[]): WorkerRow[] {
	const rank = new Map(workerIds.map((workerId, index) => [workerId, index]));
	return [...rows].sort(
		(a, b) =>
			(rank.get(a.workerId) ?? Number.MAX_SAFE_INTEGER) -
			(rank.get(b.workerId) ?? Number.MAX_SAFE_INTEGER),
	);
}
