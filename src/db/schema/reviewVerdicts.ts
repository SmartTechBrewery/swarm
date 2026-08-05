import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';

/**
 * The durable, restart-safe ledger backing the SWARM Review verdict safety
 * cap (issue #235). One logical delivery record per `(project, repository, PR,
 * head SHA)` — a "review slot" — reserved by the `pr-review` trigger
 * (`src/triggers/handlers/review.ts`) before the Review phase runs and marked
 * `submitted` by the phase itself (`src/pipeline/review.ts`) once
 * `ScmDeliveryProvider.submitReview` has returned/recovered a `reviewId`.
 *
 * `ordinal` numbers a PR's review slots (1 = the initial review, 2–3 = the two
 * permitted re-reviews); `reviewVerdictsRepository.ts` never creates a slot
 * past its `REVIEW_VERDICT_CAP`.
 * `state` starts `pending` (reserved, not yet known to have submitted),
 * flips to `submitted` once delivery confirms it, or `abandoned` when the
 * phase knows for certain the review was never submitted (freeing that
 * ordinal for a fresh attempt at the same head without "charging" the PR for
 * the failed retry — the cap counts only `submitted` slots, plus at most one
 * `pending` slot in flight at a time).
 *
 * `repository` denormalizes the owning project's `repo` (rather than joining
 * `projects` for every lookup), matching `runs.prNumber`/`runs.prTitle`'s
 * precedent of carrying PR-driven-phase context directly on the row.
 */
export const reviewVerdicts = pgTable(
	'review_verdicts',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		projectId: text('project_id')
			.notNull()
			.references(() => projects.id, { onDelete: 'cascade' }),
		repository: text('repository').notNull(),
		prNumber: text('pr_number').notNull(),
		headSha: text('head_sha').notNull(),
		/** This PR's review-slot number — 1 (initial) or 2–3 (the two permitted re-reviews). */
		ordinal: integer('ordinal').notNull(),
		/** `pending` (reserved) | `submitted` (delivered) | `abandoned` (known never submitted). */
		state: text('state').notNull().default('pending'),
		/** The submitted verdict (`gh pr review`'s three outcomes) once `state` is `submitted`. */
		verdict: text('verdict'),
		/** The submitted GitHub review's numeric id, once known. */
		reviewId: text('review_id'),
		reservedAt: timestamp('reserved_at').defaultNow().notNull(),
		submittedAt: timestamp('submitted_at'),
		/**
		 * When an operator deliberately forced the corrective cycle to continue past
		 * this slot's cap-reaching verdict ("Force re-review", issue #511). Set on
		 * the *capped* slot itself, so the override is recorded next to the verdict
		 * it overrides and a later operator can tell a cap-bypassed re-review from an
		 * ordinary automatic one. Each grant is worth exactly one extra reservation:
		 * `reserveReviewVerdict` raises the PR's effective cap by the number of
		 * granted-but-unconsumed overrides.
		 */
		capOverrideGrantedAt: timestamp('cap_override_granted_at'),
		/**
		 * When the extra slot {@link capOverrideGrantedAt} granted was actually taken
		 * by a reservation. Consumed inside the same advisory-locked transaction that
		 * creates that slot, so one grant can never license two reviews.
		 */
		capOverrideConsumedAt: timestamp('cap_override_consumed_at'),
	},
	(table) => [
		// One *active* record per head — the same-head retry/reuse identity the
		// reservation logic keys on (`reviewVerdictsRepository.ts`'s
		// `reserveReviewVerdict`). Partial (excludes `abandoned`) so a fresh
		// reservation for a head whose earlier attempt was abandoned doesn't
		// collide with that voided row.
		uniqueIndex('idx_review_verdicts_head')
			.on(table.projectId, table.repository, table.prNumber, table.headSha)
			.where(sql`${table.state} <> 'abandoned'`),
		// Every reservation/cap decision for a PR reads all its slots by this key.
		index('idx_review_verdicts_pr').on(table.projectId, table.repository, table.prNumber),
		// The Respond-to-review trigger resolves a submitted review's slot by id.
		index('idx_review_verdicts_review_id').on(table.reviewId),
	],
);
