import type { WorkerEnrollmentStatus } from '@/types/workers.js';

/**
 * How the worker detail view (issue #477) explains one enrollment's routability.
 * `isRoutable = status === 'active' && sharingConsent` is the whole predicate the
 * dispatch gate reads (`src/identity/worker-enrollment.ts`), so a machine that
 * isn't taking work in a project fails it for one of exactly two reasons — and an
 * operator needs to be told *which*, since the two have different owners: the
 * project administrator approves, the worker's owner shares.
 *
 * One reason sits outside that predicate and is answered here too: the machine's
 * checkout not being this project's repository (issue #690, {@link
 * repositoryMismatch}), which is why the enrollment was refused or suspended in the
 * first place.
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

/**
 * The two repositories that disagree when the machine's declared checkout is not
 * this enrollment's project repository (issue #690) — the reason an enrollment was
 * refused at enrollment time, or suspended when the declaration arrived later — or
 * `null` when they agree or either is unknown. Returning the pair rather than a
 * boolean keeps the rule in one place and gives the caller the two non-null values
 * to render.
 *
 * Both sides reach the browser in the shared normalised `owner/repo` form, so plain
 * equality here is the same comparison the server makes (`repoSlugsMatch`,
 * `src/scm/repo-slug.ts`, which is not imported into this bundle because its slug
 * reader spawns `git`).
 *
 * Unknown on either side is **not** a mismatch: a machine that declared nothing —
 * one that never connected, a daemon on an older build, a checkout with no readable
 * `origin` — must not read as one that declared the wrong thing, which is exactly
 * the rule the server's write path and suspension pass apply.
 *
 * Deliberately separate from {@link routabilityBlockers}: that answers the
 * two-condition routability predicate the dispatch gate reads, while this is a fact
 * about the machine's checkout that blocks work at the daemon whatever the
 * enrollment's status says.
 */
export function repositoryMismatch(
	declaredRepository: string | null,
	projectRepository: string | null,
): { declaredRepository: string; projectRepository: string } | null {
	if (!declaredRepository || !projectRepository) return null;
	if (declaredRepository === projectRepository) return null;
	return { declaredRepository, projectRepository };
}
