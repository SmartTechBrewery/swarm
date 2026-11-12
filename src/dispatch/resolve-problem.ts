/**
 * The Resolve problem phase (issue #1395) — the control-plane half, the side
 * holding the database. `../pipeline/resolve-problem.ts` is the worker half.
 *
 * A Resolve problem dispatch names one **failed run** (`{ type: 'resolve-problem',
 * failedRunId }`, `../queue/jobs.ts`) — or, since issue #1425, one **stuck ticket**
 * (`ticket`, with `failedRunId` naming its latest run when it has one). This module
 * schedules one, turns a claimed one into the phase's inputs by reading that run
 * or re-checking that ticket against the WIP classifier, mints and revokes the
 * run-bound credential the agent reaches SWARM with, and decides — by reading the
 * bug report the run had to file — whether the attempt succeeded. What schedules
 * one automatically is the periodic sweep in `./resolve-problem-trigger.ts`
 * (issue #1396).
 */

import {
	isResolveProblemEnabled,
	resolveProblemMaxWriteActions,
} from '../config/resolve-problem.js';
import type { ProjectConfig } from '../config/schema.js';
import { findOccurrenceFiledByRun } from '../db/repositories/bugReportsRepository.js';
import type { DispatchRow } from '../db/repositories/dispatchesRepository.js';
import { findProjectRecordByIdFromDb } from '../db/repositories/projectsRepository.js';
import { getRunByIdFromDb, type RunRow } from '../db/repositories/runsRepository.js';
import type { AgentCliResult } from '../harness/agent-cli.js';
import { AgentRunError } from '../harness/agent-failure.js';
import {
	mintRunBoundAgentToken,
	revokeRunBoundAgentTokens,
} from '../identity/agent-access-token-service.js';
import { resolveWebhookCallbackBaseUrl } from '../lib/env.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import type { ResolveProblemReport } from '../pipeline/resolve-problem.js';
import type { ResolveProblemJob } from '../queue/jobs.js';
import { priorityFor } from '../queue/producer.js';
import type { WipTicket } from '../queue/wip-usage.js';
import type { TriggerResult } from '../triggers/types.js';
import { createAndPublishDispatch } from './dispatcher.js';
import { resolveProblemScopeFor } from './resolve-problem-scope.js';
import { loadWipUsageEntries } from './wip-usage-loader.js';

/** The operator MCP endpoint's route on the control plane. */
export const OPERATOR_MCP_ROUTE = '/operator/mcp';

/**
 * How long past the phase's own timeout the run-bound token stays valid: enough
 * for the result to travel back and the settle to revoke it, never a standing
 * credential.
 */
export const RESOLVE_PROBLEM_TOKEN_GRACE_MS = 10 * 60 * 1000;

/** A Resolve problem trigger, narrowed. */
export type ResolveProblemTrigger = Extract<TriggerResult, { phase: 'resolve-problem' }>;

/**
 * The dedup identity of a Resolve problem dispatch: the failed run, never the task
 * — the attempt is about that one run, and a second request for it is the same
 * attempt.
 */
export function resolveProblemDedupKey(failedRunId: string): string {
	return `resolve-problem:${failedRunId}`;
}

/**
 * The dedup identity of a ticket attempt on a stuck ticket that never ran (issue
 * #1425): the slot itself — project, repository, task and the instant it opened —
 * so a re-opened slot is a new situation and the same slot never gets a second
 * attempt. A ticket that has run is keyed on its latest run instead
 * ({@link resolveProblemDedupKey}).
 */
export function resolveProblemTicketDedupKey(slot: {
	projectId: string;
	repository: string;
	taskId: string;
	slotOpenedAt: string;
}): string {
	return `resolve-problem:slot:${slot.projectId}:${slot.repository}:${slot.taskId}:${Date.parse(slot.slotOpenedAt)}`;
}

/**
 * Schedule a Resolve problem attempt for `failedRun`. Idempotent on the failed run
 * (see {@link resolveProblemDedupKey}): a repeat returns the existing dispatch with
 * `created: false`. Whether the attempt may run at all — the project opted in, the
 * run is still failed — is decided when it is claimed ({@link resolveProblemTrigger}),
 * like every other dispatch's disposition.
 */
export async function scheduleResolveProblem(
	failedRun: Pick<RunRow, 'id' | 'projectId' | 'repository'>,
): Promise<{ dispatch: DispatchRow; created: boolean }> {
	const job: ResolveProblemJob = {
		type: 'resolve-problem',
		projectId: failedRun.projectId,
		failedRunId: failedRun.id,
		...(failedRun.repository ? { repository: failedRun.repository } : {}),
	};
	return createAndPublishDispatch({
		projectId: failedRun.projectId,
		jobPayload: job,
		dedupKey: resolveProblemDedupKey(failedRun.id),
		priority: priorityFor(job) ?? 0,
		source: 'synthetic',
		phase: 'resolve-problem',
	});
}

