/**
 * The Resolve problem trigger (issues #1396, #1425) — the periodic control-plane
 * sweep that starts the phase by itself. `./resolve-problem.ts` schedules and runs
 * one attempt; this decides *when*. A pass ({@link sweepResolveProblem}) reads the
 * opted-in projects once and runs two legs over them; a third, which reads the
 * source-control provider, runs on its own interval.
 *
 * **Failed runs** ({@link dispatchResolveProblemForFailedRuns}, issue #1396). A run
 * qualifies once it has been `failed` for {@link RESOLVE_PROBLEM_DELAY_MS}, within
 * {@link RESOLVE_PROBLEM_LOOKBACK_MS}, in a project that turned the phase on, and
 * while nothing else has picked it up and no operator cancelled it: no retry or
 * continuation of the run, no Reset, no recorded cancellation origin (dashboard/API
 * Terminate or a board move to Backlog, issue #1453), no other dispatch or newer run
 * on its task or pull request, and no attempt for it yet. A run SWARM wrote as a
 * deliberate hand-off to a person — a `failure_diagnosis.kind` in
 * `OPERATOR_HANDOFF_DIAGNOSIS_KINDS` (*Approved head needs the operator*, *CI fix
 * abandoned*; issue #1462) — never qualifies. The database half of that — everything but the project opt-in — is
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
 * ticket attempt, anchored to its latest run when it has one. A holder whose
 * anchor run an operator cancelled is never attempted, even where the panel shows
 * it as `failed` (a user termination in a non-board phase, issue #1453), and neither
 * is one whose anchor run is a deliberate hand-off to a person (issue #1462), even
 * though the panel reads that run as `failed`.
 *
 * **Red pull-request heads** ({@link dispatchResolveProblemForRedHeads}, issue
 * #1459). An open SWARM pull request whose current head has red checks while
 * nothing in SWARM acts on it — every run on it `completed`, so neither leg above
 * sees it before the 2 h stall window, and an approval would rest it as
 * `approved-awaiting-merge` forever. Quiet for `RED_HEAD_QUIET_MS` (the same 10
 * minutes as a failed run), read live from the provider, and deduplicated per
 * (repository, pull request, head) — see `./resolve-problem-red-head.ts`. A holder
 * that already carries an attempt for its current situation (one anchored to its
 * latest run, a red-head attempt included) is not given a second one by the
 * Waiting-on-you leg, and a head whose latest run is a deliberate hand-off to a
 * person (issue #1462) is not attempted at all.
 *
 * One attempt per situation: the attempt is a `resolve-problem` run, which is never
 * ticket activity and so never qualifies itself or changes a holder's
 * classification, and the dispatch is deduplicated on the failed run or the stuck
 * situation (`resolveProblemDedupKey`, `resolveProblemTicketDedupKey`) — the same
 * key in both legs for the same run — so concurrent passes, and both legs, create
 * one dispatch. Nothing is dispatched while a dispatch is queued for the holder or
 * a newer run moved it (the classifier reads those as the pipeline's), nor while
 * its anchor run is being Reset or has a retry of its own scheduled. The claim-time
 * re-check (`./resolve-problem.ts`) skips a cancelled anchor run too, and all three
 * legs and that re-check skip a deliberate hand-off through one predicate,
 * `resolveProblemAnchorHandedOff`.
 *
 * Best-effort and logged, like the rest of the reconciler: this never throws.
 */

