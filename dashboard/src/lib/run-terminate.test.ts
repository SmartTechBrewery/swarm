import { describe, expect, it } from 'vitest';
import {
	canTerminateRun,
	describeTerminateWait,
	terminateButtonLabel,
	terminateConfirmMessage,
} from './run-terminate.js';

describe('canTerminateRun', () => {
	it('allows terminate for a running or deferred run', () => {
		expect(canTerminateRun('running')).toBe(true);
		expect(canTerminateRun('deferred')).toBe(true);
	});

	it('allows terminate for a checkpointed run (issue #503)', () => {
		expect(canTerminateRun('checkpointed')).toBe(true);
	});

	it('disallows terminate for completed and failed runs', () => {
		expect(canTerminateRun('completed')).toBe(false);
		expect(canTerminateRun('failed')).toBe(false);
	});

	it('disallows terminate for an unknown status', () => {
		expect(canTerminateRun('whatever')).toBe(false);
	});
});

describe('terminateButtonLabel', () => {
	it('reads "Terminating…" while the mutation is pending', () => {
		expect(terminateButtonLabel(true)).toBe('Terminating…');
	});

	it('reads "Terminate" when idle', () => {
		expect(terminateButtonLabel(false)).toBe('Terminate');
	});

	it('names the wait once the request is accepted (issue #561)', () => {
		expect(terminateButtonLabel(false, true)).toBe('Waiting to stop…');
	});

	it('prefers the accepted request over the mutation, which it outlives', () => {
		expect(terminateButtonLabel(true, true)).toBe('Waiting to stop…');
	});
});

describe('describeTerminateWait (issue #561)', () => {
	it('says the request was recorded and what has to happen for it to take effect', () => {
		const copy = describeTerminateWait(true);
		expect(copy).toContain('was recorded');
		expect(copy).toContain('aborts the agent');
	});

	it('names the agent timeout as the outer bound when the run records one', () => {
		expect(describeTerminateWait(true)).toContain('outer bound');
	});

	it('offers the CLI escape instead of a bound when the run records no timeout', () => {
		const copy = describeTerminateWait(false);
		expect(copy).not.toContain('outer bound');
		expect(copy).toContain('swarm run reset <runId> --force');
	});
});

describe('terminateConfirmMessage', () => {
	it('describes cancelling the scheduled retry for a deferred run', () => {
		expect(terminateConfirmMessage('deferred')).toContain('scheduled retry');
	});

	it('describes stopping the running agent for a running run', () => {
		expect(terminateConfirmMessage('running')).toContain('running agent');
	});

	it('warns that a checkpointed run abandons its recorded remainder (issue #503)', () => {
		const message = terminateConfirmMessage('checkpointed');
		expect(message).toContain('scheduled continuation');
		expect(message).toContain('remaining');
		// Not the generic deferred copy — that would call it a scheduled *retry*.
		expect(message).not.toContain('scheduled retry');
	});
});
