/**
 * **Who may use each operator MCP tool** (issue #1382) — the one table that
 * decides which tools a caller is shown and which they may call, now that
 * `/operator/mcp` is open to every signed-in user rather than to installation
 * administrators only.
 *
 * Two layers, deliberately separate:
 *
 *  - **The tool's role, here.** {@link TOOL_ACCESS} gives every tool the least
 *    role its dashboard procedure requires anywhere (`minRole`). A caller whose
 *    *ceiling* — their highest role, see {@link mcpCeilingFor} — is below it is
 *    not shown the tool in `tools/list` (`./server.ts`), and a direct call is
 *    refused with `FORBIDDEN` before the tool does anything (a write tool still
 *    writes its audit row, settled `refused`: `./write-tool.ts`).
 *  - **The project, in the procedure.** Passing the table says only that the
 *    caller holds that role *somewhere*. Every call is still authorized per
 *    project by the dashboard procedure the tool wraps (`./tool-helpers.ts`), so a
 *    `projectAdmin` of one project reaches nothing of another, and a project the
 *    caller is not a member of reads as `NOT_FOUND`. `scope` records which kind of
 *    per-call check that is; it is documentation, never enforcement.
 *
 * **Default-deny.** A tool with no entry is shown to, and callable by,
 * installation administrators only, so a tool registered without deciding its
 * role cannot reach anyone else. `tests/unit/mcp/tool-access.test.ts` fails on a
 * registered tool with no entry, and on an entry naming no registered tool.
 */

import { TRPCError } from '@trpc/server';

import { type ProjectRole, projectRoleRank } from '../identity/membership.js';
import { listProjectsForUser } from '../identity/membership-service.js';
import { isInstanceAdmin, type SwarmUser } from '../identity/schema.js';

/**
 * The most a caller may do on the MCP server: `instanceAdmin` for an installation
 * administrator, otherwise their highest project role, or `signedIn` when they
 * hold no membership at all.
 */
export type McpCeiling = 'signedIn' | ProjectRole | 'instanceAdmin';

/** The least {@link McpCeiling} a tool needs to be listed and called. */
export type ToolMinRole = McpCeiling;

/**
 * How the wrapped procedure scopes a call (documentary — see the module comment):
 *
 *  - `accessible-projects` — results are filtered to every project the caller may
 *    read (all of them for an instance administrator).
 *  - `project` — the call names one project (directly or through its run), and a
 *    project the caller is not a member of reads as `NOT_FOUND`.
 *  - `project-or-installation` — as `project` when a project is named; with none,
 *    the installation-wide view, which is instance administrators' only (`FORBIDDEN`).
 *  - `worker-owner` — the target is a worker machine, and only its owner or an
 *    instance administrator may act on it; anyone else gets `NOT_FOUND`.
 *  - `none` — the call reads or acts on nothing that already exists.
 */
export type ToolScope =
	| 'accessible-projects'
	| 'project'
	| 'project-or-installation'
	| 'worker-owner'
	| 'none';

export interface ToolAccess {
	minRole: ToolMinRole;
	scope: ToolScope;
}

/** What a tool with no {@link TOOL_ACCESS} entry gets: instance administrators only. */
export const DEFAULT_TOOL_ACCESS: ToolAccess = { minRole: 'instanceAdmin', scope: 'none' };

/**
 * Every operator MCP tool's required role and scope — the role is the one its
 * dashboard procedure already enforces (`../api/authz.ts`), never a new decision
 * about the procedure itself. Keep `docs/mcp.md` "Who may use each tool" in step.
 */
