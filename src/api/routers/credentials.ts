import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
	type PmProviderCredentialReferences,
	pmCredentialReferenceFor,
} from '../../config/pm-credentials.js';
import type { ProjectRecord } from '../../config/schema.js';
import {
	type ScmProviderCredentialReferences,
	scmCredentialReferenceFor,
	sharedScmCredentialProviderFor,
} from '../../config/scm-credentials.js';
import {
	deleteProjectCredential,
	resolveAllProjectCredentials,
	writeProjectCredential,
} from '../../db/repositories/credentialsRepository.js';
import {
	findProjectRecordByIdFromDb,
	upsertProjectToDb,
} from '../../db/repositories/projectsRepository.js';
import type { PmCredentialRoleSpec } from '../../integrations/pm/manifest.js';
import { getPMProvider } from '../../integrations/pm/registry.js';
import {
	isRuntimeReadySCMProvider,
	type SCMProviderManifest,
	type ScmCredentialRoleSpec,
} from '../../integrations/scm/manifest.js';
import { getSCMProvider } from '../../integrations/scm/registry.js';
import { PmProviderIdSchema } from '../../pm/events.js';
import type { PMType } from '../../pm/types.js';
import { SCM_CREDENTIAL_ROLES, type ScmType } from '../../scm/types.js';
import { assertProjectAccess } from '../authz.js';
import { authedProcedure, router } from '../trpc.js';

/**
 * Project-scoped credentials API — mirrors Cascade's `projectsRouter.credentials`
 * (`cascade/src/api/routers/projects.ts`). No procedure ever returns plaintext,
 * only a masked preview. Project-scoped authorization (#281 task 4) gates every
 * procedure via `assertProjectAccess` — SWARM's analogue of Cascade's
 * `verifyProjectOwnership`: reading a masked list needs `contributor`, while
 * writing or clearing a credential is a `projectAdmin`-only action. A non-member
 * gets NOT_FOUND (existence hidden), so the assertion also subsumes the old
 * existence check.
 *
 * Two families live here — `list`/`set`/`delete` for the **SCM** side and
 * `listPm`/`setPm`/`deletePm` for the **PM** side — and since issue #632 they have
 * the same shape: both are addressed by `(providerId, role)` and both resolve the
 * secret-store key server-side. What still differs is *who declares the roles*: an
 * SCM provider's two are named by the contract itself (`SCM_CREDENTIAL_ROLES`,
 * `src/scm/types.ts`) and only their conventional reference name is per provider,
 * while a PM provider declares its own vocabulary (an email + token, a key + token +
 * secret). Either way the manifest's `credentialRoles` is what a `list` renders from.
 *
 * **The client never names a secret-store key.** It names a provider and a role, both
 * picked off the matching `list`, and the reference key is resolved here: the
 * reference the project already configured, else the role's declared `envVarKey`. That
 * is what makes the SCM side per provider rather than one shared pair — a browser can
 * neither invent a store key nor overwrite another provider's secret by pointing a
 * role at its reference (issue #632; the pre-#632 `set` took the key itself, which is
 * exactly what let saving GitLab's reviewer token land on GitHub's row).
 *
 * **Either side's `providerId` may name a provider the project is not persisted on.** All
 * three PM procedures take it *optionally*, defaulting to `project.pm.type` (issue #641),
 * which is what lets the Project Management tab enter an *incoming* provider's
 * credentials — and then discover its boards (`src/api/routers/pm.ts`) — before a switch
 * is saved, while an omitted id keeps each procedure behaving exactly as it did before.
 * The SCM writes require the id instead (#632's reason: the browser must state which
 * provider's secret it is saving), and only `list` defaults. Supplied, the id is never
 * resolved back to the persisted provider: writing one provider's secret under another's
 * reference is the whole failure per-provider blocks exist to prevent.
 */

/**
 * Never returns plaintext or any substring of it — a configured credential
 * always collapses to the same fixed opaque marker regardless of its length,
 * so the response discloses only configured/not-configured state.
 */
function maskCredential(value: string | undefined): string {
	return isUsableSecret(value) ? '****' : 'not set';
}

/**
 * Whether a stored value is one a provider could actually authenticate with.
 * An empty row is not: `resolvePmCredential` (`src/config/provider.ts`) treats it
 * as absent and falls through, so reporting it as configured would have the panel
 * claim the credential is set while every board call answers "not configured".
 */
function isUsableSecret(value: string | undefined): boolean {
	return value !== undefined && value !== '';
}

