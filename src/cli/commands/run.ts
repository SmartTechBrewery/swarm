/**
 * `swarm run` — inspect and recover single runs from the terminal, over two
 * transports.
 *
 * **`reset`** is per-run operator recovery (issue #429), the CLI companion to the
 * dashboard's "Reset & restart" button (issue #428). Both are thin surfaces over
 * the same service (`src/dispatch/run-reset.ts`), so the guards, ordering, and
 * reported outcomes are identical; this one exists because a wedged run often
 * needs freeing while the worker — and sometimes the API — is stopped, and like
 * `swarm queue clear` / `swarm worktrees prune` it talks straight to Postgres +
 * Redis. A thin CLI shell over `resetRun` (`node:util` `parseArgs` +
 * `_shared/output.ts`, like `commands/worktrees.ts`): it validates its arguments,
 * prints one line per step the service performed, and maps a `RunResetError`
 * refusal to exit 1 with the service's own operator-facing message. Connections
 * are closed in a `finally` (`closeQueue()` + `closeDb()`, the pair `queue clear`
 * closes).
 *
 * **`list`, `show` and `logs`** read runs over the operator API
 * (`../_shared/operator-client.ts`) with the cached `swarm login` session (issue
 * #1182): the dashboard's own `runs.list` / `runs.getById` / `runs.getLogs` /
 * `runs.getOutput`, so a caller reads exactly what the dashboard shows them. They
 * need `SWARM_CONTROL_PLANE_URL` (the environment, else this checkout's `.env` —
 * `../_shared/control-plane-env.ts`) and **no `DATABASE_URL`**, which is the point on
 * a host with no shell (the VPS behind Caddy, issue #1153). They import nothing
 * new from `../../db/*`; response shapes are declared here, never imported from
 * the router, for the reason `operator-client.ts` gives.
 *
 * Subcommands:
 *   swarm run list [--project <id>] [--status <s>] [--phase <p>] [--since <window>] [--limit <n>] [--offset <n>] [--json]
 *   swarm run show <runId> [--json]
 *   swarm run logs <runId> [--json]
 *   swarm run reset <runId>
 */

import { parseArgs } from 'node:util';
import { z } from 'zod';
import { closeDb } from '../../db/client.js';
import { type ResetRunResult, RunResetError, resetRun } from '../../dispatch/run-reset.js';
import { closeRunCancellationRedis } from '../../queue/cancellation.js';
import { closeQueue } from '../../queue/producer.js';
import { ALL_TRIGGER_PHASES } from '../../triggers/types.js';
import type {
	TerminationBlockedReason,
	TerminationCleanupResult,
} from '../../worktree/termination-cleanup.js';
import {
	createOperatorClient,
	OperatorApiError,
	type OperatorClient,
	requireOperatorSession,
} from '../_shared/operator-client.js';
import * as out from '../_shared/output.js';

