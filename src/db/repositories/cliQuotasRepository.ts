import type { AgentCli } from '../../harness/agent-cli.js';
import type { CliQuotaSnapshot } from '../../harness/quota.js';
import { getDb } from '../client.js';
import { cliQuotas } from '../schema/cliQuotas.js';

/**
 * A stored snapshot together with the machine it describes (issue #703).
 *
 * The host is attached here, at the persistence boundary, rather than inside
 * {@link CliQuotaSnapshot}: that type is discovery's output, and discovery does
 * not own the storage key. The snapshot's own fields stay top-level so every
 * reader keeps reading `cli`/`status`/`windows` exactly as before.
 */
export type HostCliQuotaSnapshot = CliQuotaSnapshot & { host: string };

/**
 * Get every persisted CLI quota snapshot, each attributed to the host that
 * discovered it, ordered by `(host, cli)`.
 */
export async function getAllCliQuotas(): Promise<HostCliQuotaSnapshot[]> {
	const rows = await getDb().select().from(cliQuotas).orderBy(cliQuotas.host, cliQuotas.cli);
	return rows.map((r) => ({ ...r.snapshot, host: r.host }));
}

/**
 * Upsert one host's snapshot for one CLI. Two hosts reporting the same `cli`
 * are two rows; a re-run on one host replaces only that host's row.
 */
export async function upsertCliQuota(
	host: string,
	cli: AgentCli,
	status: 'available' | 'unavailable' | 'error',
	snapshot: CliQuotaSnapshot,
): Promise<void> {
	await getDb()
		.insert(cliQuotas)
		.values({
			host,
			cli,
			status,
			snapshot,
			updatedAt: new Date(),
		})
		.onConflictDoUpdate({
			target: [cliQuotas.host, cliQuotas.cli],
			set: {
				status,
				snapshot,
				updatedAt: new Date(),
			},
		});
}
