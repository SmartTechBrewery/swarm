import { describe, expect, it, vi } from 'vitest';

import type { AgentCliResult } from '@/harness/agent-cli.js';
import { AgentRunError } from '@/harness/agent-failure.js';
import type { ScmDeliveryProvider } from '@/scm/delivery.js';
import { DeliveryDeferredError } from '@/scm/delivery.js';
import { buildTaskAssignment } from '@/transport/assignment.js';
import { runAssignmentDbFree } from '@/transport/assignment-execution.js';
import type { AssignmentSink } from '@/transport/worker-client.js';
import type { AssignedPhaseInputs, PhaseRunResult } from '@/worker/consumer.js';
import { createMockTaskAssignmentInput } from '../../helpers/factories.js';

const OPERATOR_TOKEN = 'operator-token';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function agentResult(overrides: Partial<AgentCliResult> = {}): AgentCliResult {
	return {
		cli: 'claude',
		exitCode: 0,
		signal: null,
		stdout: '',
		stderr: '',
		durationMs: 100,
		timedOut: false,
		aborted: false,
		outputTruncated: false,
		...overrides,
	};
}

function recordingSink(): AssignmentSink & { sent: Array<Record<string, unknown>> } {
	const sent: Array<Record<string, unknown>> = [];
	return {
		sent,
		send(frame) {
			sent.push(frame as unknown as Record<string, unknown>);
		},
	};
}

/** A `respond-to-ci` assignment carrying the PR coordinates the phase needs. */
function ciAssignment(overrides: Parameters<typeof createMockTaskAssignmentInput>[0] = {}) {
	return buildTaskAssignment(
		createMockTaskAssignmentInput({
			phase: 'respond-to-ci',
			workItem: undefined,
			pr: { prNumber: '99', prBranch: 'issue-17', headSha: 'deadbeef' },
			...overrides,
		}),
	);
}

/** A stub delivery so no real GitHub client is constructed. */
function stubDelivery(): ScmDeliveryProvider {
	return {
		commitIdentity: { name: 'op', email: 'op@users.noreply.github.com' },
		findPullRequest: async () => undefined,
		createPullRequest: async () => ({ number: 1, url: 'u' }),
		pushBranch: async () => {},
		submitReview: async () => 1,
		postComment: async () => 1,
	};
}

/** Default deps: a phase runner that streams one line via the base runner, plus a stub delivery. */
function depsWith(
	runPhase: (inputs: AssignedPhaseInputs) => Promise<PhaseRunResult>,
	buildDelivery: (repo: string, token: string) => Promise<ScmDeliveryProvider> = async () =>
		stubDelivery(),
) {
	return {
		runPhase,
		buildDelivery,
		baseRunAgent: vi.fn(async (options: { onStdout?: (l: string) => void }) => {
			options.onStdout?.('working…');
			return agentResult();
		}) as never,
		logger: silentLogger,
	};
}

