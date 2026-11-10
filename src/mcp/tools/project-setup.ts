/**
 * The operator MCP server's project set-up tools (issue #1359): what an agent needs to
 * create a SWARM project and bring it to a state where the pipeline can run, with the
 * dashboard's own validation and roles.
 *
 * Reads — `project_get` (the whole configuration, credentials as configured/not
 * configured only), `pm_board_discover` (the board-mapping screen's discovery) and
 * `project_readiness` (what is still missing, item by item).
 *
 * Writes, each through the audited write-tool framework (`../write-tool.ts`) — a
 * mandatory `reason`, a `dryRun`, an `operator_actions` row — and each wrapping the
 * dashboard procedure the matching screen calls:
 *
 *  - `project_create` → `projects.create` (New Project dialog), any signed-in user, who
 *    becomes the project's `projectAdmin`. Dry run: `projects.previewCreate`.
 *  - `project_update` → `projects.update` (Repositories, Agents, Pipeline tabs),
 *    `projectAdmin`. Dry run: `projects.previewUpdate`.
 *  - `pm_board_set` → `projects.update` with a `pm` member (Project Management tab's
 *    board mapping), `projectAdmin`. Dry run: `projects.previewUpdate`.
 *  - `project_credential_set` → `projects.credentials.set` / `setPm` (Source Control and
 *    Project Management tabs' credentials), `projectAdmin`. Dry run:
 *    `projects.credentials.previewSet` / `previewSetPm`.
 *
 * **Secrets go in, never out.** `project_create`'s `reviewerToken` and
 * `project_credential_set`'s `value` are declared `secretInputs`, so the audit row
 * records them as `[redacted]`; no procedure called here returns one, and no tool
 * result or log line carries one.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { ProjectCreateInputSchema, ProjectUpdateInputSchema } from '../../api/routers/projects.js';
import { ProjectPmSchema } from '../../config/schema.js';
import { PmProviderIdSchema } from '../../pm/events.js';
import { PM_STATUS_KEYS } from '../../pm/pipeline.js';
import { PM_TYPES, type PMType } from '../../pm/types.js';
import type { ToolContext } from '../tool-access.js';
import { callerFor, runTool, type SwarmCaller } from '../tool-helpers.js';
import { registerWriteTool } from '../write-tool.js';

const projectIdInput = z.string().min(1).describe('The project id.');

const create = ProjectCreateInputSchema.shape;
const projectCreateInput = {
	id: create.id.describe('The new project id: a stable slug, unique on the installation.'),
	name: create.name.describe('The display name.'),
	repositories: create.repositories.describe(
		'The repositories, at least one, each `{ repo, baseBranch?, branchPrefix?, ... }` exactly as ' +
			'`swarm.config.json` states them. `repo` is the provider coordinate: `owner/repo` on GitHub, ' +
			'Bitbucket and GitLab, `organization/project/repository` on Azure DevOps. A repository ' +
			'another project already owns is refused.',
	),
	scm: create.scm.describe(
		'The SCM provider: `github` (default), `bitbucket`, `gitlab` or `azure-devops`.',
	),
	repoRoot: create.repoRoot.describe(
		"Where the repository is checked out on a worker (the config's `repoRoot`).",
	),
	worktreeRoot: create.worktreeRoot,
	visibility: create.visibility.describe(
		'`private` (default; members only) or `discoverable` (others may ask to join).',
	),
	agents: create.agents.describe(
		"Optional per-phase agent configuration, as `swarm.config.json`'s `agents`: each phase " +
			'(`planning`, `implementation`, `implementationUnplanned`, `review`, `respondToReview`, ' +
			'`respondToCi`, `resolveConflicts`) takes `targets` — `{ cli, model?, reasoning? }` in ' +
			'priority order — plus `timeoutMs` and `prompt`. Omitted phases run on coded defaults.',
	),
	pipeline: create.pipeline.describe(
		"Optional pipeline options, as `swarm.config.json`'s `pipeline` (planning, review, " +
			'respondToReview, respondToCi, continuation budgets, …).',
	),
	worktreeRetention: create.worktreeRetention,
	reviewerToken: create.reviewerToken.describe(
		"SECRET, optional. The project's reviewer credential for its SCM provider. Omit to seed the " +
			"installation's default. Stored encrypted, never returned, and recorded as `[redacted]` in the audit trail.",
	),
};

const update = ProjectUpdateInputSchema.shape;
const projectUpdateInput = {
	projectId: projectIdInput,
	name: update.name.describe('A new display name.'),
	repositories: update.repositories.describe(
		'The **whole** new repository list (it replaces the stored one), in the same shape as ' +
			'`project_create` takes. Read the current list with `project_get` first.',
	),
	scm: update.scm.describe('A new SCM provider.'),
	repoRoot: update.repoRoot,
	worktreeRoot: update.worktreeRoot,
	visibility: update.visibility.describe('`private` or `discoverable`.'),
	agents: update.agents.describe(
		'The **whole** new `agents` block (it replaces the stored one): per phase, `targets` in ' +
			'priority order, `timeoutMs` and `prompt`. Read the current one with `project_get` first.',
	),
	pipeline: update.pipeline.describe(
		'A pipeline **patch**, merged over the stored options section by section; ' +
			'`maxContinuations: null` clears the budget back to its default.',
	),
	worktreeRetention: update.worktreeRetention,
};

const pmBoardSetInput = {
	projectId: projectIdInput,
	pm: ProjectPmSchema.describe(
		'The whole board mapping, as one `pm` member: `type` and its board — ' +
			'`github-projects`: `{ projectId, statusFieldId, statusOptions }` (`statusFieldId` is ' +
			"`pm_board_discover`'s `providerContext.statusFieldId`); `linear`: `{ teamId, statusOptions }`; " +
			'`jira`: `{ baseUrl, projectKey, statusOptions, repositoryField? }`; `trello`: ' +
			"`{ boardId, statusOptions }`. `statusOptions` maps SWARM's status keys (`backlog`, `planning`, " +
			'`todo` — shown as Ready —, `inProgress`, `inReview`, `done`) to discovered state ids; map ' +
			'all six. Switching provider needs its required credentials stored first.',
	),
};

const credentialSetInput = {
	projectId: projectIdInput,
	side: z
		.enum(['scm', 'pm'])
		.describe(
			'`scm` for a source-control credential (roles `reviewer`, `webhookSecret`), `pm` for a ' +
				'board credential (roles the PM provider declares, e.g. `apiToken` for GitHub Projects).',
		),
	providerId: z
		.string()
		.min(1)
		.optional()
		.describe(
			'The provider the credential belongs to. Defaults to the one the project runs on; name ' +
				'another to enter its credentials before switching to it.',
		),
	role: z
		.string()
		.min(1)
		.describe('The credential role, as `project_get` lists it under `credentials`.'),
	value: z
		.string()
		.min(1)
		.describe(
			'SECRET. The credential itself. Stored encrypted, never returned by any tool, and ' +
				'recorded as `[redacted]` in the audit trail.',
		),
};

const pmBoardDiscoverInput = {
	projectId: projectIdInput,
	providerId: z
		.string()
		.min(1)
		.optional()
		.describe(
			'The PM provider to discover against (`github-projects`, `linear`, `jira`, `trello`). ' +
				'Defaults to the one the project runs on.',
		),
	containerId: z
		.string()
		.min(1)
		.optional()
		.describe(
			"A board id from a previous call's `containers`. Omit to list the boards; give it to list " +
				"that board's states.",
		),
	discoveryDraft: z
		.record(z.string(), z.string())
		.optional()
		.describe(
			'Provider set-up needed before discovery, e.g. `{ "baseUrl": "https://acme.atlassian.net" }` for Jira.',
		),
};

type CredentialSetArgs = {
	projectId: string;
	side: 'scm' | 'pm';
	providerId?: string;
	role: string;
	value: string;
};

/**
 * The SCM provider a credential write addresses: the one named, else the one the project
 * runs on — `credentials.set` requires one, the PM side defaults by itself.
 */
