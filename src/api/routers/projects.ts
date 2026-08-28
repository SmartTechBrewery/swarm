import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import {
	PipelineBaseSchema,
	type PipelineConfig,
	PipelineConfigSchema,
	type PmCredentialReferencesByProvider,
	type ProjectPm,
	type ProjectRecord,
	ProjectRecordBaseSchema,
	type ScmCredentialReferencesByProvider,
} from '../../config/schema.js';
import { scmCredentialReferenceFor } from '../../config/scm-credentials.js';
import { writeProjectCredential } from '../../db/repositories/credentialsRepository.js';
import { resolveInstanceScmCredential } from '../../db/repositories/instanceCredentialsRepository.js';
import {
	approveMembershipRequestInDb,
	createMembershipRequest,
	getMembershipRequestById,
	getPendingRequest,
	listPendingRequestsForProject,
	rejectMembershipRequestInDb,
} from '../../db/repositories/projectMembershipRequestsRepository.js';
import {
	createProjectWithMemberInDb,
	deleteProjectFromDb,
	findProjectRecordByIdFromDb,
	listAllProjectRecordsFromDb,
	listDiscoverableProjectsFromDb,
	ProjectRepositoryConflictError,
	upsertProjectToDb,
} from '../../db/repositories/projectsRepository.js';
import { getMembership, listProjectsForUser } from '../../identity/membership-service.js';
import { githubProjectsBlankPm } from '../../integrations/pm/github-projects/config-schema.js';
import { getPMProvider } from '../../integrations/pm/registry.js';
import { getSCMProvider, listInstanceDefaultScmRoles } from '../../integrations/scm/registry.js';
import { describeError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import type { ScmCredentialRole, ScmType } from '../../scm/types.js';
import {
	accessibleProjectScope,
	assertProjectAccess,
	filterAccessibleProjects,
	mayAccessProject,
} from '../authz.js';
import { authedProcedure, router } from '../trpc.js';
import { credentialsRouter } from './credentials.js';

/**
 * The `pm` block a dashboard-created project starts with: SWARM's default PM
 * provider and an *empty* board mapping placeholder. The operator fills it in on
 * the Project Management tab (issues #201/#537) by picking a discovered board and its states,
 * so `create` never asks the client for opaque node IDs — and never trusts them
 * either (see `create` below).
 *
 * The blank mapping deliberately does not satisfy `ProjectPmSchema` (a persisted
 * mapping needs at least one status option): it is a placeholder for a project
 * that has not been mapped yet, and the board reads that would use it fail loudly
 * on the unmappable status rather than writing to a wrong board.
 *
 * The member itself is the provider's, not this module's (issue #641): every PM
 * manifest now declares its own blank `pm` member (`PMProviderManifest.blankPm`) so the
 * discovery API can serve a provider a project is not persisted on, and this default is
 * GitHub Projects' copy of that one definition rather than a second hand-written
 * spelling of its field names. Imported from the provider's side-effect-free
 * `config-schema.ts` — the module `src/config/schema.ts` already composes centrally —
 * so naming SWARM's default provider here doesn't drag its registration in with it.
 */
export const DEFAULT_PM_CONFIG: ProjectPm = githubProjectsBlankPm;

/**
 * The `credentials.scm` map a new project starts with: one reference per role its
 * **SCM provider** declares, named by that role's own conventional key
 * (`SCMProviderManifest.credentialRoles`, issue #628) — the exact shape of
 * {@link defaultPmCredentialReferences}, read off the manifest rather than hardcoded,
 * so a project created for another provider seeds *its* keys with no edit here.
 *
 * The implementer persona is intentionally absent — it resolves from the worker-local
 * `SWARM_OPERATOR_GH_TOKEN` (and its Bitbucket/GitLab siblings), not from
 * `project_credentials` (issue #396). An unregistered provider seeds nothing.
 */
function defaultScmCredentialReferences(scm: ScmType): ScmCredentialReferencesByProvider {
	const roles = getSCMProvider(scm)?.credentialRoles ?? [];
	if (roles.length === 0) return {};
	return { [scm]: Object.fromEntries(roles.map((role) => [role.role, role.envVarKey])) };
}

/**
 * The `credentials.pm` map a new project starts with: one reference per credential
 * role its PM provider *requires and owns*, named by that role's own declared
 * conventional key (issue #537), filed under that provider's id (issue #631). Nothing
 * is stored yet — the reference is a slot the Project Management tab (or `swarm config
 * apply`) fills — so board operations fail with the actionable "credential not
 * configured" error until it is, which is the point.
 *
 * Read off the manifest rather than hardcoded, so a project created for a different
 * PM provider seeds *its* roles with no edit here (ai/RULES.md §2). Optional and
 * shared-credential-inheriting roles are skipped: neither needs an entry to resolve.
 * An unregistered provider seeds nothing.
 */
function defaultPmCredentialReferences(
	pm: ProjectPm,
): PmCredentialReferencesByProvider | undefined {
	const roles = getPMProvider(pm.type)?.credentialRoles ?? [];
	const references = Object.fromEntries(
		roles
			.filter((role) => !role.optional && !role.inheritsSharedCredential)
			.map((role) => [role.role, role.envVarKey]),
	);
	return Object.keys(references).length > 0 ? { [pm.type]: references } : undefined;
}

/**
 * One instance-level default already resolved for the project being created (issue
 * #778) — the hand-off between the required check below and the best-effort write after
 * it.
 */
interface ResolvedInstanceScmDefault {
	readonly role: ScmCredentialRole;
	readonly envVarKey: string;
	readonly secret: string;
}

/**
 * Resolve every instance-level default the new project's **own** SCM provider requires,
 * refusing creation when the installation has recorded none (issue #778).
 *
 * The reviewer identity is an installation-wide *requirement*, not the best-effort
 * convenience issue #769 shipped: a project whose provider declares an
 * `instanceDefault`-eligible role with nothing stored has no way to run Review, so
 * `create` refuses here — before any row is written — rather than logging a warning and
 * leaving "this installation isn't fully configured" undetectable until Review fails on
 * that project days later. The message names the provider, the role and the tab to fix
 * it on, because whoever creates a project is usually not the `instanceAdmin` who can.
 *
 * Only the provider the project runs on, and only roles that declare `instanceDefault` —
 * never every registered provider's block, which is the fallback shape
 * `adoptLegacyScmCredentials` (`src/config/scm-credentials.ts`) refuses for the same
 * reason. `webhookSecret` can never declare it, so it is never required and never seeded.
 * A provider that declares no eligible role at all is untouched — the filtered loop is
 * empty, so nothing is looked up and creation proceeds exactly as before — and so is a
 * registered but not runtime-ready provider, which `listInstanceDefaultScmRoles()`
 * already excludes.
 *
 * Two properties worth not re-deriving. It **fails closed** on a lookup error: the
 * rejection propagates and nothing is created, where issue #769's post-commit seed left
 * a project created-but-unseeded — we cannot claim the credential exists, and re-running
 * `create` once the DB recovers is clean precisely because nothing was written. And it
 * returns the resolved secret rather than a boolean, so the row is read **once**: a
 * second read at write time would reopen the window where the default is cleared in
 * between, recreating the silent degradation this replaces.
 *
 * Throws on the first missing role rather than aggregating: every provider declares at
 * most one eligible role (`reviewer`), so an aggregate would be machinery for a list of
 * length ≤ 1.
 *
 * `swarm config apply` (`src/config/apply.ts`) deliberately keeps the opposite
 * philosophy — a missing referenced secret there is warned-and-skipped, because applying
 * a config file before every secret is exported is a legitimate partial state for that
 * path. This requirement is the dashboard's alone.
 */
async function requireInstanceScmDefaults(
	scm: ScmType,
): Promise<readonly ResolvedInstanceScmDefault[]> {
	const resolved: ResolvedInstanceScmDefault[] = [];
	for (const eligible of listInstanceDefaultScmRoles()) {
		if (eligible.providerId !== scm) continue;
		const secret = await resolveInstanceScmCredential(scm, eligible.role);
		if (secret === null) {
			throw new TRPCError({
				code: 'PRECONDITION_FAILED',
				message:
					`This installation has recorded no ${eligible.providerLabel} '${eligible.role}' ` +
					`credential, so a ${eligible.providerLabel} project could not run Review. An ` +
					'instance administrator must set it in General Settings → Credentials ' +
					`(${eligible.envVarKey}) before this project can be created.`,
			});
		}
		resolved.push({ role: eligible.role, envVarKey: eligible.envVarKey, secret });
	}
	return resolved;
}

/**
 * Copy the defaults {@link requireInstanceScmDefaults} resolved into the new project's
 * `project_credentials` rows (issue #769 phase 2/2), so a dashboard-created project is
 * routable for Review without an operator pasting the reviewer PAT by hand.
 *
 * A copy made once, at creation, into the project's *own* row — deliberately **not** a
 * resolution tier: `resolveScmCredentialOrNull` (`src/config/provider.ts`) still reads
 * only what this project names, so the no-fallback-chain rule is intact and a project
 * that later switches provider cannot resolve a stale secret. The value is decrypted
 * under the instance AAD and re-encrypted under the project's (`writeProjectCredential`
 * binds it to `projectId`), which leaves the project row self-contained: clearing or
 * rotating the instance default afterwards cannot break it, and cannot reach it.
 *
 * The destination key is the one the project *resolves* the role through, via the same
 * `scmCredentialReferenceFor(...) ?? envVarKey` rule `credentials.set` writes under
 * (`scmReferenceKeyFor`, `./credentials.ts`) — not a second derivation of it.
 *
 * Nothing can be overwritten here: the project row was created in this same call, so it
 * holds no credentials yet (and `deleteProjectFromDb` cascades them, so a reused id
 * cannot leave one behind).
 */
async function seedInstanceScmCredentials(
	project: ProjectRecord,
	scm: ScmType,
	defaults: readonly ResolvedInstanceScmDefault[],
): Promise<void> {
	for (const seed of defaults) {
		const key = scmCredentialReferenceFor(project, scm, seed.role) ?? seed.envVarKey;
		// No display name: nothing reads one for an SCM reference, matching `credentials.set`.
		await writeProjectCredential(project.id, key, seed.secret, null);
	}
}

// Derived from the record base object (`.omit()` needs a bare `z.object`); credentials
// are not client-writable here, so the config schema's `credentials.pm` cross-field
// check has nothing to validate on this input. The *record*, not the scoped view: this
// is the config-management surface, so `repositories` is what a client writes.
const ProjectWriteInputSchema = ProjectRecordBaseSchema.omit({ credentials: true });
// `pm` is omitted from the create input, not accepted from the client: a new
// project always starts on `DEFAULT_PM_CONFIG`'s placeholder mapping.
const ProjectCreateInputSchema = ProjectWriteInputSchema.omit({ pm: true });

function mergePipelineConfig(
	existing: PipelineConfig | undefined,
	patch: Partial<PipelineConfig> | undefined,
): PipelineConfig {
	if (!existing) return (patch || {}) as PipelineConfig;
	if (!patch) return existing;
	return {
		...existing,
		...patch,
		planning:
			existing.planning || patch.planning
				? {
						...existing.planning,
						...patch.planning,
					}
				: undefined,
		review:
			existing.review || patch.review
				? {
						...existing.review,
						...patch.review,
					}
				: undefined,
		respondToReview:
			existing.respondToReview || patch.respondToReview
				? {
						...existing.respondToReview,
						...patch.respondToReview,
					}
				: undefined,
		respondToCi:
			existing.respondToCi || patch.respondToCi
				? {
						...existing.respondToCi,
						...patch.respondToCi,
					}
				: undefined,
	};
}

/**
 * Refuse a `pm` update that would move the project onto a provider it cannot actually
 * run on — the server-side half of the switch guarantee (issue #642).
 *
 * The dashboard walks the switch in an order that makes this unreachable (the incoming
 * provider's credentials are entered *before* the new `pm` member is written), but
 * nothing about `update` enforced that order: it merges `{...existing, ...updates}` and
 * hands the result to `upsertProjectToDb`, which deliberately does not parse — so
 * `validatePmCredentialRoles`' presence rule (`src/config/schema.ts`, rule 3) fires on
 * `validateConfig` / `swarm config apply` but never here. A hand-rolled client could
 * therefore name a provider with no credentials at all and leave the project
 * half-switched: `pm.type` pointing at a board every read and write would fail against.
 *
 * The check mirrors that rule exactly — the provider must be **registered**, and every
 * role it declares that is neither optional nor inherited must have a reference in
 * *its own* `credentials.pm[<providerId>]` block (issue #631) — so the two surfaces
 * agree on what a complete PM configuration is. It fires only on a `pm.type` **change**:
 * an ordinary board/status edit is unaffected, and a project already running on a
 * provider whose credentials predate a manifest change is not retroactively blocked from
 * fixing its mapping.
 *
 * Presence of the *reference* is what is required, not of the stored secret — the same
 * thing the config schema checks, and the same thing `resolvePmCredential` needs before
 * it can look a secret up at all.
 */
function assertPmProviderSwitchable(existing: ProjectRecord, pm: ProjectPm): void {
	if (pm.type === existing.pm.type) return;

	const manifest = getPMProvider(pm.type);
	if (!manifest) {
		throw new TRPCError({
			code: 'BAD_REQUEST',
			message:
				`No PM provider is registered for '${pm.type}', so this project cannot be ` +
				'switched to it.',
		});
	}

	const configured = existing.credentials.pm?.[manifest.id] ?? {};
	const missing = manifest.credentialRoles.filter(
		(spec) => !spec.optional && !spec.inheritsSharedCredential && !configured[spec.role],
	);
	if (missing.length === 0) return;

	throw new TRPCError({
		code: 'BAD_REQUEST',
		message:
			`Cannot switch this project to ${manifest.label}: it requires the ` +
			`${missing.map((spec) => `'${spec.role}' (${spec.label})`).join(', ')} credential` +
			`${missing.length === 1 ? '' : 's'}, which this project has not configured. Set ` +
			`${missing.length === 1 ? 'it' : 'them'} under Project Management → Credentials ` +
			'before saving the new board mapping.',
	});
}

function hasUniqueViolationCode(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { code: unknown }).code === '23505'
	);
}

