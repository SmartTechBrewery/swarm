import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The bug-report tools (issue #1383) against a fake tRPC caller: which `bugReports`
 * procedure each tool reaches, with what, and how the writes are audited. The
 * procedures' own authorization and rules are `tests/unit/api/routers/bugReports.test.ts`'s.
 */
const { recordOperatorAction, settleOperatorAction, caller } = vi.hoisted(() => ({
	recordOperatorAction: vi.fn(),
	settleOperatorAction: vi.fn(),
	caller: {
		bugReports: {
			list: vi.fn(),
			get: vi.fn(),
			previewCreate: vi.fn(),
			create: vi.fn(),
			previewAddOccurrence: vi.fn(),
			addOccurrence: vi.fn(),
			previewSetStatus: vi.fn(),
			setStatus: vi.fn(),
		},
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
import { registerBugReportTools } from '@/mcp/tools/bug-reports.js';

const USER: SwarmUser = {
	id: '22222222-2222-4222-8222-222222222222',
	identifier: 'member@example.com',
	displayName: 'member',
	instanceAdmin: false,
	createdAt: new Date('2026-01-01T00:00:00Z'),
	updatedAt: new Date('2026-01-01T00:00:00Z'),
};

const REPORT_ID = '11111111-1111-4111-8111-111111111111';

type Handler = (args: Record<string, unknown>) => Promise<CallToolResult>;
const handlers = new Map<string, Handler>();
const descriptions = new Map<string, string>();
const server = {
	registerTool: (name: string, config: { description: string }, handler: Handler) => {
		handlers.set(name, handler);
		descriptions.set(name, config.description);
	},
} as unknown as McpServer;
registerBugReportTools(server, { user: USER, credential: { kind: 'user' }, ceiling: 'member' });

function call(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
	const handler = handlers.get(tool);
	if (!handler) throw new Error(`no tool ${tool}`);
	return handler(args);
}

beforeEach(() => {
	recordOperatorAction.mockReset().mockResolvedValue('audit-1');
	settleOperatorAction.mockReset().mockResolvedValue(undefined);
	for (const fn of Object.values(caller.bugReports)) fn.mockReset();
});

describe('the read tools', () => {
	it('bug_reports_list passes its filters to bugReports.list', async () => {
		caller.bugReports.list.mockResolvedValue({ data: [], total: 0 });
		const input = { projectId: 'p1', status: ['new', 'confirmed'], query: 'lease' };

		const result = await call('bug_reports_list', input);

		expect(result.structuredContent).toEqual({ data: [], total: 0 });
		expect(caller.bugReports.list).toHaveBeenCalledWith(input);
	});

	it('bug_report_get reports a refusal as an error result', async () => {
		caller.bugReports.get.mockRejectedValue(
			new TRPCError({ code: 'NOT_FOUND', message: `Bug report "${REPORT_ID}" not found.` }),
		);

		const result = await call('bug_report_get', { reportId: REPORT_ID });

		expect(result.isError).toBe(true);
		expect(result.content[0]).toMatchObject({
			text: `NOT_FOUND: Bug report "${REPORT_ID}" not found.`,
		});
	});
});

describe('bug_report_create', () => {
	const input = { title: 'Lease lost', description: 'The worker lease lapsed.', runId: 'run-1' };

	it("previews, then creates — auditing the run as the target and the preview's project", async () => {
		caller.bugReports.previewCreate.mockResolvedValue({ projectId: 'p1', report: {} });
		caller.bugReports.create.mockResolvedValue({ report: { id: REPORT_ID } });

		const result = await call('bug_report_create', {
			...input,
			reason: 'seen twice',
			dryRun: false,
		});

		expect(result.isError).toBeUndefined();
		expect(caller.bugReports.previewCreate).toHaveBeenCalledWith(input);
		expect(caller.bugReports.create).toHaveBeenCalledWith(input);
		expect(recordOperatorAction).toHaveBeenCalledWith(
			expect.objectContaining({ tool: 'bug_report_create', target: 'run-1', input }),
		);
		expect(settleOperatorAction).toHaveBeenCalledWith('audit-1', {
			outcome: 'succeeded',
			error: null,
			projectId: 'p1',
		});
	});

	it('answers a dry run from the preview and never creates', async () => {
		const plan = { projectId: 'p1', report: { title: 'Lease lost' } };
		caller.bugReports.previewCreate.mockResolvedValue(plan);

		const result = await call('bug_report_create', { ...input, reason: 'checking', dryRun: true });

		expect(result.structuredContent).toEqual({ dryRun: true, auditId: 'audit-1', preview: plan });
		expect(caller.bugReports.create).not.toHaveBeenCalled();
	});

	it('tells the caller to search first and add an occurrence instead of duplicating', () => {
		const description = descriptions.get('bug_report_create') ?? '';
		expect(description).toContain('bug_reports_list');
		expect(description).toContain('bug_report_add_occurrence');
		expect(description).toContain('`environmental`');
	});
});

describe('bug_report_add_occurrence', () => {
	it('adds the occurrence to the report it names', async () => {
		caller.bugReports.previewAddOccurrence.mockResolvedValue({ projectId: 'p1' });
		caller.bugReports.addOccurrence.mockResolvedValue({ report: { occurrenceCount: 2 } });
		const input = { reportId: REPORT_ID, prNumber: 12, note: 'again' };

		await call('bug_report_add_occurrence', { ...input, reason: 'recurred', dryRun: false });

		expect(caller.bugReports.addOccurrence).toHaveBeenCalledWith(input);
		expect(recordOperatorAction).toHaveBeenCalledWith(
			expect.objectContaining({ tool: 'bug_report_add_occurrence', target: REPORT_ID }),
		);
	});
});

describe('bug_report_set_status', () => {
	it('settles a refused preview as refused and never writes', async () => {
		caller.bugReports.previewSetStatus.mockRejectedValue(
			new TRPCError({ code: 'BAD_REQUEST', message: 'Status "ticketed" needs `githubIssueUrl`.' }),
		);

		const result = await call('bug_report_set_status', {
			reportId: REPORT_ID,
			status: 'ticketed',
			reason: 'filed upstream',
			dryRun: false,
		});

		expect(result.isError).toBe(true);
		expect(caller.bugReports.setStatus).not.toHaveBeenCalled();
		expect(settleOperatorAction).toHaveBeenCalledWith('audit-1', {
			outcome: 'refused',
			error: 'BAD_REQUEST: Status "ticketed" needs `githubIssueUrl`.',
			projectId: null,
		});
	});

	it('records a ticketed report through bugReports.setStatus', async () => {
		caller.bugReports.previewSetStatus.mockResolvedValue({ projectId: 'p1' });
		caller.bugReports.setStatus.mockResolvedValue({ id: REPORT_ID, status: 'ticketed' });
		const input = {
			reportId: REPORT_ID,
			status: 'ticketed',
			githubIssueUrl: 'https://github.com/acme/swarm/issues/9',
		};

		await call('bug_report_set_status', { ...input, reason: 'filed upstream', dryRun: false });

		expect(caller.bugReports.setStatus).toHaveBeenCalledWith(input);
		expect(descriptions.get('bug_report_set_status')).toContain("status: 'ticketed'");
	});
});