/**
 * Load a project for a credential operation, or NOT_FOUND. The whole **record**, not
 * a repository-scoped view: every write here is a read-modify-upsert of the project
 * row, so it must carry the `repositories` list back unchanged (issue #684).
 */
async function requireProject(projectId: string): Promise<ProjectRecord> {
	const project = await findProjectRecordByIdFromDb(projectId);
	if (!project) {
		throw new TRPCError({
			code: 'NOT_FOUND',
			message: `Project with ID "${projectId}" not found`,
		});
	}
	return project;
}

/**
 * The provider a PM request addresses: the one it named, else the one the project is
 * persisted on. Naming one is what lets an operator enter the **incoming** provider's
 * credentials before a switch is saved (issue #641); omitting it keeps every procedure
 * behaving exactly as it did before.
 */
function requestedPmProviderId(project: ProjectRecord, providerId: PMType | undefined): PMType {
	return providerId ?? project.pm.type;
}

/**
 * The role spec a PM write names, validated against the *registered* manifest for the
 * provider it addresses — which since issue #641 need not be the one the project runs
 * on. An unregistered provider is NOT_FOUND and an undeclared role a BAD_REQUEST: the
 * client picked both off `listPm`, so a mismatch means the provider changed under it.
 *
 * Returns the manifest's own `id` alongside the spec (the SCM twin's shape), so callers
 * address `credentials.pm` with a validated provider id rather than the raw input — and
 * never with the persisted provider's id as a fallback, which would write the incoming
 * provider's secret over the outgoing one's reference.
 */
function requirePmRoleSpec(
	project: ProjectRecord,
	role: string,
	providerId: PMType | undefined,
): { providerId: PMType; spec: PmCredentialRoleSpec } {
	const requestedId = requestedPmProviderId(project, providerId);
	const manifest = getPMProvider(requestedId);
	if (!manifest) {
		throw new TRPCError({
			code: 'NOT_FOUND',
			message: `No PM provider registered for '${requestedId}'`,
		});
	}
	const spec = manifest.credentialRoles.find((candidate) => candidate.role === role);
	if (!spec) {
		throw new TRPCError({
			code: 'BAD_REQUEST',
			message: `PM provider '${manifest.id}' declares no credential role '${role}'`,
		});
	}
	// A role that inherits a shared SCM credential *is* that credential (declared as
	// data on the manifest — `PmCredentialRoleSpec.inheritsSharedCredential`), and its
	// declared env-var key is the shared reference itself. Writing it here would
	// silently overwrite (or clearing it would silently destroy) the Source Control
	// tab's secret under a PM-shaped label, so this refuses and says where it lives.
	// Evaluated per *named* provider since issue #641: only GitHub Projects declares
	// one, so whether a role is editable here is a property of the provider being
	// configured rather than of the one the project happens to run on.
	if (spec.inheritsSharedCredential) {
		throw new TRPCError({
			code: 'BAD_REQUEST',
			message:
				`The '${spec.role}' credential is the project's shared ${spec.inheritsSharedCredential} ` +
				'credential — configure it on the Source Control tab.',
		});
	}
	return { providerId: manifest.id, spec };
}

/**
 * The secret-store key one `(PM provider, role)` resolves through, mirroring
 * `resolvePmCredential`'s order (`src/config/provider.ts`): the reference the project
 * already configured for *that provider* (issue #631 — never another provider's block,
 * which is the overwrite this shape exists to remove), else the SCM-side reference the
 * role inherits — since issue #628 the *per-provider* one for the SCM provider this
 * project runs on — else the role's declared conventional key.
 */
function pmReferenceKeyFor(
	project: ProjectRecord,
	providerId: PMType,
	spec: PmCredentialRoleSpec,
): string {
	const configured = pmCredentialReferenceFor(project, providerId, spec.role);
	if (configured) return configured;
	if (spec.inheritsSharedCredential) {
		const inherited = scmCredentialReferenceFor(
			project,
			sharedScmCredentialProviderFor(project),
			spec.inheritsSharedCredential,
		);
		if (inherited) return inherited;
	}
	return spec.envVarKey;
}

/**
 * The registered SCM manifest for `providerId`, or `null` when nothing can serve it.
 *
 * Runtime-readiness is part of "can serve it": a manifest declaring
 * `runtimeReady: false` is registered so a provider under construction can be resolved
 * by id, and no project may route to it (`requireProjectSCMProvider`), so offering its
 * credential fields would invite an operator to configure a provider that cannot run.
 * A miss is an ordinary condition rather than a bug — the dashboard's provider
 * catalogue is a hand-kept browser list (`dashboard/src/lib/credentials.ts`) and may
 * name a provider this installation has not registered — so {@link list} reports it
 * instead of throwing.
 */
