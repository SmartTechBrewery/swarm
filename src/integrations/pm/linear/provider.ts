/**
 * LinearPMProvider — the concrete `PMProvider` (`src/pm/types.ts`) for Linear.
 * This phase lands the **read half** plus discovery: the board reads the pipeline
 * needs to resolve the card that triggered a phase, and the `containers`/`states`
 * enumeration the board-mapping screen builds a mapping from. The writes and the
 * dependency gate arrive with the next phase, which is why nothing registers a
 * Linear manifest yet (ai/RULES.md §2 "Register when the contract is satisfied,
 * not when the folder appears" — the sequencing GitLab's #295 used).
 *
 * Every operation is GraphQL: Linear has no REST surface at all, so unlike the
 * GitHub Projects provider there is no second protocol to keep straight. Every
 * field name, argument and `IssueFilter` key in the documents below was verified
 * against the live schema at https://api.linear.app/graphql rather than inferred.
 *
 * Credentials are never passed in: each method runs its work inside
 * `withLinearProjectCredentials(this.project, …)`, so `linearGraphQL` picks the
 * API key up off the async scope (`./credentials.ts`, `./client.ts`).
 *
 * A **container is a Linear team** and the board mapping's `statusOptions` values
 * are that team's workflow-state UUIDs (`./config-schema.ts`): workflow states
 * belong to teams, so the team is the smallest scope whose states are a complete
 * mapping.
 */

import type { ProjectConfig } from '../../../config/schema.js';
import type {
	ContainerDiscoveryResult,
	CreateWorkItemInput,
	DiscoveredContainer,
	DiscoveredState,
	ListWorkItemsFilter,
	PMDiscoveryArgs,
	PMDiscoveryCapability,
	PMDiscoveryResult,
	PMProvider,
	PMType,
	StateDiscoveryResult,
	UpdateWorkItemPatch,
	WorkItem,
	WorkItemArtifact,
	WorkItemAssignee,
	WorkItemBlocker,
	WorkItemLabel,
} from '../../../pm/types.js';
import { collectLinearConnection, type LinearConnection, linearGraphQL } from './client.js';
import { type LinearIntegrationConfig, requireLinearConfig } from './config-schema.js';
import { withLinearProjectCredentials } from './credentials.js';
import { requireStateIdForStatusKey, resolveStatusKeyByStateId } from './status-mapping.js';

/**
 * The issue fields every read below selects, so one card maps the same way
 * whichever query found it.
 *
 * `team { id }` is not part of `WorkItem` — it scopes the one lookup Linear
 * offers no team filter for (`attachmentsForURL`, see
 * {@link LinearPMProvider.findWorkItemForArtifact}). The label page size is
 * deliberately generous, as on the GitHub side: `WorkItem.labels` drives the
 * automation gate (ai/ARCHITECTURE.md "Automation opt-in gate"), so a label
 * truncated off the end of the page would read as "not opted in" and silently
 * halt the pipeline. Linear's `state.type` is not selected — see
 * {@link LinearPMProvider.discoverStates} for why it has nowhere to go.
 */
const ISSUE_FIELDS = /* GraphQL */ `
	id
	title
	description
	url
	createdAt
	updatedAt
	team { id }
	state { id name }
	attachments(first: 100) { nodes { url } }
	labels(first: 100) { nodes { id name color } }
	assignee { id name displayName }
`;

/** Read one issue by its UUID. `issue(id:)` takes a `String!`, not an `ID!`. */
const GET_ISSUE_QUERY = /* GraphQL */ `
	query GetIssue($id: String!) {
		issue(id: $id) { ${ISSUE_FIELDS} }
	}
`;

/**
 * One page of the top-level `issues` connection under a caller-supplied
 * `IssueFilter`. Every list-shaped read shares this one document because they
 * differ only in that filter — the board read narrows by team and optionally
 * workflow state.
 */
const LIST_ISSUES_QUERY = /* GraphQL */ `
	query ListIssues($filter: IssueFilter, $cursor: String) {
		issues(filter: $filter, first: 100, after: $cursor) {
			pageInfo { hasNextPage endCursor }
			nodes { ${ISSUE_FIELDS} }
		}
	}
`;

/**
 * The issues Linear has attached a given external URL to. This is how a Linear
 * card learns about a GitHub pull request: Linear's own GitHub integration
 * records the PR as an attachment on the issue.
 */
