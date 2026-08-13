import { getAllCliQuotas, upsertCliQuota } from '../../db/repositories/cliQuotasRepository.js';
import { discoverCliQuotas, discoveryHost } from '../../harness/quota-discovery.js';
import { authedProcedure, router } from '../trpc.js';

/**
 * tRPC router for CLI quotas and capabilities (issue #164).
 *
 * Exposes queries to read the persisted quota snapshots and mutations to trigger
 * manual quota refreshes.
 */
export const quotaRouter = router({
	/**
	 * Get every persisted capability and quota snapshot, each attributed to the
	 * host it describes (issue #703).
	 */
	getQuotas: authedProcedure.query(async () => {
		return await getAllCliQuotas();
	}),

	/**
	 * Run full capability discovery and live quota queries on **this** host,
	 * persist the results against it, and return the fresh snapshots.
	 */
	refreshQuotas: authedProcedure.mutation(async () => {
		const host = discoveryHost();
		const snapshots = await discoverCliQuotas(false); // cheap = false for manual refresh
		for (const snapshot of snapshots) {
			await upsertCliQuota(host, snapshot.cli, snapshot.status, snapshot);
		}
		return snapshots;
	}),
});
