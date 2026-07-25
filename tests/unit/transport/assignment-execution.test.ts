import { describe, expect, it, vi } from 'vitest';

import type { AgentCliResult } from '@/harness/agent-cli.js';
import { AgentRunError } from '@/harness/agent-failure.js';
import type { ScmDeliveryProvider } from '@/scm/delivery.js';
import { DeliveryDeferredError } from '@/scm/delivery.js';
import { buildTaskAssignment } from '@/transport/assignment.js';
import { runAssignmentDbFree } from '@/transport/assignment-execution.js';
import type { FetchLike } from '@/transport/delivery-client.js';
import { TRANSPORT_PROTOCOL_VERSION } from '@/transport/protocol.js';
import type { AssignmentSink } from '@/transport/worker-client.js';
import type { AssignedPhaseInputs, PhaseRunResult } from '@/worker/consumer.js';
import { createMockTaskAssignmentInput } from '../../helpers/factories.js';

const OPERATOR_TOKEN = 'operator-token';
const CONTROL_PLANE = 'https://swarm.example';
const WORKER_CREDENTIAL = 'raw-worker-credential-secret';
/** The project id `createMockProjectConfig` carries — every delivery call is scoped to it. */
const PROJECT_ID = 'swarm';

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
		findPullRequest: vi.fn(async () => undefined),
		createPullRequest: vi.fn(async () => ({ number: 1, url: 'u' })),
		pushBranch: vi.fn(async () => {}),
		submitReview: vi.fn(async () => 1),
		postComment: vi.fn(async () => 1),
	};
}

/** Default deps: a phase runner that streams one line via the base runner, plus a stub delivery. */
function depsWith(
	runPhase: (inputs: AssignedPhaseInputs) => Promise<PhaseRunResult>,
	buildDelivery: (repo: string, token: string) => Promise<ScmDeliveryProvider> = async () =>
		stubDelivery(),
	fetchImpl?: FetchLike,
) {
	return {
		runPhase,
		buildDelivery,
		fetchImpl,
		baseRunAgent: vi.fn(async (options: { onStdout?: (l: string) => void }) => {
			options.onStdout?.('working…');
			return agentResult();
		}) as never,
		logger: silentLogger,
	};
}

/** The transport coordinates every run needs: the operator token + this worker's own credential. */
const RUN_OPTIONS = {
	operatorToken: OPERATOR_TOKEN,
	controlPlaneUrl: CONTROL_PLANE,
	workerCredential: WORKER_CREDENTIAL,
} as const;

