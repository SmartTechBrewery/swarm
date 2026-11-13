/**
 * Neutral wording for cancelled runs (issue #305): the dashboard must not assert
 * an unverified actor/origin for a run that stopped only because a durable
 * cancellation marker was found. The backend already records the neutral
 * message for new rows (`RUN_CANCELLED_MESSAGE` in `src/queue/cancellation.ts`);
 * this module normalises the one exact string historical rows persisted before
 * that change, so old rows read the same way without a DB rewrite.
 *
 * Origin display (issue #308) is separate, additive structured data
 * (`describeCancellationOrigin`): it's shown only when a cancellation origin
 * was actually recorded, never inferred from the marker's mere existence.
 */

import type { CancellationOrigin } from '@/types/runs.js';

/** The exact terminal message legacy cancelled runs persisted (pre-#305). */
const LEGACY_USER_TERMINATION_MESSAGE = 'Run terminated by user from the dashboard.';

/** The neutral wording the backend records now (mirrors `RUN_CANCELLED_MESSAGE`). */
export const RUN_CANCELLED_MESSAGE = 'Run cancelled after a cancellation request.';

/**
 * Render a run's error without asserting an unverified actor: rewrite the exact
 * legacy cancellation string to the neutral wording; pass everything else
 * through unchanged so genuine errors are never altered.
 */
export function normalizeRunError(error: string): string {
	return error === LEGACY_USER_TERMINATION_MESSAGE ? RUN_CANCELLED_MESSAGE : error;
}

/** The sentence each recorded origin source reads as (issue #1451 added the board move). */
const CANCELLATION_SOURCE_COPY: Record<CancellationOrigin['source'], string> = {
	dashboard: 'Cancelled via dashboard',
	api: 'Cancelled via API',
	'board-backlog': 'Cancelled because its board card was moved to Backlog',
};

/**
 * Describe a run's recorded cancellation origin, or `null` when there is none
 * to show — a marker-only (external/unknown) cancellation and every legacy row
 * have no origin, and this must never guess one from their absence.
 */
export function describeCancellationOrigin(
	origin: CancellationOrigin | null | undefined,
): string | null {
	if (!origin) return null;
	const base = CANCELLATION_SOURCE_COPY[origin.source];
	return origin.actor ? `${base} by ${origin.actor}` : base;
}