const USAGE = `swarm run — inspect and recover single runs

Usage:
  swarm run list [--project <id>] [--status <status>] [--phase <phase>]
                 [--since <window>] [--limit <n>] [--offset <n>] [--json]
  swarm run show <runId> [--json]
  swarm run logs <runId> [--json]
  swarm run reset <runId>

  list     List recent runs, newest first, one per line: started, status, phase,
           project, run id, subject, and the first line of the headline.
           --status   running | completed | failed | deferred | checkpointed
           --phase    planning | implementation | review | respond-to-review |
                      respond-to-ci | resolve-conflicts | worker-update
           --since    runs started within a window: 30m, 24h, 7d, or an ISO 8601
                      timestamp
           --limit    page size, 1–200 (default 50); --offset pages on
  show     Show one run: where and when it ran, its headline, and the failure
           cause and recovery the dashboard shows.
  logs     Print one run's agent output, then its captured stdout/stderr.

  reset    Reset one *wedged* run and restart its phase from scratch: cancel its
           active dispatch, clear its Redis cancellation flag, settle its
           checkout and worktree lease (releasing a stale lease no live run
           owns), clear its recovery record, and re-dispatch the phase with a
           fresh agent session. This is the last resort — try "Retry now" or
           "Terminate" from the dashboard first.

list, show and logs read over the control plane with your \`swarm login\` session
and need SWARM_CONTROL_PLANE_URL (from the environment, or this checkout's .env)
— no database and no browser. They show exactly
what the dashboard shows you, no more. --json prints the control plane's payload
unchanged, for scripts. Example: swarm run list --status failed --since 24h

A reset ALWAYS DISCARDS and never refuses. It cancels a dispatch a worker has
already claimed, removes the checkout together with any uncommitted changes and
unpushed commits — permanently, and on whichever worker holds it — and resets a
run still marked running without it being terminated first: a running run's agent
process is asked to stop and waited for before anything is torn down, so there is
no "terminate, then reset" to do. An agent that never confirms the stop is
reported and the restart happens anyway. A run that cannot be re-dispatched at
all (no stored job payload, or a project that no longer exists) is settled as
failed with the reason rather than left wedged.

reset requires DATABASE_URL and REDIS_URL in the environment — run via
\`npm run swarm -- run reset <runId>\` (loads .env) or export them yourself
first. Works with the worker and the API stopped: it goes straight to Postgres
and Redis. It settles a checkout on *this* host's disk directly; one on another
worker is settled by that worker when it provisions the restart, following the
discard intent the restart carries, so this can be run from anywhere.`;

/** `runs.id` is a uuid column (`src/db/schema/runs.ts`). */
const RunIdSchema = z.string().uuid();

/**
 * Operator-facing wording for a protected-checkout reason (dirty/unpushed/leased).
 * Typed against the service's union rather than `string` so a new blocked reason
 * is a compile error here instead of leaking its raw key into the report.
 *
 * Keep the wording in this formatter and {@link describeWorktreeOutcome} in sync
 * with the dashboard's copy of the same report (`dashboard/src/lib/run-reset.ts`),
 * which cannot import this module: the dashboard package deliberately depends on
 * no server code, so the two surfaces over `resetRun` duplicate these strings.
 */
function describeWorktreeReason(reason: TerminationBlockedReason): string {
	switch (reason) {
		case 'dirty':
			return 'uncommitted changes';
		case 'unpushed':
			return 'unpushed commits';
		case 'live-leased':
			return 'a lease held by another live run';
	}
}

/**
 * One line describing what the reset did to the run's checkout and lease **on the
 * control-plane host** — the only filesystem `resetRun` can settle itself. A
 * checkout on another worker is described by {@link describeWorktreeIntent}
 * instead (issue #592).
 */
function describeWorktreeOutcome(worktree: TerminationCleanupResult): string {
	switch (worktree.outcome) {
		case 'absent':
			// The service still releases the lease on this path, so a leftover marker
			// from the wedged run is gone. What it can no longer claim is that there was
			// nothing to remove: on a federated deployment the checkout is usually alive
			// on another worker, which is the very case being reset.
			return 'checkout: none on this host — one held by another worker is settled by that worker when it provisions the restart; any leftover lease marker here was dropped';
		case 'preserved':
			return 'checkout: kept for its saved agent session; the lease was released';
		case 'removed': {
			const notes = [
				worktree.discarded
					? `${describeWorktreeReason(worktree.discarded)} discarded as requested`
					: undefined,
				worktree.staleLeaseReleased
					? 'a stale worktree lease no live run owned was released'
					: undefined,
			].filter((note): note is string => note !== undefined);
			return notes.length > 0
				? `checkout: removed — ${notes.join('; ')}`
				: 'checkout: removed and its lease released';
		}
		case 'blocked':
			// Since issue #744 a reset discards, so a retained checkout is one the
			// settlement could not free at all — not one the operator declined to.
			return (
				`checkout: retained — ${describeWorktreeReason(worktree.blockedReason)}; the restarted run re-checks it before provisioning ` +
				'— the worker holding it discards it when it provisions the restart'
			);
	}
}

/**
 * Print the per-step report in the order `resetRun` performs them, so an
 * operator can tell a reset that actually freed the checkout from one that
 * restarted the run but left protected work behind.
 */
