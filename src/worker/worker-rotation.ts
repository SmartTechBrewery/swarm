/**
 * The per-project **"Shuffle workers"** rotation (`pipeline.shuffleWorkers`,
 * issue #1416). The dispatch gate normally prefers the first eligible worker in
 * the project's configured order (issue #750), so when tasks block one another
 * and only one is runnable at a time, every phase lands on the same top-ranked
 * machine and drains that one CLI quota while the rest sit idle. With shuffle on,
 * the gate instead walks the roster **least recently dispatched first**.
 *
 * The order is "least recently used" rather than a next-in-list pointer: each
 * enrollment records when its worker last claimed a phase run for the project
 * (`worker_project_enrollments.last_dispatched_at`, stamped by
 * `claimWorkerForDispatch`). With every worker free that is exactly "the next one
 * in list order, wrapping after the last"; with some busy, a worker that was
 * skipped is first in line next time, and no pointer can dangle at a machine that
 * left the project.
 *
 * It is a **preference between eligible workers and nothing more**: the gate
 * reorders its candidates with it and then applies every eligibility rule
 * unchanged, so it never makes an ineligible worker eligible and never makes a
 * dispatch wait while some eligible worker is free. It deliberately reads no CLI
 * quota data — only the dispatch record.
 */

import type { PipelineConfig } from '../config/schema.js';
import type { WorkerDispatchCandidate } from '../identity/worker-enrollment-service.js';

/**
 * Whether the project rotates dispatches across its workers. Unset defaults to
 * `false` here rather than with `z.default()` because `pipeline` itself is
 * optional — the same reason `resolveRequireAssignee` applies its own default.
 */
export function resolveShuffleWorkers(pipeline: PipelineConfig | undefined): boolean {
	return pipeline?.shuffleWorkers === true;
}

/**
 * The candidates in rotation order: never-dispatched workers first, then by when
 * each last took a phase run for the project, oldest first. A stable sort, so
 * ties — including every never-dispatched worker — keep the configured order.
 */
export function orderForRotation(
	candidates: readonly WorkerDispatchCandidate[],
): WorkerDispatchCandidate[] {
	const lastTurn = (candidate: WorkerDispatchCandidate): number =>
		candidate.enrollment.lastDispatchedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
	return [...candidates].sort((a, b) => {
		const left = lastTurn(a);
		const right = lastTurn(b);
		return left === right ? 0 : left < right ? -1 : 1;
	});
}
