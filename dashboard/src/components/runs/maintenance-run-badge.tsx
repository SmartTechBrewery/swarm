import { Badge } from '@/components/ui/badge.js';
import { isMaintenanceRun } from '@/lib/run-kind.js';

/**
 * The mark a maintenance run carries on every runs surface (issue #974) — one
 * component for the same reason `workers/worker-build.tsx` is one: the sentence an
 * operator reads about a maintenance row is written once rather than pasted into
 * three call sites that then drift.
 *
 * **The word is `Maintenance`, deliberately not `Updating`.** "Updating" is a
 * status, and the row's status is already carried by `RunStatusBadge`
 * (`Running`/`Completed`/`Failed`); this pill says what *kind* of work the row is,
 * which is a different axis, so the two can never conflate. It is not the phase
 * word either — the Phase column already says "worker update", so repeating it
 * would add colour and no information.
 *
 * **Why `caution` for a kind.** `Badge`'s own header says the hue carries *state*
 * and is deliberately not a way to promote one member of a set — `caution` doubling
 * as that for the `planning` phase is how Planning came to read as specially
 * trusted (issue #542). This is the opposite shape rather than a repeat of it: a
 * maintenance run is not one member of the set of pipeline runs whose kind is being
 * promoted, it is the row that is *not* in that set, and the state the hue carries
 * is the one an operator acts on — none of the pipeline recovery actions apply, and
 * the API refuses them (`requirePipelineRun`). The issue asked for amber for that
 * reason, so it is the shared `Badge` in `caution`, never a hand-rolled second pill
 * (`ai/DESIGN_SYSTEM.md` §4).
 *
 * Renders `null` for pipeline work, which is load-bearing rather than tidy: every
 * caller puts it in a cell whose full text other tests assert.
 *
 * The `data-testid` lives on a `display: contents` wrapper here rather than at each
 * call site, so it exists exactly when the mark does — a wrapper rendered
 * unconditionally would answer "is this row marked?" with yes everywhere — and the
 * badge still lays out as the direct flex child of whatever contains it.
 */
export function MaintenanceRunBadge({ run }: { run: { kind: string } }) {
	if (!isMaintenanceRun(run)) return null;
	return (
		<span data-testid="run-maintenance-mark" className="contents">
			<Badge
				tone="caution"
				title="Machine maintenance, not pipeline work: this run moves one machine to a SWARM build. It references no pull request and no board item, and it does not count against the project's concurrency."
			>
				Maintenance
			</Badge>
		</span>
	);
}
