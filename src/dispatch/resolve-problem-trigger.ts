/**
 * The Resolve problem trigger (issue #1396) — the periodic control-plane sweep that
 * starts the phase by itself. `./resolve-problem.ts` schedules and runs one
 * attempt; this decides *when*.
 *
 * A run qualifies once it has been `failed` for {@link RESOLVE_PROBLEM_DELAY_MS},
 * within {@link RESOLVE_PROBLEM_LOOKBACK_MS}, in a project that turned the phase
 * on, and while nothing else has picked it up: no retry or continuation of the
 * run, no Reset, no other dispatch or newer run on its task or pull request, and
 * no attempt for it yet. The database half of that — everything but the project
 * opt-in — is `listUnrecoveredFailedRuns` (`../db/repositories/runsRepository.ts`);
 * the opt-in is read here, through `isResolveProblemEnabled`, so the query is never
 * issued while no project has the phase on.
 *
 * Only `status = 'failed'` is ever read, so `deferred`, `checkpointed` and every
 * other self-retrying state never qualify. One attempt per failed run: the attempt
 * is a `resolve-problem` run, which never qualifies itself, and the dispatch is
 * deduplicated on the failed run (`resolveProblemDedupKey`), so two concurrent
 * passes create one dispatch.
 *
 * Best-effort and logged, like the rest of the reconciler: this never throws.
 */

import { isResolveProblemEnabled } from '../config/resolve-problem.js';
import type { ProjectConfig } from '../config/schema.js';
import { listAllProjectsFromDb } from '../db/repositories/projectsRepository.js';
import {
	listUnrecoveredFailedRuns,
	type PipelineRunRow,
} from '../db/repositories/runsRepository.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { scheduleResolveProblem } from './resolve-problem.js';

/** How long a run must have been `failed` before Resolve problem is dispatched for it. */
export const RESOLVE_PROBLEM_DELAY_MS = 10 * 60 * 1000;

/** How far back the sweep looks: an older failure is left to the operator. */
export const RESOLVE_PROBLEM_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** The ids of the projects that turned the phase on (`pipeline.resolveProblem.enabled`). */
export function resolveProblemProjectIds(projects: readonly ProjectConfig[]): string[] {
	return projects
		.filter((project) => isResolveProblemEnabled(project.pipeline))
		.map((project) => project.id);
}

/** The settled-before / since window a pass at `now` reads. */
export function resolveProblemWindow(now: Date): { settledBefore: Date; since: Date } {
	return {
		settledBefore: new Date(now.getTime() - RESOLVE_PROBLEM_DELAY_MS),
		since: new Date(now.getTime() - RESOLVE_PROBLEM_LOOKBACK_MS),
	};
}

export interface ResolveProblemSweepDeps {
	listProjects: () => Promise<ProjectConfig[]>;
	listCandidates: typeof listUnrecoveredFailedRuns;
	schedule: (run: PipelineRunRow) => Promise<{ created: boolean }>;
	now: () => Date;
}

const defaultDeps: ResolveProblemSweepDeps = {
	listProjects: listAllProjectsFromDb,
	listCandidates: listUnrecoveredFailedRuns,
	schedule: scheduleResolveProblem,
	now: () => new Date(),
};

/**
 * One sweep pass: dispatch a Resolve problem attempt for every qualifying failed
 * run. Returns the ids of the failed runs this pass created a dispatch for — a run
 * another pass got to first is not one of them.
 */
export async function dispatchResolveProblemForFailedRuns(
	deps: Partial<ResolveProblemSweepDeps> = {},
): Promise<string[]> {
	const { listProjects, listCandidates, schedule, now } = { ...defaultDeps, ...deps };
	const created: string[] = [];
	try {
		const projectIds = resolveProblemProjectIds(await listProjects());
		if (projectIds.length === 0) return created;
		const candidates = await listCandidates({ projectIds, ...resolveProblemWindow(now()) });
		for (const run of candidates) {
			try {
				const result = await schedule(run);
				if (result.created) created.push(run.id);
			} catch (err) {
				logger.warn('resolve-problem trigger: failed to dispatch an attempt (next pass retries)', {
					runId: run.id,
					projectId: run.projectId,
					error: describeError(err),
				});
			}
		}
		if (created.length > 0) {
			logger.info('resolve-problem trigger: dispatched Resolve problem for failed runs', {
				count: created.length,
				runIds: created,
			});
		}
	} catch (err) {
		logger.error('resolve-problem trigger: sweep failed (continuing)', {
			error: describeError(err),
		});
	}
	return created;
}
