import { describe, expect, it } from 'vitest';
import { isMaintenanceRun, PIPELINE_RUN_KIND } from './run-kind.js';

describe('isMaintenanceRun (issue #974)', () => {
	it('is false for pipeline work', () => {
		expect(isMaintenanceRun({ kind: PIPELINE_RUN_KIND })).toBe(false);
		expect(PIPELINE_RUN_KIND).toBe('pipeline');
	});

	it('is true for the one maintenance kind that exists', () => {
		expect(isMaintenanceRun({ kind: 'worker-update' })).toBe(true);
	});

	// The whole reason the predicate reads the discriminator positively: a second
	// maintenance kind is covered without this function — or any caller — being
	// edited, exactly as every server-side `kind = 'pipeline'` reader is.
	it('is true for a maintenance kind that does not exist yet', () => {
		expect(isMaintenanceRun({ kind: 'worker-reprovision' })).toBe(true);
	});
});
