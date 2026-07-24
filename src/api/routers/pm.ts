import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { getProjectByIdFromDb } from '../../db/repositories/projectsRepository.js';
import { getPMProvider, listPMProviders } from '../../integrations/pm/registry.js';
import type { PMDiscoveryCapability, PMProvider } from '../../pm/types.js';
import { assertProjectAccess } from '../authz.js';
import { authedProcedure, router } from '../trpc.js';

/** A provider guaranteed to implement discovery (the optional method is present). */
type DiscoveringProvider = PMProvider & { discover: NonNullable<PMProvider['discover']> };

/**
 * Project-scoped PM discovery API — backs the Board Mapping screen's provider/
 * board/status pickers (issue #201). It dispatches through the registered PM
 * manifest (`getPMProvider` → `createProvider` → `PMProvider.discover`) rather
 * than importing GitHub Projects directly, so a second provider drops in behind
 * the same procedures with no change here (ai/RULES.md §2, ai/CODING_STANDARDS.md
 * "Module shape for a provider").
 *
 * Discovery uses the implementer persona's token (the worker-local operator
 * token, `SWARM_OPERATOR_GH_TOKEN` — issue #396) — the browser never supplies a
 * token, and a resolved board catalogue is a privileged read of the provider
 * account, so every procedure requires `projectAdmin` (the same boundary as
 * editing config). A non-member gets NOT_FOUND, so a private project's existence
 * never leaks. This resolves server-side, so the API process must have the
 * operator token in its host env.
 */

/**
 * Resolve the project and build its PM provider after authorizing the caller.
 * Requires `projectAdmin`: discovery runs with the implementer (operator) token
 * and exposes the provider account's board catalogue. Verifies the requested
 * capability is one the project's provider declares, so an unknown provider or
 * unsupported capability fails with a clear code instead of a raw dispatch error.
 */
async function resolveProviderForDiscovery(
	user: Parameters<typeof assertProjectAccess>[0],
	projectId: string,
	capability: PMDiscoveryCapability,
): Promise<DiscoveringProvider> {
	await assertProjectAccess(user, projectId, 'projectAdmin');
	const project = await getProjectByIdFromDb(projectId);
	if (!project) {
		throw new TRPCError({
			code: 'NOT_FOUND',
			message: `Project with ID "${projectId}" not found`,
		});
	}
	const manifest = getPMProvider(project.pm.type);
	if (!manifest) {
		throw new TRPCError({
			code: 'NOT_FOUND',
			message: `No PM provider registered for '${project.pm.type}'`,
		});
	}
	const provider = manifest.createProvider(project);
	// The manifest declaring a capability and the provider implementing `discover`
	// must agree; guard both so a misdeclared manifest fails clearly rather than
	// throwing a raw "not a function" (and so TypeScript narrows the optional method).
	if (!manifest.discovery.includes(capability) || !provider.discover) {
		throw new TRPCError({
			code: 'NOT_IMPLEMENTED',
			message: `Provider '${manifest.id}' does not support '${capability}' discovery`,
		});
	}
	return provider as DiscoveringProvider;
}

/**
 * Run a discovery call and translate a failure into a safe, actionable tRPC
 * error. A missing implementer (operator) token — the most common setup gap —
 * points the operator at setting `SWARM_OPERATOR_GH_TOKEN` in the host env; a
 * provider/actionable error (board didn't resolve, no Status field) surfaces its
 * message — those are secret-free by construction, and GitHub API errors never
 * carry the token. Nothing here echoes a credential value.
 */
async function runDiscovery<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (/no github .+ token configured/i.test(message)) {
			throw new TRPCError({
				code: 'PRECONDITION_FAILED',
				message:
					"No implementer token is configured. Set SWARM_OPERATOR_GH_TOKEN in this host's environment, then try again.",
			});
		}
		throw new TRPCError({ code: 'BAD_REQUEST', message });
	}
}

export const pmRouter = router({
	/**
	 * The registered PM providers' identity + declared discovery capabilities —
	 * enough for the mapping screen's provider selector to render data-driven
	 * choices without importing a concrete provider.
	 */
	listProviders: authedProcedure
		.input(z.object({ projectId: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			await assertProjectAccess(ctx.user, input.projectId, 'projectAdmin');
			return listPMProviders().map((m) => ({
				id: m.id,
				label: m.label,
				discovery: [...m.discovery],
			}));
		}),

	/** Discover the selectable boards for a project's configured PM provider. */
	discoverContainers: authedProcedure
		.input(z.object({ projectId: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			const provider = await resolveProviderForDiscovery(ctx.user, input.projectId, 'containers');
			return runDiscovery(() => provider.discover('containers', {}));
		}),

	/** Discover a selected board's workflow states (its mappable columns/statuses). */
	discoverStates: authedProcedure
		.input(z.object({ projectId: z.string().min(1), containerId: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			const provider = await resolveProviderForDiscovery(ctx.user, input.projectId, 'states');
			return runDiscovery(() => provider.discover('states', { containerId: input.containerId }));
		}),
});
