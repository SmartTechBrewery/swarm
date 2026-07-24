import { describe, expect, it } from 'vitest';

import { AgentRunError } from '@/harness/agent-failure.js';
import { adaptResultToPhaseRun } from '@/router/dispatcher.js';
import { DeliveryDeferredError } from '@/scm/delivery.js';
import type { TaskExecutionResult } from '@/transport/protocol.js';
import type { DispatchSelection } from '@/worker/eligibility-gate.js';
import { RunTerminatedError } from '@/worker/run-cancellation.js';

const SELECTION: DispatchSelection = {
	workerId: 'w-1',
	workerName: 'ada-laptop',
	ownerUserId: 'user-1',
	target: { cli: 'claude' },
	targetIndex: 0,
	cli: 'claude',
	skippedClis: [],
};

const DISPATCH = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function base(overrides: Partial<TaskExecutionResult>): TaskExecutionResult {
	return {
		type: 'task-execution-result',
		dispatchId: DISPATCH,
		status: 'succeeded',
		phase: 'implementation',
		taskId: '407',
		...overrides,
	} as TaskExecutionResult;
}

describe('adaptResultToPhaseRun', () => {
	it('maps a succeeded result to a PhaseRunResult carrying the settle context', () => {
		const run = adaptResultToPhaseRun(
			base({
				status: 'succeeded',
				exitCode: 0,
				durationMs: 1234,
				movedTo: 'todo',
				verdict: 'approve',
				reviewOrdinal: 1,
				reviewAutomationOutcome: 'manual-intervention-required',
			}),
			SELECTION,
		);
		expect(run.agent).toMatchObject({
			cli: 'claude',
			exitCode: 0,
			durationMs: 1234,
			timedOut: false,
		});
		expect(run.movedTo).toBe('todo');
		expect(run.verdict).toBe('approve');
		expect(run.reviewOrdinal).toBe(1);
		expect(run.automationOutcome).toBe('manual-intervention-required');
	});

	it('throws RunTerminatedError for a cancelled failure (never a deferral)', () => {
		expect(() =>
			adaptResultToPhaseRun(
				base({ status: 'failed', cancelled: true, error: 'Run cancelled by user' }),
				SELECTION,
			),
		).toThrow(RunTerminatedError);
	});

	it('throws a terminal error for a non-cancelled failure', () => {
		expect(() =>
			adaptResultToPhaseRun(base({ status: 'failed', error: 'agent exited 1' }), SELECTION),
		).toThrow('agent exited 1');
	});

	it('throws DeliveryDeferredError for a delivery deferral', () => {
		expect(() =>
			adaptResultToPhaseRun(
				base({ status: 'deferred', failureKind: 'delivery', reason: 'push failed' }),
				SELECTION,
			),
		).toThrow(DeliveryDeferredError);
	});

	it('throws an AgentRunError carrying the reported failure kind for a deferral', () => {
		try {
			adaptResultToPhaseRun(
				base({ status: 'deferred', failureKind: 'rate-limit', reason: 'rate limited' }),
				SELECTION,
			);
			throw new Error('expected a throw');
		} catch (err) {
			expect(err).toBeInstanceOf(AgentRunError);
			expect((err as AgentRunError).failure.kind).toBe('rate-limit');
		}
	});

	it('keeps a genuinely-interrupted timeout deferrable (non-zero synthetic exit)', () => {
		try {
			adaptResultToPhaseRun(
				base({ status: 'deferred', failureKind: 'timeout', exitCode: 143 }),
				SELECTION,
			);
			throw new Error('expected a throw');
		} catch (err) {
			expect(err).toBeInstanceOf(AgentRunError);
			const agentErr = err as AgentRunError;
			expect(agentErr.failure.kind).toBe('timeout');
			// A non-zero exit is what keeps a timeout deferrable in `handlePhaseFailure`.
			expect(agentErr.agent?.exitCode).toBe(143);
		}
	});
});
