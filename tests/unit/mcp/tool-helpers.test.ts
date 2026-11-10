import { TRPCError } from '@trpc/server';
import { describe, expect, it, vi } from 'vitest';

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@/lib/logger.js', async () => ({
	...(await vi.importActual<typeof import('@/lib/logger.js')>('@/lib/logger.js')),
	logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() },
}));

import type { SwarmUser } from '@/identity/schema.js';
import type { ToolContext } from '@/mcp/tool-access.js';
import { jsonResult, runTool } from '@/mcp/tool-helpers.js';

const USER: SwarmUser = {
	id: '22222222-2222-4222-8222-222222222222',
	identifier: 'member@example.com',
	displayName: 'member',
	instanceAdmin: false,
	createdAt: new Date('2026-01-01T00:00:00Z'),
	updatedAt: new Date('2026-01-01T00:00:00Z'),
};
/** A ceiling every tool, listed or not, is open to. */
const ADMIN: ToolContext = { user: USER, ceiling: 'instanceAdmin' };

describe('jsonResult', () => {
	it('returns an object as JSON text and as the same structured content', () => {
		const result = jsonResult({ at: new Date('2026-10-28T10:00:00Z'), n: 1 });

		expect(result.structuredContent).toEqual({ at: '2026-10-28T10:00:00.000Z', n: 1 });
		expect(JSON.parse(result.content[0]?.type === 'text' ? result.content[0].text : '')).toEqual(
			result.structuredContent,
		);
	});

	// The MCP schema requires `structuredContent` to be an object.
	it.each([[[1, 2]], [null], ['text']])('carries %j as text only', (value) => {
		const result = jsonResult(value);

		expect(result.structuredContent).toBeUndefined();
		expect(result.content).toEqual([{ type: 'text', text: JSON.stringify(value, null, 2) }]);
	});
});

describe('runTool', () => {
	it("passes a tool body's result through", async () => {
		const result = await runTool(ADMIN, 't', async () => ({ ok: true }));

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual({ ok: true });
	});

	// Issue #1382: the tool's TOOL_ACCESS role is checked before its body runs.
	it.each([
		['contributor', 'run_reset'],
		['projectAdmin', 'an_unlisted_tool'],
	] as const)('refuses a %s calling %s with FORBIDDEN, never running the body', async (ceiling, tool) => {
		const body = vi.fn(async () => ({ ok: true }));

		const result = await runTool({ user: USER, ceiling }, tool, body);

		expect(result.isError).toBe(true);
		expect(result.content).toEqual([
			{
				type: 'text',
				text: expect.stringMatching(new RegExp(`^FORBIDDEN: Tool "${tool}" needs `)),
			},
		]);
		expect(body).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
	});

	it("reports a procedure's refusal verbatim as an error result", async () => {
		const result = await runTool(ADMIN, 't', async () => {
			throw new TRPCError({ code: 'FORBIDDEN', message: 'Not a member of this project' });
		});

		expect(result).toEqual({
			isError: true,
			content: [{ type: 'text', text: 'FORBIDDEN: Not a member of this project' }],
		});
		expect(warn).not.toHaveBeenCalled();
	});

	it('reports and logs an unexpected failure with its cause', async () => {
		const result = await runTool(ADMIN, 'runs_list', async () => {
			throw new Error('Failed query', { cause: new Error('connection reset') });
		});

		expect(result.isError).toBe(true);
		expect(result.content).toEqual([
			{ type: 'text', text: 'Tool "runs_list" failed: Failed query ← connection reset' },
		]);
		expect(warn).toHaveBeenCalledWith('operator MCP tool failed', {
			tool: 'runs_list',
			error: 'Failed query ← connection reset',
		});
	});

	// tRPC wraps a procedure's plain throw as INTERNAL_SERVER_ERROR: same wording as a
	// refusal, but logged as the failure it is.
	it('reports an INTERNAL_SERVER_ERROR verbatim and logs it with its cause', async () => {
		const result = await runTool(ADMIN, 'run_reset', async () => {
			throw new TRPCError({
				code: 'INTERNAL_SERVER_ERROR',
				message: 'Failed to reset run "r1": connection reset',
				cause: new Error('connection reset'),
			});
		});

		expect(result).toEqual({
			isError: true,
			content: [
				{ type: 'text', text: 'INTERNAL_SERVER_ERROR: Failed to reset run "r1": connection reset' },
			],
		});
		expect(warn).toHaveBeenCalledWith('operator MCP tool failed', {
			tool: 'run_reset',
			error: 'INTERNAL_SERVER_ERROR: Failed to reset run "r1": connection reset',
			cause: 'connection reset',
		});
	});
});
