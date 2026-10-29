import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The read-only `runs` namespace on the operator API (issue #1182), driven through
 * the **real mount** with a real bearer, so what is under test is exactly what a
 * `swarm run list|show|logs` caller reaches: the authorization boundary (a member,
 * an instance admin, a non-member) and the absence of every run mutation.
 *
 * Mocked at the same boundaries `tests/unit/api/routers/runs.test.ts` uses — the
 * run repository reads, the membership service the authz helpers consult, and the
 * one dispatch read `getById`'s enrichment makes for a settled run — each keeping
 * the rest of its module real.
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

import { operatorRouter } from '@/api/operator-router.js';
import { runsRouter } from '@/api/routers/runs.js';
import type { SwarmUser } from '@/identity/schema.js';
import { type OperatorApiDeps, registerOperatorApi } from '@/router/operator-api.js';

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

/**
 * A failed run with no worker, recovery or checkpoint, so `getById`'s enrichment
 * makes the one dispatch read and nothing else.
 */
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
		failureDiagnosis: {
			kind: 'agent-error',
			title: 'The agent failed',
			message: 'It exited non-zero.',
			recovery: 'Retry the run.',
		},
		startedAt: new Date('2026-10-28T10:00:00Z'),
		completedAt: new Date('2026-10-28T10:05:00Z'),
	};
}

function appWith(): Hono {
	const deps: OperatorApiDeps = { resolveSession: vi.fn(async (token: string) => TOKENS[token]) };
	const app = new Hono();
	registerOperatorApi(app, deps);
	return app;
}

