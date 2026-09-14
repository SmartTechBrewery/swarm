import { describe, expect, it } from 'vitest';
import {
	ENROLLMENT_STATUS_LABELS,
	type RoutabilityInput,
	repositoryMismatch,
	routabilityBlockers,
} from './worker-enrollment-view.js';

function enrollment(overrides: Partial<RoutabilityInput> = {}): RoutabilityInput {
	return { status: 'active', sharingConsent: true, isRoutable: true, ...overrides };
}

describe('routabilityBlockers (issue #477)', () => {
	it('names no blocker for a routable enrollment', () => {
		expect(routabilityBlockers(enrollment())).toEqual([]);
	});

	it('names the pending approval, and says whose decision it is', () => {
		const [blocker] = routabilityBlockers(enrollment({ status: 'pending', isRoutable: false }));
		expect(blocker).toMatch(/project administrator/);
	});

	it('names a suspension separately from a never-approved enrollment', () => {
		const [blocker] = routabilityBlockers(enrollment({ status: 'suspended', isRoutable: false }));
		expect(blocker).toMatch(/suspended/);
	});

	it('names missing sharing consent, and says it is the owner’s', () => {
		const [blocker] = routabilityBlockers(enrollment({ sharingConsent: false, isRoutable: false }));
		expect(blocker).toMatch(/owner/);
	});

	it('names both axes when both are unmet — they are independent and both required', () => {
		expect(
			routabilityBlockers(
				enrollment({ status: 'pending', sharingConsent: false, isRoutable: false }),
			),
		).toHaveLength(2);
	});

	it('never contradicts the server: a routable enrollment gets no blocker whatever the fields say', () => {
		// Impossible per the server's own derivation, but the verdict is authoritative.
		expect(routabilityBlockers(enrollment({ sharingConsent: false, isRoutable: true }))).toEqual(
			[],
		);
	});
});

describe('repositoryMismatch (issue #690, widened by #946)', () => {
	it('returns the two repositories that disagree', () => {
		expect(repositoryMismatch('acme/frontend', ['acme/backend'])).toEqual({
			declaredRepository: 'acme/frontend',
			projectRepositories: ['acme/backend'],
		});
	});

	it('is null when the machine’s checkout is the project’s repository', () => {
		expect(repositoryMismatch('acme/frontend', ['acme/frontend'])).toBeNull();
	});

	// The case issue #946 made reachable: one worker per repository, several per
	// project — a machine on the project's *second* repository is correctly enrolled.
	it('is null when the project declares the machine’s checkout anywhere in its list', () => {
		expect(repositoryMismatch('acme/frontend', ['acme/backend', 'acme/frontend'])).toBeNull();
	});

	// So an operator can tell a typo from a repository the project simply does not own.
	it('names every repository the project declares when none of them matches', () => {
		expect(repositoryMismatch('acme/docs', ['acme/backend', 'acme/frontend'])).toEqual({
			declaredRepository: 'acme/docs',
			projectRepositories: ['acme/backend', 'acme/frontend'],
		});
	});

	// Unknown is not wrong: a machine that declared nothing must not read as one that
	// declared the wrong thing — the rule the server's own checks apply. An empty list
	// is the same kind of unknown: the project no longer resolves.
	it('is null when either side is unknown', () => {
		expect(repositoryMismatch(null, ['acme/backend'])).toBeNull();
		expect(repositoryMismatch('acme/frontend', [])).toBeNull();
		expect(repositoryMismatch(null, [])).toBeNull();
	});
});

describe('ENROLLMENT_STATUS_LABELS', () => {
	it('labels every approval state in operator terms rather than raw keys', () => {
		expect(ENROLLMENT_STATUS_LABELS).toEqual({
			pending: 'Pending approval',
			active: 'Approved',
			suspended: 'Suspended',
		});
	});
});
