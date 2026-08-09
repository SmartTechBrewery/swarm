/**
 * JiraPMProvider — the concrete `PMProvider` (`src/pm/types.ts`) for Jira Cloud.
 * This phase lands the **board reads** (`getWorkItem`, `listWorkItems`,
 * `findWorkItemByUrlSuffix`, `findWorkItemForArtifact`,
 * `findWorkItemByDescriptionMarker`) and `discover`; the writes, the transition,
 * and the dependency gate are still explicit not-implemented stubs, and nothing
 * registers this provider yet — a provider registers only once no method of the
 * contract is a stub (ai/RULES.md §2 "Register when the contract is satisfied,
 * not when the folder appears", the sequencing GitLab's #295 and Linear's #491
 * both used).
 *
 * Every operation is REST v3 over `jiraRequest` (`./client.ts`), which picks the
 * basic-auth pair up off the async scope — credentials are never arguments, so
 * each method wraps its work in `withJiraProjectCredentials(this.project, …)`
 * exactly as Linear's provider does.
 *
 * A **container is a Jira project**, identified by its human **key** (`SWARM`)
 * rather than its numeric id, because the key is what every issue key is prefixed
 * with and what a board webhook carries; a **state** is one of that project's
 * workflow statuses, mapped by status **id** (`./config-schema.ts`).
 *
 * Two Jira-specific costs are deliberate and visible rather than hidden:
 * `taskRef` needs the issue's *remote links*, a second round trip per card, so it
 * is resolved only on the reads that answer with a single card; and Jira indexes
 * nothing on a remote link's URL, so {@link JiraPMProvider.findWorkItemForArtifact}
 * is a capped scan rather than a lookup.
 */

import type { ProjectConfig } from '../../../config/schema.js';
import { logger } from '../../../lib/logger.js';
import type {
	ContainerDiscoveryResult,
	DiscoveredContainer,
	DiscoveredState,
	ListWorkItemsFilter,
	PMDiscoveryArgs,
	PMDiscoveryCapability,
	PMDiscoveryResult,
	PMProvider,
	PMType,
	StateDiscoveryResult,
	WorkItem,
	WorkItemArtifact,
	WorkItemAssignee,
	WorkItemBlocker,
	WorkItemLabel,
} from '../../../pm/types.js';
import { adfToPlainText } from './adf.js';
import { collectJiraPage, type JiraPage, jiraRequest, MAX_PAGES } from './client.js';
import { type JiraIntegrationConfig, requireJiraConfig } from './config-schema.js';
import { withJiraProjectCredentials } from './credentials.js';
import { requireStatusIdForStatusKey, resolveStatusKeyByStatusId } from './status-mapping.js';

/**
 * The issue fields every read requests, so one card maps the same way whichever
 * query found it. Jira returns the whole issue when `fields` is omitted; naming
 * them keeps the ADF `description` the largest thing on the wire instead of the
 * hundred-odd custom fields a real site carries.
 *
 * Labels are *not* paged by Jira — `fields.labels` is a plain array — so, unlike
 * the Linear and GitHub Projects providers, there is no page size here that could
 * truncate the automation-gate label off the end (ai/ARCHITECTURE.md "Automation
 * opt-in gate").
 */
const ISSUE_FIELDS = 'summary,description,status,labels,assignee,created,updated';

/** Jira's own cap on one page of results (`maxResults`), for both search and offset paging. */
const PAGE_SIZE = 100;

/**
 * How many of the board's cards {@link JiraPMProvider.findWorkItemForArtifact}
 * will confirm one by one before giving up. See that method for why the scan
 * exists at all; the cap is what keeps a large board from turning one fail-open
 * gate check into hundreds of requests.
 */
const ARTIFACT_SCAN_LIMIT = 50;

/** How many candidates that scan reads remote links for at once. */
const ARTIFACT_SCAN_CONCURRENCY = 5;

/** An Atlassian account as the issue reads select it. */
interface JiraUser {
	accountId?: string;
	displayName?: string | null;
	emailAddress?: string | null;
}

/** The subset of `fields` {@link ISSUE_FIELDS} asks for. Every member is optional defensively. */
interface JiraIssueFields {
	summary?: string | null;
	/** An ADF document in REST v3 — read through {@link adfToPlainText}, never as a string. */
	description?: unknown;
	status?: { id?: string; name?: string } | null;
	labels?: Array<string | null> | null;
	assignee?: JiraUser | null;
	created?: string;
	updated?: string;
}