function jsonResponse(status: number, body: unknown): Awaited<ReturnType<FetchLike>> {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('runAssignmentDbFree', () => {
	it('acks, reports running, streams output, and settles succeeded for a source-only phase', async () => {
		const sink = recordingSink();
		const buildDelivery = vi.fn(async () => stubDelivery());
		const runPhase = vi.fn(async (inputs: AssignedPhaseInputs) => ({
			agent: await inputs.runAgent({ cli: 'claude', args: [], cwd: '/tmp' }),
		}));
		await runAssignmentDbFree(ciAssignment(), sink, {
			...RUN_OPTIONS,
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
		// The phase received the injected operator-token delivery + agent token, and no
		// PM provider — a source-only phase writes to no board.
		const inputs = runPhase.mock.calls[0][0];
		expect(inputs.agentToken).toBe(OPERATOR_TOKEN);
		expect(inputs.delivery).toBeDefined();
		expect(inputs.pm).toBeUndefined();
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
		await runAssignmentDbFree(assignment, sink, { ...RUN_OPTIONS, deps: depsWith(runPhase) });

		expect(sink.sent.at(-1)).toMatchObject({ status: 'succeeded', phase: 'resolve-conflicts' });
		expect(runPhase.mock.calls[0][0].delivery).toBeDefined();
	});

	it('fails an unsupported phase cleanly with the gate message and never runs it', async () => {
		const sink = recordingSink();
		const runPhase = vi.fn();
		const buildDelivery = vi.fn(async () => stubDelivery());
		// Planning's PM surface (create/update/label/find-comment + splitting) has no
		// DB-free seam, so it stays on the local host worker.
		await runAssignmentDbFree(
			buildTaskAssignment(createMockTaskAssignmentInput({ phase: 'planning' })),
			sink,
			{ ...RUN_OPTIONS, deps: depsWith(runPhase as never, buildDelivery) },
		);

		expect(runPhase).not.toHaveBeenCalled();
		// The gate fails before any delivery is built (no GitHub client, no DB).
		expect(buildDelivery).not.toHaveBeenCalled();
		expect(sink.sent.at(-1)).toMatchObject({ type: 'task-execution-result', status: 'failed' });
		expect(String((sink.sent.at(-1) as Record<string, unknown>).error)).toMatch(
			/phase planning is not yet runnable on a DB-free worker/i,
		);
	});

	it('still gates respond-to-review out — it needs a PM read no DB-free seam serves yet', async () => {
		const sink = recordingSink();
		const runPhase = vi.fn();
		await runAssignmentDbFree(
			ciAssignment({
				phase: 'respond-to-review',
				pr: { prNumber: '99', prBranch: 'issue-17', headSha: 'deadbeef', reviewId: '7' },
			}),
			sink,
			{ ...RUN_OPTIONS, deps: depsWith(runPhase as never) },
		);

		expect(runPhase).not.toHaveBeenCalled();
		expect(String((sink.sent.at(-1) as Record<string, unknown>).error)).toMatch(
			/phase respond-to-review is not yet runnable on a DB-free worker/i,
		);
	});

	it('runs implementation with its board writes on the control-plane PM delivery API', async () => {
		const sink = recordingSink();
		const fetchImpl = vi
			.fn<FetchLike>()
			.mockResolvedValue(jsonResponse(200, { commentId: 'IC_1' }));
		const operator = stubDelivery();
		const runPhase = vi.fn(async (inputs: AssignedPhaseInputs) => {
			// What the real phase does: move the card to In progress, post the
			// implementer's comment, then move it on.
			await inputs.pm?.moveWorkItem('PVTI_item1', 'inProgress');
			await inputs.pm?.addComment('PVTI_item1', 'Implementation done');
			// Source ops stay on the operator's own token — no HTTP delivery for these.
			await inputs.delivery?.pushBranch('/tmp/wt', 'issue-17', 'deadbeef');
			return { agent: agentResult(), movedTo: 'inReview' as const };
		});

		await runAssignmentDbFree(
			buildTaskAssignment(createMockTaskAssignmentInput({ phase: 'implementation' })),
			sink,
			{ ...RUN_OPTIONS, deps: depsWith(runPhase, async () => operator, fetchImpl) },
		);

		expect(sink.sent.at(-1)).toMatchObject({
			status: 'succeeded',
			phase: 'implementation',
			movedTo: 'inReview',
		});
		// Both board writes went up to the control plane, project-scoped, under this
		// worker's own credential — with a canonical status key, never an option ID.
		expect(fetchImpl).toHaveBeenCalledTimes(2);
		const [moveUrl, moveInit] = fetchImpl.mock.calls[0];
		expect(moveUrl).toBe(`${CONTROL_PLANE}/worker/delivery/pm/move`);
		expect(moveInit.headers.authorization).toBe(`Bearer ${WORKER_CREDENTIAL}`);
		expect(JSON.parse(moveInit.body)).toEqual({
			projectId: PROJECT_ID,
			itemId: 'PVTI_item1',
			status: 'inProgress',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		});
		expect(fetchImpl.mock.calls[1][0]).toBe(`${CONTROL_PLANE}/worker/delivery/pm/comment`);
		// The source push ran on the operator provider, not over the wire.
		expect(operator.pushBranch).toHaveBeenCalledWith('/tmp/wt', 'issue-17', 'deadbeef');
		// Its SCM delivery is the operator provider itself: the implementer identity is
		// the operator, so nothing about it rides the transport.
		const inputs = runPhase.mock.calls[0][0];
		expect(inputs.delivery).toBe(operator);
		expect(inputs.agentToken).toBe(OPERATOR_TOKEN);
	});

	it("skips implementation's dependency gate instead of failing a board read it cannot serve", async () => {
		const sink = recordingSink();
		const fetchImpl = vi.fn<FetchLike>();
		let pm: AssignedPhaseInputs['pm'];
		const runPhase = vi.fn(async (inputs: AssignedPhaseInputs) => {
			pm = inputs.pm;
			return { agent: agentResult() };
		});
		await runAssignmentDbFree(
			buildTaskAssignment(createMockTaskAssignmentInput({ phase: 'implementation' })),
			sink,
			{ ...RUN_OPTIONS, deps: depsWith(runPhase, undefined, fetchImpl) },
		);

		// The control plane owns the dependency gate on this path, so the injected
		// provider declares the capability off and the gate short-circuits.
		expect(pm?.supportsDependencies).toBe(false);
		await expect(pm?.listBlockers('PVTI_item1')).resolves.toEqual([]);
		// A board *read* is a wiring bug here, and says so rather than returning a lie.
		await expect(pm?.getWorkItem('PVTI_item1')).rejects.toThrow(
			/not available on a DB-free worker/i,
		);
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it('runs review with submitReview on the control-plane SCM delivery API', async () => {
		const sink = recordingSink();
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { reviewId: 4242 }));
		const operator = stubDelivery();
		const runPhase = vi.fn(async (inputs: AssignedPhaseInputs) => {
			const reviewId = await inputs.delivery?.submitReview({
				prNumber: 99,
				verdict: 'approve',
				body: 'LGTM',
				deliveryId: 'run-1',
			});
			expect(reviewId).toBe(4242);
			return { agent: agentResult(), verdict: 'approve' as const };
		});

		await runAssignmentDbFree(
			ciAssignment({ phase: 'review', pr: { prNumber: '99', headSha: 'deadbeef' } }),
			sink,
			{ ...RUN_OPTIONS, deps: depsWith(runPhase, async () => operator, fetchImpl) },
		);

		expect(sink.sent.at(-1)).toMatchObject({
			status: 'succeeded',
			phase: 'review',
			verdict: 'approve',
		});
		// The verdict travelled up to the control plane, which submits it under the
		// per-project reviewer PAT — the worker never held that token.
		const [url, init] = fetchImpl.mock.calls[0];
		expect(url).toBe(`${CONTROL_PLANE}/worker/delivery/review`);
		expect(init.headers.authorization).toBe(`Bearer ${WORKER_CREDENTIAL}`);
		expect(JSON.parse(init.body)).toEqual({
			projectId: PROJECT_ID,
			prNumber: 99,
			verdict: 'approve',
			body: 'LGTM',
			deliveryId: 'run-1',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		});
		expect(operator.submitReview).not.toHaveBeenCalled();
		// Review writes to no board, and its source-side ops still delegate locally.
		const inputs = runPhase.mock.calls[0][0];
		expect(inputs.pm).toBeUndefined();
		await inputs.delivery?.findPullRequest('issue-17');
		expect(operator.findPullRequest).toHaveBeenCalledWith('issue-17');
	});

	it('settles the run failed when a control-plane delivery call is refused', async () => {
		const sink = recordingSink();
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(403, {}));
		const runPhase = vi.fn(async (inputs: AssignedPhaseInputs) => {
			await inputs.pm?.moveWorkItem('PVTI_item1', 'inProgress');
			return { agent: agentResult() };
		});
		await runAssignmentDbFree(
			buildTaskAssignment(createMockTaskAssignmentInput({ phase: 'implementation' })),
			sink,
			{ ...RUN_OPTIONS, deps: depsWith(runPhase, undefined, fetchImpl) },
		);

		expect(sink.sent.at(-1)).toMatchObject({ type: 'task-execution-result', status: 'failed' });
		expect(String((sink.sent.at(-1) as Record<string, unknown>).error)).toMatch(/403/);
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
			...RUN_OPTIONS,
			inFlight,
			deps: depsWith(runPhase),
		});
		await Promise.resolve();
		await runAssignmentDbFree(frame, sink, {
			...RUN_OPTIONS,
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
		await runAssignmentDbFree(ciAssignment(), sink, { ...RUN_OPTIONS, deps: depsWith(runPhase) });

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
		await runAssignmentDbFree(ciAssignment(), sink, { ...RUN_OPTIONS, deps: depsWith(runPhase) });

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
		await runAssignmentDbFree(ciAssignment(), sink, { ...RUN_OPTIONS, deps: depsWith(runPhase) });

		expect(sink.sent.at(-1)).toMatchObject({ status: 'failed', error: 'boom' });
	});

	it('routes a timed-out run through the failure path even when it exited 0', async () => {
		const sink = recordingSink();
		const runPhase = vi.fn(async () => ({
			agent: agentResult({ timedOut: true, exitCode: null }),
		}));
		await runAssignmentDbFree(ciAssignment(), sink, { ...RUN_OPTIONS, deps: depsWith(runPhase) });

		expect(sink.sent.at(-1)).toMatchObject({ status: 'deferred', failureKind: 'timeout' });
	});
});
