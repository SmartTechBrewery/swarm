import { describe, expect, it } from 'vitest';
import {
	describeRolloutMemberState,
	describeRolloutStatus,
	tallyRolloutMemberStates,
} from './worker-rollout-states.js';

describe('describeRolloutMemberState (issue #1025)', () => {
	it('describes every member state the control plane can report', () => {
		for (const state of [
			'queued',
			'draining',
			'signalled',
			'verifying',
			'done',
			'skipped',
			'failed',
		]) {
			const copy = describeRolloutMemberState(state);
			expect(copy.label.length).toBeGreaterThan(0);
			expect(copy.description.length).toBeGreaterThan(0);
		}
	});

	it('keeps `skipped` honest — settled without being moved, never done', () => {
		const skipped = describeRolloutMemberState('skipped');
		expect(skipped.label).toBe('Skipped');
		// A machine enrolled in no project or running under no supervisor settles here,
		// and reading that as `done` would report a fleet as updated when it is not.
		expect(skipped.label).not.toBe(describeRolloutMemberState('done').label);
		expect(skipped.tone).toBe('caution');
		expect(skipped.description).toMatch(/without being moved/);
		expect(skipped.description).toMatch(/still on the build it had/);
	});

	it('reads a machine still in flight as neither good nor bad news', () => {
		for (const state of ['queued', 'draining', 'signalled', 'verifying']) {
			expect(describeRolloutMemberState(state).tone).toBe('neutral');
		}
		expect(describeRolloutMemberState('done').tone).toBe('positive');
		expect(describeRolloutMemberState('failed').tone).toBe('negative');
	});

	it('keeps the server’s own word for a state this build has never heard of', () => {
		// A newer control plane may report an eighth state; describing it is the only
		// honest answer, and dropping the machine would read as one nobody named.
		const unknown = describeRolloutMemberState('quarantined');
		expect(unknown.label).toBe('quarantined');
		expect(unknown.tone).toBe('neutral');
		expect(unknown.description).toMatch(/does not know/);
	});
});

describe('describeRolloutStatus (issue #1025)', () => {
	it('describes the three statuses a rollout has', () => {
		expect(describeRolloutStatus('in_progress').label).toBe('In progress');
		expect(describeRolloutStatus('halted').label).toBe('Halted');
		expect(describeRolloutStatus('halted').tone).toBe('negative');
		expect(describeRolloutStatus('completed').label).toBe('Completed');
		expect(describeRolloutStatus('completed').tone).toBe('positive');
	});

	it('says a halt is final and has no resume', () => {
		expect(describeRolloutStatus('halted').description).toMatch(/no resume/);
	});

	it('keeps the server’s own word for an unknown status too', () => {
		expect(describeRolloutStatus('paused').label).toBe('paused');
		expect(describeRolloutStatus('paused').tone).toBe('neutral');
	});
});

describe('tallyRolloutMemberStates (issue #1025)', () => {
	it('counts each state once, in the rollout’s own progression order', () => {
		expect(
			tallyRolloutMemberStates([
				{ state: 'done' },
				{ state: 'queued' },
				{ state: 'done' },
				{ state: 'draining' },
			]),
		).toEqual([
			{ state: 'queued', count: 1 },
			{ state: 'draining', count: 1 },
			{ state: 'done', count: 2 },
		]);
	});

	it('still counts a state this build does not know, after the ones it does', () => {
		expect(
			tallyRolloutMemberStates([{ state: 'quarantined' }, { state: 'done' }, { state: 'adopted' }]),
		).toEqual([
			{ state: 'done', count: 1 },
			{ state: 'adopted', count: 1 },
			{ state: 'quarantined', count: 1 },
		]);
	});

	it('answers an empty rollout with an empty tally', () => {
		expect(tallyRolloutMemberStates([])).toEqual([]);
	});
});
