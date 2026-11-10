import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The project set-up tools (issue #1359) against a fake tRPC caller: which dashboard
 * procedure each tool reaches, with what, and that a secret given as input never reaches
 * the audit trail or a result. The procedures' own authorization and validation are
 * covered by their router suites (`tests/unit/api/routers/projects.test.ts`,
 * `credentials.test.ts`).
 */
const { recordOperatorAction, settleOperatorAction, caller } = vi.hoisted(() => ({
	recordOperatorAction: vi.fn(),
	settleOperatorAction: vi.fn(),
	caller: {
		projects: {
			getById: vi.fn(),
			previewCreate: vi.fn(),
			create: vi.fn(),
			previewUpdate: vi.fn(),
			update: vi.fn(),
			readiness: vi.fn(),
			credentials: {
				list: vi.fn(),
				listPm: vi.fn(),
				previewSet: vi.fn(),
				set: vi.fn(),
				previewSetPm: vi.fn(),
				setPm: vi.fn(),
			},
		},
		pm: { listProviders: vi.fn(), discoverContainers: vi.fn(), discoverStates: vi.fn() },
	},
}));
vi.mock('@/db/repositories/operatorActionsRepository.js', () => ({
	recordOperatorAction,
	settleOperatorAction,
}));
vi.mock('@/mcp/tool-helpers.js', async () => ({
	...(await vi.importActual<typeof import('@/mcp/tool-helpers.js')>('@/mcp/tool-helpers.js')),
	callerFor: () => caller,
}));

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SwarmUser } from '@/identity/schema.js';
import { registerProjectSetupTools } from '@/mcp/tools/project-setup.js';

const USER: SwarmUser = {
	id: '22222222-2222-4222-8222-222222222222',
	identifier: 'admin@example.com',
	displayName: 'admin',
	instanceAdmin: true,
	createdAt: new Date('2026-01-01T00:00:00Z'),
	updatedAt: new Date('2026-01-01T00:00:00Z'),
};

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;
const handlers = new Map<string, Handler>();
const server = {
	registerTool: (name: string, _config: unknown, handler: Handler) => handlers.set(name, handler),
} as unknown as McpServer;
registerProjectSetupTools(server, { user: USER, ceiling: 'instanceAdmin' });

function call(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
	const handler = handlers.get(tool);
	if (!handler) throw new Error(`no tool ${tool}`);
	return handler(args);
}

function auditInput(): unknown {
	return recordOperatorAction.mock.calls[0]?.[0]?.input;
}

beforeEach(() => {
	recordOperatorAction.mockReset().mockResolvedValue('audit-1');
	settleOperatorAction.mockReset().mockResolvedValue(undefined);
	for (const group of [caller.projects, caller.projects.credentials, caller.pm]) {
		for (const fn of Object.values(group)) {
			if (typeof fn === 'function') (fn as ReturnType<typeof vi.fn>).mockReset();
		}
	}
});

