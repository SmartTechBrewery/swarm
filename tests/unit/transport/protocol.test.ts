import { describe, expect, it } from 'vitest';
import { toNonSecretProjectConfig } from '@/config/project-config-slice.js';
import { REVIEW_AUTOMATION_OUTCOMES, REVIEW_VERDICTS } from '@/pipeline/review.js';
import { PM_STATUS_KEYS } from '@/pm/pipeline.js';
import { RecoveryModeSchema } from '@/queue/jobs.js';
import {
	ControlPlaneMessageSchema,
	DisconnectSchema,
	HandshakeRequestSchema,
	HandshakeResponseSchema,
	HeartbeatAckSchema,
	HeartbeatSchema,
	PostCommentDeliveryRequestSchema,
	ReportWorkerUpdateDeliveryRequestSchema,
	ReportWorkerUpdateDeliveryResponseSchema,
	ReportWorktreeSweepDeliveryRequestSchema,
	ReportWorktreeSweepDeliveryResponseSchema,
	StreamLogSchema,
	TaskAssignmentAckSchema,
	TaskAssignmentSchema,
	TaskCancelSchema,
	TaskExecutionResultSchema,
	TaskPhaseSchema,
	TaskProgressSchema,
	TRANSPORT_PROTOCOL_VERSION,
	WorkerStreamMessageSchema,
	WorkerUpdateSchema,
	WorktreeSweepSchema,
} from '@/transport/protocol.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

const WORKER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const DISPATCH_ID = '44444444-4444-4444-8444-444444444444';