/** A stuck ticket the sweep schedules an attempt for (issue #1425). */
export interface ResolveProblemTicketCandidate {
	projectId: string;
	repository: string;
	taskId: string;
	/** ISO 8601 — when the ticket's slot opened. */
	slotOpenedAt: string;
	/** The ticket's latest run, when it has run — the attempt's anchor. */
	latestRunId?: string;
	prNumber?: string;
	workItemId?: string;
}

/**
 * Schedule a Resolve problem attempt for a stuck ticket (issue #1425). Idempotent
 * on the stuck situation: the latest run's key when the ticket has run — the same
 * key a run attempt on that run takes, so the two can never both be dispatched —
 * else the slot's own ({@link resolveProblemTicketDedupKey}). Re-checked against
 * the WIP classifier when claimed ({@link resolveProblemTrigger}).
 */
export async function scheduleResolveProblemForTicket(
	ticket: ResolveProblemTicketCandidate,
): Promise<{ dispatch: DispatchRow; created: boolean }> {
	const job: ResolveProblemJob = {
		type: 'resolve-problem',
		projectId: ticket.projectId,
		repository: ticket.repository,
		...(ticket.latestRunId ? { failedRunId: ticket.latestRunId } : {}),
		ticket: {
			taskId: ticket.taskId,
			reason: 'stalled',
			slotOpenedAt: ticket.slotOpenedAt,
			...(ticket.prNumber ? { prNumber: ticket.prNumber } : {}),
			...(ticket.workItemId ? { workItemId: ticket.workItemId } : {}),
		},
	};
	return createAndPublishDispatch({
		projectId: ticket.projectId,
		jobPayload: job,
		dedupKey: ticket.latestRunId
			? resolveProblemDedupKey(ticket.latestRunId)
			: resolveProblemTicketDedupKey(ticket),
		priority: priorityFor(job) ?? 0,
		source: 'synthetic',
		phase: 'resolve-problem',
	});
}

/** A claimed Resolve problem dispatch that should not run, and why. */
export interface ResolveProblemSkip {
	skip: string;
	/** The failed run's or the ticket's task, when it could still be read. */
	taskId?: string;
}

/**
 * The WIP panel's current classification of one slot holder, or `undefined` when
 * the task holds no slot in `repository` any more. Read through the panel's own
 * loader, so the claim-time re-check and the panel cannot disagree.
 */
export type LoadHeldTicket = (
	project: ProjectConfig,
	repository: string,
	taskId: string,
) => Promise<WipTicket | undefined>;

const loadHeldTicket: LoadHeldTicket = async (project, repository, taskId) => {
	const record = await findProjectRecordByIdFromDb(project.id);
	const entries = await loadWipUsageEntries(record ? [record] : [], [project.id]);
	return entries
		.find((entry) => entry.repository === repository)
		?.tickets.find((ticket) => ticket.taskId === taskId);
};

/**
 * Why a Resolve problem anchor run must not be worked on while someone else is
 * acting on it — a Reset an operator began, or a retry the run scheduled for
 * itself — or `undefined` when nothing is.
 */
export function resolveProblemAnchorBusy(
	run: Pick<RunRow, 'id' | 'resetStartedAt' | 'nextRetryAt'>,
	now: Date,
): string | undefined {
	if (run.resetStartedAt) return `Run ${run.id} is being Reset by an operator`;
	if (run.nextRetryAt && run.nextRetryAt.getTime() > now.getTime()) {
		return `Run ${run.id} has a retry of its own scheduled`;
	}
	return undefined;
}

/**
 * The phase's inputs for a claimed Resolve problem dispatch, or the reason it must
 * not run. A run attempt is read off the failed run: it is skipped when the project
 * has not turned the phase on, the run is gone or belongs elsewhere, it is no longer
 * `failed` (a retry already picked it up), or it is itself a Resolve problem
 * attempt. A ticket attempt (issue #1425) is re-checked against the WIP classifier:
 * see {@link resolveTicketAttempt}.
 */
