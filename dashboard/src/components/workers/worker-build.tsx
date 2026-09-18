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
 *
 * Since issue #978 the module holds the *second* mark those screens put beside a
 * machine's name — `Updating`, for a request still outstanding. It lives here
 * because the two are read together and must never be written to read as one
 * state; keeping them in one file is what makes that a decision rather than a
 * coincidence of two components.
 */

/** A build as one scannable token: the abbreviated commit, marked when the checkout it named was dirty. */
export function formatWorkerBuild(
	build: { commit: string; dirty: boolean },
	version?: string | null,
): string {
	const commit = `${build.commit.slice(0, 7)}${build.dirty ? '+dirty' : ''}`;
	// The version leads because it is what an operator says out loud, and the commit
	// stays because it is what "Outdated" was actually decided on — dropping it would
	// leave the mark answering a question the text no longer asks. A machine that has
	// declared no version reads exactly as it did before.
	return version ? `${version} (${commit})` : commit;
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

/**
 * The mark for a machine with an update request still **outstanding** (issue #978)
 * — the same shared `Badge` in `caution`, for the same reason: it is the identical
 * "attention, not an error" register as `Outdated`, and a new pill is not to be
 * hand-rolled (`ai/DESIGN_SYSTEM.md` §4). The *words* carry the distinction, which
 * is also what keeps it legible without colour.
 *
 * `Updating` rather than the runs surfaces' `Maintenance` (issue #974) because this
 * is the other axis: there the pill says what *kind* of row it is among pipeline
 * runs, with the status badge beside it saying how it is going; here the machine's
 * state *is* the fact, so it takes the status word that mark deliberately left free.
 *
 * **Rendered only for a non-null `requestId`.** That is the pending marker; `target`
 * is not, since `workers.update` goes on naming the build the latest request
 * concerned long after the machine answered, so testing the value's presence would
 * leave every machine ever updated marked forever.
 *
 * It sits *beside* {@link WorkerBuildBadge}, never instead of it. Both facts are
 * true at once while a machine waits — its build differs, and it has been asked to
 * move — and they are not one state: one says nobody has acted, the other that
 * somebody has. Suppressing the staleness mark here would make it lie by omission
 * for exactly the window an operator is watching it.
 *
 * It clears itself: the machine reports, `requestId` goes `null`, and the build
 * mark alone answers whatever build the daemon re-declared on reconnect.
 */
export function WorkerUpdatingBadge({
	update,
}: {
	/** Only these three fields are read — never the reported outcome beside them. */
	update: { requestId: string | null; target: string; requestedAt: string } | null;
}) {
	if (!update?.requestId) return null;
	return (
		<Badge
			tone="caution"
			title={`This machine was asked to move to ${update.target} on ${new Date(update.requestedAt).toLocaleString()} and has not reported yet. It is still running the build shown beside it until it restarts and re-declares.`}
		>
			Updating
		</Badge>
	);
}