function reportReset(result: ResetRunResult): void {
	// The reset's first step (issue #745). A run that had no agent to stop says
	// nothing, the same way a step the service did not perform is not claimed below.
	switch (result.agentStop) {
		case 'not-running':
			break;
		case 'stopped':
			out.step(
				'agent: the running agent was asked to stop, and the run left running before anything was torn down',
			);
			break;
		case 'timed-out':
			// Warned rather than stepped: the restart went ahead against a run that never
			// confirmed the stop, which is the one thing here an operator must not miss.
			out.warn(
				'agent: the running agent was asked to stop but had not confirmed within the wait; the reset continued and discarded its checkout anyway',
			);
			break;
	}

	switch (result.dispatch) {
		case 'none':
			out.step('dispatch: none was active');
			break;
		case 'cancelled':
			out.step('dispatch: the active dispatch was cancelled');
			break;
		case 'cancelled-claimed':
			out.step('dispatch: a dispatch a worker had already claimed was cancelled');
			break;
	}

	if (result.cancellationCleared) {
		out.step('cancellation flag: cleared, so the fresh attempt is not killed at startup');
	}

	if (result.worktree) {
		out.step(describeWorktreeOutcome(result.worktree));
	}
	// A local teardown throw no longer stops the reset (issue #744) — it is reported
	// so the operator knows this host's checkout still needs a look, while the
	// restart's own discard intent settles the one that was actually in the way.
	if (result.worktreeError) {
		out.warn(
			`checkout: this host's teardown failed — ${result.worktreeError}; the reset continued, and the worker holding the checkout discards it when it provisions the restart`,
		);
	}
	// The other half of the checkout answer (issue #592): what the *restart* does to a
	// checkout this host cannot see. There is no restart to carry it on a terminated
	// reset, so the line is only true for the restarted ending.
	if (result.outcome === 'restarted') {
		out.step(
			'restart intent: the worker holding the checkout discards it — dirty and unpushed work included — before provisioning',
		);
	}

	if (result.recoveryCleared) {
		out.step('recovery record: cleared');
	}

	// The one step that reports work *lost* (issue #567): the run stops waiting for
	// the machine that held its preserved checkout, and that attempt is not carried
	// over. Warned rather than stepped, because nothing else here is irreversible.
	if (result.abandonedPreservedWorkerId) {
		out.warn(
			`preserved work: discarded — this run is no longer pinned to worker ${result.abandonedPreservedWorkerId}, and that attempt's progress is not carried over`,
		);
	}

	// A stated terminal ending is a *reported outcome*, not a failure (issue #744):
	// the run was cleared and settled rather than left wedged, so it exits 0 with the
	// reason on stdout like every other step.
	if (result.outcome === 'terminated') {
		out.step(`not restarted: ${result.reason}`);
		return;
	}
	out.step(`restarted: re-dispatched from scratch as dispatch ${result.dispatchId}`);
}