function runtimeReadyScmProvider(providerId: string): SCMProviderManifest | null {
	const manifest = getSCMProvider(providerId);
	return manifest && isRuntimeReadySCMProvider(manifest) ? manifest : null;
}

/**
 * The provider a request addresses: the one it named, else the one the project runs
 * on. `sharedScmCredentialProviderFor` is the same attribution issue #628's adoption
 * used for a project that names no provider, so the tab shows the very block such a
 * project's references were adopted into rather than an empty one.
 */
function requestedScmProviderId(project: ProjectRecord, providerId: string | undefined): string {
	return providerId ?? sharedScmCredentialProviderFor(project);
}

/**
 * The role spec an SCM write names, validated against the *registered* manifest for the
 * provider it names — the SCM twin of {@link requirePmRoleSpec}. An unserveable
 * provider is NOT_FOUND and an undeclared role a BAD_REQUEST: the client picked both
 * off {@link list}, so a mismatch means the provider changed under it.
 *
 * Returns the manifest's own `id` alongside the spec, so callers address
 * `credentials.scm` with a validated provider id rather than the raw input string.
 */
function requireScmRoleSpec(
	providerId: string,
	role: string,
): { providerId: ScmType; spec: ScmCredentialRoleSpec } {
	const manifest = runtimeReadyScmProvider(providerId);
	if (!manifest) {
		throw new TRPCError({
			code: 'NOT_FOUND',
			message: `No runtime-ready SCM provider is registered for '${providerId}'`,
		});
	}
	const spec = manifest.credentialRoles.find((candidate) => candidate.role === role);
	if (!spec) {
		throw new TRPCError({
			code: 'BAD_REQUEST',
			message: `SCM provider '${manifest.id}' declares no credential role '${role}'`,
		});
	}
	return { providerId: manifest.id, spec };
}

/**
 * The secret-store key one `(provider, role)` resolves through, mirroring
 * `resolveScmCredentialOrNull`'s order (`src/config/provider.ts`): the reference the
 * project already configured for *that provider*, else the role's declared conventional
 * key. Never another provider's reference — that fallback is the overwrite issue #632
 * exists to remove.
 */
function scmReferenceKeyFor(
	project: ProjectRecord,
	providerId: ScmType,
	spec: ScmCredentialRoleSpec,
): string {
	return scmCredentialReferenceFor(project, providerId, spec.role) ?? spec.envVarKey;
}

/**
 * Persist one provider's `role -> reference` block under `credentials.scm[providerId]`,
 * leaving every other provider's block untouched. Written through the project row (a
 * reference is config, not a secret) and only when it actually changes, so setting a
 * credential twice doesn't churn the row. A block that empties drops out entirely
 * rather than persisting as `{}`.
 */
async function updateScmReferences(
	project: ProjectRecord,
	providerId: ScmType,
	references: ScmProviderCredentialReferences,
): Promise<void> {
	const current = project.credentials.scm?.[providerId] ?? {};
	if (SCM_CREDENTIAL_ROLES.every((role) => current[role] === references[role])) return;

	const scm = { ...(project.credentials.scm ?? {}) };
	if (SCM_CREDENTIAL_ROLES.some((role) => references[role])) scm[providerId] = references;
	else delete scm[providerId];
	await upsertProjectToDb({
		...project,
		credentials: { ...project.credentials, scm },
	});
}

/**
 * Persist one PM provider's `role -> reference` block under
 * `credentials.pm[providerId]`, leaving every other provider's block untouched — the PM
 * twin of {@link updateScmReferences} (issue #631). That preservation is the point: a
 * project retaining the credentials of a provider it is not currently running on must
 * not lose them because a role name collides with one of the current provider's, and
 * since issue #641 the block being written is just as often the *incoming* provider's
 * as the persisted one's.
 *
 * Written through the project row (a reference is config, not a secret) and only when
 * it actually changes, so setting a credential twice doesn't churn the row. A block
 * that empties drops out entirely rather than persisting as `{}`.
 */
async function updatePmReferences(
	project: ProjectRecord,
	providerId: PMType,
	references: PmProviderCredentialReferences,
): Promise<void> {
	const current = project.credentials.pm?.[providerId] ?? {};
	const unchanged =
		Object.keys(current).length === Object.keys(references).length &&
		Object.entries(references).every(([role, key]) => current[role] === key);
	if (unchanged) return;

	const pm = { ...(project.credentials.pm ?? {}) };
	if (Object.keys(references).length > 0) pm[providerId] = references;
	else delete pm[providerId];
	await upsertProjectToDb({
		...project,
		credentials: { ...project.credentials, pm },
	});
}

