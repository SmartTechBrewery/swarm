import { and, asc, gt, inArray } from 'drizzle-orm';

import type { AgentCli } from '../../harness/agent-cli.js';
import { getDb } from '../client.js';
import { workerCliRateLimits } from '../schema/workerCliRateLimits.js';

/** One machine's cool-down on one CLI, as stored (issue #981). */
export interface WorkerCliRateLimit {
	workerId: string;
	cli: AgentCli;
	/** When the limit is expected back — the record is live until this instant. */
	expiresAt: Date;
	/** When the deferral that recorded it was observed. */
	observedAt: Date;
	/** The CLI's verbatim reset text, for an operator — never parsed back. */
	resetHint: string | null;
}

/**
 * Record the cool-down for one `(worker, CLI)` pair — **last observation wins**.
 *
 * A re-record replaces the row rather than extending or merging it: the newest
 * deferral is the best evidence about the machine's current allowance, and the
 * expiry it carries is already bounded by the shared retry policy's six-hour
 * ceiling, so nothing a bad observation writes can outlive that. Two CLIs on one
 * machine are two rows, and two machines on one CLI are two rows — the key is the
 * pair (the lesson of issue #703, which `cli_quotas` learned the hard way).
 */
export async function recordWorkerCliRateLimit(input: {
	workerId: string;
	cli: AgentCli;
	expiresAt: Date;
	observedAt: Date;
	resetHint?: string;
}): Promise<void> {
	const resetHint = input.resetHint ?? null;
	await getDb()
		.insert(workerCliRateLimits)
		.values({
			workerId: input.workerId,
			cli: input.cli,
			expiresAt: input.expiresAt,
			observedAt: input.observedAt,
			resetHint,
			updatedAt: new Date(),
		})
		.onConflictDoUpdate({
			target: [workerCliRateLimits.workerId, workerCliRateLimits.cli],
			set: {
				expiresAt: input.expiresAt,
				observedAt: input.observedAt,
				resetHint,
				updatedAt: new Date(),
			},
		});
}

/**
 * Every **live** cool-down (`expires_at > asOf`) held by the given workers, as
 * `workerId → (cli → expiresAt)` — the shape the dispatch gate's per-candidate
 * lookup wants, resolved in one batched query rather than one per worker.
 *
 * An expired row is simply not returned, which is what makes the record
 * self-releasing and why no sweeper exists: a lapsed row is invisible to every
 * reader and is overwritten by the next observation. An empty `workerIds` answers
 * an empty map without touching the database (`inArray` on `[]` is a footgun).
 */
export async function listActiveWorkerCliRateLimits(
	workerIds: string[],
	asOf: Date = new Date(),
): Promise<Map<string, Map<AgentCli, Date>>> {
	const byWorker = new Map<string, Map<AgentCli, Date>>();
	if (workerIds.length === 0) return byWorker;
	const rows = await getDb()
		.select({
			workerId: workerCliRateLimits.workerId,
			cli: workerCliRateLimits.cli,
			expiresAt: workerCliRateLimits.expiresAt,
		})
		.from(workerCliRateLimits)
		.where(
			and(
				inArray(workerCliRateLimits.workerId, workerIds),
				gt(workerCliRateLimits.expiresAt, asOf),
			),
		);
	for (const row of rows) {
		const clis = byWorker.get(row.workerId) ?? new Map<AgentCli, Date>();
		clis.set(row.cli as AgentCli, row.expiresAt);
		byWorker.set(row.workerId, clis);
	}
	return byWorker;
}

/**
 * The same **live** cool-downs as {@link listActiveWorkerCliRateLimits}, as whole
 * rows grouped by worker — the read-model sibling of the gate's map (issue #988).
 *
 * Two shapes rather than one because the two callers want different facts. The
 * gate asks "may this pairing run right now?" and needs nothing but the expiry,
 * while an operator surface has to *say* which CLI, since when it was observed, and
 * what the CLI's own reset text said — none of which a `(cli → expiresAt)` map
 * carries. Grouped-and-batched for the same reason the gate's read is: the Workers
 * roster asks for a whole fleet at once, and a per-row query there is an N+1 on a
 * screen that polls.
 *
 * The same self-releasing filter applies: an expired row is simply not returned,
 * and an empty `workerIds` answers an empty map without touching the database.
 * Rows are ordered by CLI so a rendered list is stable between polls.
 */
export async function listActiveCliRateLimitsForWorkers(
	workerIds: string[],
	asOf: Date = new Date(),
): Promise<Map<string, WorkerCliRateLimit[]>> {
	const byWorker = new Map<string, WorkerCliRateLimit[]>();
	if (workerIds.length === 0) return byWorker;
	const rows = await getDb()
		.select()
		.from(workerCliRateLimits)
		.where(
			and(
				inArray(workerCliRateLimits.workerId, workerIds),
				gt(workerCliRateLimits.expiresAt, asOf),
			),
		)
		.orderBy(asc(workerCliRateLimits.cli));
	for (const row of rows) {
		const limits = byWorker.get(row.workerId) ?? [];
		limits.push({
			workerId: row.workerId,
			cli: row.cli as AgentCli,
			expiresAt: row.expiresAt,
			observedAt: row.observedAt,
			resetHint: row.resetHint,
		});
		byWorker.set(row.workerId, limits);
	}
	return byWorker;
}

/**
 * One machine's **live** cool-downs, newest-observation-per-CLI as stored — the
 * single-worker sibling of {@link listActiveCliRateLimitsForWorkers}, for the
 * detail read that already knows which machine it is about (issue #988).
 *
 * An empty array means the machine is cooling on nothing, which is the same answer
 * as "never hit a limit" and deliberately so: the record is self-releasing, so
 * there is no third state for a surface to distinguish.
 */
export async function listActiveCliRateLimitsForWorker(
	workerId: string,
	asOf: Date = new Date(),
): Promise<WorkerCliRateLimit[]> {
	const byWorker = await listActiveCliRateLimitsForWorkers([workerId], asOf);
	return byWorker.get(workerId) ?? [];
}
