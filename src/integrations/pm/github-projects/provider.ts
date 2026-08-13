/**
 * GitHubProjectsPMProvider — the concrete `PMProvider` (`src/pm/types.ts`) for
 * GitHub Projects (v2), net-new to SWARM (Cascade ships Trello/JIRA/Linear, not
 * GitHub Projects — ai/ARCHITECTURE.md "PM: GitHub Projects"). It's what lets
 * the Planning and Implementation phases read the card that triggered them,
 * post their output on the linked Issue, and move the card forward.
 *
 * Every operation is GraphQL — Projects v2 has no REST surface for item/field
 * reads or writes — except comments, which land on the backing Issue/PR via
 * REST because Projects items have no native comment thread
 * (docs/github-projects-v2-api.md §3-4). The exact queries/mutation below are
 * the ones that doc verified against the real board.
 *
 * Credentials are never passed in: each method runs its GitHub work inside
 * `withGitHubProjectsCredentials(project, …)` (`./credentials.ts`), so the scoped
 * Octokit client (`getScopedClient`) authenticates as the project's **own** board
 * credential — the `apiToken` role this provider declares on its manifest,
 * resolved through `credentials.pm` (issue #537). It is deliberately *not* the SCM
 * implementer persona it used to borrow: the worker-local `SWARM_OPERATOR_GH_TOKEN`
 * is an SCM credential, and depending on it made board access a property of
 * whichever host happened to run the code. Because that credential is the account
 * every SWARM board write is attributed to, it is also the identity the router's
 * loop-prevention gate recognizes as its own (`resolveGitHubProjectsIdentity`), so
 * the pipeline doesn't re-trigger itself.
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
	ItemRepositoryRoute,
	PMDiscoveryArgs,
	PMDiscoveryCapability,
	PMDiscoveryResult,
	PMProvider,
	PMType,
	RepositoryRoutingCandidate,
	StateDiscoveryResult,
	UpdateWorkItemPatch,
	WorkItem,
	WorkItemArtifact,
	WorkItemAssignee,
	WorkItemBlocker,
	WorkItemDependent,
	WorkItemLabel,
} from '../../../pm/types.js';
import { repoSlugsMatch } from '../../../scm/repo-slug.js';
import { getScopedClient } from '../../scm/github/client.js';
import {
	type GitHubProjectsIntegrationConfig,
	requireGitHubProjectsConfig,
} from './config-schema.js';
import { withGitHubProjectsCredentials } from './credentials.js';
import { resolveStatusKeyByOptionId } from './status-mapping.js';

/** Shape of the `content` node a Projects item wraps (Issue / PullRequest). */
interface ContentNode {
	__typename?: string;
	number?: number;
	title?: string;
	body?: string | null;
	url?: string;
	repository?: { nameWithOwner?: string };
	labels?: { nodes?: Array<{ id?: string; name?: string; color?: string }> };
	assignees?: { nodes?: Array<{ id?: string; login?: string; name?: string | null }> };
}

interface ItemNode {
	id?: string;
	content?: ContentNode | null;
	fieldValueByName?: { name?: string; optionId?: string } | null;
	createdAt?: string;
	updatedAt?: string;
}

interface GetItemResponse {
	node?: ItemNode | null;
}

/** A project item read through its backing artifact, which also names the board it sits on. */
interface ArtifactItemNode extends ItemNode {
	project?: { id?: string } | null;
}

/** One artifact's board memberships, for {@link ARTIFACT_ITEMS_QUERY}. */
interface ArtifactItemsResponse {
	repository?: {
		issueOrPullRequest?: {
			__typename?: string;
			projectItems?: { nodes?: Array<ArtifactItemNode | null> | null } | null;
		} | null;
	} | null;
}

/** One page of a repository's newest issue bodies, for {@link RECENT_ISSUE_BODIES_QUERY}. */
interface RecentIssueBodiesResponse {
	repository?: {
		issues?: { nodes?: Array<{ number?: number; body?: string | null } | null> | null } | null;
	} | null;
}

/** One page of the board's items, for {@link GitHubProjectsPMProvider.listWorkItems}. */
interface ListItemsResponse {
	node?: {
		items?: {
			nodes?: ItemNode[] | null;
			pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
		} | null;
	} | null;
}

/**
 * A Projects item read, plus the backing Issue/PR coordinates the item itself
 * doesn't expose through the provider-agnostic {@link WorkItem} (which speaks no
 * GitHub-specific fields). Kept internal to the adapter.
 */
interface ResolvedItem {
	workItem: WorkItem;
	owner?: string;
	repo?: string;
	contentNumber?: number;
}

/**
 * The selection every read maps a {@link WorkItem} from — one Projects item, its
 * Status option, and its backing Issue/PR. Interpolated into each item-shaped
 * query below rather than repeated, so the three reads can never drift into
 * mapping different fields.
 *
 * The label page size is deliberately generous: `WorkItem.labels` now drives the
 * automation gate (issue #131), so a label truncated off the end of the page
 * would read as "not opted in" and silently halt the pipeline on a busy issue.
 */
const ITEM_FIELDS = /* GraphQL */ `
	id
	createdAt
	updatedAt
	content {
		__typename
		... on Issue {
			number title body url
			repository { nameWithOwner }
			labels(first: 100) { nodes { id name color } }
			assignees(first: 10) { nodes { id login name } }
		}
		... on PullRequest {
			number title body url
			repository { nameWithOwner }
			labels(first: 100) { nodes { id name color } }
			assignees(first: 10) { nodes { id login name } }
		}
	}
	fieldValueByName(name: "Status") {
		... on ProjectV2ItemFieldSingleSelectValue { name optionId }
	}
`;

/** Read one item, its Status option, and its backing Issue/PR in one round-trip. */
const GET_ITEM_QUERY = /* GraphQL */ `
	query($itemId: ID!) {
		node(id: $itemId) {
			... on ProjectV2Item {
				${ITEM_FIELDS}
			}
		}
	}
`;

const LIST_ITEMS_QUERY = /* GraphQL */ `
	query($projectId: ID!, $cursor: String) {
		node(id: $projectId) {
			... on ProjectV2 {
				items(first: 100, after: $cursor) {
					pageInfo { hasNextPage endCursor }
					nodes {
						${ITEM_FIELDS}
					}
				}
			}
		}
	}
`;

/**
 * How many boards one Issue/PR's `projectItems` are read for. An artifact belongs
 * to as many boards as somebody added it to — a handful in practice, and
 * unrelated to how many cards any of those boards holds — so this is a defensive
 * ceiling rather than a page to walk. {@link ARTIFACT_ITEMS_QUERY}'s consumer
 * logs if it ever fills.
 */
const ARTIFACT_PROJECT_ITEMS = 50;