export const TOOL_ACCESS: Readonly<Record<string, ToolAccess>> = {
	// Reads of a project and its runs — `canReadProject`, the contributor floor.
	runs_list: { minRole: 'contributor', scope: 'accessible-projects' },
	run_get: { minRole: 'contributor', scope: 'project' },
	pipeline_snapshot: { minRole: 'contributor', scope: 'project' },
	dispatch_history: { minRole: 'contributor', scope: 'project' },
	pr_status: { minRole: 'contributor', scope: 'project' },
	pipeline_stats: { minRole: 'contributor', scope: 'project' },
	phase_agents_get: { minRole: 'contributor', scope: 'project' },
	consistency_check: { minRole: 'contributor', scope: 'project' },
	project_get: { minRole: 'contributor', scope: 'project' },
	// A project's workers and log lines for a contributor; the unscoped,
	// installation-wide view stays `assertInstanceAdmin`'s.
	workers_state: { minRole: 'contributor', scope: 'project-or-installation' },
	cli_rate_limits: { minRole: 'contributor', scope: 'project-or-installation' },
	control_plane_logs: { minRole: 'contributor', scope: 'project-or-installation' },
	// Reads behind the project's admin-only setup screens (board mapping, readiness).
	pm_board_discover: { minRole: 'projectAdmin', scope: 'project' },
	project_readiness: { minRole: 'projectAdmin', scope: 'project' },
	// Driving a project's runs — `canWriteProject`, the member floor.
	run_reset: { minRole: 'member', scope: 'project' },
	dispatch_redispatch_now: { minRole: 'member', scope: 'project' },
	pr_force_re_review: { minRole: 'member', scope: 'project' },
	pr_recheck_mergeability: { minRole: 'member', scope: 'project' },
	dependency_waits_wake: { minRole: 'member', scope: 'project' },
	work_item_close: { minRole: 'member', scope: 'project' },
	// Administering a project's configuration and credentials — `canAdministerProject`.
	phase_agents_reorder: { minRole: 'projectAdmin', scope: 'project' },
	phase_agents_restore: { minRole: 'projectAdmin', scope: 'project' },
	project_update: { minRole: 'projectAdmin', scope: 'project' },
	pm_board_set: { minRole: 'projectAdmin', scope: 'project' },
	project_credential_set: { minRole: 'projectAdmin', scope: 'project' },
	// A worker's own owner may block its CLI, as on the Workers screen: a resource
	// gate, not a project role.
	cli_rate_limit_set: { minRole: 'signedIn', scope: 'worker-owner' },
	// The New Project dialog is open to any signed-in user; the creator becomes its admin.
	project_create: { minRole: 'signedIn', scope: 'none' },
};

/** `name`'s entry in {@link TOOL_ACCESS}, or {@link DEFAULT_TOOL_ACCESS} when it has none. */
export function toolAccessFor(name: string): ToolAccess {
	return Object.hasOwn(TOOL_ACCESS, name) ? TOOL_ACCESS[name] : DEFAULT_TOOL_ACCESS;
}

/** Privilege order of a ceiling; the project roles keep `projectRoleRank`'s order. */
function ceilingRank(ceiling: McpCeiling): number {
	if (ceiling === 'signedIn') return 0;
	if (ceiling === 'instanceAdmin') return Number.MAX_SAFE_INTEGER;
	return projectRoleRank(ceiling) + 1;
}

/** Whether a caller at `ceiling` may list and call a tool needing `minRole`. */
export function ceilingReaches(ceiling: McpCeiling, minRole: ToolMinRole): boolean {
	return ceilingRank(ceiling) >= ceilingRank(minRole);
}

/**
 * `user`'s {@link McpCeiling}: `instanceAdmin` for an installation administrator
 * (no membership read), otherwise their highest role across every project
 * membership, or `signedIn` when they hold none. Read once per MCP request.
 */
export async function mcpCeilingFor(user: SwarmUser): Promise<McpCeiling> {
	if (isInstanceAdmin(user)) return 'instanceAdmin';
	let ceiling: McpCeiling = 'signedIn';
	for (const { role } of await listProjectsForUser(user.id)) {
		if (ceilingRank(role) > ceilingRank(ceiling)) ceiling = role;
	}
	return ceiling;
}

/** How a required role reads in a refusal. */
const ROLE_WORDING: Record<ToolMinRole, string> = {
	signedIn: 'a signed-in session',
	contributor: 'at least the contributor role on some project',
	member: 'at least the member role on some project',
	projectAdmin: 'the projectAdmin role on some project',
	instanceAdmin: 'installation administrator rights',
};

/**
 * Throw `FORBIDDEN` unless a caller at `ceiling` may call tool `name`. The refusal
 * names the role the tool needs and nothing about any project, so it reveals
 * nothing the caller could not read from this table.
 */
export function assertToolAccess(name: string, ceiling: McpCeiling): void {
	const { minRole } = toolAccessFor(name);
	if (ceilingReaches(ceiling, minRole)) return;
	throw new TRPCError({
		code: 'FORBIDDEN',
		message: `Tool "${name}" needs ${ROLE_WORDING[minRole]}, which you do not hold.`,
	});
}

/**
 * What every tool is registered with for one MCP request: the user its bearer
 * resolved to, and that user's {@link McpCeiling}, read once for the request.
 */
export interface ToolContext {
	user: SwarmUser;
	ceiling: McpCeiling;
}
