import {
	boolean,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from 'drizzle-orm/pg-core';
import type { AgentCli } from '../../harness/agent-cli.js';
import {
	DEFAULT_CONCURRENCY_ALLOCATION,
	DEFAULT_ENROLLMENT_ALLOWED_PHASES,
	DEFAULT_ENROLLMENT_ORDER_INDEX,
} from '../../identity/worker-enrollment.js';
import type { TriggerPhase } from '../../triggers/types.js';
import { projects } from './projects.js';
import { workers } from './workers.js';

/**
 * One row per **worker-project enrollment** — the persisted form of
 * `WorkerEnrollment` (`src/identity/worker-enrollment.ts`), which stays the
 * source of truth for the shape (ai/CODING_STANDARDS.md "Zod is the source of
 * truth"). Phase 3 of the worker slice (ADR-001's third authorization layer):
 * where `workers` models a locally operated execution environment and
 * `worker_sessions` its one live claim, this links a worker to a project with a
 * project-scoped approval status, execution constraints, and the
 * owner-controlled sharing-consent flag the #130 dispatch gate reads.
 *
 * `worker_id` is a `workers.id` (`uuid`); `project_id` is a `projects.id`
 * (`text`). Both FKs are `ON DELETE CASCADE`, so an enrollment vanishes with
 * either its worker or its project and never dangles. The **unique index** on
 * `(worker_id, project_id)` is the enrollment identity: a worker holds at most
 * one enrollment per project; a re-enrollment is an update, not a second row.
 *
 * `status` is stored as free `text` (the Zod `EnrollmentStatusSchema` enum is
 * the source of truth for the values), matching how `project_members.role` /
 * `project_membership_requests.status` persist their enums. `allowed_clis` is a
 * `jsonb` of `AgentCli[]` (a subset of the worker's `capabilities`), the same
 * treatment `workers.capabilities` gets, and `allowed_phases` a `jsonb` of
 * `TriggerPhase[]` (issue #509) — the owner's per-project routing choice, which is
 * **not** the same axis as `workers.supported_phases`: that column is what the
 * daemon declares it can execute and is rewritten on every reconnect, while this
 * one is only ever written by its owner. It defaults to every phase so a row
 * created (or migrated) without a deliberate choice constrains nothing on its own.
 * `concurrency_allocation` is **`NOT NULL`
 * and defaults to `1`** (issue #480): every enrollment states this worker's share
 * of the project, and a new one claims a single slot unless the operator says
 * otherwise. "No per-worker cap" is deliberately not expressible — as `NULL` it
 * was a second way of saying a number, and on a default install already resolved
 * to an effective 1 (the limit it deferred to, `max_concurrent_jobs`, defaults
 * to 1). A larger integer widens this one
 * project's share of the worker. `order_index` is this worker's rank **within
 * its project's configured order** (issue #750): `NOT NULL`, defaulting to
 * `DEFAULT_ENROLLMENT_ORDER_INDEX` (`0`), read ascending with `(created_at, id)`
 * as the tie-break — which is what makes the all-zero migrated state read back in
 * exactly the creation order it read in before the column existed. Duplicates are
 * therefore legal and carry **no** unique constraint: the migration produces a
 * whole project of them, and two concurrent enrollments can compute the same
 * append position. A new row appends (`max(order_index) + 1` for the project) so
 * enrolling a machine never lands it mid-order; a reorder rewrites that project's
 * positions to a dense `0..n-1`. `sharing_consent` defaults to `false` (a fresh
 * enrollment is never routable until the owner opts in), so revoking consent is
 * the owner's explicit lever for flipping the routability predicate
 * (`isRoutable`).
 *
 * The two secondary indexes serve the two read models: `project_id` for the
 * project roster (`listEnrollmentsForProject`) and `worker_id` for the owner
 * self-service view (`listEnrollmentsForWorker`).
 */
export const workerProjectEnrollments = pgTable(
	'worker_project_enrollments',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		workerId: uuid('worker_id')
			.notNull()
			.references(() => workers.id, { onDelete: 'cascade' }),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		/** One of `EnrollmentStatusSchema` (`src/identity/worker-enrollment.ts`) — the source of truth for the values. */
		status: text('status').notNull().default('pending'),
		/** Subset of the worker's `capabilities` this project may run (source of truth in `worker-enrollment.ts`). */
		allowedClis: jsonb('allowed_clis').$type<AgentCli[]>().notNull(),
		/**
		 * The pipeline phases this project may route to the worker — the owner's
		 * choice (issue #509), distinct from the daemon-declared
		 * `workers.supported_phases`. Defaults to
		 * `DEFAULT_ENROLLMENT_ALLOWED_PHASES` (`src/identity/worker-enrollment.ts`,
		 * the source of truth for the shape). See the table doc-comment.
		 */
		allowedPhases: jsonb('allowed_phases')
			.$type<TriggerPhase[]>()
			.notNull()
			.default([...DEFAULT_ENROLLMENT_ALLOWED_PHASES]),
		/**
		 * This worker's share of the project: a positive integer, never null,
		 * defaulting to `DEFAULT_CONCURRENCY_ALLOCATION`
		 * (`src/identity/worker-enrollment.ts`, the source of truth for the shape).
		 * See the table doc-comment.
		 */
		concurrencyAllocation: integer('concurrency_allocation')
			.notNull()
			.default(DEFAULT_CONCURRENCY_ALLOCATION),
		/**
		 * This worker's rank within its project's configured order (issue #750),
		 * defaulting to `DEFAULT_ENROLLMENT_ORDER_INDEX`
		 * (`src/identity/worker-enrollment.ts`, the source of truth for the shape).
		 * See the table doc-comment for the tie-break, the append rule, and why
		 * duplicates are legal.
		 */
		orderIndex: integer('order_index').notNull().default(DEFAULT_ENROLLMENT_ORDER_INDEX),
		/** Owner-controlled, revocable; defaults false so a fresh enrollment is not routable until the owner opts in. */
		sharingConsent: boolean('sharing_consent').notNull().default(false),
		createdAt: timestamp('created_at').notNull().defaultNow(),
		updatedAt: timestamp('updated_at')
			.notNull()
			.defaultNow()
			.$onUpdate(() => new Date()),
	},
	(table) => [
		// At most one enrollment per (worker, project): the enrollment identity.
		uniqueIndex('idx_worker_enrollments_worker_project').on(table.workerId, table.projectId),
		// The project roster lookup (`listEnrollmentsForProject`).
		index('idx_worker_enrollments_project').on(table.projectId),
		// The owner self-service lookup — every enrollment for a worker (`listEnrollmentsForWorker`).
		index('idx_worker_enrollments_worker').on(table.workerId),
	],
);
