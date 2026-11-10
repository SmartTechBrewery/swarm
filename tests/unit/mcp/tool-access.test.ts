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

import type { ProjectRole } from '@/identity/membership.js';
import type { SwarmUser } from '@/identity/schema.js';
import { createSwarmMcpServer } from '@/mcp/server.js';
import {
	assertToolAccess,
	ceilingReaches,
	DEFAULT_TOOL_ACCESS,
	type McpCeiling,
	mcpCeilingFor,
	TOOL_ACCESS,
	toolAccessFor,
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
});

describe('toolAccessFor and assertToolAccess', () => {
	it('default-denies a tool with no entry to everyone below an instance admin', () => {
		expect(toolAccessFor('a_tool_nobody_decided')).toEqual(DEFAULT_TOOL_ACCESS);
		expect(DEFAULT_TOOL_ACCESS.minRole).toBe('instanceAdmin');
		// An inherited object key is not an entry.
		expect(toolAccessFor('constructor')).toEqual(DEFAULT_TOOL_ACCESS);
		expect(() => assertToolAccess('a_tool_nobody_decided', 'projectAdmin')).toThrow(TRPCError);
		expect(() => assertToolAccess('a_tool_nobody_decided', 'instanceAdmin')).not.toThrow();
	});

	it("refuses a caller below a listed tool's role with FORBIDDEN naming the role", () => {
		let thrown: unknown;
		try {
			assertToolAccess('project_update', 'member');
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(TRPCError);
		expect((thrown as TRPCError).code).toBe('FORBIDDEN');
		expect((thrown as TRPCError).message).toBe(
			'Tool "project_update" needs the projectAdmin role on some project, which you do not hold.',
		);
		expect(() => assertToolAccess('project_update', 'projectAdmin')).not.toThrow();
	});
});

describe('TOOL_ACCESS', () => {
	/** Every tool name the server registers, whatever the caller may see. */
	function registeredToolNames(): string[] {
		const server = createSwarmMcpServer({ user: user(true), ceiling: 'instanceAdmin' });
		const registered = (server as unknown as { _registeredTools: Record<string, unknown> })
			._registeredTools;
		return Object.keys(registered).sort();
	}

	// A new tool without an entry would be served to instance admins only; a stale
	// entry would document a tool that no longer exists.
	it('has exactly one entry per registered tool', () => {
		expect(Object.keys(TOOL_ACCESS).sort()).toEqual(registeredToolNames());
	});

	it('never asks for more than an instance admin or less than a signed-in user', () => {
		for (const [name, access] of Object.entries(TOOL_ACCESS)) {
			expect(ORDER, name).toContain(access.minRole);
			// Instance-admin-only is the default; an entry exists to say something else.
			expect(access.minRole, name).not.toBe('instanceAdmin');
		}
	});
});
