import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Server } from 'lucide-react';
import { Badge } from '@/components/ui/badge.js';
import { trpc } from '@/lib/trpc.js';
import { routabilityBlockers } from '@/lib/worker-enrollment-view.js';
import { WORKERS_REFETCH_MS } from '@/lib/workers-refresh.js';
import type { OwnerEnrollment, OwnerWorker } from '@/types/workers.js';

/**
 * The machines the signed-in operator owns (issue #660) — the profile's **My
 * Workers** tab, and the one place a worker owner sees their own fleet without
 * first knowing which project each machine is enrolled in.
 *
 * **Ownership is the server's, and this adds none of its own.** Its one source is
 * the existing `workers.listMine` read model, an `authedProcedure` that resolves
 * the owner from the session and takes no input, so the panel passes no user id
 * and applies no client-side owner filter — the same rule `WorkersTable` already
 * relies on ("presence in `workers.listMine`, never inferred from a
 * client-supplied owner claim"). Nothing here widens or duplicates the existing
 * worker-management authorization; it renders what that procedure already
 * returns, which is secret-free by construction (no machine path, credential, or
 * credential hash exists on the surface to leak).
 *
 * **It is read-only.** Naming a machine, granting sharing consent, and setting
 * execution constraints stay on the worker detail screen, where the server
 * declares per value who may change it — so this tab offers no control and each
 * entry simply links to `/workers/$workerId`. That link is scoped by project
 * membership (issue #647's deliberate choice), so a machine enrolled in no
 * project the owner can access resolves to `NOT_FOUND` there; a machine with no
 * enrollments at all says so here rather than only surfacing as an error one
 * click later.
 *
 * Polling, not realtime — {@link WORKERS_REFETCH_MS} is the cadence every other
 * worker view uses, so activity and availability age out at the same rate here.
 */

const CARD_CLASS = 'border border-zinc-800 rounded-lg bg-panel/20 p-4 shadow-sm';
const LABEL_CLASS = 'block text-xs font-medium text-zinc-400';

/**
 * What "Available" means, stated wherever the verdict is stamped. The same
 * predicate the dispatch gate reads, in the same words the worker detail view's
 * routable badge uses — one fact, one explanation.
 */
const AVAILABILITY_TITLE =
	'Available = the enrollment is approved and its owner shares the machine — the only thing the dispatch gate reads';

/**
 * `runState.busy` is about work, not connectivity: this read model carries no
 * lease state, so "Idle" must not be allowed to read as "connected".
 */
const IDLE_TITLE =
	'No run is assigned right now. Whether the machine is connected is on its detail screen.';

/** One project's availability line — the verdict, and for an unavailable one, why. */
function EnrollmentRow({
	enrollment,
	projectName,
}: {
	enrollment: OwnerEnrollment;
	projectName: string;
}) {
	// The shared helper, not re-worded copy: the two unmet conditions have
	// different owners (a project administrator approves, the machine's owner
	// shares), and the profile must name them exactly as the detail view does.
	const blockers = routabilityBlockers(enrollment);
	return (
		<li className="space-y-1">
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-zinc-300 break-words">{projectName}</span>
				<Badge tone={enrollment.isRoutable ? 'positive' : 'neutral'} title={AVAILABILITY_TITLE}>
					{enrollment.isRoutable ? 'Available' : 'Unavailable'}
				</Badge>
			</div>
			{blockers.length > 0 ? (
				<ul className="space-y-1 text-zinc-500">
					{blockers.map((blocker) => (
						<li key={blocker}>· {blocker}</li>
					))}
				</ul>
			) : null}
		</li>
	);
}

