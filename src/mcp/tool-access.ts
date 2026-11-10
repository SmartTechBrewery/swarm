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
 * **A scoped agent credential sees a fixed subset** (issue #1385). A request made
 * with an agent access token limited to some projects is shown, and may call, only
 * the tools marked `agentScoped` — every read tool plus the recovery writes in
 * `SCOPED_AGENT_RECOVERY_TOOLS` (`../identity/agent-access-token.ts`) — and only
 * those its ceiling, computed from the holder's roles on the scoped projects
 * alone, reaches. Any other tool is refused `FORBIDDEN` (audited, for a write
 * tool), whatever the holder's own role.
 *
 * **Default-deny.** A tool with no entry is shown to, and callable by,
 * installation administrators only — never by a scoped agent credential — so a
 * tool registered without deciding its role cannot reach anyone else. `tests/unit/mcp/tool-access.test.ts` fails on a
 * registered tool with no entry, and on an entry naming no registered tool.
 */

import { TRPCError } from '@trpc/server';

import { type ProjectRole, projectRoleRank } from '../identity/membership.js';
import { listProjectsForUser } from '../identity/membership-service.js';
import {
	agentScopeOf,
	isInstanceAdmin,
	type SwarmUser,
	scopeUserToProjects,
} from '../identity/schema.js';

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
	/**
	 * Whether a scoped agent credential (issue #1385) may list and call the tool:
	 * `true` for every read tool and the writes in `SCOPED_AGENT_RECOVERY_TOOLS`,
	 * `false` for every other tool.
	 */
	agentScoped: boolean;
}

/**
 * What a tool with no {@link TOOL_ACCESS} entry gets: instance administrators
 * only, and never a scoped agent credential.
 */
export const DEFAULT_TOOL_ACCESS: ToolAccess = {
	minRole: 'instanceAdmin',
	scope: 'none',
	agentScoped: false,
};

/**
 * Every operator MCP tool's required role and scope — the role is the one its
 * dashboard procedure already enforces (`../api/authz.ts`), never a new decision
 * about the procedure itself — and whether a scoped agent credential may use it.
 * Keep `docs/mcp.md` "Who may use each tool" and "Scoped agent credentials" in step.
 */
