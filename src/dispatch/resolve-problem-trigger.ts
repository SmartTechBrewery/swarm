/**
 * The Resolve problem trigger (issues #1396, #1425) — the periodic control-plane
 * sweep that starts the phase by itself. `./resolve-problem.ts` schedules and runs
 * one attempt; this decides *when*. A pass ({@link sweepResolveProblem}) reads the
 * opted-in projects once and runs two legs over them.
 *
 * **Failed runs** ({@link dispatchResolveProblemForFailedRuns}, issue #1396). A run
 * qualifies once it has been `failed` for {@link RESOLVE_PROBLEM_DELAY_MS}, within
 * {@link RESOLVE_PROBLEM_LOOKBACK_MS}, in a project that turned the phase on, and
 * while nothing else has picked it up: no retry or continuation of the run, no
 * Reset, no other dispatch or newer run on its task or pull request, and no attempt
 * for it yet. The database half of that — everything but the project opt-in — is
 * `listUnrecoveredFailedRuns` (`../db/repositories/runsRepository.ts`). Only
 * `status = 'failed'` is read there, so `deferred`, `checkpointed` and every other
 * self-retrying state never qualify.
 *
 * **Waiting on you** ({@link dispatchResolveProblemForWaitingTickets}, issue
 * #1425). WIP slot holders the dashboard's WIP panel shows as waiting on the
 * operator, read through the panel's own loader (`./wip-usage-loader.ts`), so the
 * panel and this sweep cannot disagree. Only the reasons
 * `./resolve-problem-scope.ts` puts in scope are attempted — `stalled` and `failed`
 * (at any age, so a failed run past the first leg's lookback still gets one); a user
 * termination, the review cap, a plan awaiting greenlight and an approval awaiting
 * merge are deliberate hand-offs to a person and are left alone. A `failed` holder
 * becomes the same run attempt the first leg would dispatch; a `stalled` holder a
 * ticket attempt, anchored to its latest run when it has one.
 *
 * One attempt per situation: the attempt is a `resolve-problem` run, which is never
 * ticket activity and so never qualifies itself or changes a holder's
 * classification, and the dispatch is deduplicated on the failed run or the stuck
 * situation (`resolveProblemDedupKey`, `resolveProblemTicketDedupKey`) — the same
 * key in both legs for the same run — so concurrent passes, and both legs, create
 * one dispatch. Nothing is dispatched while a dispatch is queued for the holder or
 * a newer run moved it (the classifier reads those as the pipeline's), nor while
 * its anchor run is being Reset or has a retry of its own scheduled.
 *
 * Best-effort and logged, like the rest of the reconciler: this never throws.
 */

import { isResolveProblemEnabled } from '../config/resolve-problem.js';
import type { ProjectConfig, ProjectRecord } from '../config/schema.js';
import { listAllProjectRecordsFromDb } from '../db/repositories/projectsRepository.js';
import {
	getRunByIdFromDb,
	listUnrecoveredFailedRuns,
	type PipelineRunRow,
	type RunRow,
} from '../db/repositories/runsRepository.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { WipTicket, WipUsageEntry } from '../queue/wip-usage.js';
import {
	type ResolveProblemTicketCandidate,
	resolveProblemAnchorBusy,
	scheduleResolveProblem,
	scheduleResolveProblemForTicket,
} from './resolve-problem.js';
import { resolveProblemScopeFor } from './resolve-problem-scope.js';
import { loadWipUsageEntries } from './wip-usage-loader.js';

/** How long a run must have been `failed` before Resolve problem is dispatched for it. */
export const RESOLVE_PROBLEM_DELAY_MS = 10 * 60 * 1000;

/** How far back the sweep looks: an older failure is left to the operator. */
export const RESOLVE_PROBLEM_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** What the sweep reads of a project: its id and its opt-in. */
export type ResolveProblemProject = Pick<ProjectConfig, 'id' | 'pipeline'>;

