import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The per-tool access table (issue #1382): the caller's role ceiling, the order
 * ceilings compare in, default-deny for a tool with no entry, and — the guard that
 * keeps the table honest — that every registered tool has exactly one entry.
 */
const { listProjectsForUser } = vi.hoisted(() => ({ listProjectsForUser: vi.fn() }));
vi.mock('@/identity/membership-service.js', async () => ({
	...(await vi.importActual<typeof import('@/identity/membership-service.js')>(
		'@/identity/membership-service.js',
	)),
	listProjectsForUser,
}));

import { SCOPED_AGENT_RECOVERY_TOOLS } from '@/identity/agent-access-token.js';
import type { ProjectRole } from '@/identity/membership.js';
import type { SwarmUser } from '@/identity/schema.js';
import { createSwarmMcpServer } from '@/mcp/server.js';
import {
	assertToolAccess,
	ceilingReaches,
	DEFAULT_TOOL_ACCESS,
	type McpCeiling,
	mcpCeilingFor,
	scopedAgentPrincipal,
	TOOL_ACCESS,
	type ToolContext,
	toolAccessFor,
	toolListedFor,
	userPrincipal,
} from '@/mcp/tool-access.js';

function user(instanceAdmin: boolean): SwarmUser {
	return {
		id: '22222222-2222-4222-8222-222222222222',
		identifier: 'someone@example.com',
		displayName: 'someone',
		instanceAdmin,
		createdAt: new Date('2026-01-01T00:00:00Z'),
		updatedAt: new Date('2026-01-01T00:00:00Z'),
	};
}

function memberships(...roles: ProjectRole[]) {
	return roles.map((role, index) => ({
		id: `m${index}`,
		projectId: `proj-${index}`,
		userId: user(false).id,
		role,
		createdAt: new Date(0),
	}));
}

/** A session's (or an ordinary token's) context at `ceiling`. */
function at(ceiling: McpCeiling, instanceAdmin = false): ToolContext {
	return { ...userPrincipal(user(instanceAdmin)), ceiling };
}

const TOKEN_ID = '33333333-3333-4333-8333-333333333333';

/** A scoped agent credential's context at `ceiling`, limited to `proj-0`. */
function scopedAt(ceiling: McpCeiling): ToolContext {
	return { ...scopedAgentPrincipal(user(true), TOKEN_ID, ['proj-0']), ceiling };
}

const ORDER: McpCeiling[] = ['signedIn', 'contributor', 'member', 'projectAdmin', 'instanceAdmin'];

beforeEach(() => {
	listProjectsForUser.mockReset().mockResolvedValue([]);
});

describe('ceilingReaches', () => {
	it.each(
		ORDER.flatMap((ceiling, ceilingIndex) =>
			ORDER.map((minRole, minIndex) => [ceiling, minRole, ceilingIndex >= minIndex] as const),
		),
	)('%s reaching a %s tool: %s', (ceiling, minRole, expected) => {
		expect(ceilingReaches(ceiling, minRole)).toBe(expected);
	});
});

describe('mcpCeilingFor', () => {
	it('is instanceAdmin for an installation administrator, reading no membership', async () => {
		expect(await mcpCeilingFor(user(true))).toBe('instanceAdmin');
		expect(listProjectsForUser).not.toHaveBeenCalled();
	});

	it('is the highest role across mixed memberships', async () => {
		listProjectsForUser.mockResolvedValue(memberships('contributor', 'projectAdmin', 'member'));

		expect(await mcpCeilingFor(user(false))).toBe('projectAdmin');
		expect(listProjectsForUser).toHaveBeenCalledWith(user(false).id);
	});

	it('is the only role a single membership holds', async () => {
		listProjectsForUser.mockResolvedValue(memberships('contributor'));

		expect(await mcpCeilingFor(user(false))).toBe('contributor');
	});

	it('is signedIn for a user with no membership', async () => {
		expect(await mcpCeilingFor(user(false))).toBe('signedIn');
	});

	// Issue #1385: a scoped agent credential's ceiling comes from its projects alone.
	it('is projectAdmin, never instanceAdmin, for an administrator holding a scoped credential', async () => {
		const { user: scoped } = scopedAgentPrincipal(user(true), TOKEN_ID, ['proj-0']);

		expect(await mcpCeilingFor(scoped)).toBe('projectAdmin');
		expect(listProjectsForUser).not.toHaveBeenCalled();
	});

	it("is a non-admin holder's highest role on the scoped projects only", async () => {
		// proj-0 contributor, proj-1 projectAdmin — only proj-0 is in scope.
		listProjectsForUser.mockResolvedValue(memberships('contributor', 'projectAdmin'));
		const { user: scoped } = scopedAgentPrincipal(user(false), TOKEN_ID, ['proj-0']);

		expect(await mcpCeilingFor(scoped)).toBe('contributor');
	});
});

describe('toolAccessFor and assertToolAccess', () => {
	it('default-denies a tool with no entry to everyone below an instance admin', () => {
		expect(toolAccessFor('a_tool_nobody_decided')).toEqual(DEFAULT_TOOL_ACCESS);
		expect(DEFAULT_TOOL_ACCESS.minRole).toBe('instanceAdmin');
		// An inherited object key is not an entry.
		expect(toolAccessFor('constructor')).toEqual(DEFAULT_TOOL_ACCESS);
		expect(() => assertToolAccess('a_tool_nobody_decided', at('projectAdmin'))).toThrow(TRPCError);
		expect(() =>
			assertToolAccess('a_tool_nobody_decided', at('instanceAdmin', true)),
		).not.toThrow();
	});

	it("refuses a caller below a listed tool's role with FORBIDDEN naming the role", () => {
		let thrown: unknown;
		try {
			assertToolAccess('project_update', at('member'));
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(TRPCError);
		expect((thrown as TRPCError).code).toBe('FORBIDDEN');
		expect((thrown as TRPCError).message).toBe(
			'Tool "project_update" needs the projectAdmin role on some project, which you do not hold.',
		);
		expect(() => assertToolAccess('project_update', at('projectAdmin'))).not.toThrow();
	});

	it('refuses a scoped agent credential every tool outside its allowlist, whatever the ceiling', () => {
		let thrown: unknown;
		try {
			assertToolAccess('project_update', scopedAt('projectAdmin'));
		} catch (error) {
			thrown = error;
		}

		expect((thrown as TRPCError).code).toBe('FORBIDDEN');
		expect((thrown as TRPCError).message).toBe(
			'Tool "project_update" is not available to a scoped agent credential.',
		);
		expect(() => assertToolAccess('a_tool_nobody_decided', scopedAt('instanceAdmin'))).toThrow(
			/not available to a scoped agent credential/,
		);
		expect(() => assertToolAccess('run_reset', scopedAt('member'))).not.toThrow();
		expect(() => assertToolAccess('run_reset', scopedAt('contributor'))).toThrow(/member role/);
	});

	it('lists a scoped agent credential only the allowlisted tools its ceiling reaches', () => {
		expect(toolListedFor('run_reset', scopedAt('projectAdmin'))).toBe(true);
		expect(toolListedFor('project_update', scopedAt('projectAdmin'))).toBe(false);
		expect(toolListedFor('run_reset', scopedAt('contributor'))).toBe(false);
		expect(toolListedFor('project_update', at('projectAdmin'))).toBe(true);
	});
});

describe('TOOL_ACCESS', () => {
	/** Every tool name the server registers, whatever the caller may see. */
	function registeredToolNames(): string[] {
		const server = createSwarmMcpServer(at('instanceAdmin', true));
		const registered = (server as unknown as { _registeredTools: Record<string, unknown> })
			._registeredTools;
		return Object.keys(registered).sort();
	}

	// A new tool without an entry would be served to instance admins only; a stale
	// entry would document a tool that no longer exists.
	it('has exactly one entry per registered tool', () => {
		expect(Object.keys(TOOL_ACCESS).sort()).toEqual(registeredToolNames());
	});

	// Issue #1385: a scoped agent credential reaches every read tool and the recovery
	// allowlist, and no other write tool.
	it('marks exactly the read tools and the recovery allowlist agentScoped', () => {
		const server = createSwarmMcpServer(at('instanceAdmin', true));
		const registered = (
			server as unknown as {
				_registeredTools: Record<string, { annotations?: { readOnlyHint?: boolean } }>;
			}
		)._registeredTools;
		const expected = Object.entries(registered)
			.filter(
				([name, tool]) =>
					tool.annotations?.readOnlyHint === true ||
					(SCOPED_AGENT_RECOVERY_TOOLS as readonly string[]).includes(name),
			)
			.map(([name]) => name)
			.sort();
		const scoped = Object.entries(TOOL_ACCESS)
			.filter(([, access]) => access.agentScoped)
			.map(([name]) => name)
			.sort();

		expect(scoped).toEqual(expected);
		for (const name of SCOPED_AGENT_RECOVERY_TOOLS) expect(registered, name).toHaveProperty(name);
		expect(DEFAULT_TOOL_ACCESS.agentScoped).toBe(false);
	});

	it('never asks for more than an instance admin or less than a signed-in user', () => {
		for (const [name, access] of Object.entries(TOOL_ACCESS)) {
			expect(ORDER, name).toContain(access.minRole);
			// Instance-admin-only is the default; an entry exists to say something else.
			expect(access.minRole, name).not.toBe('instanceAdmin');
		}
	});
});