const ATTACHMENTS_FOR_URL_QUERY = /* GraphQL */ `
	query AttachmentsForUrl($url: String!) {
		attachmentsForURL(url: $url, first: 50) {
			nodes { id issue { ${ISSUE_FIELDS} } }
		}
	}
`;

/** One page of the teams the API key can see — the selectable containers. */
const TEAMS_QUERY = /* GraphQL */ `
	query Teams($cursor: String) {
		teams(first: 100, after: $cursor) {
			pageInfo { hasNextPage endCursor }
			nodes { id name }
		}
	}
`;

/** One page of one team's workflow states — the states a mapping is built from. */
const TEAM_STATES_QUERY = /* GraphQL */ `
	query TeamStates($teamId: String!, $cursor: String) {
		team(id: $teamId) {
			id
			states(first: 100, after: $cursor) {
				pageInfo { hasNextPage endCursor }
				nodes { id name position }
			}
		}
	}
`;

/** The shape {@link ISSUE_FIELDS} selects. Every field is optional defensively. */
interface IssueNode {
	id?: string;
	title?: string;
	description?: string | null;
	url?: string;
	createdAt?: string;
	updatedAt?: string;
	team?: { id?: string } | null;
	state?: { id?: string; name?: string } | null;
	attachments?: { nodes?: Array<{ url?: string } | null> | null } | null;
	labels?: { nodes?: Array<{ id?: string; name?: string; color?: string | null } | null> | null };
	assignee?: { id?: string; name?: string | null; displayName?: string | null } | null;
}

interface GetIssueResponse {
	issue?: IssueNode | null;
}

interface ListIssuesResponse {
	issues?: LinearConnection<IssueNode> | null;
}

interface AttachmentsForUrlResponse {
	attachmentsForURL?: { nodes?: Array<{ id?: string; issue?: IssueNode | null } | null> | null };
}

interface TeamNode {
	id?: string;
	name?: string;
}

interface TeamsResponse {
	teams?: LinearConnection<TeamNode> | null;
}

interface StateNode {
	id?: string;
	name?: string;
	position?: number;
}

interface TeamStatesResponse {
	team?: { id?: string; states?: LinearConnection<StateNode> | null } | null;
}

/** The `IssueFilter` variable shape the read queries take. */
interface IssueFilterVariable {
	team: { id: { eq: string } };
	state?: { id: { eq: string } };
}

function mapLabels(issue: IssueNode): WorkItemLabel[] {
	const nodes = issue.labels?.nodes ?? [];
	return nodes
		.filter((node): node is { id: string; name: string; color?: string | null } =>
			Boolean(node?.id && node.name),
		)
		.map((node) => ({ id: node.id, name: node.name, color: node.color ?? undefined }));
}

/**
 * Map the issue's assignee onto the provider-neutral array. Linear models exactly
 * one assignee per issue, so this is `[]` or a single element — the shared shape
 * doesn't change, only how many entries it can hold.
 *
 * Linear draws the two names the other way round from GitHub: `displayName` is
 * the short unique handle SWARM's identity link matches on
 * (`src/identity/assignee-resolver.ts`), and `name` is the person's full name. So
 * `handle` ← `displayName` and `displayName` ← `name`.
 */
function mapAssignees(issue: IssueNode): WorkItemAssignee[] {
	const assignee = issue.assignee;
	if (!assignee?.displayName) return [];
	return [
		{
			handle: assignee.displayName,
			displayName: assignee.name || undefined,
			providerId: assignee.id,
		},
	];
}

/**
 * Map a Linear issue onto a `WorkItem`. `config` is needed for exactly one thing:
 * translating the opaque workflow-state UUID into the canonical `statusKey`
 * shared code resolves a pipeline phase from, so no caller inverts
 * `statusOptions` itself (ai/RULES.md §2).
 *
 * `taskRef` comes only from a GitHub issue or pull-request attachment in this
 * project's repository. A Linear-native number would name an unrelated GitHub
 * issue in the PR closing keyword, so an unlinked card leaves it unset and cannot
 * start an SCM-driven phase (ai/ARCHITECTURE.md "Task identity").
 */
