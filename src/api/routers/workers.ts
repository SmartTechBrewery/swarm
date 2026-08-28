import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { findProjectByIdFromDb } from '../../db/repositories/projectsRepository.js';
import { findUserByIdentifier } from '../../db/repositories/usersRepository.js';
import { removeWorker } from '../../db/repositories/workersRepository.js';
import { AgentCliSchema } from '../../harness/agent-cli.js';
import { isInstanceAdmin, type SwarmUser } from '../../identity/schema.js';
import {
	WorkerCapabilitiesSchema,
	WorkerCapabilityNotProbedError,
	WorkerCapabilityReductionError,
	WorkerDisplayNameSchema,
} from '../../identity/worker.js';
import {
	AllowedClisNotCapableError,
	approveEnrollment,
	type DashboardProjectScope,
	type DashboardWorkerView,
	deriveWorkerRunState,
	EnrollmentRepositoryMismatchError,
	enrollWorker,
	getDashboardWorkerDetail,
	getEnrollment,
	listDashboardWorkers,
	listOwnerWorkers,
	listProjectRoster,
	listProjectWorkerIdsInOrder,
	moveProjectWorkerOrder,
	setEnrollmentStatus,
	setSharingConsent,
	updateEnrollmentConstraints,
	WorkerOrderDirectionSchema,
} from '../../identity/worker-enrollment-service.js';
import {
	declareWorkerCapabilities,
	getWorker,
	registerWorker,
	renameWorker,
	type Worker,
} from '../../identity/worker-service.js';
import { requireProjectSCMProviderId } from '../../integrations/scm/registry.js';
import { TriggerPhaseSchema } from '../../triggers/types.js';
import {
	accessibleProjectScope,
	assertInstanceAdmin,
	assertProjectAccess,
	mayAccessProject,
} from '../authz.js';
import { authedProcedure, router } from '../trpc.js';
import { resolveStrictlyOwnedWorker, workerNotFound } from '../worker-access.js';
import { workerScmCredentialsRouter } from './workerScmCredentials.js';

/**
 * The tRPC **workers** router (#337 Phase 3) — the enrollment-side companion to
 * `routers/projects.ts`. It exposes three clearly separated surfaces, all gated
 * by the identity/authorization layers ADR-001 establishes:
 *
 * - **Installation roster** (`list`, #133): the read-only cross-project
 *   connectivity view the dashboard's global Workers screen renders — every
 *   registered worker, including un-enrolled machines — which is an operator's
 *   view of the installation and so is reserved to an `instanceAdmin`
 *   (`assertInstanceAdmin`, issue #647). Given a `projectId` (#574) the same query
 *   serves **one project's** roster instead — the project detail page's Workers
 *   tab, the view an enrolled worker owner keeps — under the project roster's own
 *   access rule. The two order differently since issue #750, which is ordering
 *   alone and no change to what is visible: the project-scoped list follows the
 *   project's configured worker order, the unscoped one still lists the caller's
 *   own machines first (#657) and groups the rest by owner (#808). `getById` (#477)
 *   returns that same row for one worker, widened with per-project enrollment
 *   detail and with what the *viewer* may change, so the detail screen offers only
 *   controls that would succeed. It stays bounded by `accessibleProjectScope` for
 *   non-owners, while a strict owner may also open their own un-enrolled worker to
 *   create its first enrollment.
 * - **Owner self-service**, scoped to `ctx.user`: an owner registers a new
 *   machine (`register`, issue #799 — the network equivalent of `swarm workers
 *   register`, and the only procedure here that returns a secret), lists *their
 *   own* workers and enrollments (`listMine`), offers a worker to a project
 *   (`enroll`), renames a machine (`rename`), declares which agent CLIs it should
 *   run (`setDeclaredCapabilities`, issue #787 — the durable declaration issue
 *   #783 made survive a reconnect, cleared by passing `capabilities: null`),
 *   retires one for good (`remove`, issue #789 — the dashboard-reachable twin of
 *   `swarm workers remove`), and controls the revocable sharing consent
 *   (`setConsent`) and execution constraints (`updateConstraints`). Ownership is
 *   checked per call. `enroll` alone lets an `instanceAdmin` act on any worker
 *   (layer-1 override, `resolveOwnedWorker`) — offering a worker to a project
 *   reads as administering the project side of that offer; `rename`,
 *   `setDeclaredCapabilities`, `remove`, `setConsent`, and `updateConstraints`
 *   are the machine owner's own call about their own machine and admit no such
 *   override (`resolveStrictlyOwnedWorker`/`resolveOwnedEnrollment`). Either
 *   way, a caller who does not own the worker gets `NOT_FOUND`, so
 *   worker/enrollment existence never leaks across owners. The nested
 *   `scmCredentials` router (issue #766) is owner self-service too — the
 *   machine's own operator SCM credential per provider — and applies the same
 *   strict rule to *every* procedure, its read included (`./workerScmCredentials.ts`).
 * - **Project roster**, gated by `assertProjectAccess` exactly like
 *   `routers/projects.ts`: a `contributor` reads the roster (`roster`) and the
 *   SCM provider the project runs on (`projectScmProvider`, issue #799); only a
 *   `projectAdmin` approves an enrollment (`approveEnrollment`), revokes/
 *   reactivates one (`setStatus`), or moves a worker through the project's
 *   configured order (`reorderProjectWorker`, issue #750). A non-member gets
 *   `NOT_FOUND` (existence hidden), a member below the required role `FORBIDDEN`.
 *
 * Two of these procedures exist for the **networked CLI** rather than for the
 * dashboard (issue #799): `register` and `projectScmProvider` are what let
 * `swarm workers` run on a machine holding only `SWARM_CONTROL_PLANE_URL` and an
 * operator token, with no `DATABASE_URL` of its own. They are reachable on the
 * router's `/operator/trpc/*` mount (`../operator-router.ts`) and on the
 * dashboard's `/trpc/*` alike — the same procedure, the same authorization, since
 * neither mount is a privileged caller.
 *
 * Read models here expose **no secrets** (the service assembles secret-free
 * views) and derive busy/current-run from run lifecycle, never from the client.
 * None of this dispatches work: revoking consent/enrollment only flips the
 * `isRoutable` predicate the #130 gate consumes — it never terminates a running
 * agent (out of scope).
 */

