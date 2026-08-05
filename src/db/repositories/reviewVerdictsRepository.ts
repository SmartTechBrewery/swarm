/**
 * The SWARM Review verdict safety-cap ledger (issue #235) — an atomic,
 * restart-safe record of how many formal reviews a PR has received, so a
 * PR/head retry never "charges" a second slot and no more than
 * {@link REVIEW_VERDICT_CAP} verdicts are ever submitted for one PR.
 *
 * {@link reserveReviewVerdict} is the only writer that creates a slot, and it
 * serializes every reservation decision for a PR behind a Postgres
 * transaction-scoped advisory lock keyed on `(projectId, repository,
 * prNumber)` (`pg_advisory_xact_lock`, released automatically at commit/
 * rollback) — so two workers racing to review the same PR can never both
 * allocate the last slot. Within that lock: a retry of an already-reserved
 * head reuses its existing record (`reused`); a different head is blocked
 * while another reservation for this PR is still `pending` (`blocked`, since
 * exactly one review is ever in flight per PR); once {@link REVIEW_VERDICT_CAP}
 * `submitted` records exist, a further reservation is rejected (`capped`);
 * otherwise a fresh `pending` record is created at the next ordinal
 * (`reserved`).
 *
 * `pending` state is not itself a submitted verdict — the cap counts only
 * `submitted` records (or an in-flight `pending` one, via the `blocked`
 * case), so a same-head retry after a failure that's known to have never
 * reached submission ({@link abandonReviewVerdict}) doesn't cost the PR its
 * slot.
 *
 * **Operator cap overrides (issue #511).** {@link REVIEW_VERDICT_CAP} is the
 * *automatic* cap: nothing SWARM does on its own raises it. An operator who
 * deliberately forces the corrective cycle to continue past a cap-reaching
 * `request-changes` verdict ({@link grantReviewCapOverride}, the "Force
 * re-review" action) grants that PR exactly one extra slot, recorded on the
 * capped record itself. {@link reserveReviewVerdict} spends one such grant —
 * inside the same advisory-locked transaction that creates the slot, so a grant
 * can never license two reviews — and the raised ordinal still trips
 * {@link isCapReachingRequestChanges}, so the forced pass stops the automatic
 * cycle again rather than reopening it.
 */

import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { getDb } from '../client.js';
import { reviewVerdicts } from '../schema/reviewVerdicts.js';

/**
 * No PR may receive more than this many *automatically* submitted SWARM Review
 * verdicts — an initial review plus at most two re-reviews. The one place the
 * cap is defined: every reservation decision, "is this the last permitted
 * verdict?" check, and doc reference derives from it. An explicit operator
 * override ({@link grantReviewCapOverride}) adds one slot on top per grant; it
 * never changes this number.
 */
export const REVIEW_VERDICT_CAP = 3;

export type ReviewVerdictState = 'pending' | 'submitted' | 'abandoned';

/** The natural key identifying one PR's review slots (or one specific head's slot). */
export interface ReviewVerdictKey {
	projectId: string;
	repository: string;
	prNumber: string;
	headSha: string;
}

export type ReviewVerdictReservation =
	/** `capOverride` marks a slot that only exists because an operator forced it (issue #511). */
	| { status: 'reserved'; id: string; ordinal: number; capOverride?: true }
	| { status: 'reused'; id: string; ordinal: number; state: 'pending' | 'submitted' }
	| { status: 'blocked'; ordinal: number }
	| { status: 'capped' };

/**
 * Reserve (or reuse) this PR/head's review slot, serialized behind a
 * transaction-scoped Postgres advisory lock so concurrent reservations for
 * the same PR can't race past {@link REVIEW_VERDICT_CAP}. See the module header for
 * the full decision order.
 */
