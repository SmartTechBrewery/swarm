import type { WorkerEnrollmentStatus } from '@/types/workers.js';

/**
 * How the worker detail view (issue #477) explains one enrollment's routability.
 * `isRoutable = status === 'active' && sharingConsent` is the whole predicate the
 * dispatch gate reads (`src/identity/worker-enrollment.ts`), so a machine that
 * isn't taking work in a project fails it for one of exactly two reasons — and an
 * operator needs to be told *which*, since the two have different owners: the
 * project administrator approves, the worker's owner shares.
 */

/** The enrollment fields routability is derived from — narrower than the read model. */
export interface RoutabilityInput {
	status: WorkerEnrollmentStatus;
	sharingConsent: boolean;
	isRoutable: boolean;
}

/** Human labels for the approval axis, used by both the badge and the blocker text. */
export const ENROLLMENT_STATUS_LABELS: Record<WorkerEnrollmentStatus, string> = {
	pending: 'Pending approval',
	active: 'Approved',
	suspended: 'Suspended',
};

/**
 * Why this enrollment is not routable, one entry per unmet condition, naming who
 * can resolve it. Empty for a routable enrollment — and also empty in the
 * impossible case where the server reports `isRoutable` while a condition looks
 * unmet: the server's verdict is authoritative, and inventing a blocker it didn't
 * claim would be the dashboard contradicting the dispatch gate.
 */
export function routabilityBlockers(enrollment: RoutabilityInput): string[] {
	if (enrollment.isRoutable) return [];
	const blockers: string[] = [];
	if (enrollment.status === 'pending') {
		blockers.push('The enrollment is awaiting a project administrator’s approval.');
	}
	if (enrollment.status === 'suspended') {
		blockers.push('A project administrator suspended the enrollment.');
	}
	if (!enrollment.sharingConsent) {
		blockers.push('The worker’s owner has not shared this machine with the project.');
	}
	return blockers;
}