export const credentialsRouter = router({
	/**
	 * One SCM provider's credential state for this project — the data the Source
	 * Control tab renders its fields from, addressed per provider since issue #632 so
	 * switching the tab's selector shows *that* provider's own state (unconfigured
	 * where nothing was saved) instead of one shared pair.
	 *
	 * `providerId` defaults to the provider the project runs on. An id nothing can
	 * serve reports `providerRegistered: false` with no roles rather than throwing, so
	 * the tab renders a "not available in this dashboard" state.
	 */
	list: authedProcedure
		.input(z.object({ projectId: z.string().min(1), providerId: z.string().min(1).optional() }))
		.query(async ({ ctx, input }) => {
			await assertProjectAccess(ctx.user, input.projectId, 'contributor');
			const project = await requireProject(input.projectId);
			const providerId = requestedScmProviderId(project, input.providerId);
			const manifest = runtimeReadyScmProvider(providerId);
			const resolved = await resolveAllProjectCredentials(input.projectId);

			return {
				providerId,
				providerLabel: manifest?.label ?? providerId,
				/** `false` when nothing runtime-ready is registered — nothing is editable then. */
				providerRegistered: !!manifest,
				roles: manifest
					? manifest.credentialRoles.map((spec) => {
							const referenceKey = scmReferenceKeyFor(project, manifest.id, spec);
							return {
								role: spec.role,
								/** The provider's conventional `swarm config apply` key for this role. */
								envVarKey: spec.envVarKey,
								/** The store key this role currently resolves through. Never a secret. */
								referenceKey,
								isConfigured: isUsableSecret(resolved[referenceKey]),
								maskedValue: maskCredential(resolved[referenceKey]),
							};
						})
					: [],
			};
		}),

	/**
	 * One PM provider's declared credential roles for this project, each with its
	 * configured/not-configured state and a masked preview — the data the Project
	 * Management tab renders its credential section from (issue #537). Provider
	 * terminology (`label`, `description`) comes off the manifest, so the screen
	 * hard-codes no provider.
	 *
	 * `providerId` defaults to the provider the project is persisted on; naming another
	 * answers for *that* provider's own block (issue #641), which is how the switch flow
	 * shows an incoming provider's credentials as unconfigured rather than showing the
	 * outgoing provider's. An id nothing is registered for reports
	 * `providerRegistered: false` with no roles rather than throwing — the same shape the
	 * SCM `list` uses, and the same answer this procedure has always given for an
	 * unregistered persisted `pm.type`.
	 *
	 * A role that inherits a shared SCM credential is reported with
	 * `inheritsSharedCredential` set and is not editable here (see
	 * {@link requirePmRoleSpec}); its resolved state is still shown, because "is the
	 * board's webhook secret set?" is a question this screen should answer.
	 */
	listPm: authedProcedure
		.input(
			z.object({
				projectId: z.string().min(1),
				providerId: PmProviderIdSchema.optional(),
			}),
		)
		.query(async ({ ctx, input }) => {
			await assertProjectAccess(ctx.user, input.projectId, 'contributor');
			const project = await requireProject(input.projectId);
			const providerId = requestedPmProviderId(project, input.providerId);
			const manifest = getPMProvider(providerId);
			const resolved = await resolveAllProjectCredentials(input.projectId);

			return {
				providerId,
				providerLabel: manifest?.label ?? providerId,
				/** `false` when nothing is registered for it — nothing is editable then. */
				providerRegistered: !!manifest,
				roles: (manifest?.credentialRoles ?? []).map((spec) => {
					const referenceKey = pmReferenceKeyFor(project, providerId, spec);
					return {
						role: spec.role,
						label: spec.label,
						description: spec.description,
						envVarKey: spec.envVarKey,
						/** The store key this role currently resolves through. Never a secret. */
						referenceKey,
						optional: spec.optional === true,
						inheritsSharedCredential: spec.inheritsSharedCredential,
						isConfigured: isUsableSecret(resolved[referenceKey]),
						maskedValue: maskCredential(resolved[referenceKey]),
					};
				}),
			};
		}),

	/**
	 * Store the secret for one PM role and make sure `credentials.pm[providerId]` names
	 * it, so a project configured entirely through the dashboard resolves the same way a
	 * file-configured one does (`resolvePmCredential`). The plaintext is written
	 * straight to the encrypted store and never read back.
	 *
	 * `providerId` defaults to the persisted provider. Only the named provider's block is
	 * touched (issue #641): the persisted provider's references and stored secrets are
	 * left exactly as they were, which is what lets an operator enter an incoming
	 * provider's credentials — and then discover its boards — with the project still
	 * running on the outgoing one.
	 */
	setPm: authedProcedure
		.input(
			z.object({
				projectId: z.string().min(1),
				providerId: PmProviderIdSchema.optional(),
				role: z.string().min(1),
				value: z.string().min(1),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await assertProjectAccess(ctx.user, input.projectId, 'projectAdmin');
			const project = await requireProject(input.projectId);
			const { providerId, spec } = requirePmRoleSpec(project, input.role, input.providerId);
			const referenceKey = pmReferenceKeyFor(project, providerId, spec);

			await writeProjectCredential(input.projectId, referenceKey, input.value, spec.label);
			await updatePmReferences(project, providerId, {
				...(project.credentials.pm?.[providerId] ?? {}),
				[spec.role]: referenceKey,
			});
		}),

	/**
	 * Clear one PM role: delete the stored secret *and* drop its
	 * `credentials.pm[providerId]` reference, leaving every other provider's block in
	 * place. Dropping the reference is the point — a role with no reference reads
	 * no host environment variable either (`resolvePmCredential`), so "removed" means
	 * the provider fails explicitly instead of silently resolving an ambient value. A
	 * later `swarm config apply` re-adds the reference from `swarm.config.json`, which
	 * is the file-based configuration path staying authoritative for itself.
	 */
	deletePm: authedProcedure
		.input(
			z.object({
				projectId: z.string().min(1),
				providerId: PmProviderIdSchema.optional(),
				role: z.string().min(1),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await assertProjectAccess(ctx.user, input.projectId, 'projectAdmin');
			const project = await requireProject(input.projectId);
			const { providerId, spec } = requirePmRoleSpec(project, input.role, input.providerId);
			const referenceKey = pmReferenceKeyFor(project, providerId, spec);

			await deleteProjectCredential(input.projectId, referenceKey);
			const { [spec.role]: _removed, ...remaining } = project.credentials.pm?.[providerId] ?? {};
			await updatePmReferences(project, providerId, remaining);
		}),

	/**
	 * Store the secret for one `(provider, role)` and make sure
	 * `credentials.scm[providerId]` names it, so a project configured entirely through
	 * the dashboard resolves the same way a file-configured one does
	 * (`resolveScmCredentialOrNull`). The plaintext is written straight to the encrypted
	 * store and never read back.
	 *
	 * Only the named provider's block is touched: another provider's stored secret and
	 * reference are left exactly as they were, which is what lets an operator evaluate a
	 * second provider without re-entering the first one's credentials.
	 */
	set: authedProcedure
		.input(
			z.object({
				projectId: z.string().min(1),
				providerId: z.string().min(1),
				role: z.string().min(1),
				value: z.string().min(1),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await assertProjectAccess(ctx.user, input.projectId, 'projectAdmin');
			const project = await requireProject(input.projectId);
			const { providerId, spec } = requireScmRoleSpec(input.providerId, input.role);
			const referenceKey = scmReferenceKeyFor(project, providerId, spec);

			// No display name: the store row's label was the one thing the pre-#632 input let
			// a client choose alongside the key, and nothing reads it for an SCM reference.
			await writeProjectCredential(input.projectId, referenceKey, input.value, null);
			await updateScmReferences(project, providerId, {
				...(project.credentials.scm?.[providerId] ?? {}),
				[spec.role]: referenceKey,
			});
		}),

	/**
	 * Clear one `(provider, role)`: delete the stored secret *and* drop that provider's
	 * reference for that role, leaving every other provider's block in place. Dropping
	 * the reference is the point — an SCM reference has no host-environment fallback, so
	 * "removed" means resolution fails explicitly with the provider and role named. A
	 * later `swarm config apply` re-adds the reference from `swarm.config.json`, which is
	 * the file-based configuration path staying authoritative for itself.
	 */
	delete: authedProcedure
		.input(
			z.object({
				projectId: z.string().min(1),
				providerId: z.string().min(1),
				role: z.string().min(1),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await assertProjectAccess(ctx.user, input.projectId, 'projectAdmin');
			const project = await requireProject(input.projectId);
			const { providerId, spec } = requireScmRoleSpec(input.providerId, input.role);
			const referenceKey = scmReferenceKeyFor(project, providerId, spec);

			await deleteProjectCredential(input.projectId, referenceKey);
			const { [spec.role]: _removed, ...remaining } = project.credentials.scm?.[providerId] ?? {};
			await updateScmReferences(project, providerId, remaining);
		}),
});
