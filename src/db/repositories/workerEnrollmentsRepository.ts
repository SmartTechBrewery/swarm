/**
 * Worker-enrollment persistence — plain functions, one `getDb()` per call, no
 * class, mirroring `workersRepository.ts` / `projectMembersRepository.ts`. Backs
 * the `worker_project_enrollments` table (`src/db/schema/workerProjectEnrollments.ts`),
 * the persisted form of `WorkerEnrollment` (`src/identity/worker-enrollment.ts`,
 * the source of truth for the shape). Phase 3 of the worker slice.
 *
 * A row already carries the domain's exact types, so mapping it back to
 * `WorkerEnrollment` is a re-assembly, not a re-validation — same as
 * `rowToWorker` (`allowedClis`/`allowedPhases` come back typed from `jsonb` and
 * are cast to `AgentCli[]` / `TriggerPhase[]`, `status` is cast back to the
 * `EnrollmentStatus` enum the writers here only ever store). Creating a second
 * enrollment for the same
 * `(worker, project)` surfaces the raw pg `23505` unique violation; the caller
 * translates it. Lookups that find nothing return `undefined`/`[]` — a
 * not-found, not an error (ai/CODING_STANDARDS.md "Error handling").
 */

import { and, asc, eq } from 'drizzle-orm';

import type { AgentCli } from '../../harness/agent-cli.js';
import {
	AllowedClisNotCapableError,
	type EnrollmentStatus,
	type WorkerEnrollment,
} from '../../identity/worker-enrollment.js';
import type { TriggerPhase } from '../../triggers/types.js';
import { getDb } from '../client.js';
import { workerProjectEnrollments } from '../schema/workerProjectEnrollments.js';
import { workers } from '../schema/workers.js';

type EnrollmentRow = typeof workerProjectEnrollments.$inferSelect;

