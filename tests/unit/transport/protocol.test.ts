import { describe, expect, it } from 'vitest';
import { REVIEW_AUTOMATION_OUTCOMES, REVIEW_VERDICTS } from '@/pipeline/review.js';
import { PM_STATUS_KEYS } from '@/pm/pipeline.js';
import {
	ControlPlaneMessageSchema,
	DisconnectSchema,
	HandshakeRequestSchema,
	HandshakeResponseSchema,
	HeartbeatAckSchema,
	HeartbeatSchema,
	StreamLogSchema,
	TaskAssignmentAckSchema,
	TaskAssignmentSchema,
	TaskExecutionResultSchema,
	TaskPhaseSchema,
	TaskProgressSchema,
	TRANSPORT_PROTOCOL_VERSION,
	WorkerStreamMessageSchema,
} from '@/transport/protocol.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

const WORKER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const DISPATCH_ID = '44444444-4444-4444-8444-444444444444';

/** The non-secret project-config slice a valid frame embeds. */
const PROJECT_SLICE = (() => {
	const { credentials: _credentials, ...rest } = createMockProjectConfig();
	return rest;
})();

/** A minimal well-formed `task-assignment` frame for the union/round-trip tests. */
const VALID_ASSIGNMENT = {
	type: 'task-assignment' as const,
	protocolVersion: TRANSPORT_PROTOCOL_VERSION,
	dispatchId: DISPATCH_ID,
	phase: 'planning' as const,
	taskId: '17',
	projectConfig: PROJECT_SLICE,
	targetBranch: 'issue-17',
	systemPrompt: 'Do the thing.',
	target: { cli: 'claude' as const },
};

