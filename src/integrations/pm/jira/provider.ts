/**
 * JiraPMProvider — the concrete `PMProvider` (`src/pm/types.ts`) for Jira Cloud.
 * With this phase no contract method is a stub: the board reads and `discover`
 * landed first, and the writes (`moveWorkItem`, `addComment`, `createWorkItem`,
 * `updateWorkItem`, `addLabel`), the comment lookup, and the dependency gate
 * (`listBlockers`/`addBlockedBy`) complete it. Nothing registers this provider
 * yet — its ingress (router adapter, webhook, manifest) is a later phase, and a
 * provider registers only once *all* of that exists (ai/RULES.md §2 "Register
 * when the contract is satisfied, not when the folder appears", the sequencing
 * GitLab's #295 and Linear's #491 both used).
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
 * Three Jira-specific costs are deliberate and visible rather than hidden:
 * `taskRef` needs the issue's *remote links*, a second round trip per card, so it
 * is resolved only on the reads that answer with a single card; Jira indexes
 * nothing on a remote link's URL, so {@link JiraPMProvider.findWorkItemForArtifact}
 * is a capped scan rather than a lookup; and a status change is a **workflow
 * transition**, not a field write, so {@link JiraPMProvider.moveWorkItem} resolves
 * the transition that reaches the mapped status instead of assigning it.
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
	WorkItemLabel,
} from '../../../pm/types.js';
import { adfToPlainText, textToAdf } from './adf.js';
import { collectJiraPage, JiraApiError, type JiraPage, jiraRequest, MAX_PAGES } from './client.js';
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

/**
 * The `inward` description of Jira's built-in **Blocks** link type — the sentence
 * fragment Jira renders as "<this issue> is blocked by <that issue>", and the
 * signal {@link isBlockedByLinkType} matches a link type on. Matched on the
 * description rather than an id because link-type ids are per-instance.
 */
const BLOCKED_BY_INWARD = 'is blocked by';

/** The built-in link type's own name, the fallback when its descriptions were reworded. */
const BLOCKS_LINK_TYPE_NAME = 'blocks';

/**
 * Jira's status **category** key for a finished status. A Jira status carries no
 * open/closed boolean — every workflow status belongs to one of three categories
 * (`new`, `indeterminate`, `done`), and only `done` means finished.
 */
const DONE_STATUS_CATEGORY = 'done';

/**
 * The issue type {@link JiraPMProvider.createWorkItem} prefers when the project
 * offers it. Not a *mapping*: no config field names an issue type (issue #490's
 * non-goal), the project's own types are read and a standard one is picked.
 */
const PREFERRED_ISSUE_TYPE = 'task';

/** The fields a blocker is mapped from — its title and the status category behind `open`. */
const BLOCKER_FIELDS = 'summary,status';

/** One transition Jira offers out of an issue's *current* workflow status. */
interface JiraTransition {
	/** The transition's own id — what a transition POST names, never the status id. */
	id?: string;
	name?: string;
	/** The status the issue lands in once the transition executes. */
	to?: { id?: string; name?: string } | null;
}

/** `GET /rest/api/3/issue/{key}/transitions` — a bare object, not a page. */
interface JiraTransitionsResponse {
	transitions?: Array<JiraTransition | null> | null;
}

/** One Jira comment; `body` is an ADF document in REST v3, read through {@link adfToPlainText}. */
interface JiraComment {
	id?: string;
	body?: unknown;
}

/**
 * One page of `GET /rest/api/3/issue/{key}/comment`. Offset-paged like the rest of
 * REST v3, but its array is `comments` rather than the usual `values`, so it is
 * re-shaped into a {@link JiraPage} before {@link collectJiraPage} walks it.
 */
interface JiraCommentPage {
	comments?: Array<JiraComment | null> | null;
	startAt?: number | null;
	maxResults?: number | null;
	total?: number | null;
}

