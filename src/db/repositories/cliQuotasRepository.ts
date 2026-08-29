import { eq } from 'drizzle-orm';

import type { AgentCli } from '../../harness/agent-cli.js';
import type { CliQuotaSnapshot } from '../../harness/quota.js';
import { getDb } from '../client.js';
import { cliQuotas } from '../schema/cliQuotas.js';
import { workers } from '../schema/workers.js';

/**
 * A stored snapshot together with the worker whose machine it describes
 * (issue #703, re-keyed onto the worker by issue #823).
 *
 * The attribution is attached here, at the persistence boundary, rather than
 * inside {@link CliQuotaSnapshot}: that type is discovery's output, and discovery
 * does not own the storage key. The snapshot's own fields stay top-level so every
 * reader keeps reading `cli`/`status`/`windows` exactly as before.
 */
export type WorkerCliQuotaSnapshot = CliQuotaSnapshot & { workerId: string; workerName: string };

/**
 * Every persisted CLI quota snapshot belonging to **one owner's** workers, each
 * attributed to the worker it describes, ordered by worker display name then CLI.
 *
 * The ownership filter lives here, in the only read, rather than in the caller —
 * there is deliberately no `getAllCliQuotas` successor, so a future caller cannot
 * reach for an unscoped read and re-open the leak issue #823 closed. An owner with
 * no worker, or a worker that has not reported, reads `[]`.
 *
 * The columns are selected explicitly so the join keeps the worker's other
 * columns — `credential_hash` above all — out of the projection.
 */
export async function listCliQuotasForOwner(
	ownerUserId: string,
): Promise<WorkerCliQuotaSnapshot[]> {
	const rows = await getDb()
		.select({
			workerId: cliQuotas.workerId,
			workerName: workers.displayName,
			snapshot: cliQuotas.snapshot,
		})
		.from(cliQuotas)
		.innerJoin(workers, eq(cliQuotas.workerId, workers.id))
		.where(eq(workers.ownerUserId, ownerUserId))
		.orderBy(workers.displayName, cliQuotas.cli);
	return rows.map((r) => ({ ...r.snapshot, workerId: r.workerId, workerName: r.workerName }));
}

/**
 * Upsert one worker's snapshot for one CLI. Two workers reporting the same `cli`
 * are two rows; a re-report from one worker replaces only that worker's row.
 */
export async function upsertCliQuota(
	workerId: string,
	cli: AgentCli,
	status: 'available' | 'unavailable' | 'error',
	snapshot: CliQuotaSnapshot,
): Promise<void> {
	await getDb()
		.insert(cliQuotas)
		.values({
			workerId,
			cli,
			status,
			snapshot,
			updatedAt: new Date(),
		})
		.onConflictDoUpdate({
			target: [cliQuotas.workerId, cliQuotas.cli],
			set: {
				status,
				snapshot,
				updatedAt: new Date(),
			},
		});
}