/**
 * **The board-free artifact lookup.** Addresses one Issue/PR by its repository
 * and number and walks to *its* project items, instead of paging the board to
 * find the item that wraps it (issue #735). Constant cost: one request and one
 * GraphQL point, measured against the 325-card live board where the whole-board
 * read it replaces cost four requests and eight points.
 *
 * `issueOrPullRequest` rather than `issue`/`pullRequest`: GitHub numbers issues
 * and pull requests in one per-repository sequence, so a number resolves to
 * exactly one of them, and `__typename` is what the caller confirms the requested
 * `kind` against. Owner and name are explicit, which is what keeps two
 * repositories using the same number apart — the property
 * `findWorkItemForArtifact` is defined by.
 */
const ARTIFACT_ITEMS_QUERY = /* GraphQL */ `
	query($owner: String!, $name: String!, $number: Int!) {
		repository(owner: $owner, name: $name) {
			issueOrPullRequest(number: $number) {
				__typename
				... on Issue {
					projectItems(first: ${ARTIFACT_PROJECT_ITEMS}) {
						nodes { project { id } ${ITEM_FIELDS} }
					}
				}
				... on PullRequest {
					projectItems(first: ${ARTIFACT_PROJECT_ITEMS}) {
						nodes { project { id } ${ITEM_FIELDS} }
					}
				}
			}
		}
	}
`;

/**
 * How many of a repository's most recent issues {@link RECENT_ISSUE_BODIES_QUERY}
 * reads. One page is the whole read: the only caller is Planning's split guard
 * asking about a child *it created moments ago*, which sits at the very top of a
 * `CREATED_AT DESC` ordering. A marker on an issue older than this window is
 * missed — stated here rather than discovered, and the alternative (GitHub's
 * eventually-consistent issue search) is the one thing that guard cannot use.
 */
const RECENT_ISSUE_WINDOW = 100;

/**
 * **The board-free marker lookup**: the newest issues of the project's own
 * repository, bodies only, newest first (issue #735).
 *
 * A repository read rather than a board read, and a *listing* rather than
 * `search`: `repository.issues` is strongly consistent, while GitHub's search
 * index is not — and the caller is Planning's retried split, where a child
 * created seconds ago has to be findable now or the guard silently creates a
 * second one (`src/pm/types.ts`, "One-card lookups are lookups, not scans").
 * Bodies only, because the matched issue's card is then resolved through
 * {@link ARTIFACT_ITEMS_QUERY}.
 */
const RECENT_ISSUE_BODIES_QUERY = /* GraphQL */ `
	query($owner: String!, $name: String!) {
		repository(owner: $owner, name: $name) {
			issues(first: ${RECENT_ISSUE_WINDOW}, orderBy: { field: CREATED_AT, direction: DESC }) {
				nodes { number body }
			}
		}
	}
`;

/**
 * Set a single-select field on an item (docs/github-projects-v2-api.md §4). The
 * only mutation SWARM writes — status transitions are the whole PM surface it
 * needs.
 */
const MOVE_ITEM_MUTATION = /* GraphQL */ `
	mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
		updateProjectV2ItemFieldValue(input: {
			projectId: $projectId
			itemId: $itemId
			fieldId: $fieldId
			value: { singleSelectOptionId: $optionId }
		}) {
			projectV2Item { id }
		}
	}
`;

/**
 * Add an existing Issue/PR (by its content node ID) to the board, returning the
 * new item's node ID. Paired with {@link MOVE_ITEM_MUTATION} to place the item
 * in a starting Status — the two writes {@link GitHubProjectsPMProvider.createWorkItem}
 * makes after creating the backing Issue via REST.
 */
const ADD_PROJECT_ITEM_MUTATION = /* GraphQL */ `
	mutation($projectId: ID!, $contentId: ID!) {
		addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
			item { id }
		}
	}
`;

interface AddProjectItemResponse {
	addProjectV2ItemById?: { item?: { id?: string } | null } | null;
}

/**
 * One page of the Projects v2 boards owned by the authenticated user, for board
 * discovery (issue #201). The dashboard picks a board from these instead of an
 * operator typing its node ID. `url` is the board's web URL, shown as picker
 * detail. Paginated like every Projects v2 connection so a user with more than
 * one page of boards isn't silently truncated to the first 100.
 */
const VIEWER_PROJECTS_QUERY = /* GraphQL */ `
	query($cursor: String) {
		viewer {
			projectsV2(first: 100, after: $cursor) {
				pageInfo { hasNextPage endCursor }
				nodes { id title url }
			}
		}
	}
`;

/** One page of the organizations the authenticated user belongs to, for org board discovery. */
const VIEWER_ORGS_QUERY = /* GraphQL */ `
	query($cursor: String) {
		viewer {
			organizations(first: 100, after: $cursor) {
				pageInfo { hasNextPage endCursor }
				nodes { login }
			}
		}
	}
`;

/** One page of the Projects v2 boards owned by a single organization. */
const ORG_PROJECTS_QUERY = /* GraphQL */ `
	query($login: String!, $cursor: String) {
		organization(login: $login) {
			projectsV2(first: 100, after: $cursor) {
				pageInfo { hasNextPage endCursor }
				nodes { id title url }
			}
		}
	}
`;

/**
 * One page of a selected board's fields, for state discovery (issue #201). Only
 * the single-select fields carry `options`; the mapping's states come from the
 * one named `Status` (the same field name {@link GET_ITEM_QUERY} reads item
 * status from). `fields` is a paginated connection — a board with many custom
 * fields could push `Status` past the first page, so it is walked to the end.
 */
const PROJECT_FIELDS_QUERY = /* GraphQL */ `
	query($projectId: ID!, $cursor: String) {
		node(id: $projectId) {
			... on ProjectV2 {
				id
				fields(first: 100, after: $cursor) {
					pageInfo { hasNextPage endCursor }
					nodes {
						... on ProjectV2SingleSelectField {
							id
							name
							options { id name }
						}
					}
				}
			}
		}
	}
`;

/** A discovered Projects v2 board node (user- or org-owned). */
interface ProjectV2Node {
	id?: string;
	title?: string;
	url?: string;
}

interface ProjectsConnection {
	nodes?: Array<ProjectV2Node | null> | null;
	pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
}

interface ViewerProjectsResponse {
	viewer?: { projectsV2?: ProjectsConnection | null } | null;
}

interface ViewerOrgsResponse {
	viewer?: {
		organizations?: {
			nodes?: Array<{ login?: string } | null> | null;
			pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
		} | null;
	} | null;
}

interface OrgProjectsResponse {
	organization?: { projectsV2?: ProjectsConnection | null } | null;
}

/** A single-select field node (others in the `fields` connection come back empty). */
interface SingleSelectFieldNode {
	id?: string;
	name?: string;
	options?: Array<{ id?: string; name?: string } | null> | null;
}

interface ProjectFieldsResponse {
	node?: {
		id?: string;
		fields?: {
			nodes?: Array<SingleSelectFieldNode | null> | null;
			pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
		} | null;
	} | null;
}

/** Default label color (GitHub's neutral grey) for a SWARM-created label. */
const DEFAULT_LABEL_COLOR = 'ededed';

function mapLabels(content: ContentNode | null | undefined): WorkItemLabel[] {
	const nodes = content?.labels?.nodes ?? [];
	return nodes
		.filter((n): n is { id: string; name: string; color?: string } => !!n?.id && !!n.name)
		.map((n) => ({ id: n.id, name: n.name, color: n.color }));
}

