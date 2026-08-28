import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
	listWorkerScmCredentialStates,
	writeWorkerScmCredential,
} from '../../db/repositories/workerScmCredentialsRepository.js';
import { listWorkerScmProviders } from '../../identity/worker-scm-credential.js';
import { isRuntimeReadySCMProvider } from '../../integrations/scm/manifest.js';
import { getSCMProvider } from '../../integrations/scm/registry.js';
import type { ScmType } from '../../scm/types.js';
import { verifyScmCredentialSecret } from '../scm-verification.js';
import { authedProcedure, router } from '../trpc.js';
import { resolveStrictlyOwnedWorker } from '../worker-access.js';

/**
 * The worker operator's **own** SCM credential, as a dashboard write surface —
 * nested into `workersRouter` as `workers.scmCredentials` (issue #766, phase 2/3 of
 * retiring `SWARM_OPERATOR_GH_TOKEN`). The second write path onto the store phase
 * 1/3 built (`worker_scm_credentials`), beside `swarm workers set-scm-credential`.
 *
 * Two invariants hold for every procedure here:
 *
 * - **Strict ownership, reads included.** An `instanceAdmin` who does not own the
 *   worker gets the same `NOT_FOUND` a stranger does — no layer-1 override, the rule
 *   `workers.rename`/`setConsent`/`updateConstraints` already apply to the machine
 *   owner's own calls about their own machine. It covers `list` too, on
 *   `instanceCredentials.ts`'s precedent: configured/not-configured state is itself
 *   protected, not just the secret. The administrator's path to another operator's
 *   worker stays the CLI.
 * - **No plaintext and no masked echo, ever.** `list` reports presence and a
 *   last-updated timestamp; nothing here returns a stored value or any substring of
 *   one, so the dashboard supports "replace" and never "reveal". The one login a
 *   `set` returns is resolved from the value just pasted, is not persisted, and
 *   never appears in `list`.
 *
 * Nothing here touches dispatch. `src/router/dispatcher.ts` resolves the credential
 * per dispatch, so a value saved here takes effect on the next phase with no worker
 * restart — that property comes from phase 1/3 and needs no mechanism of its own.
 */

/**
 * One slot the form renders a field for. Exported because it names part of the
 * router's inferred output type, which the tRPC client's own types then reference.
 */
export interface WorkerScmCredentialSlot {
	providerId: ScmType;
	providerLabel: string;
	isConfigured: boolean;
	/** When the stored value was last written, ISO, or `null` when none is stored. */
	updatedAt: string | null;
}

/**
 * The manifest a write names, validated against the **registry** rather than against
 * the slot list {@link list} returned — so an enrollment created between a client's
 * `list` and its `set` cannot lose a legitimate write to a race.
 *
 * A provider nothing runtime-ready is registered for is `NOT_FOUND`, reusing the
 * wording `credentials.ts` / `instanceCredentials.ts` already use: no project may
 * route to such a provider, so no worker can need a credential for it.
 */
function requireRuntimeReadyProvider(providerId: string): { id: ScmType; label: string } {
	const manifest = getSCMProvider(providerId);
	if (!manifest || !isRuntimeReadySCMProvider(manifest)) {
		throw new TRPCError({
			code: 'NOT_FOUND',
			message: `No runtime-ready SCM provider is registered for '${providerId}'`,
		});
	}
	return { id: manifest.id, label: manifest.label };
}

export const workerScmCredentialsRouter = router({
	/**
	 * The provider slots this worker's owner should hold a credential for, each with
	 * whether one is stored and when it was last written.
	 *
	 * The slots are the providers the worker's *enrollments* resolve to
	 * ({@link listWorkerScmProviders} — every enrollment, so a `pending` one counts),
	 * unioned with the providers a value is already stored for. That union is what
	 * keeps a credential visible and rotatable after the enrollment that motivated it
	 * went away, instead of leaving stored state with no surface to change it on.
	 *
	 * A provider whose manifest is missing or not runtime-ready is dropped from either
	 * source, for `runtimeReadyScmProvider`'s reason (`./credentials.ts`): offering a
	 * slot nothing can serve would only invite an operator to configure something no
	 * dispatch could use.
	 */
	list: authedProcedure
		.input(z.object({ workerId: z.string().uuid() }))
		.query(async ({ ctx, input }) => {
			await resolveStrictlyOwnedWorker(ctx.user, input.workerId);

			const stored = new Map(
				(await listWorkerScmCredentialStates(input.workerId)).map((row) => [
					row.scmProviderId,
					row.updatedAt,
				]),
			);
			// Needed providers first, then any provider that only holds a stored value.
			const providerIds = await listWorkerScmProviders(input.workerId);
			for (const storedProviderId of stored.keys()) {
				if (!providerIds.some((providerId) => providerId === storedProviderId)) {
					const manifest = getSCMProvider(storedProviderId);
					if (manifest) providerIds.push(manifest.id);
				}
			}

			const providers: WorkerScmCredentialSlot[] = [];
			for (const providerId of providerIds) {
				const manifest = getSCMProvider(providerId);
				if (!manifest || !isRuntimeReadySCMProvider(manifest)) continue;
				const updatedAt = stored.get(manifest.id);
				providers.push({
					providerId: manifest.id,
					// The registry's own label, so the browser never has to name a provider.
					providerLabel: manifest.label,
					isConfigured: updatedAt !== undefined,
					updatedAt: updatedAt?.toISOString() ?? null,
				});
			}
			return { providers };
		}),

	/**
	 * Set — or rotate, which is the same write — this worker's operator credential for
	 * one provider.
	 *
	 * The value is **verified against the provider before it is stored**, and a value
	 * that resolves to no account is rejected with nothing written: the acceptance
	 * criteria's "clear rejection message rather than a silent store-then-fail-at-
	 * dispatch-time". Known limitation, inherited from the `scm.verify…` procedures
	 * this shares its lookup with (`../scm-verification.ts`): the provider identity
	 * lookups swallow a transport failure to `null`, so an unreachable provider reads
	 * as an invalid credential. Failing closed is the right side to err on for a write
	 * — storing on an inconclusive check is exactly what the criteria rule out.
	 *
	 * Returns the login the secret resolved to, so the form can confirm the account
	 * this machine will commit, push and comment as. It is not persisted.
	 */
	set: authedProcedure
		.input(
			z.object({
				workerId: z.string().uuid(),
				providerId: z.string().min(1),
				value: z.string().min(1),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await resolveStrictlyOwnedWorker(ctx.user, input.workerId);
			const provider = requireRuntimeReadyProvider(input.providerId);

			const verification = await verifyScmCredentialSecret(provider.id, input.value);
			if (!verification.valid) {
				throw new TRPCError({
					code: 'BAD_REQUEST',
					message:
						`That credential did not resolve to a ${provider.label} account, so nothing was ` +
						'stored. Check the value and try again — an unreachable provider looks the same ' +
						'as an invalid credential here, deliberately.',
				});
			}

			await writeWorkerScmCredential(input.workerId, provider.id, input.value);
			return { login: verification.login };
		}),
});