describe('transport protocol schemas', () => {
	describe('HandshakeRequestSchema', () => {
		const valid = {
			credential: 'raw-worker-credential',
			daemonVersion: '1.2.3',
			hostname: 'ada-laptop',
			capabilities: ['claude', 'codex'],
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		};

		it('accepts a well-formed handshake request', () => {
			expect(HandshakeRequestSchema.parse(valid)).toEqual(valid);
		});

		it('rejects an empty credential', () => {
			expect(HandshakeRequestSchema.safeParse({ ...valid, credential: '' }).success).toBe(false);
		});

		it('rejects an empty capability set', () => {
			expect(HandshakeRequestSchema.safeParse({ ...valid, capabilities: [] }).success).toBe(false);
		});

		it('rejects an unknown CLI in capabilities', () => {
			expect(
				HandshakeRequestSchema.safeParse({ ...valid, capabilities: ['claude', 'cursor'] }).success,
			).toBe(false);
		});

		it('rejects a missing field', () => {
			const { hostname, ...withoutHostname } = valid;
			expect(HandshakeRequestSchema.safeParse(withoutHostname).success).toBe(false);
		});
	});

	describe('HandshakeResponseSchema', () => {
		const valid = {
			authenticated: true as const,
			workerId: WORKER_ID,
			sessionId: SESSION_ID,
			fencingToken: 1,
			heartbeatTtlMs: 60_000,
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		};

		it('round-trips a success response', () => {
			expect(HandshakeResponseSchema.parse(valid)).toEqual(valid);
		});

		it('rejects authenticated: false (a failure never uses this shape)', () => {
			expect(HandshakeResponseSchema.safeParse({ ...valid, authenticated: false }).success).toBe(
				false,
			);
		});

		it('rejects a non-positive fencing token', () => {
			expect(HandshakeResponseSchema.safeParse({ ...valid, fencingToken: 0 }).success).toBe(false);
		});
	});

	describe('HeartbeatSchema', () => {
		it('accepts a heartbeat with no health', () => {
			expect(HeartbeatSchema.parse({ type: 'heartbeat', fencingToken: 2 })).toEqual({
				type: 'heartbeat',
				fencingToken: 2,
			});
		});

		it('accepts optional health telemetry', () => {
			const frame = {
				type: 'heartbeat' as const,
				fencingToken: 2,
				health: { cpuLoadPercent: 42, availableRamBytes: 1024 },
			};
			expect(HeartbeatSchema.parse(frame)).toEqual(frame);
		});

		it('rejects a cpu load above 100', () => {
			expect(
				HeartbeatSchema.safeParse({
					type: 'heartbeat',
					fencingToken: 2,
					health: { cpuLoadPercent: 101 },
				}).success,
			).toBe(false);
		});

		it('rejects the wrong type discriminator', () => {
			expect(HeartbeatSchema.safeParse({ type: 'heartbeat-ack', fencingToken: 2 }).success).toBe(
				false,
			);
		});
	});

	describe('WorkerStreamMessageSchema (worker→cloud union)', () => {
		const RUN_ID = '66666666-6666-4666-8666-666666666666';

		it('parses a heartbeat frame', () => {
			const parsed = WorkerStreamMessageSchema.parse({ type: 'heartbeat', fencingToken: 5 });
			expect(parsed.type).toBe('heartbeat');
		});

		it('parses a task-assignment-ack frame', () => {
			const frame = { type: 'task-assignment-ack', dispatchId: DISPATCH_ID, duplicate: false };
			expect(WorkerStreamMessageSchema.parse(frame)).toEqual(frame);
		});

		it('parses a batched stream-log frame', () => {
			const frame = {
				type: 'stream-log' as const,
				dispatchId: DISPATCH_ID,
				runId: RUN_ID,
				lines: [
					{
						stream: 'stdout' as const,
						content: 'working…\n',
						emittedAt: '2026-07-24T12:00:00.000Z',
					},
					{ stream: 'stderr' as const, content: 'warn\n', emittedAt: '2026-07-24T12:00:00.100Z' },
				],
			};
			expect(WorkerStreamMessageSchema.parse(frame)).toEqual(frame);
		});

		it('rejects a stream-log frame with no lines', () => {
			expect(
				StreamLogSchema.safeParse({ type: 'stream-log', dispatchId: DISPATCH_ID, lines: [] })
					.success,
			).toBe(false);
		});

		it('parses a task-progress frame for each state', () => {
			for (const state of ['running', 'branch-provisioned'] as const) {
				const frame = {
					type: 'task-progress' as const,
					dispatchId: DISPATCH_ID,
					phase: 'implementation' as const,
					taskId: '17',
					state,
				};
				expect(TaskProgressSchema.parse(frame)).toEqual(frame);
			}
		});

		it('round-trips a succeeded task-execution-result', () => {
			const frame = {
				type: 'task-execution-result' as const,
				dispatchId: DISPATCH_ID,
				runId: RUN_ID,
				status: 'succeeded' as const,
				phase: 'planning' as const,
				taskId: '17',
				exitCode: 0,
				signal: null,
				timedOut: false,
				durationMs: 1234,
			};
			expect(TaskExecutionResultSchema.parse(frame)).toEqual(frame);
			expect(WorkerStreamMessageSchema.parse(frame).type).toBe('task-execution-result');
		});

		it('round-trips a succeeded result carrying the produced PR url (issue #398)', () => {
			const frame = {
				type: 'task-execution-result' as const,
				dispatchId: DISPATCH_ID,
				runId: RUN_ID,
				status: 'succeeded' as const,
				phase: 'implementation' as const,
				taskId: '17',
				exitCode: 0,
				prUrl: 'https://github.com/o/r/pull/7',
			};
			expect(TaskExecutionResultSchema.parse(frame)).toEqual(frame);
			// The field is optional, so an older worker's frame — which omits it — still
			// parses: no protocol-version bump was needed.
			const { prUrl, ...older } = frame;
			expect(TaskExecutionResultSchema.parse(older)).toEqual(older);
		});

		it('round-trips a deferred task-execution-result carrying the retry hint', () => {
			const frame = {
				type: 'task-execution-result' as const,
				dispatchId: DISPATCH_ID,
				status: 'deferred' as const,
				phase: 'implementation' as const,
				taskId: '17',
				retryDelayMs: 360_000,
				resumable: true,
				failureKind: 'rate-limit',
				reason: 'rate limited',
			};
			expect(TaskExecutionResultSchema.parse(frame)).toEqual(frame);
		});

		it('round-trips a dependency deferral carrying the open blockers (issue #438)', () => {
			const frame = {
				type: 'task-execution-result' as const,
				dispatchId: DISPATCH_ID,
				status: 'deferred' as const,
				phase: 'implementation' as const,
				taskId: '17',
				retryDelayMs: 0,
				resumable: false,
				failureKind: 'dependency',
				reason: '#319 (“Session auth”) must be done first',
				blockers: [
					{
						reference: '#319',
						url: 'https://github.com/jkwiecien/swarm/issues/319',
						title: 'Session auth',
						open: true,
						source: 'dependency' as const,
					},
				],
			};
			// The blockers must survive the wire, not just the type: the control plane
			// rebuilds `DependencyBlockedError` from them so its message names #319.
			expect(TaskExecutionResultSchema.parse(frame)).toEqual(frame);
		});

		it('round-trips a failed, cancelled task-execution-result', () => {
			const frame = {
				type: 'task-execution-result' as const,
				dispatchId: DISPATCH_ID,
				status: 'failed' as const,
				phase: 'review' as const,
				taskId: '17',
				error: 'boom',
				cancelled: true,
			};
			expect(TaskExecutionResultSchema.parse(frame)).toEqual(frame);
		});

		it('rejects an unknown execution-result status', () => {
			expect(
				TaskExecutionResultSchema.safeParse({
					type: 'task-execution-result',
					dispatchId: DISPATCH_ID,
					status: 'partial',
					phase: 'review',
					taskId: '17',
				}).success,
			).toBe(false);
		});

		it('rejects a task-assignment-ack missing its duplicate flag', () => {
			expect(
				TaskAssignmentAckSchema.safeParse({ type: 'task-assignment-ack', dispatchId: DISPATCH_ID })
					.success,
			).toBe(false);
		});

		it('rejects a control-plane frame carried the wrong direction', () => {
			expect(WorkerStreamMessageSchema.safeParse({ type: 'heartbeat-ack' }).success).toBe(false);
			expect(WorkerStreamMessageSchema.safeParse({ type: 'disconnect', reason: 'x' }).success).toBe(
				false,
			);
			expect(WorkerStreamMessageSchema.safeParse(VALID_ASSIGNMENT).success).toBe(false);
		});
	});

	describe('ControlPlaneMessageSchema (cloud→worker union)', () => {
		it('parses a heartbeat-ack frame', () => {
			expect(ControlPlaneMessageSchema.parse({ type: 'heartbeat-ack' })).toEqual({
				type: 'heartbeat-ack',
			});
		});

		it('parses a disconnect frame with a reason', () => {
			expect(HeartbeatAckSchema.safeParse({ type: 'heartbeat-ack' }).success).toBe(true);
			expect(ControlPlaneMessageSchema.parse({ type: 'disconnect', reason: 'lease lost' })).toEqual(
				{ type: 'disconnect', reason: 'lease lost' },
			);
		});

		it('rejects a disconnect frame missing its reason', () => {
			expect(DisconnectSchema.safeParse({ type: 'disconnect' }).success).toBe(false);
		});

		it('rejects a worker→cloud frame carried the wrong direction', () => {
			expect(
				ControlPlaneMessageSchema.safeParse({ type: 'heartbeat', fencingToken: 1 }).success,
			).toBe(false);
		});

		it('discriminates a task-assignment frame to TaskAssignmentSchema', () => {
			const parsed = ControlPlaneMessageSchema.parse(VALID_ASSIGNMENT);
			expect(parsed.type).toBe('task-assignment');
		});
	});

	describe('TaskPhaseSchema', () => {
		it('accepts the six worker-runnable phases', () => {
			for (const phase of [
				'planning',
				'implementation',
				'review',
				'respond-to-review',
				'respond-to-ci',
				'resolve-conflicts',
			]) {
				expect(TaskPhaseSchema.safeParse(phase).success).toBe(true);
			}
		});

		it('rejects an unknown phase', () => {
			expect(TaskPhaseSchema.safeParse('deploy').success).toBe(false);
		});
	});

	describe('TaskAssignmentSchema', () => {
		it('round-trips a full valid frame', () => {
			const frame = {
				...VALID_ASSIGNMENT,
				runId: '55555555-5555-4555-8555-555555555555',
				customPrompt: 'extra project instructions',
				timeoutMs: 600_000,
				agentSessionId: 'sess-1',
				resumeSession: true,
				workItem: {
					id: 'PVTI_1',
					title: 'Do it',
					description: 'body',
					url: 'https://github.com/jkwiecien/swarm/issues/17',
					labels: [{ id: 'LA_1', name: 'swarm' }],
					assignees: [],
				},
			};
			expect(TaskAssignmentSchema.parse(frame)).toEqual(frame);
		});

		it('strips a credentials key from an embedded config rather than storing it', () => {
			const withSecret = {
				...VALID_ASSIGNMENT,
				projectConfig: { ...PROJECT_SLICE, credentials: { implementer: 'x' } },
			};
			// `.omit` produces a strict-less object schema, so an extra `credentials`
			// key is ignored rather than stored — the parsed slice carries none.
			const parsed = TaskAssignmentSchema.parse(withSecret);
			expect('credentials' in parsed.projectConfig).toBe(false);
		});

		it('rejects an empty system prompt', () => {
			expect(
				TaskAssignmentSchema.safeParse({ ...VALID_ASSIGNMENT, systemPrompt: '' }).success,
			).toBe(false);
		});

		it('rejects a non-UUID dispatchId', () => {
			expect(
				TaskAssignmentSchema.safeParse({ ...VALID_ASSIGNMENT, dispatchId: 'nope' }).success,
			).toBe(false);
		});
	});

	// The TaskExecutionResult settle-context enums (issue #407) are hand-authored
	// literals so the wire protocol stays self-contained — no runtime import of the
	// pm/pipeline layers. These guards keep that duplication honest: if a canonical
	// status key / verdict / automation outcome is ever added or renamed, the frame
	// must gain it too, or the control plane silently can't settle on the new value.
	describe('TaskExecutionResult settle-context enums track their canonical sources', () => {
		it('movedTo matches PM_STATUS_KEYS', () => {
			const movedTo = TaskExecutionResultSchema.shape.movedTo.unwrap();
			expect([...movedTo.options].sort()).toEqual([...PM_STATUS_KEYS].sort());
		});

		it('verdict matches REVIEW_VERDICTS', () => {
			const verdict = TaskExecutionResultSchema.shape.verdict.unwrap();
			expect([...verdict.options].sort()).toEqual([...REVIEW_VERDICTS].sort());
		});

		it('reviewAutomationOutcome matches REVIEW_AUTOMATION_OUTCOMES', () => {
			const outcome = TaskExecutionResultSchema.shape.reviewAutomationOutcome.unwrap();
			expect([...outcome.options].sort()).toEqual([...REVIEW_AUTOMATION_OUTCOMES].sort());
		});
	});
});
