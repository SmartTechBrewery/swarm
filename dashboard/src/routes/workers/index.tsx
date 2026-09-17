import { createRoute } from '@tanstack/react-router';
import { Server } from 'lucide-react';
import { InstanceAdminOnly } from '@/components/layout/instance-admin-only.js';
import { InstallationRolloutPanel } from '@/components/workers/installation-rollout-panel.js';
import { WorkersRoster } from '@/components/workers/workers-roster.js';
import { rootRoute } from '../__root.js';

/**
 * The **Workers** screen (issue #133): which machines are enrolled and
 * connected, what they can run, and which job they are running right now. Per
 * project it also shows availability for automatic dispatch, and lets the
 * signed-in operator toggle it on the workers they own (issue #282). It stays the
 * scannable index: everything else a machine carries — and the controls that
 * administer it — is one row click away on `/workers/$workerId` (issue #477).
 *
 * The roster itself lives in {@link WorkersRoster}, which this screen renders
 * unscoped and the project detail page's Workers tab renders scoped to one
 * project (issue #574) — one component, so the two views cannot drift.
 *
 * Unscoped it spans the whole installation — including machines enrolled nowhere
 * — so the route renders it behind {@link InstanceAdminOnly} (see
 * {@link WorkersScreen}); a worker owner reads the same roster, scoped, on their
 * project's Workers tab (issue #647).
 *
 * It is also where a **staged installation-wide rollout** is started and watched
 * (issue #1025): the roster toolbar's **Update all workers** button starts one, and
 * {@link InstallationRolloutPanel} above the roster says where every machine stands
 * while it runs and afterwards. That readout lives on the screen rather than in the
 * modal because a rollout advances itself, so it has to outlive the click that
 * started it.
 */

export function WorkersRouteComponent() {
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

			{/* The staged installation-wide rollout, when one has run (issue #1025) —
			    above the roster, so it is the first thing an operator sees while a fleet
			    is moving, and reachable by reloading the page rather than only from the
			    modal that started it. It renders nothing at all when there is no rollout. */}
			<InstallationRolloutPanel />

			<WorkersRoster />
		</div>
	);
}

/**
 * What the route actually mounts (issue #647): the screen behind the
 * instance-admin gate. Denied, the screen never mounts, so the installation-wide
 * `workers.list` read is never issued.
 */
export function WorkersScreen() {
	return (
		<InstanceAdminOnly view="workers">
			<WorkersRouteComponent />
		</InstanceAdminOnly>
	);
}

export const workersRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/workers',
	component: WorkersScreen,
});