/**
 * Map the issue/PR's assignees to the provider-neutral shape. GitHub's `login`
 * vocabulary stops here — the rest of SWARM speaks `WorkItemAssignee.handle`
 * (ai/RULES.md §2). A `name` GitHub leaves unset comes back as `null`/`''`,
 * which is "no display name" rather than an empty one.
 */
function mapAssignees(content: ContentNode | null | undefined): WorkItemAssignee[] {
	const nodes = content?.assignees?.nodes ?? [];
	return nodes
		.filter((n): n is { id?: string; login: string; name?: string | null } => !!n?.login)
		.map((n) => ({ handle: n.login, displayName: n.name || undefined, providerId: n.id }));
}

function ownerRepoFrom(content: ContentNode | null | undefined): {
	owner?: string;
	repo?: string;
} {
	const nameWithOwner = content?.repository?.nameWithOwner;
	if (!nameWithOwner) return {};
	const [owner, repo] = nameWithOwner.split('/');
	return { owner, repo };
}

/** Split an `owner/repo` slug for the repository-addressed queries, or nothing if it isn't one. */
function splitRepositorySlug(repository: string): { owner: string; name: string } | undefined {
	const [owner, name, ...rest] = repository.split('/');
	return owner && name && rest.length === 0 ? { owner, name } : undefined;
}

/**
 * Whether a GraphQL failure is GitHub answering "that doesn't resolve".
 *
 * The board-free lookups (issue #735) address an Issue/PR that may simply not
 * exist — an issue number decoded from a branch name, a repository slug from
 * config — and the contract's answer for that is a soft `undefined`, not a throw.
 * GitHub reports it as a partial response carrying a `NOT_FOUND` error, which
 * Octokit raises, so it has to be recognised here rather than read off the data.
 *
 * **It also covers "the board credential cannot see that repository."** GitHub
 * answers an unauthorized read with `NOT_FOUND` too, and nothing in the response
 * tells the two apart; a whole-board scan used to answer from the board instead
 * and so could still find such a card. That is the one behaviour this trades
 * away, and it resolves to the contract's ordinary miss with the caller failing
 * open (`src/pm/pull-request-work-item.ts`), never to a wrong card. Every other
 * GraphQL error still propagates.
 */
function isNotFoundGraphQLError(err: unknown): boolean {
	const errors = (err as { errors?: Array<{ type?: string } | null> } | null)?.errors;
	return Array.isArray(errors) && errors.some((entry) => entry?.type === 'NOT_FOUND');
}

/**
 * The Issue/PR a `/issues/<n>`-shaped URL suffix names, resolved against
 * `defaultRepository` when the suffix carries no `owner/repo` of its own.
 *
 * This is GitHub's URL layout, and parsing it belongs in this adapter and nowhere
 * else (ai/RULES.md §2) — the caller passes a tail it knows (`/issues/100`) and
 * has no host or owner to go with it, which is exactly why the contract takes a
 * *suffix*. A suffix GitHub's layout could not produce resolves to nothing, which
 * the caller answers as a free miss.
 *
 * The number is anchored to the end and preceded by a path separator, so
 * `/issues/100` cannot name `/issues/1001` — the same guard the previous
 * `endsWith` match relied on, now applied to the key instead of to every card.
 */
function parseArtifactSuffix(
	urlSuffix: string,
	defaultRepository: string,
): WorkItemArtifact | undefined {
	const match = /(?:^|\/)(?:([^/\s]+)\/([^/\s]+)\/)?(issues|pull)\/(\d+)$/.exec(urlSuffix);
	if (!match) return undefined;
	const [, owner, repo, path, number] = match;
	if (!path || !number) return undefined;
	return {
		repository: owner && repo ? `${owner}/${repo}` : defaultRepository,
		kind: path === 'issues' ? 'issue' : 'pullRequest',
		number,
	};
}

/**
 * Map a board item onto a `WorkItem`. `config` is the project's board mapping, and
 * it is needed for exactly one thing: translating the opaque Status option ID into
 * the canonical `statusKey` shared code resolves a pipeline phase from, so no
 * caller has to invert `statusOptions` itself (ai/RULES.md §2).
 */
function toResolvedItem(item: ItemNode, config: GitHubProjectsIntegrationConfig): ResolvedItem {
	const content = item.content ?? undefined;
	const { owner, repo } = ownerRepoFrom(content);
	const optionId = item.fieldValueByName?.optionId;
	const workItem: WorkItem = {
		id: item.id ?? '',
		title: content?.title ?? '',
		description: content?.body ?? '',
		url: content?.url ?? '',
		// The board's own linkage to the SCM artifact — the backing Issue/PR's number,
		// read in the same round-trip. Absent for a draft card, which has no Issue/PR
		// and therefore no SCM-driven phase (ai/ARCHITECTURE.md "Task identity").
		taskRef: content?.number == null ? undefined : String(content.number),
		status: item.fieldValueByName?.name,
		statusId: optionId,
		statusKey: optionId === undefined ? undefined : resolveStatusKeyByOptionId(config, optionId),
		labels: mapLabels(content),
		assignees: mapAssignees(content),
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
	};
	return { workItem, owner, repo, contentNumber: content?.number };
}

export class GitHubProjectsPMProvider implements PMProvider {
	readonly type: PMType = 'github-projects';

	// GitHub Issues models cross-issue dependencies natively (the issue-dependencies
	// REST API — docs/github-projects-v2-api.md), so this provider supports the
	// blocked-by capability. A future Bitbucket/GitLab provider sets this to `false`
	// if it can't, and callers fall back to the human-readable comment guard.
	readonly supportsDependencies = true;

	// GitHub Issues/PRs carry assignees natively, so every item this adapter maps
	// reports them (`mapAssignees`). A provider without the concept sets this
	// `false` and every item stays unassigned.
	readonly supportsAssignees = true;

	/**
	 * This project's board mapping, narrowed out of the `pm` union once at
	 * construction (`requireGitHubProjectsConfig`) instead of at each read — the
	 * only place this provider asserts which union member it was built for
	 * (issue #495).
	 */
	private readonly config: GitHubProjectsIntegrationConfig;

	constructor(private readonly project: ProjectConfig) {
		this.config = requireGitHubProjectsConfig(project);
	}

	/** Run `fn` with this project's board credential bound to the GitHub client. */
	private run<T>(fn: () => Promise<T>): Promise<T> {
		return withGitHubProjectsCredentials(this.project, fn);
	}

	private async resolveItem(id: string): Promise<ResolvedItem> {
		return this.run(async () => {
			const data = await getScopedClient().graphql<GetItemResponse>(GET_ITEM_QUERY, {
				itemId: id,
			});
			const item = data.node;
			// A non-resolving item ID is bad input, not a soft miss: the ID came from
			// a webhook or a prior board read (ai/CODING_STANDARDS.md "Error handling").
			if (!item?.id) {
				throw new Error(`GitHub Projects item '${id}' did not resolve`);
			}
			return toResolvedItem(item, this.config);
		});
	}