describe('project_create', () => {
	const input = {
		id: 'new-proj',
		name: 'New',
		repositories: [{ repo: 'acme/app' }],
		repoRoot: '/src/app',
		reviewerToken: 'ghp_very_secret',
	};

	it('previews, then creates with the whole input — and audits the token as [redacted]', async () => {
		caller.projects.previewCreate.mockResolvedValue({
			project: { id: 'new-proj' },
			wouldRefuse: null,
		});
		caller.projects.create.mockResolvedValue({ id: 'new-proj', name: 'New' });

		const result = await call('project_create', {
			...input,
			reason: 'new team repo',
			dryRun: false,
		});

		expect(result.isError).toBeUndefined();
		// The dry run gets only the token's presence; the write gets the token.
		const { reviewerToken: _token, ...withoutToken } = input;
		expect(caller.projects.previewCreate).toHaveBeenCalledWith({
			...withoutToken,
			hasReviewerToken: true,
		});
		expect(caller.projects.create).toHaveBeenCalledWith(input);
		expect(auditInput()).toEqual({ ...input, reviewerToken: '[redacted]' });
		expect(JSON.stringify(recordOperatorAction.mock.calls)).not.toContain('ghp_very_secret');
		expect(JSON.stringify(result)).not.toContain('ghp_very_secret');
		expect(settleOperatorAction).toHaveBeenCalledWith('audit-1', {
			outcome: 'succeeded',
			error: null,
			projectId: 'new-proj',
		});
	});

	it('answers a dry run from the preview alone, naming no project when it would be refused', async () => {
		const plan = { project: null, wouldRefuse: { code: 'CONFLICT', message: 'taken' } };
		caller.projects.previewCreate.mockResolvedValue(plan);

		const result = await call('project_create', { ...input, reason: 'checking', dryRun: true });

		expect(result.structuredContent).toEqual({ dryRun: true, auditId: 'audit-1', preview: plan });
		expect(caller.projects.create).not.toHaveBeenCalled();
		expect(settleOperatorAction).toHaveBeenCalledWith('audit-1', {
			outcome: 'succeeded',
			error: null,
			projectId: null,
		});
	});
});

describe('project_update and pm_board_set', () => {
	it('passes the fields to projects.update under the project id', async () => {
		caller.projects.previewUpdate.mockResolvedValue({ wouldRefuse: null });
		caller.projects.update.mockResolvedValue({ id: 'p1' });
		const agents = { review: { targets: [{ cli: 'codex' }, { cli: 'claude' }] } };

		await call('project_update', {
			projectId: 'p1',
			agents,
			reason: 'review on codex',
			dryRun: false,
		});

		expect(caller.projects.previewUpdate).toHaveBeenCalledWith({ id: 'p1', agents });
		expect(caller.projects.update).toHaveBeenCalledWith({ id: 'p1', agents });
	});

	// A merged pipeline the schema rejects is an operator mistake, not a broken procedure.
	it('settles a BAD_REQUEST from the write as refused, not failed', async () => {
		caller.projects.previewUpdate.mockResolvedValue({ wouldRefuse: null });
		const message = 'Respond-to-review cannot be enabled when Review is disabled';
		caller.projects.update.mockRejectedValue(new TRPCError({ code: 'BAD_REQUEST', message }));

		const result = await call('project_update', {
			projectId: 'p1',
			pipeline: { review: { enabled: false } },
			reason: 'turn review off',
			dryRun: false,
		});

		expect(result.isError).toBe(true);
		expect(settleOperatorAction).toHaveBeenCalledWith('audit-1', {
			outcome: 'refused',
			error: expect.stringContaining(message),
			projectId: 'p1',
		});
	});

	it('saves a board mapping as the pm member of an update', async () => {
		caller.projects.previewUpdate.mockResolvedValue({ wouldRefuse: null });
		caller.projects.update.mockResolvedValue({ id: 'p1' });
		const pm = {
			type: 'github-projects',
			projectId: 'PVT_1',
			statusFieldId: 'F_1',
			statusOptions: { backlog: 'a' },
		};

		await call('pm_board_set', { projectId: 'p1', pm, reason: 'connect board', dryRun: false });

		expect(caller.projects.update).toHaveBeenCalledWith({ id: 'p1', pm });
	});
});

