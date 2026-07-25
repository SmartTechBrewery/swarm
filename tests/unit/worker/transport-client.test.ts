import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectConfig } from '@/config/schema.js';
import type { AgentCliResult } from '@/harness/agent-cli.js';
import { AgentRunError } from '@/harness/agent-failure.js';
import { DependencyBlockedError } from '@/pipeline/dependency-guard.js';
import { DeliveryDeferredError } from '@/scm/delivery.js';
import { buildTaskAssignment } from '@/transport/assignment.js';
import type { AssignmentSink } from '@/transport/worker-client.js';
import type { AssignedPhaseInputs, PhaseRunResult } from '@/worker/consumer.js';
import {
	createAssignmentRunAgent,
	fromAssignedWorkItem,
	runAssignment,
} from '@/worker/transport-client.js';
import {
	createMockProjectConfig,
	createMockTaskAssignmentInput,
	createMockWorkItem,
} from '../../helpers/factories.js';

// Cancellation rides Redis; mock it so the cancelled-settlement path is testable
// without a live datastore. Everything else is injected through `runAssignment`'s
// deps, so no DB is touched.
const { isRunCancellationRequested } = vi.hoisted(() => ({
	isRunCancellationRequested: vi.fn<(runId: string) => Promise<boolean>>(),
}));
vi.mock('@/queue/cancellation.js', () => ({
	isRunCancellationRequested,
	clearRunCancellation: vi.fn(async () => {}),
	RUN_CANCELLED_MESSAGE: 'Run cancelled after a cancellation request.',
}));

const RUN_ID = '77777777-7777-4777-8777-777777777777';

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

/** A sink that records every worker→cloud frame the executor sends. */
function recordingSink(): AssignmentSink & { sent: Array<Record<string, unknown>> } {
	const sent: Array<Record<string, unknown>> = [];
	return {
		sent,
		send(frame) {
			sent.push(frame as unknown as Record<string, unknown>);
		},
	};
}

function assignment(overrides: Parameters<typeof createMockTaskAssignmentInput>[0] = {}) {
	return buildTaskAssignment(createMockTaskAssignmentInput(overrides));
}

function depsWith(
	runPhase: (inputs: AssignedPhaseInputs) => Promise<PhaseRunResult>,
	loadProject: (id: string) => Promise<ProjectConfig | undefined> = async () =>
		createMockProjectConfig(),
) {
	return { loadProject, runPhase, logger: silentLogger };
}

