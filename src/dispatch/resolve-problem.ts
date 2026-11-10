/**
 * The Resolve problem phase (issue #1395) — the control-plane half, the side
 * holding the database. `../pipeline/resolve-problem.ts` is the worker half.
 *
 * A Resolve problem dispatch names one **failed run** (`{ type: 'resolve-problem',
 * failedRunId }`, `../queue/jobs.ts`). This module schedules one, turns a claimed
 * one into the phase's inputs by reading that run, mints and revokes the
 * run-bound credential the agent reaches SWARM with, and decides — by reading the
 * bug report the run had to file — whether the attempt succeeded. Nothing
 * schedules one automatically yet; phase 5 of the parent task adds that trigger.
 */

import {
	isResolveProblemEnabled,
	resolveProblemMaxWriteActions,
} from '../config/resolve-problem.js';
import type { ProjectConfig } from '../config/schema.js';
import { findOccurrenceFiledByRun } from '../db/repositories/bugReportsRepository.js';
import type { DispatchRow } from '../db/repositories/dispatchesRepository.js';
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
import type { TriggerResult } from '../triggers/types.js';
import { createAndPublishDispatch } from './dispatcher.js';

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

/** A claimed Resolve problem dispatch that should not run, and why. */
export interface ResolveProblemSkip {
	skip: string;
	/** The failed run's task, when the run could still be read. */
	taskId?: string;
}

/**
 * The phase's inputs for a claimed Resolve problem dispatch, read off the failed
 * run — or the reason it must not run: the project has not turned the phase on,
 * the run is gone or belongs elsewhere, it is no longer `failed` (a retry already
 * picked it up), or it is itself a Resolve problem attempt.
 */
export async function resolveProblemTrigger(
	job: ResolveProblemJob,
	project: ProjectConfig,
	readRun: (id: string) => Promise<RunRow | undefined> = getRunByIdFromDb,
): Promise<ResolveProblemTrigger | ResolveProblemSkip> {
	if (!isResolveProblemEnabled(project.pipeline)) {
		return {
			skip: `Resolve problem is not enabled for project '${project.id}' (pipeline.resolveProblem.enabled)`,
		};
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
		failedRun: {
			id: run.id,
			phase: run.phase,
			taskId: run.taskId,
			prNumber: run.prNumber,
			error: run.error,
			failureDiagnosis: run.failureDiagnosis,
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
			`Resolve problem could not resolve the failed run: ${verified.summary} ${describeActions(verified)}`,
		);
	}
}