import { scopeProjectToRepository } from '../config/project-repository.js';
import { isResolveProblemEnabled } from '../config/resolve-problem.js';
import type { ProjectConfig, ProjectRecord } from '../config/schema.js';
import { listActiveDispatchTaskRefs } from '../db/repositories/dispatchesRepository.js';
import { listAllProjectRecordsFromDb } from '../db/repositories/projectsRepository.js';
import {
	getRunByIdFromDb,
	listTaskActivitySince,
	listUnrecoveredFailedRuns,
	type PipelineRunRow,
	type RunRow,
} from '../db/repositories/runsRepository.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { WipTicket, WipUsageEntry } from '../queue/wip-usage.js';
import {
	type ResolveProblemRedHeadCandidate,
	type ResolveProblemTicketCandidate,
	resolveProblemAnchorBusy,
	resolveProblemAnchorCancelled,
	resolveProblemAnchorHandedOff,
	scheduleResolveProblem,
	scheduleResolveProblemForRedHead,
	scheduleResolveProblemForTicket,
} from './resolve-problem.js';
import {
	probeRedHead,
	RED_HEAD_LOOKBACK_MS,
	type RedHeadCandidate,
	type RedHeadProbe,
	redHeadCandidates,
	redHeadHandled,
} from './resolve-problem-red-head.js';
import { resolveProblemScopeFor } from './resolve-problem-scope.js';
import {
	itemLivenessPolicyFor,
	loadWipCappedPullRequests,
	loadWipUsageEntries,
} from './wip-usage-loader.js';

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
	// An attempt already exists for this holder's current situation — anchored to
	// its latest run, e.g. a red-head attempt (issue #1459) — so a second one, under
	// another dedup key, would only diagnose the same thing again.
	if (ticket.resolveProblem) return undefined;
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
 * Schedule one candidate's attempt unless its anchor run is gone, cancelled, a
 * deliberate hand-off to a person, or being acted on (a Reset, a self-scheduled retry). Whether a dispatch was created.
 */