	async getWorkItem(id: string): Promise<WorkItem> {
		return (await this.resolveItem(id)).workItem;
	}

	/**
	 * The card's own backing repository decides, so this provider reads no routing
	 * token at all — `candidates[].routingToken` is deliberately unused (issue #686
	 * phase 1). A Projects card wraps at most one Issue/PR, which lives in exactly
	 * one repository, so it also can never answer `ambiguous`.
	 *
	 * No new query: `resolveItem` already reads `repository { nameWithOwner }` in the
	 * same round-trip it reads the item with. The comparison goes through the shared
	 * `repoSlugsMatch` rather than `===`, so a config entry's casing or a `.git`
	 * suffix cannot make a card look like it belongs to no repository (issue #688).
	 *
	 * A **draft** card has no Issue/PR and therefore no repository — `unrouted`, the
	 * same answer as a card whose repository this project does not own.
	 */
	async resolveItemRepository(
		id: string,
		candidates: readonly RepositoryRoutingCandidate[],
	): Promise<ItemRepositoryRoute> {
		const { owner, repo } = await this.resolveItem(id);
		if (!owner || !repo) return { status: 'unrouted' };
		const slug = `${owner}/${repo}`;
		const claimed = candidates.find((candidate) => repoSlugsMatch(candidate.repo, slug));
		return claimed ? { status: 'routed', repo: claimed.repo } : { status: 'unrouted' };
	}

	async listWorkItems(filter?: { status?: string }): Promise<WorkItem[]> {
		// The board's small today (ai/ARCHITECTURE.md "Single-user scope"), but
		// `items` is a paginated connection — walk every page so a board that
		// outgrows one page (100 items) isn't silently truncated. Status filtering
		// is client-side against the canonical key the caller passes, resolved to
		// this board's option ID.
		let wantedOptionId: string | undefined;
		if (filter?.status !== undefined) {
			wantedOptionId = this.config.statusOptions[filter.status];
			// A status key with no mapping is a config/logic error, not "match
			// everything": leaving it undefined would fall through to the no-filter
			// path below and return all items. Fail loudly, matching moveWorkItem
			// (ai/CODING_STANDARDS.md "Error handling").
			if (!wantedOptionId) {
				throw new Error(
					`Cannot list items: status '${filter.status}' has no option ID in the project's statusOptions map`,
				);
			}
		}
		return this.run(async () => {
			const nodes: ItemNode[] = [];
			let cursor: string | undefined;
			for (;;) {
				const data = await getScopedClient().graphql<ListItemsResponse>(LIST_ITEMS_QUERY, {
					projectId: this.config.projectId,
					cursor,
				});
				const page = data.node?.items;
				nodes.push(...(page?.nodes ?? []));
				const pageInfo = page?.pageInfo;
				// Guard against a malformed response that claims another page but hands
				// back no cursor — advancing on `undefined` would refetch page one forever.
				if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
				// And against a server that claims another page while handing back the
				// same cursor we just used — advancing to it would loop forever too. This
				// keeps the loop provably terminating regardless of server behavior.
				if (pageInfo.endCursor === cursor) break;
				cursor = pageInfo.endCursor;
			}
			return nodes
				.filter((n): n is ItemNode => !!n?.id)
				.map((n) => toResolvedItem(n, this.config).workItem)
				.filter((wi) => wantedOptionId === undefined || wi.statusId === wantedOptionId);
		});
	}

	async findWorkItemByUrlSuffix(urlSuffix: string): Promise<WorkItem | undefined> {
		// Projects v2 exposes no server-side filter on the backing content's URL — but
		// the suffix names the backing artifact, and *that* is addressable, so the card
		// is reached through the Issue/PR rather than by paging the board past it
		// (issue #735). A suffix carrying no owner/repo resolves against this project's
		// own repository. That is narrower than the previous whole-board `endsWith` scan,
		// which would have matched an unrelated repository's same-numbered card sitting on
		// a shared org board — and it is what both callers mean. The legacy fallback in
		// `src/pipeline/respond-to-review.ts` decodes the number from a task branch in
		// this very repository. The dashboard's queue enrichment (`src/api/routers/runs.ts`,
		// on its path for a dispatch row recorded before the repository was) has no
		// repository to offer at all, so on a multi-repository project this resolves
		// against the project's default entry rather than matching any repository's card;
		// that read is cosmetic and fail-open, so such a row simply renders without its
		// card title.
		const artifact = parseArtifactSuffix(urlSuffix, this.project.repo);
		// A suffix no GitHub artifact URL ends with is a miss this can answer without
		// asking GitHub anything (`src/pm/types.ts`, "One-card lookups are lookups").
		if (!artifact) return undefined;
		return this.resolveArtifactItem(artifact);
	}

	async findWorkItemByDescriptionMarker(marker: string): Promise<WorkItem | undefined> {
		// Two narrow reads instead of a whole board (issue #735): the newest issues of
		// this project's repository, then the matched issue's own card.
		//
		// Deliberately **not** GitHub's issue search API, which is an
		// eventually-consistent index: the caller asking is Planning's retried split,
		// and a child created seconds ago has to be findable *now* or the guard
		// silently duplicates it — the exact failure this lookup exists to prevent.
		// `repository.issues` is a listing, not the index, so it answers immediately;
		// what it costs instead is the {@link RECENT_ISSUE_WINDOW} bound, which the
		// split's own children are never near.
		//
		// It reaches the project's repository rather than the board, so a marker on a
		// draft card, on a pull request, or on an issue from another repository is not
		// found. Every one of those is outside what `createWorkItem` can produce, and
		// this lookup exists to recognise what `createWorkItem` produced.
		const slug = splitRepositorySlug(this.project.repo);
		if (!slug) return undefined;
		const number = await this.run(async () => {
			const data = await this.readOrMiss<RecentIssueBodiesResponse>(RECENT_ISSUE_BODIES_QUERY, {
				owner: slug.owner,
				name: slug.name,
			});
			const nodes = data?.repository?.issues?.nodes ?? [];
			if (nodes.length >= RECENT_ISSUE_WINDOW) {
				logger.debug('pm: marker lookup read a full window of recent issues', {
					repository: this.project.repo,
					window: RECENT_ISSUE_WINDOW,
				});
			}
			return nodes.find((node) => node?.number != null && (node.body ?? '').includes(marker))
				?.number;
		});
		if (number === undefined) return undefined;
		return this.resolveArtifactItem({
			repository: this.project.repo,
			kind: 'issue',
			number: String(number),
		});
	}

	async findWorkItemForArtifact(artifact: WorkItemArtifact): Promise<WorkItem | undefined> {
		return this.resolveArtifactItem(artifact);
	}

