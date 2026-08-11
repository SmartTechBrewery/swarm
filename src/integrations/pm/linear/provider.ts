/**
 * LinearPMProvider — the concrete `PMProvider` (`src/pm/types.ts`) for Linear.
 * Every method of the contract is now real: the board reads and discovery the
 * previous phase landed, plus the writes (status transition, comment, issue
 * create/update, label) and the dependency gate (`listBlockers`/`addBlockedBy`).
 * Registration still waits on the ingress adapter and the manifest — a provider
 * registers only once nothing about it is a stub, and the reverse is not true
 * (ai/RULES.md §2 "Register when the contract is satisfied, not when the folder
 * appears" — the sequencing GitLab's #295 used).
 *
 * Every operation is GraphQL: Linear has no REST surface at all, so unlike the
 * GitHub Projects provider there is no second protocol to keep straight. Every
 * field name, argument, mutation, payload field and `IssueFilter` key in the
 * documents below was verified against the live schema at
 * https://api.linear.app/graphql rather than inferred.
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
import { logger } from '../../../lib/logger.js';
import {
	dedupeBlockers,
	dependencyProse,
	findDependencyReferences,
} from '../../../pm/dependencies.js';
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
	WorkItemDependent,
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
 * halt the pipeline. Attachments use the same generous page size: the original
 * GitHub issue link supplies `taskRef`, and missing it would make the phase
 * dispatcher log-and-skip an otherwise linked card. Linear's `state.type` is
 * not selected — see {@link LinearPMProvider.discoverStates} for why it has
 * nowhere to go.
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

/**
 * The fields a {@link WorkItemBlocker} is built from — a much narrower selection
 * than {@link ISSUE_FIELDS}, because a blocker only has to be named in a message
 * and answered "still open?".
 *
 * `identifier` (`SWARM-491`) is Linear's own human-readable reference and the one
 * a person would search for; `number` backs the `#N` form the shared prose
 * heuristic speaks. `state { type }` is the open/closed signal: Linear has no
 * boolean, only the state's category.
 */
const BLOCKER_ISSUE_FIELDS = /* GraphQL */ `
	id
	identifier
	number
	title
	url
	state { type }
`;

/** One page of an issue's comments — id and body are all a marker scan needs. */
const ISSUE_COMMENTS_QUERY = /* GraphQL */ `
	query IssueComments($id: String!, $cursor: String) {
		issue(id: $id) {
			id
			comments(first: 100, after: $cursor) {
				pageInfo { hasNextPage endCursor }
				nodes { id body }
			}
		}
	}
`;

/**
 * The free text a prose-declared prerequisite can hide in — the issue's own
 * description plus its comments — together with the issue's `number` so a
 * self-reference can be dropped.
 */
const ISSUE_DEPENDENCY_PROSE_QUERY = /* GraphQL */ `
	query IssueDependencyProse($id: String!) {
		issue(id: $id) {
			id
			number
			description
			comments(first: 100) { nodes { body } }
		}
	}
`;

/**
 * One page of the relations *pointing at* this issue. See
 * {@link LinearPMProvider.fetchNativeBlockers} for why "who blocks me" is
 * `inverseRelations` rather than `relations`.
 */
const ISSUE_BLOCKING_RELATIONS_QUERY = /* GraphQL */ `
	query IssueBlockingRelations($id: String!, $cursor: String) {
		issue(id: $id) {
			id
			inverseRelations(first: 100, after: $cursor) {
				pageInfo { hasNextPage endCursor }
				nodes { type issue { ${BLOCKER_ISSUE_FIELDS} } }
			}
		}
	}
`;

/**
 * One page of the relations this issue *is the source of* — the exact mirror of
 * {@link ISSUE_BLOCKING_RELATIONS_QUERY}, selecting `relations` where that selects
 * `inverseRelations`, and reading the relation's `relatedIssue` target where that
 * reads its `issue` source. See {@link LinearPMProvider.listDependents}.
 *
 * Both names were verified against the live schema, per this file's header rule:
 * `Issue.relations` is an `IssueRelationConnection!` alongside `inverseRelations`,
 * and `IssueRelation` carries `issue: Issue!` and `relatedIssue: Issue!`.
 */
