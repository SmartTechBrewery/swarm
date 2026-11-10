import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { RESOLVE_PROBLEM_MAX_WRITE_ACTIONS_LIMIT } from '../../config/resolve-problem.js';
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
	assertRepositoriesUnclaimed,
	createProjectWithMemberInDb,
	deleteIdleProjectFromDb,
	findProjectRecordByIdFromDb,
	listAllProjectRecordsFromDb,
	listDiscoverableProjectsFromDb,
	ProjectRepositoryConflictError,
	upsertProjectToDb,
} from '../../db/repositories/projectsRepository.js';
import { getMembership } from '../../identity/membership-service.js';
import { githubProjectsBlankPm } from '../../integrations/pm/github-projects/config-schema.js';
import { getPMProvider } from '../../integrations/pm/registry.js';
import { getSCMProvider, listInstanceDefaultScmRoles } from '../../integrations/scm/registry.js';
import { describeError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { repoCoordinatesIssue } from '../../scm/repo-coordinates.js';
import type { ScmCredentialRole, ScmType } from '../../scm/types.js';
import { listAccessibleProjectSummaries } from '../accessible-projects.js';
import {
	accessibleProjectScope,
	assertProjectAccess,
	filterAccessibleProjects,
	mayAccessProject,
} from '../authz.js';
import { checkProjectReadiness } from '../project-readiness.js';
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
 * The implementer persona is intentionally absent — it is the stored credential of the
 * operator whose worker produced a pull request (issues #765, #1249), not a
 * `project_credentials` entry. An unregistered provider seeds nothing.
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
	/** Where the secret came from: the creator's own `reviewerToken`, or the instance default. */
	readonly source: 'request' | 'instanceDefault';
}

/**
 * Resolve every instance-level default the new project's **own** SCM provider requires,
 * refusing creation when neither the request nor the installation supplies one (issue
 * #778).
 *
 * A `reviewerToken` the creator typed into the New Project dialog satisfies the
 * `reviewer` role on its own — the stored default is then not even read — so a project
 * whose reviewer is not the installation's usual account can be created without an
 * instance administrator recording a default nobody else wants. The default stays the
 * fallback for a creator who leaves the field empty.
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
	reviewerToken: string | undefined,
): Promise<readonly ResolvedInstanceScmDefault[]> {
	const resolved: ResolvedInstanceScmDefault[] = [];
	const eligibleRoles = listInstanceDefaultScmRoles().filter((r) => r.providerId === scm);
	// Every shipped provider declares `reviewer` eligible, so this only refuses a token for
	// a provider that would otherwise silently drop it.
	if (reviewerToken !== undefined && !eligibleRoles.some((r) => r.role === 'reviewer')) {
		throw new TRPCError({
			code: 'BAD_REQUEST',
			message: `A reviewer token cannot be set at creation for a ${scm} project; set it on the Source Control tab.`,
		});
	}
	for (const eligible of eligibleRoles) {
		const fromRequest = eligible.role === 'reviewer' && reviewerToken !== undefined;
		const secret = fromRequest
			? reviewerToken
			: await resolveInstanceScmCredential(scm, eligible.role);
		if (secret === null) {
			throw new TRPCError({
				code: 'PRECONDITION_FAILED',
				message:
					`This installation has recorded no ${eligible.providerLabel} '${eligible.role}' ` +
					`credential, so a ${eligible.providerLabel} project could not run Review. Enter ` +
					"the project's reviewer token in the New Project dialog, or have an instance " +
					'administrator set a default in General Settings → Credentials ' +
					`(${eligible.envVarKey}).`,
			});
		}
		resolved.push({
			role: eligible.role,
			envVarKey: eligible.envVarKey,
			secret,
			source: fromRequest ? 'request' : 'instanceDefault',
		});
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
// `reviewerToken` is a secret, not config: `create` strips it before the record is
// assembled and only ever writes it, encrypted, to the project's credential row.
// Exported for the operator MCP server's `project_create` (`src/mcp/tools/project-setup.ts`),
// which takes exactly this input so the two surfaces cannot validate differently.
export const ProjectCreateInputSchema = ProjectWriteInputSchema.omit({ pm: true }).extend({
	reviewerToken: z.string().trim().min(1).optional(),
});

/**
 * What `previewCreate` accepts: `create`'s input with the reviewer token's *presence*
 * in place of its value, as `credentials.previewSet` takes no value. A query travels as
 * a GET with its input in the URL, so a secret here could land in a browser history or
 * an access log — and the dry run only reports the token's source, never the token.
 */
const ProjectCreatePreviewInputSchema = ProjectWriteInputSchema.omit({ pm: true }).extend({
	hasReviewerToken: z.boolean().optional(),
});

/**
 * Stands in for a supplied reviewer token when `previewCreate` plans: planning only
 * needs to know one was given (the `request` source), and a preview writes and returns
 * no secret, so this value never leaves the procedure.
 */
const PREVIEW_REVIEWER_TOKEN_PLACEHOLDER = '[preview]';

/**
 * The `pipeline` patch `update` accepts: the stored shape, except that
 * `maxContinuations: null` *clears* the budget back to its coded default (issue
 * #1259), and `resolveProblem.maxWriteActions: null` clears that phase's write cap
 * the same way (issue #1384). The wire is plain JSON, so an `undefined` key never arrives — without an
 * explicit `null` the Pipeline tab could set the budget but never unset it.
 */
const PipelinePatchSchema = PipelineBaseSchema.extend({
	maxContinuations: z.number().int().positive().nullable().optional(),
	resolveProblem: z
		.object({
			enabled: z.boolean().optional(),
			maxWriteActions: z
				.number()
				.int()
				.positive()
				.max(RESOLVE_PROBLEM_MAX_WRITE_ACTIONS_LIMIT)
				.nullable()
				.optional(),
		})
		.optional(),
});
type PipelinePatch = z.infer<typeof PipelinePatchSchema>;

/**
 * What `update` accepts: any subset of the record's writable fields, merged over the
 * stored one, with `pipeline` as the patch above. Exported for the operator MCP
 * server's `project_update` and `pm_board_set` (`src/mcp/tools/project-setup.ts`).
 */
export const ProjectUpdateInputSchema = ProjectWriteInputSchema.partial().extend({
	id: z.string().min(1),
	pipeline: PipelinePatchSchema.optional(),
});
type ProjectUpdateInput = z.infer<typeof ProjectUpdateInputSchema>;
type ProjectCreateInput = z.infer<typeof ProjectCreateInputSchema>;

function mergePipelineConfig(
	existing: PipelineConfig | undefined,
	patch: PipelinePatch | undefined,
): PipelineConfig {
	if (!patch) return existing ?? {};
	const { maxContinuations, resolveProblem, ...rest } = patch;
	const merged = mergePipelineSections(existing, rest);
	if (maxContinuations === null) delete merged.maxContinuations;
	else if (maxContinuations !== undefined) merged.maxContinuations = maxContinuations;
	if (resolveProblem) {
		const { maxWriteActions, ...flags } = resolveProblem;
		const section = { ...existing?.resolveProblem, ...flags };
		if (maxWriteActions === null) delete section.maxWriteActions;
		else if (maxWriteActions !== undefined) section.maxWriteActions = maxWriteActions;
		merged.resolveProblem = section;
	}
	return merged;
}

function mergePipelineSections(
	existing: PipelineConfig | undefined,
	patch: PipelineConfig,
): PipelineConfig {
	if (!existing) return { ...patch };
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
 * Refuse repositories whose segment count is not the one `scm` addresses a repository
 * by (issue #1089) — the API twin of the config schema's coordinate refinement.
 * {@link ProjectWriteInputSchema} derives from the *base* record schema, so it inherits
 * the two-or-three-segment regex without the per-provider count, and `upsertProjectToDb`
 * does not parse: without this a GitHub project could be given `a/b/c` here.
 */
function assertRepositoryCoordinates(
	scm: ScmType | undefined,
	repositories: ReadonlyArray<{ repo: string }>,
): void {
	for (const { repo } of repositories) {
		const message = repoCoordinatesIssue(scm, repo);
		if (message) throw new TRPCError({ code: 'BAD_REQUEST', message });
	}
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

/**
 * The `CONFLICT` a colliding project write answers with, naming which half collided
 * (issue #1359): a repository another project owns, or — on `create`, the only write
 * that can collide on it — the project id. The owning project is deliberately not
 * named: the caller may not be allowed to see it. A unique violation on `update` stays
 * the generic wording, since nothing tells which constraint it was.
 */
function projectConflictError(error: unknown, createdId?: string): TRPCError {
	if (error instanceof ProjectRepositoryConflictError) {
		return new TRPCError({
			code: 'CONFLICT',
			message: `Repository '${error.repo}' already belongs to another project.`,
		});
	}
	if (createdId !== undefined) return duplicateProjectIdError(createdId);
	return new TRPCError({ code: 'CONFLICT', message: 'Project ID or repository already exists' });
}

/** The `CONFLICT` a create answers with for an id another project already has. */
function duplicateProjectIdError(id: string): TRPCError {
	return new TRPCError({ code: 'CONFLICT', message: `A project with ID "${id}" already exists.` });
}

/** A refusal a preview reports instead of throwing, in the procedure's own code and words. */
export interface PreviewRefusal {
	code: TRPCError['code'];
	message: string;
}

/**
 * A planning step's throw as a preview's `wouldRefuse`: a client-class `TRPCError` is the
 * refusal the real write would answer with; anything else is a real failure and
 * propagates. The plan functions turn every validation failure into a `TRPCError`
 * themselves, so the write and its preview answer in the same code and words.
 */
function previewRefusalOf(error: unknown): PreviewRefusal {
	if (error instanceof TRPCError && error.code !== 'INTERNAL_SERVER_ERROR') {
		return { code: error.code, message: error.message };
	}
	throw error;
}

/** The project record `id` names, or the same `NOT_FOUND` every project procedure answers. */
async function requireProjectRecord(id: string): Promise<ProjectRecord> {
	const project = await findProjectRecordByIdFromDb(id);
	if (!project) {
		throw new TRPCError({
			code: 'NOT_FOUND',
			message: `Project with ID "${id}" not found`,
		});
	}
	return project;
}

/** Everything `create` decided before writing: the record and the credentials to seed into it. */
interface PlannedProjectCreate {
	config: ProjectRecord;
	scm: ScmType;
	instanceDefaults: readonly ResolvedInstanceScmDefault[];
}

/**
 * Validate a create request and assemble the record it would write — `create`'s whole
 * decision, shared with `previewCreate` so the dry run and the write cannot disagree.
 * Writes nothing; throws the refusal `create` answers with.
 */
async function planProjectCreate(raw: ProjectCreateInput): Promise<PlannedProjectCreate> {
	const { reviewerToken, ...input } = raw;
	const pmReferences = defaultPmCredentialReferences(DEFAULT_PM_CONFIG);
	// This is a creation-time default, not a config-schema fallback: the dashboard
	// always submits its explicit picker value, while non-dashboard callers remain
	// routable instead of creating a project with no SCM provider.
	const scm: ScmType = input.scm ?? 'github';
	// First of all, for the same reason as the instance-default check below: a refused
	// creation does no work at all.
	assertRepositoryCoordinates(scm, input.repositories);
	// Issue #778: the instance reviewer credential is an installation-wide requirement,
	// so a provider declaring an `instanceDefault`-eligible role with nothing stored
	// refuses creation here — before any row is written, and before the config below is
	// even assembled, so a refused creation does no work at all. A request that would
	// both be refused and conflict on id therefore reports the refusal, the more
	// actionable of the two; the operator meets the conflict on the retry.
	const instanceDefaults = await requireInstanceScmDefaults(scm, reviewerToken);
	const scmReferences = defaultScmCredentialReferences(scm);
	const config: ProjectRecord = {
		...input,
		scm,
		pm: DEFAULT_PM_CONFIG,
		credentials: {
			scm: scmReferences,
			...(pmReferences ? { pm: pmReferences } : {}),
		},
	};
	return { config, scm, instanceDefaults };
}

/**
 * Validate an update request against the stored record and assemble the record it
 * would write — `update`'s whole decision, shared with `previewUpdate`. Writes nothing;
 * throws the refusal `update` answers with.
 */
function planProjectUpdate(existing: ProjectRecord, input: ProjectUpdateInput): ProjectRecord {
	const { id: _id, pipeline: pipelinePatch, ...updates } = input;
	// Before the merge, so a refused switch leaves nothing written at all.
	if (updates.pm) assertPmProviderSwitchable(existing, updates.pm);
	const config: ProjectRecord = {
		...existing,
		...updates,
	};
	// Only on a change to either side, as the PM switch check: an ordinary edit is
	// unaffected, while a three-segment repository on GitHub — or a switch to Azure
	// DevOps with two-segment repositories still stored — is refused unwritten.
	if (updates.repositories || updates.scm) {
		assertRepositoryCoordinates(config.scm, config.repositories);
	}
	if (pipelinePatch) {
		// The input schema cannot catch a patch the *merged* pipeline breaks (the patch
		// schema extends the unrefined base, e.g. Review disabled while Respond-to-review
		// is not): a client refusal, not a raw ZodError tRPC would answer as a 500.
		const parsed = PipelineConfigSchema.safeParse(
			mergePipelineConfig(existing.pipeline, pipelinePatch),
		);
		if (!parsed.success) {
			throw new TRPCError({
				code: 'BAD_REQUEST',
				message: parsed.error.issues.map((issue) => issue.message).join('; '),
			});
		}
		config.pipeline = parsed.data;
	}
	return config;
}

/**
 * The repository-ownership half of a write's conflict check, run without writing — the
 * same guard `createProjectWithMemberInDb` / `upsertProjectToDb` apply — mapped to the
 * `CONFLICT` the write would answer with.
 */
async function assertRepositoriesAvailable(config: ProjectRecord): Promise<void> {
	try {
		await assertRepositoriesUnclaimed(config);
	} catch (error) {
		if (error instanceof ProjectRepositoryConflictError) throw projectConflictError(error);
		throw error;
	}
}

/** The top-level record fields whose value an update would change. */
function changedProjectFields(before: ProjectRecord, after: ProjectRecord): string[] {
	const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
	return [...keys].filter(
		(key) =>
			JSON.stringify(before[key as keyof ProjectRecord]) !==
			JSON.stringify(after[key as keyof ProjectRecord]),
	);
}

export const projectsRouter = router({
	// Only the caller's accessible projects: their membership set, or every
	// project for an `instanceAdmin` (`filterAccessibleProjects`, #281 task 4).
	list: authedProcedure.query(async ({ ctx }) => {
		return await filterAccessibleProjects(ctx.user, await listAllProjectRecordsFromDb());
	}),

	// The caller's own projects and what they hold on each (issue #661) — the read
	// model behind the profile's My Projects tab, and the first place the dashboard
	// exposes a per-project membership role as personal data. The read itself is
	// `listAccessibleProjectSummaries` (`../accessible-projects.ts`), shared with the
	// operator API's `workers.enrollableProjects` (issue #1311): visibility is
	// `list`'s own `filterAccessibleProjects` rule, and `role` is `null` for access
	// that comes from the installation role alone.
	//
	// Kept out of `list` rather than folded into it, for `viewerAccess`'s reason:
	// that query's cache is rewritten by `projects.update`'s result, which carries no
	// viewer-scoped field, so a `role` riding along there would be dropped by the next
	// config save.
	listMine: authedProcedure.query(({ ctx }) => listAccessibleProjectSummaries(ctx.user)),

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

	// The project's whole `agents` block, read at `projectAdmin` (issue #1349) — what
	// `update` would replace when given an `agents` change, and the dry run and
	// pre-write authorization of the operator MCP server's `phase_agents_reorder` and
	// `phase_agents_restore` (`src/mcp/tools/phase-agents.ts`), which persist through
	// `update`. Gated exactly as that mutation, so a dry run never describes a change
	// the real call would refuse: a `member`/`contributor` gets FORBIDDEN, a
	// non-member the existence-hiding NOT_FOUND.
	agentsForUpdate: authedProcedure
		.input(z.object({ id: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			await assertProjectAccess(ctx.user, input.id, 'projectAdmin');
			const project = await findProjectRecordByIdFromDb(input.id);
			if (!project) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Project with ID "${input.id}" not found`,
				});
			}
			return { agents: project.agents };
		}),

	// Any authenticated user may create a project and becomes its `projectAdmin`
	// (#281 task 4): the creator gets a membership row in the same call, so they
	// can immediately administer what they just created without an operator
	// seeding membership first. An `instanceAdmin` administers it regardless, but
	// the row is still written so the creator keeps access if their installation
	// role is later removed. Creation and membership insertion are performed
	// atomically in one transaction so a partial failure never leaves an unowned project.
	create: authedProcedure.input(ProjectCreateInputSchema).mutation(async ({ ctx, input }) => {
		const { config, scm, instanceDefaults } = await planProjectCreate(input);
		try {
			await createProjectWithMemberInDb(config, {
				projectId: config.id,
				userId: ctx.user.id,
				role: 'projectAdmin',
			});
		} catch (error) {
			if (isProjectConflict(error)) throw projectConflictError(error, config.id);
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

	update: authedProcedure.input(ProjectUpdateInputSchema).mutation(async ({ ctx, input }) => {
		// Config changes are a `projectAdmin`-only action; a `member`/`contributor`
		// gets FORBIDDEN, a non-member NOT_FOUND.
		await assertProjectAccess(ctx.user, input.id, 'projectAdmin');
		const existing = await requireProjectRecord(input.id);
		const config = planProjectUpdate(existing, input);
		try {
			await upsertProjectToDb(config);
			return config;
		} catch (error) {
			if (isProjectConflict(error)) throw projectConflictError(error);
			throw error;
		}
	}),

	// The dry run of `create` (issue #1359, the operator MCP server's `project_create`):
	// the same validation, the same instance-credential requirement and the same
	// id/repository conflict check, with nothing written. Gated as `create` is — any
	// authenticated user — and a refusal is reported as `wouldRefuse` in the code and
	// words `create` would answer with. No secret goes in or comes out: it takes only
	// whether a reviewer token was given (`hasReviewerToken`), and the credentials
	// `create` would seed are named by provider, role and source only.
	previewCreate: authedProcedure
		.input(ProjectCreatePreviewInputSchema)
		.query(async ({ ctx, input: { hasReviewerToken, ...input } }) => {
			let project: ProjectRecord | null = null;
			let seededCredentials: Array<{
				providerId: ScmType;
				role: ScmCredentialRole;
				source: string;
			}> = [];
			let wouldRefuse: PreviewRefusal | null = null;
			try {
				const plan = await planProjectCreate({
					...input,
					reviewerToken: hasReviewerToken ? PREVIEW_REVIEWER_TOKEN_PLACEHOLDER : undefined,
				});
				project = plan.config;
				seededCredentials = plan.instanceDefaults.map((seed) => ({
					providerId: plan.scm,
					role: seed.role,
					source: seed.source,
				}));
				if (await findProjectRecordByIdFromDb(plan.config.id)) {
					throw duplicateProjectIdError(plan.config.id);
				}
				await assertRepositoriesAvailable(plan.config);
			} catch (error) {
				wouldRefuse = previewRefusalOf(error);
			}
			return {
				project,
				creator: { userId: ctx.user.id, identifier: ctx.user.identifier, role: 'projectAdmin' },
				seededCredentials,
				// A new project always starts on the placeholder board mapping; `pm_board_set` /
				// the Project Management tab replaces it.
				pmPlaceholder: true,
				wouldRefuse,
			};
		}),

	// The dry run of `update` (issue #1359, the operator MCP server's `project_update` and
	// `pm_board_set`): the merged record `update` would write and which top-level fields it
	// changes, or the refusal it would answer with — including a repository another project
	// owns. Gated exactly as `update` (`projectAdmin`), so a caller who may not change the
	// project learns nothing more from the dry run.
	previewUpdate: authedProcedure.input(ProjectUpdateInputSchema).query(async ({ ctx, input }) => {
		await assertProjectAccess(ctx.user, input.id, 'projectAdmin');
		const existing = await requireProjectRecord(input.id);
		try {
			const after = planProjectUpdate(existing, input);
			await assertRepositoriesAvailable(after);
			return {
				before: existing,
				after,
				changedFields: changedProjectFields(existing, after),
				wouldRefuse: null,
			};
		} catch (error) {
			return {
				before: existing,
				after: null,
				changedFields: [],
				wouldRefuse: previewRefusalOf(error),
			};
		}
	}),

	// Whether the project can run, item by item, and what is missing (issue #1359) — the
	// operator MCP server's `project_readiness`. `projectAdmin`, like board discovery: it
	// exercises the project's own SCM and PM credentials against their providers, and the
	// role it reports to is the one that can fix what it finds. See
	// `../project-readiness.ts` for what each item checks.
	readiness: authedProcedure
		.input(z.object({ projectId: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			await assertProjectAccess(ctx.user, input.projectId, 'projectAdmin');
			return checkProjectReadiness(await requireProjectRecord(input.projectId));
		}),

	// Removing a project for good — reachable from the dashboard's Settings tab since
	// issue #854, and until then only as a hand-written `DELETE FROM projects`.
	//
	// The row delete leans entirely on Postgres FK cascades, so it takes the project's
	// `runs`, `dispatches`, `project_credentials`, `project_members`,
	// `project_membership_requests`, `review_verdicts` and `worker_project_enrollments`
	// with it, none of it recoverable.
	//
	// That cascade is why this refuses while the project has work in flight, the same
	// `CONFLICT` `workers.remove` answers a mid-run machine deletion with — and
	// deliberately *unlike* a PM provider switch (issue #642), which is not refused
	// because it leaves every row intact and only re-points what they mean. Here the
	// rows a worker is mid-way through executing would be deleted underneath it, so the
	// operator waits or stops the run first. The guard is on the server rather than in
	// the dashboard, so it holds for any caller; the dashboard renders the refusal.
	//
	// The existence check, the in-flight check and the delete are one transaction in
	// `deleteIdleProjectFromDb`, which is what makes the refusal race-free rather than
	// a read a dispatch claim can slip past — see its own doc comment for the two locks
	// that serialize deletion against dispatching. This procedure only maps its outcome
	// onto the wire.
	delete: authedProcedure
		.input(z.object({ id: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			// Deleting a project is `projectAdmin`-only (same boundary as `update`).
			await assertProjectAccess(ctx.user, input.id, 'projectAdmin');
			const outcome = await deleteIdleProjectFromDb(input.id);
			if (outcome.deleted) return;
			if (outcome.reason === 'not-found') {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Project with ID "${input.id}" not found`,
				});
			}
			if (outcome.reason === 'contended') {
				// A claim of one of this project's dispatches was landing as this ran, so
				// the guard refused rather than waiting on it (which is what keeps the two
				// lock orders from deadlocking). Work is starting, so this is the same
				// refusal with a shorter horizon: retry and it resolves either way.
				throw new TRPCError({
					code: 'CONFLICT',
					message:
						'A run is being claimed for this project right now. Try deleting it again in a moment.',
				});
			}
			// The two counts are two views of the same work — a dispatch a worker is
			// executing normally has a `running` run row too — so the greater of them is
			// how many pieces of work are in flight, not their sum. They differ only at
			// the edges: an executing dispatch whose run row does not exist yet, and a
			// zombie `running` row whose dispatch the lease sweep already reclaimed.
			const inFlight = Math.max(outcome.executingDispatches, outcome.runningRuns);
			const noun = inFlight === 1 ? 'run' : 'runs';
			const pronoun = inFlight === 1 ? 'it' : 'them';
			throw new TRPCError({
				code: 'CONFLICT',
				message: `This project has ${inFlight} ${noun} in flight. Wait for ${pronoun} to finish, or stop ${pronoun} from the Runs screen, before deleting the project.`,
			});
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