	/**
	 * This board's card for one Issue/PR, resolved through the artifact itself
	 * ({@link ARTIFACT_ITEMS_QUERY}) — the shared body of all three one-card
	 * lookups, and the whole of issue #735's fix on this provider.
	 *
	 * The board is never read: an artifact knows which boards it is on, so the
	 * match is `project.id`, and every property the previous whole-board scan gave
	 * survives it. It cannot confuse two repositories (owner and name are query
	 * arguments), it cannot confuse an issue with a pull request of the same number
	 * (`__typename` is checked against the requested `kind`), and a miss stays a
	 * soft `undefined` rather than becoming a throw.
	 */
	private async resolveArtifactItem({
		repository,
		kind,
		number,
	}: WorkItemArtifact): Promise<WorkItem | undefined> {
		const slug = splitRepositorySlug(repository);
		const parsed = Number(number);
		// A malformed artifact reference is the contract's soft miss, not bad input:
		// the number reaching here was decoded from a branch name or a URL suffix.
		if (!slug || !Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
		return this.run(async () => {
			const data = await this.readOrMiss<ArtifactItemsResponse>(ARTIFACT_ITEMS_QUERY, {
				owner: slug.owner,
				name: slug.name,
				number: parsed,
			});
			const artifact = data?.repository?.issueOrPullRequest;
			// GitHub numbers issues and pull requests in one sequence, so a number is
			// one or the other; answering with the wrong kind would hand the caller a
			// card it did not ask for.
			if (!artifact || artifact.__typename !== (kind === 'issue' ? 'Issue' : 'PullRequest')) {
				return undefined;
			}
			const nodes = (artifact.projectItems?.nodes ?? []).filter((node): node is ArtifactItemNode =>
				Boolean(node?.id),
			);
			if (nodes.length >= ARTIFACT_PROJECT_ITEMS) {
				logger.debug('pm: artifact sits on a full page of boards — later ones were not read', {
					repository,
					number,
					limit: ARTIFACT_PROJECT_ITEMS,
				});
			}
			const node = nodes.find((candidate) => candidate.project?.id === this.config.projectId);
			return node ? toResolvedItem(node, this.config).workItem : undefined;
		});
	}

	/**
	 * Run one of the artifact-addressed queries, turning GitHub's "that doesn't
	 * resolve" into the contract's soft miss ({@link isNotFoundGraphQLError}) and
	 * letting every other failure propagate. Runs inside a credential scope (its
	 * callers do).
	 */
	private async readOrMiss<T>(
		query: string,
		variables: Record<string, unknown>,
	): Promise<T | undefined> {
		try {
			return await getScopedClient().graphql<T>(query, variables);
		} catch (error) {
			if (isNotFoundGraphQLError(error)) return undefined;
			throw error;
		}
	}

	async moveWorkItem(id: string, status: string): Promise<void> {
		const { projectId, statusFieldId, statusOptions } = this.config;
		const optionId = statusOptions[status];
		if (!optionId) {
			// A status the board mapping can't resolve is a config/logic error, not a
			// value to silently write — fail loudly (ai/CODING_STANDARDS.md).
			throw new Error(
				`Cannot move item '${id}': status '${status}' has no option ID in the project's statusOptions map`,
			);
		}
		await this.run(async () => {
			await getScopedClient().graphql(MOVE_ITEM_MUTATION, {
				projectId,
				itemId: id,
				fieldId: statusFieldId,
				optionId,
			});
		});
		logger.debug('pm: moved work item', { itemId: id, status });
	}

	async addComment(id: string, text: string): Promise<string> {
		const resolved = await this.resolveItem(id);
		const { owner, repo, contentNumber } = resolved;
		// Projects items have no comment thread; the comment lands on the backing
		// Issue/PR (docs/github-projects-v2-api.md §4). A draft item has no backing
		// Issue, so there's nowhere to post — that's a bad target, not a soft miss.
		if (!owner || !repo || contentNumber == null) {
			throw new Error(
				`Cannot comment on item '${id}': it has no backing Issue/PR to post to (likely a draft item)`,
			);
		}
		return this.run(async () => {
			const { data } = await getScopedClient().issues.createComment({
				owner,
				repo,
				issue_number: contentNumber,
				body: text,
			});
			return String(data.id);
		});
	}

	async findComment(id: string, marker: string): Promise<string | undefined> {
		const resolved = await this.resolveItem(id);
		const { owner, repo, contentNumber } = resolved;
		if (!owner || !repo || contentNumber == null) {
			return undefined;
		}
		return this.run(async () => {
			const client = getScopedClient();
			// Scan *all* comment pages, not just the first 100: the marker of an older
			// delivery can sit beyond page 1, and missing it would post a duplicate on a
			// retry. Mirrors the SCM idempotent-comment path (`postIdempotentPullRequestComment`,
			// src/integrations/scm/github/client.ts). Match the marker as a substring —
			// it lives at the comment's tail, not its start.
			const comments = await client.paginate(client.issues.listComments, {
				owner,
				repo,
				issue_number: contentNumber,
				per_page: 100,
			});
			const found = comments.find((c) => c.body?.includes(marker));
			return found ? String(found.id) : undefined;
		});
	}

	async createWorkItem(input: CreateWorkItemInput): Promise<WorkItem> {
		const [owner, repo] = this.project.repo.split('/');
		const { projectId, statusFieldId, statusOptions } = this.config;
		const optionId = statusOptions[input.status];
		if (!optionId) {
			// Same fail-loud contract as moveWorkItem: an unmappable status is a
			// config/logic error, not a value to silently write (ai/CODING_STANDARDS.md).
			throw new Error(
				`Cannot create item: status '${input.status}' has no option ID in the project's statusOptions map`,
			);
		}
		const labels = input.labels ?? [];
		return this.run(async () => {
			const client = getScopedClient();
			// A label referenced on a new issue must already exist, so ensure each
			// before creating — otherwise the whole create fails on an unknown label.
			for (const name of labels) {
				await ensureLabel(owner, repo, name);
			}
			const { data: issue } = await client.issues.create({
				owner,
				repo,
				title: input.title,
				body: input.description,
				labels,
			});
			// Add the fresh Issue to the board, then place it in its starting Status —
			// two writes, since addProjectV2ItemById can't set a field value.
			const added = await client.graphql<AddProjectItemResponse>(ADD_PROJECT_ITEM_MUTATION, {
				projectId,
				contentId: issue.node_id,
			});
			const itemId = added.addProjectV2ItemById?.item?.id;
			if (!itemId) {
				throw new Error(`addProjectV2ItemById returned no item id for issue #${issue.number}`);
			}
			await client.graphql(MOVE_ITEM_MUTATION, {
				projectId,
				itemId,
				fieldId: statusFieldId,
				optionId,
			});
			logger.debug('pm: created work item', {
				itemId,
				issueNumber: issue.number,
				status: input.status,
			});
			return {
				id: itemId,
				title: issue.title,
				description: issue.body ?? '',
				url: issue.html_url,
				// The Issue this card was just created around is its SCM artifact.
				taskRef: String(issue.number),
				statusId: optionId,
				// The caller named the canonical key, and `optionId` is its resolution —
				// carry it back so the fresh item reads like one off a board read.
				statusKey: resolveStatusKeyByOptionId(this.config, optionId),
				labels: (issue.labels ?? [])
					.map((l) =>
						typeof l === 'string'
							? { id: l, name: l }
							: { id: String(l.id), name: l.name ?? '', color: l.color ?? undefined },
					)
					.filter((l): l is WorkItemLabel => l.name.length > 0),
				// A freshly created issue is unassigned — SWARM never assigns on create.
				assignees: [],
			};
		});
	}

	async updateWorkItem(id: string, patch: UpdateWorkItemPatch): Promise<void> {
		// Title/description live on the backing Issue, not the board card — resolve
		// it first (its own scoped run), mirroring addComment's two-step shape.
		const { owner, repo, contentNumber } = await this.resolveItem(id);
		if (!owner || !repo || contentNumber == null) {
			throw new Error(
				`Cannot update item '${id}': it has no backing Issue to update (likely a draft item)`,
			);
		}
		if (patch.title === undefined && patch.description === undefined) return;
		await this.run(async () => {
			await getScopedClient().issues.update({
				owner,
				repo,
				issue_number: contentNumber,
				...(patch.title !== undefined ? { title: patch.title } : {}),
				...(patch.description !== undefined ? { body: patch.description } : {}),
			});
		});
		logger.debug('pm: updated work item', { itemId: id });
	}

	async addLabel(id: string, name: string): Promise<void> {
		// Labels live on the backing Issue, not the board card — resolve it first
		// (its own scoped run), mirroring addComment/updateWorkItem's two-step shape.
		const { owner, repo, contentNumber } = await this.resolveItem(id);
		if (!owner || !repo || contentNumber == null) {
			throw new Error(
				`Cannot label item '${id}': it has no backing Issue to label (likely a draft item)`,
			);
		}
		await this.run(async () => {
			const client = getScopedClient();
			// Create the label if missing (reusing the same helper createWorkItem uses),
			// then apply it. issues.addLabels is additive and idempotent — re-adding an
			// already-present label neither duplicates it nor errors.
			await ensureLabel(owner, repo, name);
			await client.issues.addLabels({ owner, repo, issue_number: contentNumber, labels: [name] });
		});
		logger.debug('pm: applied label', { itemId: id, label: name });
	}

	async listBlockers(id: string): Promise<WorkItemBlocker[]> {
		const { workItem, owner, repo, contentNumber } = await this.resolveItem(id);
		// A draft item (no backing Issue) can carry no dependencies — nothing to gate on.
		if (!owner || !repo || contentNumber == null) return [];
		return this.run(async () => {
			// Two sources: the native "blocked by" relationships, plus prerequisites the
			// item names in prose (its own description + comments). Deduped by URL so a
			// dependency that is both linked and mentioned appears once — as the native
			// one, which is what makes it a gate rather than a notice (issue #643: the
			// caller defers only on `source: 'dependency'` and surfaces the rest).
			const [native, mentioned] = await Promise.all([
				this.fetchNativeBlockers(owner, repo, contentNumber),
				this.fetchMentionedBlockers(owner, repo, contentNumber, workItem.description),
			]);
			return dedupeBlockers([...native, ...mentioned]);
		});
	}

	async listDependents(id: string): Promise<WorkItemDependent[]> {
		const { owner, repo, contentNumber } = await this.resolveItem(id);
		// A draft item (no backing Issue) can block nothing — the same reason
		// `listBlockers` returns early for one.
		if (!owner || !repo || contentNumber == null) return [];
		return this.run(() => this.fetchNativeDependents(owner, repo, contentNumber));
	}

	async addBlockedBy(id: string, blockerId: string): Promise<void> {
		const [target, blocker] = await Promise.all([
			this.resolveItem(id),
			this.resolveItem(blockerId),
		]);
		if (!target.owner || !target.repo || target.contentNumber == null) {
			throw new Error(`Cannot add dependency to item '${id}': it has no backing Issue`);
		}
		if (!blocker.owner || !blocker.repo || blocker.contentNumber == null) {
			throw new Error(`Cannot block item '${id}': blocker '${blockerId}' has no backing Issue`);
		}
		await this.run(async () => {
			const client = getScopedClient();
			// The dependencies API keys the blocker by its numeric database id, not its
			// number, so resolve the blocking issue once to read `id`.
			const { data: blockerIssue } = await client.issues.get({
				owner: blocker.owner as string,
				repo: blocker.repo as string,
				issue_number: blocker.contentNumber as number,
			});
			try {
				await client.request(
					'POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by',
					{
						owner: target.owner as string,
						repo: target.repo as string,
						issue_number: target.contentNumber as number,
						issue_id: blockerIssue.id,
					},
				);
				logger.debug('pm: linked blocked-by dependency', {
					itemId: id,
					blockerId,
					blockerIssue: blocker.contentNumber,
				});
			} catch (err) {
				// Idempotent: an already-recorded dependency comes back 422 — treat as success.
				if (isHttpStatus(err, 422)) return;
				throw err;
			}
		});
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
				// Unreachable for a declared capability (the type union is exhaustive),
				// but a runtime guard keeps a future capability from silently no-op'ing.
				throw new Error(`GitHub Projects does not support discovery capability '${capability}'`);
		}
	}