describe('runAssignment', () => {
	beforeEach(() => {
		isRunCancellationRequested.mockReset();
		isRunCancellationRequested.mockResolvedValue(false);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('acks, reports running, and settles succeeded with the agent exit metadata', async () => {
		const sink = recordingSink();
		const runPhase = vi.fn(async () => ({
			agent: agentResult({ exitCode: 0, durationMs: 4321 }),
		}));
		await runAssignment(assignment(), sink, { deps: depsWith(runPhase) });

		const types = sink.sent.map((f) => f.type);
		expect(types).toEqual(['task-assignment-ack', 'task-progress', 'task-execution-result']);
		expect(sink.sent[0]).toMatchObject({ type: 'task-assignment-ack', duplicate: false });
		expect(sink.sent[1]).toMatchObject({ type: 'task-progress', state: 'running' });
		expect(sink.sent[2]).toMatchObject({
			type: 'task-execution-result',
			status: 'succeeded',
			phase: 'planning',
			taskId: '17',
			exitCode: 0,
			durationMs: 4321,
		});
		expect(runPhase).toHaveBeenCalledTimes(1);
	});

	it('settles deferred with the retry hint for a rate-limit agent error', async () => {
		const sink = recordingSink();
		const runPhase = vi.fn(async () => {
			throw new AgentRunError('rate limited', { kind: 'rate-limit' }, agentResult({ exitCode: 1 }));
		});
		await runAssignment(assignment(), sink, { deps: depsWith(runPhase) });

		const result = sink.sent.at(-1) as Record<string, unknown>;
		expect(result).toMatchObject({
			type: 'task-execution-result',
			status: 'deferred',
			failureKind: 'rate-limit',
			resumable: true,
		});
		expect(typeof result.retryDelayMs).toBe('number');
		expect(result.retryDelayMs as number).toBeGreaterThan(0);
	});

	it('settles deferred (delivery) for a DeliveryDeferredError, resuming delivery', async () => {
		const sink = recordingSink();
		const runPhase = vi.fn(async () => {
			throw new DeliveryDeferredError('push failed', { cause: new Error('remote rejected') });
		});
		await runAssignment(assignment(), sink, { deps: depsWith(runPhase) });

		expect(sink.sent.at(-1)).toMatchObject({
			type: 'task-execution-result',
			status: 'deferred',
			failureKind: 'delivery',
			resumeDelivery: true,
		});
	});

	it('settles deferred (dependency) for a DependencyBlockedError, reporting the blockers', async () => {
		const sink = recordingSink();
		const workItem = createMockWorkItem();
		const blocker = {
			reference: '#319',
			url: 'https://github.com/jkwiecien/swarm/issues/319',
			title: 'Session auth',
			open: true,
			source: 'dependency' as const,
		};
		const runPhase = vi.fn(async () => {
			throw new DependencyBlockedError(workItem, [blocker]);
		});
		await runAssignment(assignment({ phase: 'implementation' }), sink, {
			deps: depsWith(runPhase),
		});

		// Both executors share `deferrableOrFailedResult`, so the same-host path defers
		// on a blocked prerequisite too rather than settling failed (issue #438).
		const result = sink.sent.at(-1) as Record<string, unknown>;
		expect(result).toMatchObject({
			type: 'task-execution-result',
			status: 'deferred',
			failureKind: 'dependency',
			resumable: false,
		});
		expect(result.blockers).toEqual([blocker]);
		expect(result.reason).toContain('#319');
	});

	it('settles terminally failed for a generic error', async () => {
		const sink = recordingSink();
		const runPhase = vi.fn(async () => {
			throw new Error('boom');
		});
		await runAssignment(assignment(), sink, { deps: depsWith(runPhase) });

		expect(sink.sent.at(-1)).toMatchObject({
			type: 'task-execution-result',
			status: 'failed',
			error: 'boom',
		});
	});

	it('routes a timed-out run through the failure path even when it exited 0', async () => {
		const sink = recordingSink();
		const runPhase = vi.fn(async () => ({
			agent: agentResult({ timedOut: true, exitCode: null }),
		}));
		await runAssignment(assignment(), sink, { deps: depsWith(runPhase) });

		// A genuinely interrupted timeout (non-zero/absent exit) is deferrable.
		expect(sink.sent.at(-1)).toMatchObject({
			type: 'task-execution-result',
			status: 'deferred',
			failureKind: 'timeout',
		});
	});

	it('settles a user termination as failed+cancelled, never deferred', async () => {
		isRunCancellationRequested.mockResolvedValue(true);
		const sink = recordingSink();
		const runPhase = vi.fn(async () => {
			// A user termination surfaces as an aborted run (would otherwise defer).
			throw new AgentRunError('aborted', { kind: 'aborted' }, agentResult({ exitCode: null }));
		});
		await runAssignment(assignment({ runId: RUN_ID }), sink, { deps: depsWith(runPhase) });

		expect(sink.sent.at(-1)).toMatchObject({
			type: 'task-execution-result',
			status: 'failed',
			cancelled: true,
		});
	});

	it('settles failed when the assignment references an unknown project', async () => {
		const sink = recordingSink();
		const runPhase = vi.fn();
		await runAssignment(assignment(), sink, {
			deps: depsWith(runPhase as never, async () => undefined),
		});

		expect(runPhase).not.toHaveBeenCalled();
		expect(sink.sent.at(-1)).toMatchObject({ type: 'task-execution-result', status: 'failed' });
		expect(String((sink.sent.at(-1) as Record<string, unknown>).error)).toMatch(/unknown project/);
	});

	it('is idempotent: a re-pushed dispatch already running is acked as a duplicate, not re-run', async () => {
		const inFlight = new Set<string>();
		const sink = recordingSink();
		// A phase that never settles, so the first assignment stays in-flight.
		let releaseFirst: (() => void) | undefined;
		const runPhase = vi.fn(
			() =>
				new Promise<PhaseRunResult>((resolve) => {
					releaseFirst = () => resolve({ agent: agentResult() });
				}),
		);
		const frame = assignment();

		const first = runAssignment(frame, sink, { inFlight, deps: depsWith(runPhase) });
		await Promise.resolve();
		// Re-push the same dispatch while the first is still running.
		await runAssignment(frame, sink, { inFlight, deps: depsWith(runPhase) });

		const dupAck = sink.sent.find((f) => f.type === 'task-assignment-ack' && f.duplicate === true);
		expect(dupAck).toBeDefined();
		expect(runPhase).toHaveBeenCalledTimes(1);

		releaseFirst?.();
		await first;
	});

	it('reports the implementation branch checkpoint as a task-progress frame', async () => {
		const sink = recordingSink();
		const runPhase = vi.fn(async (inputs: AssignedPhaseInputs) => {
			await inputs.onBranchProvisioned?.();
			return { agent: agentResult() };
		});
		await runAssignment(assignment({ phase: 'implementation' }), sink, {
			deps: depsWith(runPhase),
		});

		expect(
			sink.sent.some((f) => f.type === 'task-progress' && f.state === 'branch-provisioned'),
		).toBe(true);
	});
});

describe('createAssignmentRunAgent', () => {
	it('forwards agent output as a batched stream-log frame and returns the run result', async () => {
		const sink = recordingSink();
		const frame = assignment({ runId: RUN_ID });
		const result = agentResult({ exitCode: 0 });
		// A fake base runner that emits two lines then resolves — no real CLI/DB.
		const base: ReturnType<typeof createAssignmentRunAgent> = async (options) => {
			options.onStdout?.('planning…');
			options.onStderr?.('a warning');
			return result;
		};

		const runAgent = createAssignmentRunAgent(frame, sink, base);
		const returned = await runAgent({ cli: 'claude', args: [], cwd: '/tmp' });

		expect(returned).toBe(result);
		const streamLog = sink.sent.find((f) => f.type === 'stream-log') as
			| Record<string, unknown>
			| undefined;
		expect(streamLog).toBeDefined();
		expect(streamLog?.dispatchId).toBe(frame.dispatchId);
		expect(streamLog?.runId).toBe(RUN_ID);
		const lines = streamLog?.lines as Array<{ stream: string; content: string }>;
		expect(lines.map((l) => l.stream)).toEqual(['stdout', 'stderr']);
		expect(lines[0].content).toBe('planning…\n');
	});
});

describe('fromAssignedWorkItem', () => {
	it('round-trips the transport work-item subset back to a PM WorkItem', () => {
		const workItem = fromAssignedWorkItem({
			id: 'PVTI_1',
			title: 'Do it',
			description: 'body',
			url: 'https://example.com/1',
			status: 'Planning',
			statusId: '3fe662f4',
			labels: [{ id: 'LA_1', name: 'swarm', color: 'ededed' }],
			assignees: [{ handle: 'octocat', displayName: 'The Octocat' }],
		});
		expect(workItem).toMatchObject({
			id: 'PVTI_1',
			title: 'Do it',
			labels: [{ id: 'LA_1', name: 'swarm', color: 'ededed' }],
			assignees: [{ handle: 'octocat', displayName: 'The Octocat' }],
		});
	});
});
