import { describe, expect, it } from 'vitest';

import { describeWorkerSupervision } from '@/lib/worker-supervision-states.js';

import { WORKER_SUPERVISION_STATES } from '../../../src/lib/worker-supervision.js';

describe('describeWorkerSupervision', () => {
	// The whole reason this vocabulary exists: the explanation used to be one paragraph
	// shown to every reader, so a machine reading `Not supervised` was handed a
	// definition of all three states.
	it('describes each state in its own terms', () => {
		expect(describeWorkerSupervision('supervised').label).toBe('Supervised');
		expect(describeWorkerSupervision('unsupervised').label).toBe('Not supervised');
		expect(describeWorkerSupervision('unknown').label).toBe('Unknown');

		const descriptions = WORKER_SUPERVISION_STATES.map(
			(state) => describeWorkerSupervision(state).description,
		);
		expect(new Set(descriptions).size).toBe(WORKER_SUPERVISION_STATES.length);
	});

	// What an operator needs on seeing this is what follows from it, not what it means.
	it('tells a machine nothing will restart what it costs them', () => {
		expect(describeWorkerSupervision('unsupervised').description).toContain(
			"can't be updated from here",
		);
	});

	// Only the state an operator can act on carries a mark, so a fleet that merely
	// predates the field does not read as a fleet with a problem.
	it('marks only the state an operator can act on', () => {
		expect(describeWorkerSupervision('unsupervised').tone).toBe('caution');
		expect(describeWorkerSupervision('supervised').tone).toBe('neutral');
		expect(describeWorkerSupervision('unknown').tone).toBe('neutral');
	});

	// A newer control plane may report a state this bundle has never heard of; dropping
	// it would read as a machine that declared nothing.
	it('keeps the server’s own word for a state it does not know, and stays neutral', () => {
		const described = describeWorkerSupervision('containerised');

		expect(described.label).toBe('containerised');
		expect(described.tone).toBe('neutral');
		expect(described.description).toContain('does not know');
	});

	// The server's vocabulary is the source of truth; this file is a hand-kept mirror,
	// so a state added there must not silently fall through to the unknown branch.
	it('covers every state the server can declare', () => {
		for (const state of WORKER_SUPERVISION_STATES) {
			expect(describeWorkerSupervision(state).description).not.toContain('does not know');
		}
	});
});