export async function reserveReviewVerdict(
	key: ReviewVerdictKey,
): Promise<ReviewVerdictReservation> {
	const { projectId, repository, prNumber, headSha } = key;
	return getDb().transaction(async (tx) => {
		// Scoped to the transaction: released automatically at commit/rollback, so
		// no explicit unlock is needed and a crashed worker can't leave it held.
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtextextended(${`${projectId}:${repository}:${prNumber}`}, 0))`,
		);

		const existing = await tx
			.select()
			.from(reviewVerdicts)
			.where(
				and(
					eq(reviewVerdicts.projectId, projectId),
					eq(reviewVerdicts.repository, repository),
					eq(reviewVerdicts.prNumber, prNumber),
				),
			)
			.orderBy(asc(reviewVerdicts.ordinal));

		// Abandoned slots are excluded from every decision below: they free their
		// ordinal for a fresh same-head attempt without permanently costing the PR
		// a slot (see the module header).
		const active = existing.filter((row) => row.state !== 'abandoned');

		const sameHead = active.find((row) => row.headSha === headSha);
		if (sameHead) {
			return {
				status: 'reused',
				id: sameHead.id,
				ordinal: sameHead.ordinal,
				state: sameHead.state as 'pending' | 'submitted',
			};
		}

		const pendingOther = active.find((row) => row.state === 'pending');
		if (pendingOther) {
			return { status: 'blocked', ordinal: pendingOther.ordinal };
		}

		// Past the automatic cap, the PR proceeds only on an operator's explicit
		// grant (issue #511) — and that grant is spent here, in the same lock that
		// creates the slot it pays for, so two racing reservations can never both
		// redeem it.
		const submittedCount = active.filter((row) => row.state === 'submitted').length;
		let capOverride = false;
		if (submittedCount >= REVIEW_VERDICT_CAP) {
			const grant = active.find(
				(row) => row.capOverrideGrantedAt !== null && row.capOverrideConsumedAt === null,
			);
			if (!grant) return { status: 'capped' };
			await tx
				.update(reviewVerdicts)
				.set({ capOverrideConsumedAt: new Date() })
				.where(eq(reviewVerdicts.id, grant.id));
			capOverride = true;
		}

		const ordinal = active.length + 1;
		const inserted = await tx
			.insert(reviewVerdicts)
			.values({ projectId, repository, prNumber, headSha, ordinal, state: 'pending' })
			.returning({ id: reviewVerdicts.id });
		return {
			status: 'reserved',
			id: inserted[0].id,
			ordinal,
			...(capOverride ? { capOverride: true as const } : {}),
		};
	});
}

/** Whether an operator's cap override was recorded, or why it could not be. */
export type ReviewCapOverrideResult = 'granted' | 'already-granted' | 'no-submitted-slot';

/**
 * Record an operator's deliberate decision to continue the corrective cycle past
 * this PR/head's cap-reaching verdict ("Force re-review", issue #511), granting
 * the PR exactly one extra review slot.
 *
 * Written on the *capped* record itself rather than a side table, so the
 * override sits next to the verdict it overrides and stays visible to anyone
 * reading the PR's ledger later. Idempotent by construction: the conditional
 * update only fires while no grant exists, so repeated clicks and concurrent
 * requests resolve to one grant and the loser is told so rather than adding a
 * second slot.
 */
export async function grantReviewCapOverride(
	key: ReviewVerdictKey,
): Promise<ReviewCapOverrideResult> {
	const match = and(
		eq(reviewVerdicts.projectId, key.projectId),
		eq(reviewVerdicts.repository, key.repository),
		eq(reviewVerdicts.prNumber, key.prNumber),
		eq(reviewVerdicts.headSha, key.headSha),
		eq(reviewVerdicts.state, 'submitted'),
	);
	const granted = await getDb()
		.update(reviewVerdicts)
		.set({ capOverrideGrantedAt: new Date() })
		.where(and(match, isNull(reviewVerdicts.capOverrideGrantedAt)))
		.returning({ id: reviewVerdicts.id });
	if (granted[0]) return 'granted';

	const existing = await getDb()
		.select({ id: reviewVerdicts.id })
		.from(reviewVerdicts)
		.where(match)
		.limit(1);
	return existing[0] ? 'already-granted' : 'no-submitted-slot';
}

/**
 * Mark this PR/head's reserved slot `submitted`, recording the verdict and
 * (once known) the GitHub review id. Idempotent by natural key — safe to call
 * again after a crash between GitHub delivery and this write (`src/pipeline/review.ts`),
 * repairing the ledger without submitting a second review. Returns the slot's
 * ordinal, or `undefined` if no record exists for this PR/head (a reservation
 * that was never made — a bug or a pre-ledger call site — not treated as
 * an error here; the caller decides how to react).
 */
export async function markReviewVerdictSubmitted(
	key: ReviewVerdictKey,
	data: { verdict: string; reviewId?: string },
): Promise<{ id: string; ordinal: number } | undefined> {
	const rows = await getDb()
		.update(reviewVerdicts)
		.set({
			state: 'submitted',
			verdict: data.verdict,
			reviewId: data.reviewId,
			submittedAt: new Date(),
		})
		.where(
			and(
				eq(reviewVerdicts.projectId, key.projectId),
				eq(reviewVerdicts.repository, key.repository),
				eq(reviewVerdicts.prNumber, key.prNumber),
				eq(reviewVerdicts.headSha, key.headSha),
				ne(reviewVerdicts.state, 'abandoned'),
			),
		)
		.returning({ id: reviewVerdicts.id, ordinal: reviewVerdicts.ordinal });
	return rows[0];
}

/**
 * Abandon this PR/head's reserved slot — only when the phase knows for
 * certain the review was never submitted (a failure before any delivery
 * progress existed; see `src/pipeline/review.ts`). Only touches a `pending`
 * record: a `submitted` slot is never abandoned, and an already-`abandoned`
 * one is a no-op. Frees the ordinal for a fresh reservation at the same head
 * without charging the PR a slot for the failed attempt.
 */
export async function abandonReviewVerdict(key: ReviewVerdictKey): Promise<void> {
	await getDb()
		.update(reviewVerdicts)
		.set({ state: 'abandoned' })
		.where(
			and(
				eq(reviewVerdicts.projectId, key.projectId),
				eq(reviewVerdicts.repository, key.repository),
				eq(reviewVerdicts.prNumber, key.prNumber),
				eq(reviewVerdicts.headSha, key.headSha),
				eq(reviewVerdicts.state, 'pending'),
			),
		);
}

export interface ReviewVerdictRecord {
	ordinal: number;
	state: ReviewVerdictState;
	verdict: string | null;
	headSha: string;
}

const reviewVerdictRecordColumns = {
	ordinal: reviewVerdicts.ordinal,
	state: reviewVerdicts.state,
	verdict: reviewVerdicts.verdict,
	headSha: reviewVerdicts.headSha,
};

/**
 * Resolve a submitted verdict's slot by its GitHub review id — the
 * Respond-to-review trigger's primary lookup (`src/triggers/handlers/respond-to-review.ts`)
 * for deciding whether this event is the cap-reaching last `request-changes`
 * verdict.
 */
export async function getReviewVerdictByReviewId(
	projectId: string,
	repository: string,
	reviewId: string,
): Promise<ReviewVerdictRecord | undefined> {
	const rows = await getDb()
		.select(reviewVerdictRecordColumns)
		.from(reviewVerdicts)
		.where(
			and(
				eq(reviewVerdicts.projectId, projectId),
				eq(reviewVerdicts.repository, repository),
				eq(reviewVerdicts.reviewId, reviewId),
			),
		)
		.limit(1);
	return rows[0] as ReviewVerdictRecord | undefined;
}

/**
 * Resolve a slot by PR/head — the Respond-to-review trigger's fallback lookup
 * for the narrow webhook race where the `pull_request_review` event arrives
 * before {@link markReviewVerdictSubmitted} has stored the review id.
 */
export async function getReviewVerdictByHead(
	projectId: string,
	repository: string,
	prNumber: string,
	headSha: string,
): Promise<ReviewVerdictRecord | undefined> {
	const rows = await getDb()
		.select(reviewVerdictRecordColumns)
		.from(reviewVerdicts)
		.where(
			and(
				eq(reviewVerdicts.projectId, projectId),
				eq(reviewVerdicts.repository, repository),
				eq(reviewVerdicts.prNumber, prNumber),
				eq(reviewVerdicts.headSha, headSha),
			),
		)
		.limit(1);
	return rows[0] as ReviewVerdictRecord | undefined;
}

/**
 * The most recent *submitted* review this PR already received at an *earlier*
 * head — the signal that turns the next Review run into a **re-review** (issue
 * #328). The Review phase reads this before building the reviewer's prompt: when
 * an earlier `request-changes` verdict exists, the run's job is only to verify
 * that verdict's requested changes, not to surface newly-noticed issues.
 *
 * Only `submitted` slots count (a `pending`/`abandoned` one never happened), and
 * the current head is excluded via `currentHeadSha` so a same-head retry of the
 * PR's first review isn't mistaken for a re-review. Returns the highest-ordinal
 * prior verdict, or `undefined` when this is the PR's first review.
 */
export async function getPriorSubmittedReview(
	projectId: string,
	repository: string,
	prNumber: string,
	currentHeadSha: string,
): Promise<ReviewVerdictRecord | undefined> {
	const rows = await getDb()
		.select(reviewVerdictRecordColumns)
		.from(reviewVerdicts)
		.where(
			and(
				eq(reviewVerdicts.projectId, projectId),
				eq(reviewVerdicts.repository, repository),
				eq(reviewVerdicts.prNumber, prNumber),
				eq(reviewVerdicts.state, 'submitted'),
				ne(reviewVerdicts.headSha, currentHeadSha),
			),
		)
		.orderBy(desc(reviewVerdicts.ordinal))
		.limit(1);
	return rows[0] as ReviewVerdictRecord | undefined;
}

/**
 * This PR/head's `submitted` slot with the fields the "Force re-review" service
 * needs (issue #511) — the review id it must point the forced Respond-to-review
 * run at, and whether an override was already granted from it. Deliberately its
 * own read rather than a widened {@link ReviewVerdictRecord}: that shape crosses
 * the DB-free worker's ledger transport (`src/pipeline/review-ledger.ts`), and
 * this operator-only lookup has no business on that wire.
 */
export interface SubmittedReviewSlot {
	ordinal: number;
	verdict: string | null;
	reviewId: string | null;
	capOverrideGrantedAt: Date | null;
	capOverrideConsumedAt: Date | null;
}

export async function getSubmittedReviewSlot(
	key: ReviewVerdictKey,
): Promise<SubmittedReviewSlot | undefined> {
	const rows = await getDb()
		.select({
			ordinal: reviewVerdicts.ordinal,
			verdict: reviewVerdicts.verdict,
			reviewId: reviewVerdicts.reviewId,
			capOverrideGrantedAt: reviewVerdicts.capOverrideGrantedAt,
			capOverrideConsumedAt: reviewVerdicts.capOverrideConsumedAt,
		})
		.from(reviewVerdicts)
		.where(
			and(
				eq(reviewVerdicts.projectId, key.projectId),
				eq(reviewVerdicts.repository, key.repository),
				eq(reviewVerdicts.prNumber, key.prNumber),
				eq(reviewVerdicts.headSha, key.headSha),
				eq(reviewVerdicts.state, 'submitted'),
			),
		)
		.limit(1);
	return rows[0];
}

/**
 * Whether `ordinal`/`verdict` together are the cap-reaching final
 * `request-changes` verdict — the one condition both the Review phase
 * (recording its own run's automation outcome, `src/pipeline/review.ts`) and
 * the Respond-to-review trigger (deciding whether to stop the automatic
 * cycle, `src/triggers/handlers/respond-to-review.ts`) must agree on.
 *
 * `>=`, not `===`: only an operator's explicit cap override (issue #511) can
 * produce an ordinal above {@link REVIEW_VERDICT_CAP}, and that forced pass must
 * stop the automatic cycle exactly like the one it continued — otherwise a
 * single override would reopen the cycle indefinitely. Below the cap nothing
 * changes.
 */
export function isCapReachingRequestChanges(
	ordinal: number | undefined,
	verdict: string | null | undefined,
): boolean {
	return ordinal !== undefined && ordinal >= REVIEW_VERDICT_CAP && verdict === 'request-changes';
}