export async function resolveProblemTrigger(
	job: ResolveProblemJob,
	project: ProjectConfig,
	readRun: (id: string) => Promise<RunRow | undefined> = getRunByIdFromDb,
	loadTicket: LoadHeldTicket = loadHeldTicket,
	now: () => Date = () => new Date(),
): Promise<ResolveProblemTrigger | ResolveProblemSkip> {
	if (!isResolveProblemEnabled(project.pipeline)) {
		return {
			skip: `Resolve problem is not enabled for project '${project.id}' (pipeline.resolveProblem.enabled)`,
		};
	}
	if (job.ticket) return resolveTicketAttempt(job, job.ticket, project, readRun, loadTicket, now());
	if (!job.failedRunId) {
		return { skip: 'The Resolve problem dispatch names neither a failed run nor a ticket' };
	}
	const run = await readRun(job.failedRunId);
	if (!run || run.projectId !== project.id) {
		return { skip: `Run ${job.failedRunId} does not exist in project '${project.id}'` };
	}
	const taskId = run.taskId ?? run.id;
	if (run.phase === 'resolve-problem') {
		return { skip: `Run ${run.id} is itself a Resolve problem attempt`, taskId };
	}
	if (run.status !== 'failed') {
		return {
			skip: `Run ${run.id} is ${run.status}, not failed — there is nothing to resolve`,
			taskId,
		};
	}
	return {
		phase: 'resolve-problem',
		taskId,
		failedRunId: run.id,
		...(run.prNumber ? { prNumber: run.prNumber } : {}),
		...(run.workItemId ? { workItemId: run.workItemId } : {}),
		failedRun: failedRunRecord(run),
	};
}

function failedRunRecord(run: RunRow): NonNullable<ResolveProblemTrigger['failedRun']> {
	return {
		id: run.id,
		phase: run.phase,
		taskId: run.taskId,
		prNumber: run.prNumber,
		error: run.error,
		failureDiagnosis: run.failureDiagnosis,
	};
}

/** A ticket attempt's anchor run, or why it must not be worked on now. */
async function readTicketAnchor(
	runId: string,
	project: ProjectConfig,
	readRun: (id: string) => Promise<RunRow | undefined>,
	now: Date,
): Promise<RunRow | ResolveProblemSkip> {
	const anchor = await readRun(runId);
	if (!anchor || anchor.projectId !== project.id) {
		return { skip: `Run ${runId} does not exist in project '${project.id}'` };
	}
	if (anchor.phase === 'resolve-problem') {
		return { skip: `Run ${anchor.id} is itself a Resolve problem attempt` };
	}
	const busy = resolveProblemAnchorBusy(anchor, now);
	return busy ? { skip: busy } : anchor;
}

/**
 * Why a held ticket is no longer the stuck situation an attempt was scheduled for —
 * it moved, waits for a reason Resolve problem does not take on, or re-took its
 * slot — or `undefined` when it still is.
 */
function ticketNoLongerStuck(
	held: WipTicket,
	slotOpenedAt: string,
	anchorRunId: string | undefined,
): string | undefined {
	if (held.state !== 'waiting-on-operator') return `is ${held.state} again — it is not stuck`;
	const scope = resolveProblemScopeFor(held.operatorReason);
	if (!scope.inScope) {
		return `now waits on a person as ${held.operatorReason ?? '(no recorded reason)'}: ${scope.reason}`;
	}
	if (Date.parse(held.openedAt) !== Date.parse(slotOpenedAt)) {
		return 'took a new WIP slot since this attempt was scheduled';
	}
	if (held.latestRunId !== anchorRunId) {
		return `has moved since this attempt was scheduled (latest run ${held.latestRunId ?? 'none'})`;
	}
	return undefined;
}

/**
 * A ticket attempt's claim-time re-check (issue #1425). It runs only while the
 * ticket still holds its slot, the WIP panel still shows it as Waiting on you for
 * a reason Resolve problem takes on, and its situation is the one the attempt was
 * scheduled for — the same slot (`openedAt`) and the same latest run. A ticket that
 * moved in between is a different situation, and the next sweep decides it afresh.
 * A Resolve problem run is never ticket activity, so a queued or running attempt
 * does not change the classification it is checked against.
 */
async function resolveTicketAttempt(
	job: ResolveProblemJob,
	ticket: NonNullable<ResolveProblemJob['ticket']>,
	project: ProjectConfig,
	readRun: (id: string) => Promise<RunRow | undefined>,
	loadTicket: LoadHeldTicket,
	now: Date,
): Promise<ResolveProblemTrigger | ResolveProblemSkip> {
	const { taskId } = ticket;
	const repository = job.repository;
	if (!repository) {
		return { skip: `The Resolve problem dispatch for task ${taskId} names no repository`, taskId };
	}
	const held = await loadTicket(project, repository, taskId);
	if (!held) {
		return { skip: `Task ${taskId} no longer holds a WIP slot in ${repository}`, taskId };
	}
	const changed = ticketNoLongerStuck(held, ticket.slotOpenedAt, job.failedRunId);
	if (changed) return { skip: `Task ${taskId} ${changed}`, taskId };
	const anchor = job.failedRunId
		? await readTicketAnchor(job.failedRunId, project, readRun, now)
		: undefined;
	if (anchor && 'skip' in anchor) return { ...anchor, taskId };
	const prNumber = held.prNumber ?? ticket.prNumber;
	const workItemId = held.workItemId ?? ticket.workItemId;
	return {
		phase: 'resolve-problem',
		taskId,
		...(anchor ? { failedRunId: anchor.id, failedRun: failedRunRecord(anchor) } : {}),
		...(prNumber ? { prNumber } : {}),
		...(workItemId ? { workItemId } : {}),
		ticket: {
			taskId,
			repository,
			reason: ticket.reason,
			slotOpenedAt: held.openedAt,
			...(held.lastActivityAt ? { lastActivityAt: held.lastActivityAt } : {}),
			...(prNumber ? { prNumber } : {}),
			...(workItemId ? { workItemId } : {}),
		},
	};
}