async function resetOneRun(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		options: { help: { type: 'boolean', short: 'h' } },
		allowPositionals: true,
	});
	if (values.help) {
		out.info(USAGE);
		return 0;
	}

	const [runId, ...extra] = positionals;
	if (!runId || extra.length > 0) {
		out.error('run reset: exactly one <runId> is required');
		out.info(USAGE);
		return 1;
	}
	// `runs.id` is a uuid column, so a typo'd id fails inside Postgres with a raw
	// query error instead of the service's clean not-found refusal. Caught here so
	// an operator sees the id they mistyped, not a SQL dump — and before any
	// connection is opened.
	if (!RunIdSchema.safeParse(runId).success) {
		out.error(`run reset: '${runId}' is not a valid run id (expected a uuid)`);
		return 1;
	}

	// Stated before anything is touched, because there is no opt-in left to decline
	// (issue #744): the operator's only choice is not to run the command.
	out.warn(
		'a reset discards: uncommitted changes and unpushed commits in the checkout are removed permanently, wherever it lives, and an agent still running for this run is stopped and its work lost',
	);

	try {
		out.step(`resetting run '${runId}'…`);
		const result = await resetRun(runId);
		reportReset(result);
		return 0;
	} catch (err) {
		// A refusal's message is already operator-facing; anything else is internal.
		if (err instanceof RunResetError) {
			out.error(err.message);
			return 1;
		}
		out.error(`run reset failed: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	} finally {
		// Every client this command opened, including the one `resetRun` creates to
		// clear the cancellation flag. Settled together so one failing closer cannot
		// skip the others — or replace an already-decided exit code with a throw.
		await Promise.allSettled([closeQueue(), closeDb(), closeRunCancellationRedis()]);
	}
}

// ---------------------------------------------------------------------------
// Read subcommands (issue #1182) — over the operator API, no database.
// ---------------------------------------------------------------------------

/**
 * Mirrors `RunStatusEnum` in `src/api/routers/runs.ts`, restated here so a typo
 * gets a one-line error instead of the server's raw validation dump.
 */
const RUN_STATUSES = ['running', 'completed', 'failed', 'deferred', 'checkpointed'] as const;

/**
 * Mirrors `RunPhaseEnum` in `src/api/routers/runs.ts`: the six pipeline phases plus
 * `'worker-update'`, the literal of `WORKER_UPDATE_RUN_PHASE`
 * (`src/db/repositories/runsRepository.ts`), which this DB-free path does not import.
 */
const RUN_PHASES: readonly string[] = [...ALL_TRIGGER_PHASES, 'worker-update'];

const LIST_DEFAULT_LIMIT = 50;
const LIST_MAX_LIMIT = 200;
/** How much of a run's headline a `list` line carries before it is cut. */
const LIST_HEADLINE_MAX_CHARS = 160;

/**
 * One row of `runs.list` / the body of `runs.getById`. Validates only what the
 * human renderer reads; `.passthrough()` keeps every other field so `--json`
 * prints the server's payload unabridged.
 */
const RunRowSchema = z
	.object({
		id: z.string(),
		projectId: z.string(),
		phase: z.string(),
		status: z.string(),
		startedAt: z.string(),
		completedAt: z.string().nullish(),
		durationMs: z.number().nullish(),
		error: z.string().nullish(),
		workItemTitle: z.string().nullish(),
		workItemUrl: z.string().nullish(),
		prNumber: z.string().nullish(),
		prTitle: z.string().nullish(),
		taskId: z.string().nullish(),
		repository: z.string().nullish(),
		engine: z.string().nullish(),
		model: z.string().nullish(),
		nextRetryAt: z.string().nullish(),
		kind: z.string().nullish(),
		workerName: z.string().nullish(),
	})
	.passthrough();
type RunRow = z.infer<typeof RunRowSchema>;

const RunListSchema = z.object({ data: z.array(RunRowSchema), total: z.number() }).passthrough();

const RunDetailSchema = RunRowSchema.extend({
	failureDiagnosis: z
		.object({ title: z.string(), message: z.string(), recovery: z.string().nullish() })
		.passthrough()
		.nullish(),
	attribution: z
		.object({ workerName: z.string().nullish(), userDisplayName: z.string().nullish() })
		.passthrough()
		.nullish(),
}).passthrough();
type RunDetail = z.infer<typeof RunDetailSchema>;

const RunLogsSchema = z
	.object({ stdout: z.string().nullable(), stderr: z.string().nullable() })
	.passthrough()
	.nullable();

const RunOutputEventSchema = z
	.object({
		id: z.number(),
		stream: z.enum(['stdout', 'stderr']),
		content: z.string(),
		emittedAt: z.string(),
	})
	.passthrough();
type RunOutputEvent = z.infer<typeof RunOutputEventSchema>;

const RunOutputPageSchema = z.object({
	events: z.array(RunOutputEventSchema),
	nextCursor: z.number(),
	hasMore: z.boolean(),
	truncated: z.boolean(),
	retentionBytes: z.number(),
});

/** A `parse` for {@link OperatorClient} calls, so each call site names its schema and nothing else. */
function parseWith<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>): (value: unknown) => T {
	return (value) => schema.parse(value);
}

/**
 * A client bound to the cached `swarm login` session, printing the one actionable
 * line and returning `undefined` when the URL or the session is missing. Called
 * *after* argument parsing, so `--help` and a usage error still answer on a machine
 * that has never logged in — the same shape as `workers.ts`'s.
 */
function requireOperator(): OperatorClient | undefined {
	const resolved = requireOperatorSession();
	if ('error' in resolved) {
		out.error(resolved.error);
		return undefined;
	}
	return createOperatorClient(resolved.session);
}

const SINCE_DURATION = /^(\d+)([mhd])$/;
const SINCE_UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * Resolve `--since` into the ISO instant `runs.list` takes: a relative window
 * (`30m`, `24h`, `7d`) counted back from `now`, or an ISO 8601 timestamp passed
 * through. `undefined` when it is neither.
 */
export function resolveSince(value: string, now: number = Date.now()): string | undefined {
	const duration = SINCE_DURATION.exec(value);
	if (duration) {
		return new Date(now - Number(duration[1]) * SINCE_UNIT_MS[duration[2]]).toISOString();
	}
	return z.string().datetime({ offset: true }).safeParse(value).success ? value : undefined;
}

/** A non-negative integer flag, or `undefined` when the value is not one. */
function parseCount(value: string): number | undefined {
	return /^\d+$/.test(value) ? Number(value) : undefined;
}

/** Validate a positional run id the same way `run reset` does, before anything dials out. */
function requireRunId(subcommand: string, positionals: string[]): string | undefined {
	const [runId, ...extra] = positionals;
	if (!runId || extra.length > 0) {
		out.error(`run ${subcommand}: exactly one <runId> is required`);
		out.info(USAGE);
		return undefined;
	}
	if (!RunIdSchema.safeParse(runId).success) {
		out.error(`run ${subcommand}: '${runId}' is not a valid run id (expected a uuid)`);
		return undefined;
	}
	return runId;
}

/** What a run was about, in the order the dashboard's list names it. */
function runSubject(row: RunRow): string {
	if (row.workItemTitle) return row.workItemTitle;
	if (row.prTitle) return row.prTitle;
	if (row.prNumber) return `#${row.prNumber}`;
	return row.taskId ?? '-';
}

/** The first line of a run's headline, cut for a one-line listing. */
function headlineSummary(error: string): string {
	const firstLine = error.split('\n', 1)[0].trim();
	return firstLine.length > LIST_HEADLINE_MAX_CHARS
		? `${firstLine.slice(0, LIST_HEADLINE_MAX_CHARS - 1)}…`
		: firstLine;
}

/** The `runs.list` input; a key left `undefined` is dropped on the JSON wire. */
interface ListRunsInput {
	projectId?: string;
	status?: string;
	phase?: string;
	since?: string;
	limit: number;
	offset: number;
}

/**
 * Validate `run list`'s filter flags into the `runs.list` input, or return the
 * one-line reason the first bad flag is refused — before anything dials out.
 */
function buildListInput(flags: {
	project?: string;
	status?: string;
	phase?: string;
	since?: string;
	limit?: string;
	offset?: string;
}): ListRunsInput | string {
	if (flags.project !== undefined && !flags.project.trim()) return '--project needs a project id';
	if (flags.status !== undefined && !(RUN_STATUSES as readonly string[]).includes(flags.status)) {
		return `--status must be one of ${RUN_STATUSES.join(', ')}`;
	}
	if (flags.phase !== undefined && !RUN_PHASES.includes(flags.phase)) {
		return `--phase must be one of ${RUN_PHASES.join(', ')}`;
	}
	const since = flags.since === undefined ? undefined : resolveSince(flags.since);
	if (flags.since !== undefined && !since) {
		return '--since must be a duration like 30m, 24h or 7d, or an ISO 8601 timestamp';
	}
	const limit = flags.limit === undefined ? LIST_DEFAULT_LIMIT : parseCount(flags.limit);
	if (limit === undefined || limit < 1 || limit > LIST_MAX_LIMIT) {
		return `--limit must be an integer from 1 to ${LIST_MAX_LIMIT}`;
	}
	const offset = flags.offset === undefined ? 0 : parseCount(flags.offset);
	if (offset === undefined) return '--offset must be an integer of 0 or more';
	return {
		projectId: flags.project,
		status: flags.status,
		phase: flags.phase,
		since,
		limit,
		offset,
	};
}

async function listRunsCommand(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		options: {
			help: { type: 'boolean', short: 'h' },
			json: { type: 'boolean' },
			project: { type: 'string' },
			status: { type: 'string' },
			phase: { type: 'string' },
			since: { type: 'string' },
			limit: { type: 'string' },
			offset: { type: 'string' },
		},
		allowPositionals: true,
	});
	if (values.help) {
		out.info(USAGE);
		return 0;
	}
	if (positionals.length > 0) {
		out.error(`run list: unexpected argument '${positionals[0]}'`);
		return 1;
	}

	const input = buildListInput(values);
	if (typeof input === 'string') {
		out.error(`run list: ${input}`);
		return 1;
	}

	const client = requireOperator();
	if (!client) return 1;
	const result = await client.query('runs.list', input, parseWith(RunListSchema));

	if (values.json) {
		console.log(JSON.stringify(result, null, 2));
		return 0;
	}
	if (result.data.length === 0) {
		out.info('no runs');
		return 0;
	}
	for (const row of result.data) {
		const fields = [row.startedAt, row.status, row.phase, row.projectId, row.id, runSubject(row)];
		if (row.error) fields.push(headlineSummary(row.error));
		out.info(fields.join('\t'));
	}
	const shownTo = input.offset + result.data.length;
	if (result.total > shownTo) {
		out.info(
			`showing ${input.offset + 1}–${shownTo} of ${result.total}; next page: --offset ${shownTo}`,
		);
	}
	return 0;
}