const ISSUE_DEPENDENT_RELATIONS_QUERY = /* GraphQL */ `
	query IssueDependentRelations($id: String!, $cursor: String) {
		issue(id: $id) {
			id
			relations(first: 100, after: $cursor) {
				pageInfo { hasNextPage endCursor }
				nodes { type relatedIssue { ${BLOCKER_ISSUE_FIELDS} } }
			}
		}
	}
`;

/** The one issue in this team carrying a given number, for resolving a `#N` mention. */
const ISSUE_BY_NUMBER_QUERY = /* GraphQL */ `
	query IssueByNumber($filter: IssueFilter) {
		issues(filter: $filter, first: 1) {
			nodes { ${BLOCKER_ISSUE_FIELDS} }
		}
	}
`;

/** One page of the workspace's labels carrying a given name (see {@link LinearPMProvider.findLabelId}). */
const FIND_LABELS_QUERY = /* GraphQL */ `
	query FindIssueLabels($name: String!, $cursor: String) {
		issueLabels(filter: { name: { eqIgnoreCase: $name } }, first: 100, after: $cursor) {
			pageInfo { hasNextPage endCursor }
			nodes { id name team { id } }
		}
	}
`;

/** The labels currently attached to one issue — the idempotence check for `addLabel`. */
const ISSUE_LABELS_QUERY = /* GraphQL */ `
	query IssueLabels($id: String!) {
		issue(id: $id) {
			id
			labels(first: 100) { nodes { id name } }
		}
	}
`;

/**
 * The one mutation behind every field write: a status transition is
 * `input: { stateId }`, a re-scope is `input: { title, description }`.
 */
const UPDATE_ISSUE_MUTATION = /* GraphQL */ `
	mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
		issueUpdate(id: $id, input: $input) { success }
	}
`;

/** Create an issue, reading the whole card back so it maps like any board read. */
const CREATE_ISSUE_MUTATION = /* GraphQL */ `
	mutation CreateIssue($input: IssueCreateInput!) {
		issueCreate(input: $input) {
			success
			issue { ${ISSUE_FIELDS} }
		}
	}
`;

/** Post a comment on an issue. */
const CREATE_COMMENT_MUTATION = /* GraphQL */ `
	mutation CreateComment($input: CommentCreateInput!) {
		commentCreate(input: $input) {
			success
			comment { id }
		}
	}
`;

/** Create a team label. Linear rejects a name the team (or workspace) already uses. */
const CREATE_LABEL_MUTATION = /* GraphQL */ `
	mutation CreateIssueLabel($input: IssueLabelCreateInput!) {
		issueLabelCreate(input: $input) {
			success
			issueLabel { id name }
		}
	}
`;

/** Attach one existing label to an issue — a set insert, not a whole-list write. */
const ADD_LABEL_MUTATION = /* GraphQL */ `
	mutation AddIssueLabel($id: String!, $labelId: String!) {
		issueAddLabel(id: $id, labelId: $labelId) { success }
	}
`;

