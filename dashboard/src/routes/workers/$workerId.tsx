import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute, Link } from '@tanstack/react-router';
import { Server } from 'lucide-react';
import { WorkerDetailView } from '@/components/workers/worker-detail.js';
import { trpc } from '@/lib/trpc.js';
import type { WorkerDetail } from '@/types/workers.js';
import { rootRoute } from '../__root.js';
import { WORKERS_REFETCH_MS } from './index.js';

/**
 * The **worker detail** screen (issue #477) — one machine in full, reached by
 * clicking its row on `/workers`.
 *
 * The selection lives in the URL as a route param rather than in the list's
 * component state, so `/workers/<id>` is a working deep link and browser Back
 * returns to the index — the same navigation shape the Agent Configuration
 * phase-detail view established (`lib/project-nav.ts`) and `/runs/$runId` uses for
 * an entity with an id of its own.
 *
 * It keeps the index's polling cadence ({@link WORKERS_REFETCH_MS}), so
 * connectivity and the active job stay current while the view is open, and its one
 * source is the `workers.getById` read model: secret-free by construction, and
 * carrying the per-enrollment capability flags that decide which controls are
 * offered. Every mutation the view performs re-checks its own authorization
 * server-side; a landed mutation invalidates this query rather than patching it,
 * so what the screen shows afterwards is what the server actually stored.
 */

export function WorkerDetailRouteComponent() {
	const { workerId } = workerDetailRoute.useParams();
	const queryClient = useQueryClient();

	const workerQueryOptions = trpc.workers.getById.queryOptions({ workerId });
	const workerQuery = useQuery({ ...workerQueryOptions, refetchInterval: WORKERS_REFETCH_MS });

	// Names and repos for the enrollment blocks and the active job's PR link,
	// resolved the same way the table does; both fall back to the raw project id.
	const projectsQuery = useQuery(trpc.projects.list.queryOptions());
	const projectNames = new Map(projectsQuery.data?.map((p) => [p.id, p.name]) ?? []);
	const projectRepos = new Map(projectsQuery.data?.map((p) => [p.id, p.repo]) ?? []);

	// Annotated, not cast: the query's inferred type has to *satisfy* the
	// hand-mirrored read model (`types/workers.ts`), so a server-side field the
	// mirror missed fails the typecheck instead of surfacing as a runtime surprise.
	const worker: WorkerDetail | undefined = workerQuery.data;

	return (
		<div className="space-y-6">
			<div className="text-xs font-mono text-zinc-500">
				<Link to="/workers" className="hover:text-zinc-300 transition-colors">
					workers
				</Link>{' '}
				/ <span className="text-zinc-300 font-semibold select-all">{workerId}</span>
			</div>

			<div>
				<h1 className="text-2xl font-semibold tracking-tight text-zinc-100 flex items-center gap-2">
					<Server className="h-6 w-6 text-violet-400" />
					{worker?.displayName ?? 'Worker'}
				</h1>
				<p className="text-xs text-zinc-500 mt-1">
					Everything SWARM knows about this machine: what it declares it can run, what it is running
					now, and — per project — whether work is routed to it. Sharing and execution constraints
					are the owner's to change; approval and suspension a project administrator's.
				</p>
			</div>

			{/* A failed *poll* adds the banner and keeps the last good view — and with it
			    any half-typed edit — rather than blanking the screen every few seconds
			    on a transient error; a failed first load has nothing to keep, so the
			    banner stands alone. */}
			{workerQuery.isError ? (
				<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
					{workerQuery.error.message}
				</div>
			) : null}

			{worker ? (
				<WorkerDetailView
					worker={worker}
					projectNames={projectNames}
					projectRepos={projectRepos}
					onChanged={() => queryClient.invalidateQueries({ queryKey: workerQueryOptions.queryKey })}
				/>
			) : workerQuery.isLoading ? (
				<div className="text-sm text-zinc-400">Loading worker…</div>
			) : null}
		</div>
	);
}

export const workerDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/workers/$workerId',
	component: WorkerDetailRouteComponent,
});