	/**
	 * Enumerate the Projects v2 boards this project's board credential can pick
	 * from: the boards it owns directly, plus the boards owned by each organization
	 * it belongs to. Every connection is paginated to the end and the result is
	 * deduplicated by node ID (a board can surface through more than one path),
	 * then sorted by title so the picker is stable.
	 *
	 * Org enumeration is the one step whose failure is almost always a *permission*
	 * problem rather than an outage — `viewer.organizations` needs `read:org`, which
	 * a token minted with only `repo`/`project` lacks (issue #537's reported
	 * failure) — so it is translated into an error that names the missing permission
	 * instead of surfacing GitHub's raw wording. Never echoes the credential.
	 */
	private async discoverContainers(): Promise<ContainerDiscoveryResult> {
		return this.run(async () => {
			const client = getScopedClient();
			const own = await collectConnection<ProjectV2Node>(async (cursor) => {
				const data = await client.graphql<ViewerProjectsResponse>(VIEWER_PROJECTS_QUERY, {
					cursor,
				});
				return data.viewer?.projectsV2 ?? null;
			});
			const orgs = await this.collectViewerOrganizations(client);
			const orgBoards: ProjectV2Node[] = [];
			for (const org of orgs) {
				if (!org.login) continue;
				const login = org.login;
				const boards = await collectConnection<ProjectV2Node>(async (cursor) => {
					const data = await client.graphql<OrgProjectsResponse>(ORG_PROJECTS_QUERY, {
						login,
						cursor,
					});
					return data.organization?.projectsV2 ?? null;
				});
				orgBoards.push(...boards);
			}
			return { containers: normalizeContainers([...own, ...orgBoards]) };
		});
	}