/** The ids of the projects that turned the phase on (`pipeline.resolveProblem.enabled`). */
export function resolveProblemProjectIds(projects: readonly ResolveProblemProject[]): string[] {
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
	listProjects: () => Promise<readonly ResolveProblemProject[]>;
	listCandidates: typeof listUnrecoveredFailedRuns;
	schedule: (run: PipelineRunRow) => Promise<{ created: boolean }>;
	now: () => Date;
}

const defaultDeps: ResolveProblemSweepDeps = {
	listProjects: listAllProjectRecordsFromDb,
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

/** A Waiting-on-you holder the sweep attempts, and how (issue #1425). */
export type WaitingTicketCandidate =
	| {
			/** A `failed` holder: today's run attempt on its failed latest run. */
			kind: 'run';
			runId: string;
			projectId: string;
			repository: string;
			taskId: string;
	  }
	| ({
			/** A `stalled` holder: a ticket attempt, anchored to its latest run if any. */
			kind: 'ticket';
	  } & ResolveProblemTicketCandidate);

/**
 * The Waiting-on-you holders Resolve problem takes on, from the WIP panel's own
 * classification (issue #1425): a `waiting-on-operator` holder whose reason is in
 * scope (`resolveProblemScopeFor`), waiting at least {@link RESOLVE_PROBLEM_DELAY_MS}
 * since it last moved (or took its slot). A `stalled` holder has already waited the
 * liveness stall threshold, so in practice the delay bites only a `failed` one. A
 * `failed` holder with no latest run cannot be anchored and is skipped.
 */
export function waitingTicketCandidates(
	entries: readonly WipUsageEntry[],
	now: Date,
): WaitingTicketCandidate[] {
	return entries.flatMap((entry) =>
		entry.tickets.flatMap((ticket) => {
			const candidate = waitingTicketCandidate(entry, ticket, now);
			return candidate ? [candidate] : [];
		}),
	);
}

/** One holder's candidate, or `undefined` when it is not attempted. */
function waitingTicketCandidate(
	entry: WipUsageEntry,
	ticket: WipTicket,
	now: Date,
): WaitingTicketCandidate | undefined {
	if (ticket.state !== 'waiting-on-operator') return undefined;
	if (!resolveProblemScopeFor(ticket.operatorReason).inScope) return undefined;
	const since = Date.parse(ticket.lastActivityAt ?? ticket.openedAt);
	if (now.getTime() - since < RESOLVE_PROBLEM_DELAY_MS) return undefined;
	const { projectId, repository } = entry;
	const { taskId, latestRunId } = ticket;
	if (ticket.operatorReason !== 'failed') {
		return {
			kind: 'ticket',
			projectId,
			repository,
			taskId,
			slotOpenedAt: ticket.openedAt,
			...(latestRunId ? { latestRunId } : {}),
			...(ticket.prNumber ? { prNumber: ticket.prNumber } : {}),
			...(ticket.workItemId ? { workItemId: ticket.workItemId } : {}),
		};
	}
	if (!latestRunId) {
		logger.debug('resolve-problem trigger: failed holder names no run; skipping', {
			projectId,
			repository,
			taskId,
		});
		return undefined;
	}
	return { kind: 'run', runId: latestRunId, projectId, repository, taskId };
}

export interface ResolveProblemWaitingSweepDeps {
	listProjects: () => Promise<readonly ProjectRecord[]>;
	loadWaiting: (
		records: readonly ProjectRecord[],
		projectIds: string[],
	) => Promise<WipUsageEntry[]>;
	readRun: (id: string) => Promise<RunRow | undefined>;
	scheduleRun: (run: Pick<RunRow, 'id' | 'projectId' | 'repository'>) => Promise<{
		created: boolean;
	}>;
	scheduleTicket: (ticket: ResolveProblemTicketCandidate) => Promise<{ created: boolean }>;
	now: () => Date;
}

const defaultWaitingDeps: ResolveProblemWaitingSweepDeps = {
	listProjects: listAllProjectRecordsFromDb,
	loadWaiting: loadWipUsageEntries,
	readRun: getRunByIdFromDb,
	scheduleRun: scheduleResolveProblem,
	scheduleTicket: scheduleResolveProblemForTicket,
	now: () => new Date(),
};

/** The name a created waiting-leg attempt is logged and returned under. */
function candidateLabel(candidate: WaitingTicketCandidate): string {
	return candidate.kind === 'run'
		? candidate.runId
		: `${candidate.projectId}/${candidate.repository}#${candidate.taskId}`;
}

/**
 * Schedule one candidate's attempt unless its anchor run is gone or being acted on
 * (a Reset, a self-scheduled retry). Whether a dispatch was created.
 */
async function scheduleWaitingCandidate(
	candidate: WaitingTicketCandidate,
	now: Date,
	deps: Pick<ResolveProblemWaitingSweepDeps, 'readRun' | 'scheduleRun' | 'scheduleTicket'>,
): Promise<boolean> {
	const anchorId = candidate.kind === 'run' ? candidate.runId : candidate.latestRunId;
	const anchor = anchorId ? await deps.readRun(anchorId) : undefined;
	if (anchorId && !anchor) return false;
	const busy = anchor ? resolveProblemAnchorBusy(anchor, now) : undefined;
	if (busy) {
		logger.debug('resolve-problem trigger: holder’s run is being acted on; skipping', {
			projectId: candidate.projectId,
			taskId: candidate.taskId,
			reason: busy,
		});
		return false;
	}
	if (candidate.kind === 'run') {
		return anchor ? (await deps.scheduleRun(anchor)).created : false;
	}
	const { kind: _kind, ...ticket } = candidate;
	return (await deps.scheduleTicket(ticket)).created;
}

/**
 * One pass of the Waiting-on-you leg (issue #1425): dispatch a Resolve problem
 * attempt for every in-scope Waiting-on-you holder ({@link waitingTicketCandidates})
 * whose anchor run is not being Reset or retried. Returns the attempts this pass
 * created — a failed run's id, or `project/repository#task` for a ticket attempt; a
 * situation another pass (or the failed-run leg) got to first is not one of them.
 */
export async function dispatchResolveProblemForWaitingTickets(
	deps: Partial<ResolveProblemWaitingSweepDeps> = {},
): Promise<string[]> {
	const { listProjects, loadWaiting, readRun, scheduleRun, scheduleTicket, now } = {
		...defaultWaitingDeps,
		...deps,
	};
	const created: string[] = [];
	try {
		const records = await listProjects();
		const projectIds = resolveProblemProjectIds(records);
		if (projectIds.length === 0) return created;
		const enabled = records.filter((record) => projectIds.includes(record.id));
		const at = now();
		const candidates = waitingTicketCandidates(await loadWaiting(enabled, projectIds), at);
		for (const candidate of candidates) {
			try {
				if (
					await scheduleWaitingCandidate(candidate, at, { readRun, scheduleRun, scheduleTicket })
				) {
					created.push(candidateLabel(candidate));
				}
			} catch (err) {
				logger.warn('resolve-problem trigger: failed to dispatch an attempt (next pass retries)', {
					projectId: candidate.projectId,
					taskId: candidate.taskId,
					error: describeError(err),
				});
			}
		}
		if (created.length > 0) {
			logger.info(
				'resolve-problem trigger: dispatched Resolve problem for Waiting-on-you tickets',
				{
					count: created.length,
					attempts: created,
				},
			);
		}
	} catch (err) {
		logger.error('resolve-problem trigger: Waiting-on-you sweep failed (continuing)', {
			error: describeError(err),
		});
	}
	return created;
}

/**
 * One whole sweep pass — the reconciler's entry point. Reads the projects once and
 * runs both legs over them: failed runs first, then Waiting-on-you holders. Never
 * throws.
 */
export async function sweepResolveProblem(
	listProjects: () => Promise<readonly ProjectRecord[]> = listAllProjectRecordsFromDb,
): Promise<void> {
	let records: readonly ProjectRecord[];
	try {
		records = await listProjects();
	} catch (err) {
		logger.error('resolve-problem trigger: sweep failed (continuing)', {
			error: describeError(err),
		});
		return;
	}
	const once = async () => records;
	await dispatchResolveProblemForFailedRuns({ listProjects: once });
	await dispatchResolveProblemForWaitingTickets({ listProjects: once });
}
