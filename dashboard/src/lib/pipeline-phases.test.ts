import { describe, expect, it } from 'vitest';
import { ALL_TRIGGER_PHASES } from '../../../src/triggers/types.js';
import { sortPipelinePhases } from './pipeline-phases.js';

/**
 * The literal order a remote DB-free daemon declares today
 * (`SUPPORTED_DB_FREE_PHASES`, `src/transport/assignment-execution.ts` — a `Set`
 * written for the readability of its own doc comment). Every case that matters
 * feeds a shuffled list, so none of them can pass by the sort being an identity
 * over an already-canonical fixture.
 */
const AS_A_DAEMON_DECLARES_THEM = [
	'respond-to-ci',
	'resolve-conflicts',
	'implementation',
	'review',
	'respond-to-review',
	'planning',
];

describe('sortPipelinePhases', () => {
	it('puts a shuffled declaration into the pipeline’s own order', () => {
		const sorted = sortPipelinePhases(AS_A_DAEMON_DECLARES_THEM);

		expect(sorted).toEqual([...ALL_TRIGGER_PHASES]);
		// The input really was out of order, so equalling the canonical list above is
		// the sort's doing rather than the fixture's.
		expect(sorted).not.toEqual(AS_A_DAEMON_DECLARES_THEM);
	});

	it('keeps a declared subset a subset, in canonical relative order', () => {
		// The version-skew case (issue #467): nothing stands in for a phase the
		// machine does not declare.
		expect(sortPipelinePhases(['resolve-conflicts', 'implementation'])).toEqual([
			'implementation',
			'resolve-conflicts',
		]);
		expect(sortPipelinePhases(['review', 'planning', 'respond-to-ci'])).toEqual([
			'planning',
			'review',
			'respond-to-ci',
		]);
	});

	it('keeps a value outside the vocabulary, after every phase it knows', () => {
		expect(sortPipelinePhases(['seventh-phase', 'review', 'planning'])).toEqual([
			'planning',
			'review',
			'seventh-phase',
		]);
	});

	it('leaves two unknown values in the order they arrived', () => {
		expect(sortPipelinePhases(['eighth-phase', 'seventh-phase', 'planning'])).toEqual([
			'planning',
			'eighth-phase',
			'seventh-phase',
		]);
	});

	it('does not mutate the caller’s array — it is a React prop', () => {
		const declared = [...AS_A_DAEMON_DECLARES_THEM];
		sortPipelinePhases(declared);
		expect(declared).toEqual(AS_A_DAEMON_DECLARES_THEM);
	});

	it('returns nothing for a machine that declared nothing', () => {
		expect(sortPipelinePhases([])).toEqual([]);
	});
});
