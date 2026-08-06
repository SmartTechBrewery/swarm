import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentCliResult } from '@/harness/agent-cli.js';
import { AgentRunError } from '@/harness/agent-failure.js';
import type { SCMProviderManifest } from '@/integrations/scm/manifest.js';
import {
	_resetSCMProviderRegistryForTesting,
	registerSCMProvider,
} from '@/integrations/scm/registry.js';
import type { Checkpoint } from '@/pipeline/checkpoint.js';
import { DependencyBlockedError } from '@/pipeline/dependency-guard.js';
import type { ScmDeliveryProvider } from '@/scm/delivery.js';
import { DeliveryDeferredError } from '@/scm/delivery.js';
import { buildTaskAssignment } from '@/transport/assignment.js';
import { deferrableOrFailedResult, runAssignmentDbFree } from '@/transport/assignment-execution.js';
import type { FetchLike } from '@/transport/delivery-client.js';
import { TRANSPORT_PROTOCOL_VERSION } from '@/transport/protocol.js';
import type { AssignmentSink } from '@/transport/worker-client.js';
import type { AssignedPhaseInputs, PhaseRunResult } from '@/worker/consumer.js';
import { createMockTaskAssignmentInput, createMockWorkItem } from '../../helpers/factories.js';

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
	repoRoot: '/worker-local/swarm',
	operatorToken: OPERATOR_TOKEN,
	controlPlaneUrl: CONTROL_PLANE,
	workerCredential: WORKER_CREDENTIAL,
} as const;

