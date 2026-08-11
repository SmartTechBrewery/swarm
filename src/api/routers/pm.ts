import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { MissingPmCredentialError } from '../../config/provider.js';
import type { ProjectConfig } from '../../config/schema.js';
import { getProjectByIdFromDb } from '../../db/repositories/projectsRepository.js';
import type { PMProviderManifest } from '../../integrations/pm/manifest.js';
import { getPMProvider, listPMProviders } from '../../integrations/pm/registry.js';
import { PmProviderIdSchema } from '../../pm/events.js';
import type { PMDiscoveryCapability, PMProvider, PMType } from '../../pm/types.js';
import { assertProjectAccess } from '../authz.js';
import { authedProcedure, router } from '../trpc.js';

/** A provider guaranteed to implement discovery (the optional method is present). */
type DiscoveringProvider = PMProvider & { discover: NonNullable<PMProvider['discover']> };

/**
 * Project-scoped PM discovery API — backs the Project Management screen's provider/
 * board/status pickers (issue #201). It dispatches through the registered PM
 * manifest (`getPMProvider` → `createProvider` → `PMProvider.discover`) rather
 * than importing GitHub Projects directly, so a second provider drops in behind
 * the same procedures with no change here (ai/RULES.md §2, ai/CODING_STANDARDS.md
 * "Module shape for a provider").
 *
 * Discovery runs on the **project's own PM credential** (the roles its provider
 * declares under `credentials.pm`, resolved from the encrypted secret store —
 * issue #537), not on a worker-local SCM identity: the browser never supplies a
 * token, and the API host needs no `SWARM_OPERATOR_GH_TOKEN` to map a board. A
 * resolved board catalogue is still a privileged read of the provider account, so
 * every procedure requires `projectAdmin` (the same boundary as editing config);
 * a non-member gets NOT_FOUND, so a private project's existence never leaks.
 *
 * **A request may name a provider the project is not persisted on** (issue #641), which
 * is what lets the dashboard's provider switch pick the *incoming* board before the
 * switch is saved. Omitting `providerId` keeps today's behaviour exactly — the
 * persisted `project.pm.type` — and supplying one never falls back to it (see
 * {@link projectForDiscovery} for the projection, and `credentials.listPm`/`setPm` for
 * the credentials the same flow enters first).
 */

/**
 * Resolve the project and build a PM provider after authorizing the caller.
 * Requires `projectAdmin`: discovery runs with the project's PM credential and
 * exposes the provider account's board catalogue. Verifies the requested
 * capability is one the resolved provider declares, so an unknown provider or
 * unsupported capability fails with a clear code instead of a raw dispatch error.
 *
 * `providerId` defaults to the persisted `project.pm.type`. An id nothing is registered
 * for is NOT_FOUND naming *what was asked for* — never a fallback to the persisted
 * provider, which would silently discover the wrong board's contents.
 */
async function resolveProviderForDiscovery(
	user: Parameters<typeof assertProjectAccess>[0],
	projectId: string,
	capability: PMDiscoveryCapability,
	providerId: PMType | undefined,
	discoveryDraft: Record<string, string> | undefined,
): Promise<DiscoveringProvider> {
	await assertProjectAccess(user, projectId, 'projectAdmin');
	const project = await getProjectByIdFromDb(projectId);
	if (!project) {
		throw new TRPCError({
			code: 'NOT_FOUND',
			message: `Project with ID "${projectId}" not found`,
		});
	}
	const requestedId = providerId ?? project.pm.type;
	const manifest = getPMProvider(requestedId);
	if (!manifest) {
		throw new TRPCError({
			code: 'NOT_FOUND',
			message: `No PM provider registered for '${requestedId}'`,
		});
	}
	// The manifest declaring a capability and the provider implementing `discover` must
	// agree; guard both so a misdeclared manifest fails clearly rather than throwing a
	// raw "not a function" (and so TypeScript narrows the optional method). The
	// *declaration* is checked first, before anything is built or projected, so a
	// provider offering no discovery at all answers NOT_IMPLEMENTED whatever else its
	// blank member is missing.
	if (!manifest.discovery.includes(capability)) throw unsupportedDiscovery(manifest, capability);
	const provider = manifest.createProvider(projectForDiscovery(project, manifest, discoveryDraft));
	if (!provider.discover) throw unsupportedDiscovery(manifest, capability);
	return provider as DiscoveringProvider;
}

function unsupportedDiscovery(
	manifest: PMProviderManifest,
	capability: PMDiscoveryCapability,
): TRPCError {
	return new TRPCError({
		code: 'NOT_IMPLEMENTED',
		message: `Provider '${manifest.id}' does not support '${capability}' discovery`,
	});
}