/** Record one issue relation. See {@link LinearPMProvider.addBlockedBy} for the direction. */
const CREATE_RELATION_MUTATION = /* GraphQL */ `
	mutation CreateIssueRelation($input: IssueRelationCreateInput!) {
		issueRelationCreate(input: $input) { success }
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

/** The blocker-shaped subset of an issue that {@link BLOCKER_ISSUE_FIELDS} selects. */
interface BlockerIssueNode {
	id?: string;
	identifier?: string;
	number?: number;
	title?: string;
	url?: string;
	state?: { type?: string } | null;
}

interface CommentNode {
	id?: string;
	body?: string;
}

interface IssueCommentsResponse {
	issue?: { comments?: LinearConnection<CommentNode> | null } | null;
}

interface IssueDependencyProseResponse {
	issue?: {
		number?: number;
		description?: string | null;
		comments?: { nodes?: Array<{ body?: string } | null> | null } | null;
	} | null;
}

interface RelationNode {
	type?: string;
	issue?: BlockerIssueNode | null;
	relatedIssue?: BlockerIssueNode | null;
}

interface IssueBlockingRelationsResponse {
	issue?: { inverseRelations?: LinearConnection<RelationNode> | null } | null;
}

interface IssueDependentRelationsResponse {
	issue?: { relations?: LinearConnection<RelationNode> | null } | null;
}

interface BlockerIssuesResponse {
	issues?: { nodes?: Array<BlockerIssueNode | null> | null } | null;
}

interface LabelNode {
	id?: string;
	name?: string;
	team?: { id?: string } | null;
}

interface FindLabelsResponse {
	issueLabels?: LinearConnection<LabelNode> | null;
}

interface IssueLabelsResponse {
	issue?: { labels?: { nodes?: Array<{ id?: string; name?: string } | null> | null } } | null;
}

interface IssueUpdateResponse {
	issueUpdate?: { success?: boolean } | null;
}

interface IssueCreateResponse {
	issueCreate?: { success?: boolean; issue?: IssueNode | null } | null;
}

interface CommentCreateResponse {
	commentCreate?: { success?: boolean; comment?: { id?: string } | null } | null;
}

interface IssueLabelCreateResponse {
	issueLabelCreate?: { success?: boolean; issueLabel?: { id?: string } | null } | null;
}

interface IssueAddLabelResponse {
	issueAddLabel?: { success?: boolean } | null;
}

interface IssueRelationCreateResponse {
	issueRelationCreate?: { success?: boolean } | null;
}

/** The `IssueFilter` variable shape the read queries take. */
interface IssueFilterVariable {
	team: { id: { eq: string } };
	state?: { id: { eq: string } };
	number?: { eq: number };
	description?: { contains: string };
}

/**
 * The relation type that models a prerequisite. `IssueRelationType` also carries
 * `duplicate`/`related`/`similar`, which are not dependencies — and on the *read*
 * side `IssueRelation.type` is a plain `String`, so those arrive alongside and
 * have to be filtered out rather than excluded by the schema.
 */
const BLOCKS_RELATION_TYPE = 'blocks';

/**
 * The Linear workflow-state categories that mean an issue is finished, and so no
 * longer gates dependent work. Every other category (`triage`, `backlog`,
 * `unstarted`, `started`) leaves the blocker open.
 */
const CLOSED_STATE_TYPES = new Set(['completed', 'canceled']);

/** Map a Linear issue — a native relation's or a resolved mention's — to a provider-neutral blocker. */
function toBlocker(issue: BlockerIssueNode, source: WorkItemBlocker['source']): WorkItemBlocker {
	return {
		id: issue.id,
		// Linear's `identifier` is what a person sees and searches for; the `#N` form
		// is the fallback for a partial response, matching how the mention was written.
		reference: issue.identifier || (issue.number == null ? (issue.url ?? '?') : `#${issue.number}`),
		url: issue.url ?? '',
		title: issue.title ?? '',
		open: !CLOSED_STATE_TYPES.has(issue.state?.type ?? ''),
		source,
	};
}

/**
 * Map a Linear issue this one blocks onto a dependent — the same fields
 * {@link toBlocker} builds minus `source`, since the reverse read has only one
 * (`src/pm/types.ts`). `reference`/`url` are derived identically on purpose: they
 * are the identity the shared cycle check matches a blocker against.
 */
function toDependent(issue: BlockerIssueNode): WorkItemDependent {
	return {
		id: issue.id,
		reference: issue.identifier || (issue.number == null ? (issue.url ?? '?') : `#${issue.number}`),
		url: issue.url ?? '',
		title: issue.title ?? '',
		open: !CLOSED_STATE_TYPES.has(issue.state?.type ?? ''),
	};
}

/**
 * Fail on a mutation Linear answered without an error but without accepting
 * either. Every write payload carries `success`, and a falsy one means the write
 * did not happen — silently returning would report a move or a label that a human
 * would then not find on the board (ai/CODING_STANDARDS.md "Error handling").
 */
function requireMutationSuccess(success: boolean | undefined, operation: string): void {
	if (!success) {
		throw new Error(`Linear rejected the request to ${operation}`);
	}
}

/**
 * Whether an error is Linear refusing to create a second label with a name the
 * workspace already uses. The phrase is Linear's own — Cascade's `createLabel`
 * matches the same one against the live API (`src/linear/client.ts` there) — and
 * `linearGraphQL` surfaces a GraphQL error as its joined message text, so the
 * message is what there is to match on.
 */
function isDuplicateLabelNameError(error: unknown): boolean {
	return error instanceof Error && /duplicate label name/i.test(error.message);
}

/**
 * Whether an error is Linear refusing a relation it already holds. Narrower than
 * a blanket catch, and only a backstop: {@link LinearPMProvider.addBlockedBy}
 * makes itself idempotent by reading the existing relations first, so this
 * catches only the window between that read and the write. Unlike the label
 * phrase above, this wording could not be confirmed against a live workspace, so
 * anything it does not match is rethrown.
 */