/** `1h 2m 3s`-style, for the detail view's duration line. */
function formatDuration(ms: number): string {
	const totalSeconds = Math.round(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const parts: string[] = [];
	if (hours > 0) parts.push(`${hours}h`);
	if (hours > 0 || minutes > 0) parts.push(`${minutes}m`);
	parts.push(`${seconds}s`);
	return parts.join(' ');
}

/**
 * The detail view's labelled lines, in reading order. A line whose value is absent
 * is omitted; a failed run with no diagnosis shows its headline alone, as the
 * dashboard does.
 */
function describeRun(run: RunDetail): string[] {
	const lines: [string, string | null | undefined][] = [
		['run', run.id],
		['project', run.repository ? `${run.projectId} (${run.repository})` : run.projectId],
		[
			'phase',
			run.kind && run.kind !== 'pipeline' ? `${run.phase} (machine maintenance)` : run.phase,
		],
		['status', run.status],
		['started', run.startedAt],
		['completed', run.completedAt],
		['duration', run.durationMs == null ? null : formatDuration(run.durationMs)],
		['next retry', run.status === 'deferred' ? run.nextRetryAt : null],
		[
			'worker',
			run.attribution?.workerName
				? run.attribution.userDisplayName
					? `${run.attribution.workerName} (${run.attribution.userDisplayName})`
					: run.attribution.workerName
				: run.workerName,
		],
		['agent', [run.engine, run.model].filter(Boolean).join(' / ') || null],
		['work item', [run.workItemTitle, run.workItemUrl].filter(Boolean).join(' — ') || null],
		[
			'pull request',
			run.prNumber ? [`#${run.prNumber}`, run.prTitle].filter(Boolean).join(' ') : null,
		],
		['headline', run.error],
		[
			'cause',
			run.failureDiagnosis
				? `${run.failureDiagnosis.title}: ${run.failureDiagnosis.message}`
				: null,
		],
		['recovery', run.failureDiagnosis?.recovery],
	];
	return lines
		.filter((line): line is [string, string] => typeof line[1] === 'string' && line[1] !== '')
		.map(([label, value]) => `${`${label}:`.padEnd(14)}${value}`);
}

async function showRunCommand(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		options: { help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' } },
		allowPositionals: true,
	});
	if (values.help) {
		out.info(USAGE);
		return 0;
	}
	const runId = requireRunId('show', positionals);
	if (!runId) return 1;

	const client = requireOperator();
	if (!client) return 1;
	const result = await client.query('runs.getById', { id: runId }, parseWith(RunDetailSchema));

	if (values.json) {
		console.log(JSON.stringify(result, null, 2));
		return 0;
	}
	// Printed bare, not through `out.info`: a multi-line headline keeps its shape.
	for (const line of describeRun(result)) console.log(line);
	return 0;
}