/** One issue type a project offers on create. `subtask` types cannot stand alone. */
interface JiraIssueType {
	id?: string;
	name?: string;
	subtask?: boolean;
}

/** The subset of `GET /rest/api/3/project/{key}` the create path reads. */
interface JiraProjectDetail {
	issueTypes?: Array<JiraIssueType | null> | null;
}

/** A link type's identity and its two direction descriptions. */
interface JiraLinkType {
	id?: string;
	name?: string;
	/** How the issue at the inward end relates ("is blocked by"). */
	inward?: string;
	/** How the issue at the outward end relates ("blocks"). */
	outward?: string;
}

/** `GET /rest/api/3/issueLinkType` — every link type the site defines. */
interface JiraIssueLinkTypesResponse {
	issueLinkTypes?: Array<JiraLinkType | null> | null;
}

/**
 * The other issue of one link, as `fields.issuelinks` embeds it: enough to report
 * a blocker without a second read per link.
 */
interface JiraLinkedIssue {
	key?: string;
	fields?: {
		summary?: string | null;
		status?: { statusCategory?: { key?: string } | null } | null;
	} | null;
}

/**
 * One entry of `fields.issuelinks`. Exactly one of the two issue sides is present,
 * and *which* one is the direction: an `inwardIssue` is reached by the type's
 * `inward` description ("this issue is blocked by that one"), an `outwardIssue` by
 * its `outward` one ("this issue blocks that one").
 */
interface JiraIssueLink {
	type?: JiraLinkType | null;
	inwardIssue?: JiraLinkedIssue | null;
	outwardIssue?: JiraLinkedIssue | null;
}

/** What `POST /rest/api/3/issue` answers with — the new issue's key. */
interface JiraCreatedIssue {
	id?: string;
	key?: string;
}

/** An Atlassian account as the issue reads select it. */
interface JiraUser {
	accountId?: string;
	displayName?: string | null;
	emailAddress?: string | null;
}

/**
 * The subset of `fields` a read asks for — {@link ISSUE_FIELDS} plus the two the
 * narrower reads add (`issuelinks` for the dependency gate, `statusCategory` for a
 * blocker's open state, which Jira nests inside `status` rather than exposing
 * separately). Every member is optional defensively.
 */
