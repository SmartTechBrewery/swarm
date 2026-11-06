import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The operator MCP endpoint (issue #1338), driven through the **real mount** with a
 * real bearer and real JSON-RPC, so what is under test is exactly what an MCP
 * client connected to `/operator/mcp` reaches: the bearer gate, the tool list, and
 * the dashboard's own authorization carried through each tool call.
 *
 * Mocked at the same boundaries `./operator-api-runs.test.ts` uses — the run
 * repository reads, the membership service the authz helpers consult, and the one
 * dispatch read `getById`'s enrichment makes for a settled run — plus the worker
 * read models the `workers` procedures assemble their rows from (issue #1341), whose
 * own suites live beside the service.
 */
const {
	listRunsFromDb,
	getRunByIdFromDb,
	getRunLogsFromDb,
	getRunOutputEvents,
	listSnapshotRunsForProject,
	countRunsSettledSinceByStatus,
	getLatestCompletedReviewRunForPullRequest,
	countRunsByStatusAndPhase,
	countMergedPullRequestsByRepository,
} = vi.hoisted(() => ({
	listRunsFromDb: vi.fn(),
	getRunByIdFromDb: vi.fn(),
	getRunLogsFromDb: vi.fn(),
	getRunOutputEvents: vi.fn(),
	listSnapshotRunsForProject: vi.fn(),
	countRunsSettledSinceByStatus: vi.fn(),
	getLatestCompletedReviewRunForPullRequest: vi.fn(),
	countRunsByStatusAndPhase: vi.fn(),
	countMergedPullRequestsByRepository: vi.fn(),
}));
vi.mock('@/db/repositories/runsRepository.js', async () => ({
	...(await vi.importActual<typeof import('@/db/repositories/runsRepository.js')>(
		'@/db/repositories/runsRepository.js',
	)),
	listRunsFromDb,
	getRunByIdFromDb,
	getRunLogsFromDb,
	getRunOutputEvents,
	listSnapshotRunsForProject,
	countRunsSettledSinceByStatus,
	getLatestCompletedReviewRunForPullRequest,
	countRunsByStatusAndPhase,
	countMergedPullRequestsByRepository,
}));
// The review-verdict ledger read and the project record read behind `pr_status` and
// `phase_agents_get` (issue #1342); the ledger's pure cap predicates stay real.
const { listActiveReviewSlotsForPullRequest } = vi.hoisted(() => ({
	listActiveReviewSlotsForPullRequest: vi.fn(),
}));
vi.mock('@/db/repositories/reviewVerdictsRepository.js', async () => ({
	...(await vi.importActual<typeof import('@/db/repositories/reviewVerdictsRepository.js')>(
		'@/db/repositories/reviewVerdictsRepository.js',
	)),
	listActiveReviewSlotsForPullRequest,
}));
const { findProjectRecordByIdFromDb } = vi.hoisted(() => ({
	findProjectRecordByIdFromDb: vi.fn(),
}));
vi.mock('@/db/repositories/projectsRepository.js', async () => ({
	...(await vi.importActual<typeof import('@/db/repositories/projectsRepository.js')>(
		'@/db/repositories/projectsRepository.js',
	)),
	findProjectRecordByIdFromDb,
}));
const { getMembership, listAccessibleProjectIds } = vi.hoisted(() => ({
	getMembership: vi.fn(),
	listAccessibleProjectIds: vi.fn(),
}));
vi.mock('@/identity/membership-service.js', async () => ({
	...(await vi.importActual<typeof import('@/identity/membership-service.js')>(
		'@/identity/membership-service.js',
	)),
	getMembership,
	listAccessibleProjectIds,
}));
const { getActiveDispatchByRunId, listOpenDispatchesForProject, listDispatchesForTask } =
	vi.hoisted(() => ({
		getActiveDispatchByRunId: vi.fn(),
		listOpenDispatchesForProject: vi.fn(),
		listDispatchesForTask: vi.fn(),
	}));
vi.mock('@/db/repositories/dispatchesRepository.js', async () => ({
	...(await vi.importActual<typeof import('@/db/repositories/dispatchesRepository.js')>(
		'@/db/repositories/dispatchesRepository.js',
	)),
	getActiveDispatchByRunId,
	listOpenDispatchesForProject,
	listDispatchesForTask,
}));

const { listDashboardWorkers, listProjectWorkerIdsInOrder, listWorkerProjectCapacity } = vi.hoisted(
	() => ({
		listDashboardWorkers: vi.fn(),
		listProjectWorkerIdsInOrder: vi.fn(),
		listWorkerProjectCapacity: vi.fn(),
	}),
);
vi.mock('@/identity/worker-enrollment-service.js', async () => ({
	...(await vi.importActual<typeof import('@/identity/worker-enrollment-service.js')>(
		'@/identity/worker-enrollment-service.js',
	)),
	listDashboardWorkers,
	listProjectWorkerIdsInOrder,
	listWorkerProjectCapacity,
}));

import type { SwarmUser } from '@/identity/schema.js';
import { type OperatorMcpDeps, registerOperatorMcp } from '@/router/operator-mcp.js';
import { createMockProjectRecord } from '../../helpers/factories.js';

function user(id: string, identifier: string, instanceAdmin: boolean): SwarmUser {
	return {
		id,
		identifier,
		displayName: identifier,
		instanceAdmin,
		createdAt: new Date('2026-01-01T00:00:00Z'),
		updatedAt: new Date('2026-01-01T00:00:00Z'),
	};
}

const ADMIN = user('11111111-1111-4111-8111-111111111111', 'admin@example.com', true);
const MEMBER = user('22222222-2222-4222-8222-222222222222', 'member@example.com', false);
const STRANGER = user('33333333-3333-4333-8333-333333333333', 'stranger@example.com', false);
const TOKENS: Record<string, SwarmUser> = {
	'admin-token': ADMIN,
	'member-token': MEMBER,
	'stranger-token': STRANGER,
};

const RUN_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_PROJECT_RUN_ID = '55555555-5555-4555-8555-555555555555';

function failedRun(id = RUN_ID, projectId = 'proj-a') {
	return {
		id,
		projectId,
		kind: 'pipeline',
		phase: 'implementation',
		status: 'failed',
		repository: 'acme/widgets',
		taskId: '7',
		workItemTitle: 'Fix the widget',
		workerId: null,
		workerUserId: null,
		maintenanceMachine: null,
		recovery: null,
		checkpoint: null,
		reviewOrdinal: null,
		prNumber: null,
		timeoutMs: null,
		error: 'Agent exited 1',
		failureDiagnosis: null,
		startedAt: new Date('2026-10-28T10:00:00Z'),
		completedAt: new Date('2026-10-28T10:05:00Z'),
	};
}

const LOGS = { stdout: 'agent stdout', stderr: 'agent stderr' };
const OUTPUT_PAGE = {
	events: [{ id: 1, stream: 'stdout', content: 'hello\n', emittedAt: new Date('2026-10-28') }],
	nextCursor: 1,
	hasMore: false,
	truncated: false,
	retentionBytes: 1_000_000,
};

const WORKER_ID = '77777777-7777-4777-8777-777777777777';
const COOLING_WORKER_ID = '88888888-8888-4888-8888-888888888888';
const CAPACITY = [
	{
		projectId: 'proj-a',
		status: 'active',
		isRoutable: true,
		concurrencyAllocation: 2,
		activeRuns: 1,
	},
];
const COOL_DOWN = {
	cli: 'claude',
	workerId: COOLING_WORKER_ID,
	expiresAt: new Date('2026-11-06T18:00:00Z'),
	observedAt: new Date('2026-11-06T10:00:00Z'),
	resetHint: 'resets 6pm (UTC)',
};

/** A roster row as `listDashboardWorkers` assembles it, reduced to what the tools read. */
function workerRow(workerId: string, displayName: string, rateLimits: (typeof COOL_DOWN)[]) {
	return {
		workerId,
		displayName,
		owner: null,
		connection: 'online',
		lastSeenAt: new Date('2026-11-06T10:30:00Z'),
		drainingSince: null,
		currentRun: null,
		rateLimits,
		update: null,
	};
}

let resolveSession: ReturnType<typeof vi.fn<OperatorMcpDeps['resolveSession']>>;

function appWith(): Hono {
	const app = new Hono();
	registerOperatorMcp(app, { resolveSession });
	return app;
}

/** One JSON-RPC request over Streamable HTTP, as an MCP client sends it. */
function rpc(method: string, params: Record<string, unknown>, token?: string) {
	return appWith().request('/operator/mcp', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
}

interface ToolResult {
	isError?: boolean;
	content: Array<{ type: string; text: string }>;
	structuredContent?: Record<string, unknown>;
}

async function callTool(name: string, args: Record<string, unknown>, token: string) {
	const response = await rpc('tools/call', { name, arguments: args }, token);
	expect(response.status).toBe(200);
	const body = (await response.json()) as { result: ToolResult };
	return body.result;
}

beforeEach(() => {
	resolveSession = vi.fn(async (token: string) => TOKENS[token]);
	listRunsFromDb.mockReset().mockResolvedValue({ data: [], total: 0 });
	getRunByIdFromDb
		.mockReset()
		.mockImplementation(async (id: string) =>
			id === RUN_ID
				? failedRun()
				: id === OTHER_PROJECT_RUN_ID
					? failedRun(OTHER_PROJECT_RUN_ID, 'proj-b')
					: undefined,
		);
	getRunLogsFromDb.mockReset().mockResolvedValue(LOGS);
	getRunOutputEvents.mockReset().mockResolvedValue(OUTPUT_PAGE);
	getActiveDispatchByRunId.mockReset().mockResolvedValue(undefined);
	listSnapshotRunsForProject.mockReset().mockResolvedValue([]);
	countRunsSettledSinceByStatus.mockReset().mockResolvedValue({});
	listOpenDispatchesForProject.mockReset().mockResolvedValue([]);
	listDispatchesForTask.mockReset().mockResolvedValue([]);
	getMembership
		.mockReset()
		.mockImplementation(async (userId: string, projectId: string) =>
			userId === MEMBER.id && projectId === 'proj-a'
				? { id: 'm1', userId, projectId, role: 'contributor', createdAt: new Date(0) }
				: undefined,
		);
	listAccessibleProjectIds
		.mockReset()
		.mockImplementation(async (userId: string) => (userId === MEMBER.id ? ['proj-a'] : []));
	listDashboardWorkers.mockReset().mockResolvedValue([workerRow(WORKER_ID, 'idle-box', [])]);
	listProjectWorkerIdsInOrder.mockReset().mockResolvedValue([]);
	listWorkerProjectCapacity.mockReset().mockResolvedValue(CAPACITY);
	getLatestCompletedReviewRunForPullRequest.mockReset().mockResolvedValue(undefined);
	countRunsByStatusAndPhase.mockReset().mockResolvedValue({ byStatus: {}, byPhase: {} });
	countMergedPullRequestsByRepository.mockReset().mockResolvedValue({});
	listActiveReviewSlotsForPullRequest.mockReset().mockResolvedValue([]);
	findProjectRecordByIdFromDb.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('operator MCP — the bearer gate', () => {
	it('refuses a request carrying no bearer, before any MCP handling', async () => {
		const response = await rpc('tools/list', {});

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'Unauthorized' });
		expect(resolveSession).not.toHaveBeenCalled();
	});

	it('refuses a token the session service rejects', async () => {
		const response = await rpc('tools/call', { name: 'runs_list', arguments: {} }, 'revoked');

		expect(response.status).toBe(401);
		expect(resolveSession).toHaveBeenCalledWith('revoked');
		expect(listRunsFromDb).not.toHaveBeenCalled();
	});

	// Same reasoning as `/operator/trpc`: the branch that is safe on the loopback API
	// server would make anyone who found this URL an installation admin.
	it('does not honour SWARM_SINGLE_USER_MODE', async () => {
		vi.stubEnv('SWARM_SINGLE_USER_MODE', 'true');

		const response = await rpc('tools/call', { name: 'runs_list', arguments: {} });

		expect(response.status).toBe(401);
		expect(listRunsFromDb).not.toHaveBeenCalled();
	});

	it.each(['GET', 'DELETE'])('answers %s with 405: the server is stateless', async (method) => {
		const response = await appWith().request('/operator/mcp', {
			method,
			headers: { authorization: 'Bearer member-token', accept: 'text/event-stream' },
		});

		expect(response.status).toBe(405);
		expect(response.headers.get('allow')).toBe('POST');
	});
});

describe('operator MCP — the handshake', () => {
	it('initializes as the swarm server and lists exactly the read tools', async () => {
		const init = await rpc(
			'initialize',
			{
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'test', version: '0' },
			},
			'member-token',
		);
		expect(init.status).toBe(200);
		expect(init.headers.get('mcp-session-id')).toBeNull();
		const initBody = (await init.json()) as { result: { serverInfo: { name: string } } };
		expect(initBody.result.serverInfo.name).toBe('swarm');

		const list = await rpc('tools/list', {}, 'member-token');
		const listBody = (await list.json()) as {
			result: { tools: Array<{ name: string; annotations?: { readOnlyHint?: boolean } }> };
		};
		const tools = listBody.result.tools;

		expect(tools.map((tool) => tool.name).sort()).toEqual([
			'cli_rate_limits',
			'dispatch_history',
			'phase_agents_get',
			'pipeline_snapshot',
			'pipeline_stats',
			'pr_status',
			'run_get',
			'runs_list',
			'workers_state',
		]);
		for (const tool of tools) expect(tool.annotations?.readOnlyHint).toBe(true);
	});
});

describe('operator MCP — runs_list', () => {
	it("lists a member's own projects only when unscoped", async () => {
		const run = failedRun();
		listRunsFromDb.mockResolvedValue({ data: [run], total: 1 });

		const result = await callTool('runs_list', {}, 'member-token');

		expect(result.isError).toBeUndefined();
		expect(listRunsFromDb).toHaveBeenCalledWith({ limit: 50, offset: 0, projectIds: ['proj-a'] });
		expect(result.structuredContent).toMatchObject({ total: 1, data: [{ id: RUN_ID }] });
		expect(JSON.parse(result.content[0]?.text ?? '')).toEqual(result.structuredContent);
	});

	it("passes the procedure's filters through, converting the time window", async () => {
		await callTool(
			'runs_list',
			{
				projectId: 'proj-a',
				status: 'failed',
				phase: 'review',
				since: '2026-10-01T00:00:00Z',
				limit: 10,
				offset: 20,
			},
			'member-token',
		);

		expect(listRunsFromDb).toHaveBeenCalledWith({
			projectId: 'proj-a',
			status: 'failed',
			phase: 'review',
			limit: 10,
			offset: 20,
			startedSince: new Date('2026-10-01T00:00:00Z'),
		});
	});

	// Issue #1339 — the widened filters, including a status array.
	it('accepts several statuses and the widened filters and ordering', async () => {
		listRunsFromDb.mockResolvedValue({ data: [], total: 0 });

		const result = await callTool(
			'runs_list',
			{
				projectId: 'proj-a',
				status: ['failed', 'deferred'],
				taskId: '42',
				prNumber: 7,
				cli: 'codex',
				completedSince: '2026-10-01T00:00:00Z',
				sort: 'completedAt',
				order: 'asc',
			},
			'member-token',
		);

		expect(result.isError).toBeUndefined();
		expect(listRunsFromDb).toHaveBeenCalledWith({
			projectId: 'proj-a',
			status: ['failed', 'deferred'],
			taskId: '42',
			prNumber: '7',
			cli: 'codex',
			completedSince: new Date('2026-10-01T00:00:00Z'),
			sort: 'completedAt',
			order: 'asc',
			limit: 50,
			offset: 0,
		});
	});

	it('returns the list-only row facts the repository computes', async () => {
		listRunsFromDb.mockResolvedValue({
			data: [{ ...failedRun(), retryCount: 2, errorSummary: 'Agent exited with code 1' }],
			total: 1,
		});

		const result = await callTool('runs_list', {}, 'member-token');

		expect(result.structuredContent).toMatchObject({
			data: [{ id: RUN_ID, retryCount: 2, errorSummary: 'Agent exited with code 1' }],
		});
	});

	it('lists the whole installation for an instance admin', async () => {
		await callTool('runs_list', {}, 'admin-token');

		expect(listRunsFromDb).toHaveBeenCalledWith({ limit: 50, offset: 0 });
	});

	it("reports the procedure's refusal of a project the caller cannot read", async () => {
		const result = await callTool('runs_list', { projectId: 'proj-a' }, 'stranger-token');

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toMatch(/^NOT_FOUND: /);
		expect(listRunsFromDb).not.toHaveBeenCalled();
	});

	it('rejects a filter the procedure would reject', async () => {
		const result = await callTool('runs_list', { limit: 500 }, 'member-token');

		expect(result.isError).toBe(true);
		expect(listRunsFromDb).not.toHaveBeenCalled();
	});
});

describe('operator MCP — run_get', () => {
	it('reads a run of their project with its output, without logs by default', async () => {
		const result = await callTool('run_get', { runId: RUN_ID }, 'member-token');

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toMatchObject({
			run: { id: RUN_ID, error: 'Agent exited 1' },
			output: { nextCursor: 1, events: [{ content: 'hello\n' }] },
		});
		expect(result.structuredContent).not.toHaveProperty('logs');
		expect(getRunOutputEvents).toHaveBeenCalledWith(RUN_ID, 0);
		expect(getRunLogsFromDb).not.toHaveBeenCalled();
	});

	it('reads logs and pages output on request', async () => {
		const result = await callTool(
			'run_get',
			{ runId: RUN_ID, includeOutput: true, outputAfter: 5, includeLogs: true },
			'member-token',
		);

		expect(result.structuredContent).toMatchObject({ logs: LOGS });
		expect(getRunOutputEvents).toHaveBeenCalledWith(RUN_ID, 5);
	});

	it('skips the output read when asked to', async () => {
		const result = await callTool(
			'run_get',
			{ runId: RUN_ID, includeOutput: false },
			'member-token',
		);

		expect(result.structuredContent).not.toHaveProperty('output');
		expect(getRunOutputEvents).not.toHaveBeenCalled();
	});

	// The dashboard hides a run's existence from a non-member behind the very same
	// not-found an unknown id gets, so the tool must not tell the two apart either.
	it('reports a run in another project exactly as an unknown run, reading nothing else', async () => {
		const refused = await callTool(
			'run_get',
			{ runId: OTHER_PROJECT_RUN_ID, includeLogs: true },
			'member-token',
		);
		const unknownId = '66666666-6666-4666-8666-666666666666';
		const unknown = await callTool('run_get', { runId: unknownId }, 'member-token');

		expect(refused.isError).toBe(true);
		expect(refused.content[0]?.text).toBe(
			`NOT_FOUND: Run with ID "${OTHER_PROJECT_RUN_ID}" not found`,
		);
		expect(unknown.content[0]?.text).toBe(`NOT_FOUND: Run with ID "${unknownId}" not found`);
		expect(getRunOutputEvents).not.toHaveBeenCalled();
		expect(getRunLogsFromDb).not.toHaveBeenCalled();
	});
});

describe('operator MCP — pipeline_snapshot', () => {
	it("reads a member's project in one call", async () => {
		listSnapshotRunsForProject.mockResolvedValue([
			{
				...failedRun(),
				prTitle: null,
				nextRetryAt: null,
				continuationCount: 0,
			},
		]);
		countRunsSettledSinceByStatus.mockResolvedValue({ completed: 3, failed: 1 });

		const result = await callTool('pipeline_snapshot', { projectId: 'proj-a' }, 'member-token');

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toMatchObject({
			projectId: 'proj-a',
			windowHours: 12,
			runs: [{ id: RUN_ID, status: 'failed', error: 'Agent exited 1' }],
			dispatches: [],
			completedCounts: { byStatus: { completed: 3, failed: 1 } },
			truncated: { runs: false, dispatches: false },
		});
		expect(listSnapshotRunsForProject).toHaveBeenCalledWith(
			'proj-a',
			expect.any(Date),
			expect.any(Number),
		);
	});

	it("reports the procedure's refusal of a project the caller cannot read", async () => {
		const result = await callTool('pipeline_snapshot', { projectId: 'proj-a' }, 'stranger-token');

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toMatch(/^NOT_FOUND: /);
		expect(listSnapshotRunsForProject).not.toHaveBeenCalled();
	});
});

describe('operator MCP — dispatch_history', () => {
	it("reads a task's dispatches in a member's project", async () => {
		listDispatchesForTask.mockResolvedValue([
			{
				id: 'dispatch-1',
				projectId: 'proj-a',
				taskId: '7',
				phase: 'implementation',
				repository: 'acme/widgets',
				prNumber: null,
				state: 'failed',
				waitReason: null,
				outcome: null,
				attempt: 2,
				priority: 0,
				availableAt: new Date('2026-10-28T10:00:00Z'),
				jobPayload: {},
				runId: RUN_ID,
				selectedWorkerId: null,
				lastError: 'Agent exited 1',
				source: 'webhook',
				createdAt: new Date('2026-10-28T09:59:00Z'),
				completedAt: new Date('2026-10-28T10:05:00Z'),
			},
		]);

		const result = await callTool(
			'dispatch_history',
			{ projectId: 'proj-a', taskId: '7' },
			'member-token',
		);

		expect(result.isError).toBeUndefined();
		expect(listDispatchesForTask).toHaveBeenCalledWith(
			'proj-a',
			{ taskId: '7' },
			expect.any(Number),
		);
		expect(result.structuredContent).toMatchObject({
			dispatches: [
				{ id: 'dispatch-1', state: 'failed', runId: RUN_ID, lastError: 'Agent exited 1' },
			],
			truncated: false,
		});
	});

	it('refuses a history naming neither a task nor a pull request', async () => {
		const result = await callTool('dispatch_history', { projectId: 'proj-a' }, 'member-token');

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toMatch(/^BAD_REQUEST: /);
		expect(listDispatchesForTask).not.toHaveBeenCalled();
	});

	it("reports the procedure's refusal of a project the caller cannot read", async () => {
		const result = await callTool(
			'dispatch_history',
			{ projectId: 'proj-a', prNumber: '42' },
			'stranger-token',
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toMatch(/^NOT_FOUND: /);
		expect(listDispatchesForTask).not.toHaveBeenCalled();
	});
});

describe('operator MCP — workers_state', () => {
	it("reads a contributor's project workers with their capacity in use", async () => {
		const result = await callTool('workers_state', { projectId: 'proj-a' }, 'member-token');

		expect(result.isError).toBeUndefined();
		expect(listDashboardWorkers).toHaveBeenCalledWith(['proj-a']);
		expect(listWorkerProjectCapacity).toHaveBeenCalledWith(WORKER_ID, ['proj-a']);
		expect(result.structuredContent).toEqual({
			workers: [
				{
					workerId: WORKER_ID,
					displayName: 'idle-box',
					owner: null,
					connection: 'online',
					lastSeenAt: '2026-11-06T10:30:00.000Z',
					draining: false,
					drainingSince: null,
					currentRun: null,
					enrollments: CAPACITY,
				},
			],
		});
	});

	it('refuses a non-admin who names no project, reading nothing', async () => {
		const result = await callTool('workers_state', {}, 'member-token');

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toMatch(/^FORBIDDEN: /);
		expect(listDashboardWorkers).not.toHaveBeenCalled();
	});

	it('hides a project the caller is not a member of', async () => {
		const result = await callTool('workers_state', { projectId: 'proj-a' }, 'stranger-token');

		expect(result.content[0]?.text).toBe('NOT_FOUND: Project with ID "proj-a" not found');
		expect(listDashboardWorkers).not.toHaveBeenCalled();
	});

	it('reads the whole installation for an instance admin', async () => {
		const result = await callTool('workers_state', {}, 'admin-token');

		expect(result.isError).toBeUndefined();
		expect(listDashboardWorkers).toHaveBeenCalledWith(null);
		expect(listWorkerProjectCapacity).toHaveBeenCalledWith(WORKER_ID, null);
	});
});

describe('operator MCP — cli_rate_limits', () => {
	beforeEach(() => {
		listDashboardWorkers.mockResolvedValue([
			workerRow(WORKER_ID, 'idle-box', []),
			workerRow(COOLING_WORKER_ID, 'cooling-box', [COOL_DOWN]),
		]);
	});

	it("lists only the project's cooling workers, with each limit's reset hint", async () => {
		const result = await callTool('cli_rate_limits', { projectId: 'proj-a' }, 'member-token');

		expect(result.isError).toBeUndefined();
		expect(listDashboardWorkers).toHaveBeenCalledWith(['proj-a']);
		expect(result.structuredContent).toEqual({
			workers: [
				{
					workerId: COOLING_WORKER_ID,
					displayName: 'cooling-box',
					rateLimits: [
						{
							cli: 'claude',
							expiresAt: '2026-11-06T18:00:00.000Z',
							observedAt: '2026-11-06T10:00:00.000Z',
							resetHint: 'resets 6pm (UTC)',
						},
					],
				},
			],
		});
	});

	it('returns a named worker even when it is cooling on nothing', async () => {
		const result = await callTool(
			'cli_rate_limits',
			{ projectId: 'proj-a', workerId: WORKER_ID },
			'member-token',
		);

		expect(result.structuredContent).toEqual({
			workers: [{ workerId: WORKER_ID, displayName: 'idle-box', rateLimits: [] }],
		});
	});

	it('reports a worker outside the scope exactly as an unknown one', async () => {
		const unknownId = '99999999-9999-4999-8999-999999999999';
		const result = await callTool(
			'cli_rate_limits',
			{ projectId: 'proj-a', workerId: unknownId },
			'member-token',
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toBe(`NOT_FOUND: Worker with ID "${unknownId}" not found`);
	});

	it('refuses a non-admin who names no project, and a stranger naming one', async () => {
		const unscoped = await callTool('cli_rate_limits', {}, 'member-token');
		const stranger = await callTool('cli_rate_limits', { projectId: 'proj-a' }, 'stranger-token');

		expect(unscoped.content[0]?.text).toMatch(/^FORBIDDEN: /);
		expect(stranger.content[0]?.text).toMatch(/^NOT_FOUND: /);
		expect(listDashboardWorkers).not.toHaveBeenCalled();
	});

	it('reads the whole installation for an instance admin', async () => {
		const result = await callTool('cli_rate_limits', {}, 'admin-token');

		expect(listDashboardWorkers).toHaveBeenCalledWith(null);
		expect(result.structuredContent).toMatchObject({
			workers: [{ workerId: COOLING_WORKER_ID }],
		});
	});
});

describe('operator MCP — pr_status', () => {
	const PR = { projectId: 'proj-a', repository: 'acme/app', prNumber: 42 };

	function submitted(ordinal: number, overrides: Record<string, unknown> = {}) {
		return {
			ordinal,
			state: 'submitted',
			headSha: `head-${ordinal}`,
			capOverrideGrantedAt: null,
			capOverrideConsumedAt: null,
			dispatchActive: false,
			superseded: false,
			...overrides,
		};
	}

	it("reads a capped pull request's merge outcome, verdict count and outstanding grant", async () => {
		getLatestCompletedReviewRunForPullRequest.mockResolvedValue({
			...failedRun(),
			phase: 'review',
			status: 'completed',
			reviewVerdict: 'request-changes',
			reviewMergeOutcome: null,
			reviewMergeMessage: null,
		});
		listActiveReviewSlotsForPullRequest.mockResolvedValue([
			submitted(1),
			submitted(2),
			submitted(3, { capOverrideGrantedAt: new Date('2026-11-06T09:00:00Z') }),
		]);

		const result = await callTool('pr_status', PR, 'member-token');

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual({
			lastReviewRunId: RUN_ID,
			lastReviewVerdict: 'request-changes',
			lastReviewedHeadSha: 'head-3',
			mergeOutcome: null,
			mergeOutcomeMessage: null,
			verdictCount: 3,
			verdictCap: 3,
			supersededCount: 0,
			supersededCap: 5,
			capReached: true,
			capBound: 'verdict-cap',
			overrideOutstanding: true,
		});
		expect(listActiveReviewSlotsForPullRequest).toHaveBeenCalledWith('proj-a', 'acme/app', '42');
	});

	it('hides a project the caller is not a member of, reading nothing', async () => {
		const result = await callTool('pr_status', PR, 'stranger-token');

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toMatch(/^NOT_FOUND: /);
		expect(getLatestCompletedReviewRunForPullRequest).not.toHaveBeenCalled();
		expect(listActiveReviewSlotsForPullRequest).not.toHaveBeenCalled();
	});
});

describe('operator MCP — pipeline_stats', () => {
	const PERIOD = {
		projectId: 'proj-a',
		since: '2026-11-01T00:00:00.000Z',
		until: '2026-11-06T00:00:00.000Z',
	};

	it("counts a member's project for the period", async () => {
		countRunsByStatusAndPhase.mockResolvedValue({
			byStatus: { completed: 5, failed: 2 },
			byPhase: { implementation: 3, review: 4 },
		});
		countMergedPullRequestsByRepository.mockResolvedValue({ 'acme/app': 2, 'acme/web': 1 });

		const result = await callTool('pipeline_stats', PERIOD, 'member-token');

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual({
			runsByStatus: { completed: 5, failed: 2 },
			runsByPhase: { implementation: 3, review: 4 },
			mergedPrsByRepository: { 'acme/app': 2, 'acme/web': 1 },
			since: PERIOD.since,
			until: PERIOD.until,
		});
		expect(countRunsByStatusAndPhase).toHaveBeenCalledWith('proj-a', {
			since: new Date(PERIOD.since),
			until: new Date(PERIOD.until),
		});
	});

	it('hides a project the caller is not a member of, counting nothing', async () => {
		const result = await callTool('pipeline_stats', PERIOD, 'stranger-token');

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toMatch(/^NOT_FOUND: /);
		expect(countRunsByStatusAndPhase).not.toHaveBeenCalled();
		expect(countMergedPullRequestsByRepository).not.toHaveBeenCalled();
	});
});

describe('operator MCP — phase_agents_get', () => {
	const REVIEW_AGENT = {
		targets: [
			{ cli: 'codex' as const, model: 'gpt-5.6-sol', reasoning: 'high' as const },
			{ cli: 'claude' as const, model: 'opus' },
		],
		timeoutMs: 20 * 60 * 1000,
		prompt: 'Check the migrations.',
	};

	beforeEach(() => {
		findProjectRecordByIdFromDb.mockImplementation(async (id: string) =>
			id === 'proj-a'
				? createMockProjectRecord({
						id: 'proj-a',
						agents: { defaults: { claude: 'sonnet' }, review: REVIEW_AGENT },
					})
				: undefined,
		);
	});

	it("returns only the phase's normalised agent configuration, nothing else of the project", async () => {
		const result = await callTool(
			'phase_agents_get',
			{ projectId: 'proj-a', phase: 'review' },
			'member-token',
		);

		expect(result.isError).toBeUndefined();
		// Exactly the phase — no repositories, board mapping, credentials, or other
		// phases — with the `targets[0]` mirror the schema normalises in.
		expect(result.structuredContent).toEqual({
			projectId: 'proj-a',
			phase: 'review',
			configured: true,
			targets: REVIEW_AGENT.targets,
			cli: 'codex',
			model: 'gpt-5.6-sol',
			reasoning: 'high',
			timeoutMs: REVIEW_AGENT.timeoutMs,
			prompt: REVIEW_AGENT.prompt,
		});
	});

	it('reports a phase with no override as running on its coded defaults', async () => {
		const result = await callTool(
			'phase_agents_get',
			{ projectId: 'proj-a', phase: 'respondToCi' },
			'member-token',
		);

		expect(result.structuredContent).toEqual({
			projectId: 'proj-a',
			phase: 'respondToCi',
			configured: false,
		});
	});

	it('hides a project the caller is not a member of, reading nothing', async () => {
		const result = await callTool(
			'phase_agents_get',
			{ projectId: 'proj-a', phase: 'review' },
			'stranger-token',
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toMatch(/^NOT_FOUND: /);
		expect(findProjectRecordByIdFromDb).not.toHaveBeenCalled();
	});

	it('rejects a key that is not a phase', async () => {
		const result = await callTool(
			'phase_agents_get',
			{ projectId: 'proj-a', phase: 'defaults' },
			'member-token',
		);

		expect(result.isError).toBe(true);
		expect(findProjectRecordByIdFromDb).not.toHaveBeenCalled();
	});
});