	/**
	 * The organizations the board credential belongs to.
	 *
	 * A **permission** failure here is translated into an error naming the scope the
	 * token is missing, because GitHub's own wording ("Resource not accessible by
	 * personal access token") does not say which permission or why. Anything else —
	 * an outage, a 5xx, a rate limit, a revoked token — is rethrown untouched: this
	 * whole issue exists because a misleading error sent an operator after the wrong
	 * cause, and asserting "grant read:org" over a network blip would do it again.
	 *
	 * Must run inside a scoped-credentials context (its caller does).
	 */
	private async collectViewerOrganizations(
		client: ReturnType<typeof getScopedClient>,
	): Promise<Array<{ login?: string }>> {
		try {
			return await collectConnection<{ login?: string }>(async (cursor) => {
				const data = await client.graphql<ViewerOrgsResponse>(VIEWER_ORGS_QUERY, { cursor });
				return data.viewer?.organizations ?? null;
			});
		} catch (err) {
			if (!isPermissionDenied(err)) throw err;
			throw new Error(
				'The GitHub Projects API token cannot list the organizations it belongs to, so ' +
					"organization-owned boards can't be discovered. Grant it the 'read:org' scope " +
					'(classic token) or organization read access (fine-grained token), then try again. ' +
					`GitHub reported: ${errorMessage(err)}`,
			);
		}
	}

	/**
	 * Discover a selected board's workflow states — the options of its single-select
	 * `Status` field — plus the field's own node ID in {@link StateDiscoveryResult.providerContext}
	 * so the mapping can persist `statusFieldId` without the shared picker naming a
	 * GitHub-specific field. Throws an actionable error when the board can't be
	 * resolved, has no `Status` single-select field, or that field has no options.
	 */
	private async discoverStates(containerId: string): Promise<StateDiscoveryResult> {
		return this.run(async () => {
			const client = getScopedClient();
			const fields: SingleSelectFieldNode[] = [];
			let cursor: string | undefined;
			let resolved = false;
			for (;;) {
				const data = await client.graphql<ProjectFieldsResponse>(PROJECT_FIELDS_QUERY, {
					projectId: containerId,
					cursor,
				});
				const node = data.node;
				// `node: null` (bad id) or a node that isn't a ProjectV2 (the inline
				// fragment matched nothing, so no `id`) both mean the board didn't resolve.
				if (!node?.id) break;
				resolved = true;
				const conn = node.fields;
				for (const f of conn?.nodes ?? []) {
					if (f) fields.push(f);
				}
				const pageInfo = conn?.pageInfo;
				if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
				if (pageInfo.endCursor === cursor) break;
				cursor = pageInfo.endCursor;
			}
			if (!resolved) {
				throw new Error(`GitHub Projects board '${containerId}' did not resolve`);
			}
			const statusField = fields.find((f) => f.name === 'Status' && Array.isArray(f.options));
			if (!statusField?.id) {
				throw new Error(
					`GitHub Projects board '${containerId}' has no single-select "Status" field to map`,
				);
			}
			const states = (statusField.options ?? [])
				.filter((o): o is { id: string; name: string } => !!o?.id && !!o.name)
				.map((o) => ({ id: o.id, name: o.name }));
			if (states.length === 0) {
				throw new Error(
					`GitHub Projects board '${containerId}' Status field has no options to map`,
				);
			}
			return { states, providerContext: { statusFieldId: statusField.id } };
		});
	}

	/**
	 * The item's native "blocked by" prerequisites, via the GitHub issue-dependencies
	 * REST API. A repo/plan without the feature answers 404/410 — treated as "no
	 * dependencies" (best-effort) rather than failing the caller's gate.
	 */
	private async fetchNativeBlockers(
		owner: string,
		repo: string,
		issueNumber: number,
	): Promise<WorkItemBlocker[]> {
		try {
			const { data } = await getScopedClient().request(
				'GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by',
				{ owner, repo, issue_number: issueNumber, per_page: 100 },
			);
			const issues = (data ?? []) as DependencyIssue[];
			return issues
				.filter((i): i is DependencyIssue & { number: number } => typeof i.number === 'number')
				.map((i) => toBlocker(i, 'dependency'));
		} catch (err) {
			if (isHttpStatus(err, 404) || isHttpStatus(err, 410)) {
				logger.debug('pm: issue-dependencies API unavailable; treating as no native blockers', {
					owner,
					repo,
					issueNumber,
				});
				return [];
			}
			throw err;
		}
	}

	/**
	 * The issues this one natively blocks — the reverse edge of
	 * {@link fetchNativeBlockers}, from the sibling `dependencies/blocking`
	 * endpoint (docs/github-projects-v2-api.md §5b). Native only: prose is never
	 * consulted here, because this answer is what excuses a blocker (issue #639).
	 *
	 * Answers *issues*, not board items, so the mapped dependents carry no `id` —
	 * which is exactly why the gate matches on `url`/`reference` and checks only the
	 * direct edge. A repo/plan without the feature answers 404/410, treated as "no
	 * dependents" like its blocked-by twin: a missing reverse read leaves the
	 * blockers gating, it does not ungate them.
	 */
	private async fetchNativeDependents(
		owner: string,
		repo: string,
		issueNumber: number,
	): Promise<WorkItemDependent[]> {
		try {
			const { data } = await getScopedClient().request(
				'GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocking',
				{ owner, repo, issue_number: issueNumber, per_page: 100 },
			);
			const issues = (data ?? []) as DependencyIssue[];
			return issues
				.filter((i): i is DependencyIssue & { number: number } => typeof i.number === 'number')
				.map(toDependent);
		} catch (err) {
			if (isHttpStatus(err, 404) || isHttpStatus(err, 410)) {
				logger.debug('pm: issue-dependencies API unavailable; treating as no dependents', {
					owner,
					repo,
					issueNumber,
				});
				return [];
			}
			throw err;
		}
	}

	/**
	 * Prerequisites the item *names in prose* — its own description and its
	 * **human** comments — that aren't native relationships. Provider-neutral
	 * reference extraction (`findDependencyReferences`); this adapter resolves each
	 * referenced issue's live open/closed state. A reference that doesn't resolve is
	 * skipped (a typo'd or cross-repo number is not a gate).
	 *
	 * These are reported as `source: 'mention'` and are **advisory** since issue
	 * #643: the gate surfaces them for a human and proceeds, so accuracy here decides
	 * the quality of a notice rather than whether a run stalls. Still worth resolving
	 * the live state — a notice about an already-closed issue is noise.
	 *
	 * SWARM's own comments are excluded (`isSwarmGeneratedBody`, issue #431): a
	 * published plan — a split child's Preplan comment, or any phase's plan comment —
	 * is agent prose that routinely says things like "this phase requires #266 to
	 * land first". Read as a dependency declaration, that used to gate the item on an
	 * issue nobody declared a blocker (deferring Implementation while it stayed open
	 * and finally failing the run); since #643 it would instead ask a human to record
	 * a relationship SWARM invented out of its own writing. A prerequisite has to be
	 * declared by a person, in the description or a comment of their own — or, to gate
	 * anything, as a native `blocked by` relationship.
	 */
	private async fetchMentionedBlockers(
		owner: string,
		repo: string,
		issueNumber: number,
		description: string,
	): Promise<WorkItemBlocker[]> {
		const client = getScopedClient();
		// Only the first page (100 comments) is scanned — a prose dependency buried
		// past comment #100 is missed, but the native `blocked by` relationship and
		// the item's own description remain the durable guards, so this best-effort
		// scan of the most likely places (description + early discussion) is enough
		// without paginating a long thread on every gate check.
		const { data: comments } = await client.issues.listComments({
			owner,
			repo,
			issue_number: issueNumber,
			per_page: 100,
		});
		const prose = dependencyProse(
			description,
			comments.map((c) => c.body ?? undefined),
		);
		const refs = findDependencyReferences(prose).filter((n) => n !== String(issueNumber));
		const resolved = await Promise.all(
			refs.map(async (ref): Promise<WorkItemBlocker | undefined> => {
				try {
					const { data: issue } = await client.issues.get({
						owner,
						repo,
						issue_number: Number(ref),
					});
					return toBlocker(issue, 'mention');
				} catch (err) {
					if (isHttpStatus(err, 404)) return undefined;
					throw err;
				}
			}),
		);
		return resolved.filter((b): b is WorkItemBlocker => b !== undefined);
	}
}