interface JiraIssue {
	/** The human key (`SWARM-123`) — this provider's work-item id. */
	key?: string;
	/** Jira's numeric issue id. Unused: the key is the id every seam speaks. */
	id?: string;
	fields?: JiraIssueFields | null;
}

/** An issue whose key is known — what every read narrows to before mapping. */
type KeyedJiraIssue = JiraIssue & { key: string };

/**
 * One page of the enhanced JQL search (`GET /rest/api/3/search/jql`). Token-paged,
 * not offset-paged, which is why it cannot go through {@link collectJiraPage}
 * (`./client.ts` module header).
 */
interface JiraSearchResponse {
	issues?: Array<JiraIssue | null> | null;
	nextPageToken?: string | null;
	isLast?: boolean | null;
}

/** One entry of `GET /rest/api/3/issue/{key}/remotelink` — a plain array, not a page. */
interface JiraRemoteLink {
	object?: { url?: string | null } | null;
}

interface JiraProjectNode {
	id?: string;
	key?: string;
	name?: string;
}

/** One issue type's statuses, the shape `GET /rest/api/3/project/{key}/statuses` groups by. */
interface JiraIssueTypeStatuses {
	id?: string;
	name?: string;
	statuses?: Array<{ id?: string; name?: string } | null> | null;
}

/** The site URL without a trailing slash, so a browse URL can never carry `//browse`. */
function siteUrl(config: JiraIntegrationConfig): string {
	return config.baseUrl.replace(/\/+$/, '');
}

/**
 * Quote a value as a JQL string literal. JQL's own escapes are `\"` and `\\`, so
 * escaping those two is what makes an operator-supplied project key safe to
 * interpolate rather than trusted to be `[A-Z][A-Z0-9]+`.
 */