/** One machine: what it is called and doing, what it can run, and where it can run it. */
function WorkerCard({
	worker,
	projectNames,
}: {
	worker: OwnerWorker;
	projectNames: Map<string, string>;
}) {
	return (
		<li className={CARD_CLASS}>
			<div className="flex items-start justify-between gap-3">
				<div className="min-w-0">
					<Link
						to="/workers/$workerId"
						params={{ workerId: worker.workerId }}
						className="text-sm font-medium text-zinc-100 hover:text-violet-300 transition-colors break-words"
					>
						{worker.displayName}
					</Link>
				</div>
				{worker.runState.busy ? (
					<Badge tone="positive">Running a job</Badge>
				) : (
					<Badge title={IDLE_TITLE}>Idle</Badge>
				)}
			</div>

			<div className="mt-3">
				<span className={LABEL_CLASS}>Agent CLIs</span>
				{worker.capabilities.length === 0 ? (
					<span className="text-sm text-zinc-500">—</span>
				) : (
					<div className="mt-1 flex flex-wrap gap-1">
						{worker.capabilities.map((cli) => (
							<Badge key={cli}>{cli}</Badge>
						))}
					</div>
				)}
			</div>

			<div className="mt-3 pt-3 border-t border-zinc-800/60 text-xs">
				<span className={LABEL_CLASS}>Availability for automatic dispatch</span>
				{worker.enrollments.length === 0 ? (
					<div className="mt-1 space-y-1">
						<p className="text-zinc-400">Not enrolled in any project yet.</p>
						<p className="text-zinc-500">
							Enroll it with <span className="font-mono">swarm workers enroll</span> before a
							project can dispatch work to it.
						</p>
					</div>
				) : (
					<ul className="mt-1 space-y-2">
						{worker.enrollments.map((enrollment) => (
							<EnrollmentRow
								key={enrollment.enrollmentId}
								enrollment={enrollment}
								projectName={projectNames.get(enrollment.projectId) ?? enrollment.projectId}
							/>
						))}
					</ul>
				)}
			</div>
		</li>
	);
}

export function MyWorkersPanel() {
	const mineQuery = useQuery({
		...trpc.workers.listMine.queryOptions(),
		refetchInterval: WORKERS_REFETCH_MS,
	});
	// Names for the availability lines, resolved the same way the Workers table and
	// the worker detail screen resolve them — and falling back to the raw project id
	// when this auxiliary lookup is unavailable.
	const projectsQuery = useQuery(trpc.projects.list.queryOptions());
	const projectNames = new Map(projectsQuery.data?.map((p) => [p.id, p.name]) ?? []);

	// Annotated, not cast: the query's inferred type has to *satisfy* the
	// hand-mirrored read model (`types/workers.ts`), so a server-side field the
	// mirror missed fails the typecheck instead of surfacing as a runtime surprise.
	const workers: OwnerWorker[] | undefined = mineQuery.data;

	if (mineQuery.isLoading) {
		return <div className="text-sm text-zinc-400">Loading workers…</div>;
	}
	// A failure is stated verbatim rather than degraded to the empty state, which
	// would tell an owner with machines that they operate none.
	if (mineQuery.isError) {
		return (
			<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
				{mineQuery.error.message}
			</div>
		);
	}
	if (!workers || workers.length === 0) {
		return (
			<div className="border border-zinc-800 rounded-lg bg-panel/20 p-8 text-center space-y-2">
				<Server className="w-12 h-12 stroke-1 text-zinc-700 mx-auto" />
				<p className="text-sm text-zinc-400">You don't operate any workers yet.</p>
				<p className="text-xs text-zinc-500">
					A machine appears here once you register it with{' '}
					<span className="font-mono">swarm workers register</span>; enroll it with{' '}
					<span className="font-mono">swarm workers enroll</span> to make it available to a project.
				</p>
			</div>
		);
	}

	return (
		<div className="space-y-3">
			<p className="text-xs text-zinc-400">
				The machines you operate, in the order they were registered. Naming, sharing consent, and
				execution constraints are on each machine's own screen.
			</p>
			{/* Server order is kept — no client-side sort is invented on top of it. */}
			<ul className="space-y-3">
				{workers.map((worker) => (
					<WorkerCard key={worker.workerId} worker={worker} projectNames={projectNames} />
				))}
			</ul>
		</div>
	);
}