/** The subset of a GitHub Issue the dependency endpoints return that we map from. */
interface DependencyIssue {
	id?: number;
	number?: number;
	title?: string | null;
	html_url?: string;
	state?: string;
}

/** Map a GitHub issue (native dependency or resolved mention) to a provider-neutral blocker. */
function toBlocker(issue: DependencyIssue, source: WorkItemBlocker['source']): WorkItemBlocker {
	return {
		reference: issue.number != null ? `#${issue.number}` : (issue.html_url ?? '?'),
		url: issue.html_url ?? '',
		title: issue.title ?? '',
		open: issue.state !== 'closed',
		source,
	};
}

/**
 * Map a natively blocked issue onto a dependent — the same fields as
 * {@link toBlocker} minus `source`, since the reverse read has only one
 * (`src/pm/types.ts`). `reference`/`url` are built identically on purpose: they are
 * the identity the shared cycle check matches a blocker against.
 */
function toDependent(issue: DependencyIssue): WorkItemDependent {
	return {
		reference: issue.number != null ? `#${issue.number}` : (issue.html_url ?? '?'),
		url: issue.html_url ?? '',
		title: issue.title ?? '',
		open: issue.state !== 'closed',
	};
}

/**
 * Ensure a label exists in the repo before it's applied to a new issue —
 * `issues.create` errors on an unknown label. Created with GitHub's neutral grey
 * when missing; a concurrent create that already made it (422) is treated as
 * success. Must run inside a scoped-credentials context (its callers do).
 */
async function ensureLabel(owner: string, repo: string, name: string): Promise<void> {
	const client = getScopedClient();
	try {
		await client.issues.getLabel({ owner, repo, name });
		return;
	} catch (err) {
		if (!isHttpStatus(err, 404)) throw err;
	}
	try {
		await client.issues.createLabel({ owner, repo, name, color: DEFAULT_LABEL_COLOR });
	} catch (err) {
		// A parallel create won the race — the label now exists, which is all we need.
		if (!isHttpStatus(err, 422)) throw err;
	}
}

/**
 * Walk a paginated GraphQL connection to the end, collecting every node. Applies
 * the same termination guards as {@link GitHubProjectsPMProvider.listWorkItems}:
 * stop when there's no next page or no cursor, and stop if a page repeats the
 * cursor it was fetched with (a misbehaving server must not loop forever). Must
 * run inside a scoped-credentials context (its callers do).
 */
async function collectConnection<N>(
	fetchPage: (cursor: string | undefined) => Promise<{
		nodes?: Array<N | null> | null;
		pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
	} | null>,
): Promise<N[]> {
	const all: N[] = [];
	let cursor: string | undefined;
	for (;;) {
		const page = await fetchPage(cursor);
		for (const node of page?.nodes ?? []) {
			if (node) all.push(node);
		}
		const pageInfo = page?.pageInfo;
		if (!pageInfo?.hasNextPage || !pageInfo.endCursor) break;
		if (pageInfo.endCursor === cursor) break;
		cursor = pageInfo.endCursor;
	}
	return all;
}

/**
 * Reduce discovered board nodes to stable picker options: keep only nodes with a
 * node ID and title, deduplicate by ID (a board can be reachable both directly
 * and through an org), and sort by title (case-insensitive) so the picker order
 * doesn't jump between refreshes.
 */
function normalizeContainers(nodes: ProjectV2Node[]): DiscoveredContainer[] {
	const byId = new Map<string, DiscoveredContainer>();
	for (const node of nodes) {
		if (!node.id || !node.title) continue;
		if (byId.has(node.id)) continue;
		byId.set(node.id, { id: node.id, name: node.title, url: node.url || undefined });
	}
	return [...byId.values()].sort((a, b) =>
		a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
	);
}

/**
 * A thrown value's message, for wrapping one API failure in a more actionable
 * error. GitHub's own errors never carry the credential, so this is safe to
 * surface (the API layer shows a provider message verbatim — `src/api/routers/pm.ts`).
 */
function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Whether an Octokit error carries a specific HTTP status. */
function isHttpStatus(err: unknown, status: number): boolean {
	return typeof err === 'object' && err !== null && (err as { status?: number }).status === status;
}

/**
 * Whether a failure is GitHub refusing the call on **authorization** grounds, as
 * opposed to failing to answer it. Used to decide whether a diagnosis may be
 * asserted or the original error must stand.
 *
 * Three signals, in decreasing order of how much they can be trusted:
 *
 * 1. HTTP 401/403 — a REST-shaped refusal (expired or under-scoped token).
 * 2. A GraphQL `errors` entry typed `FORBIDDEN`/`INSUFFICIENT_SCOPES`. A
 *    scope-refused GraphQL query comes back **HTTP 200** with an `errors` array,
 *    which Octokit raises as a `GraphqlResponseError`; the `type` is the
 *    machine-readable part.
 * 3. GitHub's own refusal wording, as a fallback. Matching provider text is
 *    normally the wrong instinct — this module argues against it elsewhere — but
 *    the GraphQL surface has more than one shape for this and losing the
 *    diagnosis would regress the very failure #537 was reported for. It is scoped
 *    tightly enough that an outage or a 5xx cannot satisfy it.
 */
function isPermissionDenied(err: unknown): boolean {
	if (isHttpStatus(err, 401) || isHttpStatus(err, 403)) return true;
	const graphqlErrors = (err as { errors?: Array<{ type?: string }> } | null)?.errors;
	if (
		Array.isArray(graphqlErrors) &&
		graphqlErrors.some(
			(entry) => entry?.type === 'FORBIDDEN' || entry?.type === 'INSUFFICIENT_SCOPES',
		)
	) {
		return true;
	}
	return /not accessible by|insufficient.*scope|requires.*scope|read:org/i.test(errorMessage(err));
}

/**
 * Build the GitHub Projects PM provider for a project. The one construction
 * seam callers (the worker's phase dispatch, the trigger handlers) use, so they
 * depend on the `PMProvider` interface rather than the concrete class.
 */
export function createGitHubProjectsProvider(project: ProjectConfig): PMProvider {
	return new GitHubProjectsPMProvider(project);
}