/**
 * drizzle-orm wraps every node-postgres query error in a `DrizzleQueryError`,
 * which has no top-level `code` — the original pg error (the one carrying
 * `code: '23505'` for a unique violation) is on `.cause`. Check both so this
 * still matches once drizzle's wrapping is in the way.
 */
function isUniqueViolation(error: unknown): boolean {
	return (
		hasUniqueViolationCode(error) || (error instanceof Error && hasUniqueViolationCode(error.cause))
	);
}

/**
 * Either way a project write can collide: the `projects.id` primary key (a unique
 * violation from Postgres) or a repository another project already owns
 * (`ProjectRepositoryConflictError`, the guard that replaced the `repo` UNIQUE
 * constraint in issue #684). Both are the same CONFLICT to a client, so they are
 * recognised together rather than the repository half falling through as a 500.
 */
function isProjectConflict(error: unknown): boolean {
	return error instanceof ProjectRepositoryConflictError || isUniqueViolation(error);
}

export const projectsRouter = router({
	// Only the caller's accessible projects: their membership set, or every
	// project for an `instanceAdmin` (`filterAccessibleProjects`, #281 task 4).
	list: authedProcedure.query(async ({ ctx }) => {
		return await filterAccessibleProjects(ctx.user, await listAllProjectRecordsFromDb());
	}),

	// The caller's own projects and what they hold on each (issue #661) — the read
	// model behind the profile's My Projects tab, and the first place the dashboard
	// exposes a per-project membership role as personal data.
	//
	// Visibility is not decided here: it is the same `filterAccessibleProjects` rule
	// `list` runs on, so a project the caller may not discover is absent for exactly
	// the reason it is absent there and the two cannot drift apart. A `discoverable`
	// project they have not joined is therefore not listed — asking to join one stays
	// `listDiscoverable`/`requestMembership`.
	//
	// `role` is the membership row's role, or `null` when there is none. Only an
	// `instanceAdmin` reaches a project without one, so `null` means precisely
	// "access comes from the installation role" and is reported as the absence of a
	// membership rather than as a synthesized `projectAdmin` — inventing one would
	// misdescribe access that removing an installation role would take away. An
	// `instanceAdmin` who *is* a member reports that real role.
	//
	// Kept out of `list` rather than folded into it, for `viewerAccess`'s reason:
	// that query's cache is rewritten by `projects.update`'s result, which carries no
	// viewer-scoped field, so a `role` riding along there would be dropped by the next
	// config save. The projection is id + name + role only — the narrowness
	// `listDiscoverableProjectsFromDb` already applies to a project read that is not
	// about configuration, so no repo path, board mapping, or credential reference
	// travels to a personal overview that needs none of them.
	listMine: authedProcedure.query(async ({ ctx }) => {
		const accessible = await filterAccessibleProjects(
			ctx.user,
			await listAllProjectRecordsFromDb(),
		);
		const roleByProjectId = new Map(
			(await listProjectsForUser(ctx.user.id)).map(
				(membership) => [membership.projectId, membership.role] as const,
			),
		);
		// `listAllProjectRecordsFromDb` already orders by name, so the order is the server's
		// and the panel adds no sort of its own.
		return accessible.map((project) => ({
			id: project.id,
			name: project.name,
			role: roleByProjectId.get(project.id) ?? null,
		}));
	}),

	getById: authedProcedure
		.input(z.object({ id: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			// A non-member gets NOT_FOUND here, so the read below never reveals that a
			// project they can't see exists.
			await assertProjectAccess(ctx.user, input.id, 'contributor');
			const project = await findProjectRecordByIdFromDb(input.id);
			if (!project) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Project with ID "${input.id}" not found`,
				});
			}
			return project;
		}),

	// What the caller may *do* on one project, rather than what it is configured as
	// (issue #655) — the read model the project-detail screen decides which tabs to
	// offer from, so the configuration and credential tabs a `projectAdmin`-gated
	// mutation would refuse are never drawn or mounted for anyone else. It reports
	// the authorization each of those procedures re-checks for itself
	// (`mayAccessProject`, the non-throwing twin of `assertProjectAccess`); it is not
	// an enforcement point, and it grants nothing.
	//
	// Kept separate from `getById` rather than folded into its return: the project
	// config is written back into that query's cache by `projects.update`'s own
	// result, which carries no viewer capability, so a flag riding along there would
	// be dropped by the next config save.
	//
	// Gated at `contributor` like `getById`, so asking what you may do on a project
	// you cannot see returns the same existence-hiding `NOT_FOUND`. An
	// `instanceAdmin` administers every project, which `mayAccessProject` already
	// answers — the dashboard needs no separate installation-role branch.
	viewerAccess: authedProcedure
		.input(z.object({ projectId: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			await assertProjectAccess(ctx.user, input.projectId, 'contributor');
			return {
				canAdminister: await mayAccessProject(ctx.user, input.projectId, 'projectAdmin'),
			};
		}),

	// Any authenticated user may create a project and becomes its `projectAdmin`
	// (#281 task 4): the creator gets a membership row in the same call, so they
	// can immediately administer what they just created without an operator
	// seeding membership first. An `instanceAdmin` administers it regardless, but
	// the row is still written so the creator keeps access if their installation
	// role is later removed. Creation and membership insertion are performed
	// atomically in one transaction so a partial failure never leaves an unowned project.
	create: authedProcedure.input(ProjectCreateInputSchema).mutation(async ({ ctx, input }) => {
		const pmReferences = defaultPmCredentialReferences(DEFAULT_PM_CONFIG);
		// This is a creation-time default, not a config-schema fallback: the dashboard
		// always submits its explicit picker value, while non-dashboard callers remain
		// routable instead of creating a project with no SCM provider.
		const scm: ScmType = input.scm ?? 'github';
		// Issue #778: the instance reviewer credential is an installation-wide requirement,
		// so a provider declaring an `instanceDefault`-eligible role with nothing stored
		// refuses creation here — before any row is written, and before the config below is
		// even assembled, so a refused creation does no work at all. A request that would
		// both be refused and conflict on id therefore reports the refusal, the more
		// actionable of the two; the operator meets the conflict on the retry.
		const instanceDefaults = await requireInstanceScmDefaults(scm);
		const scmReferences = defaultScmCredentialReferences(scm);
		const config = {
			...input,
			scm,
			pm: DEFAULT_PM_CONFIG,
			credentials: {
				scm: scmReferences,
				...(pmReferences ? { pm: pmReferences } : {}),
			},
		};
		try {
			await createProjectWithMemberInDb(config, {
				projectId: config.id,
				userId: ctx.user.id,
				role: 'projectAdmin',
			});
		} catch (error) {
			if (isProjectConflict(error)) {
				throw new TRPCError({
					code: 'CONFLICT',
					message: 'Project ID or repository already exists',
				});
			}
			throw error;
		}
		// The *write* half stays best-effort, and outside the transaction above on purpose:
		// the project and its membership are already committed atomically, and
		// `writeProjectCredential` takes no transaction handle. The value demonstrably
		// exists by now — `requireInstanceScmDefaults` resolved it or refused — so a failure
		// here is a transient encryption/DB fault, not a reason to have refused creation:
		// the degraded outcome is settable on the Source Control tab, while re-running
		// `create` to recover it would only earn a `CONFLICT`.
		try {
			await seedInstanceScmCredentials(config, scm, instanceDefaults);
		} catch (error) {
			logger.warn(
				'projects.create: seeding the instance default SCM credentials failed; set them on the Source Control tab',
				{ projectId: config.id, scm, error: describeError(error) },
			);
		}
		return config;
	}),

	update: authedProcedure
		.input(
			ProjectWriteInputSchema.partial().extend({
				id: z.string().min(1),
				pipeline: PipelineBaseSchema.optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			// Config changes are a `projectAdmin`-only action; a `member`/`contributor`
			// gets FORBIDDEN, a non-member NOT_FOUND.
			await assertProjectAccess(ctx.user, input.id, 'projectAdmin');
			const existing = await findProjectRecordByIdFromDb(input.id);
			if (!existing) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Project with ID "${input.id}" not found`,
				});
			}
			const { id, ...updates } = input;
			// Before the merge, so a refused switch leaves nothing written at all.
			if (updates.pm) assertPmProviderSwitchable(existing, updates.pm);
			const config = {
				...existing,
				...updates,
			};
			if (updates.pipeline) {
				config.pipeline = PipelineConfigSchema.parse(
					mergePipelineConfig(existing.pipeline, updates.pipeline),
				);
			}
			try {
				await upsertProjectToDb(config);
				return config;
			} catch (error) {
				if (isProjectConflict(error)) {
					throw new TRPCError({
						code: 'CONFLICT',
						message: 'Project ID or repository already exists',
					});
				}
				throw error;
			}
		}),

	delete: authedProcedure
		.input(z.object({ id: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			// Deleting a project is `projectAdmin`-only (same boundary as `update`).
			await assertProjectAccess(ctx.user, input.id, 'projectAdmin');
			const existing = await findProjectRecordByIdFromDb(input.id);
			if (!existing) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Project with ID "${input.id}" not found`,
				});
			}
			await deleteProjectFromDb(input.id);
		}),

	// --- Open-project discovery & join flow (#281 task 5) ---
	//
	// These are the only project-keyed procedures a *non-member* may touch, and
	// only for `discoverable` projects. They keep discovery, joining, and
	// membership strictly separate from execution: none of them grants worker
	// registration or task routing — those remain distinct permissions (ADR-001).

	// The limited public-discovery read: any authenticated user sees the id +
	// name of `discoverable` projects they cannot already access. Exposes no
	// credentials, config, repo, or run internals (`listDiscoverableProjectsFromDb`
	// selects only id + name), and excludes projects the caller is already a
	// member of — an `instanceAdmin` already accesses every project, so they get
	// nothing new to discover.
	listDiscoverable: authedProcedure.query(async ({ ctx }) => {
		const scope = await accessibleProjectScope(ctx.user);
		if (scope === null) return [];
		const alreadyAccessible = new Set(scope);
		const discoverable = await listDiscoverableProjectsFromDb();
		return discoverable.filter((project) => !alreadyAccessible.has(project.id));
	}),

	// Ask to join a `discoverable` project. Joining never grants access directly:
	// it files a `pending` request a `projectAdmin`/`instanceAdmin` must approve
	// (ADR-001 Q1, resolved in favour of request/approve). A private or unknown
	// project is NOT_FOUND so a private project's existence never leaks; an
	// existing membership or pending request is a CONFLICT.
	requestMembership: authedProcedure
		.input(z.object({ projectId: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			const project = await findProjectRecordByIdFromDb(input.projectId);
			if (!project || project.visibility !== 'discoverable') {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Project with ID "${input.projectId}" not found`,
				});
			}
			if (await getMembership(ctx.user.id, input.projectId)) {
				throw new TRPCError({
					code: 'CONFLICT',
					message: 'You are already a member of this project.',
				});
			}
			if (await getPendingRequest(ctx.user.id, input.projectId)) {
				throw new TRPCError({
					code: 'CONFLICT',
					message: 'You already have a pending membership request for this project.',
				});
			}
			try {
				return await createMembershipRequest({
					projectId: input.projectId,
					userId: ctx.user.id,
				});
			} catch (error) {
				// The partial unique index catches a request that raced past the check above.
				if (isUniqueViolation(error)) {
					throw new TRPCError({
						code: 'CONFLICT',
						message: 'You already have a pending membership request for this project.',
					});
				}
				throw error;
			}
		}),

	// A `projectAdmin`/`instanceAdmin` lists the pending join requests for their
	// project. A non-member gets NOT_FOUND (existence hidden), a member below
	// `projectAdmin` FORBIDDEN — the same boundary as administering the project.
	listMembershipRequests: authedProcedure
		.input(z.object({ projectId: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			await assertProjectAccess(ctx.user, input.projectId, 'projectAdmin');
			return await listPendingRequestsForProject(input.projectId);
		}),

	// Approve a pending request → a `contributor` (read-only) membership. Keyed
	// on the request's own project, so a non-admin can neither approve nor learn
	// the request exists (the same NOT_FOUND message whether the request is
	// missing or the caller lacks access).
	approveMembershipRequest: authedProcedure
		.input(z.object({ requestId: z.string().uuid() }))
		.mutation(async ({ ctx, input }) => {
			const notFound = `Membership request with ID "${input.requestId}" not found`;
			const request = await getMembershipRequestById(input.requestId);
			if (!request) {
				throw new TRPCError({ code: 'NOT_FOUND', message: notFound });
			}
			await assertProjectAccess(ctx.user, request.projectId, 'projectAdmin', notFound);
			if (request.status !== 'pending') {
				throw new TRPCError({
					code: 'CONFLICT',
					message: 'This membership request has already been resolved.',
				});
			}
			const transitioned = await approveMembershipRequestInDb(request);
			if (!transitioned) {
				throw new TRPCError({
					code: 'CONFLICT',
					message: 'This membership request has already been resolved.',
				});
			}
			return { ...request, status: 'approved' as const };
		}),

	// Reject a pending request. Grants no membership. Same access boundary and
	// existence-hiding as approval.
	rejectMembershipRequest: authedProcedure
		.input(z.object({ requestId: z.string().uuid() }))
		.mutation(async ({ ctx, input }) => {
			const notFound = `Membership request with ID "${input.requestId}" not found`;
			const request = await getMembershipRequestById(input.requestId);
			if (!request) {
				throw new TRPCError({ code: 'NOT_FOUND', message: notFound });
			}
			await assertProjectAccess(ctx.user, request.projectId, 'projectAdmin', notFound);
			if (request.status !== 'pending') {
				throw new TRPCError({
					code: 'CONFLICT',
					message: 'This membership request has already been resolved.',
				});
			}
			const transitioned = await rejectMembershipRequestInDb(request.id);
			if (!transitioned) {
				throw new TRPCError({
					code: 'CONFLICT',
					message: 'This membership request has already been resolved.',
				});
			}
			return { ...request, status: 'rejected' as const };
		}),

	credentials: credentialsRouter,
});