function quoteJql(value: string): string {
	return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The characters Jira's text index treats as query operators rather than as text.
 * They have to be escaped *before* the JQL quoting above, which then doubles the
 * backslashes so one survives into the text query itself.
 */
const JQL_TEXT_OPERATORS = /[+\-&|!(){}[\]^~*?\\:"]/g;

/** Quote a value as the right-hand side of a JQL `~` (text) comparison. */
function quoteJqlText(value: string): string {
	return quoteJql(value.replace(JQL_TEXT_OPERATORS, '\\$&'));
}

/**
 * A Jira status id as JQL wants it: bare, because a quoted value is matched
 * against status *names* instead. The board mapping documents its values as ids
 * (`./config-schema.ts`), so a non-numeric one is a config error worth naming
 * rather than a query to send and have silently match nothing.
 */
function requireJqlStatusId(statusId: string, statusKey: string): string {
	if (!/^\d+$/.test(statusId)) {
		throw new Error(
			`Jira statusOptions maps canonical status '${statusKey}' to '${statusId}', which is not a ` +
				'Jira status ID — statusOptions values are numeric status IDs, not status names',
		);
	}
	return statusId;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Drop a query string, fragment, or trailing slash a remote link may have been recorded with. */
function normalizeArtifactUrl(url: string): string {
	return url.replace(/[?#].*$/, '').replace(/\/+$/, '');
}

/**
 * `taskRef` for a card, read off its remote links: the first link pointing at a
 * GitHub **issue** in this project's own repository.
 *
 * The Jira analogue of Linear's GitHub-issue *attachment* rule (ai/ARCHITECTURE.md
 * "Task identity"). A *pull-request* remote link deliberately does not qualify — a
 * PR is an artifact of the task, not its id — and the Jira issue key is never used
 * as a task id, since a task id names a worktree and a branch. A card with no
 * GitHub issue link leaves this unset, which is the honest answer: the phase
 * dispatcher logs and skips.
 */
function taskRefFromRemoteLinks(links: JiraRemoteLink[], repository: string): string | undefined {
	const issueUrl = new RegExp(
		`^https://github\\.com/${escapeRegExp(repository)}/issues/(\\d+)(?:[/?#]|$)`,
	);
	for (const link of links) {
		const match = link?.object?.url?.match(issueUrl);
		if (match) return match[1];
	}
	return undefined;
}

/**
 * Jira labels are free-form strings with no id of their own, so the name *is* the
 * id — unlike GitHub's and Linear's label objects.
 */
function mapLabels(fields: JiraIssueFields): WorkItemLabel[] {
	return (fields.labels ?? [])
		.filter((label): label is string => Boolean(label))
		.map((name) => ({ id: name, name }));
}

/**
 * Map the issue's assignee onto the provider-neutral array. Jira models exactly
 * one assignee per issue, so this is `[]` or a single element.
 *
 * The handle prefers `emailAddress`, but Jira Cloud omits that field unless the
 * token's own account holds the right privacy scope, so `displayName` is the
 * fallback — and `src/identity/assignee-resolver.ts` links on whichever of the two
 * the operator recorded. `accountId` is the stable id to re-link against when a
 * display name is changed, which is what `providerId` is for.
 */
function mapAssignees(fields: JiraIssueFields): WorkItemAssignee[] {
	const assignee = fields.assignee;
	const handle = assignee?.emailAddress || assignee?.displayName;
	if (!assignee || !handle) return [];
	return [
		{
			handle,
			displayName: assignee.displayName || undefined,
			providerId: assignee.accountId,
		},
	];
}

/**
 * Map a Jira issue onto a `WorkItem`. `config` is needed for two things: the site
 * URL the card's browse link is built from, and translating the opaque status id
 * into the canonical `statusKey` shared code resolves a pipeline phase from, so no
 * caller inverts `statusOptions` itself (ai/RULES.md §2).
 *
 * `taskRef` is **not** set here: it lives on the issue's remote links, a separate
 * request, so the callers that need it merge it in explicitly
 * ({@link JiraPMProvider.resolveTaskRef}).
 */
function toWorkItem(issue: KeyedJiraIssue, config: JiraIntegrationConfig): WorkItem {
	const fields = issue.fields ?? {};
	const statusId = fields.status?.id;
	return {
		id: issue.key,
		title: fields.summary ?? '',
		description: adfToPlainText(fields.description),
		url: `${siteUrl(config)}/browse/${issue.key}`,
		status: fields.status?.name,
		statusId,
		statusKey: statusId === undefined ? undefined : resolveStatusKeyByStatusId(config, statusId),
		labels: mapLabels(fields),
		assignees: mapAssignees(fields),
		createdAt: fields.created,
		updatedAt: fields.updated,
	};
}

/**
 * Reduce discovered projects to stable picker options: keep only nodes carrying
 * both a key and a name, deduplicate by key, and sort by name (case-insensitive)
 * so the picker order doesn't jump between refreshes — the same normalisation
 * Linear's `normalizeContainers` performs.
 *
 * The id is the project **key**, not the numeric project id: the key is what an
 * issue key is prefixed with, what a board webhook carries, and what the board
 * mapping stores (`./config-schema.ts`).
 */
function normalizeContainers(projects: JiraProjectNode[], site: string): DiscoveredContainer[] {
	const byId = new Map<string, DiscoveredContainer>();
	for (const project of projects) {
		if (!project.key || !project.name) continue;
		if (byId.has(project.key)) continue;
		byId.set(project.key, {
			id: project.key,
			name: project.name,
			url: `${site}/browse/${project.key}`,
		});
	}
	return [...byId.values()].sort((a, b) =>
		a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
	);
}

/** Split `values` into consecutive groups of at most `size`. */
function chunk<T>(values: T[], size: number): T[][] {
	const groups: T[][] = [];
	for (let index = 0; index < values.length; index += size) {
		groups.push(values.slice(index, index + size));
	}
	return groups;
}

export class JiraPMProvider implements PMProvider {
	readonly type: PMType = 'jira';

	// A Jira issue carries an assignee natively (`fields.assignee`), so every item
	// this provider maps reports it — at most one, which `mapAssignees` folds into
	// the shared array shape.
	readonly supportsAssignees = true;

	// Jira models cross-issue prerequisites natively, as an issue link of type
	// "Blocks", so this provider claims the dependency capability and callers keep
	// the dependency gate rather than falling back to the human-readable comment
	// guard. The two methods behind it land with the writes in phase 3/6.
	readonly supportsDependencies = true;

	/**
	 * This project's board mapping, narrowed out of the `pm` union once at
	 * construction instead of at each read — the only place this provider asserts
	 * which union member it was built for (issue #495).
	 */
	private readonly config: JiraIntegrationConfig;

	constructor(private readonly project: ProjectConfig) {
		this.config = requireJiraConfig(project);
	}

	/** Run `fn` with this project's Jira basic-auth pair bound to scope. */
	private run<T>(fn: () => Promise<T>): Promise<T> {
		return withJiraProjectCredentials(this.project, fn);
	}

	async getWorkItem(id: string): Promise<WorkItem> {
		return this.run(async () => {
			const issue = await jiraRequest<JiraIssue | undefined>(`issue/${encodeURIComponent(id)}`, {
				query: { fields: ISSUE_FIELDS },
			});
			// A non-resolving id is bad input, not a soft miss: it came from a webhook
			// or a prior board read (ai/CODING_STANDARDS.md "Error handling"). Jira
			// answers an unknown key with a 404, which `jiraRequest` already throws as a
			// `JiraApiError` — this covers the partial/empty-body case and states the
			// contract at the seam that owns it.
			if (!issue?.key) {
				throw new Error(`Jira issue '${id}' did not resolve`);
			}
			return this.resolveTaskRef(toWorkItem({ ...issue, key: issue.key }, this.config));
		});
	}

	async listWorkItems(filter?: ListWorkItemsFilter): Promise<WorkItem[]> {
		// Resolve the canonical key to this project's status id *before* the read. An
		// unmapped status is a config/logic error, not "match everything": omitting the
		// clause would silently return the whole board, so `requireStatusIdForStatusKey`
		// fails loudly, exactly as the other two providers' `listWorkItems` do
		// (ai/CODING_STANDARDS.md "Error handling").
		const statusClause =
			filter?.status === undefined
				? undefined
				: `status = ${requireJqlStatusId(requireStatusIdForStatusKey(this.config, filter.status), filter.status)}`;
		return this.run(async () => {
			const issues = await this.searchIssues(this.boardJql(statusClause));
			// No `taskRef` on a whole-board read, deliberately: it lives on each issue's
			// remote links, so filling it here would cost one extra request *per card*.
			// Every caller of this method matches on `url`, `status`, or `id`
			// (`src/api/routers/runs.ts`, `src/triggers/handlers/preplan-invalidated.ts`);
			// the reads that answer with a single card do resolve it.
			return issues.map((issue) => toWorkItem(issue, this.config));
		});
	}

	async findWorkItemByUrlSuffix(urlSuffix: string): Promise<WorkItem | undefined> {
		// Jira exposes no JQL comparison against an issue's own browse URL, so the
		// match runs client-side over the same paged board read `listWorkItems` walks.
		//
		// SWARM's only caller passes a GitHub-shaped `/issues/<n>` suffix — the
		// documented legacy fallback in `src/pipeline/respond-to-review.ts`, used only
		// for a pull request with no recorded card (ai/ARCHITECTURE.md "Task
		// identity"). A Jira card's URL is `<site>/browse/PROJ-123`, which never ends
		// with that, so for those pre-existing PRs this honestly resolves nothing; a
		// Jira board reports through SWARM's own durable `runs.work_item_id` link
		// instead, which is provider-neutral.
		const items = await this.listWorkItems();
		const match = items.find((item) => item.url.endsWith(urlSuffix));
		return match ? this.run(() => this.resolveTaskRef(match)) : undefined;
	}

	async findWorkItemForArtifact({
		repository,
		kind,
		number,
	}: WorkItemArtifact): Promise<WorkItem | undefined> {
		const path = kind === 'issue' ? 'issues' : 'pull';
		const artifactUrl = `https://github.com/${repository}/${path}/${number}`;
		return this.run(async () => {
			// **A scan, not a lookup.** Jira indexes nothing on a remote link's URL —
			// there is no JQL field for one and no reverse endpoint — so the only honest
			// implementation is to take the board's cards and confirm each by reading its
			// remote links. Ordered by `updated DESC` because the card behind an active
			// pull request is one SWARM has been moving, and capped so a large board
			// can't turn one gate check into hundreds of requests.
			//
			// Two consequences worth stating plainly: a card outside the cap is missed,
			// and Jira's search index is eventually consistent, so a card created
			// seconds ago may not be found yet. Both are tolerable *here* because this
			// is a soft miss by contract and its only caller — the automation-label gate
			// in `src/pm/pull-request-work-item.ts` — fails open, so a miss dispatches
			// normally rather than wedging review/CI work.
			const candidates = await this.searchIssues(
				this.boardJql(undefined, 'updated DESC'),
				ARTIFACT_SCAN_LIMIT + 1,
			);
			if (candidates.length > ARTIFACT_SCAN_LIMIT) {
				logger.debug('pm: capping the Jira remote-link scan for an artifact', {
					artifactUrl,
					scanned: ARTIFACT_SCAN_LIMIT,
				});
			}
			const scanned = candidates.slice(0, ARTIFACT_SCAN_LIMIT);
			for (const batch of chunk(scanned, ARTIFACT_SCAN_CONCURRENCY)) {
				const read = await Promise.all(
					batch.map(async (issue) => ({ issue, links: await this.fetchRemoteLinks(issue.key) })),
				);
				const confirmed = read.find(({ links }) =>
					links.some((link) => {
						const url = link?.object?.url;
						return url ? normalizeArtifactUrl(url) === artifactUrl : false;
					}),
				);
				if (confirmed) {
					// The links this card was confirmed by are the same ones `taskRef` is
					// read from, so it costs no extra request here.
					const taskRef = taskRefFromRemoteLinks(confirmed.links, this.project.repo);
					return { ...toWorkItem(confirmed.issue, this.config), taskRef };
				}
			}
			return undefined;
		});
	}

	async findWorkItemByDescriptionMarker(marker: string): Promise<WorkItem | undefined> {
		return this.run(async () => {
			// Jira's `~` is a tokenised **text** match, not `contains`: it narrows the
			// read server-side, and the client-side check below is what decides. Matching
			// on `~` alone would accept a card that merely shares the marker's words.
			//
			// Callers pass a marker at most one item can carry (Planning's split guard),
			// so the first confirmed match is the match. The risk this shape leaves is
			// Jira's text index being eventually consistent: a child created seconds ago
			// may not be indexed yet, in which case the guard misses and the split
			// creates a second child — the client-side confirmation stops the opposite
			// failure, a false positive adopting an unrelated card.
			const issues = await this.searchIssues(
				this.boardJql(`description ~ ${quoteJqlText(marker)}`),
			);
			const match = issues.find((issue) =>
				adfToPlainText(issue.fields?.description).includes(marker),
			);
			return match ? this.resolveTaskRef(toWorkItem(match, this.config)) : undefined;
		});
	}

	// The board writes, the transition, and the dependency gate land in phase 3/6.
	// The wording below is the generic sentinel the PM conformance suite scans a
	// registered provider's own source for, which is what keeps a stub from being
	// registered as if it were real (ai/TESTING.md "Provider conformance").
	async moveWorkItem(): Promise<void> {
		throw new Error('moveWorkItem is not implemented for the Jira PM provider');
	}

	async addComment(): Promise<string> {
		throw new Error('addComment is not implemented for the Jira PM provider');
	}

	async findComment(): Promise<string | undefined> {
		throw new Error('findComment is not implemented for the Jira PM provider');
	}

	async createWorkItem(): Promise<WorkItem> {
		throw new Error('createWorkItem is not implemented for the Jira PM provider');
	}

	async updateWorkItem(): Promise<void> {
		throw new Error('updateWorkItem is not implemented for the Jira PM provider');
	}

	async addLabel(): Promise<void> {
		throw new Error('addLabel is not implemented for the Jira PM provider');
	}

	async listBlockers(): Promise<WorkItemBlocker[]> {
		throw new Error('listBlockers is not implemented for the Jira PM provider');
	}

	async addBlockedBy(): Promise<void> {
		throw new Error('addBlockedBy is not implemented for the Jira PM provider');
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
				throw new Error(`Jira does not support discovery capability '${capability}'`);
		}
	}

	/**
	 * Enumerate the Jira projects the credential can browse — the containers a board
	 * mapping is scoped to. `project/search` already returns only projects the
	 * account has permission on, so there is no second path to union in.
	 */
	private async discoverContainers(): Promise<ContainerDiscoveryResult> {
		return this.run(async () => {
			const projects = await collectJiraPage<JiraProjectNode>((startAt) =>
				jiraRequest<JiraPage<JiraProjectNode>>('project/search', {
					query: { startAt, maxResults: PAGE_SIZE },
				}),
			);
			return { containers: normalizeContainers(projects, siteUrl(this.config)) };
		});
	}

	/**
	 * Discover one project's workflow statuses. Jira reports them **grouped by issue
	 * type**, and a project's issue types usually share most of their workflow, so
	 * the groups are flattened and deduplicated by status id. Insertion order is
	 * kept rather than sorted alphabetically: within a group it is the workflow's own
	 * order, which is the order an operator building the mapping is reading down.
	 *
	 * Returns **no** `providerContext`: a Jira status id is the whole mapping, so
	 * there is no extra scope to thread back — that field exists for GitHub Projects'
	 * `statusFieldId`.
	 */
	private async discoverStates(containerId: string): Promise<StateDiscoveryResult> {
		return this.run(async () => {
			const issueTypes = await jiraRequest<JiraIssueTypeStatuses[] | undefined>(
				`project/${encodeURIComponent(containerId)}/statuses`,
			);
			// A key Jira cannot resolve answers 404, which `jiraRequest` throws; this is
			// the partial/empty-body case, and both are actionable at the mapping screen.
			if (!Array.isArray(issueTypes)) {
				throw new Error(`Jira project '${containerId}' did not resolve`);
			}
			const byId = new Map<string, DiscoveredState>();
			for (const issueType of issueTypes) {
				for (const status of issueType?.statuses ?? []) {
					if (!status?.id || !status.name || byId.has(status.id)) continue;
					byId.set(status.id, { id: status.id, name: status.name });
				}
			}
			if (byId.size === 0) {
				throw new Error(`Jira project '${containerId}' has no workflow statuses to map`);
			}
			return { states: [...byId.values()] };
		});
	}

	/**
	 * The JQL for this project's board: every card, optionally narrowed by one extra
	 * clause. The project key is quoted rather than trusted to be `[A-Z][A-Z0-9]+`,
	 * so an operator-supplied key can't reshape the query.
	 */
	private boardJql(where?: string, order = 'created DESC'): string {
		const scope = `project = ${quoteJql(this.config.projectKey)}`;
		return `${where ? `${scope} AND ${where}` : scope} ORDER BY ${order}`;
	}

	/**
	 * Every issue a JQL query matches, up to `limit`.
	 *
	 * Paged on the enhanced search's opaque `nextPageToken` rather than through
	 * {@link collectJiraPage}: `GET /rest/api/3/search/jql` is the one Jira operation
	 * that does not use the offset-paged `{ startAt, values }` envelope
	 * (`./client.ts` module header). The page cap is the same guard against an
	 * endless pager. Runs inside a credential scope (its callers do).
	 */
	private async searchIssues(
		jql: string,
		limit = Number.POSITIVE_INFINITY,
	): Promise<KeyedJiraIssue[]> {
		const collected: KeyedJiraIssue[] = [];
		let nextPageToken: string | undefined;
		for (let page = 0; page < MAX_PAGES; page++) {
			const response = await jiraRequest<JiraSearchResponse | undefined>('search/jql', {
				query: { jql, fields: ISSUE_FIELDS, maxResults: PAGE_SIZE, nextPageToken },
			});
			for (const issue of response?.issues ?? []) {
				if (!issue?.key) continue;
				collected.push({ ...issue, key: issue.key });
				if (collected.length >= limit) return collected;
			}
			nextPageToken = response?.nextPageToken ?? undefined;
			if (response?.isLast || !nextPageToken) return collected;
		}
		throw new Error(
			`Jira search pagination exceeded maximum page count of ${MAX_PAGES} — refusing to follow an endless pager`,
		);
	}

	/**
	 * Fill in the card's `taskRef` from its remote links — the one extra round trip
	 * per card this provider pays for the card↔artifact link, kept in a single helper
	 * so every call site paying it is visible. Runs inside a credential scope (its
	 * callers do).
	 */
	private async resolveTaskRef(item: WorkItem): Promise<WorkItem> {
		const links = await this.fetchRemoteLinks(item.id);
		return { ...item, taskRef: taskRefFromRemoteLinks(links, this.project.repo) };
	}

	/** One issue's remote links. Runs inside a credential scope (its callers do). */
	private async fetchRemoteLinks(key: string): Promise<JiraRemoteLink[]> {
		const links = await jiraRequest<JiraRemoteLink[] | undefined>(
			`issue/${encodeURIComponent(key)}/remotelink`,
		);
		return Array.isArray(links) ? links : [];
	}
}

/**
 * Build the Jira PM provider for a project. The one construction seam callers use,
 * so they depend on the `PMProvider` interface rather than the concrete class —
 * and, once a manifest exists, what `createProvider` points at.
 */
export function createJiraProvider(project: ProjectConfig): PMProvider {
	return new JiraPMProvider(project);
}
