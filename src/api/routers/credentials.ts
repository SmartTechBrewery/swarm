import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import type { ProjectConfig } from '../../config/schema.js';
import {
	deleteProjectCredential,
	resolveAllProjectCredentials,
	writeProjectCredential,
} from '../../db/repositories/credentialsRepository.js';
import {
	getProjectByIdFromDb,
	upsertProjectToDb,
} from '../../db/repositories/projectsRepository.js';
import type { PmCredentialRoleSpec } from '../../integrations/pm/manifest.js';
import { getPMProvider } from '../../integrations/pm/registry.js';
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
 * Two families live here, and they differ in *who declares the roles*:
 *
 * - `list`/`set`/`delete` edit the shared **SCM** references (`reviewer`,
 *   `webhookSecret`), a fixed pair on the central config schema.
 * - `listPm`/`setPm`/`deletePm` edit the **PM provider's own** roles — whatever the
 *   registered manifest for `project.pm.type` declares (`credentialRoles`, issue
 *   #497), so the surface is provider-driven and the dashboard's Project Management
 *   tab renders it without naming a provider (issue #537). The client names a
 *   *role*, never an env-var key: the reference key is the project's existing one or
 *   the role's declared `envVarKey`, resolved server-side, so a browser can neither
 *   invent a store key nor point a role at another project's secret.
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

/** Load a project for a credential operation, or NOT_FOUND. */
async function requireProject(projectId: string): Promise<ProjectConfig> {
	const project = await getProjectByIdFromDb(projectId);
	if (!project) {
		throw new TRPCError({
			code: 'NOT_FOUND',
			message: `Project with ID "${projectId}" not found`,
		});
	}
	return project;
}

/**
 * The role spec a PM write names, validated against the *registered* manifest for
 * the project's provider. An unregistered provider or an undeclared role is a
 * BAD_REQUEST rather than a raw throw: the client picked it off `listPm`, so a
 * mismatch means the provider changed under it.
 */
function requirePmRoleSpec(project: ProjectConfig, role: string): PmCredentialRoleSpec {
	const manifest = getPMProvider(project.pm.type);
	if (!manifest) {
		throw new TRPCError({
			code: 'NOT_FOUND',
			message: `No PM provider registered for '${project.pm.type}'`,
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
	if (spec.inheritsSharedCredential) {
		throw new TRPCError({
			code: 'BAD_REQUEST',
			message:
				`The '${spec.role}' credential is the project's shared ${spec.inheritsSharedCredential} ` +
				'credential — configure it on the Source Control tab.',
		});
	}
	return spec;
}

/**
 * The secret-store key one PM role resolves through, mirroring
 * `resolvePmCredential`'s order (`src/config/provider.ts`): the reference the
 * project already configured, else the shared reference the role inherits, else the
 * role's declared conventional key.
 */
function pmReferenceKeyFor(project: ProjectConfig, spec: PmCredentialRoleSpec): string {
	const configured = project.credentials.pm?.[spec.role];
	if (configured) return configured;
	if (spec.inheritsSharedCredential) return project.credentials[spec.inheritsSharedCredential];
	return spec.envVarKey;
}

/**
 * Persist a project's `credentials.pm` role → reference map. Written through the
 * project row (the map is config, not a secret), and only when it actually changes,
 * so setting a credential twice doesn't churn the row.
 */
async function updatePmReferences(
	project: ProjectConfig,
	references: Record<string, string>,
): Promise<void> {
	const current = project.credentials.pm ?? {};
	const unchanged =
		Object.keys(current).length === Object.keys(references).length &&
		Object.entries(references).every(([role, key]) => current[role] === key);
	if (unchanged) return;
	await upsertProjectToDb({
		...project,
		credentials: {
			...project.credentials,
			pm: references,
		},
	});
}

export const credentialsRouter = router({
	list: authedProcedure
		.input(z.object({ projectId: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			await assertProjectAccess(ctx.user, input.projectId, 'contributor');
			const project = await requireProject(input.projectId);

			const resolved = await resolveAllProjectCredentials(input.projectId);

			// The Source Control screen edits the shared SCM references only; the PM
			// provider's own role map (`credentials.pm`, issue #497) is provider-declared
			// and served by `listPm` below, so it is excluded here rather than listed as a
			// role whose "env var key" is an object.
			const { pm: _pmReferences, ...scmReferences } = project.credentials;

			return Object.entries(scmReferences).map(([role, envVarKey]) => ({
				role: role as 'reviewer' | 'webhookSecret',
				envVarKey,
				isConfigured: isUsableSecret(resolved[envVarKey]),
				maskedValue: maskCredential(resolved[envVarKey]),
			}));
		}),

	/**
	 * The PM provider's declared credential roles for this project, each with its
	 * configured/not-configured state and a masked preview — the data the Project
	 * Management tab renders its credential section from (issue #537). Provider
	 * terminology (`label`, `description`) comes off the manifest, so the screen
	 * hard-codes no provider.
	 *
	 * A role that inherits a shared SCM credential is reported with
	 * `inheritsSharedCredential` set and is not editable here (see
	 * {@link requirePmRoleSpec}); its resolved state is still shown, because "is the
	 * board's webhook secret set?" is a question this screen should answer.
	 */
	listPm: authedProcedure
		.input(z.object({ projectId: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			await assertProjectAccess(ctx.user, input.projectId, 'contributor');
			const project = await requireProject(input.projectId);
			const manifest = getPMProvider(project.pm.type);
			const resolved = await resolveAllProjectCredentials(input.projectId);

			return {
				providerId: project.pm.type,
				providerLabel: manifest?.label ?? project.pm.type,
				/** `false` when nothing is registered for `pm.type` — nothing is editable then. */
				providerRegistered: !!manifest,
				roles: (manifest?.credentialRoles ?? []).map((spec) => {
					const referenceKey = pmReferenceKeyFor(project, spec);
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
	 * Store the secret for one PM role and make sure `credentials.pm` names it, so a
	 * project configured entirely through the dashboard resolves the same way a
	 * file-configured one does (`resolvePmCredential`). The plaintext is written
	 * straight to the encrypted store and never read back.
	 */
	setPm: authedProcedure
		.input(
			z.object({
				projectId: z.string().min(1),
				role: z.string().min(1),
				value: z.string().min(1),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await assertProjectAccess(ctx.user, input.projectId, 'projectAdmin');
			const project = await requireProject(input.projectId);
			const spec = requirePmRoleSpec(project, input.role);
			const referenceKey = pmReferenceKeyFor(project, spec);

			await writeProjectCredential(input.projectId, referenceKey, input.value, spec.label);
			await updatePmReferences(project, {
				...(project.credentials.pm ?? {}),
				[spec.role]: referenceKey,
			});
		}),

	/**
	 * Clear one PM role: delete the stored secret *and* drop its `credentials.pm`
	 * reference. Dropping the reference is the point — a role with no reference reads
	 * no host environment variable either (`resolvePmCredential`), so "removed" means
	 * the provider fails explicitly instead of silently resolving an ambient value. A
	 * later `swarm config apply` re-adds the reference from `swarm.config.json`, which
	 * is the file-based configuration path staying authoritative for itself.
	 */
	deletePm: authedProcedure
		.input(z.object({ projectId: z.string().min(1), role: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			await assertProjectAccess(ctx.user, input.projectId, 'projectAdmin');
			const project = await requireProject(input.projectId);
			const spec = requirePmRoleSpec(project, input.role);
			const referenceKey = pmReferenceKeyFor(project, spec);

			await deleteProjectCredential(input.projectId, referenceKey);
			const { [spec.role]: _removed, ...remaining } = project.credentials.pm ?? {};
			await updatePmReferences(project, remaining);
		}),

	set: authedProcedure
		.input(
			z.object({
				projectId: z.string().min(1),
				envVarKey: z
					.string()
					.regex(/^[A-Z_][A-Z0-9_]*$/, 'must be an UPPER_SNAKE_CASE env var key'),
				value: z.string().min(1),
				name: z.string().optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await assertProjectAccess(ctx.user, input.projectId, 'projectAdmin');
			await requireProject(input.projectId);

			await writeProjectCredential(
				input.projectId,
				input.envVarKey,
				input.value,
				input.name ?? null,
			);
		}),

	delete: authedProcedure
		.input(z.object({ projectId: z.string().min(1), envVarKey: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			await assertProjectAccess(ctx.user, input.projectId, 'projectAdmin');
			await requireProject(input.projectId);

			await deleteProjectCredential(input.projectId, input.envVarKey);
		}),
});
