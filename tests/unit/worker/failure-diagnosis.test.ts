import { describe, expect, it } from 'vitest';
import type { AgentCliResult } from '@/harness/agent-cli.js';
import type { ProposedScope } from '@/pipeline/planning.js';
import { diagnoseFailure, MIN_SCOPE_STALL_DURATION_MS } from '@/worker/failure-diagnosis.js';

const MULTI_CONCERN_SCOPE: ProposedScope = {
	whyOneTask: 'The concerns must be coordinated in one delivery.',
	independentConcerns: ['persist terminal diagnosis', 'render recovery guidance'],
	affectedAreas: ['worker', 'dashboard'],
	outOfScope: [],
};

function agent(overrides: Partial<AgentCliResult> = {}): AgentCliResult {
	return {
		cli: 'claude',
		exitCode: 1,
		signal: null,
		stdout: '',
		stderr: '',
		durationMs: MIN_SCOPE_STALL_DURATION_MS,
		timedOut: false,
		aborted: false,
		outputTruncated: false,
		...overrides,
	};
}

describe('diagnoseFailure (issue #269)', () => {
	it('labels a recognised stall as likely scope exceeded only with all supporting evidence', () => {
		const diagnosis = diagnoseFailure({
			failureKind: 'stalled',
			planningScope: MULTI_CONCERN_SCOPE,
			agent: agent({
				stdout: `${'x'.repeat(1_000)}\nError: timeout waiting for response`,
			}),
		});

		expect(diagnosis).toMatchObject({
			kind: 'likely-scope-exceeded',
			title: 'Likely scope exceeded',
			message:
				'The agent stalled after substantial progress. This task likely exceeds the single-task scope; narrow or split it before retrying.',
		});
	});

	it('remains provider-stalled-early with 993 bytes of preceding output and a real stall line', () => {
		const diagnosis = diagnoseFailure({
			failureKind: 'stalled',
			planningScope: MULTI_CONCERN_SCOPE,
			agent: agent({
				stdout: `${'x'.repeat(993)}\nError: timeout waiting for response`,
			}),
		});

		expect(diagnosis?.kind).toBe('provider-stalled-early');
	});

	it('keeps a short or minimally-output stall provider-oriented even when scope metadata exists', () => {
		const diagnosis = diagnoseFailure({
			failureKind: 'stalled',
			planningScope: MULTI_CONCERN_SCOPE,
			agent: agent({ durationMs: MIN_SCOPE_STALL_DURATION_MS - 1, stdout: 'brief output' }),
		});

		expect(diagnosis).toMatchObject({
			kind: 'provider-stalled-early',
			title: 'Provider stalled early',
			message:
				'The agent provider stalled before meaningful work began; retry later or use another configured provider.',
		});
	});

	// A control-plane stand-in whose frame reported no duration (issue #596) is no
	// evidence of substantial progress, so it must not support a scope claim.
	it('keeps a stall provider-oriented when the reported result carries no duration', () => {
		const { durationMs: _unreported, ...unreportedAgent } = agent({
			stdout: `${'x'.repeat(2_000)}\nError: timeout waiting for response`,
		});

		const diagnosis = diagnoseFailure({
			failureKind: 'stalled',
			planningScope: MULTI_CONCERN_SCOPE,
			agent: unreportedAgent,
		});

		expect(diagnosis?.kind).toBe('provider-stalled-early');
	});

	it('never turns a harness timeout alone into a scope conclusion', () => {
		const diagnosis = diagnoseFailure({
			failureKind: 'timeout',
			planningScope: MULTI_CONCERN_SCOPE,
			agent: agent({ stdout: 'x'.repeat(2_000), timedOut: true }),
		});

		expect(diagnosis?.kind).toBe('provider-stalled-early');
	});

	it.each([
		['provider-rate-limit', 'Known provider condition: quota or rate limit'],
		['provider-capacity', 'Known provider condition: model capacity'],
		['launch-or-authentication', 'Known provider condition: launch or authentication'],
		['worker-shutdown', 'Known condition: worker shutdown'],
		['user-terminated', 'Known condition: user termination'],
	] as const)('%s takes precedence over scope-looking evidence', (knownCondition, title) => {
		const diagnosis = diagnoseFailure({
			knownCondition,
			failureKind: 'stalled',
			planningScope: MULTI_CONCERN_SCOPE,
			agent: agent({ stdout: 'x'.repeat(2_000) }),
		});

		expect(diagnosis).toMatchObject({ kind: knownCondition, title });
	});
});
