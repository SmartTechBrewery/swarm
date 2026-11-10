/**
 * The `run_attempts` history (issue #1400): one row per execution attempt of a run,
 * so a run page can say which attempt each piece of output, each error and each
 * outcome belongs to, rather than reading the run row's latest status against output
 * that an earlier attempt produced.
 *
 * Three moments write it:
 *
 * - **open** ({@link openRunAttempt}) — the worker consumer has bound a worker to a
 *   dispatch and set the run `running` for it. A pre-run wait never opens one.
 * - **close** ({@link closeSettledRunAttempts}) — the run left `running`. Called
 *   inside every run settle writer, it copies the run's outcome columns onto the
 *   open attempt, because those columns are overwritten by the next retry.
 * - **operator intent** ({@link recordNextAttemptTrigger}) — Reset & restart or
 *   Retry now, carried on the run row until the attempt that executes it opens.
 */

import { and, asc, count, desc, eq, inArray, isNull, ne, type SQL, sql } from 'drizzle-orm';

import { getDb } from '../client.js';
import {
	type RunAttemptOperatorTrigger,
	type RunAttemptTrigger,
	runAttempts,
	runOutputEvents,
	runs,
} from '../schema/runs.js';

export type RunAttemptRow = typeof runAttempts.$inferSelect;

/**
 * How an attempt ended: the run status it left `running` for, or `superseded` when
 * a later attempt opened before this one recorded any outcome.
 */
export type RunAttemptOutcome = 'completed' | 'failed' | 'deferred' | 'checkpointed' | 'superseded';

export type { RunAttemptOperatorTrigger, RunAttemptTrigger };

/** A transaction or the pool — every write here can join a caller's transaction. */
export type RunAttemptExecutor = Pick<ReturnType<typeof getDb>, 'select' | 'insert' | 'update'>;

/**
 * Close every still-open attempt of `runIds` whose run has left `running`, copying
 * the outcome the run row now states. A no-op for a run still running, a run with no
 * open attempt (a pre-run wait), and an already-closed attempt — so a later settle of
 * the same run (a deferred run cancelled by a reset) never rewrites the outcome the
 * attempt actually ended with.
 */
export async function closeSettledRunAttempts(
	executor: RunAttemptExecutor,
	runIds: readonly string[],
): Promise<void> {
	if (runIds.length === 0) return;
	await executor
		.update(runAttempts)
		.set({
			endedAt: sql`COALESCE(${runs.completedAt}, now())`,
			outcome: sql`${runs.status}`,
			error: sql`${runs.error}`,
			failureDiagnosis: sql`${runs.failureDiagnosis}`,
			nextRetryAt: sql`${runs.nextRetryAt}`,
			exitCode: sql`${runs.exitCode}`,
			// What actually ran, when the settle recorded it; the attempt's own otherwise.
			engine: sql`COALESCE(${runs.engine}, ${runAttempts.engine})`,
			model: sql`COALESCE(${runs.model}, ${runAttempts.model})`,
		})
		.from(runs)
		.where(
			and(
				eq(runAttempts.runId, runs.id),
				isNull(runAttempts.endedAt),
				ne(runs.status, 'running'),
				inArray(runs.id, [...runIds]),
			),
		);
}

/**
 * Open the attempt the run row now describes — called once the consumer has set the
 * run `running` on a selected worker for `dispatchId`. Consumes the operator intent
 * that started it, if any. An attempt still open at this point never recorded an
 * outcome (its run was re-claimed while still `running`), so it is closed as
 * `superseded` rather than left looking like it is executing.
 *
 * Returns the new attempt's id, or `undefined` when the run row is gone.
 */