/** The non-secret project-config slice a valid frame embeds. */
const PROJECT_SLICE = (() => {
	return toNonSecretProjectConfig(createMockProjectConfig());
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

		// Issue #687: the daemon declares which repository its one local checkout is.
		// Additive and optional in both directions like `reclaim` below, which is why
		// `TRANSPORT_PROTOCOL_VERSION` is deliberately not bumped: the shape above (with
		// no `repository`) is the older daemon's and stays valid, and its omission is what
		// records NULL on the worker row.
		it('accepts a declared repository, normalised to the host-less owner/repo form', () => {
			expect(
				HandshakeRequestSchema.parse({ ...valid, repository: 'SmartTechBrewery/Swarm.git' }),
			).toEqual({ ...valid, repository: 'smarttechbrewery/swarm' });
		});

		it('accepts a nested namespace a GitLab subgroup checkout would declare', () => {
			expect(
				HandshakeRequestSchema.parse({ ...valid, repository: 'group/sub/project' }).repository,
			).toBe('group/sub/project');
		});

		it('rejects a host-prefixed, single-segment, or empty repository', () => {
			for (const repository of ['https://github.com/SmartTechBrewery/swarm', 'swarm', '']) {
				expect(HandshakeRequestSchema.safeParse({ ...valid, repository }).success).toBe(false);
			}
		});

		// Issue #918: the daemon declares the SWARM build it is running. Additive and
		// optional on exactly the same terms as `repository` above — the shape above,
		// with no `build`, is the older daemon's and stays valid.
		it('accepts a declared build, normalising the commit to lower-case hex', () => {
			expect(
				HandshakeRequestSchema.parse({
					...valid,
					build: { commit: '9F3A1B2C4D5E6F70819A2B3C4D5E6F7081920A3B', dirty: false },
				}),
			).toEqual({
				...valid,
				build: { commit: '9f3a1b2c4d5e6f70819a2b3c4d5e6f7081920a3b', dirty: false },
			});
		});

		it('rejects a non-hex, too-short, or absent commit', () => {
			for (const commit of ['zzzzzzz', 'abc123', '']) {
				expect(
					HandshakeRequestSchema.safeParse({ ...valid, build: { commit, dirty: true } }).success,
				).toBe(false);
			}
		});

		it('rejects a build that omits the dirty flag', () => {
			expect(
				HandshakeRequestSchema.safeParse({ ...valid, build: { commit: 'abc1234' } }).success,
			).toBe(false);
		});

		// Issue #997: the daemon declares how it is supervised. Additive and optional on
		// exactly the same terms as the two above — the shape above, with no
		// `supervision`, is the older daemon's and stays valid.
		it('accepts each of the three declared supervision states', () => {
			for (const supervision of ['supervised', 'unsupervised', 'unknown'] as const) {
				expect(HandshakeRequestSchema.parse({ ...valid, supervision })).toEqual({
					...valid,
					supervision,
				});
			}
		});

		it('rejects a supervision value outside the vocabulary', () => {
			for (const supervision of ['launchd', 'SUPERVISED', '']) {
				expect(HandshakeRequestSchema.safeParse({ ...valid, supervision }).success).toBe(false);
			}
		});

		// Issue #608: a reconnecting daemon presents the lease it already holds. The
		// field is additive and optional in both directions, which is why
		// `TRANSPORT_PROTOCOL_VERSION` is deliberately not bumped for it — the shape
		// above (with no `reclaim`) is the older daemon's and stays valid.
		it('accepts a reclaim carrying the session id and fencing token it holds', () => {
			const reclaim = { sessionId: SESSION_ID, fencingToken: 4 };
			expect(HandshakeRequestSchema.parse({ ...valid, reclaim })).toEqual({ ...valid, reclaim });
		});

		it('rejects a malformed reclaim', () => {
			expect(
				HandshakeRequestSchema.safeParse({
					...valid,
					reclaim: { sessionId: 'not-a-uuid', fencingToken: 4 },
				}).success,
			).toBe(false);
			expect(
				HandshakeRequestSchema.safeParse({
					...valid,
					reclaim: { sessionId: SESSION_ID, fencingToken: 0 },
				}).success,
			).toBe(false);
			expect(
				HandshakeRequestSchema.safeParse({ ...valid, reclaim: { sessionId: SESSION_ID } }).success,
			).toBe(false);
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
				// The reset the CLI actually reported (issue #980), which is what the
				// control plane schedules the retry from.
				retryAfter: '2026-09-15T11:40:00.000Z',
				resetHint: '1:40pm (Europe/Warsaw)',
			};
			expect(TaskExecutionResultSchema.parse(frame)).toEqual(frame);
			// Both fields are optional, so an older worker's frame — which omits them —
			// still parses: no protocol-version bump was needed, and its `retryDelayMs`
			// is the fallback the control plane reads instead.
			const { retryAfter, resetHint, ...older } = frame;
			expect(TaskExecutionResultSchema.parse(older)).toEqual(older);
		});

		it('round-trips a deferred frame carrying the CLI’s own self-timeout notice', () => {
			const frame = {
				type: 'task-execution-result' as const,
				dispatchId: DISPATCH_ID,
				status: 'deferred' as const,
				phase: 'implementation' as const,
				taskId: '17',
				retryDelayMs: 60_000,
				resumable: true,
				failureKind: 'timeout',
				reason: 'CLI timed out',
				exitCode: 0,
				// Issue #1000: without it the control plane sees only `exitCode: 0` and
				// re-judges the worker's deferral into a terminal failure.
				cliSelfTimeout:
					'[agy] print timeout after 5m0s with turn in progress; returning partial output',
			};
			expect(TaskExecutionResultSchema.parse(frame)).toEqual(frame);
			// Optional and additive, so no protocol-version bump: an older worker omits
			// it and its frames parse exactly as they do today.
			const { cliSelfTimeout, ...older } = frame;
			expect(TaskExecutionResultSchema.parse(older)).toEqual(older);
		});

		// Validated as a loose string rather than `z.string().datetime()` on purpose: a
		// terminal result frame must never lose its whole settle over one optional field,
		// so an unparseable reset reaches the control plane and is handled there.
		it('accepts a non-ISO retryAfter rather than failing the whole deferred frame', () => {
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
				retryAfter: 'tomorrow-ish',
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
						url: 'https://github.com/SmartTechBrewery/swarm/issues/319',
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

		// Issue #952: the refused adoption the control plane rebuilds a
		// `BlockedRecoveryError` from, so the settle writes a recovery record instead of
		// the null write that erases `runs.recovery.preservedWorkerId`.
		it('round-trips a failed task-execution-result carrying the recovery gate’s refusal', () => {
			const frame = {
				type: 'task-execution-result' as const,
				dispatchId: DISPATCH_ID,
				status: 'failed' as const,
				phase: 'implementation' as const,
				taskId: '17',
				error: 'Checkpoint no longer matches the working tree',
				blockedReason: 'checkpoint-divergent',
			};
			expect(TaskExecutionResultSchema.parse(frame)).toEqual(frame);
		});

		// The field is additive in both directions, which is why
		// `TRANSPORT_PROTOCOL_VERSION` is not bumped: an older worker simply omits it and
		// its terminal failures settle exactly as they do today.
		it('accepts a failed task-execution-result from a worker that reports no refusal', () => {
			const older = {
				type: 'task-execution-result' as const,
				dispatchId: DISPATCH_ID,
				status: 'failed' as const,
				phase: 'implementation' as const,
				taskId: '17',
				error: 'worktree setup failed',
			};
			expect(TaskExecutionResultSchema.parse(older)).toEqual(older);
		});

		// A vocabulary this control plane does not model must still parse: rejecting the
		// frame would lose the whole settle over one field, which is the same reasoning
		// `failureKind` records.
		it('accepts a refusal reason newer than this control plane', () => {
			const parsed = TaskExecutionResultSchema.parse({
				type: 'task-execution-result',
				dispatchId: DISPATCH_ID,
				status: 'failed',
				phase: 'implementation',
				taskId: '17',
				error: 'blocked',
				blockedReason: 'lease-contested',
			});
			expect(parsed.blockedReason).toBe('lease-contested');
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

		// Issue #933. The frame that asks a *machine* to move to a build carries a
		// target ref and a request id and nothing else — the grammar is what makes it
		// data rather than an instruction, so these are schema-level assertions and not
		// a reviewer's promise.
		describe('worker-update (issue #933)', () => {
			const REQUEST_ID = '66666666-6666-4666-8666-666666666666';
			const valid = { type: 'worker-update' as const, requestId: REQUEST_ID, target: 'main' };

			it('round-trips through the cloud→worker union', () => {
				expect(ControlPlaneMessageSchema.parse(valid)).toEqual(valid);
			});

			it('accepts the three things a target may be: a branch, a tag, a commit', () => {
				for (const target of ['main', 'issue-933', 'release/1.2.3', 'v1.2.3', 'a1b2c3d']) {
					expect(WorkerUpdateSchema.safeParse({ ...valid, target }).success).toBe(true);
				}
			});

			// The exclusions that matter, stated one per class rather than exhaustively:
			// nothing that could be read as a URL, a shell fragment, a git option, a
			// refspec, or a revision expression can reach the daemon at all.
			it.each([
				['a URL', 'https://example.com/evil.git'],
				['an scp-style remote', 'git@example.com:evil/repo.git'],
				['a shell fragment', 'main; rm -rf /'],
				['a command substitution', 'main$(id)'],
				['a git option', '--upload-pack=curl'],
				['a refspec', 'main:refs/heads/main'],
				['a revision expression', 'main~2'],
				['a path traversal', '../../etc/passwd'],
				['an absolute path', '/usr/local/bin/swarm'],
				['whitespace', 'main other'],
			])('rejects %s as a target', (_what, target) => {
				expect(WorkerUpdateSchema.safeParse({ ...valid, target }).success).toBe(false);
			});

			it('requires both fields — neither is correlation-only', () => {
				expect(
					WorkerUpdateSchema.safeParse({ type: 'worker-update', target: 'main' }).success,
				).toBe(false);
				expect(
					WorkerUpdateSchema.safeParse({ type: 'worker-update', requestId: REQUEST_ID }).success,
				).toBe(false);
			});

			// A frame carrying anything that could *act* is the failure this design exists
			// to prevent, so the union must drop such a key rather than pass it through.
			it('drops a command smuggled alongside the target', () => {
				const parsed = ControlPlaneMessageSchema.parse({ ...valid, command: 'rm -rf /' });
				expect(parsed).toEqual(valid);
			});
		});

		// Issue #955. The frame that asks a *machine* to tidy its own checkouts carries
		// per project an id, a relative worktree root and an age — and nothing that could
		// name a directory on its own, since the machine's own repo root is what the root
		// is resolved against.
		describe('worktree-sweep (issue #955)', () => {
			const REQUEST_ID = '77777777-7777-4777-8777-777777777777';
			const valid = {
				type: 'worktree-sweep' as const,
				requestId: REQUEST_ID,
				projects: [
					{ projectId: 'swarm', worktreeRoot: '.swarm-workspaces', abandonedAfterDays: 10 },
				],
			};

			it('round-trips through the cloud→worker union', () => {
				expect(ControlPlaneMessageSchema.parse(valid)).toEqual(valid);
			});

			// A frame naming nothing asks for nothing: the dispatcher logs a machine with no
			// approved enrollment and leaves it alone rather than pushing an empty sweep.
			it('rejects a frame that names no project', () => {
				expect(WorktreeSweepSchema.safeParse({ ...valid, projects: [] }).success).toBe(false);
			});

			it('requires a whole-day, positive threshold', () => {
				for (const abandonedAfterDays of [0, -1, 1.5]) {
					expect(
						WorktreeSweepSchema.safeParse({
							...valid,
							projects: [{ ...valid.projects[0], abandonedAfterDays }],
						}).success,
					).toBe(false);
				}
			});

			// The daemon resolves `worktreeRoot` against its own `SWARM_WORKER_REPO_ROOT`,
			// so a frame carrying a path of its own would be the one way the wire could
			// point a sweep somewhere the machine does not already own.
			it('drops an absolute root smuggled alongside the relative one', () => {
				const parsed = ControlPlaneMessageSchema.parse({
					...valid,
					projects: [{ ...valid.projects[0], repoRoot: '/etc' }],
				});
				expect(parsed).toEqual(valid);
			});
		});

		it('discriminates a task-assignment frame to TaskAssignmentSchema', () => {
			const parsed = ControlPlaneMessageSchema.parse(VALID_ASSIGNMENT);
			expect(parsed.type).toBe('task-assignment');
		});

		it('round-trips a task-cancel frame through the union (issue #549)', () => {
			const frame = {
				type: 'task-cancel' as const,
				dispatchId: DISPATCH_ID,
				runId: '55555555-5555-4555-8555-555555555555',
				reason: 'a cancellation was requested for this run',
				// What the worker answers an unappliable cancel with (issue #724) — a
				// terminal result frame names both.
				phase: 'review' as const,
				taskId: '724',
			};
			expect(ControlPlaneMessageSchema.parse(frame)).toEqual(frame);
			// `runId`/`reason` are correlation and log context — a bare cancel is valid.
			expect(
				ControlPlaneMessageSchema.parse({ type: 'task-cancel', dispatchId: DISPATCH_ID }),
			).toEqual({ type: 'task-cancel', dispatchId: DISPATCH_ID });
		});

		// The #724 fields are additive in both directions, which is why
		// `TRANSPORT_PROTOCOL_VERSION` stays put: an older control plane omits them (and
		// the worker keeps its log-only behaviour), an older worker ignores them.
		it('parses a task-cancel that predates the phase/task it now names', () => {
			const old = {
				type: 'task-cancel' as const,
				dispatchId: DISPATCH_ID,
				runId: '55555555-5555-4555-8555-555555555555',
				reason: 'a cancellation was requested for this run',
			};
			const parsed = TaskCancelSchema.parse(old);
			expect(parsed).toEqual(old);
			expect(parsed.phase).toBeUndefined();
			expect(parsed.taskId).toBeUndefined();
			// An empty task id is not "absent" — it could never build a valid result frame.
			expect(TaskCancelSchema.safeParse({ ...old, phase: 'review', taskId: '' }).success).toBe(
				false,
			);
		});

		it('rejects a task-cancel without the dispatch it names', () => {
			expect(TaskCancelSchema.safeParse({ type: 'task-cancel' }).success).toBe(false);
			expect(
				TaskCancelSchema.safeParse({ type: 'task-cancel', dispatchId: 'not-a-uuid' }).success,
			).toBe(false);
		});

		// The additive contract behind adding `task-cancel` without a
		// `TRANSPORT_PROTOCOL_VERSION` bump: the union refuses a frame it does not
		// model, and the client treats that refusal as a logged no-op rather than a
		// reason to close the session (see `worker-client.test.ts`).
		it('rejects an unknown cloud→worker frame type', () => {
			expect(
				ControlPlaneMessageSchema.safeParse({ type: 'task-pause', dispatchId: DISPATCH_ID })
					.success,
			).toBe(false);
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
					url: 'https://github.com/SmartTechBrewery/swarm/issues/17',
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

		// The recovery intent the frame carries since issue #591. Optional and
		// additive in both directions, which is why `TRANSPORT_PROTOCOL_VERSION` is
		// deliberately not bumped: an older router omits it, an older worker ignores
		// it, and neither end rejects the other's frame.
		describe('recoveryMode', () => {
			it('accepts every RecoveryMode value', () => {
				for (const mode of RecoveryModeSchema.options) {
					const parsed = TaskAssignmentSchema.parse({ ...VALID_ASSIGNMENT, recoveryMode: mode });
					expect(parsed.recoveryMode).toBe(mode);
				}
			});

			it('rejects an unknown mode rather than passing it to the worktree gate', () => {
				// `'discard'` used to be the example here and is a real mode since issue
				// #592, so the unknown value has to be one no schema will ever accept.
				expect(
					TaskAssignmentSchema.safeParse({ ...VALID_ASSIGNMENT, recoveryMode: 'obliterate' })
						.success,
				).toBe(false);
			});

			it('parses a frame from an older router that carries none', () => {
				const parsed = TaskAssignmentSchema.parse(VALID_ASSIGNMENT);
				expect(parsed.recoveryMode).toBeUndefined();
			});
		});

		// The worker operator's own SCM credential (issue #765). Optional on the wire
		// for the same skew reason as `recoveryMode` above, even though a run cannot
		// proceed without one: the worker settles a frame carrying none with an
		// explicit reason, which a rejected frame could not.
		describe('operatorCredential', () => {
			it('parses a frame from an older router that carries none', () => {
				const parsed = TaskAssignmentSchema.parse(VALID_ASSIGNMENT);
				expect(parsed.operatorCredential).toBeUndefined();
			});

			it('carries the credential when present', () => {
				const parsed = TaskAssignmentSchema.parse({
					...VALID_ASSIGNMENT,
					operatorCredential: 'op-secret',
				});
				expect(parsed.operatorCredential).toBe('op-secret');
			});

			// An empty string is not "absent": it would reach the provider as a
			// credential and fail there, losing the attributable reason.
			it('rejects an empty credential', () => {
				expect(
					TaskAssignmentSchema.safeParse({ ...VALID_ASSIGNMENT, operatorCredential: '' }).success,
				).toBe(false);
			});
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

		// `comment` is a *retired* verdict SWARM no longer produces (issue #470) that
		// the frame deliberately still accepts: rejecting it would fail an older
		// worker's whole completion frame over one optional telemetry field, losing
		// the run's result. `src/router/dispatcher.ts` drops it when adapting the
		// frame. Asserting the exact superset keeps the guard's real job — a *new*
		// verdict that the frame didn't gain still fails here.
		const RETIRED_WIRE_VERDICTS = ['comment'] as const;

		it('verdict matches REVIEW_VERDICTS plus the retired wire values', () => {
			const verdict = TaskExecutionResultSchema.shape.verdict.unwrap();
			expect([...verdict.options].sort()).toEqual(
				[...REVIEW_VERDICTS, ...RETIRED_WIRE_VERDICTS].sort(),
			);
		});

		it('reviewAutomationOutcome matches REVIEW_AUTOMATION_OUTCOMES', () => {
			const outcome = TaskExecutionResultSchema.shape.reviewAutomationOutcome.unwrap();
			expect([...outcome.options].sort()).toEqual([...REVIEW_AUTOMATION_OUTCOMES].sort());
		});
	});

	describe('PostCommentDeliveryRequestSchema', () => {
		const valid = {
			projectId: 'swarm',
			prNumber: 42,
			body: 'Addressed the review',
			deliveryId: 'delivery-2',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		};

		// The frame gained `persona` after the reviewer was found answering its own
		// review (issue #444); the default is what keeps an existing client — one
		// that sends no persona — on its previous behaviour without a protocol bump.
		it('defaults an absent persona to reviewer', () => {
			const parsed = PostCommentDeliveryRequestSchema.parse(valid);
			expect(parsed.persona).toBe('reviewer');
		});

		it('round-trips an explicit implementer persona', () => {
			const parsed = PostCommentDeliveryRequestSchema.parse({ ...valid, persona: 'implementer' });
			expect(parsed.persona).toBe('implementer');
		});

		it('rejects a persona that is neither', () => {
			expect(
				PostCommentDeliveryRequestSchema.safeParse({ ...valid, persona: 'operator' }).success,
			).toBe(false);
		});
	});

	// Issue #933 — the answer to a `worker-update`, on a route rather than the stream
	// (see the schema's own comment for why).
	describe('ReportWorkerUpdateDeliveryRequestSchema', () => {
		const valid = {
			requestId: '66666666-6666-4666-8666-666666666666',
			target: 'main',
			status: 'applied' as const,
			message: 'Applied: the SWARM install root moved to abc1234 and was rebuilt there.',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		};

		it('round-trips every status the vocabulary admits', () => {
			for (const status of [
				'applied',
				'adopted',
				'already-current',
				'refused',
				'failed',
				'declined',
			]) {
				expect(
					ReportWorkerUpdateDeliveryRequestSchema.safeParse({ ...valid, status }).success,
				).toBe(true);
			}
		});

		it('rejects a status outside the vocabulary', () => {
			expect(
				ReportWorkerUpdateDeliveryRequestSchema.safeParse({ ...valid, status: 'in-progress' })
					.success,
			).toBe(false);
		});

		// The echoed target is held to the same grammar the request frame is: a report
		// is recorded and shown to an operator, and a value that could not have been
		// asked for is not an answer to anything.
		it('rejects an echoed target that is not a well-formed ref', () => {
			expect(
				ReportWorkerUpdateDeliveryRequestSchema.safeParse({
					...valid,
					target: 'https://example.com/evil.git',
				}).success,
			).toBe(false);
		});

		it('names no worker — identity is the credential the request authenticates with', () => {
			const parsed = ReportWorkerUpdateDeliveryRequestSchema.parse({
				...valid,
				workerId: '11111111-1111-4111-8111-111111111111',
			});
			expect(parsed).not.toHaveProperty('workerId');
		});

		it('refuses to be a log sink', () => {
			expect(
				ReportWorkerUpdateDeliveryRequestSchema.safeParse({ ...valid, message: 'x'.repeat(4001) })
					.success,
			).toBe(false);
			expect(
				ReportWorkerUpdateDeliveryRequestSchema.safeParse({ ...valid, message: '' }).success,
			).toBe(false);
		});

		it('answers with whether the report closed the request that was pending', () => {
			expect(ReportWorkerUpdateDeliveryResponseSchema.parse({ recorded: false })).toEqual({
				recorded: false,
			});
		});
	});

	// Issue #955 — the answer to a `worktree-sweep`, on a route rather than the stream
	// for the reason the update report already states.
	describe('ReportWorktreeSweepDeliveryRequestSchema', () => {
		const removal = {
			projectId: 'swarm',
			taskId: '955',
			path: '/home/ada/swarm/.swarm-workspaces/task-955',
			lastTouchedAt: '2026-08-30T09:00:00.000Z',
			ageDays: 15,
			hadUncommittedChanges: true,
			hadUnpushedCommits: false,
		};
		const valid = {
			requestId: '77777777-7777-4777-8777-777777777777',
			status: 'swept' as const,
			removed: [removal],
			removedCount: 1,
			keptLiveCount: 2,
			failedCount: 0,
			message: 'Swept 1 project(s): removed 1 abandoned checkout(s), kept 2 still in use.',
			protocolVersion: TRANSPORT_PROTOCOL_VERSION,
		};

		it('round-trips a report of what one machine removed', () => {
			expect(ReportWorktreeSweepDeliveryRequestSchema.parse(valid)).toEqual(valid);
		});

		it('rejects a status outside the vocabulary', () => {
			expect(
				ReportWorktreeSweepDeliveryRequestSchema.safeParse({ ...valid, status: 'partial' }).success,
			).toBe(false);
		});

		// The dirty/unpushed pair is the whole reason the record is durable, so a removal
		// that omits either is not a removal this wire accepts.
		it('requires every removal to say what work it destroyed', () => {
			const { hadUnpushedCommits: _omitted, ...incomplete } = removal;
			expect(
				ReportWorktreeSweepDeliveryRequestSchema.safeParse({ ...valid, removed: [incomplete] })
					.success,
			).toBe(false);
		});

		it('names no worker — identity is the credential the request authenticates with', () => {
			const parsed = ReportWorktreeSweepDeliveryRequestSchema.parse({
				...valid,
				workerId: '11111111-1111-4111-8111-111111111111',
			});
			expect(parsed).not.toHaveProperty('workerId');
		});

		// Capped detail, uncapped count: a machine that removed hundreds still reports
		// how many, and the wire still refuses to be a log sink.
		it('caps the removals it carries while leaving the true total unbounded', () => {
			expect(
				ReportWorktreeSweepDeliveryRequestSchema.safeParse({
					...valid,
					removed: Array.from({ length: 201 }, () => removal),
				}).success,
			).toBe(false);
			expect(
				ReportWorktreeSweepDeliveryRequestSchema.safeParse({
					...valid,
					removed: [removal],
					removedCount: 4096,
				}).success,
			).toBe(true);
			expect(
				ReportWorktreeSweepDeliveryRequestSchema.safeParse({ ...valid, message: 'x'.repeat(4001) })
					.success,
			).toBe(false);
		});

		it('answers with whether the report closed the request that was pending', () => {
			expect(ReportWorktreeSweepDeliveryResponseSchema.parse({ recorded: false })).toEqual({
				recorded: false,
			});
		});
	});
});