async function scmProviderFor(caller: SwarmCaller, input: CredentialSetArgs): Promise<string> {
	if (input.providerId) return input.providerId;
	const project = await caller.projects.getById({ id: input.projectId });
	if (!project.scm) {
		throw new TRPCError({
			code: 'BAD_REQUEST',
			message: 'The project names no SCM provider; pass `providerId`.',
		});
	}
	return project.scm;
}

/** The PM provider id as the credential procedures type it, refused unless it names one. */
function pmProviderId(providerId: string | undefined): PMType | undefined {
	if (providerId === undefined) return undefined;
	const parsed = PmProviderIdSchema.safeParse(providerId);
	if (!parsed.success) {
		throw new TRPCError({
			code: 'BAD_REQUEST',
			message: `Unknown PM provider '${providerId}'. Use one of: ${PM_TYPES.join(', ')}.`,
		});
	}
	return parsed.data;
}

/** Register the project set-up tools on `server`, authorizing (and auditing writes) as `context`'s user. */
export function registerProjectSetupTools(server: McpServer, context: ToolContext): void {
	server.registerTool(
		'project_get',
		{
			title: "Read a project's configuration",
			description:
				"Read-only. A project's whole configuration as the dashboard stores it (`projects.getById`): " +
				'id, name, repositories, SCM provider, visibility, board mapping (`pm`), per-phase agents, ' +
				'pipeline options and credential references (store key names, never values) — plus, ' +
				'under `credentials`, each SCM and PM credential role with whether it is configured. No ' +
				'secret is ever returned. Needs contributor access to the project.',
			inputSchema: { projectId: projectIdInput },
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		({ projectId }) =>
			runTool(context, 'project_get', async () => {
				const caller = callerFor(context.user);
				const project = await caller.projects.getById({ id: projectId });
				const [scm, pm] = await Promise.all([
					caller.projects.credentials.list({ projectId }),
					caller.projects.credentials.listPm({ projectId }),
				]);
				return { project, credentials: { scm, pm } };
			}),
	);

	server.registerTool(
		'pm_board_discover',
		{
			title: "Discover a project's PM boards and their states",
			description:
				"Read-only. The Project Management tab's discovery, run server-side with the project's " +
				'own board credential (store it first with `project_credential_set`, side `pm`). ' +
				'Without `containerId`: the boards the credential can see, as `{ providers, containers }`. ' +
				"With one: that board's states, as `{ containerId, states, providerContext, statusKeys }`, " +
				"where `statusKeys` are SWARM's six keys to map each state to with `pm_board_set`. Needs " +
				'`projectAdmin`.',
			inputSchema: pmBoardDiscoverInput,
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		({ projectId, providerId, containerId, discoveryDraft }) =>
			runTool(context, 'pm_board_discover', async () => {
				const caller = callerFor(context.user);
				const provider = pmProviderId(providerId);
				if (containerId) {
					const result = await caller.pm.discoverStates({
						projectId,
						containerId,
						providerId: provider,
						discoveryDraft,
					});
					return { containerId, ...result, statusKeys: [...PM_STATUS_KEYS] };
				}
				const [providers, result] = await Promise.all([
					caller.pm.listProviders({ projectId }),
					caller.pm.discoverContainers({ projectId, providerId: provider, discoveryDraft }),
				]);
				return { providers, ...result };
			}),
	);

	server.registerTool(
		'project_readiness',
		{
			title: 'Check whether a project can run',
			description:
				'Read-only. Reports, item by item, whether the project can run and what is missing ' +
				'(`projects.readiness`), as `{ projectId, ready, checkedAt, items }`. Each item has an ' +
				'`area` (`scm`, `pm`, `webhooks`, `workers`, `members`), what was checked, a `status` — ' +
				'`ok`, `missing` (blocks the pipeline) or `unverified` (SWARM cannot read it back, such ' +
				"as a webhook registered in the provider's UI) — and a `detail` naming the fix. It " +
				"reads each repository with the project's reviewer credential and the board's states " +
				'with its board credential. `ready` is true when nothing is `missing`. Needs `projectAdmin`.',
			inputSchema: { projectId: projectIdInput },
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		({ projectId }) =>
			runTool(context, 'project_readiness', () =>
				callerFor(context.user).projects.readiness({ projectId }),
			),
	);

	registerWriteTool(server, context, {
		name: 'project_create',
		title: 'Create a project',
		description:
			"WRITE. Creates a project as the dashboard's New Project dialog does (`projects.create`), " +
			'with the same validation: repository coordinates checked against the SCM provider, a ' +
			"reviewer credential required (the `reviewerToken` given, or the installation's default), " +
			'and a duplicate project id or repository refused with `CONFLICT`. You become its ' +
			'`projectAdmin`. The board starts on a placeholder mapping, so the project cannot run until ' +
			'`pm_board_set`; use `project_readiness` to see what is left. Any signed-in user may create ' +
			'a project. Requires a `reason`; pass `dryRun: true` first to see the record it would ' +
			'write and `wouldRefuse`.',
		inputSchema: projectCreateInput,
		destructive: false,
		secretInputs: ['reviewerToken'],
		targetOf: (input) => input.id,
		preview: async ({ reviewerToken, ...input }, caller) => {
			// Only the token's presence: the dry run reports its source, never its value.
			const plan = await caller.projects.previewCreate({
				...input,
				hasReviewerToken: reviewerToken !== undefined,
			});
			return { projectId: plan.wouldRefuse ? null : input.id, plan };
		},
		apply: (input, caller) => caller.projects.create(input),
	});

	registerWriteTool(server, context, {
		name: 'project_update',
		title: "Update a project's configuration",
		description:
			"WRITE. Changes a project's configuration as the dashboard's Repositories, Agents and " +
			'Pipeline tabs do (`projects.update`), through the same rules: each field given replaces ' +
			'the stored one (`pipeline` is merged as a patch), repository coordinates are checked ' +
			'against the SCM provider, and a repository another project owns is refused with ' +
			'`CONFLICT`. The board mapping is `pm_board_set`, credentials `project_credential_set`. ' +
			'Needs `projectAdmin`. Requires a `reason`; pass `dryRun: true` first to see `before`, ' +
			'`after`, `changedFields` and `wouldRefuse`.',
		inputSchema: projectUpdateInput,
		destructive: false,
		targetOf: (input) => input.projectId,
		preview: async ({ projectId, ...fields }, caller) => ({
			projectId,
			plan: await caller.projects.previewUpdate({ ...fields, id: projectId }),
		}),
		apply: ({ projectId, ...fields }, caller) =>
			caller.projects.update({ ...fields, id: projectId }),
	});

	registerWriteTool(server, context, {
		name: 'pm_board_set',
		title: "Connect a project's PM board and map its statuses",
		description:
			"WRITE. Saves the project's board and its status mapping, as the Project Management tab's " +
			'Save does (`projects.update` with `pm`), replacing the creation-time placeholder. Find ' +
			'the board and its state ids with `pm_board_discover`. Moving to another provider is ' +
			"refused until that provider's required credentials are stored. Needs `projectAdmin`. " +
			'Requires a `reason`; pass `dryRun: true` first to see `before`, `after` and `wouldRefuse`.',
		inputSchema: pmBoardSetInput,
		destructive: false,
		targetOf: (input) => input.projectId,
		preview: async ({ projectId, pm }, caller) => ({
			projectId,
			plan: await caller.projects.previewUpdate({ id: projectId, pm }),
		}),
		apply: ({ projectId, pm }, caller) => caller.projects.update({ id: projectId, pm }),
	});

	registerWriteTool(server, context, {
		name: 'project_credential_set',
		title: "Set or replace a project's credential",
		description:
			"WRITE. Stores one project credential, as the Source Control and Project Management tabs' " +
			'credential fields do (`projects.credentials.set` / `setPm`): `side: "scm"` with role ' +
			'`reviewer` or `webhookSecret`, or `side: "pm"` with a role the PM provider declares ' +
			'(`project_get` lists them). Replaces a stored value. The secret is accepted as input only: it ' +
			'is never returned and the audit trail records `[redacted]`. A PM role that is the ' +
			"repository's shared credential (GitHub Projects' webhook secret) is refused — set it on " +
			'side `scm`. Needs `projectAdmin`. Requires a `reason`; pass `dryRun: true` first to see ' +
			'which store key it lands on and whether it would `set` or `replace`.',
		inputSchema: credentialSetInput,
		destructive: true,
		secretInputs: ['value'],
		targetOf: (input) => `${input.projectId}:${input.side}:${input.role}`,
		preview: async (input, caller) => {
			const plan =
				input.side === 'scm'
					? await caller.projects.credentials.previewSet({
							projectId: input.projectId,
							providerId: await scmProviderFor(caller, input),
							role: input.role,
						})
					: await caller.projects.credentials.previewSetPm({
							projectId: input.projectId,
							providerId: pmProviderId(input.providerId),
							role: input.role,
						});
			return { projectId: input.projectId, plan };
		},
		apply: async (input, caller) => {
			if (input.side === 'scm') {
				await caller.projects.credentials.set({
					projectId: input.projectId,
					providerId: await scmProviderFor(caller, input),
					role: input.role,
					value: input.value,
				});
			} else {
				await caller.projects.credentials.setPm({
					projectId: input.projectId,
					providerId: pmProviderId(input.providerId),
					role: input.role,
					value: input.value,
				});
			}
			return { projectId: input.projectId, side: input.side, role: input.role, stored: true };
		},
	});
}