export async function openRunAttempt(
	runId: string,
	dispatchId: string | undefined,
): Promise<string | undefined> {
	return await getDb().transaction(async (tx) => {
		const rows = await tx
			.select({
				workerId: runs.workerId,
				engine: runs.engine,
				model: runs.model,
				startedAt: runs.startedAt,
				nextAttemptTrigger: runs.nextAttemptTrigger,
				nextAttemptRequestedAt: runs.nextAttemptRequestedAt,
			})
			.from(runs)
			.where(eq(runs.id, runId))
			.for('update')
			.limit(1);
		const run = rows[0];
		if (!run) return undefined;

		await tx
			.update(runAttempts)
			.set({ endedAt: run.startedAt, outcome: 'superseded' })
			.where(and(eq(runAttempts.runId, runId), isNull(runAttempts.endedAt)));

		const [last] = await tx
			.select({ seq: runAttempts.seq })
			.from(runAttempts)
			.where(eq(runAttempts.runId, runId))
			.orderBy(desc(runAttempts.seq))
			.limit(1);

		const [inserted] = await tx
			.insert(runAttempts)
			.values({
				runId,
				seq: (last?.seq ?? 0) + 1,
				dispatchId: dispatchId ?? null,
				trigger: run.nextAttemptTrigger ?? 'automatic',
				requestedAt: run.nextAttemptTrigger ? run.nextAttemptRequestedAt : null,
				workerId: run.workerId,
				engine: run.engine,
				model: run.model,
				startedAt: run.startedAt,
			})
			.returning({ id: runAttempts.id });

		if (run.nextAttemptTrigger) {
			await tx
				.update(runs)
				.set({ nextAttemptTrigger: null, nextAttemptRequestedAt: null })
				.where(eq(runs.id, runId));
		}
		return inserted.id;
	});
}

/**
 * Record that an operator asked for the run's next attempt, so that attempt is shown
 * as theirs. A later request replaces an earlier one that no attempt executed yet.
 */
export async function recordNextAttemptTrigger(
	runId: string,
	trigger: RunAttemptOperatorTrigger,
): Promise<void> {
	await getDb()
		.update(runs)
		.set({ nextAttemptTrigger: trigger, nextAttemptRequestedAt: new Date() })
		.where(eq(runs.id, runId));
}

/** Who streamed a batch of output, as the transport authorized it. */
export interface RunOutputSource {
	dispatchId?: string;
	workerId?: string;
}

/**
 * The attempt a batch of output belongs to, with its share of the retention cap.
 *
 * Keyed on the dispatch and worker that streamed it, not on "whatever is open now":
 * a worker returning after its attempt was reaped (issue #1171) streams late output
 * for *its* attempt while a newer one may already be running. The latest attempt
 * matching both wins, since a re-claimed dispatch can run several attempts. A source
 * naming nothing (a control-plane note with no dispatch in hand) belongs to the run's
 * latest attempt. `undefined` when nothing matches — the output is then kept
 * unattributed rather than credited to an attempt that did not produce it.
 */
export async function resolveOutputAttempt(
	executor: RunAttemptExecutor,
	runId: string,
	source: RunOutputSource | undefined,
): Promise<{ id: string; outputBytes: number; outputTruncated: boolean } | undefined> {
	const filters: SQL[] = [eq(runAttempts.runId, runId)];
	if (source?.dispatchId) filters.push(eq(runAttempts.dispatchId, source.dispatchId));
	if (source?.workerId) filters.push(eq(runAttempts.workerId, source.workerId));
	const rows = await executor
		.select({
			id: runAttempts.id,
			outputBytes: runAttempts.outputBytes,
			outputTruncated: runAttempts.outputTruncated,
		})
		.from(runAttempts)
		.where(and(...filters))
		.orderBy(desc(runAttempts.seq))
		.for('update')
		.limit(1);
	return rows[0];
}

/** One attempt as the run page and `run_get` read it. */
export interface RunAttemptSummary extends RunAttemptRow {
	/** How many output lines this attempt has stored. `0` means it produced none. */
	outputEventCount: number;
}

/**
 * Every attempt of a run in order, each with its stored output count, plus the count
 * of output lines no attempt is recorded for (output written before attempts were).
 */
export async function listRunAttempts(runId: string): Promise<{
	attempts: RunAttemptSummary[];
	unattributedOutputEventCount: number;
}> {
	const db = getDb();
	const [attempts, counts] = await Promise.all([
		db.select().from(runAttempts).where(eq(runAttempts.runId, runId)).orderBy(asc(runAttempts.seq)),
		db
			.select({ attemptId: runOutputEvents.attemptId, events: count() })
			.from(runOutputEvents)
			.where(eq(runOutputEvents.runId, runId))
			.groupBy(runOutputEvents.attemptId),
	]);
	const byAttempt = new Map(counts.map((row) => [row.attemptId, Number(row.events)]));
	return {
		attempts: attempts.map((attempt) => ({
			...attempt,
			outputEventCount: byAttempt.get(attempt.id) ?? 0,
		})),
		unattributedOutputEventCount: byAttempt.get(null) ?? 0,
	};
}