async function scheduleWaitingCandidate(
	candidate: WaitingTicketCandidate,
	now: Date,
	deps: Pick<ResolveProblemWaitingSweepDeps, 'readRun' | 'scheduleRun' | 'scheduleTicket'>,
): Promise<boolean> {
	const anchorId = candidate.kind === 'run' ? candidate.runId : candidate.latestRunId;
	const anchor = anchorId ? await deps.readRun(anchorId) : undefined;
	if (anchorId && !anchor) return false;
	const cancelled = anchor ? resolveProblemAnchorCancelled(anchor) : undefined;
	if (cancelled) {
		logger.debug('resolve-problem trigger: holder’s run was cancelled by an operator; skipping', {
			projectId: candidate.projectId,
			taskId: candidate.taskId,
			reason: cancelled,
		});
		return false;
	}
	const handedOff = anchor ? resolveProblemAnchorHandedOff(anchor) : undefined;
	if (handedOff) {
		logger.debug('resolve-problem trigger: holder’s run is a deliberate hand-off; skipping', {
			projectId: candidate.projectId,
			taskId: candidate.taskId,
			reason: handedOff,
		});
		return false;
	}
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

export interface ResolveProblemRedHeadSweepDeps {
	listProjects: () => Promise<readonly ProjectRecord[]>;
	listActivity: typeof listTaskActivitySince;
	listActiveDispatches: typeof listActiveDispatchTaskRefs;
	loadCapped: typeof loadWipCappedPullRequests;
	/** The live read, against `project` scoped to the pull request's repository. */
	probe: (project: ProjectConfig, prNumber: string) => Promise<RedHeadProbe>;
	handled: typeof redHeadHandled;
	readRun: (id: string) => Promise<RunRow | undefined>;
	schedule: (head: ResolveProblemRedHeadCandidate) => Promise<{ created: boolean }>;
	now: () => Date;
}

// Wrapped rather than referenced, so a suite that mocks one of these modules
// without the leg's reads can still import this one.
const defaultRedHeadDeps: ResolveProblemRedHeadSweepDeps = {
	listProjects: () => listAllProjectRecordsFromDb(),
	listActivity: (input) => listTaskActivitySince(input),
	listActiveDispatches: (projectIds) => listActiveDispatchTaskRefs(projectIds),
	loadCapped: (pullRequests) => loadWipCappedPullRequests(pullRequests),
	probe: (project, prNumber) => probeRedHead(project, prNumber),
	handled: (key, autoMerge, now) => redHeadHandled(key, autoMerge, now),
	readRun: (id) => getRunByIdFromDb(id),
	schedule: (head) => scheduleResolveProblemForRedHead(head),
	now: () => new Date(),
};

/** The name a created red-head attempt is logged and returned under. */
function redHeadLabel(candidate: RedHeadCandidate, headSha: string): string {
	return `${candidate.projectId}/${candidate.repository}#${candidate.prNumber}@${headSha}`;
}

/**
 * Read one candidate's head and schedule its attempt when it is red and nothing
 * handles it (issue #1459). The label of a created attempt, else `undefined`.
 */
async function scheduleRedHeadCandidate(
	record: ProjectRecord,
	candidate: RedHeadCandidate,
	at: Date,
	deps: Pick<ResolveProblemRedHeadSweepDeps, 'probe' | 'handled' | 'readRun' | 'schedule'>,
): Promise<string | undefined> {
	const context = {
		projectId: candidate.projectId,
		repository: candidate.repository,
		prNumber: candidate.prNumber,
	};
	let probe: RedHeadProbe;
	try {
		probe = await deps.probe(
			scopeProjectToRepository(record, candidate.repository),
			candidate.prNumber,
		);
	} catch (err) {
		logger.debug('resolve-problem trigger: pull request unreadable; next pass retries', {
			...context,
			error: describeError(err),
		});
		return undefined;
	}
	if (probe.state !== 'red') return undefined;
	const { headSha, failedChecks } = probe;
	const handled = await deps.handled({ ...context, headSha }, candidate.autoMerge, at);
	if (handled) {
		logger.debug('resolve-problem trigger: red head is being handled; skipping', {
			...context,
			headSha,
			reason: handled,
		});
		return undefined;
	}
	const anchor = await deps.readRun(candidate.latestRunId);
	if (!anchor) return undefined;
	const held =
		resolveProblemAnchorCancelled(anchor) ??
		resolveProblemAnchorHandedOff(anchor) ??
		resolveProblemAnchorBusy(anchor, at);
	if (held) {
		logger.debug('resolve-problem trigger: red head’s latest run is held; skipping', {
			...context,
			headSha,
			reason: held,
		});
		return undefined;
	}
	const { autoMerge: _autoMerge, ...head } = candidate;
	const result = await deps.schedule({ ...head, headSha, failedChecks });
	return result.created ? redHeadLabel(candidate, headSha) : undefined;
}

/**
 * One pass of the red-head leg (issue #1459, `./resolve-problem-red-head.ts`):
 * dispatch a Resolve problem attempt for every open SWARM pull request, in a
 * project that turned the phase on, whose current head is red while nothing in
 * SWARM acts on it. Candidates come from the database ({@link redHeadCandidates},
 * minus pull requests the review cap stopped on a refused approval), and each is
 * confirmed by one live provider read before anything is scheduled. Returns the
 * attempts this pass created as `project/repository#pr@head`; a head another pass
 * got to first is not one of them. Runs on its own interval
 * (`RED_HEAD_SWEEP_INTERVAL_MS`, `src/router/dispatcher.ts`), because it reads the
 * provider. Never throws.
 */
export async function dispatchResolveProblemForRedHeads(
	deps: Partial<ResolveProblemRedHeadSweepDeps> = {},
): Promise<string[]> {
	const resolved = { ...defaultRedHeadDeps, ...deps };
	const created: string[] = [];
	try {
		const records = await resolved.listProjects();
		const projectIds = resolveProblemProjectIds(records);
		if (projectIds.length === 0) return created;
		const at = resolved.now();
		const [activity, activeDispatches] = await Promise.all([
			resolved.listActivity({ since: new Date(at.getTime() - RED_HEAD_LOOKBACK_MS), projectIds }),
			resolved.listActiveDispatches(projectIds),
		]);
		const byId = new Map(records.map((record) => [record.id, record]));
		const candidates = redHeadCandidates(
			activity,
			activeDispatches,
			Object.fromEntries(projectIds.map((id) => [id, itemLivenessPolicyFor(byId.get(id))])),
			at,
		);
		if (candidates.length === 0) return created;
		const capped = await resolved.loadCapped(candidates);
		const isCapped = (candidate: RedHeadCandidate): boolean =>
			capped.some(
				(pr) =>
					pr.projectId === candidate.projectId &&
					pr.repository === candidate.repository &&
					pr.prNumber === candidate.prNumber,
			);
		for (const candidate of candidates) {
			const record = byId.get(candidate.projectId);
			if (!record || isCapped(candidate)) continue;
			try {
				const label = await scheduleRedHeadCandidate(record, candidate, at, resolved);
				if (label) created.push(label);
			} catch (err) {
				logger.warn('resolve-problem trigger: failed to dispatch an attempt (next pass retries)', {
					projectId: candidate.projectId,
					repository: candidate.repository,
					prNumber: candidate.prNumber,
					error: describeError(err),
				});
			}
		}
		if (created.length > 0) {
			logger.info(
				'resolve-problem trigger: dispatched Resolve problem for red pull-request heads',
				{
					count: created.length,
					attempts: created,
				},
			);
		}
	} catch (err) {
		logger.error('resolve-problem trigger: red-head sweep failed (continuing)', {
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