/** A run's whole agent output, every page of it, plus the retention facts the last page reported. */
interface RunOutput {
	events: RunOutputEvent[];
	truncated: boolean;
	retentionBytes: number;
}

/**
 * Page `runs.getOutput` from the start, exactly as the dashboard's viewer does. A
 * cursor that does not advance stops the loop, so a misbehaving server cannot spin
 * it forever.
 */
async function readAllOutput(client: OperatorClient, runId: string): Promise<RunOutput> {
	const output: RunOutput = { events: [], truncated: false, retentionBytes: 0 };
	let after = 0;
	for (;;) {
		const page = await client.query(
			'runs.getOutput',
			{ runId, after },
			parseWith(RunOutputPageSchema),
		);
		output.events.push(...page.events);
		output.truncated = page.truncated;
		output.retentionBytes = page.retentionBytes;
		if (!page.hasMore || page.nextCursor <= after) return output;
		after = page.nextCursor;
	}
}

function printAgentOutput({ events, truncated, retentionBytes }: RunOutput): void {
	if (events.length === 0) {
		out.info('no agent output captured');
	} else {
		out.info('--- agent output ---');
		// Verbatim: each chunk carries its own newlines, as the live viewer renders it.
		for (const event of events) process.stdout.write(event.content);
		if (!events[events.length - 1].content.endsWith('\n')) process.stdout.write('\n');
	}
	if (truncated) {
		out.warn(
			`agent output was truncated at the ${retentionBytes} byte retention cap; later output was not kept`,
		);
	}
}

