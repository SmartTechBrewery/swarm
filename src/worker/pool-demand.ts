/**
 * The **demand side** of pool-aware scheduling (issue #533): what else this project
 * is currently trying to run, in the shape the dispatch gate judges
 * ({@link RunnableDispatchDemand}).
 *
 * The gate knows which workers can serve *this* dispatch; to tell a scarce worker
 * from a spare one it also has to know what the other runnable dispatches need. That
 * is a durable read — every attempt to start a phase is a `dispatches` row
 * (ADR-002) — plus the one canonical reading of a phase's target policy
 * (`./target-policy.ts`), so a contender's targets are resolved exactly as its own
 * dispatch will resolve them, including a per-run "Retry now" pin carried on its
 * stored payload.
 *
 * Three deliberate approximations, all of which only ever make a contender look
 * *less* constrained than it is — the safe direction, since an overstated demand is
 * what would divert this dispatch for contention that isn't real:
 *
 * - **No assignee affinity.** An affinity-gated contender may only run on its
 *   assignee's machines, but the board item that says so is not on the dispatch row,
 *   and resolving it would mean a board read per waiting dispatch on the dispatch
 *   path.
 * - **Implementation is read as planned.** `implementationUnplanned` selects a
 *   different `agents.*` block for an item that never went through Planning, which a
 *   project may point at different targets; establishing it costs another query per
 *   contender (`wasPrecededByPlanning`), so the planned block is used.
 * - **A payload that names no repository is not narrowed by one** (issue #714). Its
 *   `undefined` means the project's *default* entry, and the project a gate scoped is
 *   not necessarily that entry — so the gate skips its repository check for that
 *   contender rather than guessing at one.
 *
 * Best-effort by contract: every failure resolves to `undefined`, which the gate
 * reads as "no pool information" and answers with its plain first-eligible pick. A
 * scheduling *preference* must never be the reason a dispatch that could run
 * doesn't.
 */

import type { ProjectConfig } from '../config/schema.js';
import {
	type DispatchRow,
	listRunnableDispatchesForPool,
} from '../db/repositories/dispatchesRepository.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { normalizeStoredJobPayload, repositoryForJob } from '../queue/jobs.js';
import { ALL_TRIGGER_PHASES, type TriggerPhase } from '../triggers/types.js';
import type { RunnableDispatchDemand } from './eligibility-gate.js';
import { PHASE_DEFAULT_CLI, phaseAgentConfig, resolveTargetPolicy } from './target-policy.js';

/** The phase a dispatch row resolved to, or `undefined` when it names no pipeline phase. */
function pipelinePhase(row: DispatchRow): TriggerPhase | undefined {
	// `null` until the trigger registry resolves one, and `merge-automation` for the
	// agent-less executor that provisions no worktree and needs no worker at all —
	// neither is demand on the worker pool.
	return ALL_TRIGGER_PHASES.find((phase) => phase === row.phase);
}

/** One runnable dispatch row as a demand the gate can turn into eligible workers. */
function toDemand(project: ProjectConfig, row: DispatchRow): RunnableDispatchDemand | undefined {
	const phase = pipelinePhase(row);
	if (!phase) return undefined;
	return {
		dispatchId: row.id,
		phase,
		targets: resolveTargetPolicy(phaseAgentConfig(project, phase), row.jobPayload).targets,
		phaseDefaultCli: PHASE_DEFAULT_CLI[phase],
		// Which repository the contender belongs to (issue #714), read off its own stored
		// payload exactly as its dispatch will scope the project by it. Normalised first,
		// because a row written before #684/#686 carries the legacy envelope. `undefined`
		// means the payload names none — the project's *default* entry, which the `project`
		// scoped here may not be — so the gate skips the repository check for that
		// contender rather than narrowing it by the wrong repository.
		repository: repositoryForJob(normalizeStoredJobPayload(row.jobPayload)),
	};
}

/**
 * The project's runnable dispatches in scheduling order — the queue's own
 * priority → availability → FIFO ordering, which is where priority and ageing keep
 * living. This dispatch is normally among them (it holds a lease but has claimed no
 * worker yet); the gate replaces its entry with the affinity-narrowed set it
 * actually selects from.
 */
export async function loadRunnableDispatchDemands(
	project: ProjectConfig,
): Promise<RunnableDispatchDemand[] | undefined> {
	try {
		const rows = await listRunnableDispatchesForPool(project.id);
		return rows
			.map((row) => toDemand(project, row))
			.filter((demand): demand is RunnableDispatchDemand => demand !== undefined);
	} catch (err) {
		logger.debug('Could not read the project’s runnable dispatches for pool scheduling', {
			projectId: project.id,
			error: describeError(err),
		});
		return undefined;
	}
}