function isDuplicateRelationError(error: unknown): boolean {
	return error instanceof Error && /duplicate|already (?:exists|related)/i.test(error.message);
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
 * `taskRef` comes only from a GitHub issue attachment in this project's
 * repository. A pull-request attachment is an artifact link, not a task id, so
 * it cannot replace the issue link when a card has both. A Linear-native number
 * would name an unrelated GitHub issue in the PR closing keyword, so an unlinked
 * card leaves it unset and cannot start an SCM-driven phase (ai/ARCHITECTURE.md
 * "Task identity").
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
		`^https://github\\.com/${escapeRegExp(repository)}/issues/(\\d+)(?:[/?#]|$)`,
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
	private issueFilter(
		extra: { stateId?: string; number?: number; descriptionContains?: string } = {},
	): IssueFilterVariable {
		return {
			team: { id: { eq: this.config.teamId } },
			...(extra.stateId === undefined ? {} : { state: { id: { eq: extra.stateId } } }),
			...(extra.number === undefined ? {} : { number: { eq: extra.number } }),
			...(extra.descriptionContains === undefined
				? {}
				: { description: { contains: extra.descriptionContains } }),
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

	async findWorkItemByDescriptionMarker(marker: string): Promise<WorkItem | undefined> {
		return this.run(async () => {
			// Server-side, unlike GitHub Projects' client-side scan of a whole board
			// read: `IssueFilter.description` takes a case-sensitive `contains`, which
			// is the same narrowing the team/state filters use.
			//
			// A *filter over the issues themselves*, deliberately, and not Linear's
			// `searchIssues` — the caller is Planning's retried split, and a child
			// created seconds ago has to be findable now or the guard silently
			// duplicates it, which an eventually-consistent search index cannot
			// promise. Callers pass a marker at most one item can carry, so the first
			// match is the match.
			const issues = await this.collectIssues(this.issueFilter({ descriptionContains: marker }));
			const issue = issues[0];
			return issue ? toWorkItem(issue, this.config, this.project.repo) : undefined;
		});
	}

	async moveWorkItem(id: string, status: string): Promise<void> {
		// Resolve the canonical key before the write: a status the board mapping
		// can't resolve is a config/logic error, not a value to send blindly — the
		// same fail-loud contract `listWorkItems` and GitHub Projects' `moveWorkItem`
		// keep (ai/CODING_STANDARDS.md "Error handling").
		const stateId = requireStateIdForStatusKey(this.config, status);
		await this.run(async () => {
			const data = await linearGraphQL<IssueUpdateResponse>(UPDATE_ISSUE_MUTATION, {
				id,
				input: { stateId },
			});
			requireMutationSuccess(data.issueUpdate?.success, `move item '${id}' to '${status}'`);
		});
		logger.debug('pm: moved work item', { itemId: id, status });
	}

	async addComment(id: string, text: string): Promise<string> {
		// Unlike GitHub Projects — whose board card has no comment thread, so the
		// comment is redirected onto the backing Issue — a Linear issue *is* the
		// card, and the comment lands natively on it. There is no backing artifact
		// to resolve first, and no draft-item case that leaves nowhere to post.
		return this.run(async () => {
			const data = await linearGraphQL<CommentCreateResponse>(CREATE_COMMENT_MUTATION, {
				input: { issueId: id, body: text },
			});
			const commentId = data.commentCreate?.comment?.id;
			if (!data.commentCreate?.success || !commentId) {
				throw new Error(`Linear rejected the request to comment on item '${id}'`);
			}
			return commentId;
		});
	}

	async findComment(id: string, marker: string): Promise<string | undefined> {
		return this.run(async () => {
			// Every page, not just the first: an earlier delivery's marker can sit
			// beyond page 1, and missing it would post a duplicate on a retry — the
			// same reason GitHub Projects paginates its own comment scan. Substring
			// match, because the marker lives at the comment's tail, not its start.
			const comments = await collectLinearConnection<CommentNode>(async (cursor) => {
				const data = await linearGraphQL<IssueCommentsResponse>(ISSUE_COMMENTS_QUERY, {
					id,
					cursor,
				});
				return data.issue?.comments ?? null;
			});
			return comments.find((comment) => comment.id && comment.body?.includes(marker))?.id;
		});
	}

	async createWorkItem(input: CreateWorkItemInput): Promise<WorkItem> {
		const stateId = requireStateIdForStatusKey(this.config, input.status);
		const labels = input.labels ?? [];
		return this.run(async () => {
			// `IssueCreateInput` takes label *ids*, so every name has to be resolved
			// (and created when the workspace has none) before the issue exists.
			const labelIds: string[] = [];
			for (const name of labels) {
				labelIds.push(await this.ensureLabelId(name));
			}
			const data = await linearGraphQL<IssueCreateResponse>(CREATE_ISSUE_MUTATION, {
				input: {
					teamId: this.config.teamId,
					title: input.title,
					description: input.description,
					stateId,
					...(labelIds.length > 0 ? { labelIds } : {}),
				},
			});
			const issue = data.issueCreate?.issue;
			if (!data.issueCreate?.success || !issue?.id) {
				throw new Error(`Linear rejected the request to create issue '${input.title}'`);
			}
			logger.debug('pm: created work item', { itemId: issue.id, status: input.status });
			// One write, unlike GitHub Projects' create-then-place pair: `stateId` is
			// part of the create. Mapped through `toWorkItem` so the fresh card reads
			// exactly like one off a board read — the caller gets the same resolved
			// `statusKey` and label shape. Its `taskRef` is unset and that is honest:
			// a Linear issue is not an SCM artifact, and nothing has linked one to it
			// yet (ai/ARCHITECTURE.md "Task identity").
			return toWorkItem({ ...issue, id: issue.id }, this.config, this.project.repo);
		});
	}

	async updateWorkItem(id: string, patch: UpdateWorkItemPatch): Promise<void> {
		// Nothing to write is not an empty write: `issueUpdate` with an empty input
		// would touch the issue's `updatedAt` for no reason.
		if (patch.title === undefined && patch.description === undefined) return;
		await this.run(async () => {
			const data = await linearGraphQL<IssueUpdateResponse>(UPDATE_ISSUE_MUTATION, {
				id,
				input: {
					...(patch.title !== undefined ? { title: patch.title } : {}),
					...(patch.description !== undefined ? { description: patch.description } : {}),
				},
			});
			requireMutationSuccess(data.issueUpdate?.success, `update item '${id}'`);
		});
		logger.debug('pm: updated work item', { itemId: id });
	}

	async addLabel(id: string, name: string): Promise<void> {
		await this.run(async () => {
			// Re-applying a label the issue already carries is contractually a no-op,
			// so check before writing rather than leaning on how Linear happens to
			// answer a repeated add. Compared case-insensitively, the way Linear
			// itself compares label names.
			const attached = await linearGraphQL<IssueLabelsResponse>(ISSUE_LABELS_QUERY, { id });
			const already = (attached.issue?.labels?.nodes ?? []).some(
				(node) => node?.name?.toLowerCase() === name.toLowerCase(),
			);
			if (already) return;
			const labelId = await this.ensureLabelId(name);
			// Linear's dedicated add mutation (`issueAddLabel(id:, labelId:)`, verified
			// against the live schema) is a set insert. The alternative Cascade had to
			// use — read `labels.nodes`, write the whole list back through
			// `issueUpdate(labelIds:)` — loses any label a concurrent writer added
			// between that read and the write; this has no such window.
			const data = await linearGraphQL<IssueAddLabelResponse>(ADD_LABEL_MUTATION, { id, labelId });
			requireMutationSuccess(data.issueAddLabel?.success, `label item '${id}' with '${name}'`);
			logger.debug('pm: applied label', { itemId: id, label: name });
		});
	}

	async listBlockers(id: string): Promise<WorkItemBlocker[]> {
		return this.run(async () => {
			// Two sources, deduplicated by URL so a prerequisite that is both linked
			// and written down is reported once — as the native relation, which is what
			// makes it a gate rather than a notice (issue #643): Linear's own blocking
			// relations, and the prerequisites the item names in prose.
			const [native, mentioned] = await Promise.all([
				this.fetchNativeBlockers(id),
				this.fetchMentionedBlockers(id),
			]);
			return dedupeBlockers([...native, ...mentioned]);
		});
	}

	/**
	 * The issues Linear itself records this one as blocking — the mirror of
	 * {@link fetchNativeBlockers}, and the direction that method deliberately does
	 * *not* read. A `blocks` relation runs from the blocker to the blocked issue, so
	 * "what do I block?" is this issue's own `relations`, each dependent being the
	 * relation's `relatedIssue` target — the same pairing
	 * {@link LinearPMProvider.addBlockedBy} writes (`issueId` the blocker,
	 * `relatedIssueId` the blocked issue).
	 *
	 * Native only, never prose (`src/pm/types.ts`), and the non-dependency relation
	 * types (`related`/`duplicate`/`similar`) are filtered out here exactly as they
	 * are on the blocker side, since `IssueRelation.type` reads as a plain `String`.
	 */
	async listDependents(id: string): Promise<WorkItemDependent[]> {
		return this.run(async () => {
			const relations = await collectLinearConnection<RelationNode>(async (cursor) => {
				const data = await linearGraphQL<IssueDependentRelationsResponse>(
					ISSUE_DEPENDENT_RELATIONS_QUERY,
					{ id, cursor },
				);
				return data.issue?.relations ?? null;
			});
			return relations
				.filter(
					(relation): relation is RelationNode & { relatedIssue: BlockerIssueNode } =>
						relation.type === BLOCKS_RELATION_TYPE && Boolean(relation.relatedIssue?.id),
				)
				.map((relation) => toDependent(relation.relatedIssue));
		});
	}

	async addBlockedBy(id: string, blockerId: string): Promise<void> {
		await this.run(async () => {
			// Linear has no upsert for a relation, so idempotence comes from reading
			// the relations it already holds — re-chaining a split's phases must not
			// fail on a retry.
			const existing = await this.fetchNativeBlockers(id);
			if (existing.some((blocker) => blocker.id === blockerId)) return;
			try {
				// The *blocker* is the relation's source: the schema defines `issue` as
				// "the source issue whose relationship is being described" and
				// `relatedIssue` as its target, so `blockerId blocks id`.
				const data = await linearGraphQL<IssueRelationCreateResponse>(CREATE_RELATION_MUTATION, {
					input: { issueId: blockerId, relatedIssueId: id, type: BLOCKS_RELATION_TYPE },
				});
				requireMutationSuccess(
					data.issueRelationCreate?.success,
					`block item '${id}' by '${blockerId}'`,
				);
			} catch (error) {
				// A relation recorded between the read above and this write: the pair is
				// linked, which is exactly what the caller asked for.
				if (!isDuplicateRelationError(error)) throw error;
				return;
			}
			logger.debug('pm: linked blocked-by dependency', { itemId: id, blockerId });
		});
	}

	/**
	 * The issues Linear itself records as blocking this one.
	 *
	 * A `blocks` relation runs from the blocker to the blocked issue — the schema
	 * calls `issue` "the source issue whose relationship is being described" and
	 * `relatedIssue` its target — so the relations *pointing at* this issue are its
	 * `inverseRelations`, and each blocker is that relation's `issue` side. Reading
	 * `relations`, or taking the relation's `relatedIssue`, would each answer the
	 * opposite question ("what do I block?") and gate nothing — so the test fixture
	 * carries both sides of the relation and asserts which one comes back.
	 *
	 * Runs inside a credential scope (its callers do).
	 */
	private async fetchNativeBlockers(id: string): Promise<WorkItemBlocker[]> {
		const relations = await collectLinearConnection<RelationNode>(async (cursor) => {
			const data = await linearGraphQL<IssueBlockingRelationsResponse>(
				ISSUE_BLOCKING_RELATIONS_QUERY,
				{ id, cursor },
			);
			return data.issue?.inverseRelations ?? null;
		});
		return relations
			.filter(
				(relation): relation is RelationNode & { issue: BlockerIssueNode } =>
					relation.type === BLOCKS_RELATION_TYPE && Boolean(relation.issue?.id),
			)
			.map((relation) => toBlocker(relation.issue, 'dependency'));
	}

	/**
	 * The prerequisites the item *names in prose* — its own description and its
	 * **human** comments. The heuristic is the shared, provider-neutral one
	 * (`dependencyProse` + `findDependencyReferences`, `src/pm/dependencies.ts`),
	 * which also excludes SWARM's own comments so a published plan's "requires
	 * #266" never becomes a blocker nobody declared (issue #431); this adapter only
	 * resolves each reference to a live open/closed state.
	 *
	 * Reported as `source: 'mention'`, which since issue #643 makes them
	 * **advisory**: the gate surfaces them for a human and lets the run proceed, so
	 * only the native relation below actually defers work.
	 *
	 * **Known limitation:** the shared heuristic recognises the numeric `#N` and
	 * `/issues/N` forms, not Linear's own `SWARM-491` identifier — widening it
	 * would change GitHub's behaviour too, so it is out of scope here. A
	 * prerequisite written only in Linear's own notation is therefore guarded by
	 * the native relation above, not by this scan.
	 *
	 * Only the first page of comments is scanned, matching GitHub Projects: a
	 * prose dependency buried past comment #100 is missed, but the native relation
	 * and the description remain the durable guards, and this check runs on every
	 * gated dispatch.
	 *
	 * Runs inside a credential scope (its callers do).
	 */
	private async fetchMentionedBlockers(id: string): Promise<WorkItemBlocker[]> {
		const data = await linearGraphQL<IssueDependencyProseResponse>(ISSUE_DEPENDENCY_PROSE_QUERY, {
			id,
		});
		const issue = data.issue;
		if (!issue) return [];
		const prose = dependencyProse(
			issue.description ?? undefined,
			(issue.comments?.nodes ?? []).map((node) => node?.body),
		);
		const refs = findDependencyReferences(prose).filter((ref) => ref !== String(issue.number));
		const resolved = await Promise.all(refs.map((ref) => this.findBlockerByNumber(ref)));
		return resolved.filter((blocker): blocker is WorkItemBlocker => blocker !== undefined);
	}

	/**
	 * Resolve one referenced issue *number* to a blocker within this project's
	 * team. A reference that resolves to nothing is skipped rather than raised: a
	 * typo'd number, or one naming a GitHub issue rather than a Linear one, is not
	 * a gate. Runs inside a credential scope (its callers do).
	 */
	private async findBlockerByNumber(ref: string): Promise<WorkItemBlocker | undefined> {
		const number = Number(ref);
		if (!Number.isSafeInteger(number)) return undefined;
		const data = await linearGraphQL<BlockerIssuesResponse>(ISSUE_BY_NUMBER_QUERY, {
			filter: this.issueFilter({ number }),
		});
		const issue = (data.issues?.nodes ?? []).find((node) => node?.id);
		return issue ? toBlocker(issue, 'mention') : undefined;
	}

	/**
	 * Resolve a label *name* to the id every Linear write takes, creating the label
	 * when nothing in the workspace carries that name. Runs inside a credential
	 * scope (its callers do).
	 *
	 * Create-if-missing tolerating a lost race, like GitHub Projects' `ensureLabel`:
	 * a concurrent create that got there first leaves the label existing, which is
	 * all the caller needs, so the duplicate-name rejection falls through to a
	 * second lookup instead of failing the write it was preparing.
	 */
	private async ensureLabelId(name: string): Promise<string> {
		const existing = await this.findLabelId(name);
		if (existing) return existing;
		try {
			const data = await linearGraphQL<IssueLabelCreateResponse>(CREATE_LABEL_MUTATION, {
				input: { teamId: this.config.teamId, name },
			});
			const created = data.issueLabelCreate?.issueLabel?.id;
			if (data.issueLabelCreate?.success && created) return created;
		} catch (error) {
			if (!isDuplicateLabelNameError(error)) throw error;
		}
		const resolved = await this.findLabelId(name);
		if (!resolved) {
			throw new Error(`Linear label '${name}' could neither be resolved nor created`);
		}
		return resolved;
	}

	/**
	 * The id of the label this project's issues would get for `name`, or
	 * `undefined` when the workspace has none.
	 *
	 * Searched workspace-wide rather than through `team(id:) { labels }` because a
	 * Linear label is either scoped to one team or shared across the workspace, and
	 * an issue can carry either — a team-only lookup would miss a shared label and
	 * then fail to create it, since Linear rejects the duplicate name. This team's
	 * own label wins when both exist. Runs inside a credential scope (its callers do).
	 */
	private async findLabelId(name: string): Promise<string | undefined> {
		const labels = await collectLinearConnection<LabelNode>(async (cursor) => {
			const data = await linearGraphQL<FindLabelsResponse>(FIND_LABELS_QUERY, { name, cursor });
			return data.issueLabels ?? null;
		});
		const usable = labels.filter(
			(label) => label.id && (!label.team?.id || label.team.id === this.config.teamId),
		);
		return (usable.find((label) => label.team?.id === this.config.teamId) ?? usable[0])?.id;
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