describe('runAssignmentDbFree', () => {
	it('acks, reports running, streams output, and settles succeeded for a source-only phase', async () => {
		const sink = recordingSink();
		const buildDelivery = vi.fn(async () => stubDelivery());
		const runPhase = vi.fn(async (inputs: AssignedPhaseInputs) => ({
			agent: await inputs.runAgent({ cli: 'claude', args: [], cwd: '/tmp' }),
		}));
		await runAssignmentDbFree(ciAssignment(), sink, {
			operatorToken: OPERATOR_TOKEN,
			deps: depsWith(runPhase, buildDelivery),
		});

		const types = sink.sent.map((f) => f.type);
		expect(types[0]).toBe('task-assignment-ack');
		expect(sink.sent[0]).toMatchObject({ duplicate: false });
		expect(types).toContain('task-progress');
		expect(types).toContain('stream-log');
		expect(sink.sent.at(-1)).toMatchObject({
			type: 'task-execution-result',
			status: 'succeeded',
			phase: 'respond-to-ci',
		});
		// Delivery was built from the reconstructed project's repo + the operator token.
		expect(buildDelivery).toHaveBeenCalledWith('jkwiecien/swarm', OPERATOR_TOKEN);
		// The phase received the injected operator-token delivery + agent token.
		const inputs = runPhase.mock.calls[0][0];
		expect(inputs.agentToken).toBe(OPERATOR_TOKEN);
		expect(inputs.delivery).toBeDefined();
	});

	it('injects the operator delivery into resolve-conflicts too', async () => {
		const sink = recordingSink();
		const runPhase = vi.fn(async (_inputs: AssignedPhaseInputs) => ({ agent: agentResult() }));
		const assignment = buildTaskAssignment(
			createMockTaskAssignmentInput({
				phase: 'resolve-conflicts',
				workItem: undefined,
				pr: {
					prNumber: '99',
					prBranch: 'issue-17',
					headSha: 'deadbeef',
					baseBranch: 'main',
					baseSha: 'cafe',
				},
			}),
		);
		await runAssignmentDbFree(assignment, sink, {
			operatorToken: OPERATOR_TOKEN,
			deps: depsWith(runPhase),
		});

		expect(sink.sent.at(-1)).toMatchObject({ status: 'succeeded', phase: 'resolve-conflicts' });
		expect(runPhase.mock.calls[0][0].delivery).toBeDefined();
	});

	it('fails an unsupported phase cleanly with the gate message and never runs it', async () => {
		const sink = recordingSink();
		const runPhase = vi.fn();
		const buildDelivery = vi.fn(async () => stubDelivery());
		await runAssignmentDbFree(
			buildTaskAssignment(createMockTaskAssignmentInput({ phase: 'implementation' })),
			sink,
			{ operatorToken: OPERATOR_TOKEN, deps: depsWith(runPhase as never, buildDelivery) },
		);

		expect(runPhase).not.toHaveBeenCalled();
		// The gate fails before any delivery is built (no GitHub client, no DB).
		expect(buildDelivery).not.toHaveBeenCalled();
		expect(sink.sent.at(-1)).toMatchObject({ type: 'task-execution-result', status: 'failed' });
		expect(String((sink.sent.at(-1) as Record<string, unknown>).error)).toMatch(
			/phase implementation is not yet runnable on a DB-free worker/i,
		);
	});

	it('is idempotent: a re-pushed dispatch already running acks duplicate and starts no second run', async () => {
		const inFlight = new Set<string>();
		const sink = recordingSink();
		let releaseFirst: (() => void) | undefined;
		const runPhase = vi.fn(
			() =>
				new Promise<PhaseRunResult>((resolve) => {
					releaseFirst = () => resolve({ agent: agentResult() });
				}),
		);
		const frame = ciAssignment();

		const first = runAssignmentDbFree(frame, sink, {
			operatorToken: OPERATOR_TOKEN,
			inFlight,
			deps: depsWith(runPhase),
		});
		await Promise.resolve();
		await runAssignmentDbFree(frame, sink, {
			operatorToken: OPERATOR_TOKEN,
			inFlight,
			deps: depsWith(runPhase),
		});

		expect(sink.sent.some((f) => f.type === 'task-assignment-ack' && f.duplicate === true)).toBe(
			true,
		);
		expect(runPhase).toHaveBeenCalledTimes(1);

		releaseFirst?.();
		await first;
	});

	it('settles deferred (delivery) for a DeliveryDeferredError, resuming delivery', async () => {
		const sink = recordingSink();
		const runPhase = vi.fn(async () => {
			throw new DeliveryDeferredError('push failed', { cause: new Error('remote rejected') });
		});
		await runAssignmentDbFree(ciAssignment(), sink, {
			operatorToken: OPERATOR_TOKEN,
			deps: depsWith(runPhase),
		});

		expect(sink.sent.at(-1)).toMatchObject({
			type: 'task-execution-result',
			status: 'deferred',
			failureKind: 'delivery',
			resumeDelivery: true,
		});
	});

	it('settles deferred with a retry hint for a rate-limit agent error', async () => {
		const sink = recordingSink();
		const runPhase = vi.fn(async () => {
			throw new AgentRunError('rate limited', { kind: 'rate-limit' }, agentResult({ exitCode: 1 }));
		});
		await runAssignmentDbFree(ciAssignment(), sink, {
			operatorToken: OPERATOR_TOKEN,
			deps: depsWith(runPhase),
		});

		const result = sink.sent.at(-1) as Record<string, unknown>;
		expect(result).toMatchObject({
			status: 'deferred',
			failureKind: 'rate-limit',
			resumable: true,
		});
		expect(result.retryDelayMs as number).toBeGreaterThan(0);
	});

	it('settles terminally failed for a generic error', async () => {
		const sink = recordingSink();
		const runPhase = vi.fn(async () => {
			throw new Error('boom');
		});
		await runAssignmentDbFree(ciAssignment(), sink, {
			operatorToken: OPERATOR_TOKEN,
			deps: depsWith(runPhase),
		});

		expect(sink.sent.at(-1)).toMatchObject({ status: 'failed', error: 'boom' });
	});

	it('routes a timed-out run through the failure path even when it exited 0', async () => {
		const sink = recordingSink();
		const runPhase = vi.fn(async () => ({
			agent: agentResult({ timedOut: true, exitCode: null }),
		}));
		await runAssignmentDbFree(ciAssignment(), sink, {
			operatorToken: OPERATOR_TOKEN,
			deps: depsWith(runPhase),
		});

		expect(sink.sent.at(-1)).toMatchObject({ status: 'deferred', failureKind: 'timeout' });
	});
});
