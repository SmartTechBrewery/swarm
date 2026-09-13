import { Badge } from '@/components/ui/badge.js';

/**
 * How the Workers screens state a machine's SWARM build (issue #925) — shared by
 * the roster's Machine cell and the detail view's "Declared by the daemon" card, so
 * the one sentence an operator reads about a stale worker is written once rather
 * than copied into two components that then drift.
 *
 * The build itself is the daemon's own declaration: the commit its SWARM install
 * root is on, plus a flag for a checkout that is dirty or whose `dist/` build
 * predates that commit. It answers the question `daemonVersion` cannot — that
 * resolves to `package.json`'s never-bumped `0.1.0`, identical on every machine in
 * the fleet whatever code it is running.
 */

/** A build as one scannable token: the abbreviated commit, marked when the checkout it named was dirty. */
export function formatWorkerBuild(build: { commit: string; dirty: boolean }): string {
	return `${build.commit.slice(0, 7)}${build.dirty ? '+dirty' : ''}`;
}

/**
 * The mark for a machine whose build is not the control plane's own — the shared
 * `Badge` in `caution`, never a hand-rolled second pill (`ai/DESIGN_SYSTEM.md` §4).
 *
 * **Rendered only for an explicit `false`.** `null` is "the question has no answer"
 * — the machine declared no build, or the server cannot resolve its own — and
 * rendering it as a mark would stamp an entire fleet outdated the moment the
 * comparand went missing.
 *
 * The copy says the build *differs* rather than that the machine is *behind*:
 * equality is what was actually checked. The control plane cannot cheaply prove the
 * worker's commit is an ancestor of its own — it may never have fetched it — so
 * naming a distance would be inventing one.
 */
export function WorkerBuildBadge({
	buildIsCurrent,
	controlPlaneBuild,
}: {
	buildIsCurrent: boolean | null;
	/**
	 * The build compared against, named in the tooltip where the surface carries it.
	 * Only the detail view does — it is one value for the whole installation, so the
	 * roster payload does not repeat it per row.
	 */
	controlPlaneBuild?: { commit: string; dirty: boolean } | null;
}) {
	if (buildIsCurrent !== false) return null;
	const against = controlPlaneBuild ? ` (${formatWorkerBuild(controlPlaneBuild)})` : '';
	return (
		<Badge
			tone="caution"
			title={`This machine's SWARM build differs from the control plane's${against}. It is running code from a different checkout state — restart the daemon after updating its checkout.`}
		>
			Outdated
		</Badge>
	);
}