export const TOOL_ACCESS: Readonly<Record<string, ToolAccess>> = {
	// Reads of a project and its runs — `canReadProject`, the contributor floor.
	runs_list: { minRole: 'contributor', scope: 'accessible-projects', agentScoped: true },
	run_get: { minRole: 'contributor', scope: 'project', agentScoped: true },
	pipeline_snapshot: { minRole: 'contributor', scope: 'project', agentScoped: true },
	dispatch_history: { minRole: 'contributor', scope: 'project', agentScoped: true },
	pr_status: { minRole: 'contributor', scope: 'project', agentScoped: true },
	pipeline_stats: { minRole: 'contributor', scope: 'project', agentScoped: true },
	phase_agents_get: { minRole: 'contributor', scope: 'project', agentScoped: true },
	consistency_check: { minRole: 'contributor', scope: 'project', agentScoped: true },
	project_get: { minRole: 'contributor', scope: 'project', agentScoped: true },
	// A project's workers and log lines for a contributor; the unscoped,
	// installation-wide view stays `assertInstanceAdmin`'s.
	workers_state: { minRole: 'contributor', scope: 'project-or-installation', agentScoped: true },
	cli_rate_limits: { minRole: 'contributor', scope: 'project-or-installation', agentScoped: true },
	control_plane_logs: {
		minRole: 'contributor',
		scope: 'project-or-installation',
		agentScoped: true,
	},
	// Reads behind the project's admin-only setup screens (board mapping, readiness).
	pm_board_discover: { minRole: 'projectAdmin', scope: 'project', agentScoped: true },
	project_readiness: { minRole: 'projectAdmin', scope: 'project', agentScoped: true },
	// Driving a project's runs — `canWriteProject`, the member floor.
	run_reset: { minRole: 'member', scope: 'project', agentScoped: true },
	dispatch_redispatch_now: { minRole: 'member', scope: 'project', agentScoped: true },
	pr_force_re_review: { minRole: 'member', scope: 'project', agentScoped: true },
	pr_recheck_mergeability: { minRole: 'member', scope: 'project', agentScoped: true },
	dependency_waits_wake: { minRole: 'member', scope: 'project', agentScoped: true },
	work_item_close: { minRole: 'member', scope: 'project', agentScoped: false },
	// Administering a project's configuration and credentials — `canAdministerProject`.
	phase_agents_reorder: { minRole: 'projectAdmin', scope: 'project', agentScoped: false },
	phase_agents_restore: { minRole: 'projectAdmin', scope: 'project', agentScoped: false },
	project_update: { minRole: 'projectAdmin', scope: 'project', agentScoped: false },
	pm_board_set: { minRole: 'projectAdmin', scope: 'project', agentScoped: false },
	project_credential_set: { minRole: 'projectAdmin', scope: 'project', agentScoped: false },
	// A worker's own owner may block its CLI, as on the Workers screen: a resource
	// gate, not a project role.
	cli_rate_limit_set: { minRole: 'signedIn', scope: 'worker-owner', agentScoped: false },
	// The New Project dialog is open to any signed-in user; the creator becomes its admin.
	project_create: { minRole: 'signedIn', scope: 'none', agentScoped: false },
	// SWARM's own bug reports (issue #1383): read at `contributor`, written at `member`
	// on the report's project; an installation-wide report is an instance admin's. An
	// agent may file and add occurrences; triage stays the holder's own.
	bug_reports_list: { minRole: 'contributor', scope: 'accessible-projects', agentScoped: true },
	bug_report_get: { minRole: 'contributor', scope: 'project', agentScoped: true },
	bug_report_create: { minRole: 'member', scope: 'project-or-installation', agentScoped: true },
	bug_report_add_occurrence: {
		minRole: 'member',
		scope: 'project-or-installation',
		agentScoped: true,
	},
	bug_report_set_status: {
		minRole: 'member',
		scope: 'project-or-installation',
		agentScoped: false,
	},
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
 *
 * A scoped agent credential's user (issue #1385) never reaches `instanceAdmin`:
 * its ceiling is `projectAdmin` for an administrator holder — what they hold on
 * every project in the scope — and otherwise the holder's highest role on the
 * scoped projects alone, so a role held elsewhere lifts nothing.
 */
export async function mcpCeilingFor(user: SwarmUser): Promise<McpCeiling> {
	const scope = agentScopeOf(user);
	if (scope?.holderInstanceAdmin) return 'projectAdmin';
	if (!scope && isInstanceAdmin(user)) return 'instanceAdmin';
	let ceiling: McpCeiling = 'signedIn';
	for (const { projectId, role } of await listProjectsForUser(user.id)) {
		if (scope && !scope.projectIds.includes(projectId)) continue;
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
 * Which credential an MCP request was made with (issue #1385): `user` for a
 * `swarm login` session or an ordinary agent access token — both act with the
 * account's full access — and `scoped-agent-token` for an agent access token
 * limited to `projectIds`. Recorded on every write tool's audit row.
 *
 * A **run-bound** scoped credential (issue #1393) also carries the `runId` it was
 * minted for and its `maxWriteActions` cap; with them, the write-tool framework
 * enforces the per-run guardrails (`./write-tool.ts`). Both are absent for a
 * scoped credential a holder issued.
 */
export type McpCredential =
	| { kind: 'user' }
	| {
			kind: 'scoped-agent-token';
			tokenId: string;
			projectIds: readonly string[];
			runId?: string;
			maxWriteActions?: number;
	  };

/** What binds a scoped agent credential to one run (issue #1393). */
export interface RunBinding {
	runId: string;
	maxWriteActions: number;
}

/** Who an MCP request acts as, and with which credential. */
export interface McpPrincipal {
	/**
	 * The user every tool authorizes as — for a scoped agent credential, the holder
	 * limited to its projects (`scopeUserToProjects`, `../identity/schema.ts`).
	 */
	user: SwarmUser;
	credential: McpCredential;
}

/** The principal of a session or an ordinary agent access token: the user, unlimited. */
export function userPrincipal(user: SwarmUser): McpPrincipal {
	return { user, credential: { kind: 'user' } };
}

/**
 * The principal of a scoped agent credential: `holder` limited to `projectIds`,
 * with the token's id kept for the audit trail — and, for a run-bound credential,
 * its {@link RunBinding}. The one place both halves are built, so the user's
 * project limit and the credential it came from cannot drift.
 */
export function scopedAgentPrincipal(
	holder: SwarmUser,
	tokenId: string,
	projectIds: readonly string[],
	run?: RunBinding,
): McpPrincipal {
	return {
		user: scopeUserToProjects(holder, projectIds),
		credential: {
			kind: 'scoped-agent-token',
			tokenId,
			projectIds: [...projectIds],
			...(run ? { runId: run.runId, maxWriteActions: run.maxWriteActions } : {}),
		},
	};
}

/**
 * What every tool is registered with for one MCP request: the principal its bearer
 * resolved to, and that user's {@link McpCeiling}, read once for the request.
 */
export interface ToolContext extends McpPrincipal {
	ceiling: McpCeiling;
}

/**
 * Whether `context` is a scoped agent credential's — read from the credential and,
 * failing closed, from a project limit on the user as well.
 */
function isScopedAgent(context: Pick<ToolContext, 'user' | 'credential'>): boolean {
	return (
		context.credential.kind === 'scoped-agent-token' || agentScopeOf(context.user) !== undefined
	);
}

/** Whether `tools/list` shows tool `name` to `context` (`./server.ts`). */
export function toolListedFor(name: string, context: ToolContext): boolean {
	const access = toolAccessFor(name);
	if (isScopedAgent(context) && !access.agentScoped) return false;
	return ceilingReaches(context.ceiling, access.minRole);
}

/**
 * Throw `FORBIDDEN` unless `context` may call tool `name`: a scoped agent
 * credential only an `agentScoped` tool, and anyone only a tool their ceiling
 * reaches. The refusal names the credential or the role the tool needs and nothing
 * about any project, so it reveals nothing the caller could not read from this
 * table.
 */
export function assertToolAccess(name: string, context: ToolContext): void {
	const { minRole, agentScoped } = toolAccessFor(name);
	if (isScopedAgent(context) && !agentScoped) {
		throw new TRPCError({
			code: 'FORBIDDEN',
			message: `Tool "${name}" is not available to a scoped agent credential.`,
		});
	}
	if (ceilingReaches(context.ceiling, minRole)) return;
	throw new TRPCError({
		code: 'FORBIDDEN',
		message: `Tool "${name}" needs ${ROLE_WORDING[minRole]}, which you do not hold.`,
	});
}
