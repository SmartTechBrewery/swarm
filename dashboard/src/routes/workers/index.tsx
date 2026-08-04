import { useQuery } from '@tanstack/react-query';
import { createRoute, useNavigate } from '@tanstack/react-router';
import { Server } from 'lucide-react';
import { WorkersTable } from '@/components/workers/workers-table.js';
import { trpc } from '@/lib/trpc.js';
import type { WorkerRow } from '@/types/workers.js';
import { rootRoute } from '../__root.js';

/**
 * The **Workers** screen (issue #133): which machines are enrolled and
 * connected, what they can run, and which job they are running right now. Per
 * project it also shows availability for automatic dispatch, and lets the
 * signed-in operator toggle it on the workers they own (issue #282). It stays the
 * scannable index: everything else a machine carries — and the controls that
 * administer it — is one row click away on `/workers/$workerId` (issue #477).
 *
 * Polling, not realtime — {@link WORKERS_REFETCH_MS} is comfortably below the
 * default 60s heartbeat TTL, so a worker that stops heartbeating flips to
 * Offline within one poll without a websocket. Authorization lives entirely on
 * the server (`workers.list`/`roster`/`listMine`/`setConsent`); this screen
 * renders and mutates only what those procedures allow.
 */

/** Poll cadence, matching the dashboard's idle baseline (`runs-refresh.ts`). */
export const WORKERS_REFETCH_MS = 5_000;

export function WorkersRouteComponent() {
	const navigate = useNavigate();
	const workersQuery = useQuery({
		...trpc.workers.list.queryOptions(),
		refetchInterval: WORKERS_REFETCH_MS,
	});

	// A row click opens that machine's detail view (issue #477). The selection is a
	// route param, not table state, so the deep link works and Back returns here.
	const openWorker = (workerId: string) => {
		navigate({ to: '/workers/$workerId', params: { workerId } });
	};

	// Full container width (issue #473): the table's Active job column reads as
	// prose, so the freed space goes to it rather than to a right-hand gutter.
	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-2xl font-semibold tracking-tight text-zinc-100 flex items-center gap-2">
					<Server className="h-6 w-6 text-violet-400" />
					Workers
				</h1>
				<p className="text-xs text-zinc-500 mt-1">
					Registered machines you can see, their connection state, the agent CLIs they declare, the
					job each is running now, and — per project — whether it is available for automatic
					dispatch. Toggle availability on the workers you own, or open a row for everything else
					the machine carries.
				</p>
			</div>

			{workersQuery.isLoading ? (
				<div className="text-sm text-zinc-400">Loading workers…</div>
			) : workersQuery.isError ? (
				<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
					{workersQuery.error.message}
				</div>
			) : workersQuery.data && workersQuery.data.length > 0 ? (
				<WorkersTable
					workers={workersQuery.data as WorkerRow[]}
					refetchInterval={WORKERS_REFETCH_MS}
					onSelectWorker={openWorker}
				/>
			) : (
				<div className="border border-zinc-800 rounded-lg bg-panel/20 p-8 text-center space-y-2">
					<Server className="w-12 h-12 stroke-1 text-zinc-700 mx-auto" />
					<p className="text-sm text-zinc-400">No workers to show.</p>
					<p className="text-xs text-zinc-500">
						A machine appears here once it is registered with{' '}
						<span className="font-mono">swarm workers register</span> and enrolled in a project you
						can access.
					</p>
				</div>
			)}
		</div>
	);
}

export const workersRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/workers',
	component: WorkersRouteComponent,
});
