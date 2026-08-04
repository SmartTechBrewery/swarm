import { describe, expect, it } from 'vitest';
import {
	ENROLLMENT_STATUS_LABELS,
	type RoutabilityInput,
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

describe('ENROLLMENT_STATUS_LABELS', () => {
	it('labels every approval state in operator terms rather than raw keys', () => {
		expect(ENROLLMENT_STATUS_LABELS).toEqual({
			pending: 'Pending approval',
			active: 'Approved',
			suspended: 'Suspended',
		});
	});
});