/** The `NOT_FOUND` a non-owner/non-member (or anyone querying an unknown id) receives for an enrollment. */
function enrollmentNotFound(enrollmentId: string): TRPCError {
	return new TRPCError({
		code: 'NOT_FOUND',
		message: `Enrollment with ID "${enrollmentId}" not found`,
	});
}

/**
 * Resolve a worker the caller may act on as its owner. An `instanceAdmin` may
 * act on any worker (layer-1 override) for this one act — offering a worker to
 * a project is closer to project administration than to owning the machine.
 * A missing worker and a worker owned by someone else both surface the same
 * `NOT_FOUND`, so ownership never leaks which worker ids are real.
 */
async function resolveOwnedWorker(user: SwarmUser, workerId: string): Promise<Worker> {
	const worker = await getWorker(workerId);
	if (!worker || (!isInstanceAdmin(user) && worker.ownerUserId !== user.id)) {
		throw workerNotFound(workerId);
	}
	return worker;
}

/**
 * Resolve an enrollment plus its worker, hiding both behind one `NOT_FOUND`
 * unless the caller **strictly** owns the worker — no `instanceAdmin`
 * override; sharing consent and execution constraints (allowed CLIs, allowed
 * phases, concurrency) are the machine owner's own call, not an
 * administrative one. Used by the owner-scoped enrollment mutations so a
 * non-owner cannot even learn an enrollment id exists.
 */
async function resolveOwnedEnrollment(user: SwarmUser, enrollmentId: string) {
	const enrollment = await getEnrollment(enrollmentId);
	if (!enrollment) throw enrollmentNotFound(enrollmentId);
	const worker = await getWorker(enrollment.workerId);
	if (!worker || worker.ownerUserId !== user.id) {
		throw enrollmentNotFound(enrollmentId);
	}
	return { enrollment, worker };
}

/**
 * The project scope one roster read runs under. With a `projectId` this is the
 * project's own roster (issue #574) — the Workers tab on the project detail page
 * — so it applies the access rule `roster` applies, a `contributor` may read it
 * and a non-member gets `NOT_FOUND`, and scopes the read to that project alone:
 * an enrollment elsewhere, an in-flight run outside it, and the un-enrolled
 * machines an `instanceAdmin` otherwise sees all stay out. Without one it is the
 * installation-wide roster, which only an `instanceAdmin` may read (issue #647) —
 * so the unrestricted `null` scope below is never handed to a worker owner.
 */
async function resolveRosterScope(
	user: SwarmUser,
	projectId: string | undefined,
): Promise<DashboardProjectScope> {
	if (projectId) {
		await assertProjectAccess(user, projectId, 'contributor');
		return [projectId];
	}
	assertInstanceAdmin(user, 'workers');
	return null;
}