/** Re-assemble a `WorkerEnrollment` from a persisted `worker_project_enrollments` row. */
function rowToEnrollment(row: EnrollmentRow): WorkerEnrollment {
	return {
		id: row.id,
		workerId: row.workerId,
		projectId: row.projectId,
		status: row.status as EnrollmentStatus,
		allowedClis: row.allowedClis as AgentCli[],
		allowedPhases: row.allowedPhases as TriggerPhase[],
		concurrencyAllocation: row.concurrencyAllocation,
		sharingConsent: row.sharingConsent,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/** The fields a caller supplies to create an enrollment; `id`/timestamps are generated. */
export interface CreateEnrollmentInput {
	workerId: string;
	projectId: string;
	status: EnrollmentStatus;
	allowedClis: AgentCli[];
	/** The pipeline phases this project may route to the worker (issue #509). */
	allowedPhases: TriggerPhase[];
	/** This worker's share of the project — a positive integer (issue #480). */
	concurrencyAllocation: number;
	sharingConsent: boolean;
}

/**
 * Create an enrollment. Rejects with the pg `23505` unique violation if this
 * worker already has an enrollment for this project (at most one per
 * `(worker, project)`). Locks the worker row FOR UPDATE inside a transaction and
 * throws {@link AllowedClisNotCapableError} if any allowed CLI is not a declared capability of the worker.
 */
export async function createEnrollment(input: CreateEnrollmentInput): Promise<WorkerEnrollment> {
	return await getDb().transaction(async (tx) => {
		const [workerRow] = await tx
			.select()
			.from(workers)
			.where(eq(workers.id, input.workerId))
			.for('update')
			.limit(1);

		if (workerRow) {
			const capabilitySet = new Set(workerRow.capabilities as AgentCli[]);
			const offending = input.allowedClis.filter((cli) => !capabilitySet.has(cli));
			if (offending.length > 0) {
				throw new AllowedClisNotCapableError(input.workerId, offending);
			}
		}

		const [row] = await tx
			.insert(workerProjectEnrollments)
			.values({
				workerId: input.workerId,
				projectId: input.projectId,
				status: input.status,
				allowedClis: input.allowedClis,
				allowedPhases: input.allowedPhases,
				concurrencyAllocation: input.concurrencyAllocation,
				sharingConsent: input.sharingConsent,
			})
			.returning();
		return rowToEnrollment(row);
	});
}

/** Resolve an enrollment by its generated id. Returns `undefined` if unknown. */
export async function getEnrollmentById(id: string): Promise<WorkerEnrollment | undefined> {
	const rows = await getDb()
		.select()
		.from(workerProjectEnrollments)
		.where(eq(workerProjectEnrollments.id, id))
		.limit(1);
	const row = rows[0];
	return row ? rowToEnrollment(row) : undefined;
}

/** Resolve a worker's enrollment for one project, or `undefined` if it has none. */
export async function getEnrollment(
	workerId: string,
	projectId: string,
): Promise<WorkerEnrollment | undefined> {
	const rows = await getDb()
		.select()
		.from(workerProjectEnrollments)
		.where(
			and(
				eq(workerProjectEnrollments.workerId, workerId),
				eq(workerProjectEnrollments.projectId, projectId),
			),
		)
		.limit(1);
	const row = rows[0];
	return row ? rowToEnrollment(row) : undefined;
}

/** List every enrollment of a project, oldest first — the roster read. Empty if none. */
export async function listEnrollmentsForProject(projectId: string): Promise<WorkerEnrollment[]> {
	const rows = await getDb()
		.select()
		.from(workerProjectEnrollments)
		.where(eq(workerProjectEnrollments.projectId, projectId))
		.orderBy(asc(workerProjectEnrollments.createdAt), asc(workerProjectEnrollments.id));
	return rows.map(rowToEnrollment);
}

/** List every enrollment a worker holds, oldest first — the owner self-service read. Empty if none. */
export async function listEnrollmentsForWorker(workerId: string): Promise<WorkerEnrollment[]> {
	const rows = await getDb()
		.select()
		.from(workerProjectEnrollments)
		.where(eq(workerProjectEnrollments.workerId, workerId))
		.orderBy(asc(workerProjectEnrollments.createdAt), asc(workerProjectEnrollments.id));
	return rows.map(rowToEnrollment);
}

/**
 * Transition an enrollment's `status` (approve → `active`, revoke → `suspended`,
 * or back). Returns the updated enrollment, or `undefined` if no enrollment has
 * that id (nothing to update). Flipping to a non-`active` status is what makes
 * `isRoutable` false without deleting the row — the worker and its session are
 * untouched.
 */
export async function updateEnrollmentStatus(
	id: string,
	status: EnrollmentStatus,
): Promise<WorkerEnrollment | undefined> {
	const [row] = await getDb()
		.update(workerProjectEnrollments)
		.set({ status })
		.where(eq(workerProjectEnrollments.id, id))
		.returning();
	return row ? rowToEnrollment(row) : undefined;
}

/**
 * Set (or revoke, with `false`) the owner-controlled sharing consent. Returns
 * the updated enrollment, or `undefined` if no enrollment has that id. Revoking
 * consent flips `isRoutable` false — blocking future dispatch — without touching
 * the worker, its session, or any running process.
 */
export async function setEnrollmentSharingConsent(
	id: string,
	sharingConsent: boolean,
): Promise<WorkerEnrollment | undefined> {
	const [row] = await getDb()
		.update(workerProjectEnrollments)
		.set({ sharingConsent })
		.where(eq(workerProjectEnrollments.id, id))
		.returning();
	return row ? rowToEnrollment(row) : undefined;
}

/** The mutable execution constraints; each field is optional so a caller updates only what changed. */
export interface UpdateEnrollmentConstraintsInput {
	allowedClis?: AgentCli[];
	/** The phases this project may route here; omit to leave the stored set alone (issue #509). */
	allowedPhases?: TriggerPhase[];
	/** A positive integer sets the allocation; omit to leave the stored value alone. */
	concurrencyAllocation?: number;
}

/**
 * Update an enrollment's execution constraints (`allowedClis`, `allowedPhases`,
 * and/or `concurrencyAllocation`). A no-field update is a no-op that still returns
 * the current row. Returns `undefined` if no enrollment has that id. Locks the associated
 * worker row FOR UPDATE inside a transaction and throws {@link AllowedClisNotCapableError} if `allowedClis`
 * contains CLIs not in the worker's capabilities. `allowedPhases` carries no such
 * check — a daemon narrows its declared repertoire freely, so containment in
 * `workers.supported_phases` is not an invariant to enforce (see
 * `EnrollmentAllowedPhasesSchema`, `src/identity/worker-enrollment.ts`).
 */
export async function updateEnrollmentConstraints(
	id: string,
	input: UpdateEnrollmentConstraintsInput,
): Promise<WorkerEnrollment | undefined> {
	const patch: Partial<
		Pick<EnrollmentRow, 'allowedClis' | 'allowedPhases' | 'concurrencyAllocation'>
	> = {};
	if (input.allowedClis !== undefined) patch.allowedClis = input.allowedClis;
	if (input.allowedPhases !== undefined) patch.allowedPhases = input.allowedPhases;
	if (input.concurrencyAllocation !== undefined) {
		patch.concurrencyAllocation = input.concurrencyAllocation;
	}
	if (Object.keys(patch).length === 0) {
		return getEnrollmentById(id);
	}
	return await getDb().transaction(async (tx) => {
		const existingRows = await tx
			.select()
			.from(workerProjectEnrollments)
			.where(eq(workerProjectEnrollments.id, id))
			.limit(1);
		const existing = existingRows[0];
		if (!existing) return undefined;

		const [workerRow] = await tx
			.select()
			.from(workers)
			.where(eq(workers.id, existing.workerId))
			.for('update')
			.limit(1);

		if (patch.allowedClis !== undefined && workerRow) {
			const capabilitySet = new Set(workerRow.capabilities as AgentCli[]);
			const offending = patch.allowedClis.filter((cli) => !capabilitySet.has(cli));
			if (offending.length > 0) {
				throw new AllowedClisNotCapableError(workerRow.id, offending);
			}
		}

		const [row] = await tx
			.update(workerProjectEnrollments)
			.set(patch)
			.where(eq(workerProjectEnrollments.id, id))
			.returning();
		return row ? rowToEnrollment(row) : undefined;
	});
}

/**
 * Remove an enrollment (hard delete). Returns `true` if one was removed, `false`
 * if none had that id (a no-op, not an error). Note revocation is normally a
 * `suspended` status transition, not a delete, so the constraints survive a
 * later re-activation.
 */
export async function removeEnrollment(id: string): Promise<boolean> {
	const rows = await getDb()
		.delete(workerProjectEnrollments)
		.where(eq(workerProjectEnrollments.id, id))
		.returning({ id: workerProjectEnrollments.id });
	return rows.length > 0;
}