function toWorkItem(
	issue: IssueNode & { id: string },
	config: LinearIntegrationConfig,
	repository: string,
): WorkItem {
	const stateId = issue.state?.id;
	return {
		id: issue.id,
		title: issue.title ?? '',
		description: issue.description ?? '',
		url: issue.url ?? '',
		taskRef: taskRefFromAttachments(issue, repository),
		status: issue.state?.name,
		statusId: stateId,
		statusKey: stateId === undefined ? undefined : resolveStatusKeyByStateId(config, stateId),
		labels: mapLabels(issue),
		assignees: mapAssignees(issue),
		createdAt: issue.createdAt,
		updatedAt: issue.updatedAt,
	};
}

function taskRefFromAttachments(issue: IssueNode, repository: string): string | undefined {
	const artifactUrl = new RegExp(
		`^https://github\\.com/${escapeRegExp(repository)}/(?:issues|pull)/(\\d+)(?:[/?#]|$)`,
	);
	for (const attachment of issue.attachments?.nodes ?? []) {
		const match = attachment?.url?.match(artifactUrl);
		if (match) return match[1];
	}
	return undefined;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Reduce discovered teams to stable picker options: keep only nodes carrying both
 * an id and a name, deduplicate by id, and sort by name (case-insensitive) so the
 * picker order doesn't jump between refreshes. No `url` — a Linear team has no web
 * URL of its own, and `DiscoveredContainer.url` is optional for exactly this case.
 */
function normalizeContainers(teams: TeamNode[]): DiscoveredContainer[] {
	const byId = new Map<string, DiscoveredContainer>();
	for (const team of teams) {
		if (!team.id || !team.name) continue;
		if (byId.has(team.id)) continue;
		byId.set(team.id, { id: team.id, name: team.name });
	}
	return [...byId.values()].sort((a, b) =>
		a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
	);
}

export class LinearPMProvider implements PMProvider {
	readonly type: PMType = 'linear';

	// Linear issues carry an assignee natively (`Issue.assignee`), so every item
	// this provider maps reports it — at most one, which `mapAssignees` folds into
	// the shared array shape.
	readonly supportsAssignees = true;

	// Linear models cross-issue prerequisites natively, as an issue relation of
	// type `blocks`/`blockedBy`, so this provider claims the dependency capability
	// and callers keep the dependency gate rather than falling back to the
	// human-readable comment guard.
	readonly supportsDependencies = true;

	/**
	 * This project's board mapping, narrowed out of the `pm` union once at
	 * construction instead of at each read — the only place this provider asserts
	 * which union member it was built for (issue #495).
	 */
	private readonly config: LinearIntegrationConfig;

	constructor(private readonly project: ProjectConfig) {
		this.config = requireLinearConfig(project);
	}

	/** Run `fn` with this project's Linear API key bound to scope. */
	private run<T>(fn: () => Promise<T>): Promise<T> {
		return withLinearProjectCredentials(this.project, fn);
	}

	/** An `IssueFilter` scoped to this project's team, optionally narrowed further. */
	private issueFilter(extra: { stateId?: string } = {}): IssueFilterVariable {
		return {
			team: { id: { eq: this.config.teamId } },
			...(extra.stateId === undefined ? {} : { state: { id: { eq: extra.stateId } } }),
		};
	}

	/** Walk every page of the `issues` connection under `filter`. Runs inside a credential scope. */
	private async collectIssues(
		filter: IssueFilterVariable,
	): Promise<Array<IssueNode & { id: string }>> {
		const issues = await collectLinearConnection<IssueNode>(async (cursor) => {
			const data = await linearGraphQL<ListIssuesResponse>(LIST_ISSUES_QUERY, { filter, cursor });
			return data.issues ?? null;
		});
		return issues.filter((issue): issue is IssueNode & { id: string } => Boolean(issue?.id));
	}

	async getWorkItem(id: string): Promise<WorkItem> {
		return this.run(async () => {
			const data = await linearGraphQL<GetIssueResponse>(GET_ISSUE_QUERY, { id });
			const issue = data.issue;
			// A non-resolving id is bad input, not a soft miss: it came from a webhook
			// or a prior board read (ai/CODING_STANDARDS.md "Error handling"). Linear
			// types `issue` non-null and answers an unknown id with a GraphQL error,
			// which `linearGraphQL` already throws — this covers the partial-data case
			// and states the contract at the seam that owns it.
			if (!issue?.id) {
				throw new Error(`Linear issue '${id}' did not resolve`);
			}
			return toWorkItem({ ...issue, id: issue.id }, this.config, this.project.repo);
		});
	}

	async listWorkItems(filter?: ListWorkItemsFilter): Promise<WorkItem[]> {
		// Resolve the canonical key to this team's workflow-state UUID *before* the
		// read. An unmapped status is a config/logic error, not "match everything":
		// omitting the state filter would silently return the whole board, so
		// `requireStateIdForStatusKey` fails loudly, exactly as GitHub Projects'
		// `listWorkItems` does (ai/CODING_STANDARDS.md "Error handling").
		const stateId =
			filter?.status === undefined
				? undefined
				: requireStateIdForStatusKey(this.config, filter.status);
		return this.run(async () => {
			// Filtering is server-side here, unlike the GitHub Projects provider:
			// `IssueFilter` narrows by team *and* workflow state, so a status-filtered
			// read doesn't page the whole board to discard most of it.
			const issues = await this.collectIssues(this.issueFilter({ stateId }));
			return issues.map((issue) => toWorkItem(issue, this.config, this.project.repo));
		});
	}

	async findWorkItemByUrlSuffix(urlSuffix: string): Promise<WorkItem | undefined> {
		// Linear exposes no filter on an issue's own `url`, so the match runs
		// client-side over the same paged team read `listWorkItems` walks.
		//
		// SWARM's only caller passes a GitHub-shaped `/issues/<n>` suffix — the
		// documented legacy fallback in `src/pipeline/respond-to-review.ts`, used only
		// for a pull request with no recorded card (ai/ARCHITECTURE.md "Task
		// identity"). A Linear issue's URL is a `linear.app/<workspace>/issue/<KEY>`
		// path, which never ends with that, so for those pre-existing PRs this
		// honestly resolves nothing; a Linear board reports through SWARM's own
		// durable `runs.work_item_id` link instead, which is provider-neutral.
		const items = await this.listWorkItems();
		return items.find((item) => item.url.endsWith(urlSuffix));
	}

	async findWorkItemForArtifact({
		repository,
		kind,
		number,
	}: WorkItemArtifact): Promise<WorkItem | undefined> {
		// Linear records its GitHub linkage as an attachment, whether it points to an
		// issue or a pull request. A workspace without that integration simply has no
		// card for the artifact, and the caller falls open.
		const path = kind === 'issue' ? 'issues' : 'pull';
		const url = `https://github.com/${repository}/${path}/${number}`;
		return this.run(async () => {
			const data = await linearGraphQL<AttachmentsForUrlResponse>(ATTACHMENTS_FOR_URL_QUERY, {
				url,
			});
			// `attachmentsForURL` is workspace-wide, with no team argument — scope the
			// match to the team this project maps to, or another team's card for the same
			// PR would come back as this board's.
			const attached = (data.attachmentsForURL?.nodes ?? []).find(
				(node) => node?.issue?.id && node.issue.team?.id === this.config.teamId,
			);
			const issue = attached?.issue;
			return issue?.id
				? toWorkItem({ ...issue, id: issue.id }, this.config, this.project.repo)
				: undefined;
		});
	}

	// ---------------------------------------------------------------------------
	// The write half plus the dependency reads land in the next phase. Each one
	// throws the generic **not-implemented sentinel inline**, on purpose and
	// verbatim: the PM conformance suite scans each contract method's own source
	// for that wording (`tests/unit/integrations/pm/pm-conformance.test.ts`), so
	// registering this provider before the stubs are gone fails that suite instead
	// of shipping a board that silently can't be written to. Do not factor these
	// into a shared helper — hiding the phrase behind a call would defeat the gate,
	// which is the only thing making a half-built provider safe (ai/RULES.md §2,
	// ai/TESTING.md "A provider under construction registers nothing").
	// ---------------------------------------------------------------------------

	async moveWorkItem(id: string, status: string): Promise<void> {
		throw new Error(
			`moveWorkItem is not implemented for the Linear PM provider (item '${id}' → '${status}')`,
		);
	}

	async addComment(id: string, text: string): Promise<string> {
		throw new Error(
			`addComment is not implemented for the Linear PM provider (item '${id}', ${text.length} chars)`,
		);
	}

	async findComment(id: string, marker: string): Promise<string | undefined> {
		throw new Error(
			`findComment is not implemented for the Linear PM provider (item '${id}', marker '${marker}')`,
		);
	}

	async createWorkItem(input: CreateWorkItemInput): Promise<WorkItem> {
		throw new Error(
			`createWorkItem is not implemented for the Linear PM provider (title '${input.title}')`,
		);
	}

	async updateWorkItem(id: string, patch: UpdateWorkItemPatch): Promise<void> {
		throw new Error(
			`updateWorkItem is not implemented for the Linear PM provider (item '${id}', fields ${Object.keys(patch).join(', ')})`,
		);
	}

	async addLabel(id: string, name: string): Promise<void> {
		throw new Error(
			`addLabel is not implemented for the Linear PM provider (item '${id}', label '${name}')`,
		);
	}

	async listBlockers(id: string): Promise<WorkItemBlocker[]> {
		throw new Error(`listBlockers is not implemented for the Linear PM provider (item '${id}')`);
	}

	async addBlockedBy(id: string, blockerId: string): Promise<void> {
		throw new Error(
			`addBlockedBy is not implemented for the Linear PM provider (item '${id}' blocked by '${blockerId}')`,
		);
	}

	async discover<C extends PMDiscoveryCapability>(
		capability: C,
		args: PMDiscoveryArgs[C],
	): Promise<PMDiscoveryResult[C]> {
		switch (capability) {
			case 'containers':
				return (await this.discoverContainers()) as PMDiscoveryResult[C];
			case 'states':
				return (await this.discoverStates(args.containerId)) as PMDiscoveryResult[C];
			default:
				// Unreachable for a declared capability (the union is exhaustive), but a
				// runtime guard keeps a future capability from silently no-op'ing.
				throw new Error(`Linear does not support discovery capability '${capability}'`);
		}
	}

	/**
	 * Enumerate the Linear teams the API key can see — the containers a board
	 * mapping is scoped to. `teams` already returns only teams whose issues the key
	 * has access to, so there is no second path to union in the way GitHub's
	 * viewer-plus-orgs discovery needs.
	 */
	private async discoverContainers(): Promise<ContainerDiscoveryResult> {
		return this.run(async () => {
			const teams = await collectLinearConnection<TeamNode>(async (cursor) => {
				const data = await linearGraphQL<TeamsResponse>(TEAMS_QUERY, { cursor });
				return data.teams ?? null;
			});
			return { containers: normalizeContainers(teams) };
		});
	}

	/**
	 * Discover one team's workflow states, ordered by Linear's own `position` (the
	 * order the team sees them in) with the name as a tiebreak so the picker is
	 * stable. Throws an actionable error when the team doesn't resolve or has no
	 * states to map.
	 *
	 * Returns **no** `providerContext`: a Linear state's UUID is the whole mapping,
	 * so there is no extra scope to thread back — that field exists for GitHub
	 * Projects' `statusFieldId`. Linear's state `type` (`backlog`, `started`,
	 * `completed`, …) would be a useful picker hint, but `DiscoveredState` carries
	 * only `id` and `name`, so it has nowhere to go and is not even selected.
	 */
	private async discoverStates(containerId: string): Promise<StateDiscoveryResult> {
		return this.run(async () => {
			let resolved = false;
			const nodes = await collectLinearConnection<StateNode>(async (cursor) => {
				const data = await linearGraphQL<TeamStatesResponse>(TEAM_STATES_QUERY, {
					teamId: containerId,
					cursor,
				});
				const team = data.team;
				if (!team?.id) return null;
				resolved = true;
				return team.states ?? null;
			});
			if (!resolved) {
				throw new Error(`Linear team '${containerId}' did not resolve`);
			}
			const states: DiscoveredState[] = nodes
				.filter((node): node is StateNode & { id: string; name: string } =>
					Boolean(node.id && node.name),
				)
				// A node without a `position` sorts last rather than to the front, so a
				// partial response degrades to "unknown order at the end".
				.sort(
					(a, b) =>
						(a.position ?? Number.POSITIVE_INFINITY) - (b.position ?? Number.POSITIVE_INFINITY) ||
						a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
				)
				.map((node) => ({ id: node.id, name: node.name }));
			if (states.length === 0) {
				throw new Error(`Linear team '${containerId}' has no workflow states to map`);
			}
			return { states };
		});
	}
}

/**
 * Build the Linear PM provider for a project. The one construction seam callers
 * use, so they depend on the `PMProvider` interface rather than the concrete
 * class — and, once a manifest exists, what `createProvider` points at.
 */
export function createLinearProvider(project: ProjectConfig): PMProvider {
	return new LinearPMProvider(project);
}
