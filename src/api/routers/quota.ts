import { listCliQuotasForOwner } from '../../db/repositories/cliQuotasRepository.js';
import { authedProcedure, router } from '../trpc.js';

/**
 * tRPC router for CLI quotas and capabilities (issue #164), scoped to the
 * viewer's own workers since issue #823.
 *
 * There is **no `instanceAdmin` override**, deliberately — this follows the
 * spirit of `resolveStrictlyOwnedWorker` (`src/api/worker-access.ts`) rather than
 * `resolveOwnedWorker`. A machine's allowance is a fact about that machine's
 * owner, and an admin's own machine is reached by the same filter as everyone
 * else's; administering an installation is not a reason to read someone else's
 * remaining allowance.
 *
 * There is also no refresh mutation. The one that existed probed the **API
 * server's own** host — precisely the machine whose data must stop being
 * presented as everyone's — so it was removed rather than re-pointed; a worker
 * reports its own snapshot instead (issue #823 phase 2).
 */
export const quotaRouter = router({
	/**
	 * Every stored snapshot for the workers the caller owns, each attributed to
	 * the worker it describes. A caller who owns no worker gets `[]` — an empty
	 * page, never a denial, matching the shape issue #821 chose for the runs list.
	 */
	getQuotas: authedProcedure.query(async ({ ctx }) => {
		return await listCliQuotasForOwner(ctx.user.id);
	}),
});
