import { randomUUID } from 'node:crypto';

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { findProjectByIdFromDb } from '../../db/repositories/projectsRepository.js';
import { findUserByIdentifier, listUsers } from '../../db/repositories/usersRepository.js';
import { removeWorker } from '../../db/repositories/workersRepository.js';
import { AgentCliSchema } from '../../harness/agent-cli.js';
import { isInstanceAdmin, type SwarmUser } from '../../identity/schema.js';
import {
	WorkerCapabilitiesSchema,
	WorkerCapabilityNotProbedError,
	WorkerCapabilityReductionError,
	WorkerDisplayNameSchema,
	type WorkerUpdateState,
	type WorktreeSweepResult,
	type WorktreeSweepStatus,
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
	type RosterOwner,
	setEnrollmentStatus,
	setSharingConsent,
	updateEnrollmentConstraints,
	WorkerOrderDirectionSchema,
} from '../../identity/worker-enrollment-service.js';
import {
	declareWorkerCapabilities,
	getWorker,
	listAllWorkers,
	listWorkersForOwner,
	registerWorker,
	renameWorker,
	requestWorkerUpdate,
	requestWorktreeSweep,
	setWorkerDraining,
	type Worker,
} from '../../identity/worker-service.js';
import { RolloutWaveSizeSchema } from '../../identity/worker-update-rollout.js';
import { requireProjectSCMProviderId } from '../../integrations/scm/registry.js';
import { WorkerUpdateTargetSchema } from '../../lib/build-identity.js';
import { logger } from '../../lib/logger.js';
import { publishWorktreeSweepRequest } from '../../queue/worker-sweeps.js';
import { publishWorkerUpdateRequest } from '../../queue/worker-updates.js';
import { TriggerPhaseSchema } from '../../triggers/types.js';
import {
	accessibleProjectScope,
	assertInstanceAdmin,
	assertProjectAccess,
	mayAccessProject,
} from '../authz.js';
import { authedProcedure, router } from '../trpc.js';
import { resolveStrictlyOwnedWorker, workerNotFound } from '../worker-access.js';
import { fanOutWorkerUpdate } from '../worker-update-fanout.js';
import {
	getRolloutForOwner,
	type RolloutMemberView,
	type RolloutView,
	startRollout,
} from '../worker-update-rollout.js';
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
 *   create its first enrollment. Both rows carry the machine's declared SWARM
 *   `build` and the server-derived `buildIsCurrent` verdict (issue #925), and
 *   `getById` alone also carries `controlPlaneBuild` — the API server's own build,
 *   which is the comparand that verdict was reached against and is one value for
 *   the whole installation rather than a per-row fact. Every one of the three is
 *   three-valued: an undeclared build and an unresolvable comparand both read as
 *   "no answer", never as stale. **One installation-wide *mutation* joins them**
 *   (`requestUpdateForInstallation`, issue #922): an administrator asks every
 *   machine on the installation to move to a build, including machines they do not
 *   own. It is an administrator's call on #647's terms — `FORBIDDEN` for anybody
 *   else, never narrowed to their own machines — because it only ever *asks*: the
 *   host opt-in (`SWARM_WORKER_SELF_UPDATE`) and the drain that makes a machine
 *   askable at all both stay the owner's, so nothing #800 reserved to them moves.
 *   The procedure's own comment carries the full reasoning and
 *   `docs/onboarding-worker.md` states it for operators. **A second
 *   installation-wide read joins them** (`listSweeps`, issue #956): every machine's
 *   last recorded abandoned-worktree sweep and what it removed — the readout behind
 *   `swarm workers sweeps`, and the only way to see a sweep without replacing it,
 *   which matters once the sweeps are requested by a weekly schedule rather than by
 *   the operator reading them. An administrator's on the same #647 terms, and kept
 *   off the roster rows deliberately: one report carries up to 200 removed paths,
 *   which no roster wants to be.
 * - **Owner self-service**, scoped to `ctx.user`: an owner registers a new
 *   machine (`register`, issue #799 — the network equivalent of `swarm workers
 *   register`, and the only procedure here that returns a secret), lists *their
 *   own* workers and enrollments (`listMine`), offers a worker to a project
 *   (`enroll`), renames a machine (`rename`), declares which agent CLIs it should
 *   run (`setDeclaredCapabilities`, issue #787 — the durable declaration issue
 *   #783 made survive a reconnect, cleared by passing `capabilities: null`),
 *   retires one for good (`remove`, issue #789 — the dashboard-reachable twin of
 *   `swarm workers remove`), takes a machine out of the dispatch pool so it can be
 *   restarted and puts it back (`setDraining`, issue #919 — reversible, sticky
 *   across the machine's reconnect, and answering with the machine's derived run
 *   state so the caller can tell when restarting is safe), asks a *drained*
 *   machine to move its SWARM install root to a build and restart into it
 *   (`requestUpdate`, issue #933 — refused with `CONFLICT` while the machine is
 *   still in the pool, since it would be given new work while it waits to
 *   restart), asks the same of *every* machine they own in one action
 *   (`requestUpdateForMine`, issue #921 — the fan-out in
 *   `../worker-update-fanout.ts`, which refuses no machine for its state and
 *   reports a disposition per machine instead), stages that same move across the
 *   whole fleet as a rollout that drains, signals, verifies and returns machines to
 *   the pool a bounded wave at a time and halts on a bad build
 *   (`startFleetUpdate` / `fleetUpdateStatus`, issue #940 — the state machine in
 *   `../worker-update-rollout.ts`; re-calling `startFleetUpdate` for the target
 *   already in progress *advances* it, and only a different target is `CONFLICT`),
 *   and controls the
 *   revocable sharing consent
 *   (`setConsent`) and execution constraints (`updateConstraints`). Ownership is
 *   checked per call. `enroll` alone lets an `instanceAdmin` act on any worker
 *   (layer-1 override, `resolveOwnedWorker`) — offering a worker to a project
 *   reads as administering the project side of that offer; `rename`,
 *   `setDeclaredCapabilities`, `remove`, `setDraining`, `requestUpdate`,
 *   `requestUpdateForMine`, `startFleetUpdate`, `fleetUpdateStatus`,
 *   `requestWorktreeSweep`, `setConsent`,
 *   and `updateConstraints`
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
 *   `NOT_FOUND` (existence hidden), a member below the required role `FORBIDDEN`
 *   — with one deliberate exception, `projectScmProvider`, which since issue #899
 *   answers a non-member of a *real* project with `FORBIDDEN` naming the
 *   `swarm members add` remedy instead, because its only caller is an operator
 *   provisioning their own machine and the collapsed refusal sent one chasing a
 *   project id that was correct all along. See the procedure's own comment for
 *   the existence-oracle that buys and why it stays there.
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

/**
 * The wire form of a worker's self-update state (issue #933) — the same explicit
 * ISO-timestamp treatment `lastSeenAt` and `drainingSince` get above, applied to
 * the two instants nested inside it, so a browser reads strings rather than
 * whatever the serializer makes of a `Date`.
 */
function serializeWorkerUpdate(update: WorkerUpdateState | null) {
	if (!update) return null;
	return {
		...update,
		requestedAt: update.requestedAt.toISOString(),
		reportedAt: update.reportedAt?.toISOString() ?? null,
	};
}

/**
 * Every user on the installation, keyed by id, in the non-secret {@link RosterOwner}
 * shape the rosters already report an owner in (issue #922).
 *
 * One read rather than a lookup per machine: an installation-wide fan-out labels
 * every row, and a `listUsers()` on an installation that has a handful of operators
 * is cheaper than N round trips. Nothing here decides visibility — the caller has
 * already been established as an `instanceAdmin`, for whom every machine and its
 * owner are visible anyway — and no credential material is in `SwarmUser` to leak.
 */
async function resolveWorkerOwners(): Promise<Map<string, RosterOwner>> {
	const users = await listUsers();
	return new Map(
		users.map((user) => [
			user.id,
			{ userId: user.id, identifier: user.identifier, displayName: user.displayName },
		]),
	);
}

/**
 * The wire form of a staged fleet update (issue #940) — the same explicit
 * ISO-timestamp treatment {@link serializeWorkerUpdate} applies, over the rollout's
 * two instants and each member's two. `null` when the caller has never started one,
 * which is an honest empty answer rather than an error.
 */
function serializeRollout(view: RolloutView | null) {
	if (!view) return null;
	return {
		...view.rollout,
		createdAt: view.rollout.createdAt.toISOString(),
		updatedAt: view.rollout.updatedAt.toISOString(),
		members: view.members.map(serializeRolloutMember),
	};
}

/** One member's line on the wire — the row plus its machine's label, instants as ISO strings. */
function serializeRolloutMember(member: RolloutMemberView) {
	return {
		...member,
		signalledAt: member.signalledAt?.toISOString() ?? null,
		settledAt: member.settledAt?.toISOString() ?? null,
	};
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

/**
 * The wire form of the sweep a machine last reported (issue #955), or `null` when it
 * has never answered one — which is the only thing that reads as `null` since issue
 * #956: a request outstanding beside an older outcome still answers with that
 * outcome, because asking no longer erases it (`../../db/repositories/workersRepository.ts`).
 * The caller states the outstanding request separately (`pendingRequestedAt`), so
 * "swept last week, asked again this morning, not heard from" is legible as both
 * facts rather than collapsing into "never swept".
 */
function previousSweepView(sweep: Worker['worktreeSweep']): {
	reportedAt: string;
	status: WorktreeSweepStatus;
	result: WorktreeSweepResult;
} | null {
	if (!sweep?.reportedAt || !sweep.status || !sweep.result) return null;
	return {
		reportedAt: sweep.reportedAt.toISOString(),
		status: sweep.status,
		result: sweep.result,
	};
}

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
				drainingSince: worker.drainingSince?.toISOString() ?? null,
				update: serializeWorkerUpdate(worker.update),
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
				drainingSince: detail.drainingSince?.toISOString() ?? null,
				update: serializeWorkerUpdate(detail.update),
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

	// Take one of the caller's own machines OUT of the dispatch pool, or return it
	// to the pool (issue #919). Draining is what makes restarting a worker safe: the
	// machine is given no new work from the next dispatch onward, while whatever it
	// is already running is left completely alone — the gate runs only before a phase
	// starts, and the fenced claim re-checks the same flag under the worker row's
	// lock, so an assignment already in flight is never disturbed.
	//
	// Strictly owner-only, exactly like `rename`, `setDeclaredCapabilities` and
	// `remove`: taking your own machine out of the pool so you can restart it is the
	// machine operator's call, not an administrative one, so an `instanceAdmin` who
	// does not own it gets the same NOT_FOUND a stranger does.
	//
	// Idempotent — a second drain keeps the instant the first recorded, so re-running
	// it does not restart the "draining since" clock. Deliberately **not** refused
	// while the machine is busy (unlike `remove`): being busy is the normal reason to
	// drain. That is why the server-derived run state comes back alongside the flag —
	// this one call doubles as the "has it gone idle, is it safe to restart yet?"
	// check, read from the run lifecycle exactly as `remove`'s refusal is, never
	// trusted from the caller.
	//
	// The flag is machine-wide and sticky across a reconnect: the handshake writes
	// only the daemon-declared columns, so a machine coming back does not quietly
	// rejoin the pool. Only `draining: false` returns it.
	setDraining: authedProcedure
		.input(z.object({ workerId: z.string().uuid(), draining: z.boolean() }))
		.mutation(async ({ ctx, input }) => {
			await resolveStrictlyOwnedWorker(ctx.user, input.workerId);
			const updated = await setWorkerDraining(input.workerId, input.draining);
			if (!updated) throw workerNotFound(input.workerId);
			const runState = await deriveWorkerRunState(input.workerId);
			return {
				workerId: updated.id,
				displayName: updated.displayName,
				drainingSince: updated.drainingSince?.toISOString() ?? null,
				busy: runState.busy,
				currentRunId: runState.currentRunId,
			};
		}),

	// Ask one of the caller's own machines to move its SWARM install root to a build
	// and restart into it (issue #933). The request is recorded on the worker row and
	// published; the router — the process that holds worker sockets — turns that into
	// the push (`../../router/worker-update-dispatch.ts`), and the machine reports
	// back on its own delivery route.
	//
	// Strictly owner-only, exactly like `setDraining` and `rename`: replacing the code
	// a machine runs is the machine operator's call, so an `instanceAdmin` who does not
	// own it gets the same NOT_FOUND a stranger does. That is not a formality here —
	// this is the one mutation in the tree whose effect is to run different code on
	// somebody's hardware.
	//
	// **Refused unless the machine is already draining** (issue #919), which is the
	// precondition that makes the rest of this safe rather than a policy about
	// tidiness: the daemon waits for its in-flight phases to finish before it applies
	// anything, and only draining guarantees no *new* work is dispatched into that
	// wait. The refusal names `swarm workers drain <id>` rather than draining the
	// machine itself — taking a machine out of the pool is its own decision with its
	// own idempotence, and doing it as a side effect would leave the operator with a
	// drained machine they never asked for if the update is then refused downstream.
	//
	// That precondition is *tested by the durable write itself* (issue #921), not read
	// here and trusted: `requestWorkerUpdate` carries `draining_since IS NOT NULL` in
	// its `WHERE` and answers `in-pool` when it matched nothing, so a concurrent
	// `swarm workers undrain` landing between this handler's read and its write leaves
	// the machine unasked rather than queued for a restart it is no longer drained
	// for. This handler only words the refusal; the fleet form words the same outcome
	// as an `in-pool` disposition over the same single eligibility boundary.
	//
	// The target is validated against the shared grammar before anything is written,
	// so a malformed one is `BAD_REQUEST` here rather than a `refused` report minutes
	// later from a machine that had to be woken to say so.
	//
	// Re-issuing overwrites: the row keeps one request, and the new one's id is what
	// the next report must name. There is deliberately no cancel — a machine that has
	// not acted is left with a request nothing pushes again until it reconnects, and
	// one that has acted has already restarted.
	requestUpdate: authedProcedure
		.input(z.object({ workerId: z.string().uuid(), target: WorkerUpdateTargetSchema }))
		.mutation(async ({ ctx, input }) => {
			await resolveStrictlyOwnedWorker(ctx.user, input.workerId);
			const requestId = randomUUID();
			const result = await requestWorkerUpdate(
				input.workerId,
				requestId,
				input.target,
				ctx.user.id,
			);
			if (result.outcome === 'not-found') throw workerNotFound(input.workerId);
			if (result.outcome === 'in-pool') {
				throw new TRPCError({
					code: 'CONFLICT',
					message:
						`Worker '${result.worker.displayName}' is still in the dispatch pool, so it cannot be ` +
						`asked to update: it would be given new work while it waits to restart. Run ` +
						`\`swarm workers drain ${input.workerId}\` first, then request the update.`,
				});
			}
			const updated = result.worker;
			// After the durable write, and never awaited for correctness: the request lives
			// on the row, so a router that misses this notification pushes it the moment the
			// machine next connects. The publish swallows its own failures for that reason.
			await publishWorkerUpdateRequest(input.workerId);
			return {
				workerId: updated.id,
				displayName: updated.displayName,
				requestId,
				target: input.target,
				requestedAt: updated.update?.requestedAt.toISOString() ?? null,
				drainingSince: updated.drainingSince?.toISOString() ?? null,
			};
		}),

	// Ask one of the caller's own machines to sweep its abandoned `task-<id>`
	// checkouts (issue #955). The request is recorded on the worker row and published;
	// the router — the process that holds worker sockets — turns that into the push
	// (`../../router/worktree-sweep-dispatch.ts`), and the machine reports back on its
	// own delivery route.
	//
	// Strictly owner-only, exactly like `requestUpdate`: removing directories from
	// somebody's hardware is the machine operator's call, so an `instanceAdmin` who
	// does not own it gets the same NOT_FOUND a stranger does.
	//
	// **Deliberately no draining precondition**, which is where this parts company
	// with `requestUpdate`. An update replaces the code under a running daemon and so
	// needs a machine no new work is dispatched to; a sweep disturbs no in-flight run,
	// because the daemon's own in-flight set is what makes a leased checkout read as
	// live and be skipped. Requiring a drain would also make phase 3's unattended
	// weekly sweep impossible — so there is no `in-pool` refusal to word here, and the
	// answer is simply the request the row now carries.
	//
	// Nothing about *what* to sweep is decided here: the projects and their thresholds
	// are read off the machine's approved enrollments when the frame is built, which is
	// what keeps a request made today from sweeping a project the machine left before
	// it next connects. Re-issuing overwrites an unanswered request, and there is no
	// cancel — a machine that has not acted is left with a request nothing pushes again
	// until it reconnects.
	requestWorktreeSweep: authedProcedure
		.input(z.object({ workerId: z.string().uuid() }))
		.mutation(async ({ ctx, input }) => {
			// Read before the write, so the answer is the record as it stood when the
			// question was asked. Since issue #956 the write no longer destroys it — a new
			// request replaces the request pair alone and the reported outcome stands until
			// the *next report* overwrites it — so this is a convenience rather than the
			// last chance to read it: one command both asks and reports, and `sweeps` reads
			// the same record without asking for anything.
			const previous = await resolveStrictlyOwnedWorker(ctx.user, input.workerId);
			const requestId = randomUUID();
			const updated = await requestWorktreeSweep(input.workerId, requestId);
			if (!updated) throw workerNotFound(input.workerId);
			// After the durable write, and never awaited for correctness: the request lives
			// on the row, so a router that misses this notification pushes it the moment the
			// machine next connects. The publish swallows its own failures for that reason.
			await publishWorktreeSweepRequest(input.workerId);
			return {
				workerId: updated.id,
				displayName: updated.displayName,
				requestId,
				requestedAt: updated.worktreeSweep?.requestedAt.toISOString() ?? null,
				// The sweep on record when this request was made, or `null` when the machine
				// has never answered one. Serialised rather than returned as the domain value,
				// like every other date on this router.
				previousSweep: previousSweepView(previous.worktreeSweep),
			};
		}),

	// What the **fleet** last deleted — every machine's most recent recorded sweep
	// (issue #956), which is the question the weekly schedule exists to make
	// answerable from one place: `swarm workers sweeps`.
	//
	// A read rather than a request: before this existed the only way to see a
	// machine's sweep was to ask it for another one, which is fine for one machine an
	// operator is standing at and wrong for a fleet nobody asked to sweep in the first
	// place. It reads the same record the weekly fan-out leaves standing — asking no
	// longer erases the answer (`../../db/repositories/workersRepository.ts`), so a
	// machine that swept last week and has not yet answered this week's ask reports
	// both facts here rather than reading as never swept.
	//
	// **Installation-wide, so an instance administrator's**, on issue #647's rule for
	// the unscoped roster: it reads across every owner's machines, which is an
	// operator's view of the installation rather than a member's view of their own
	// work. Refused outright rather than narrowed to the caller's own machines, for
	// the reason `requestUpdateForInstallation` states: a partial answer read as the
	// whole installation is worse than no answer. `FORBIDDEN` rather than
	// `NOT_FOUND` — the caller named no worker id, so there is no existence to hide.
	//
	// Ordering is `listAllWorkers`' own (oldest first) and nothing here re-sorts:
	// unlike the installation-wide *update* report there is no per-owner action to
	// take from this, so there is no owner axis to group along.
	listSweeps: authedProcedure.query(async ({ ctx }) => {
		if (!isInstanceAdmin(ctx.user)) {
			throw new TRPCError({
				code: 'FORBIDDEN',
				message:
					`Reading the installation's worktree sweeps is available to instance ` +
					`administrators only. Run \`swarm workers sweep-worktrees <worker-id>\` to ` +
					`read and refresh the sweep on a machine you own.`,
			});
		}
		const workers = await listAllWorkers();
		return {
			workers: workers.map((worker) => ({
				workerId: worker.id,
				displayName: worker.displayName,
				// The outstanding request, if any — a machine asked but not yet heard from,
				// which on a weekly unattended schedule is the ordinary state of one that has
				// been offline since the signal went out rather than an anomaly.
				pendingRequestedAt: worker.worktreeSweep?.requestId
					? (worker.worktreeSweep.requestedAt.toISOString() ?? null)
					: null,
				// The same shape `requestWorktreeSweep` returns as `previousSweep`, so one
				// reader serves both; `null` only for a machine that has never reported one,
				// never merely because the request above is still outstanding.
				lastSweep: previousSweepView(worker.worktreeSweep),
			})),
		};
	}),

	// The same request, asked of **every machine the caller owns** in one action
	// (issue #921), with a per-machine disposition saying what became of each —
	// including the machines it deliberately did not ask, and why.
	//
	// Strictly owner-scoped, and named for that scope: the set is
	// `listWorkersForOwner(ctx.user.id)` and nothing else, which inherits
	// `requestUpdate`'s owner-only rule rather than restating it. Whether an
	// `instanceAdmin` may signal machines they do not own was issue #922's question,
	// and it is answered by `requestUpdateForInstallation` below rather than here —
	// hence `ForMine` (mirroring `listMine`), which left the admin-facing name free.
	// An `instanceAdmin` calling *this* one still gets their own machines and nobody
	// else's, so the two selections stay separate procedures with separate rules.
	//
	// Unlike `requestUpdate` it refuses **no** machine for its state: a fleet action
	// that aborted on one un-drained machine would tell the operator nothing about the
	// other eleven. The dispositions and the reasoning behind them live in
	// `../worker-update-fanout.ts`; what stays here is the authorization and the wire
	// shape.
	//
	// The target is validated once, by the same `WorkerUpdateTargetSchema`
	// `requestUpdate` uses, so a malformed ref is one `BAD_REQUEST` for the whole call
	// rather than an identical refusal per machine. An operator who owns no machines
	// gets `{ target, workers: [] }` — an honest empty answer, not an error.
	requestUpdateForMine: authedProcedure
		.input(z.object({ target: WorkerUpdateTargetSchema }))
		.mutation(async ({ ctx, input }) => {
			const workers = await listWorkersForOwner(ctx.user.id);
			const entries = await fanOutWorkerUpdate(workers, input.target, ctx.user.id);
			return {
				target: input.target,
				workers: entries.map((entry) => ({
					...entry,
					update: serializeWorkerUpdate(entry.update),
				})),
			};
		}),

	// The same request, asked of **every machine on the installation** — the
	// administrator-facing selection issue #922 settled, and the answer to the
	// question `requestUpdateForMine` deliberately left open.
	//
	// **May an installation administrator ask a machine they do not own? Yes — ask,
	// and nothing further.** The codebase already held both stances and neither
	// generalises on its own: issue #800 made `set-scm-credential`, `remove`,
	// `consent` and `update-enrollment` strictly the machine owner's, while issue
	// #647 made the unfiltered roster an administrator's view. What settles this one
	// is that each of #800's four *takes something of the owner's* and keeps it — a
	// credential the administrator would then hold, the machine's existence, the
	// owner's consent to share it, the constraints their machine runs under — whereas
	// this takes nothing and decides nothing. Both of the switches that decide whether
	// a machine actually moves stay the owner's, and neither needs the administrator's
	// cooperation to work:
	//
	// - **The host opt-in** (`SWARM_WORKER_SELF_UPDATE`, issues #920/#933) is read
	//   from the machine's own environment and never from the wire. With it unset the
	//   daemon reports `declined` and carries on working, and unsetting it and
	//   restarting revokes it outright.
	// - **Draining** is still strictly the owner's (issue #919) and is *not* widened
	//   here. The fan-out asks only machines already out of the dispatch pool, so a
	//   machine its owner has not drained is reported `in-pool` and left untouched.
	//   An administrator therefore cannot take the installation's capacity down with
	//   this, and cannot move a machine whose owner has not made it askable.
	//
	// So the administrator may put the request; the owner keeps both vetoes. The rule
	// is written down for operators in `docs/onboarding-worker.md` beside #800's.
	//
	// **A non-administrator is refused outright, never narrowed.** No fallback to the
	// caller's own machines, and no per-worker filtering — an installation-wide action
	// that silently became an owner-scoped one would be the worst of both, since the
	// operator would read a partial report as the whole installation. `FORBIDDEN`
	// rather than the owner-scoped commands' `NOT_FOUND` on #647's own reasoning:
	// the caller named no worker id, so there is no existence to hide, and nothing
	// about the installation leaks through the refusal.
	//
	// Every request records **who** made it on the machine's own row
	// (`update_requested_by_user_id`, beside the build and the instant), which is what
	// makes this auditable now that the requester and the owner can be different
	// people; the log line below is the fleet-shaped view of the same act.
	requestUpdateForInstallation: authedProcedure
		.input(z.object({ target: WorkerUpdateTargetSchema }))
		.mutation(async ({ ctx, input }) => {
			if (!isInstanceAdmin(ctx.user)) {
				throw new TRPCError({
					code: 'FORBIDDEN',
					message:
						`Requesting an update across the installation is available to instance ` +
						`administrators only. Run \`swarm workers update --all ${input.target}\` to move ` +
						`the machines you own.`,
				});
			}
			// Grouped by owner before the fan-out rather than after it: the fan-out
			// preserves input order, so ordering the selection here is what makes the
			// report read as one block per owner — which is the axis an administrator reads
			// an installation-wide report along, and the one `listAllWorkers`' oldest-first
			// order interleaves.
			const owners = await resolveWorkerOwners();
			const workers = (await listAllWorkers()).sort((a, b) =>
				byIdentifier(
					owners.get(a.ownerUserId)?.identifier ?? a.ownerUserId,
					owners.get(b.ownerUserId)?.identifier ?? b.ownerUserId,
				),
			);
			const entries = await fanOutWorkerUpdate(workers, input.target, ctx.user.id);
			const ownerOf = new Map(workers.map((worker) => [worker.id, worker.ownerUserId]));
			const reported = entries.map((entry) => {
				const ownerUserId = ownerOf.get(entry.workerId);
				return {
					...entry,
					// `null` rather than an omitted field for an owner the users read did not
					// carry — a machine deregistered mid-fan-out, say. The roster reports an
					// unresolvable owner the same way, and a reader must print "unknown" for it
					// rather than silently attribute the machine to nobody in particular.
					owner: ownerUserId === undefined ? null : (owners.get(ownerUserId) ?? null),
					// The machine's own last word on its host opt-in (issue #933): `declined` is
					// reported by nothing else, so it is the only signal the control plane has
					// that this owner has opted out. Derived rather than stored, because it is
					// only ever true of a machine that has *answered* — a machine nobody has
					// asked yet has not opted out, it is simply unknown.
					optedOut: entry.lastReportedStatus === 'declined',
					update: serializeWorkerUpdate(entry.update),
				};
			});
			// The audit line for the action as a whole — who asked, for which build, for
			// which machines, and what became of each. The durable per-machine record is on
			// the rows themselves; this is what an operator greps when they want the fleet
			// action rather than one machine's history.
			logger.info('installation-wide worker update requested', {
				requestedBy: ctx.user.identifier,
				requestedByUserId: ctx.user.id,
				target: input.target,
				workers: reported.map((entry) => ({
					workerId: entry.workerId,
					owner: entry.owner?.identifier ?? null,
					disposition: entry.disposition,
					optedOut: entry.optedOut,
				})),
			});
			return { target: input.target, requestedBy: ctx.user.identifier, workers: reported };
		}),

	// Move **every machine the caller owns** to a build as a staged rollout (issue
	// #940) — the same per-machine request as `requestUpdateForMine`, but drained,
	// signalled, verified and returned to the pool a bounded wave at a time, and
	// stopped on its own when the build turns out to be bad. The state machine and
	// its reasoning live in `../worker-update-rollout.ts`; what stays here is the
	// authorization, the refusals and the wire shape.
	//
	// Strictly owner-scoped, inherited from `requestUpdateForMine` rather than
	// restated: the set is the caller's own machines and nothing wider, and whether an
	// installation administrator may stage a rollout over machines they do not own
	// stays issue #922's question.
	//
	// **Calling it again is how a rollout is advanced**, not an error: re-running
	// `swarm workers update --all <ref>` moves the rollout on and reports where every
	// member stands, exactly as re-running `swarm workers drain` is already the
	// supported way to poll a drain. Only a *different* target while one is in progress
	// is `CONFLICT`, and it names the status command rather than a machine — two
	// rollouts over the same machines would drain and undrain each other's members, so
	// re-targeting a fleet mid-move is refused rather than done quietly.
	//
	// The target is validated once by the same `WorkerUpdateTargetSchema`
	// `requestUpdate` uses, so a malformed ref is one `BAD_REQUEST` before any machine
	// is drained. An operator who owns no machines gets `{ rollout: null }` — an honest
	// empty answer, not an error, exactly as the fan-out gives them.
	startFleetUpdate: authedProcedure
		.input(
			z.object({
				target: WorkerUpdateTargetSchema,
				// Omit for the default of one machine at a time. Ignored when this call
				// advances a rollout already in progress: that rollout's bound is the one it
				// was started with and lives on its own row, so a later call cannot widen how
				// much capacity is down mid-move.
				waveSize: RolloutWaveSizeSchema.optional(),
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const result = await startRollout({
				ownerUserId: ctx.user.id,
				target: input.target,
				waveSize: input.waveSize,
			});
			if (result.outcome === 'no-machines') {
				return { action: 'no-machines' as const, target: input.target, rollout: null };
			}
			if (result.outcome === 'conflict') {
				throw new TRPCError({
					code: 'CONFLICT',
					message:
						`A fleet update to '${result.view.rollout.target}' is already in progress, so it ` +
						`cannot be re-targeted at '${input.target}' mid-move. Run ` +
						`\`swarm workers update --status\` to see where it stands; it has to finish or ` +
						`halt before another can start.`,
				});
			}
			return {
				action: result.outcome,
				target: input.target,
				rollout: serializeRollout(result.view),
			};
		}),

	// Where the caller's most recent staged fleet update stands (issue #940) — every
	// member, its state, and whatever its machine reported, plus the halt reason when
	// the rollout stopped itself. Owner-scoped exactly like `startFleetUpdate`, and
	// read-only: it never drains, signals or advances anything, so an operator can look
	// without moving the fleet on.
	//
	// It answers the caller's **latest** rollout whatever its status, not only a live
	// one, because the state a halted rollout left behind is the whole point of
	// recording it. `null` when they have never started one.
	fleetUpdateStatus: authedProcedure.query(async ({ ctx }) => {
		return { rollout: serializeRollout(await getRolloutForOwner(ctx.user.id)) };
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
	// Still a `contributor` read, but the **one** project-keyed procedure in the tree
	// that does not collapse "no such project" into "not yours" (issue #899). It looks
	// the row up *first*, so it makes two distinct refusals: `NOT_FOUND` when no
	// project carries the id, and `FORBIDDEN` naming `swarm members add` when the
	// project is real and the caller simply has no membership row for it. Live, an
	// operator read the collapsed `NOT_FOUND` as "wrong project id", spent the
	// investigation querying Postgres for rows that were there all along, and the fix
	// turned out to be a membership.
	//
	// Why the carve-out is affordable here and nowhere else: this procedure has one
	// caller in the repo (`planRegisterAndEnroll`, `src/cli/commands/workers.ts`), it
	// is an operator provisioning their *own* machine, and its entire payload is a
	// provider id — no name, repo, config, credential, board mapping or run. What it
	// costs is stated plainly: an authenticated caller can now use it to learn whether
	// a project id exists on the installation, which for a `private` project is a real
	// weakening of the existence-hiding property (`discoverable` ones are already
	// published by `projects.listDiscoverable`). That is accepted deliberately and
	// scoped to this path. **Do not copy it to `roster`** or to any other
	// project-keyed procedure: `assertProjectAccess` keeps its collapsing semantics
	// for all of them, and `roster` next door is the contrast case.
	//
	// `mayAccessProject(…, 'contributor')` replaces `assertProjectAccess` faithfully:
	// `contributor` is the lowest role, so that helper's member-below-`minRole`
	// `FORBIDDEN` branch was unreachable here and the non-member `NOT_FOUND` was the
	// only refusal it ever produced. An `instanceAdmin` still passes straight through.
	// The reorder means a non-member now costs one project row read — the intended
	// trade for telling the two apart.
	//
	// It returns `{ providerId }` and nothing else — no credential, no repository, no
	// config.
	projectScmProvider: authedProcedure
		.input(z.object({ projectId: z.string().min(1) }))
		.query(async ({ ctx, input }) => {
			const project = await findProjectByIdFromDb(input.projectId);
			if (!project) {
				throw new TRPCError({
					code: 'NOT_FOUND',
					message: `Project with ID "${input.projectId}" not found`,
				});
			}
			if (!(await mayAccessProject(ctx.user, input.projectId, 'contributor'))) {
				throw new TRPCError({
					code: 'FORBIDDEN',
					message:
						`You are not a member of project "${input.projectId}". The project id is right — ` +
						`the membership is missing: ask an instance administrator to run ` +
						`\`swarm members add ${input.projectId} ${ctx.user.identifier}\`, then run this again.`,
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
