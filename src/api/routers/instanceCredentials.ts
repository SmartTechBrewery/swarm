import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
	deleteInstanceScmCredential,
	listConfiguredInstanceScmCredentials,
	writeInstanceScmCredential,
} from '../../db/repositories/instanceCredentialsRepository.js';
import { isInstanceAdmin, type SwarmUser } from '../../identity/schema.js';
import { isRuntimeReadySCMProvider } from '../../integrations/scm/manifest.js';
import {
	getSCMProvider,
	type InstanceDefaultScmRole,
	listInstanceDefaultScmRoles,
} from '../../integrations/scm/registry.js';
import { authedProcedure, router } from '../trpc.js';

/**
 * Instance-level **default** SCM credentials API — nested into `settingsRouter` as
 * `settings.credentials` (issue #769), the read/write surface behind General Settings →
 * **Credentials**.
 *
 * One value per `(provider, role)` slot the provider declares eligible
 * (`ScmCredentialRoleSpec.instanceDefault` — today exactly GitHub's `reviewer`), stored
 * encrypted in `instance_scm_credentials`. Its own table rather than a key in the
 * `app_settings` blob, because `settings.get` returns that whole object to any
 * authenticated caller and a secret there would be echoed back verbatim.
 *
 * **This value is a creation-time seed only.** Nothing here is consulted by
 * `resolveScmCredentialOrNull` / `requireScmCredential` (`src/config/provider.ts`) —
 * their no-fallback-chain rule is untouched — and setting or clearing a default has no
 * effect on any existing project, whose own credential stays editable on its Source
 * Control tab. Copying the default into a *new* project's own row at creation is phase
 * 2/2.
 *
 * **Authorization is enforced here, not on the screen.** Every procedure, reads
 * included, is instance-administrator only. That is the difference from the `agents`
 * tab, whose admin-only-ness is a screen-level visibility boundary
 * (`INSTANCE_ADMIN_ONLY_TABS`, `dashboard/src/lib/settings-nav.ts`) with the router
 * unchanged: a secret must not be writable — nor its configured/not-configured state
 * readable — by any authenticated user just because a tab is hidden.
 *
 * No procedure returns plaintext, and none returns a masked echo of a stored value
 * either: `list` reports configured/not-configured state alone.
 */

/**
 * Throw unless `user` administers the installation.
 *
 * A local guard rather than `assertInstanceAdmin` (`../authz.ts`): that helper's copy is
 * worded for a read-only installation *view* ("Open a project you are enrolled in to see
 * its …"), which misdescribes a credential write. `FORBIDDEN`, not `NOT_FOUND`, for that
 * helper's own reason — there is no project existence to hide here, only a fixed
 * installation-wide surface.
 */
function assertInstanceCredentialAdmin(user: SwarmUser): void {
	if (isInstanceAdmin(user)) return;
	throw new TRPCError({
		code: 'FORBIDDEN',
		message: 'Instance-level default credentials are managed by instance administrators only.',
	});
}

/**
 * The eligible `(provider, role)` pair a write names, validated against the *registered*
 * manifests — the shape `requireScmRoleSpec` (`./credentials.ts`) already uses, and its
 * two distinct answers:
 *
 * - a provider nothing **runtime-ready** is registered for is `NOT_FOUND` (nothing can
 *   serve it, so there is no slot to configure — `runtimeReadyScmProvider`'s reason);
 * - a role that provider does not declare, or declares *without* `instanceDefault`, is a
 *   `BAD_REQUEST` naming the role. A registered, runtime-ready provider that simply has
 *   not opted in lands here rather than in the `NOT_FOUND` above, because the honest
 *   answer is about the role and not about the provider's existence.
 *
 * The client picked both off {@link list}, so either mismatch means the manifests changed
 * under it.
 */
function requireInstanceDefaultRole(providerId: string, role: string): InstanceDefaultScmRole {
	const manifest = getSCMProvider(providerId);
	if (!manifest || !isRuntimeReadySCMProvider(manifest)) {
		throw new TRPCError({
			code: 'NOT_FOUND',
			message: `No runtime-ready SCM provider is registered for '${providerId}'`,
		});
	}
	const spec = manifest.credentialRoles.find(
		(candidate) => candidate.role === role && candidate.instanceDefault === true,
	);
	if (!spec) {
		throw new TRPCError({
			code: 'BAD_REQUEST',
			message: `SCM provider '${manifest.id}' declares no instance-level default for credential role '${role}'`,
		});
	}
	return {
		providerId: manifest.id,
		providerLabel: manifest.label,
		role: spec.role,
		envVarKey: spec.envVarKey,
	};
}

export const instanceCredentialsRouter = router({
	/**
	 * Every `(provider, role)` slot eligible for an instance-level default, each with
	 * whether one is currently stored — the data the Credentials tab renders its fields
	 * from.
	 *
	 * Deliberately no masked preview: unlike the project panel there is no legacy
	 * masked-value contract to honour here, and `maskedPreview` in the dashboard already
	 * discards the server's string. So the response carries no plaintext and no substring
	 * of one, only configured/not-configured state.
	 */
	list: authedProcedure.query(async ({ ctx }) => {
		assertInstanceCredentialAdmin(ctx.user);
		const configured = await listConfiguredInstanceScmCredentials();
		const isConfigured = new Set(configured.map((row) => `${row.providerId}:${row.role}`));

		return {
			roles: listInstanceDefaultScmRoles().map((eligible) => ({
				providerId: eligible.providerId,
				providerLabel: eligible.providerLabel,
				role: eligible.role,
				/**
				 * The provider's conventional key for the role — and at this tier it really *is*
				 * the key: an instance default has no project and therefore no reference
				 * indirection to resolve, so there is no `referenceKey` to show instead.
				 */
				envVarKey: eligible.envVarKey,
				isConfigured: isConfigured.has(`${eligible.providerId}:${eligible.role}`),
			})),
		};
	}),

	/**
	 * Record (or rotate) the installation's default for one eligible slot. The plaintext
	 * is written straight to the encrypted store and never read back.
	 */
	set: authedProcedure
		.input(
			z.object({
				providerId: z.string().min(1),
				role: z.string().min(1),
				value: z.string().min(1),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			assertInstanceCredentialAdmin(ctx.user);
			const eligible = requireInstanceDefaultRole(input.providerId, input.role);
			await writeInstanceScmCredential(eligible.providerId, eligible.role, input.value);
		}),

	/**
	 * Clear the installation's default for one eligible slot. No project loses a
	 * credential: nothing resolves through this value, so clearing it only stops a future
	 * project from being seeded with it.
	 */
	delete: authedProcedure
		.input(z.object({ providerId: z.string().min(1), role: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			assertInstanceCredentialAdmin(ctx.user);
			const eligible = requireInstanceDefaultRole(input.providerId, input.role);
			await deleteInstanceScmCredential(eligible.providerId, eligible.role);
		}),
});
