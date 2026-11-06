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
 * dispatch read `getById`'s enrichment makes for a settled run.
 */
const { listRunsFromDb, getRunByIdFromDb, getRunLogsFromDb, getRunOutputEvents } = vi.hoisted(
	() => ({
		listRunsFromDb: vi.fn(),
		getRunByIdFromDb: vi.fn(),
		getRunLogsFromDb: vi.fn(),
		getRunOutputEvents: vi.fn(),
	}),
);
vi.mock('@/db/repositories/runsRepository.js', async () => ({
	...(await vi.importActual<typeof import('@/db/repositories/runsRepository.js')>(
		'@/db/repositories/runsRepository.js',
	)),
	listRunsFromDb,
	getRunByIdFromDb,
	getRunLogsFromDb,
	getRunOutputEvents,
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
const { getActiveDispatchByRunId } = vi.hoisted(() => ({ getActiveDispatchByRunId: vi.fn() }));
vi.mock('@/db/repositories/dispatchesRepository.js', async () => ({
	...(await vi.importActual<typeof import('@/db/repositories/dispatchesRepository.js')>(
		'@/db/repositories/dispatchesRepository.js',
	)),
	getActiveDispatchByRunId,
}));

import type { SwarmUser } from '@/identity/schema.js';
import { type OperatorMcpDeps, registerOperatorMcp } from '@/router/operator-mcp.js';

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
	it('initializes as the swarm server and lists exactly the run read tools', async () => {
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

		expect(tools.map((tool) => tool.name).sort()).toEqual(['run_get', 'runs_list']);
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