/**
 * The project a discovery call runs against: the real one when it is already on this
 * provider, else a **projection** of it whose `pm` is the provider's own mapping-free
 * member (`PMProviderManifest.blankPm`, issue #641).
 *
 * Nothing is written and nothing else is replaced, which is what makes the projection
 * safe: the provider still resolves credentials through the project's own
 * `credentials.pm[<providerId>]` block (`resolvePmCredential` reads `pm.type`, which the
 * projection sets to this provider), so the incoming provider authenticates as itself
 * and the browser still never handles a secret. The blank member comes off the manifest
 * as data rather than being assembled here, so this branches on *whether* the persisted
 * provider was asked for, never on which provider it is (ai/RULES.md §2).
 *
 * A provider whose blank member cannot support discovery at all says so on its manifest
 * and is refused here, before a call is made: `PRECONDITION_FAILED` carrying the
 * provider's own copy, so an operator reads what to set and where instead of an opaque
 * transport failure (Jira's site URL is the case — `src/integrations/pm/jira/index.ts`).
 */
function projectForDiscovery(
	project: ProjectConfig,
	manifest: PMProviderManifest,
	discoveryDraft: Record<string, string> | undefined,
): ProjectConfig {
	if (manifest.discoveryDraft) {
		const parsed = manifest.discoveryDraft.schema.safeParse(discoveryDraft ?? {});
		if (parsed.success) return { ...project, pm: manifest.discoveryDraft.buildPm(parsed.data) };
	}
	if (manifest.id === project.pm.type) return project;
	if (manifest.blankPmDiscoveryBlocker) {
		throw new TRPCError({
			code: 'PRECONDITION_FAILED',
			message: manifest.blankPmDiscoveryBlocker,
		});
	}
	return { ...project, pm: manifest.blankPm };
}

/**
 * Run a discovery call and translate a failure into a safe, actionable tRPC
 * error.
 *
 * The one case worth distinguishing is a PM credential the project hasn't
 * configured — the most common setup gap, and the one the dashboard can offer a fix
 * for. It arrives as a typed `MissingPmCredentialError` (`src/config/provider.ts`),
 * so this recognizes the *condition* rather than pattern-matching a message, and
 * answers `PRECONDITION_FAILED` naming the role to configure. Everything else
 * (board didn't resolve, no Status field, a token missing `read:org`) surfaces the
 * provider's own message, which the provider writes to be actionable and
 * secret-free — GitHub API errors never carry the credential, and nothing here
 * echoes a credential value.
 */
async function runDiscovery<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof MissingPmCredentialError) {
			throw new TRPCError({
				code: 'PRECONDITION_FAILED',
				message:
					`No ${err.label} is configured for this project. Add it under Project Management → ` +
					`Credentials (file-based config: set credentials.pm.${err.providerId}.${err.role}, whose conventional ` +
					`environment key is ${err.envVarKey}), then try again.`,
			});
		}
		throw new TRPCError({
			code: 'BAD_REQUEST',
			message: err instanceof Error ? err.message : String(err),
		});
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
				discoveryDraft: m.discoveryDraft?.fields ?? [],
			}));
		}),

	/**
	 * Discover the selectable boards for a PM provider — the project's own, or the
	 * `providerId` a pending switch names (issue #641).
	 */
	discoverContainers: authedProcedure
		.input(
			z.object({
				projectId: z.string().min(1),
				providerId: PmProviderIdSchema.optional(),
				discoveryDraft: z.record(z.string(), z.string()).optional(),
			}),
		)
		.query(async ({ ctx, input }) => {
			const provider = await resolveProviderForDiscovery(
				ctx.user,
				input.projectId,
				'containers',
				input.providerId,
				input.discoveryDraft,
			);
			return runDiscovery(() => provider.discover('containers', {}));
		}),

	/** Discover a selected board's workflow states (its mappable columns/statuses). */
	discoverStates: authedProcedure
		.input(
			z.object({
				projectId: z.string().min(1),
				containerId: z.string().min(1),
				providerId: PmProviderIdSchema.optional(),
				discoveryDraft: z.record(z.string(), z.string()).optional(),
			}),
		)
		.query(async ({ ctx, input }) => {
			const provider = await resolveProviderForDiscovery(
				ctx.user,
				input.projectId,
				'states',
				input.providerId,
				input.discoveryDraft,
			);
			return runDiscovery(() => provider.discover('states', { containerId: input.containerId }));
		}),
});
