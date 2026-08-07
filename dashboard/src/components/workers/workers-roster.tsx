import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { Server } from 'lucide-react';
import { WorkersTable } from '@/components/workers/workers-table.js';
import { trpc } from '@/lib/trpc.js';
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
}

/**
 * The worker roster body (issue #133) — the query plus its loading, error,
 * empty, and populated states — shared verbatim by the `/workers` screen and the
 * project detail page's Workers tab (issue #574). One component rather than two
 * panels, so the scoped view *is* the global experience (consent switch, current
 * job, capabilities, row navigation, poll cadence) rather than a re-implementation
 * of it that can drift.
 *
 * Polling, not realtime — {@link WORKERS_REFETCH_MS} is comfortably below the
 * default 60s heartbeat TTL. Authorization lives entirely on the server
 * (`workers.list`/`roster`/`listMine`/`setConsent`); this renders and mutates only
 * what those procedures allow.
 */
export function WorkersRoster({ projectId }: WorkersRosterProps) {
	const navigate = useNavigate();
	// `undefined` rather than a no-argument call: the two variants stay on distinct
	// query keys, so a project tab never reads the global roster out of the cache.
	const workersQuery = useQuery({
		...trpc.workers.list.queryOptions(projectId ? { projectId } : undefined),
		refetchInterval: WORKERS_REFETCH_MS,
	});

	// A row click opens that machine's detail view (issue #477). The selection is a
	// route param, not table state, so the deep link works and Back returns here.
	const openWorker = (workerId: string) => {
		navigate({ to: '/workers/$workerId', params: { workerId } });
	};

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