function printCapturedLogs(logs: z.infer<typeof RunLogsSchema>): void {
	if (!logs || (!logs.stdout && !logs.stderr)) {
		out.info('no captured stdout/stderr stored for this run');
		return;
	}
	for (const [label, text] of [
		['stdout', logs.stdout],
		['stderr', logs.stderr],
	] as const) {
		if (!text) continue;
		out.info(`--- captured ${label} ---`);
		process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
	}
}

async function runLogsCommand(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		options: { help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' } },
		allowPositionals: true,
	});
	if (values.help) {
		out.info(USAGE);
		return 0;
	}
	const runId = requireRunId('logs', positionals);
	if (!runId) return 1;

	const client = requireOperator();
	if (!client) return 1;
	const output = await readAllOutput(client, runId);
	const logs = await client.query('runs.getLogs', { runId }, parseWith(RunLogsSchema));

	if (values.json) {
		console.log(JSON.stringify({ output, logs }, null, 2));
		return 0;
	}
	printAgentOutput(output);
	printCapturedLogs(logs);
	return 0;
}

export async function run(argv: string[]): Promise<number> {
	const [subcommand, ...rest] = argv;

	if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
		out.info(USAGE);
		return subcommand ? 0 : 1;
	}

	if (subcommand === 'reset') return resetOneRun(rest);

	try {
		switch (subcommand) {
			case 'list':
				return await listRunsCommand(rest);
			case 'show':
				return await showRunCommand(rest);
			case 'logs':
				return await runLogsCommand(rest);
		}
	} catch (err) {
		// A refusal the control plane made — or a failure to reach it — already
		// carries an operator-facing message (the same split `workers.ts` makes).
		if (err instanceof OperatorApiError) {
			out.error(err.message);
			return 1;
		}
		throw err;
	}

	out.error(`unknown run subcommand '${subcommand}' (expected list, show, logs or reset)`);
	out.info(USAGE);
	return 1;
}