describe('project_credential_set', () => {
	it("resolves the project's SCM provider when none is named and never records the value", async () => {
		caller.projects.getById.mockResolvedValue({ id: 'p1', scm: 'gitlab' });
		caller.projects.credentials.previewSet.mockResolvedValue({ change: 'set' });

		const result = await call('project_credential_set', {
			projectId: 'p1',
			side: 'scm',
			role: 'reviewer',
			value: 'glpat-secret',
			reason: 'reviewer token',
			dryRun: false,
		});

		expect(result.isError).toBeUndefined();
		expect(caller.projects.credentials.previewSet).toHaveBeenCalledWith({
			projectId: 'p1',
			providerId: 'gitlab',
			role: 'reviewer',
		});
		expect(caller.projects.credentials.set).toHaveBeenCalledWith({
			projectId: 'p1',
			providerId: 'gitlab',
			role: 'reviewer',
			value: 'glpat-secret',
		});
		expect(auditInput()).toMatchObject({ value: '[redacted]' });
		expect(JSON.stringify(recordOperatorAction.mock.calls)).not.toContain('glpat-secret');
		expect(JSON.stringify(result)).not.toContain('glpat-secret');
	});

	it('writes a PM credential for the provider named', async () => {
		caller.projects.credentials.previewSetPm.mockResolvedValue({ change: 'replace' });

		await call('project_credential_set', {
			projectId: 'p1',
			side: 'pm',
			providerId: 'linear',
			role: 'apiKey',
			value: 'lin_secret',
			reason: 'board key',
			dryRun: false,
		});

		expect(caller.projects.credentials.setPm).toHaveBeenCalledWith({
			projectId: 'p1',
			providerId: 'linear',
			role: 'apiKey',
			value: 'lin_secret',
		});
	});

	it('refuses an unknown PM provider before writing, and audits the refusal', async () => {
		const result = await call('project_credential_set', {
			projectId: 'p1',
			side: 'pm',
			providerId: 'asana',
			role: 'apiKey',
			value: 'x',
			reason: 'typo',
			dryRun: false,
		});

		expect(result.isError).toBe(true);
		expect(caller.projects.credentials.setPm).not.toHaveBeenCalled();
		expect(settleOperatorAction).toHaveBeenCalledWith(
			'audit-1',
			expect.objectContaining({ outcome: 'refused' }),
		);
	});
});

describe('the read tools', () => {
	it('project_get returns the record with both credential lists', async () => {
		caller.projects.getById.mockResolvedValue({ id: 'p1' });
		caller.projects.credentials.list.mockResolvedValue({ roles: [] });
		caller.projects.credentials.listPm.mockResolvedValue({ roles: [] });

		const result = await call('project_get', { projectId: 'p1' });

		expect(result.structuredContent).toEqual({
			project: { id: 'p1' },
			credentials: { scm: { roles: [] }, pm: { roles: [] } },
		});
	});

	it('pm_board_discover lists boards without a container and states with one', async () => {
		caller.pm.listProviders.mockResolvedValue([{ id: 'github-projects' }]);
		caller.pm.discoverContainers.mockResolvedValue({
			containers: [{ id: 'PVT_1', name: 'Board' }],
		});
		caller.pm.discoverStates.mockResolvedValue({
			states: [{ id: 'a', name: 'Backlog' }],
			providerContext: { statusFieldId: 'F_1' },
		});

		const boards = await call('pm_board_discover', { projectId: 'p1' });
		expect(boards.structuredContent).toEqual({
			providers: [{ id: 'github-projects' }],
			containers: [{ id: 'PVT_1', name: 'Board' }],
		});

		const states = await call('pm_board_discover', { projectId: 'p1', containerId: 'PVT_1' });
		expect(caller.pm.discoverStates).toHaveBeenCalledWith({
			projectId: 'p1',
			containerId: 'PVT_1',
			providerId: undefined,
			discoveryDraft: undefined,
		});
		expect(states.structuredContent).toMatchObject({
			containerId: 'PVT_1',
			providerContext: { statusFieldId: 'F_1' },
			statusKeys: ['backlog', 'planning', 'todo', 'inProgress', 'inReview', 'done'],
		});
	});

	it('project_readiness returns the procedure report', async () => {
		caller.projects.readiness.mockResolvedValue({ projectId: 'p1', ready: true, items: [] });

		const result = await call('project_readiness', { projectId: 'p1' });

		expect(caller.projects.readiness).toHaveBeenCalledWith({ projectId: 'p1' });
		expect(result.structuredContent).toMatchObject({ ready: true });
	});
});