interface JiraIssueFields {
	summary?: string | null;
	/** An ADF document in REST v3 — read through {@link adfToPlainText}, never as a string. */
	description?: unknown;
	status?: { id?: string; name?: string; statusCategory?: { key?: string } | null } | null;
	labels?: Array<string | null> | null;
	assignee?: JiraUser | null;
	created?: string;
	updated?: string;
	issuelinks?: Array<JiraIssueLink | null> | null;
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

/** A link-type description, folded for comparison against Jira's own wording. */
function normalizeLinkText(value: string | undefined): string {
	return (value ?? '').trim().toLowerCase();
}

/**
 * Whether a link type is the one that expresses "blocked by". Matched on its
 * `inward` description first — that is the sentence Jira renders and the only
 * thing that states the direction — and on the built-in name as a fallback for a
 * site whose descriptions were reworded. Never on an id: link-type ids differ per
 * instance.
 */
function isBlockedByLinkType(type: JiraLinkType | null | undefined): boolean {
	return (
		normalizeLinkText(type?.inward) === BLOCKED_BY_INWARD ||
		normalizeLinkText(type?.name) === BLOCKS_LINK_TYPE_NAME
	);
}

/**
 * Map one linked/referenced issue onto a `WorkItemBlocker`.
 *
 * `reference` is the issue **key** (`SWARM-123`) rather than a number, because that
 * is what a person searches Jira for and what the deferral comment has to name.
 * `open` comes from the status **category**: Jira has no finished flag, and only
 * the `done` category means finished, so a workflow status of any name outside it
 * still gates dependent work.
 */
function toBlocker(
	issue: JiraLinkedIssue & { key: string },
	source: WorkItemBlocker['source'],
	config: JiraIntegrationConfig,
): WorkItemBlocker {
	return {
		id: issue.key,
		reference: issue.key,
		url: `${siteUrl(config)}/browse/${issue.key}`,
		title: issue.fields?.summary ?? '',
		open: issue.fields?.status?.statusCategory?.key !== DONE_STATUS_CATEGORY,
		source,
	};
}

/**
 * A Jira label is a single token — the API rejects one containing whitespace with
 * an opaque 400. Failing here instead names the constraint and the offending value.
 * `pipeline.automationLabel` defaults to `swarm`, so this is a guard on operator
 * config rather than a common path.
 */
function requireJiraLabel(name: string): string {
	if (/\s/.test(name)) {
		throw new Error(
			`Jira label '${name}' contains whitespace — Jira labels are single tokens and cannot contain spaces`,
		);
	}
	return name;
}

/**
 * Whether an error is Jira refusing a link it already holds. Only a backstop:
 * {@link JiraPMProvider.addBlockedBy} reads the existing links first, so this
 * covers the window between that read and the write. The wording could not be
 * confirmed against a live site, so — exactly as Linear's equivalent — anything it
 * does not match is rethrown rather than swallowed.
 */
function isDuplicateLinkError(error: unknown): boolean {
	return error instanceof Error && /duplicate|already (?:exists|linked)/i.test(error.message);
}

/** A status as an error message should name it: `'In Progress' (id 3)`. */
function describeStatus(status: JiraIssueFields['status']): string {
	if (!status?.id && !status?.name) return '<unknown>';
	return `'${status.name ?? '<unnamed>'}' (id ${status.id ?? '?'})`;
}

/** Every transition Jira offers, as `"<id>:<name> → <target> (<target id>)"`, for an actionable error. */
function describeTransitions(transitions: JiraTransition[]): string {
	const described = transitions.map(
		(transition) =>
			`${transition.id}:${transition.name ?? '<unnamed>'} → ${transition.to?.name ?? '<unnamed>'} (id ${transition.to?.id ?? '?'})`,
	);
	return described.length > 0 ? described.join(', ') : '<none>';
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
	// guard.
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

	/**
	 * Move a card by executing the **workflow transition** that lands it in the
	 * mapped status — Jira does not let a status be assigned like a field.
	 *
	 * Because the move runs *through* the workflow, a target can be legitimately
	 * unreachable from where the issue currently sits, and that is reported rather
	 * than absorbed: Cascade's adapter logs a warning and returns, which leaves the
	 * pipeline believing it reported progress while the board never moved. It also
	 * does **not** fall back to matching a transition by name — the board mapping
	 * stores status ids precisely so a rename cannot silently redirect a move.
	 */
	async moveWorkItem(id: string, status: string): Promise<void> {
		// Resolve the canonical key before the write: a status the board mapping
		// can't resolve is a config/logic error, not a value to send blindly — the
		// same fail-loud contract `listWorkItems` and the other two providers'
		// `moveWorkItem` keep (ai/CODING_STANDARDS.md "Error handling").
		const targetStatusId = requireStatusIdForStatusKey(this.config, status);
		await this.run(async () => {
			// A card already in the target status has no transition *to* it, and
			// re-requesting the status a card is already in is ordinary (`autoAdvance`
			// re-asserts it), so the no-op is answered before the workflow is consulted.
			const current = await this.fetchStatus(id);
			if (current?.id === targetStatusId) {
				logger.debug('pm: work item already in the requested status', { itemId: id, status });
				return;
			}
			const transitions = await this.fetchTransitions(id);
			const transition = transitions.find((candidate) => candidate.to?.id === targetStatusId);
			if (!transition) {
				throw new Error(
					`Jira issue '${id}' cannot reach canonical status '${status}' (Jira status id ${targetStatusId}): ` +
						`no transition out of its current status ${describeStatus(current)} targets it. ` +
						`Jira offers: ${describeTransitions(transitions)}. ` +
						"Fix the project's workflow or its statusOptions mapping.",
				);
			}
			await jiraRequest<void>(`issue/${encodeURIComponent(id)}/transitions`, {
				method: 'POST',
				body: { transition: { id: transition.id } },
			});
			logger.debug('pm: moved work item', { itemId: id, status, transition: transition.id });
		});
	}

	async addComment(id: string, text: string): Promise<string> {
		// Unlike GitHub Projects — whose board card has no comment thread, so the
		// comment is redirected onto the backing Issue — a Jira issue *is* the card,
		// and the comment lands natively on it. There is no backing artifact to
		// resolve first, and no draft-item case that leaves nowhere to post.
		return this.run(async () => {
			const comment = await jiraRequest<JiraComment | undefined>(
				`issue/${encodeURIComponent(id)}/comment`,
				{ method: 'POST', body: { body: textToAdf(text) } },
			);
			if (!comment?.id) {
				throw new Error(`Jira returned no comment id for the comment posted on issue '${id}'`);
			}
			return comment.id;
		});
	}

	async findComment(id: string, marker: string): Promise<string | undefined> {
		return this.run(async () => {
			// Every page, not just the first: an earlier delivery's marker can sit
			// beyond page 1, and missing it would post a duplicate on a retry — the
			// same reason the other two providers walk their whole thread. The body is
			// an ADF document, so the match runs on its plain text, which is what keeps
			// SWARM's `<!-- swarm-… -->` markers findable (`./adf.ts`).
			const comments = await this.fetchAllComments(id);
			return comments.find((comment) => comment.id && adfToPlainText(comment.body).includes(marker))
				?.id;
		});
	}

	/**
	 * Create a card in the requested status — three writes, because Jira requires an
	 * `issuetype` on create and cannot create an issue *into* an arbitrary status:
	 * create, transition, then read the card back so it maps exactly like one off a
	 * board read (resolved `statusKey`, label shape).
	 *
	 * A failing transition **throws** rather than warning and returning the card
	 * (Cascade warns): a child left in the workflow's initial status would never
	 * start, whereas Planning's retry is idempotent through
	 * {@link JiraPMProvider.findWorkItemByDescriptionMarker} — so a loud failure is
	 * recoverable and a silent one is not. The already-created issue is not rolled
	 * back; the retry adopts it.
	 */
	async createWorkItem(input: CreateWorkItemInput): Promise<WorkItem> {
		// Both validations run before the issue exists, so a bad mapping or an
		// unusable label fails without leaving a half-created card behind.
		requireStatusIdForStatusKey(this.config, input.status);
		const labels = (input.labels ?? []).map(requireJiraLabel);
		const key = await this.run(async () => {
			const issueTypeId = await this.resolveStandardIssueTypeId();
			const created = await jiraRequest<JiraCreatedIssue | undefined>('issue', {
				method: 'POST',
				body: {
					fields: {
						project: { key: this.config.projectKey },
						summary: input.title,
						description: textToAdf(input.description),
						issuetype: { id: issueTypeId },
						// Jira labels are free-form and auto-create, so the names go straight
						// on — there is no label object to resolve or create first, unlike
						// GitHub's and Linear's.
						...(labels.length > 0 ? { labels } : {}),
					},
				},
			});
			if (!created?.key) {
				throw new Error(`Jira returned no issue key for the created issue '${input.title}'`);
			}
			logger.debug('pm: created work item', { itemId: created.key, status: input.status });
			return created.key;
		});
		await this.moveWorkItem(key, input.status);
		return this.getWorkItem(key);
	}

	async updateWorkItem(id: string, patch: UpdateWorkItemPatch): Promise<void> {
		// Nothing to write is not an empty write: a `PUT` with no fields would still
		// touch the issue's `updated` timestamp for no reason.
		if (patch.title === undefined && patch.description === undefined) return;
		await this.run(async () => {
			await jiraRequest<void>(`issue/${encodeURIComponent(id)}`, {
				method: 'PUT',
				body: {
					fields: {
						...(patch.title !== undefined ? { summary: patch.title } : {}),
						...(patch.description !== undefined
							? { description: textToAdf(patch.description) }
							: {}),
					},
				},
			});
		});
		logger.debug('pm: updated work item', { itemId: id });
	}

	async addLabel(id: string, name: string): Promise<void> {
		requireJiraLabel(name);
		await this.run(async () => {
			// Re-applying a label the issue already carries is contractually a no-op,
			// so check before writing. Compared exactly, not case-insensitively: Jira
			// labels are case-sensitive, so `swarm` and `Swarm` are two labels.
			const issue = await jiraRequest<JiraIssue | undefined>(`issue/${encodeURIComponent(id)}`, {
				query: { fields: 'labels' },
			});
			if ((issue?.fields?.labels ?? []).includes(name)) return;
			// Jira's `update` verb is a set insert on the labels field. The alternative
			// — read every label and write the whole list back through `fields.labels`
			// (what Cascade does) — loses any label a concurrent writer added between
			// that read and the write; this has no such window.
			await jiraRequest<void>(`issue/${encodeURIComponent(id)}`, {
				method: 'PUT',
				body: { update: { labels: [{ add: name }] } },
			});
			logger.debug('pm: applied label', { itemId: id, label: name });
		});
	}

	async listBlockers(id: string): Promise<WorkItemBlocker[]> {
		return this.run(async () => {
			// Two sources, deduplicated by URL so a prerequisite that is both linked
			// and written down is reported once — as the native link, which is what
			// makes it a gate rather than a notice (issue #643): Jira's own "is blocked
			// by" issue links, and the prerequisites the item names in prose.
			const [native, mentioned] = await Promise.all([
				this.fetchNativeBlockers(id),
				this.fetchMentionedBlockers(id),
			]);
			return dedupeBlockers([...native, ...mentioned]);
		});
	}

	async addBlockedBy(id: string, blockerId: string): Promise<void> {
		await this.run(async () => {
			// Jira has no upsert for a link, so idempotence comes from reading the
			// links it already holds — re-chaining a split's phases must not fail on a
			// retry.
			const existing = await this.fetchNativeBlockers(id);
			if (existing.some((blocker) => blocker.id === blockerId)) return;
			const linkType = await this.resolveBlockedByLinkType();
			try {
				// `outwardIssue` is the *from* side of the link and `inwardIssue` the to
				// side, so this records "`blockerId` blocks `id`" — the same relationship
				// {@link JiraPMProvider.fetchNativeBlockers} reads back off `id` as an
				// `inwardIssue` entry.
				await jiraRequest<void>('issueLink', {
					method: 'POST',
					body: {
						type: { name: linkType },
						inwardIssue: { key: id },
						outwardIssue: { key: blockerId },
					},
				});
			} catch (error) {
				// A link recorded between the read above and this write: the pair is
				// linked, which is exactly what the caller asked for.
				if (!isDuplicateLinkError(error)) throw error;
				return;
			}
			logger.debug('pm: linked blocked-by dependency', { itemId: id, blockerId });
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

	/**
	 * The issue's current workflow status — the narrowest read there is, since the
	 * transition lookup needs only this. Runs inside a credential scope (its callers do).
	 */
	private async fetchStatus(id: string): Promise<JiraIssueFields['status']> {
		const issue = await jiraRequest<JiraIssue | undefined>(`issue/${encodeURIComponent(id)}`, {
			query: { fields: 'status' },
		});
		return issue?.fields?.status;
	}

	/**
	 * The transitions Jira offers out of the issue's current status, narrowed to the
	 * ones that name both themselves and a target status — a transition missing
	 * either can be neither matched nor executed. Runs inside a credential scope
	 * (its callers do).
	 */
	private async fetchTransitions(id: string): Promise<JiraTransition[]> {
		const response = await jiraRequest<JiraTransitionsResponse | undefined>(
			`issue/${encodeURIComponent(id)}/transitions`,
		);
		return (response?.transitions ?? []).filter((transition): transition is JiraTransition =>
			Boolean(transition?.id && transition.to?.id),
		);
	}

	/**
	 * One page of the issue's comment thread, re-shaped into the offset-paged
	 * envelope {@link collectJiraPage} walks — the comment operation names its array
	 * `comments` rather than `values`. Runs inside a credential scope (its callers do).
	 */
	private async fetchCommentPage(id: string, startAt: number): Promise<JiraPage<JiraComment>> {
		const page = await jiraRequest<JiraCommentPage | undefined>(
			`issue/${encodeURIComponent(id)}/comment`,
			{ query: { startAt, maxResults: PAGE_SIZE } },
		);
		return { ...page, values: page?.comments ?? [] };
	}

	/** The whole comment thread. Runs inside a credential scope (its callers do). */
	private async fetchAllComments(id: string): Promise<JiraComment[]> {
		return collectJiraPage<JiraComment>((startAt) => this.fetchCommentPage(id, startAt));
	}

	/**
	 * The issues Jira itself records as blocking this one.
	 *
	 * Direction is carried by *which side* of the link the entry names, not by the
	 * link type: an entry with an `inwardIssue` is reached by the type's `inward`
	 * description, so under the Blocks type it reads "this issue **is blocked by**
	 * that one". An `outwardIssue` entry says the opposite ("this issue blocks that
	 * one") and gates nothing here — so the test fixture carries both directions and
	 * asserts which one comes back.
	 *
	 * Runs inside a credential scope (its callers do).
	 */
	private async fetchNativeBlockers(id: string): Promise<WorkItemBlocker[]> {
		const links = await this.fetchIssueLinks(id);
		return links
			.filter(
				(link): link is JiraIssueLink & { inwardIssue: JiraLinkedIssue & { key: string } } =>
					isBlockedByLinkType(link.type) && Boolean(link.inwardIssue?.key),
			)
			.map((link) => toBlocker(link.inwardIssue, 'dependency', this.config));
	}

	/** One issue's links. Runs inside a credential scope (its callers do). */
	private async fetchIssueLinks(id: string): Promise<JiraIssueLink[]> {
		const issue = await jiraRequest<JiraIssue | undefined>(`issue/${encodeURIComponent(id)}`, {
			query: { fields: 'issuelinks' },
		});
		return (issue?.fields?.issuelinks ?? []).filter((link): link is JiraIssueLink => Boolean(link));
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
	 * only the native issue link below actually defers work.
	 *
	 * **Known limitation:** the shared heuristic recognises the numeric `#N` and
	 * `/issues/N` forms, not Jira's own `SWARM-123` notation — widening it would
	 * change GitHub's behaviour too, so it is out of scope here. A prerequisite
	 * written only in Jira's own notation is therefore guarded by the native issue
	 * link above, not by this scan. A bare `#N` is resolved as this project's own
	 * issue `<projectKey>-N` and nowhere else, so a number naming some other
	 * project's issue resolves to nothing rather than to the wrong card.
	 *
	 * Only the first page of comments is scanned, matching the other two providers:
	 * a prose dependency buried past comment #100 is missed, but the native link and
	 * the description remain the durable guards, and this check runs on every gated
	 * dispatch.
	 *
	 * Runs inside a credential scope (its callers do).
	 */
	private async fetchMentionedBlockers(id: string): Promise<WorkItemBlocker[]> {
		const [issue, comments] = await Promise.all([
			jiraRequest<JiraIssue | undefined>(`issue/${encodeURIComponent(id)}`, {
				query: { fields: 'description' },
			}),
			this.fetchCommentPage(id, 0),
		]);
		const prose = dependencyProse(
			adfToPlainText(issue?.fields?.description),
			(comments.values ?? []).map((comment) =>
				comment ? adfToPlainText(comment.body) : undefined,
			),
		);
		const keys = findDependencyReferences(prose)
			.map((reference) => `${this.config.projectKey}-${reference}`)
			.filter((key) => key !== id);
		const resolved = await Promise.all(keys.map((key) => this.findBlockerByKey(key)));
		return resolved.filter((blocker): blocker is WorkItemBlocker => blocker !== undefined);
	}

	/**
	 * Resolve one referenced issue key to a blocker. A key that resolves to nothing
	 * is skipped rather than raised: a typo'd number, or one naming a GitHub issue
	 * rather than a Jira one, is not a gate — the same soft miss Linear's mention
	 * lookup makes. Runs inside a credential scope (its callers do).
	 */
	private async findBlockerByKey(key: string): Promise<WorkItemBlocker | undefined> {
		try {
			const issue = await jiraRequest<JiraIssue | undefined>(`issue/${encodeURIComponent(key)}`, {
				query: { fields: BLOCKER_FIELDS },
			});
			return issue?.key
				? toBlocker({ ...issue, key: issue.key }, 'mention', this.config)
				: undefined;
		} catch (error) {
			// Only "there is no such issue" is a miss; anything else (a permission
			// failure, an outage) is a real error the gate must not swallow.
			if (error instanceof JiraApiError && error.status === 404) return undefined;
			throw error;
		}
	}

	/**
	 * The **name** of this site's "is blocked by" link type — what a link write
	 * names it by. Resolved from the site rather than assumed to be the English
	 * built-in `Blocks`, since link types are site data an administrator can rename
	 * or delete. Runs inside a credential scope (its callers do).
	 */
	private async resolveBlockedByLinkType(): Promise<string> {
		const response = await jiraRequest<JiraIssueLinkTypesResponse | undefined>('issueLinkType');
		const types = (response?.issueLinkTypes ?? []).filter((type): type is JiraLinkType =>
			Boolean(type?.name),
		);
		// The `inward` description states the direction, so it decides; the built-in
		// name is only the fallback for a site that reworded its descriptions.
		const match =
			types.find((type) => normalizeLinkText(type.inward) === BLOCKED_BY_INWARD) ??
			types.find((type) => isBlockedByLinkType(type));
		if (!match?.name) {
			throw new Error(
				`Jira site '${siteUrl(this.config)}' defines no '${BLOCKED_BY_INWARD}' issue link type, so a ` +
					`dependency cannot be recorded. It offers: ${types.map((type) => type.name).join(', ') || '<none>'}.`,
			);
		}
		return match.name;
	}

	/**
	 * The issue type a new card is created as. Jira requires one on create, and
	 * SWARM's contract has no issue-type concept, so the project's *own* types are
	 * read and a standard one picked — one named `Task` when the project offers it,
	 * else the first non-subtask type. A sub-task cannot stand alone (it needs a
	 * parent), so those are never eligible.
	 *
	 * Deliberately **not** an issue-type mapping: no config field is added, which is
	 * what issue #490's non-goal forbids. Runs inside a credential scope (its
	 * callers do).
	 */
	private async resolveStandardIssueTypeId(): Promise<string> {
		const project = await jiraRequest<JiraProjectDetail | undefined>(
			`project/${encodeURIComponent(this.config.projectKey)}`,
		);
		const usable = (project?.issueTypes ?? []).filter(
			(issueType): issueType is JiraIssueType & { id: string } =>
				Boolean(issueType?.id) && !issueType?.subtask,
		);
		const preferred =
			usable.find((issueType) => issueType.name?.toLowerCase() === PREFERRED_ISSUE_TYPE) ??
			usable[0];
		if (!preferred) {
			throw new Error(
				`Jira project '${this.config.projectKey}' offers no standard (non-subtask) issue type to create an issue as`,
			);
		}
		return preferred.id;
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