function jsonResponse(status: number, body: unknown): Awaited<ReturnType<FetchLike>> {
	return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/**
 * Deps with no `buildDelivery` override, so the operator delivery resolves the way
 * production does — through the SCM registry.
 */
function depsWithoutDeliveryOverride(
	runPhase: (inputs: AssignedPhaseInputs) => Promise<PhaseRunResult>,
) {
	return {
		runPhase,
		baseRunAgent: vi.fn(async () => agentResult()) as never,
		logger: silentLogger,
	};
}

/** What an involuntarily stopped implementation run left behind on the worker's disk. */
const CHECKPOINT: Checkpoint = {
	phase: 'implementation',
	completed: ['Wrote the schema and its tests'],
	remaining: ['Update the docs', 'Run the focused tests'],
	decisions: [],
	workingTree: { modified: ['src/config/schema.ts'], added: [], deleted: [] },
};

describe('runAssignmentDbFree', () => {
	// This file never imports the integrations entrypoint, so the registry starts
	// empty and only the tests below that register a manifest see one.
	beforeEach(_resetSCMProviderRegistryForTesting);

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
		expect(buildDelivery).toHaveBeenCalledWith('SmartTechBrewery/swarm', OPERATOR_TOKEN);
		// The phase received the injected operator-token delivery + agent token, and no
		// PM provider — a source-only phase writes to no board.
		const inputs = runPhase.mock.calls[0][0];
		expect(inputs.agentToken).toBe(OPERATOR_TOKEN);
		expect(inputs.delivery).toBeDefined();
		expect(inputs.pm).toBeUndefined();
	});

	it('defaults its operator delivery to the registered SCM provider (issue #462)', async () => {
		const operator = stubDelivery();
		const operatorDeliveryProvider = vi.fn(async () => operator);
		registerSCMProvider({
			id: 'github',
			label: 'GitHub',
			category: 'scm',
			webhookRoute: '/github/webhook',
			provider: { type: 'github', category: 'scm', operatorDeliveryProvider },
		} as unknown as SCMProviderManifest);
		const sink = recordingSink();
		const runPhase = vi.fn(async (_inputs: AssignedPhaseInputs) => ({ agent: agentResult() }));

		await runAssignmentDbFree(ciAssignment(), sink, {
			...RUN_OPTIONS,
			deps: depsWithoutDeliveryOverride(runPhase),
		});

		// Resolved through the registry rather than by importing the GitHub
		// operator-delivery builder, and handed the neutral `owner/repo` plus the
		// operator's own credential.
		expect(operatorDeliveryProvider).toHaveBeenCalledWith('SmartTechBrewery/swarm', OPERATOR_TOKEN);
		expect(runPhase.mock.calls[0][0].delivery).toBe(operator);
		expect(sink.sent.at(-1)).toMatchObject({ status: 'succeeded', phase: 'respond-to-ci' });
	});

	it('settles failed, not crashes, when no runtime-ready SCM provider is registered', async () => {
		const sink = recordingSink();
		const runPhase = vi.fn(async () => ({ agent: agentResult() }));

		await runAssignmentDbFree(ciAssignment(), sink, {
			...RUN_OPTIONS,
			deps: depsWithoutDeliveryOverride(runPhase),
		});

		// `runAssignmentDbFree` never throws — an unloaded entrypoint is reported as a
		// terminal frame naming the wiring problem, and the phase never runs.
		expect(runPhase).not.toHaveBeenCalled();
		expect(sink.sent.at(-1)).toMatchObject({ type: 'task-execution-result', status: 'failed' });
		expect(String((sink.sent.at(-1) as Record<string, unknown>).error)).toMatch(
			/Cannot resolve the SCM provider for project/i,
		);
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

	it('runs respond-to-review with its card lookup, board move and follow-up on the delivery API', async () => {
		const sink = recordingSink();
		const card = {
			id: 'ITEM_17',
			title: 'Example',
			description: 'body',
			url: 'https://github.com/SmartTechBrewery/swarm/issues/17',
			labels: [],
			assignees: [],
		};
		const fetchImpl = vi.fn<FetchLike>().mockImplementation(async (url) => {
			if (url.endsWith('/pm/find-item')) return jsonResponse(200, { item: card });
			return jsonResponse(200, {});
		});
		const operator = stubDelivery();
		const runPhase = vi.fn(async (inputs: AssignedPhaseInputs) => {
			// What the real phase does: resolve the card, report In progress, push the
			// fix + reply as the implementer, schedule the follow-up Review, report In
			// review.
			const item = await inputs.pm?.findWorkItemByUrlSuffix('/issues/17');
			await inputs.pm?.moveWorkItem(item?.id as string, 'inProgress');
			await inputs.delivery?.pushBranch('/tmp/wt', 'issue-17', 'fixsha');
			await inputs.delivery?.postComment({ prNumber: 99, body: 'Fixed', deliveryId: 'd1' });
			await inputs.scheduleFollowUpReview?.({
				project: inputs.project,
				prNumber: '99',
				prBranch: 'issue-17',
				headSha: 'fixsha',
			});
			await inputs.pm?.moveWorkItem(item?.id as string, 'inReview');
			return { agent: agentResult(), movedTo: 'inReview' as const };
		});

		await runAssignmentDbFree(
			ciAssignment({
				phase: 'respond-to-review',
				pr: { prNumber: '99', prBranch: 'issue-17', headSha: 'deadbeef', reviewId: '7' },
			}),
			sink,
			{ ...RUN_OPTIONS, deps: depsWith(runPhase, async () => operator, fetchImpl) },
		);

		expect(sink.sent.at(-1)).toMatchObject({
			status: 'succeeded',
			phase: 'respond-to-review',
			movedTo: 'inReview',
		});
		expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
			`${CONTROL_PLANE}/worker/delivery/pm/find-item`,
			`${CONTROL_PLANE}/worker/delivery/pm/move`,
			`${CONTROL_PLANE}/worker/delivery/follow-up-review`,
			`${CONTROL_PLANE}/worker/delivery/pm/move`,
		]);
		expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
			projectId: PROJECT_ID,
			urlSuffix: '/issues/17',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		});
		expect(JSON.parse(fetchImpl.mock.calls[2][1].body)).toEqual({
			projectId: PROJECT_ID,
			prNumber: '99',
			prBranch: 'issue-17',
			headSha: 'fixsha',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		});
		// The fix commit and the implementer's reply stay on the operator's own token
		// — the reply is the implementer answering, not the reviewer.
		const inputs = runPhase.mock.calls[0][0];
		expect(inputs.delivery).toBe(operator);
		expect(inputs.agentToken).toBe(OPERATOR_TOKEN);
		expect(operator.pushBranch).toHaveBeenCalledWith('/tmp/wt', 'issue-17', 'fixsha');
		expect(operator.postComment).toHaveBeenCalledTimes(1);
	});

	it('keeps the respond-to-review board report best-effort when the card cannot be resolved', async () => {
		const sink = recordingSink();
		// A refused lookup throws inside the phase's own try/catch, which logs and
		// skips the status report rather than failing an otherwise-good response.
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(500, {}));
		const runPhase = vi.fn(async (inputs: AssignedPhaseInputs) => {
			let resolved: unknown;
			try {
				resolved = await inputs.pm?.findWorkItemByUrlSuffix('/issues/17');
			} catch {
				resolved = undefined;
			}
			expect(resolved).toBeUndefined();
			return { agent: agentResult() };
		});

		await runAssignmentDbFree(
			ciAssignment({
				phase: 'respond-to-review',
				pr: { prNumber: '99', prBranch: 'issue-17', headSha: 'deadbeef', reviewId: '7' },
			}),
			sink,
			{ ...RUN_OPTIONS, deps: depsWith(runPhase, undefined, fetchImpl) },
		);

		expect(sink.sent.at(-1)).toMatchObject({
			status: 'succeeded',
			phase: 'respond-to-review',
		});
		expect(sink.sent.at(-1)).not.toHaveProperty('movedTo', 'inReview');
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

	it('reports the produced PR url on the result frame so the control plane can attribute it (issue #398)', async () => {
		const sink = recordingSink();
		const runPhase = vi.fn(async () => ({
			agent: agentResult(),
			prUrl: 'https://github.com/o/r/pull/7',
		}));

		await runAssignmentDbFree(
			buildTaskAssignment(createMockTaskAssignmentInput({ phase: 'implementation' })),
			sink,
			{ ...RUN_OPTIONS, deps: depsWith(runPhase) },
		);

		expect(sink.sent.at(-1)).toMatchObject({
			status: 'succeeded',
			prUrl: 'https://github.com/o/r/pull/7',
		});
	});

	it('reports no produced PR for a phase that creates none', async () => {
		const sink = recordingSink();
		const runPhase = vi.fn(async () => ({ agent: agentResult() }));

		await runAssignmentDbFree(ciAssignment(), sink, {
			...RUN_OPTIONS,
			deps: depsWith(runPhase),
		});

		expect(sink.sent.at(-1)).toMatchObject({ status: 'succeeded' });
		expect(sink.sent.at(-1)?.prUrl).toBeUndefined();
	});

	it("keeps implementation's dependency gate working through the blockers read route", async () => {
		const sink = recordingSink();
		const blockers = [
			{
				reference: '#319',
				url: 'https://github.com/SmartTechBrewery/swarm/issues/319',
				title: 'Prerequisite',
				open: true,
				source: 'dependency' as const,
			},
		];
		const fetchImpl = vi.fn<FetchLike>().mockResolvedValue(jsonResponse(200, { blockers }));
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

		// The gate must still gate on a DB-free worker: the capability stays on and the
		// read runs server-side under the PM credential (issue #330).
		expect(pm?.supportsDependencies).toBe(true);
		await expect(pm?.listBlockers('PVTI_item1')).resolves.toEqual(blockers);
		expect(fetchImpl.mock.calls[0][0]).toBe(`${CONTROL_PLANE}/worker/delivery/pm/blockers`);
		// Every other board read is a wiring bug here, and says so rather than lying.
		await expect(pm?.getWorkItem('PVTI_item1')).rejects.toThrow(
			/not available on a DB-free worker/i,
		);
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

	it('gives review a transport-backed verdict ledger instead of the Postgres one', async () => {
		const sink = recordingSink();
		// Route each call by path: the ledger and the review write have different bodies.
		const fetchImpl = vi.fn<FetchLike>().mockImplementation(async (url) => {
			if (url.endsWith('/review-ledger/prior')) return jsonResponse(200, { record: null });
			if (url.endsWith('/review-ledger/mark'))
				return jsonResponse(200, { slot: { id: 'verdict-1', ordinal: 1 } });
			if (url.endsWith('/review-ledger/abandon')) return jsonResponse(200, {});
			return jsonResponse(200, { reviewId: 4242 });
		});
		const runPhase = vi.fn(async (inputs: AssignedPhaseInputs) => {
			// What `runReviewPhase` does around its verdict — none of it may reach a DB.
			await inputs.reviewLedger?.getPriorSubmittedReview(
				'swarm',
				'SmartTechBrewery/swarm',
				'99',
				'deadbeef',
			);
			const slot = await inputs.reviewLedger?.markReviewVerdictSubmitted(
				{
					projectId: 'swarm',
					repository: 'SmartTechBrewery/swarm',
					prNumber: '99',
					headSha: 'deadbeef',
				},
				{ verdict: 'request-changes', reviewId: '9911' },
			);
			expect(slot).toEqual({ id: 'verdict-1', ordinal: 1 });
			return { agent: agentResult(), verdict: 'request-changes' as const, reviewOrdinal: 1 };
		});

		await runAssignmentDbFree(
			ciAssignment({ phase: 'review', pr: { prNumber: '99', headSha: 'deadbeef' } }),
			sink,
			{ ...RUN_OPTIONS, deps: depsWith(runPhase, undefined, fetchImpl) },
		);

		expect(sink.sent.at(-1)).toMatchObject({ status: 'succeeded', reviewOrdinal: 1 });
		const paths = fetchImpl.mock.calls.map(([url]) => url);
		expect(paths).toEqual([
			`${CONTROL_PLANE}/worker/delivery/review-ledger/prior`,
			`${CONTROL_PLANE}/worker/delivery/review-ledger/mark`,
		]);
		// The review-verdict cap and re-review signal keep working because the ledger is
		// consulted, not skipped — only its storage moved server-side.
		expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toMatchObject({
			projectId: PROJECT_ID,
			prNumber: '99',
			headSha: 'deadbeef',
			verdict: 'request-changes',
			reviewId: '9911',
		});
	});

	it('leaves the verdict ledger unset for every phase but review', async () => {
		const seen: Array<[string, unknown]> = [];
		const runPhase = vi.fn(async (inputs: AssignedPhaseInputs) => {
			seen.push([inputs.phase, inputs.reviewLedger]);
			return { agent: agentResult() };
		});
		for (const assignment of [
			ciAssignment(),
			buildTaskAssignment(createMockTaskAssignmentInput({ phase: 'implementation' })),
		]) {
			await runAssignmentDbFree(assignment, recordingSink(), {
				...RUN_OPTIONS,
				deps: depsWith(runPhase),
			});
		}

		expect(seen).toEqual([
			['respond-to-ci', undefined],
			['implementation', undefined],
		]);
	});

	it('leaves the follow-up scheduler unset for every phase but respond-to-review', async () => {
		const seen: Array<[string, boolean]> = [];
		const runPhase = vi.fn(async (inputs: AssignedPhaseInputs) => {
			seen.push([inputs.phase, inputs.scheduleFollowUpReview !== undefined]);
			return { agent: agentResult() };
		});
		for (const assignment of [
			ciAssignment(),
			buildTaskAssignment(createMockTaskAssignmentInput({ phase: 'implementation' })),
			ciAssignment({ phase: 'review', pr: { prNumber: '99', headSha: 'deadbeef' } }),
			ciAssignment({
				phase: 'respond-to-review',
				pr: { prNumber: '99', prBranch: 'issue-17', headSha: 'deadbeef', reviewId: '7' },
			}),
		]) {
			await runAssignmentDbFree(assignment, recordingSink(), {
				...RUN_OPTIONS,
				deps: depsWith(runPhase),
			});
		}

		expect(seen).toEqual([
			['respond-to-ci', false],
			['implementation', false],
			['review', false],
			['respond-to-review', true],
		]);
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

	it('settles deferred (dependency) for a DependencyBlockedError, reporting the blockers', async () => {
		const sink = recordingSink();
		const workItem = createMockWorkItem();
		const blocker = {
			reference: '#319',
			url: 'https://github.com/SmartTechBrewery/swarm/issues/319',
			title: 'Session auth',
			open: true,
			source: 'dependency' as const,
		};
		const runPhase = vi.fn(async () => {
			throw new DependencyBlockedError(workItem, [blocker]);
		});
		await runAssignmentDbFree(
			buildTaskAssignment(createMockTaskAssignmentInput({ phase: 'implementation' })),
			sink,
			{ ...RUN_OPTIONS, deps: depsWith(runPhase) },
		);

		const result = sink.sent.at(-1) as Record<string, unknown>;
		// Deferred, not failed — the regression issue #438 fixes: the item keeps waiting
		// on its prerequisite instead of needing a manual re-dispatch.
		expect(result).toMatchObject({
			type: 'task-execution-result',
			status: 'deferred',
			failureKind: 'dependency',
			resumable: false,
		});
		// The blockers travel so the control plane's message names the prerequisite.
		expect(result.blockers).toEqual([blocker]);
		expect(result.reason).toContain('#319');
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

	// Tier 2 across the wire (issue #503): only this host holds the worktree, so the
	// worker parses the checkpoint the stopped agent left in it and attaches it to the
	// deferral. The control plane owns the policy and the budget; this reports evidence.
	it('reports the Tier 2 checkpoint from its own checkout on a resumable deferral', async () => {
		const worktree = mkdtempSync(join(tmpdir(), 'swarm-dbfree-checkpoint-'));
		try {
			writeFileSync(join(worktree, 'swarm_checkpoint.json'), JSON.stringify(CHECKPOINT));
			const frame = deferrableOrFailedResult(
				new AgentRunError('rate limited', { kind: 'rate-limit' }, agentResult({ exitCode: 1 })),
				buildTaskAssignment(createMockTaskAssignmentInput({ phase: 'implementation' })),
				worktree,
			);

			// The wire status is unchanged — a continuation *is* a deferral — so no
			// protocol-version bump is needed for an older control plane.
			expect(frame).toMatchObject({ status: 'deferred', failureKind: 'rate-limit' });
			expect(frame.checkpoint).toEqual(CHECKPOINT);
		} finally {
			rmSync(worktree, { recursive: true, force: true });
		}
	});

	// A failure that discards the checkout has nothing to continue from, so it must not
	// report a checkpoint even if a stale file happens to be lying there.
	it('reports no checkpoint for a non-resumable deferral', () => {
		const worktree = mkdtempSync(join(tmpdir(), 'swarm-dbfree-checkpoint-'));
		try {
			writeFileSync(join(worktree, 'swarm_checkpoint.json'), JSON.stringify(CHECKPOINT));
			const frame = deferrableOrFailedResult(
				new AgentRunError('at capacity', { kind: 'capacity' }, agentResult({ exitCode: 1 })),
				buildTaskAssignment(createMockTaskAssignmentInput({ phase: 'implementation' })),
				worktree,
			);

			expect(frame).toMatchObject({ status: 'deferred', failureKind: 'capacity' });
			expect(frame.checkpoint).toBeUndefined();
		} finally {
			rmSync(worktree, { recursive: true, force: true });
		}
	});

	it('reports no checkpoint when the checkout carries none', () => {
		const worktree = mkdtempSync(join(tmpdir(), 'swarm-dbfree-checkpoint-'));
		try {
			const frame = deferrableOrFailedResult(
				new AgentRunError('rate limited', { kind: 'rate-limit' }, agentResult({ exitCode: 1 })),
				buildTaskAssignment(createMockTaskAssignmentInput({ phase: 'implementation' })),
				worktree,
			);

			expect(frame.checkpoint).toBeUndefined();
		} finally {
			rmSync(worktree, { recursive: true, force: true });
		}
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
