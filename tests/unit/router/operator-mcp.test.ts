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
const { listActiveReviewSlotsForPullRequest, getSubmittedReviewSlot, grantReviewCapOverride } =
	vi.hoisted(() => ({
		listActiveReviewSlotsForPullRequest: vi.fn(),
		// The force re-review service's ledger read and grant (issue #1348).
		getSubmittedReviewSlot: vi.fn(),
		grantReviewCapOverride: vi.fn(),
	}));
vi.mock('@/db/repositories/reviewVerdictsRepository.js', async () => ({
	...(await vi.importActual<typeof import('@/db/repositories/reviewVerdictsRepository.js')>(
		'@/db/repositories/reviewVerdictsRepository.js',
	)),
	listActiveReviewSlotsForPullRequest,
	getSubmittedReviewSlot,
	grantReviewCapOverride,
}));
// The pull request reads behind `pr_force_re_review` and `pr_recheck_mergeability`
// (issue #1348); the rest of the registry stays real for the config schema.
const { requireProjectSCMProvider } = vi.hoisted(() => ({ requireProjectSCMProvider: vi.fn() }));
vi.mock('@/integrations/scm/registry.js', async () => ({
	...(await vi.importActual<typeof import('@/integrations/scm/registry.js')>(
		'@/integrations/scm/registry.js',
	)),
	requireProjectSCMProvider,
}));
const { findProjectRecordByIdFromDb, getProjectByIdFromDb, upsertProjectToDb } = vi.hoisted(() => ({
	findProjectRecordByIdFromDb: vi.fn(),
	getProjectByIdFromDb: vi.fn(),
	upsertProjectToDb: vi.fn(),
}));
vi.mock('@/db/repositories/projectsRepository.js', async () => ({
	...(await vi.importActual<typeof import('@/db/repositories/projectsRepository.js')>(
		'@/db/repositories/projectsRepository.js',
	)),
	findProjectRecordByIdFromDb,
	getProjectByIdFromDb,
	upsertProjectToDb,
}));
// The consistency check behind `consistency_check` (issue #1344) has its own suite;
// here it is only the seam the procedure hands the project and its board to.
const { runConsistencyCheck, requireProjectPMProvider } = vi.hoisted(() => ({
	runConsistencyCheck: vi.fn(),
	requireProjectPMProvider: vi.fn(),
}));
vi.mock('@/dispatch/consistency-check.js', async () => ({
	...(await vi.importActual<typeof import('@/dispatch/consistency-check.js')>(
		'@/dispatch/consistency-check.js',
	)),
	runConsistencyCheck,
}));
vi.mock('@/integrations/pm/registry.js', async () => ({
	...(await vi.importActual<typeof import('@/integrations/pm/registry.js')>(
		'@/integrations/pm/registry.js',
	)),
	requireProjectPMProvider,
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
const {
	getActiveDispatchByRunId,
	listDependencyWaits,
	listOpenDispatchesForProject,
	listDispatchesForTask,
	reopenDispatchForManualRetry,
} = vi.hoisted(() => ({
	getActiveDispatchByRunId: vi.fn(),
	listDependencyWaits: vi.fn(),
	listOpenDispatchesForProject: vi.fn(),
	listDispatchesForTask: vi.fn(),
	reopenDispatchForManualRetry: vi.fn(),
}));
vi.mock('@/db/repositories/dispatchesRepository.js', async () => ({
	...(await vi.importActual<typeof import('@/db/repositories/dispatchesRepository.js')>(
		'@/db/repositories/dispatchesRepository.js',
	)),
	getActiveDispatchByRunId,
	listDependencyWaits,
	listOpenDispatchesForProject,
	listDispatchesForTask,
	reopenDispatchForManualRetry,
}));

// The write tools (issue #1346): the audit trail they record into, and the
// side-effecting seams behind `runs.reset` / `runs.retryNow`, whose own suites
// cover them — here only *whether* each is reached and as whom.
const { recordOperatorAction, settleOperatorAction, findLatestOperatorAction } = vi.hoisted(() => ({
	recordOperatorAction: vi.fn(),
	settleOperatorAction: vi.fn(),
	findLatestOperatorAction: vi.fn(),
}));
vi.mock('@/db/repositories/operatorActionsRepository.js', () => ({
	recordOperatorAction,
	settleOperatorAction,
	findLatestOperatorAction,
}));
const { resetRun } = vi.hoisted(() => ({ resetRun: vi.fn() }));
vi.mock('@/dispatch/run-reset.js', async () => ({
	...(await vi.importActual<typeof import('@/dispatch/run-reset.js')>('@/dispatch/run-reset.js')),
	resetRun,
}));
const {
	promoteDependencyWaits,
	publishDispatchWakeUp,
	createAndPublishDispatch,
	scheduleCoalescedDispatch,
} = vi.hoisted(() => ({
	promoteDependencyWaits: vi.fn(),
	publishDispatchWakeUp: vi.fn(),
	createAndPublishDispatch: vi.fn(),
	scheduleCoalescedDispatch: vi.fn(),
}));
vi.mock('@/dispatch/dispatcher.js', async () => ({
	...(await vi.importActual<typeof import('@/dispatch/dispatcher.js')>('@/dispatch/dispatcher.js')),
	promoteDependencyWaits,
	publishDispatchWakeUp,
	createAndPublishDispatch,
	scheduleCoalescedDispatch,
}));
const { clearRunCancellation } = vi.hoisted(() => ({ clearRunCancellation: vi.fn() }));
vi.mock('@/queue/cancellation.js', async () => ({
	...(await vi.importActual<typeof import('@/queue/cancellation.js')>('@/queue/cancellation.js')),
	clearRunCancellation,
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

// Issue #1350 — `cli_rate_limit_set` resolves its worker and its owner's machines
// through the worker service, and reads and extends cool-downs through the
// repository; the extend-only upsert itself is pinned by its integration suite.
const { getWorker, listWorkersForOwner } = vi.hoisted(() => ({
	getWorker: vi.fn(),
	listWorkersForOwner: vi.fn(),
}));
vi.mock('@/identity/worker-service.js', async () => ({
	...(await vi.importActual<typeof import('@/identity/worker-service.js')>(
		'@/identity/worker-service.js',
	)),
	getWorker,
	listWorkersForOwner,
}));
const { extendWorkerCliRateLimits, listActiveCliRateLimitsForWorkers } = vi.hoisted(() => ({
	extendWorkerCliRateLimits: vi.fn(),
	listActiveCliRateLimitsForWorkers: vi.fn(),
}));
vi.mock('@/db/repositories/workerCliRateLimitsRepository.js', async () => ({
	...(await vi.importActual<typeof import('@/db/repositories/workerCliRateLimitsRepository.js')>(
		'@/db/repositories/workerCliRateLimitsRepository.js',
	)),
	extendWorkerCliRateLimits,
	listActiveCliRateLimitsForWorkers,
}));

import { REVIEW_VERDICT_CAP } from '@/db/repositories/reviewVerdictsRepository.js';
import type { SwarmUser } from '@/identity/schema.js';
import { enableLogRingBuffer, logger } from '@/lib/logger.js';
import {
	MAY_USE_OPERATOR_MCP,
	type OperatorMcpDeps,
	registerOperatorMcp,
	serveOperatorMcpRequest,
} from '@/router/operator-mcp.js';
import {
	createMockPmWebhookJob,
	createMockProjectConfig,
	createMockProjectRecord,
} from '../../helpers/factories.js';

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
/** Holds `member` on `proj-a` — the role that may drive its runs. (`MEMBER` is a contributor.) */
const DRIVER = user('66666666-6666-4666-8666-666666666666', 'driver@example.com', false);
const TOKENS: Record<string, SwarmUser> = {
	'admin-token': ADMIN,
	'member-token': MEMBER,
	'stranger-token': STRANGER,
	'driver-token': DRIVER,
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

/** Agent access tokens (issue #1362), resolved by the second credential lookup. */
const AGENT_TOKENS: Record<string, SwarmUser> = {
	'admin-agent-token': ADMIN,
	'member-agent-token': MEMBER,
};

let resolveSession: ReturnType<typeof vi.fn<OperatorMcpDeps['resolveSession']>>;
let resolveAgentAccessToken: ReturnType<typeof vi.fn<OperatorMcpDeps['resolveAgentAccessToken']>>;

function appWith(): Hono {
	const app = new Hono();
	registerOperatorMcp(app, { resolveSession, resolveAgentAccessToken });
	return app;
}

function rpcRequest(method: string, params: Record<string, unknown>, token?: string): Request {
	return new Request('http://localhost/operator/mcp', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			accept: 'application/json, text/event-stream',
			...(token ? { authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
	});
}

/** One JSON-RPC request over Streamable HTTP to the real mount, as an MCP client sends it. */
async function rpc(method: string, params: Record<string, unknown>, token?: string) {
	return appWith().fetch(rpcRequest(method, params, token));
}

/**
 * A tool call made **behind** the endpoint's admin-only gate, as the token's user.
 * The gate refuses non-admins today (issue #1362), but each tool's own per-user
 * authorization is what a later decision to open MCP rests on, so it stays
 * exercised for members and strangers here.
 */
async function callTool(name: string, args: Record<string, unknown>, token: string) {
	const response = await serveOperatorMcpRequest(
		TOKENS[token],
		rpcRequest('tools/call', { name, arguments: args }, token),
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as { result: ToolResult };
	return body.result;
}

interface ToolResult {
	isError?: boolean;
	content: Array<{ type: string; text: string }>;
	structuredContent?: Record<string, unknown>;
}

beforeEach(() => {
	resolveSession = vi.fn(async (token: string) => TOKENS[token]);
	resolveAgentAccessToken = vi.fn(async (token: string) => AGENT_TOKENS[token]);
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
			projectId !== 'proj-a'
				? undefined
				: userId === MEMBER.id
					? { id: 'm1', userId, projectId, role: 'contributor', createdAt: new Date(0) }
					: userId === DRIVER.id
						? { id: 'm2', userId, projectId, role: 'member', createdAt: new Date(0) }
						: undefined,
		);
	listAccessibleProjectIds
		.mockReset()
		.mockImplementation(async (userId: string) =>
			userId === MEMBER.id || userId === DRIVER.id ? ['proj-a'] : [],
		);
	listDashboardWorkers.mockReset().mockResolvedValue([workerRow(WORKER_ID, 'idle-box', [])]);
	listProjectWorkerIdsInOrder.mockReset().mockResolvedValue([]);
	listWorkerProjectCapacity.mockReset().mockResolvedValue(CAPACITY);
	getLatestCompletedReviewRunForPullRequest.mockReset().mockResolvedValue(undefined);
	countRunsByStatusAndPhase.mockReset().mockResolvedValue({ byStatus: {}, byPhase: {} });
	countMergedPullRequestsByRepository.mockReset().mockResolvedValue({});
	listActiveReviewSlotsForPullRequest.mockReset().mockResolvedValue([]);
	findProjectRecordByIdFromDb.mockReset().mockResolvedValue(undefined);
	upsertProjectToDb.mockReset().mockResolvedValue(undefined);
	recordOperatorAction.mockReset().mockResolvedValue('audit-1');
	settleOperatorAction.mockReset().mockResolvedValue(undefined);
	findLatestOperatorAction.mockReset().mockResolvedValue(undefined);
	resetRun.mockReset();
	reopenDispatchForManualRetry.mockReset();
	listDependencyWaits.mockReset().mockResolvedValue([]);
	promoteDependencyWaits.mockReset().mockResolvedValue([]);
	publishDispatchWakeUp.mockReset().mockResolvedValue(undefined);
	clearRunCancellation.mockReset().mockResolvedValue(undefined);
	getWorker.mockReset().mockResolvedValue(undefined);
	listWorkersForOwner.mockReset().mockResolvedValue([]);
	extendWorkerCliRateLimits.mockReset().mockResolvedValue([]);
	listActiveCliRateLimitsForWorkers.mockReset().mockResolvedValue(new Map());
	getSubmittedReviewSlot.mockReset();
	grantReviewCapOverride.mockReset();
	requireProjectSCMProvider.mockReset();
	createAndPublishDispatch.mockReset();
	scheduleCoalescedDispatch.mockReset().mockResolvedValue(undefined);
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

	it('refuses a token neither credential resolves', async () => {
		const response = await rpc('tools/call', { name: 'runs_list', arguments: {} }, 'revoked');

		expect(response.status).toBe(401);
		expect(resolveSession).toHaveBeenCalledWith('revoked');
		expect(resolveAgentAccessToken).toHaveBeenCalledWith('revoked');
		expect(listRunsFromDb).not.toHaveBeenCalled();
	});

	it("accepts an instance admin's agent access token, acting as its holder", async () => {
		const response = await rpc(
			'tools/call',
			{ name: 'runs_list', arguments: {} },
			'admin-agent-token',
		);

		expect(response.status).toBe(200);
		expect(resolveAgentAccessToken).toHaveBeenCalledWith('admin-agent-token');
		// The admin reads the whole installation: no membership scope is consulted.
		expect(listAccessibleProjectIds).not.toHaveBeenCalled();
		expect(listRunsFromDb).toHaveBeenCalled();
	});

	it('does not consult agent access tokens when the session resolves', async () => {
		const response = await rpc('tools/list', {}, 'admin-token');

		expect(response.status).toBe(200);
		expect(resolveAgentAccessToken).not.toHaveBeenCalled();
	});

	// Issue #1362: MCP is admin-only for now, whatever the credential — opening it to
	// other users needs an authorization review of every tool first.
	it.each([
		['a `swarm login` session', 'member-token'],
		['an agent access token', 'member-agent-token'],
		['a stranger session', 'stranger-token'],
	])('refuses a non-admin presenting %s with 403, before any MCP handling', async (_, token) => {
		const response = await rpc('tools/call', { name: 'runs_list', arguments: {} }, token);

		expect(response.status).toBe(403);
		expect(listRunsFromDb).not.toHaveBeenCalled();
		expect(listAccessibleProjectIds).not.toHaveBeenCalled();
	});

	it('decides MCP access per installation role, admins only', () => {
		expect(MAY_USE_OPERATOR_MCP).toEqual({ instanceAdmin: true, user: false });
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
			headers: { authorization: 'Bearer admin-token', accept: 'text/event-stream' },
		});

		expect(response.status).toBe(405);
		expect(response.headers.get('allow')).toBe('POST');
	});
});

describe('operator MCP — the handshake', () => {
	it('initializes as the swarm server and lists the read tools and the audited write tools', async () => {
		const init = await rpc(
			'initialize',
			{
				protocolVersion: '2025-06-18',
				capabilities: {},
				clientInfo: { name: 'test', version: '0' },
			},
			'admin-token',
		);
		expect(init.status).toBe(200);
		expect(init.headers.get('mcp-session-id')).toBeNull();
		const initBody = (await init.json()) as { result: { serverInfo: { name: string } } };
		expect(initBody.result.serverInfo.name).toBe('swarm');

		const list = await rpc('tools/list', {}, 'admin-token');
		const listBody = (await list.json()) as {
			result: {
				tools: Array<{
					name: string;
					annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
					inputSchema: { required?: string[] };
				}>;
			};
		};
		const tools = listBody.result.tools;
		const WRITE_TOOLS = [
			'cli_rate_limit_set',
			'dependency_waits_wake',
			'dispatch_redispatch_now',
			'phase_agents_reorder',
			'phase_agents_restore',
			'pr_force_re_review',
			'pr_recheck_mergeability',
			'run_reset',
		];

		expect(tools.map((tool) => tool.name).sort()).toEqual([
			'cli_rate_limit_set',
			'cli_rate_limits',
			'consistency_check',
			'control_plane_logs',
			'dependency_waits_wake',
			'dispatch_history',
			'dispatch_redispatch_now',
			'phase_agents_get',
			'phase_agents_reorder',
			'phase_agents_restore',
			'pipeline_snapshot',
			'pipeline_stats',
			'pr_force_re_review',
			'pr_recheck_mergeability',
			'pr_status',
			'run_get',
			'run_reset',
			'runs_list',
			'workers_state',
		]);
		for (const tool of tools) {
			if (WRITE_TOOLS.includes(tool.name)) {
				expect(tool.annotations?.readOnlyHint).toBe(false);
				expect(tool.inputSchema.required).toContain('reason');
			} else {
				expect(tool.annotations?.readOnlyHint).toBe(true);
			}
		}
		expect(tools.find((tool) => tool.name === 'run_reset')?.annotations?.destructiveHint).toBe(
			true,
		);
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

// Issue #1343 — the router's own recent log lines, read from the logger's ring buffer.
describe('operator MCP — control_plane_logs', () => {
	beforeEach(() => {
		vi.spyOn(console, 'info').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.stubEnv('SWARM_LOG_LEVEL', 'info');
		enableLogRingBuffer(100);
		logger.info('dispatched', { projectId: 'proj-a', taskId: '7', dispatchId: 'd-1' });
		logger.warn('other project', { projectId: 'proj-b', taskId: '7' });
		logger.error('no project at all');
		logger.error('proj-a failed', { projectId: 'proj-a', prNumber: 12 });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		enableLogRingBuffer(0);
	});

	const messages = (result: ToolResult) =>
		(result.structuredContent?.entries as Array<{ msg: string }>).map((entry) => entry.msg);

	it("reads a contributor's project lines only, newest first, with the buffer's extent", async () => {
		const result = await callTool('control_plane_logs', { projectId: 'proj-a' }, 'member-token');

		expect(result.isError).toBeUndefined();
		expect(messages(result)).toEqual(['proj-a failed', 'dispatched']);
		expect(result.structuredContent).toMatchObject({
			entries: [
				{ level: 'error', msg: 'proj-a failed', context: { projectId: 'proj-a', prNumber: 12 } },
				{ level: 'info', context: { taskId: '7', dispatchId: 'd-1' } },
			],
			buffer: { capacity: 100, size: 4 },
		});
	});

	it('passes the filters through', async () => {
		const byLevel = await callTool(
			'control_plane_logs',
			{ projectId: 'proj-a', level: 'error' },
			'member-token',
		);
		const byPr = await callTool(
			'control_plane_logs',
			{ projectId: 'proj-a', prNumber: 12, since: '2000-01-01T00:00:00Z' },
			'member-token',
		);
		const byDispatch = await callTool(
			'control_plane_logs',
			{ projectId: 'proj-a', dispatchId: 'd-1', until: '2000-01-01T00:00:00Z' },
			'member-token',
		);

		expect(messages(byLevel)).toEqual(['proj-a failed']);
		expect(messages(byPr)).toEqual(['proj-a failed']);
		expect(messages(byDispatch)).toEqual([]);
	});

	it('hides a project the caller is not a member of', async () => {
		const result = await callTool('control_plane_logs', { projectId: 'proj-a' }, 'stranger-token');

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toBe('NOT_FOUND: Project with ID "proj-a" not found');
	});

	it('refuses a non-admin who names no project', async () => {
		const result = await callTool('control_plane_logs', { taskId: '7' }, 'member-token');

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toMatch(/^FORBIDDEN: /);
	});

	it('reads every line, including those naming no project, for an instance admin', async () => {
		const result = await callTool('control_plane_logs', { limit: 3 }, 'admin-token');

		expect(messages(result)).toEqual(['proj-a failed', 'no project at all', 'other project']);
	});

	it('cuts an overlong message', async () => {
		logger.info('x'.repeat(5000), { projectId: 'proj-a' });

		const result = await callTool(
			'control_plane_logs',
			{ projectId: 'proj-a', limit: 1 },
			'member-token',
		);

		expect(messages(result)[0]).toBe(`${'x'.repeat(4000)}… [1000 more characters]`);
	});

	it('rejects a limit above 1000', async () => {
		const result = await callTool('control_plane_logs', { limit: 1001 }, 'admin-token');

		expect(result.isError).toBe(true);
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

describe('operator MCP — consistency_check', () => {
	const PROJECT = createMockProjectConfig({ id: 'proj-a', repo: 'acme/app' });
	const BOARD = { type: 'github-projects' };
	const RESULT = {
		windowHours: 48,
		since: '2026-11-04T12:00:00.000Z',
		findings: [
			{
				kind: 'merged-pr-open-work-item',
				repository: 'acme/app',
				prNumber: 42,
				taskId: '17',
				workItemId: 'PVTI_17',
				workItemUrl: 'https://example.test/issues/17',
				detail: 'Pull request #42 was merged, but its work item is still open.',
				suggestedAction: 'Close the work item.',
			},
		],
		unchecked: [],
		truncated: false,
	};

	beforeEach(() => {
		getProjectByIdFromDb
			.mockReset()
			.mockImplementation(async (id: string) => (id === 'proj-a' ? PROJECT : undefined));
		requireProjectPMProvider.mockReset().mockReturnValue(BOARD);
		runConsistencyCheck.mockReset().mockResolvedValue(RESULT);
	});

	it("runs the check against the project's own board for a contributor", async () => {
		const result = await callTool(
			'consistency_check',
			{ projectId: 'proj-a', windowHours: 48 },
			'member-token',
		);

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual(RESULT);
		expect(requireProjectPMProvider).toHaveBeenCalledWith(PROJECT);
		expect(runConsistencyCheck).toHaveBeenCalledWith(PROJECT, BOARD, 48);
	});

	it('looks back 24 hours by default', async () => {
		await callTool('consistency_check', { projectId: 'proj-a' }, 'member-token');

		expect(runConsistencyCheck).toHaveBeenCalledWith(PROJECT, BOARD, 24);
	});

	it('hides a project the caller is not a member of, reading nothing', async () => {
		const result = await callTool('consistency_check', { projectId: 'proj-a' }, 'stranger-token');

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toMatch(/^NOT_FOUND: /);
		expect(getProjectByIdFromDb).not.toHaveBeenCalled();
		expect(runConsistencyCheck).not.toHaveBeenCalled();
	});

	it('rejects a window longer than thirty days', async () => {
		const result = await callTool(
			'consistency_check',
			{ projectId: 'proj-a', windowHours: 721 },
			'member-token',
		);

		expect(result.isError).toBe(true);
		expect(runConsistencyCheck).not.toHaveBeenCalled();
	});
});

describe('operator MCP — run_reset and dispatch_redispatch_now', () => {
	const PROJECT = createMockProjectConfig({ id: 'proj-a', repo: 'acme/widgets' });
	const PAYLOAD = createMockPmWebhookJob();
	const RESET_RESULT = {
		outcome: 'restarted',
		runId: RUN_ID,
		agentStop: 'not-running',
		dispatch: 'none',
		cancellationCleared: true,
		worktree: null,
		worktreeError: null,
		recoveryCleared: true,
		abandonedPreservedWorkerId: null,
		dispatchId: 'dispatch-2',
	};

	beforeEach(() => {
		getProjectByIdFromDb.mockReset().mockResolvedValue(PROJECT);
		getRunByIdFromDb.mockImplementation(async (id: string) =>
			id === RUN_ID ? { ...failedRun(), jobPayload: PAYLOAD } : undefined,
		);
		resetRun.mockResolvedValue(RESET_RESULT);
	});

	/** The audit row the call settled, merged with the one it inserted. */
	function auditRow() {
		expect(recordOperatorAction).toHaveBeenCalledTimes(1);
		expect(settleOperatorAction).toHaveBeenCalledTimes(1);
		return {
			...recordOperatorAction.mock.calls[0]?.[0],
			...settleOperatorAction.mock.calls[0]?.[1],
		};
	}

	it('resets the run for a project member and audits the call', async () => {
		const result = await callTool(
			'run_reset',
			{ runId: RUN_ID, reason: 'wedged on a stale lease' },
			'driver-token',
		);

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual({
			dryRun: false,
			auditId: 'audit-1',
			result: RESET_RESULT,
		});
		expect(resetRun).toHaveBeenCalledWith(RUN_ID);
		expect(auditRow()).toEqual({
			userId: DRIVER.id,
			userIdentifier: DRIVER.identifier,
			tool: 'run_reset',
			projectId: 'proj-a',
			target: RUN_ID,
			reason: 'wedged on a stale lease',
			dryRun: false,
			input: { runId: RUN_ID },
			outcome: 'succeeded',
			error: null,
		});
	});

	it('answers a dry run with the preview and does not reset', async () => {
		const result = await callTool(
			'run_reset',
			{ runId: RUN_ID, reason: 'checking', dryRun: true },
			'driver-token',
		);

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toMatchObject({
			dryRun: true,
			preview: {
				action: 'reset',
				run: { id: RUN_ID, projectId: 'proj-a', status: 'failed' },
				wouldRefuse: null,
				expectedOutcome: 'restarted',
			},
		});
		expect(resetRun).not.toHaveBeenCalled();
		expect(auditRow()).toMatchObject({ dryRun: true, outcome: 'succeeded', projectId: 'proj-a' });
	});

	// `contributor` is the read-only role: it reads the run, but may not drive it —
	// and a dry run must not get further than the real call would.
	it.each([
		[false],
		[true],
	])('refuses a contributor with FORBIDDEN (dryRun %s) and audits the refusal', async (dryRun) => {
		const result = await callTool(
			'run_reset',
			{ runId: RUN_ID, reason: 'trying', dryRun },
			'member-token',
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toMatch(/^FORBIDDEN: /);
		expect(resetRun).not.toHaveBeenCalled();
		expect(getActiveDispatchByRunId).not.toHaveBeenCalled();
		expect(auditRow()).toMatchObject({
			userId: MEMBER.id,
			tool: 'run_reset',
			target: RUN_ID,
			projectId: null,
			dryRun,
			outcome: 'refused',
			error: expect.stringMatching(/^FORBIDDEN: /),
		});
	});

	it('hides a run in a project the caller is not a member of', async () => {
		const result = await callTool(
			'run_reset',
			{ runId: RUN_ID, reason: 'trying' },
			'stranger-token',
		);

		expect(result.content[0]?.text).toBe(`NOT_FOUND: Run with ID "${RUN_ID}" not found`);
		expect(resetRun).not.toHaveBeenCalled();
		expect(auditRow()).toMatchObject({ outcome: 'refused', projectId: null });
	});

	// A reset that broke part-way may already have stopped the agent and torn down the
	// checkout: the audit row must say `failed`, never `refused` (nothing changed).
	it('audits a reset that broke as failed, through the real caller', async () => {
		resetRun.mockRejectedValue(new Error('connection reset'));

		const result = await callTool('run_reset', { runId: RUN_ID, reason: 'wedged' }, 'driver-token');

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toBe(
			`INTERNAL_SERVER_ERROR: Failed to reset run "${RUN_ID}": connection reset`,
		);
		expect(auditRow()).toMatchObject({
			projectId: 'proj-a',
			outcome: 'failed',
			error: `INTERNAL_SERVER_ERROR: Failed to reset run "${RUN_ID}": connection reset`,
		});
	});

	it('rejects a call with no reason before anything runs', async () => {
		const result = await callTool('run_reset', { runId: RUN_ID }, 'driver-token');

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toMatch(/reason/);
		expect(resetRun).not.toHaveBeenCalled();
	});

	it("re-opens the run's waiting dispatch for a project member", async () => {
		const waiting = {
			id: 'dispatch-1',
			state: 'retry-scheduled',
			waitReason: 'rate-limit',
			availableAt: new Date('2026-11-06T12:00:00Z'),
			leaseExpiresAt: null,
			jobPayload: PAYLOAD,
			wakeSeq: 1,
		};
		getActiveDispatchByRunId.mockResolvedValue(waiting);
		reopenDispatchForManualRetry.mockResolvedValue({ ...waiting, state: 'pending', wakeSeq: 2 });

		const result = await callTool(
			'dispatch_redispatch_now',
			{ runId: RUN_ID, reason: 'the rate limit has reset' },
			'driver-token',
		);

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toMatchObject({
			dryRun: false,
			result: { runId: RUN_ID, status: 'retrying' },
		});
		expect(reopenDispatchForManualRetry).toHaveBeenCalledWith('dispatch-1', expect.any(Object));
		expect(publishDispatchWakeUp).toHaveBeenCalledTimes(1);
		expect(auditRow()).toMatchObject({
			tool: 'dispatch_redispatch_now',
			projectId: 'proj-a',
			outcome: 'succeeded',
		});
	});

	it('previews a re-dispatch without re-opening anything', async () => {
		getActiveDispatchByRunId.mockResolvedValue({
			id: 'dispatch-1',
			state: 'retry-scheduled',
			waitReason: 'rate-limit',
			availableAt: new Date('2026-11-06T12:00:00Z'),
			leaseExpiresAt: null,
			jobPayload: PAYLOAD,
		});

		const result = await callTool(
			'dispatch_redispatch_now',
			{ runId: RUN_ID, reason: 'checking', dryRun: true },
			'driver-token',
		);

		expect(result.structuredContent).toMatchObject({
			dryRun: true,
			preview: {
				action: 'retryNow',
				activeDispatch: { id: 'dispatch-1', state: 'retry-scheduled', claim: 'waiting' },
				wouldRefuse: null,
				expectedOutcome: 'retrying',
			},
		});
		expect(reopenDispatchForManualRetry).not.toHaveBeenCalled();
		expect(publishDispatchWakeUp).not.toHaveBeenCalled();
		expect(clearRunCancellation).not.toHaveBeenCalled();
	});

	it("audits retryNow's own refusal of a completed run", async () => {
		getRunByIdFromDb.mockResolvedValue({ ...failedRun(), status: 'completed' });

		const result = await callTool(
			'dispatch_redispatch_now',
			{ runId: RUN_ID, reason: 'again' },
			'driver-token',
		);

		expect(result.content[0]?.text).toBe(
			`PRECONDITION_FAILED: Only a deferred, checkpointed, or failed run can be retried; run "${RUN_ID}" is completed.`,
		);
		expect(auditRow()).toMatchObject({ outcome: 'refused', projectId: 'proj-a' });
	});
});

describe('operator MCP — pr_force_re_review and pr_recheck_mergeability', () => {
	const PROJECT = createMockProjectConfig({ id: 'proj-a', repo: 'acme/widgets' });
	const REVIEWED_HEAD = 'cafebabe0000cafebabe0000cafebabe0000cafe';
	const getPullRequest = vi.fn();

	/** A completed Review run whose approval spent the allowance — issue #1040's shape. */
	function capSpentApprovalRun() {
		return {
			...failedRun(),
			phase: 'review',
			status: 'completed',
			prNumber: '508',
			reviewOrdinal: REVIEW_VERDICT_CAP,
			reviewVerdict: 'approve',
			reviewAutomationOutcome: null,
			reviewMergeOutcome: 'not-eligible',
			jobPayload: {
				type: 'scm',
				providerId: 'github',
				projectId: 'proj-a',
				event: {
					kind: 'checks',
					action: 'completed',
					repoFullName: 'acme/widgets',
					workItemId: '508',
					isCommentEvent: false,
					headSha: REVIEWED_HEAD,
					prBranch: 'issue-508',
				},
			},
		};
	}

	function pullRequestAt(headSha: string, state = 'open') {
		return {
			number: 508,
			headBranch: 'issue-508',
			headSha,
			baseBranch: 'main',
			baseSha: 'base',
			mergeable: false,
			authorLogin: 'someone',
			state,
		};
	}

	beforeEach(() => {
		getProjectByIdFromDb.mockReset().mockResolvedValue(PROJECT);
		findProjectRecordByIdFromDb.mockResolvedValue(
			createMockProjectRecord({ id: 'proj-a', repositories: [{ repo: 'acme/widgets' }] }),
		);
		getRunByIdFromDb.mockImplementation(async (id: string) =>
			id === RUN_ID ? capSpentApprovalRun() : undefined,
		);
		listActiveReviewSlotsForPullRequest.mockResolvedValue(
			Array.from({ length: REVIEW_VERDICT_CAP }, (_unused, index) => ({
				ordinal: index + 1,
				state: 'submitted',
				headSha: index + 1 === REVIEW_VERDICT_CAP ? REVIEWED_HEAD : `older-${index}`,
				capOverrideGrantedAt: null,
				capOverrideConsumedAt: null,
				dispatchActive: false,
				superseded: false,
			})),
		);
		getSubmittedReviewSlot.mockResolvedValue({
			ordinal: REVIEW_VERDICT_CAP,
			verdict: 'approve',
			reviewId: '900456',
			capOverrideGrantedAt: null,
			capOverrideConsumedAt: null,
		});
		getPullRequest.mockReset().mockResolvedValue(pullRequestAt(REVIEWED_HEAD));
		requireProjectSCMProvider.mockReturnValue({ type: 'github', getPullRequest });
	});

	function auditRow() {
		expect(recordOperatorAction).toHaveBeenCalledTimes(1);
		expect(settleOperatorAction).toHaveBeenCalledTimes(1);
		return {
			...recordOperatorAction.mock.calls[0]?.[0],
			...settleOperatorAction.mock.calls[0]?.[1],
		};
	}

	it("surfaces the service's head-unchanged refusal as a tool error and audits it", async () => {
		const result = await callTool(
			'pr_force_re_review',
			{ runId: RUN_ID, reason: 'merge refused after the cap' },
			'driver-token',
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toBe(
			`PRECONDITION_FAILED: Cannot force a review for run "${RUN_ID}" — PR #508 is still at ${REVIEWED_HEAD}, the commit this run approved. Nothing superseded the approval, so the merge was refused for another reason; see this run's merge result for the provider's own message.`,
		);
		expect(grantReviewCapOverride).not.toHaveBeenCalled();
		expect(createAndPublishDispatch).not.toHaveBeenCalled();
		expect(auditRow()).toMatchObject({
			userId: DRIVER.id,
			tool: 'pr_force_re_review',
			projectId: 'proj-a',
			target: RUN_ID,
			reason: 'merge refused after the cap',
			dryRun: false,
			outcome: 'refused',
			error: expect.stringMatching(/^PRECONDITION_FAILED: .*is still at/),
		});
	});

	it('answers a dry run with the cap state and whether the head moved, writing nothing', async () => {
		const result = await callTool(
			'pr_force_re_review',
			{ runId: RUN_ID, reason: 'checking', dryRun: true },
			'driver-token',
		);

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toMatchObject({
			dryRun: true,
			auditId: 'audit-1',
			preview: {
				run: { id: RUN_ID, projectId: 'proj-a' },
				reviewCapStop: 'verdict-cap',
				reviewCapSpent: true,
				continuation: 'review',
				reviewedHeadSha: REVIEWED_HEAD,
				currentHeadSha: REVIEWED_HEAD,
				headMoved: false,
				wouldRefuse: { code: 'PRECONDITION_FAILED' },
			},
		});
		expect(grantReviewCapOverride).not.toHaveBeenCalled();
		expect(createAndPublishDispatch).not.toHaveBeenCalled();
		expect(auditRow()).toMatchObject({ dryRun: true, outcome: 'succeeded', projectId: 'proj-a' });
	});

	it('refuses a contributor with FORBIDDEN before reading the pull request', async () => {
		const result = await callTool(
			'pr_force_re_review',
			{ runId: RUN_ID, reason: 'trying', dryRun: true },
			'member-token',
		);

		expect(result.content[0]?.text).toMatch(/^FORBIDDEN: /);
		expect(getPullRequest).not.toHaveBeenCalled();
		expect(auditRow()).toMatchObject({ outcome: 'refused', projectId: null });
	});

	it('schedules one coalesced conflict check for a project member and audits it', async () => {
		const result = await callTool(
			'pr_recheck_mergeability',
			{
				projectId: 'proj-a',
				repository: 'acme/widgets',
				prNumber: 508,
				reason: 'fan-out skipped it',
			},
			'driver-token',
		);

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toMatchObject({
			dryRun: false,
			result: {
				prNumber: 508,
				baseBranch: 'main',
				coalesceKey: 'resolve-conflicts:acme/widgets:508:main',
				scheduled: true,
			},
		});
		expect(scheduleCoalescedDispatch).toHaveBeenCalledTimes(1);
		expect(scheduleCoalescedDispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'scm',
				projectId: 'proj-a',
				event: expect.objectContaining({ conflictPrNumber: '508', baseBranch: 'main' }),
			}),
			'resolve-conflicts:acme/widgets:508:main',
			0,
			null,
		);
		expect(auditRow()).toMatchObject({
			tool: 'pr_recheck_mergeability',
			projectId: 'proj-a',
			target: 'acme/widgets#508',
			outcome: 'succeeded',
		});
	});

	it("previews the job and the pull request's current mergeability, scheduling nothing", async () => {
		const result = await callTool(
			'pr_recheck_mergeability',
			{
				projectId: 'proj-a',
				repository: 'acme/widgets',
				prNumber: 508,
				reason: 'checking',
				dryRun: true,
			},
			'driver-token',
		);

		expect(result.structuredContent).toMatchObject({
			dryRun: true,
			preview: {
				pullRequest: { state: 'open', mergeable: false, baseBranch: 'main' },
				coalesceKey: 'resolve-conflicts:acme/widgets:508:main',
				wouldRefuse: null,
			},
		});
		expect(scheduleCoalescedDispatch).not.toHaveBeenCalled();
	});

	it('refuses a contributor with FORBIDDEN and schedules nothing', async () => {
		const result = await callTool(
			'pr_recheck_mergeability',
			{ projectId: 'proj-a', repository: 'acme/widgets', prNumber: 508, reason: 'trying' },
			'member-token',
		);

		expect(result.content[0]?.text).toMatch(/^FORBIDDEN: /);
		expect(scheduleCoalescedDispatch).not.toHaveBeenCalled();
		expect(auditRow()).toMatchObject({ outcome: 'refused', target: 'acme/widgets#508' });
	});
});

describe('operator MCP — dependency_waits_wake', () => {
	const PROJECT = createMockProjectConfig({ id: 'proj-a', repo: 'acme/widgets' });
	const WAIT = {
		id: 'dispatch-9',
		phase: 'implementation',
		repository: 'acme/widgets',
		taskId: '17',
		prNumber: null,
		runId: null,
		attempt: 2,
		availableAt: new Date('2026-11-06T12:00:00Z'),
	};
	const SUMMARY = {
		dispatchId: 'dispatch-9',
		phase: 'implementation',
		repository: 'acme/widgets',
		taskId: '17',
		prNumber: null,
		runId: null,
		attempt: 2,
		availableAt: '2026-11-06T12:00:00.000Z',
	};

	beforeEach(() => {
		getProjectByIdFromDb
			.mockReset()
			.mockImplementation(async (id: string) => (id === 'proj-a' ? PROJECT : undefined));
		listDependencyWaits.mockResolvedValue([WAIT]);
		promoteDependencyWaits.mockResolvedValue([
			{ ...WAIT, availableAt: new Date(WAIT.availableAt) },
		]);
	});

	function auditRow() {
		expect(recordOperatorAction).toHaveBeenCalledTimes(1);
		expect(settleOperatorAction).toHaveBeenCalledTimes(1);
		return {
			...recordOperatorAction.mock.calls[0]?.[0],
			...settleOperatorAction.mock.calls[0]?.[1],
		};
	}

	it("wakes the project's dependency waits for a member and audits the call", async () => {
		const result = await callTool(
			'dependency_waits_wake',
			{ projectId: 'proj-a', reason: 'the blocker was closed by hand' },
			'driver-token',
		);

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual({
			dryRun: false,
			auditId: 'audit-1',
			result: { projectId: 'proj-a', woken: 1, dispatches: [SUMMARY] },
		});
		expect(promoteDependencyWaits).toHaveBeenCalledExactlyOnceWith('proj-a', 'operator');
		expect(auditRow()).toEqual({
			userId: DRIVER.id,
			userIdentifier: DRIVER.identifier,
			tool: 'dependency_waits_wake',
			projectId: 'proj-a',
			target: 'proj-a',
			reason: 'the blocker was closed by hand',
			dryRun: false,
			input: { projectId: 'proj-a' },
			outcome: 'succeeded',
			error: null,
		});
	});

	it('answers a dry run with the waits it would wake, waking none', async () => {
		const result = await callTool(
			'dependency_waits_wake',
			{ projectId: 'proj-a', reason: 'checking', dryRun: true },
			'driver-token',
		);

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual({
			dryRun: true,
			auditId: 'audit-1',
			preview: { projectId: 'proj-a', wouldWake: 1, dispatches: [SUMMARY] },
		});
		expect(listDependencyWaits).toHaveBeenCalledWith('proj-a');
		expect(promoteDependencyWaits).not.toHaveBeenCalled();
		expect(auditRow()).toMatchObject({ dryRun: true, outcome: 'succeeded', projectId: 'proj-a' });
	});

	it.each([
		['member-token', /^FORBIDDEN: /],
		['stranger-token', /^NOT_FOUND: /],
	])('refuses %s without reading or waking, and audits the refusal', async (token, error) => {
		const result = await callTool(
			'dependency_waits_wake',
			{ projectId: 'proj-a', reason: 'trying' },
			token,
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toMatch(error);
		expect(listDependencyWaits).not.toHaveBeenCalled();
		expect(promoteDependencyWaits).not.toHaveBeenCalled();
		expect(auditRow()).toMatchObject({
			tool: 'dependency_waits_wake',
			target: 'proj-a',
			projectId: null,
			outcome: 'refused',
		});
	});
});

describe('operator MCP — phase_agents_reorder and phase_agents_restore', () => {
	const CODEX = { cli: 'codex' as const, model: 'gpt-5.6-sol', reasoning: 'high' as const };
	const CLAUDE = { cli: 'claude' as const, model: 'opus' };
	const OTHER_PHASES = {
		defaults: { claude: 'sonnet' },
		// As stored: normalised, with the `targets[0]` mirror.
		review: { targets: [CLAUDE], cli: 'claude' as const, model: 'opus', timeoutMs: 20 * 60 * 1000 },
	};

	/** The stored project, re-read on every call so a test can save and read back. */
	let stored: ReturnType<typeof createMockProjectRecord>;

	function storeTargets(targets: Array<typeof CODEX | typeof CLAUDE>) {
		stored = createMockProjectRecord({
			id: 'proj-a',
			agents: {
				...OTHER_PHASES,
				resolveConflicts: { targets, prompt: 'Keep both sides.' },
			},
		});
	}

	beforeEach(() => {
		storeTargets([CODEX, CLAUDE]);
		findProjectRecordByIdFromDb.mockImplementation(async (id: string) =>
			id === 'proj-a' ? stored : undefined,
		);
		upsertProjectToDb.mockImplementation(async (config: typeof stored) => {
			stored = config;
		});
	});

	function savedPhase() {
		expect(upsertProjectToDb).toHaveBeenCalledTimes(1);
		return upsertProjectToDb.mock.calls[0]?.[0].agents;
	}

	function lastSettle() {
		return settleOperatorAction.mock.calls.at(-1)?.[1];
	}

	it('lets a project admin put claude first, persisting only the permuted targets', async () => {
		const result = await callTool(
			'phase_agents_reorder',
			{
				projectId: 'proj-a',
				phase: 'resolveConflicts',
				order: ['claude', 'codex/gpt-5.6-sol'],
				reason: 'codex is rate-limited until tomorrow',
			},
			'admin-token',
		);

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual({
			dryRun: false,
			auditId: 'audit-1',
			result: {
				projectId: 'proj-a',
				phase: 'resolveConflicts',
				before: ['codex/gpt-5.6-sol', 'claude/opus'],
				after: ['claude/opus', 'codex/gpt-5.6-sol'],
			},
		});
		// The phase's targets permuted, its mirror following `targets[0]`, its prompt and
		// every other phase untouched.
		expect(savedPhase()).toEqual({
			...OTHER_PHASES,
			resolveConflicts: {
				targets: [CLAUDE, CODEX],
				cli: 'claude',
				model: 'opus',
				prompt: 'Keep both sides.',
			},
		});
		expect(recordOperatorAction).toHaveBeenCalledWith(
			expect.objectContaining({
				tool: 'phase_agents_reorder',
				target: 'proj-a/resolveConflicts',
				dryRun: false,
			}),
		);
		expect(lastSettle()).toEqual({
			outcome: 'succeeded',
			error: null,
			projectId: 'proj-a',
			detail: { previous: [CODEX, CLAUDE], next: [CLAUDE, CODEX] },
		});
	});

	it('answers a dry run with the order before and after, saving nothing', async () => {
		const result = await callTool(
			'phase_agents_reorder',
			{
				projectId: 'proj-a',
				phase: 'resolveConflicts',
				order: ['claude', 'codex'],
				reason: 'checking',
				dryRun: true,
			},
			'admin-token',
		);

		expect(result.structuredContent).toEqual({
			dryRun: true,
			auditId: 'audit-1',
			preview: {
				projectId: 'proj-a',
				phase: 'resolveConflicts',
				before: ['codex/gpt-5.6-sol', 'claude/opus'],
				after: ['claude/opus', 'codex/gpt-5.6-sol'],
			},
		});
		expect(upsertProjectToDb).not.toHaveBeenCalled();
	});

	it.each([
		['driver-token', /^FORBIDDEN: /],
		['member-token', /^FORBIDDEN: /],
		['stranger-token', /^NOT_FOUND: /],
	])('refuses %s — it is projectAdmin-only — reading and saving nothing', async (token, error) => {
		const result = await callTool(
			'phase_agents_reorder',
			{
				projectId: 'proj-a',
				phase: 'resolveConflicts',
				order: ['claude', 'codex'],
				reason: 'trying',
			},
			token,
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toMatch(error);
		expect(findProjectRecordByIdFromDb).not.toHaveBeenCalled();
		expect(upsertProjectToDb).not.toHaveBeenCalled();
		expect(lastSettle()).toMatchObject({ outcome: 'refused', projectId: null });
	});

	it('refuses an order that is not a permutation of the current targets', async () => {
		const result = await callTool(
			'phase_agents_reorder',
			{
				projectId: 'proj-a',
				phase: 'resolveConflicts',
				order: ['claude', 'antigravity'],
				reason: 'trying',
			},
			'admin-token',
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toMatch(/^BAD_REQUEST: "antigravity" names none/);
		expect(upsertProjectToDb).not.toHaveBeenCalled();
		expect(lastSettle()).toMatchObject({ outcome: 'refused', projectId: null });
	});

	it('refuses a phase that has no targets configured', async () => {
		const result = await callTool(
			'phase_agents_reorder',
			{ projectId: 'proj-a', phase: 'planning', order: ['claude'], reason: 'trying' },
			'admin-token',
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toMatch(/^PRECONDITION_FAILED: .*no configured targets/);
		expect(upsertProjectToDb).not.toHaveBeenCalled();
	});

	it('restores the order the latest real reorder replaced — a round trip', async () => {
		await callTool(
			'phase_agents_reorder',
			{
				projectId: 'proj-a',
				phase: 'resolveConflicts',
				order: ['claude', 'codex'],
				reason: 'codex is rate-limited',
			},
			'admin-token',
		);
		const recorded = lastSettle()?.detail;
		findLatestOperatorAction.mockResolvedValue({
			id: 'audit-reorder',
			detail: recorded,
			startedAt: new Date('2026-11-06T10:00:00Z'),
		});
		upsertProjectToDb.mockClear();

		const result = await callTool(
			'phase_agents_restore',
			{ projectId: 'proj-a', phase: 'resolveConflicts', reason: 'codex has reset' },
			'admin-token',
		);

		expect(result.isError).toBeUndefined();
		expect(findLatestOperatorAction).toHaveBeenCalledExactlyOnceWith({
			tool: 'phase_agents_reorder',
			projectId: 'proj-a',
			target: 'proj-a/resolveConflicts',
		});
		expect(result.structuredContent?.result).toEqual({
			projectId: 'proj-a',
			phase: 'resolveConflicts',
			before: ['claude/opus', 'codex/gpt-5.6-sol'],
			after: ['codex/gpt-5.6-sol', 'claude/opus'],
		});
		expect(savedPhase().resolveConflicts).toEqual({
			targets: [CODEX, CLAUDE],
			cli: 'codex',
			model: 'gpt-5.6-sol',
			reasoning: 'high',
			prompt: 'Keep both sides.',
		});
	});

	it('names the reorder it would restore on a dry run, saving nothing', async () => {
		storeTargets([CLAUDE, CODEX]);
		findLatestOperatorAction.mockResolvedValue({
			id: 'audit-reorder',
			detail: { previous: [CODEX, CLAUDE], next: [CLAUDE, CODEX] },
			startedAt: new Date('2026-11-06T10:00:00Z'),
		});

		const result = await callTool(
			'phase_agents_restore',
			{ projectId: 'proj-a', phase: 'resolveConflicts', reason: 'checking', dryRun: true },
			'admin-token',
		);

		expect(result.structuredContent?.preview).toEqual({
			projectId: 'proj-a',
			phase: 'resolveConflicts',
			restoring: { auditId: 'audit-reorder', reorderedAt: '2026-11-06T10:00:00.000Z' },
			before: ['claude/opus', 'codex/gpt-5.6-sol'],
			after: ['codex/gpt-5.6-sol', 'claude/opus'],
		});
		expect(upsertProjectToDb).not.toHaveBeenCalled();
	});

	it('refuses to restore once the targets were edited by hand since the reorder', async () => {
		storeTargets([CLAUDE, { ...CODEX, model: 'gpt-5.6-terra' }]);
		findLatestOperatorAction.mockResolvedValue({
			id: 'audit-reorder',
			detail: { previous: [CODEX, CLAUDE], next: [CLAUDE, CODEX] },
			startedAt: new Date('2026-11-06T10:00:00Z'),
		});

		const result = await callTool(
			'phase_agents_restore',
			{ projectId: 'proj-a', phase: 'resolveConflicts', reason: 'codex has reset' },
			'admin-token',
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toMatch(/^PRECONDITION_FAILED: .*no longer a permutation/);
		expect(upsertProjectToDb).not.toHaveBeenCalled();
		expect(lastSettle()).toMatchObject({ outcome: 'refused', projectId: null });
	});

	it('refuses to restore when the phase was never reordered', async () => {
		const result = await callTool(
			'phase_agents_restore',
			{ projectId: 'proj-a', phase: 'resolveConflicts', reason: 'codex has reset' },
			'admin-token',
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toMatch(/^PRECONDITION_FAILED: .*no successful/);
		expect(upsertProjectToDb).not.toHaveBeenCalled();
	});

	it('refuses a non-admin restore before reading the audit trail', async () => {
		const result = await callTool(
			'phase_agents_restore',
			{ projectId: 'proj-a', phase: 'resolveConflicts', reason: 'trying' },
			'driver-token',
		);

		expect(result.content[0]?.text).toMatch(/^FORBIDDEN: /);
		expect(findLatestOperatorAction).not.toHaveBeenCalled();
		expect(upsertProjectToDb).not.toHaveBeenCalled();
	});
});

describe('operator MCP — cli_rate_limit_set', () => {
	const NOW = new Date('2026-11-06T12:00:00.000Z');
	const UNTIL = '2026-11-06T18:00:00.000Z';
	const OTHER_WORKER_ID = '99999999-9999-4999-8999-999999999999';
	/** A worker as the service returns it, reduced to what the procedure reads. */
	function machine(id: string, displayName: string, ownerUserId = MEMBER.id) {
		return { id, displayName, ownerUserId };
	}

	beforeEach(() => {
		vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
		getWorker.mockImplementation(async (id: string) =>
			id === WORKER_ID ? machine(WORKER_ID, 'idle-box') : undefined,
		);
		listWorkersForOwner.mockResolvedValue([
			machine(WORKER_ID, 'idle-box'),
			machine(OTHER_WORKER_ID, 'second-box'),
		]);
		listActiveCliRateLimitsForWorkers.mockResolvedValue(
			new Map([
				[
					OTHER_WORKER_ID,
					[
						{
							...COOL_DOWN,
							workerId: OTHER_WORKER_ID,
							expiresAt: new Date('2026-11-06T15:00:00Z'),
						},
					],
				],
			]),
		);
		extendWorkerCliRateLimits.mockImplementation(async ({ workerIds }) => workerIds);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function auditRow() {
		expect(recordOperatorAction).toHaveBeenCalledTimes(1);
		expect(settleOperatorAction).toHaveBeenCalledTimes(1);
		return {
			...recordOperatorAction.mock.calls[0]?.[0],
			...settleOperatorAction.mock.calls[0]?.[1],
		};
	}

	it("answers a dry run with every owner machine's current and new expiry, writing nothing", async () => {
		const result = await callTool(
			'cli_rate_limit_set',
			{
				workerId: WORKER_ID,
				cli: 'claude',
				until: UNTIL,
				scope: 'owner',
				reason: 'the Claude subscription is spent until tonight',
				dryRun: true,
			},
			'member-token',
		);

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual({
			dryRun: true,
			auditId: 'audit-1',
			preview: {
				cli: 'claude',
				scope: 'owner',
				requestedExpiresAt: UNTIL,
				resetHint: null,
				workers: [
					{
						workerId: WORKER_ID,
						displayName: 'idle-box',
						currentExpiresAt: null,
						newExpiresAt: UNTIL,
						change: 'create',
					},
					{
						workerId: OTHER_WORKER_ID,
						displayName: 'second-box',
						currentExpiresAt: '2026-11-06T15:00:00.000Z',
						newExpiresAt: UNTIL,
						change: 'extend',
					},
				],
			},
		});
		expect(listWorkersForOwner).toHaveBeenCalledWith(MEMBER.id);
		expect(extendWorkerCliRateLimits).not.toHaveBeenCalled();
		expect(auditRow()).toMatchObject({
			tool: 'cli_rate_limit_set',
			target: `${WORKER_ID}:claude`,
			projectId: null,
			dryRun: true,
			outcome: 'succeeded',
		});
	});

	it("blocks the owner's own machine and audits the call", async () => {
		const result = await callTool(
			'cli_rate_limit_set',
			{
				workerId: WORKER_ID,
				cli: 'claude',
				durationMinutes: 360,
				resetHint: 'weekly limit',
				reason: 'spent from another tool',
			},
			'member-token',
		);

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toMatchObject({
			dryRun: false,
			result: {
				scope: 'worker',
				requestedExpiresAt: UNTIL,
				workers: [{ workerId: WORKER_ID, change: 'create', newExpiresAt: UNTIL }],
			},
		});
		expect(extendWorkerCliRateLimits).toHaveBeenCalledWith({
			workerIds: [WORKER_ID],
			cli: 'claude',
			expiresAt: new Date(UNTIL),
			observedAt: NOW,
			resetHint: 'weekly limit',
		});
		expect(auditRow()).toMatchObject({
			userId: MEMBER.id,
			projectId: null,
			dryRun: false,
			outcome: 'succeeded',
			error: null,
		});
	});

	it.each([
		[false],
		[true],
	])("hides another owner's worker from a non-admin (dryRun %s) and audits the refusal", async (dryRun) => {
		const result = await callTool(
			'cli_rate_limit_set',
			{ workerId: WORKER_ID, cli: 'claude', until: UNTIL, reason: 'trying', dryRun },
			'stranger-token',
		);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toBe(`NOT_FOUND: Worker with ID "${WORKER_ID}" not found`);
		expect(listActiveCliRateLimitsForWorkers).not.toHaveBeenCalled();
		expect(extendWorkerCliRateLimits).not.toHaveBeenCalled();
		expect(auditRow()).toMatchObject({ outcome: 'refused', projectId: null, dryRun });
	});
});
