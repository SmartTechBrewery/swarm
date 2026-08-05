import { describe, expect, it } from 'vitest';
import { ALL_TRIGGER_PHASES } from '../../../src/triggers/types.js';
import { enrollmentPhaseOptions, projectDisabledPhases } from './worker-enrollment-phases.js';

describe('projectDisabledPhases', () => {
	it('disables nothing when the project has no pipeline config', () => {
		expect(projectDisabledPhases(undefined)).toEqual([]);
	});

	it('disables nothing when the toggles are unset — an unset flag means the phase runs', () => {
		expect(projectDisabledPhases({ review: {}, respondToCi: {} })).toEqual([]);
	});

	it('names the phases the project turned off, in pipeline order', () => {
		expect(
			projectDisabledPhases({
				review: { enabled: false },
				respondToReview: { enabled: false },
				respondToCi: { enabled: false },
			}),
		).toEqual(['review', 'respond-to-review', 'respond-to-ci']);
	});

	it('never reports a phase that carries no project toggle', () => {
		const disabled = projectDisabledPhases({ respondToCi: { enabled: false } });
		expect(disabled).toEqual(['respond-to-ci']);
		expect(disabled).not.toContain('planning');
		expect(disabled).not.toContain('implementation');
		expect(disabled).not.toContain('resolve-conflicts');
	});
});

describe('enrollmentPhaseOptions', () => {
	it('offers every pipeline phase, in the pipeline’s own order', () => {
		const options = enrollmentPhaseOptions({
			allowedPhases: ['implementation'],
			supportedPhases: [...ALL_TRIGGER_PHASES],
			projectDisabledPhases: [],
		});

		expect(options.map((option) => option.phase)).toEqual([...ALL_TRIGGER_PHASES]);
		expect(options.filter((option) => option.allowed).map((option) => option.phase)).toEqual([
			'implementation',
		]);
		expect(options.every((option) => option.unavailable === null)).toBe(true);
	});

	it('says a phase the daemon does not declare can never run here', () => {
		const [planning] = enrollmentPhaseOptions({
			allowedPhases: ['implementation'],
			supportedPhases: ['implementation'],
			projectDisabledPhases: [],
		});

		expect(planning.phase).toBe('planning');
		expect(planning.unavailable).toMatch(/does not declare this phase/);
	});

	it('says a phase the project turned off is off for every worker', () => {
		const options = enrollmentPhaseOptions({
			allowedPhases: ['review'],
			supportedPhases: [...ALL_TRIGGER_PHASES],
			projectDisabledPhases: ['review'],
		});
		const review = options.find((option) => option.phase === 'review');

		// Still reported as allowed — the selection is the owner's and survives the
		// project's toggle; the reason is what explains why nothing runs.
		expect(review?.allowed).toBe(true);
		expect(review?.unavailable).toMatch(/turned off for every worker/);
	});

	it('states both reasons when a phase is undeclared *and* project-disabled', () => {
		const options = enrollmentPhaseOptions({
			allowedPhases: ['implementation'],
			supportedPhases: ['implementation'],
			projectDisabledPhases: ['review'],
		});
		const review = options.find((option) => option.phase === 'review');

		expect(review?.unavailable).toMatch(/does not declare this phase/);
		expect(review?.unavailable).toMatch(/turned off for every worker/);
	});
});