/**
 * The one collation this router's alphabetical ordering uses — accent- and
 * case-insensitive, the same `{ sensitivity: 'base' }` comparison the PM
 * providers sort their board containers by, so "ana" and "Ana" land next to each
 * other rather than in two separate stretches of the list.
 */
const byLabel = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: 'base' });

/**
 * Identifiers stay near case- and accent-equivalent labels, but identity needs a
 * total tie-break: distinct database-unique strings must not inherit row order.
 */
const byIdentifier = (a: string, b: string) => {
	const byBaseLabel = byLabel(a, b);
	if (byBaseLabel) return byBaseLabel;

	const byVariantLabel = a.localeCompare(b, undefined, { sensitivity: 'variant' });
	if (byVariantLabel) return byVariantLabel;

	return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * The viewer's own machines first, then everyone else's grouped by owner (issues
 * #657 and #808) — presentation order only, and since issue #750 the **unscoped**
 * global `/workers` list alone. It reorders the rows `listDashboardWorkers`
 * already decided are visible and changes nothing about visibility, project
 * scoping, ownership, or authorization.
 *
 * A project's Workers tab deliberately does *not* read it: that list has a
 * configured order of its own ({@link inProjectOrder}), which is also the order
 * the dispatch gate prefers, so sorting the viewer's own machines to the top there
 * would show every operator a different sequence from the one the project is
 * actually scheduled in. The global list has no such order — it spans projects —
 * so it is ordered for scanning instead:
 *
 * 1. **The viewer's own machines**, in the read model's own oldest-first order —
 *    exactly what #657 shipped. Their order is untouched because it is the one
 *    group an operator already knows by heart; re-alphabetising it would move
 *    rows for no gain.
 * 2. **Then one contiguous run per remaining owner**, the runs ordered by owner
 *    display name and, for two owners labelled the same, by their unique
 *    `identifier` — so a name collision is broken deterministically rather than
 *    by whichever machine happened to register first.
 * 3. **Within a run, by machine display name.** Registration order says nothing
 *    an operator scanning for one machine can use.
 *
 * A row whose owner user row no longer resolves (`owner === null`) forms its own
 * run and sorts **last**: it has no label to alphabetise by, and inventing one
 * would interleave those rows through owners they have nothing to do with. It is
 * never the viewer's own — the signed-in viewer's user row resolved to produce
 * `ctx.user` — so this cannot displace group 1.
 */
function viewerWorkersFirstThenGroupedByOwner(
	workers: DashboardWorkerView[],
	viewerUserId: string,
): DashboardWorkerView[] {
	const viewers: DashboardWorkerView[] = [];
	// Keyed by owner id (the ownerless run under a key no uuid can collide with),
	// and inserted in encounter order, so the grouping itself never depends on the
	// sort below being total.
	const byOwner = new Map<string, DashboardWorkerView[]>();
	for (const worker of workers) {
		if (worker.owner?.userId === viewerUserId) {
			viewers.push(worker);
			continue;
		}
		const key = worker.owner?.userId ?? '';
		const run = byOwner.get(key);
		if (run) run.push(worker);
		else byOwner.set(key, [worker]);
	}

	const others = [...byOwner.values()]
		.sort((a, b) => {
			// An ownerless run has no label; it goes last rather than under some
			// stand-in string that would sort it among real owners.
			if (!a[0].owner || !b[0].owner) return Number(!a[0].owner) - Number(!b[0].owner);
			return (
				byLabel(a[0].owner.displayName, b[0].owner.displayName) ||
				byIdentifier(a[0].owner.identifier, b[0].owner.identifier)
			);
		})
		.flatMap((run) => [...run].sort((a, b) => byLabel(a.displayName, b.displayName)));

	return [...viewers, ...others];
}

/**
 * The project's configured worker order (issue #750) — presentation order for the
 * project-scoped list, exactly as {@link viewerWorkersFirstThenGroupedByOwner} is
 * for the global one, and the same order `workers.roster` and the dispatch gate
 * already read.
 *
 * `workerIdsInOrder` is the project's own enrollment order; the sort is stable and
 * places a worker the order does not name **last**, which is defensive rather than
 * meaningful — a project-scoped read only returns workers enrolled there, so every
 * row is named.
 */
function inProjectOrder(
	workers: DashboardWorkerView[],
	workerIdsInOrder: string[],
): DashboardWorkerView[] {
	const position = new Map(workerIdsInOrder.map((workerId, index) => [workerId, index]));
	const rank = (worker: DashboardWorkerView) =>
		position.get(worker.workerId) ?? Number.MAX_SAFE_INTEGER;
	return [...workers].sort((a, b) => rank(a) - rank(b));
}

const AllowedClisInput = z.array(AgentCliSchema).min(1);
/**
 * The phases an enrollment may be given (issue #509). Non-empty for the same
 * reason `AllowedClisInput` is: "no work here" is a suspended enrollment or
 * revoked consent, not an empty constraint. The service re-validates and
 * de-duplicates (`EnrollmentAllowedPhasesSchema`); it deliberately does not check
 * the set against the machine's declared repertoire, which the daemon rewrites on
 * every reconnect.
 */
const AllowedPhasesInput = z.array(TriggerPhaseSchema).min(1);
const ConcurrencyInput = z.number().int().positive();

export const workersRouter = router({
	// The worker owner's own operator SCM credential per provider (issue #766),
	// nested here the way `credentialsRouter` nests under `projectsRouter`: it is
	// worker-scoped state and belongs under the worker's own namespace. Every
	// procedure there is strictly-owner-only, reads included.
	scmCredentials: workerScmCredentialsRouter,

	// --- Installation roster (cross-project, read-only) ---

	// Every worker the caller may see, with connectivity, last-seen, capabilities,
	// in-flight run, and enrollment states — the dashboard's Workers screen (#133).
	// Scoping is delegated wholesale to `resolveRosterScope`: unscoped it is the
	// installation-wide roster (`null` — every worker, including un-enrolled
	// machines), which an `instanceAdmin` alone may read (issue #647); with a
	// `projectId` (#574) it is that one project, authorized like `roster`.
	// Read-only — no mutation, no path/credential/token, and no routing or
	// approval affordance. Ordering is a presentation concern applied after scoping
	// decided what is visible, and the two lists order differently (issue #750): a
	// project-scoped read comes back in that project's *configured* worker order —
	// the same order `roster` and the dispatch gate read — while the unscoped
	// installation roster keeps the caller's own machines first (#657) and, having no
	// project order to speak of, groups the rest by owner and alphabetises both the
	// owner groups and the machines inside them (#808).
	list: authedProcedure
		.input(z.object({ projectId: z.string().min(1) }).optional())
		.query(async ({ ctx, input }) => {
			const scope = await resolveRosterScope(ctx.user, input?.projectId);
			const visible = await listDashboardWorkers(scope);
			const projectId = input?.projectId;
			const workers = projectId
				? inProjectOrder(visible, await listProjectWorkerIdsInOrder(projectId))
				: viewerWorkersFirstThenGroupedByOwner(visible, ctx.user.id);
			// The service already assembled a secret-free view; the only wire-shape
			// concern here is giving the browser an explicit ISO timestamp.
			return workers.map((worker) => ({
				...worker,
				lastSeenAt: worker.lastSeenAt?.toISOString() ?? null,
			}));
		}),

	// One worker in detail (#477) — the same row `list` returns, widened with the
	// full enrollment detail per visible project and with the two capability flags
	// the detail screen needs to decide which controls to offer. Visibility is the
	// caller's `accessibleProjectScope` — deliberately *not* the installation-admin
	// rule the unscoped `list` now applies (issue #647). A strict owner can also
	// open their own un-enrolled worker to create its first enrollment; every other
	// invisible worker is `NOT_FOUND` exactly like a missing one, so existence never
	// leaks. Read-only: the flags *report* the authorization each mutation re-checks
	// for itself.
	getById: authedProcedure
		.input(z.object({ workerId: z.string().uuid() }))
		.query(async ({ ctx, input }) => {
			const scope = await accessibleProjectScope(ctx.user);
			const detail = await getDashboardWorkerDetail(input.workerId, scope, ctx.user.id);
			if (!detail) throw workerNotFound(input.workerId);
			// The owner-controlled values (display name, sharing consent, execution
			// constraints) are gated by `resolveStrictlyOwnedWorker`/`resolveOwnedEnrollment`
			// below, so the flag mirrors them exactly — no `instanceAdmin` override.
			const viewerIsOwner = detail.ownerUserId === ctx.user.id;
			const enrollments = await Promise.all(
				detail.enrollments.map(async (enrollment) => ({
					...enrollment,
					// Approval and suspend/reactivate are the project administrator's.
					viewerCanAdminister: await mayAccessProject(
						ctx.user,
						enrollment.projectId,
						'projectAdmin',
					),
				})),
			);
			return {
				...detail,
				lastSeenAt: detail.lastSeenAt?.toISOString() ?? null,
				viewerIsOwner,
				enrollments,
			};
		}),

	// --- Owner self-service (scoped to ctx.user) ---

	// Register a machine for an owner — the network equivalent of `swarm workers
	// register` (issue #799). Until now no tRPC procedure wrapped `registerWorker`
	// at all, so registering a worker meant holding `DATABASE_URL`; that is exactly
	// what an operator on a remote machine does not have.
	//
	// **This is the one procedure in the tree that returns a secret.** The raw
	// worker credential comes back in `credential` exactly *once*: only its SHA-256
	// is persisted (`hashWorkerCredential`, `../../identity/worker-service.ts`), so
	// the value is never re-readable, no procedure exists to read it back, and a lost
	// one is replaced by registering the machine again. That is the same contract
	// `swarm workers register` already prints under. Never log it, never persist it
	// anywhere else, and do not add a read-back.
	//
	// Authorization states the CLI's own rule in tRPC terms: registering a machine
	// for *yourself* needs nothing beyond a session, while registering one for
	// somebody else is an installation-administration act — which is how
	// `swarm workers register <owner-identifier>` is used today. The `FORBIDDEN`
	// deliberately comes before the owner `NOT_FOUND`, so a caller who may not
	// register for others cannot use this as a "does this identifier exist?" oracle;
	// an `instanceAdmin` still gets the honest `NOT_FOUND` for a typo.
	//
	// It is the same layer-1 rule `assertInstanceAdmin` enforces, and the same
	// `FORBIDDEN`, but stated here rather than borrowed: that helper's copy names an
	// installation-wide *view* ("Open a project you are enrolled in to see its
	// workers"), which would misdescribe a refused registration.
	//
	// A duplicate `(owner, displayName)` is `CONFLICT`. The copy names the owner
	// rather than reusing `rename`'s "You already have a worker with this name" —
	// the collision can be on somebody else's machine here, which that wording would
	// misreport — and matches what `swarm workers register` already prints.
	register: authedProcedure
		.input(
			z.object({
				ownerIdentifier: z.string().min(1),
				displayName: WorkerDisplayNameSchema,
				// The machine's own declared repertoire, validated by the domain schema
				// `registerWorker` re-parses (it de-dupes), not by the enrollment-side
				// `AllowedClisInput` — a different constraint that happens to share a shape.
				capabilities: WorkerCapabilitiesSchema,
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const owner = await findUserByIdentifier(input.ownerIdentifier);
			if ((!owner || owner.id !== ctx.user.id) && !isInstanceAdmin(ctx.user)) {
				throw new TRPCError({
					code: 'FORBIDDEN',
					message:
						'You may only register a worker for yourself. Registering one for another owner is available to instance administrators only.',
				});
			}
			if (!owner) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `User with identifier "${input.ownerIdentifier}" not found`,
				});
			}
			try {
				return await registerWorker({
					ownerUserId: owner.id,
					displayName: input.displayName,
					capabilities: input.capabilities,
				});
			} catch (error) {
				if (isUniqueViolation(error)) {
					throw new TRPCError({
						code: 'CONFLICT',
						message: `A worker named "${input.displayName}" already exists for "${input.ownerIdentifier}".`,
					});
				}
				throw error;
			}
		}),

	// The caller's own workers and their enrollments, with derived run state. A
	// user who operates no workers gets an empty list.
	listMine: authedProcedure.query(async ({ ctx }) => {
		return await listOwnerWorkers(ctx.user.id);
	}),

	// Rename one of the caller's own workers — the machine's own label, not a
	// project-scoped fact, so it is gated by strict ownership
	// (`resolveStrictlyOwnedWorker`) rather than `resolveOwnedWorker`'s
	// `instanceAdmin` override. A name collision with another of the owner's
	// workers surfaces as `CONFLICT`, exactly like a duplicate on `enroll`.
	rename: authedProcedure
		.input(z.object({ workerId: z.string().uuid(), displayName: WorkerDisplayNameSchema }))
		.mutation(async ({ ctx, input }) => {
			await resolveStrictlyOwnedWorker(ctx.user, input.workerId);
			try {
				const updated = await renameWorker(input.workerId, input.displayName);
				if (!updated) throw workerNotFound(input.workerId);
				return updated;
			} catch (error) {
				if (isUniqueViolation(error)) {
					throw new TRPCError({
						code: 'CONFLICT',
						message: 'You already have a worker with this name.',
					});
				}
				throw error;
			}
		}),

	// Deregister one of the caller's own workers — the dashboard-reachable twin of
	// `swarm workers remove`, and the retirement half of "a worker is paired with one
	// repository, for life" (issue #789). Gated by strict ownership exactly like
	// `rename`: the machine is the owner's, so an `instanceAdmin` gets the same
	// NOT_FOUND a stranger does and their path to someone else's machine stays the CLI.
	//
	// Refused while the machine is executing a run: `runs.worker_id` is
	// ON DELETE SET NULL, so deleting mid-run would silently detach a live run from the
	// machine still running it. Merely being connected is fine — `worker_sessions`
	// cascades, and the daemon's next reconnect fails on a credential that no longer
	// resolves, which is what retiring a machine means. The check is advisory, not a
	// lock: a dispatch claimed between it and the delete still slips through, and the
	// CLI's own `workers remove` keeps its unconditional behaviour as the escape hatch.
	//
	// Everything else the worker carries goes with it through existing FK constraints —
	// its enrollments, its operator SCM credentials, and its session — while its runs
	// stay in history with `worker_user_id` preserving the attribution.
	remove: authedProcedure
		.input(z.object({ workerId: z.string().uuid() }))
		.mutation(async ({ ctx, input }) => {
			await resolveStrictlyOwnedWorker(ctx.user, input.workerId);
			const runState = await deriveWorkerRunState(input.workerId);
			if (runState.busy) {
				throw new TRPCError({
					code: 'CONFLICT',
					message:
						'This worker is running a job right now. Wait for it to finish, or stop the run, before deleting the worker.',
				});
			}
			const removed = await removeWorker(input.workerId);
			if (!removed) throw workerNotFound(input.workerId);
			return { workerId: input.workerId };
		}),

	// State (or clear) the owner's durable declaration of which agent CLIs this
	// machine should run (issue #787, over issue #783's service seam). The
	// declaration is the machine's own fact, not a project-scoped one, so it is
	// gated by strict ownership exactly like `rename` — no `instanceAdmin`
	// override — and a caller who does not own the worker gets `NOT_FOUND`.
	//
	// `capabilities: null` clears the declaration and returns the worker to plain
	// auto-discovery; a non-empty set narrows what the machine's daemon reported.
	// Both of the service's guards are surfaced verbatim rather than pre-checked
	// here: a set dropping a CLI an active enrollment still requires is `CONFLICT`
	// (the same 409 the handshake answers the same rule with), and a set naming a
	// CLI the daemon never probed is `BAD_REQUEST` — the code
	// `AllowedClisNotCapableError` already uses for the enrollment-side twin.
	setDeclaredCapabilities: authedProcedure
		.input(
			z.object({
				workerId: z.string().uuid(),
				capabilities: z.array(AgentCliSchema).min(1).nullable(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await resolveStrictlyOwnedWorker(ctx.user, input.workerId);
			try {
				const updated = await declareWorkerCapabilities(input.workerId, input.capabilities);
				if (!updated) throw workerNotFound(input.workerId);
				return updated;
			} catch (error) {
				if (error instanceof WorkerCapabilityReductionError) {
					throw new TRPCError({ code: 'CONFLICT', message: error.message });
				}
				if (error instanceof WorkerCapabilityNotProbedError) {
					throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
				}
				throw error;
			}
		}),

	// Offer one of the caller's workers to a project. The caller must own the
	// worker (NOT_FOUND otherwise) and be able to see the project (`contributor`,
	// so an unknown/inaccessible project is NOT_FOUND).
	//
	// What the enrollment is created as depends on whether the caller is *both*
	// parties to the two decisions routability needs (issue #784). Offering a
	// machine you do not administer the project of stays a `pending` enrollment
	// with sharing consent off, awaiting a projectAdmin's approval and the owner's
	// own consent. When the caller owns the worker *and* holds `projectAdmin` on
	// the target, both of those approvals are already theirs and were made in the
	// act of enrolling, so it is created `active` and consenting — routable with no
	// further step.
	//
	// A project whose repository is not the worker's declared checkout is refused
	// as `BAD_REQUEST` naming both repositories (issue #690), exactly as allowed
	// CLIs exceeding the machine's capabilities are.
	enroll: authedProcedure
		.input(
			z.object({
				workerId: z.string().uuid(),
				projectId: z.string().min(1),
				allowedClis: AllowedClisInput,
				// Omit for every phase (issue #509) — a new enrollment constrains nothing
				// its machine's daemon and the project don't already constrain.
				allowedPhases: AllowedPhasesInput.optional(),
				// Omit for the default share of one project slot (issue #480); there is
				// deliberately no value meaning "no per-worker cap".
				concurrencyAllocation: ConcurrencyInput.optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const worker = await resolveOwnedWorker(ctx.user, input.workerId);
			await assertProjectAccess(ctx.user, input.projectId, 'contributor');
			// The ownership conjunct is load-bearing, not redundant with the resolve
			// above: `resolveOwnedWorker` admits an `instanceAdmin` acting on someone
			// else's machine, and `mayAccessProject` says yes to an `instanceAdmin`
			// unconditionally — so the predicate has to be *joint* owner-and-admin
			// standing, never elevated privilege on its own. It short-circuits, so a
			// caller who is not the owner pays no extra membership read.
			const selfAdministered =
				worker.ownerUserId === ctx.user.id &&
				(await mayAccessProject(ctx.user, input.projectId, 'projectAdmin'));
			try {
				return await enrollWorker({
					worker,
					projectId: input.projectId,
					allowedClis: input.allowedClis,
					allowedPhases: input.allowedPhases,
					concurrencyAllocation: input.concurrencyAllocation,
					// Stated here rather than left to the service defaults: the router is
					// now the thing deciding them. The `pending`/`false` pair is identical
					// to what the defaults produce.
					status: selfAdministered ? 'active' : 'pending',
					sharingConsent: selfAdministered,
				});
			} catch (error) {
				if (
					error instanceof AllowedClisNotCapableError ||
					error instanceof EnrollmentRepositoryMismatchError
				) {
					throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
				}
				if (isUniqueViolation(error)) {
					throw new TRPCError({
						code: 'CONFLICT',
						message: 'This worker is already enrolled in this project.',
					});
				}
				throw error;
			}
		}),

	// Set/revoke the owner-controlled sharing consent on one of the caller's
	// enrollments. Revoking (false) flips `isRoutable` false — blocking future
	// dispatch — without terminating any running agent.
	setConsent: authedProcedure
		.input(z.object({ enrollmentId: z.string().uuid(), sharingConsent: z.boolean() }))
		.mutation(async ({ ctx, input }) => {
			await resolveOwnedEnrollment(ctx.user, input.enrollmentId);
			const updated = await setSharingConsent(input.enrollmentId, input.sharingConsent);
			if (!updated) throw enrollmentNotFound(input.enrollmentId);
			return updated;
		}),

	// Update the execution constraints (allowed CLIs / allowed phases / concurrency)
	// on one of the caller's enrollments. An `allowedClis` change is re-validated
	// against the worker's capabilities (BAD_REQUEST if it exceeds them). An
	// `allowedPhases` change is the owner's per-project routing choice (issue #509):
	// it takes effect on the next dispatch and never interrupts a running phase. For
	// `concurrencyAllocation`, send a positive integer to set this worker's share of
	// the project, or omit it to leave the stored value alone — no value clears it
	// (issue #480).
	updateConstraints: authedProcedure
		.input(
			z.object({
				enrollmentId: z.string().uuid(),
				allowedClis: AllowedClisInput.optional(),
				allowedPhases: AllowedPhasesInput.optional(),
				concurrencyAllocation: ConcurrencyInput.optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const { worker } = await resolveOwnedEnrollment(ctx.user, input.enrollmentId);
			try {
				const updated = await updateEnrollmentConstraints({
					worker,
					enrollmentId: input.enrollmentId,
					allowedClis: input.allowedClis,
					allowedPhases: input.allowedPhases,
					concurrencyAllocation: input.concurrencyAllocation,
				});
				if (!updated) throw enrollmentNotFound(input.enrollmentId);
				return updated;
			} catch (error) {
				if (error instanceof AllowedClisNotCapableError) {
					throw new TRPCError({ code: 'BAD_REQUEST', message: error.message });
				}
				throw error;
			}
		}),

	// --- Project roster (project-scoped authorization) ---

	// The project's worker roster — every enrolled worker with the secret-free
	// view and derived busy/current-run. A `contributor` may read it; a
	// non-member gets NOT_FOUND (existence hidden).
	roster: authedProcedure
		.input(z.object({ projectId: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			await assertProjectAccess(ctx.user, input.projectId, 'contributor');
			return await listProjectRoster(input.projectId);
		}),

	// The SCM provider id a project runs on (issue #799) — the one fact a DB-free
	// `swarm workers register-and-enroll` cannot work out for itself. The worker
	// operator's SCM credential is stored per `(worker, provider)` (issue #765), so
	// the CLI has to name a provider before it can write one, and on a machine with
	// no `DATABASE_URL` it holds no `ProjectConfig` to resolve one from.
	//
	// Resolved through `requireProjectSCMProviderId` — the same lookup the dispatcher
	// uses — and never `project.scm ?? 'github'`, which would file a Bitbucket or
	// GitLab project's credential under GitHub (ai/RULES.md §2). Its three throws
	// (unregistered, registered-but-not-runtime-ready, and "selects none while zero
	// or two-plus are ready") already name the project and what it asked for, so they
	// are surfaced as `PRECONDITION_FAILED` with the message verbatim: the project's
	// configuration is what has to change, not the request.
	//
	// A `contributor` read, exactly like `roster`, so a non-member gets `NOT_FOUND`
	// and project existence never leaks. It returns `{ providerId }` and nothing
	// else — no credential, no repository, no config.
	projectScmProvider: authedProcedure
		.input(z.object({ projectId: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			await assertProjectAccess(ctx.user, input.projectId, 'contributor');
			const project = await findProjectByIdFromDb(input.projectId);
			if (!project) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Project with ID "${input.projectId}" not found`,
				});
			}
			try {
				return { providerId: requireProjectSCMProviderId(project) };
			} catch (error) {
				throw new TRPCError({
					code: 'PRECONDITION_FAILED',
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}),

	// Approve a pending enrollment → active (a `projectAdmin` action). Keyed on
	// the enrollment's own project, so a non-admin can neither approve nor learn
	// the enrollment exists (the same NOT_FOUND whether missing or inaccessible).
	approveEnrollment: authedProcedure
		.input(z.object({ enrollmentId: z.string().uuid() }))
		.mutation(async ({ ctx, input }) => {
			const enrollment = await getEnrollment(input.enrollmentId);
			if (!enrollment) throw enrollmentNotFound(input.enrollmentId);
			await assertProjectAccess(
				ctx.user,
				enrollment.projectId,
				'projectAdmin',
				`Enrollment with ID "${input.enrollmentId}" not found`,
			);
			const updated = await approveEnrollment(input.enrollmentId);
			if (!updated) throw enrollmentNotFound(input.enrollmentId);
			return updated;
		}),

	// Revoke (suspend) or reactivate an enrollment (a `projectAdmin` action).
	// Suspending flips `isRoutable` false without deleting the enrollment or
	// terminating a running agent. Same access boundary/existence-hiding as approval.
	setStatus: authedProcedure
		.input(
			z.object({
				enrollmentId: z.string().uuid(),
				status: z.enum(['active', 'suspended']),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const enrollment = await getEnrollment(input.enrollmentId);
			if (!enrollment) throw enrollmentNotFound(input.enrollmentId);
			await assertProjectAccess(
				ctx.user,
				enrollment.projectId,
				'projectAdmin',
				`Enrollment with ID "${input.enrollmentId}" not found`,
			);
			const updated = await setEnrollmentStatus(input.enrollmentId, input.status);
			if (!updated) throw enrollmentNotFound(input.enrollmentId);
			return updated;
		}),

	// Move one worker one step through the project's configured worker order (issue
	// #750) — a `projectAdmin` action, gated exactly like approval/suspension, so a
	// contributor is refused and a non-member cannot learn the project exists. The
	// server computes the new positions from the stored order and returns the
	// project's worker ids in it: a client states only *which* worker and *which
	// direction*, never a list of positions it may have read before someone else
	// changed them.
	//
	// The order is a scheduling preference, not an authorization: the dispatch gate
	// still judges every candidate, so reordering can never route work to a worker
	// that is not eligible for it, and the change applies from the next dispatch —
	// nothing already running is touched.
	reorderProjectWorker: authedProcedure
		.input(
			z.object({
				projectId: z.string().min(1),
				workerId: z.string().uuid(),
				direction: WorkerOrderDirectionSchema,
			}),
		)
		.mutation(async ({ ctx, input }) => {
			await assertProjectAccess(ctx.user, input.projectId, 'projectAdmin');
			const workerIds = await moveProjectWorkerOrder({
				projectId: input.projectId,
				workerId: input.workerId,
				direction: input.direction,
			});
			// No enrollment pairs this worker with this project — the same NOT_FOUND an
			// unknown worker gets, since the caller already cleared the project.
			if (!workerIds) throw workerNotFound(input.workerId);
			return { projectId: input.projectId, workerIds };
		}),
});

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
 * which has no top-level `code` — the original pg error (carrying `code: '23505'`
 * for a unique violation) is on `.cause`. Check both, exactly like
 * `routers/projects.ts`.
 */
function isUniqueViolation(error: unknown): boolean {
	return (
		hasUniqueViolationCode(error) || (error instanceof Error && hasUniqueViolationCode(error.cause))
	);
}