/** The operator MCP endpoint on SWARM's public base URL, when one is configured. */
export function operatorMcpUrl(baseUrl = resolveWebhookCallbackBaseUrl()): string | undefined {
	return baseUrl ? `${baseUrl}${OPERATOR_MCP_ROUTE}` : undefined;
}

/**
 * Mint the run-bound credential a Resolve problem run's agent reaches SWARM with
 * (issue #1393's `mintRunBoundAgentToken`): held by the selected worker's owner,
 * scoped to the run's project, capped at the project's write budget, and valid for
 * the phase timeout plus {@link RESOLVE_PROBLEM_TOKEN_GRACE_MS}. A run with no row
 * cannot be bound to, so it fails terminally rather than minting an unbound token.
 */
export async function mintResolveProblemAccess(input: {
	project: ProjectConfig;
	runId: string | undefined;
	holderUserId: string;
	timeoutMs: number;
}): Promise<{ url?: string; token: string }> {
	if (!input.runId) {
		throw new AgentRunError(
			'Resolve problem needs a run record to bind its credential to, and none could be written',
			{ kind: 'error' },
		);
	}
	const issued = await mintRunBoundAgentToken({
		holderUserId: input.holderUserId,
		projectId: input.project.id,
		runId: input.runId,
		maxWriteActions: resolveProblemMaxWriteActions(input.project.pipeline),
		ttlMs: input.timeoutMs + RESOLVE_PROBLEM_TOKEN_GRACE_MS,
	});
	const url = operatorMcpUrl();
	return { ...(url ? { url } : {}), token: issued.token };
}

/**
 * Revoke every credential bound to a Resolve problem run — called at every settle,
 * success, failure and deferral alike (a retry mints its own). Never throws: the
 * token expires on its own, so a failed revoke is logged rather than allowed to
 * change the outcome.
 */
export async function revokeResolveProblemAccess(runId: string | undefined): Promise<void> {
	if (!runId) return;
	try {
		await revokeRunBoundAgentTokens(runId);
	} catch (err) {
		logger.warn('Failed to revoke the Resolve problem run credential (it expires on its own)', {
			runId,
			error: describeError(err),
		});
	}
}

/** The operator-facing account of the real writes an attempt made. */
function describeActions(report: ResolveProblemReport): string {
	if (report.actions.length === 0) return 'Tried: no recovery action.';
	return `Tried: ${report.actions
		.map((action) => `${action.tool} on ${action.target || '(no target)'} → ${action.result}`)
		.join('; ')}.`;
}

/**
 * Decide a finished Resolve problem run from the report its agent handed back. It
 * succeeds only when the report says `resolved` **and** the run filed a bug-report
 * occurrence (`filed_by_run_id` = this run) — checked here by a database read, never
 * taken from the report's own claim. Anything else throws a terminal `AgentRunError`
 * (`kind: 'error'`, so it is not retried) whose message is what the run and the
 * board item show: the summary and the actions tried, so an escalation reads as one.
 */
export async function verifyResolveProblemOutcome(
	input: {
		runId: string | undefined;
		report: ResolveProblemReport | undefined;
		agent: AgentCliResult;
		/** What the attempt was about — a failed run (the default) or a stuck ticket. */
		subject?: 'failed-run' | 'ticket';
	},
	findOccurrence: typeof findOccurrenceFiledByRun = findOccurrenceFiledByRun,
): Promise<void> {
	const { runId, report, agent } = input;
	const fail = (message: string): never => {
		throw new AgentRunError(message, { kind: 'error' }, agent);
	};
	if (!report) fail('Resolve problem finished without a report (resolve_problem_report.json)');
	const verified = report as ResolveProblemReport;
	const occurrence = runId ? await findOccurrence(runId) : undefined;
	if (!occurrence) {
		fail(
			`Resolve problem filed no bug report for this run — it must create one or add an occurrence with filedByRunId ${runId ?? '(unknown run)'}. Its own summary: ${verified.summary} ${describeActions(verified)}`,
		);
	}
	if (verified.outcome === 'unresolved') {
		fail(
			`Resolve problem could not resolve the ${input.subject === 'ticket' ? 'stuck ticket' : 'failed run'}: ${verified.summary} ${describeActions(verified)}`,
		);
	}
}
