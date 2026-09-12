import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Search, SearchX, Server } from 'lucide-react';
import { useState } from 'react';
import { WorkersTable } from '@/components/workers/workers-table.js';
import { trpc, trpcClient } from '@/lib/trpc.js';
import { filterWorkersBySearch } from '@/lib/worker-search.js';
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
 * The search box (issue #897) lives here for the same reason: this is the
 * component holding the rows, so both surfaces get it from one place and the
 * table stays presentational. It is a filter over an already-fetched list —
 * `workers.list` returns the whole visible roster in one response — so typing
 * issues no request and clearing restores the full list.
 *
 * Polling, not realtime — {@link WORKERS_REFETCH_MS} is comfortably below the
 * default 60s heartbeat TTL. Authorization lives entirely on the server
 * (`workers.list`/`roster`/`listMine`/`setConsent`/`reorderProjectWorker`); this
 * renders and mutates only what those procedures allow.
 */
export function WorkersRoster({ projectId, canReorder = false }: WorkersRosterProps) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [search, setSearch] = useState('');
	const query = search.trim();
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

	// Withheld unless all three hold: the global screen has no project order, a
	// non-administrator may not change one, and a *filtered* list is the wrong
	// thing to reorder against — a move is relative to the project's whole order,
	// so on a narrowed list the boundary arrows would disable against the wrong
	// rows and a move would step over a machine the viewer cannot see.
	const reorder =
		canReorder && projectId && query === ''
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
		const workers = workersQuery.data as WorkerRow[];
		const visible = filterWorkersBySearch(workers, query);
		return (
			<div className="space-y-4">
				<WorkersSearchBox value={search} onChange={setSearch} />
				{visible.length > 0 ? (
					<WorkersTable
						workers={visible}
						refetchInterval={WORKERS_REFETCH_MS}
						onSelectWorker={openWorker}
						reorder={reorder}
					/>
				) : (
					<NoMatchingWorkers query={query} onClear={() => setSearch('')} />
				)}
			</div>
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
 * The roster's search box (issue #897) — rendered only once the roster has rows,
 * so the "no workers at all" state stays a plain explanation with nothing to type
 * into. The query is component state rather than a route search param: it is
 * transient, and the project detail page's own `?tab=` search already owns that
 * URL.
 */
function WorkersSearchBox({
	value,
	onChange,
}: {
	value: string;
	onChange: (next: string) => void;
}) {
	return (
		<div className="relative max-w-sm">
			<Search
				className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
				aria-hidden="true"
			/>
			{/* The design-system Input recipe with its left padding widened for the icon. */}
			<input
				type="search"
				value={value}
				onChange={(event) => onChange(event.target.value)}
				aria-label="Search workers"
				placeholder="Search machine, owner, or repository…"
				className="block w-full py-2 pl-9 pr-3 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500"
			/>
		</div>
	);
}

/**
 * A search that matched nothing, deliberately distinct from the empty-roster
 * state above: that one means no machine is enrolled and tells the operator how
 * one gets here, while this one means the roster is populated and the query is
 * what hid it — so it names the query, says what is matched, and offers the way
 * back to the full list.
 */
function NoMatchingWorkers({ query, onClear }: { query: string; onClear: () => void }) {
	return (
		<div className="border border-zinc-800 rounded-lg bg-panel/20 p-8 text-center space-y-2">
			<SearchX className="w-12 h-12 stroke-1 text-zinc-700 mx-auto" />
			<p className="text-sm text-zinc-400">No workers match “{query}”.</p>
			<p className="text-xs text-zinc-500">
				Search matches a machine’s name, its owner, and the repository it declared.
			</p>
			<button
				type="button"
				onClick={onClear}
				className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors mt-2 cursor-pointer"
			>
				Clear search
			</button>
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