/** A tRPC query over HTTP GET, as `src/cli/_shared/operator-client.ts` sends it. */
function query(path: string, input: unknown, token?: string) {
	const qs = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify(input))}`;
	return appWith().request(`/operator/trpc/${path}${qs}`, {
		headers: token ? { authorization: `Bearer ${token}` } : {},
	});
}

function mutation(path: string, token: string) {
	return appWith().request(`/operator/trpc/${path}`, {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ id: RUN_ID, runId: RUN_ID }),
	});
}

async function errorOf(response: Response): Promise<{ message?: string; code?: number }> {
	const body = (await response.json()) as { error?: { message?: string; code?: number } };
	return body.error ?? {};
}

const LOGS = { stdout: 'agent stdout', stderr: 'agent stderr' };
const OUTPUT_PAGE = {
	events: [{ id: 1, stream: 'stdout', content: 'hello\n', emittedAt: new Date('2026-10-28') }],
	nextCursor: 1,
	hasMore: false,
	truncated: false,
	retentionBytes: 1_000_000,
};

beforeEach(() => {
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

describe('operator API runs — a project member', () => {
	it('reads a run of their project, with its headline and failure cause', async () => {
		const response = await query('runs.getById', { id: RUN_ID }, 'member-token');

		expect(response.status).toBe(200);
		const body = (await response.json()) as { result: { data: Record<string, unknown> } };
		expect(body.result.data).toMatchObject({
			id: RUN_ID,
			error: 'Agent exited 1',
			failureDiagnosis: { title: 'The agent failed', recovery: 'Retry the run.' },
		});
	});

	it("reads a run's captured logs and agent output", async () => {
		const logs = await query('runs.getLogs', { runId: RUN_ID }, 'member-token');
		const output = await query('runs.getOutput', { runId: RUN_ID, after: 0 }, 'member-token');

		expect(logs.status).toBe(200);
		expect(await logs.json()).toEqual({ result: { data: LOGS } });
		expect(output.status).toBe(200);
		expect(getRunOutputEvents).toHaveBeenCalledWith(RUN_ID, 0);
	});

	it('lists only the runs of the projects they belong to', async () => {
		const response = await query('runs.list', {}, 'member-token');

		expect(response.status).toBe(200);
		expect(listRunsFromDb).toHaveBeenCalledWith({ limit: 50, offset: 0, projectIds: ['proj-a'] });
	});

	it('lists one of their projects when filtered to it', async () => {
		const response = await query('runs.list', { projectId: 'proj-a' }, 'member-token');

		expect(response.status).toBe(200);
		expect(listRunsFromDb).toHaveBeenCalledWith({ projectId: 'proj-a', limit: 50, offset: 0 });
	});
});

describe('operator API runs — an instance admin', () => {
	it('lists the whole installation unfiltered, with no membership read', async () => {
		const response = await query('runs.list', {}, 'admin-token');

		expect(response.status).toBe(200);
		expect(listRunsFromDb).toHaveBeenCalledWith({ limit: 50, offset: 0 });
		expect(listAccessibleProjectIds).not.toHaveBeenCalled();
	});

	it('reads a run of a project they hold no membership in', async () => {
		const response = await query('runs.getById', { id: OTHER_PROJECT_RUN_ID }, 'admin-token');

		expect(response.status).toBe(200);
		expect(getMembership).not.toHaveBeenCalled();
	});
});

describe('operator API runs — a non-member', () => {
	// The dashboard hides a run's existence from a non-member behind the very same
	// not-found an unknown id gets, so the refusal must be indistinguishable here too.
	it.each([
		['runs.getById', { id: RUN_ID }],
		['runs.getLogs', { runId: RUN_ID }],
		['runs.getOutput', { runId: RUN_ID, after: 0 }],
	])('gets the same not-found for %s as for an unknown run', async (path, input) => {
		const refused = await query(path, input, 'stranger-token');
		const unknownId = '66666666-6666-4666-8666-666666666666';
		const unknownInput = 'id' in input ? { id: unknownId } : { ...input, runId: unknownId };
		const unknown = await query(path, unknownInput, 'stranger-token');

		expect(refused.status).toBe(404);
		expect((await errorOf(refused)).message).toBe(`Run with ID "${RUN_ID}" not found`);
		expect(unknown.status).toBe(404);
		expect((await errorOf(unknown)).message).toBe(`Run with ID "${unknownId}" not found`);
		expect(getRunLogsFromDb).not.toHaveBeenCalled();
		expect(getRunOutputEvents).not.toHaveBeenCalled();
	});

	it('is refused a project filter they are not a member of, without a query', async () => {
		const response = await query('runs.list', { projectId: 'proj-a' }, 'stranger-token');

		expect(response.status).toBe(404);
		expect(listRunsFromDb).not.toHaveBeenCalled();
	});

	it('gets an empty unfiltered list, without a query', async () => {
		const response = await query('runs.list', {}, 'stranger-token');

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ result: { data: { data: [], total: 0 } } });
		expect(listRunsFromDb).not.toHaveBeenCalled();
	});
});

describe('operator API runs — no session', () => {
	it('refuses a request carrying no bearer', async () => {
		const response = await query('runs.list', {});

		expect(response.status).toBe(401);
		expect(listRunsFromDb).not.toHaveBeenCalled();
	});
});

describe('operator API runs — read-only', () => {
	const runsProcedures = () =>
		Object.entries(
			operatorRouter._def.procedures as unknown as Record<string, { _def: { type: string } }>,
		)
			.filter(([path]) => path.startsWith('runs.'))
			.sort(([a], [b]) => a.localeCompare(b));

	it('carries exactly the four dashboard run reads, every one a query', () => {
		const procedures = runsProcedures();

		expect(procedures.map(([path]) => path)).toEqual([
			'runs.getById',
			'runs.getLogs',
			'runs.getOutput',
			'runs.list',
		]);
		for (const [, procedure] of procedures) expect(procedure._def.type).toBe('query');
	});

	// Verbatim reuse, not a copy: the procedure objects are the dashboard's own, so
	// their authorization cannot diverge between the two surfaces.
	it("mounts the dashboard's own procedure objects", () => {
		const dashboard = runsRouter._def.procedures as unknown as Record<string, unknown>;
		for (const [path, procedure] of runsProcedures()) {
			expect(procedure).toBe(dashboard[path.slice('runs.'.length)]);
		}
	});

	it.each([
		'runs.reset',
		'runs.retryNow',
		'runs.terminate',
		'runs.forceReReview',
		'runs.dismissStalled',
		'runs.putBack',
	])('does not serve the mutation %s, even to an instance admin', async (path) => {
		const response = await mutation(path, 'admin-token');

		expect(response.status).toBe(404);
		expect((await errorOf(response)).message).toContain('No procedure found');
	});

	it.each(['runs.queued', 'runs.stalled'])('does not serve the dispatch view %s', async (path) => {
		const response = await query(path, undefined, 'admin-token');

		expect(response.status).toBe(404);
		expect((await errorOf(response)).message).toContain('No procedure found');
	});

	// The values the dashboard masks are credential values; that namespace stays off.
	it('does not serve the credentials namespace', async () => {
		const response = await query('credentials.list', undefined, 'admin-token');

		expect(response.status).toBe(404);
	});
});
