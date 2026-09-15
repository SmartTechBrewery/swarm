import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { RefreshCw, Search, SearchX, Server } from 'lucide-react';
import { useState } from 'react';
import { WorkersTable } from '@/components/workers/workers-table.js';
import { canViewInstanceWide } from '@/lib/instance-admin.js';
import { trpc, trpcClient } from '@/lib/trpc.js';
import { useCurrentUser } from '@/lib/use-current-user.js';
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
				<RosterToolbar projectId={projectId} search={search} onSearchChange={setSearch} />
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
 * The row above the table: narrowing the list on the left, acting on the fleet on
 * the right, wrapping to two rows on a phone rather than crushing either.
 *
 * It decides what it offers rather than being told, which is why it reads the
 * viewer itself. The fleet action turns on two conditions, and neither is
 * redundant. It is installation-wide — every registered machine, not the rows in
 * front of you — so it belongs only on the unscoped roster: on a project's Workers
 * tab "all workers" would read as that project's, which is not what it does. And it
 * is an instance administrator's act, asked here rather than inferred from the fact
 * that `/workers` already renders behind that gate, so mounting the roster anywhere
 * else can never hand the button to a viewer the gate would have refused. An
 * unresolved viewer offers nothing, which is `canViewInstanceWide`'s own contract.
 * The server stays the enforcement point either way, exactly as it is for the
 * roster read itself.
 */
function RosterToolbar({
	projectId,
	search,
	onSearchChange,
}: {
	projectId?: string;
	search: string;
	onSearchChange: (next: string) => void;
}) {
	const currentUser = useCurrentUser();
	const canRequestFleetUpdate = !projectId && canViewInstanceWide(currentUser.data);

	// One line: the search field grows into the space up to `max-w-sm`, the action is
	// pushed to the right edge, and only a window too narrow for both drops the button
	// to a second row rather than squeezing the input below readable.
	return (
		<div className="flex flex-wrap items-center justify-between gap-3">
			<WorkersSearchBox value={search} onChange={onSearchChange} />
			{canRequestFleetUpdate ? <FleetUpdateButton /> : null}
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
		<div className="relative flex-1 min-w-[12rem] max-w-sm">
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
 * The roster's one fleet-wide action: ask **every** registered machine to move to
 * the build the control plane is running.
 *
 * It sits in the toolbar rather than on the page header because it acts on the
 * thing below it, and it reads as one of the list's controls — the counterpart to
 * the search box, which narrows the same roster.
 *
 * **The design system's two button recipes are split here on purpose**: the
 * *hue* is the secondary one — the screen's subject is the roster, and a filled
 * violet button would read as the reason the page exists — while the *geometry* is
 * the primary one (`gap-2 px-4 py-2 text-sm font-semibold`) rather than secondary's
 * smaller `px-3 py-1.5 text-xs`. An action button is sized by what it stands next
 * to, and this one stands next to two things that are both primary-sized: the
 * other screens' violet actions, and — in its own row — the search input, whose
 * `py-2 text-sm` gives exactly this height. At the smaller recipe it sat visibly
 * short against both.
 *
 * **The label says `all`, and it means it** — every machine on the installation,
 * not the rows a search has left visible. Scoping it to the filter would make an
 * action with fleet-wide consequences depend on a transient text box, so the copy
 * names the whole set and the filter is left to do only what it looks like it does.
 *
 * Deliberately inert for now: nothing is wired to it, so it renders `disabled`
 * with a title saying so, rather than as a live-looking control that silently
 * swallows a click. Wiring it is this component's job alone — the roster passes it
 * nothing.
 */
function FleetUpdateButton() {
	return (
		<button
			type="button"
			disabled
			title="Not wired up yet — this will ask every registered machine to update to the control plane's build."
			className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors cursor-pointer disabled:opacity-55 disabled:cursor-not-allowed"
		>
			<RefreshCw className="h-4 w-4" aria-hidden="true" />
			Update all workers
		</button>
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
