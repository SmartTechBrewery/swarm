/**
 * PM Provider abstraction — the shared, provider-agnostic contract the router,
 * trigger, and dispatch code program against so none of them ever branch on a
 * concrete provider (ai/CODING_STANDARDS.md "Module shape for a provider").
 *
 * Mirrors Cascade's `src/pm/types.ts`, scoped down to SWARM's MVP: Cascade
 * ships Trello/JIRA/Linear and a much wider surface (checklists, attachments,
 * custom fields, PR linking); SWARM has exactly one *implemented* PM provider —
 * GitHub Projects (v2) — and this interface carries only the operations the
 * pipeline actually performs. The rest are deliberately left out until a second
 * provider or a phase actually needs them; adding them speculatively would be a
 * standards violation (ai/CODING_STANDARDS.md "Comments" / "don't build it
 * speculatively").
 *
 * This file defines types plus two closed value vocabularies ({@link PM_TYPES},
 * {@link PM_DISCOVERY_CAPABILITIES}) and imports nothing at runtime, so importing
 * it still adds no dependency edge of its own — the same shape `src/scm/types.ts`
 * has. The two companion halves of the PM contract are `src/pm/events.ts` (the Zod
 * normalized inbound event, which crosses the queue boundary) and
 * `src/pm/router-adapter.ts` (the ingress interface). The adapter that implements
 * all three against the GitHub Projects GraphQL API lives under
 * `src/integrations/pm/github-projects/`.
 *
 * IDs are plain `string` at this interface, on purpose: the contract is
 * provider-agnostic, so it can't name GitHub-specific branded types
 * (`src/pm/ids.ts`). The adapter brands them internally at its boundary
 * (`parseWorkItemId` on the way in, `unwrap` on the way out) — same split
 * Cascade uses, where the shared interface speaks `string` and each adapter
 * narrows to its own branded IDs.
 */

/**
 * Every PM provider id SWARM's shared surface recognizes. It was widened past the
 * one implemented provider as *vocabulary* first, exactly as `ScmType`
 * (`src/scm/types.ts`) named `bitbucket`/`gitlab` before either registered, so a
 * new connector's own issue adds a folder and a manifest rather than editing the
 * shared type. All four now have one — `linear` (issue #530), `jira` (#580), and
 * `trello` (#588) — so every value resolves; an id whose manifest is *not*
 * registered still makes `getPMProvider` return `null` and
 * {@link import('../integrations/pm/registry.js').requireProjectPMProvider}
 * throw a wiring-bug error, which is how the next provider's phases stay
 * unreachable until it is complete.
 *
 * Stated as values rather than a bare union, exactly as {@link SCM_TYPES}
 * (`src/scm/types.ts`) is: the config schema's `credentials.pm` key check
 * (`src/config/schema.ts`, issue #631) has to answer "is this string a PM provider
 * id?" at runtime, without depending on which provider modules a process imported.
 * {@link PMType} is derived from the list so the two cannot drift, and
 * `PmProviderIdSchema` (`src/pm/events.ts`) is built from it for the same reason.
 */
export const PM_TYPES = ['github-projects', 'jira', 'linear', 'trello'] as const;
export type PMType = (typeof PM_TYPES)[number];

/**
 * The discovery capabilities the board-mapping screen needs a provider to answer:
 * enumerate the provider's selectable boards (`containers`) and, for one selected
 * board, its workflow states (`states`). Kept as one `as const` constant so the
 * runtime capability list ({@link PMProviderManifest.discovery}) and the
 * TypeScript {@link PMDiscoveryCapability} union can't drift apart.
 *
 * Provider-neutral on purpose (`containers`/`states`, not GitHub's `board`/
 * `Status field`): a GitHub Projects board, a Jira project, and a Trello board
 * are all "containers"; a GitHub Status option, a Jira workflow status, and a
 * Trello list are all "states". Mapping those neutral concepts to a provider's
 * own vocabulary stays inside the adapter (ai/RULES.md §2).
 */
export const PM_DISCOVERY_CAPABILITIES = ['containers', 'states'] as const;

/** One discovery capability a provider may declare and answer (see {@link PM_DISCOVERY_CAPABILITIES}). */
export type PMDiscoveryCapability = (typeof PM_DISCOVERY_CAPABILITIES)[number];

/**
 * A selectable board/project/list a provider exposes — an opaque `id` (persisted
 * as the board mapping), a human-readable `name` for the picker, and an optional
 * `url` the picker can link to. No provider-specific fields: a GitHub Projects v2
 * node ID, a Jira project key, and a Trello board ID all reduce to `id`.
 */
export interface DiscoveredContainer {
	id: string;
	name: string;
	url?: string;
}

/**
 * One workflow state within a selected container — an opaque `id` (a GitHub
 * Status single-select option ID, a Jira transition, a Trello list) and a
 * human-readable `name`. The mapping screen maps each canonical SWARM status to
 * one of these.
 */
export interface DiscoveredState {
	id: string;
	name: string;
}

/** Result of the `containers` capability. */
export interface ContainerDiscoveryResult {
	containers: DiscoveredContainer[];
}

/**
 * Result of the `states` capability. `providerContext` carries any extra opaque
 * scope the provider needs threaded back to save time without naming it in the
 * shared contract — GitHub Projects returns the selected board's Status *field*
 * ID here (`{ statusFieldId }`), which the mapping needs alongside the option
 * IDs. A provider whose states need no extra scope omits it.
 */
export interface StateDiscoveryResult {
	states: DiscoveredState[];
	providerContext?: Record<string, string>;
}

/** Arguments for the `states` capability — the opaque id of the selected container. */
export interface DiscoverStatesArgs {
	containerId: string;
}

/** Maps each discovery capability to the arguments it takes. */
export interface PMDiscoveryArgs {
	containers: Record<string, never>;
	states: DiscoverStatesArgs;
}

/** Maps each discovery capability to the result shape it returns. */
export interface PMDiscoveryResult {
	containers: ContainerDiscoveryResult;
	states: StateDiscoveryResult;
}

export interface WorkItemLabel {
	id: string;
	name: string;
	color?: string;
}

/**
 * Who a work item is assigned to, in provider-neutral terms. `handle` is the
 * provider's login/handle for the person (a GitHub login, a Jira account
 * identifier); SWARM resolves it to one of its own users through the identity
 * link (`src/identity/assignee-resolver.ts`) rather than pattern-matching a
 * GitHub identity shape anywhere in shared code (ai/RULES.md §2).
 *
 * `providerId` is the provider's own stable id for the account when it exposes
 * one. A handle can be renamed by its owner, so it is the field to re-link
 * against when a link goes stale — nothing routes on it today.
 */
export interface WorkItemAssignee {
	handle: string;
	/** Human-friendly display name when the provider exposes one. */
	displayName?: string;
	/** Provider-native account id, when available. Informational. */
	providerId?: string;
}

export interface WorkItem {
	/** The provider-native item ID — a GitHub Projects v2 item node ID. */
	id: string;
	title: string;
	description: string;
	/** Web URL of the backing Issue/PR the card wraps. */
	url: string;
	/**
	 * The SCM artifact reference SWARM keys its worktree, branch, and PR on for this
	 * card — the issue/PR number for a card backed by one. The provider resolves it
	 * from its own linkage (GitHub Projects: the backing Issue/PR); `undefined` when
	 * the card has no SCM artifact, in which case no SCM-driven phase can run for it.
	 *
	 * A number alone names nothing, so it never travels alone: read it together with
	 * {@link taskRepository}, and treat a reference whose repository is not the one
	 * your run acts on as *not this run's artifact* — the same skip as `undefined`.
	 *
	 * A field rather than a new {@link PMProvider} method, for the same reason as
	 * {@link statusKey}: the provider already holds the linkage during its own board
	 * read, so the reference rides along with the item instead of costing a second
	 * lookup — and the method surface stays as it is. It exists so no *shared*
	 * module has to recover the number by regexing a GitHub-shaped `url`
	 * (ai/RULES.md §2); see ai/ARCHITECTURE.md "Task identity" for why `taskId`
	 * stays SCM-derived rather than becoming the PM provider's own key.
	 */
	taskRef?: string;
	/**
	 * The repository {@link taskRef}'s artifact number belongs to, as `owner/repo`,
	 * read from the same linkage `taskRef` came from — so the pair is meaningful
	 * together and neither half is a guess (issue #710). The two are set and unset
	 * together; a reference arriving without one (an older transport frame, a
	 * provider that could not read the repository) is unplaceable and is treated as
	 * the same miss as no reference at all.
	 *
	 * Three things make it load-bearing:
	 *
	 * - **A bare number names nothing.** `#42` is an artifact only once you know the
	 *   repository numbering it, so a caller that keys a worktree, a branch, or a
	 *   pull request on {@link taskRef} has to check this first.
	 * - **The provider fills it from the *card's own* linkage**, never from the
	 *   repository its `ProjectConfig` happens to be scoped to. That is what lets a
	 *   board-wide read answer per card: a board is project-wide, so one page can
	 *   hold cards linked in several of the project's repositories.
	 * - **Whether that repository is one the project owns is the caller's decision**,
	 *   not the provider's: a provider is built from a config *scoped to one
	 *   repository*, which deliberately carries no repository list at all
	 *   (`scopeProjectToRepository`, `src/config/project-repository.ts`;
	 *   ai/ARCHITECTURE.md "Project record vs. scoped project config"). So the
	 *   provider reports honestly and the caller — which holds the run's scoped
	 *   `project.repo` — refuses what is not for it (`repoSlugsMatch`,
	 *   `src/scm/repo-slug.ts`, so casing and a `.git` suffix are noise).
	 */
	taskRepository?: string;
	/** Human-readable Status option name (e.g. `In progress`) when available. */
	status?: string;
	/**
	 * Provider-native Status option ID (a GitHub Projects `SingleSelectOptionId`,
	 * e.g. `47fc9ee4`) when available. Stable across renames — prefer this over
	 * `status` for logic; `status` is display-only.
	 */
	statusId?: string;
	/**
	 * The canonical SWARM pipeline status key (`PM_STATUS_KEYS`,
	 * `src/pm/pipeline.ts`) this item's status maps to, or `undefined` when it maps
	 * to none. The provider owns the translation from its opaque native status
	 * ({@link statusId}) — shared code resolves a pipeline phase from this key and
	 * never from a board option id (ai/RULES.md §2).
	 *
	 * A plain field rather than a new {@link PMProvider} method: every provider
	 * already resolves this on the way out of its own board read, so the mapping
	 * rides along with the item instead of costing a second lookup that would need
	 * the provider's config at the call site.
	 */
	statusKey?: string;
	labels: WorkItemLabel[];
	/**
	 * Who the item is assigned to — always present, `[]` when nobody is assigned
	 * or the provider has no assignee concept ({@link PMProvider.supportsAssignees}
	 * is `false`), same non-optional-array convention as {@link labels}.
	 */
	assignees: WorkItemAssignee[];
	/** ISO 8601 creation timestamp as reported by the provider, when available. */
	createdAt?: string;
	/** ISO 8601 last-update timestamp as reported by the provider, when available. */
	updatedAt?: string;
}

/** A provider-neutral reference to the backing artifact a board card wraps. */
export interface WorkItemArtifact {
	/** Repository identity in the provider's normal owner/name form. */
	repository: string;
	/** The artifact category. Providers translate this to their native URL or identifier shape. */
	kind: 'issue' | 'pullRequest';
	/** Provider-visible artifact number. */
	number: string;
}

/**
 * Fields for creating a new work item — a fresh backing Issue added to the
 * board. Used by Planning's task-splitting to spawn the sibling tasks a large
 * item decomposes into. Provider-agnostic on purpose: `status` is a canonical
 * SWARM status key (the adapter resolves it to a board option ID), and `labels`
 * are label *names* (the adapter ensures they exist and applies them).
 */
export interface CreateWorkItemInput {
	title: string;
	description: string;
	/**
	 * Canonical SWARM pipeline status key the new item should start in (e.g.
	 * `planning` — `PM_STATUS_KEYS` in `src/pm/pipeline.ts`). The adapter resolves
	 * it to the board's option ID.
	 */
	status: string;
	/** Label names to apply to the new item's backing Issue at creation. */
	labels?: string[];
}

/** A patch of mutable work-item fields for {@link PMProvider.updateWorkItem}. */
export interface UpdateWorkItemPatch {
	/** New title for the backing Issue. Omit to leave unchanged. */
	title?: string;
	/** New description/body for the backing Issue. Omit to leave unchanged. */
	description?: string;
}

/**
 * A prerequisite that blocks a work item — enough to gate a run on it and to
 * name it in a comment or a deferral message. Returned by
 * {@link PMProvider.listBlockers}. Provider-agnostic: no GitHub-specific fields.
 */
export interface WorkItemBlocker {
	/**
	 * The blocker's provider-native work-item id when it is itself a card on the
	 * board, else undefined (a dependency referenced only in prose may point at an
	 * issue that was never added to the board). Callers gate on {@link open}, not
	 * on this.
	 */
	id?: string;
	/** Human-readable reference for logs/comments/messages — e.g. an issue number `#319`. */
	reference: string;
	/** Web URL of the blocking issue/item. */
	url: string;
	/** Title of the blocking issue/item, for human-readable messages. */
	title: string;
	/** Whether the blocker is still unfinished — a still-`open` blocker gates dependent work. */
	open: boolean;
	/**
	 * How the dependency was found: a `dependency` relationship the provider models
	 * natively, or a `mention` parsed from the item's own description/comments.
	 *
	 * **This decides the blocker's authority, not just its wording** (issue #643).
	 * Only `dependency` defers a run; a `mention` is surfaced for a human and never
	 * becomes a scheduling constraint, because prose that *discusses* a dependency
	 * reads the same as prose that *declares* one — see `src/pm/dependencies.ts`'s
	 * module comment for the two runs that proved it. A provider must therefore set
	 * this accurately: reporting a prose reference as `dependency` re-creates the
	 * defect, and reporting a real relationship as `mention` silently drops a gate.
	 */
	source: 'dependency' | 'mention';
}

/**
 * An item that this work item blocks — the **reverse** edge of
 * {@link WorkItemBlocker}, returned by {@link PMProvider.listDependents}. Enough
 * to recognise it in the blocker list and to name it in a log line.
 *
 * It carries no `source`, unlike a blocker: this read is **native by
 * definition**. Its whole purpose is to answer "does the provider's own
 * dependency graph already say the proposed blocker is waiting on *me*?", and a
 * prose-derived answer could not settle that — it would let the same heuristic
 * that invented a blocker also excuse it (issue #639, `ai/ARCHITECTURE.md`
 * "Pipeline phases" → Implementation).
 */
export interface WorkItemDependent {
	/**
	 * The dependent's provider-native work-item id when the provider's reverse read
	 * yields one, else undefined. GitHub's does not — it answers with *issues*, not
	 * board items — so callers match on {@link url} / {@link reference} rather than
	 * on this.
	 */
	id?: string;
	/** Human-readable reference for logs/messages — e.g. an issue number `#633`. */
	reference: string;
	/** Web URL of the dependent issue/item — the identity a blocker is matched on. */
	url: string;
	/** Title of the dependent issue/item, for human-readable messages. */
	title: string;
	/** Whether the dependent is still unfinished. Informational: a cycle is a cycle either way. */
	open: boolean;
}

/**
 * One repository a board card may be routed to, as {@link
 * PMProvider.resolveItemRepository} is handed it (issue #686 phase 1) — the
 * repository's own slug plus the provider-native id a card carries to claim it.
 *
 * The candidates are **passed in as data** rather than read from the provider's
 * config, and that is the point: a PM provider is built from a `ProjectConfig`
 * *scoped to one repository*, which deliberately carries no repository list at all
 * (`scopeProjectToRepository`, `src/config/project-repository.ts`; ai/ARCHITECTURE.md
 * "Project record vs. scoped project config"). The caller holds the `ProjectRecord`
 * and therefore the list; the provider keeps its list-free scope.
 *
 * `routingToken` is an **id, never a name** — a Jira component id, a Linear label
 * id, a Trello label id — matched exactly. An entry that declares none claims
 * nothing. GitHub Projects ignores the field entirely: a card there wraps one
 * backing Issue/PR, whose own repository is authoritative.
 */
export interface RepositoryRoutingCandidate {
	/** The repository this candidate names, as `owner/repo` (a `ProjectRepository.repo`). */
	repo: string;
	/** The provider-native id a card carries to claim it for this repository, when it declares one. */
	routingToken?: string;
}

/**
 * Which of a project's repositories a board card belongs to — the answer
 * {@link PMProvider.resolveItemRepository} returns.
 *
 * Three states rather than `string | undefined`, so "claimed by more than one" is a
 * first-class answer a caller cannot accidentally coerce into a pick: routing a card
 * to the wrong repository would push a branch and open a pull request where nobody
 * asked for one, so a provider reports the ambiguity and lets the caller refuse.
 * `unrouted` is the same refusal for a card that claims nothing — never a guess at
 * the default entry, which is the caller's policy to apply, not the provider's.
 */
export type ItemRepositoryRoute =
	| { status: 'routed'; repo: string }
	| { status: 'unrouted' }
	/** Every claimed repository, sorted, so a message naming them is stable. */
	| { status: 'ambiguous'; repos: string[] };

/** Optional server-side filters for {@link PMProvider.listWorkItems}. */
export interface ListWorkItemsFilter {
	/**
	 * A canonical SWARM pipeline status key (e.g. `backlog`, `planning`, `todo`,
	 * `inProgress`, `inReview`, `done` — `PM_STATUS_KEYS` in `src/pm/pipeline.ts`
	 * is the source of truth) — the same keys used in the config's
	 * `statusOptions` map. The adapter resolves it to a `SingleSelectOptionId`
	 * and filters the board's items by that Status option. Omit to list every
	 * item on the board.
	 */
	status?: string;
}

/**
 * The contract every SWARM PM provider implements: the operations the pipeline
 * (ai/ARCHITECTURE.md "Pipeline phases") needs to read the board, create and
 * update items, move a card through it, gate on dependencies, and report back —
 * plus the optional `discover` the board-mapping screen dispatches through the
 * manifest. The *inbound* half of a provider is the separate
 * {@link import('./router-adapter.js').PMRouterAdapter}.
 *
 * ## One-card lookups are lookups, not scans
 *
 * {@link PMProvider.findWorkItemByUrlSuffix},
 * {@link PMProvider.findWorkItemForArtifact} and
 * {@link PMProvider.findWorkItemByDescriptionMarker} each take one key and answer
 * with at most one card. They exist **so that nothing has to read the whole
 * board** — a federated worker resolves its card through the control plane
 * (`src/pm/transport-delivery.ts`), and proxying a board to find one card is the
 * heavy alternative they were widened out of the interface to avoid
 * (ai/RULES.md §2).
 *
 * That is a cost contract, not only a signature, and issue #735 is what happens
 * when it is honoured at the surface and given back inside: every implementation
 * answered by calling `listWorkItems()` and filtering, four GitHub GraphQL pages
 * per lookup against a 325-card board, until the board credential's hourly budget
 * ran out and took a day's dispatches with it. So, implementing one of the three:
 *
 * - **Address the backend with the key you were given.** The artifact
 *   coordinates, the marker, and the URL suffix are all specific enough to query
 *   with; resolve the card through the provider's own index, linkage or
 *   identifier grammar.
 * - **Cost must not grow with the board.** The requests a lookup issues are the
 *   same for a 30-card board and a 3000-card one — or the growth is explicitly
 *   bounded, logged when the bound bites, and stated in the method's own comment
 *   (the shape Jira's remote-link scan already documents).
 * - **A key your URL grammar cannot produce is a free miss.** A provider whose
 *   cards are `linear.app/…/issue/ENG-1` can answer a `/issues/100` suffix
 *   `undefined` without a request at all — the same honest miss as today, minus
 *   the board read that discovered it.
 * - **Say so where you cannot.** A provider with no index for a key states that
 *   in its own module, in its own words, rather than silently scanning — so the
 *   next provider copies the declaration and not the scan.
 *
 * `tests/unit/integrations/pm/pm-conformance.test.ts` holds the mechanical floor:
 * no registered provider's one-card lookup may call `listWorkItems`.
 */
export interface PMProvider {
	readonly type: PMType;

	/**
	 * Read a single work item by its provider-native ID.
	 *
	 * Throws if the ID doesn't resolve — a work item ID SWARM holds comes from a
	 * webhook payload or a prior board read, so a non-resolving ID is bad input,
	 * not a soft "not found" (ai/CODING_STANDARDS.md "Error handling").
	 */
	getWorkItem(id: string): Promise<WorkItem>;

	/**
	 * List work items on the board, optionally filtered by status. A SWARM
	 * project maps to exactly one board (ai/ARCHITECTURE.md "Single-user scope"),
	 * so there's no container argument — unlike Cascade, whose providers span
	 * multiple Trello lists / JIRA projects.
	 */
	listWorkItems(filter?: ListWorkItemsFilter): Promise<WorkItem[]>;

	/**
	 * Find the one board item whose backing Issue/PR `url` **ends with**
	 * `urlSuffix` (e.g. `/issues/100`), or `undefined` when no card wraps it.
	 *
	 * A soft miss, unlike {@link getWorkItem}: the caller knows the card only by
	 * its backing artifact — Respond-to-review resolves the card for the issue its
	 * PR branch names — and "that issue isn't on the board" is an ordinary answer,
	 * not bad input.
	 *
	 * Provider-agnostic by construction: it matches on `url`, the generic field
	 * every provider populates (ai/RULES.md §2), so no caller pattern-matches a
	 * GitHub URL shape itself. A *suffix* rather than a whole URL because the
	 * caller knows the backing artifact's tail, not the host and owner/repo path a
	 * provider's URLs carry. A suffix beginning at a path separator can't
	 * false-match a longer number (`/issues/100` vs `/issues/1001`).
	 *
	 * Subject to the one-card lookup rule on {@link PMProvider}: a suffix is a key
	 * to resolve the card by — usually through the provider's own identifier
	 * grammar — never a predicate to filter a board read with. A suffix that
	 * provider's URLs could never end with is a miss it can answer for free.
	 */
	findWorkItemByUrlSuffix(urlSuffix: string): Promise<WorkItem | undefined>;

	/**
	 * Find the board card wrapping one repository-scoped backing artifact, or
	 * `undefined` when that artifact is not on the board. Unlike
	 * {@link findWorkItemByUrlSuffix}, this lookup cannot confuse cards from two
	 * repositories that happen to use the same issue or pull-request number.
	 *
	 * Subject to the one-card lookup rule on {@link PMProvider}: the artifact's
	 * `repository`/`kind`/`number` are enough to address the provider's own
	 * linkage — an attachment, a remote link, or the artifact's own board
	 * membership — so the board is not the thing to read.
	 */
	findWorkItemForArtifact(artifact: WorkItemArtifact): Promise<WorkItem | undefined>;

	/**
	 * Find the one board item whose `description` **contains** `marker`, or
	 * `undefined` when no card carries it.
	 *
	 * The narrow, one-card form of a board search, exactly like
	 * {@link findWorkItemByUrlSuffix}: one marker in, at most one card out — which
	 * is what lets a federated worker ask the control plane "is the card I already
	 * created still there?" (`src/pm/transport-delivery.ts`). Subject to the
	 * one-card lookup rule on {@link PMProvider}, with one constraint of its own
	 * that overrides the cheapest option: the caller is Planning's *retried* split,
	 * so a child created seconds ago must be findable **now**. An
	 * eventually-consistent search index that answers "no" to a card that exists
	 * makes the guard create a second child — the exact failure this lookup
	 * prevents.
	 *
	 * So a provider prefers a **consistent** read over its text index, and where it
	 * has no consistent read that can answer the marker, it says which one it chose
	 * and what that costs. The registered three divide on exactly that: GitHub
	 * Projects reads the project repository's newest issue bodies rather than
	 * GitHub's search, and Trello scans its board rather than `/search`, both
	 * consistent; **Jira uses its `description ~` text index and states the risk**,
	 * because nothing else it exposes narrows on description text at all, and the
	 * alternative — the whole-board scan this rule exists to remove — trades the
	 * duplicate-child window for the board-budget failure of issue #735.
	 *
	 * A soft miss rather than a throw, for the same reason as
	 * {@link findWorkItemByUrlSuffix}: "nothing on the board carries that marker"
	 * is the ordinary answer, which the caller acts on by creating the item.
	 *
	 * Provider-agnostic by construction — it matches on `description`, the generic
	 * field every provider fills from its own body/description text, so no caller
	 * pattern-matches a provider-specific shape (ai/RULES.md §2). Callers pass a
	 * marker specific enough that at most one item can carry it, exactly as
	 * {@link findComment} requires for comments: Planning's split stamps every child
	 * it creates with one keyed on the delivery and the child's index, so a retried
	 * delivery recognises the child it already created instead of spawning a second
	 * one (`applySplit`, `src/pipeline/planning.ts`).
	 */
	findWorkItemByDescriptionMarker(marker: string): Promise<WorkItem | undefined>;

	/**
	 * Move a work item to a new pipeline status. `status` is a canonical SWARM
	 * pipeline key (e.g. `inProgress`), which the adapter resolves through the
	 * config's `statusOptions` map to a `SingleSelectOptionId` and writes to the
	 * board's Status field via `updateProjectV2ItemFieldValue`
	 * (docs/github-projects-v2-api.md §4).
	 */
	moveWorkItem(id: string, status: string): Promise<void>;

	/**
	 * Post a comment carrying agent output (a plan, review notes) and return the
	 * created comment's ID.
	 *
	 * GitHub Projects v2 items have **no native comment thread**
	 * (docs/github-projects-v2-api.md §4 → Comments), so the comment lands on the
	 * Issue/PR the item's card wraps, not on the board. `id` is still the work
	 * item ID; resolving it to the backing Issue/PR is the adapter's job.
	 */
	addComment(id: string, text: string): Promise<string>;

	/**
	 * Find an existing comment on the backing Issue/PR of a work item by a unique
	 * `marker` substring (e.g. a per-delivery idempotency marker), scanning *all*
	 * comment pages — not just the first — so a marker beyond page 1 is still found.
	 * Returns the matching comment's ID if found, else undefined. Callers pass a
	 * marker specific enough that at most one comment can contain it, so a match is
	 * unambiguous.
	 */
	findComment(id: string, marker: string): Promise<string | undefined>;

	/**
	 * Create a new work item on the board (a fresh backing Issue added to the
	 * project) in the given status, and return it. Planning's task-splitting uses
	 * this to spawn the sibling tasks a too-large item decomposes into.
	 *
	 * Widening the interface (rather than special-casing GitHub Projects at the
	 * call site) keeps splitting provider-agnostic — a future Jira/Linear provider
	 * implements the same method (ai/RULES.md §2 "widen the interface").
	 */
	createWorkItem(input: CreateWorkItemInput): Promise<WorkItem>;

	/**
	 * Update a work item's mutable fields (title/description on the backing Issue).
	 * Used when Planning re-scopes the original item into the smaller first task it
	 * becomes after a split — the split "can even change [its] name".
	 */
	updateWorkItem(id: string, patch: UpdateWorkItemPatch): Promise<void>;

	/**
	 * Apply a label (by name) to a work item's backing Issue/PR. Idempotent —
	 * re-applying an existing label is a no-op, neither duplicating it nor
	 * erroring — and the label is created if it does not yet exist. Provider-
	 * agnostic: `name` is a label *name*, and both ensuring the label exists and
	 * applying it are the adapter's job, so a future Jira/Linear provider
	 * implements the same method (widen-the-interface, ai/RULES.md §2). Planning
	 * completion uses this to mark an item `planned` (issue #384); labels are
	 * otherwise read-only on {@link WorkItem} and settable only at creation
	 * ({@link CreateWorkItemInput.labels}), so this is the missing post-creation
	 * label-write capability.
	 */
	addLabel(id: string, name: string): Promise<void>;

	/**
	 * Which of the project's repositories the board card `id` belongs to, chosen
	 * from `candidates` (issue #686 phase 1). Each provider answers from its own
	 * narrowest read: GitHub Projects compares the backing Issue/PR's repository,
	 * Jira its component ids, Linear and Trello their label ids.
	 *
	 * Widening the interface rather than reading a board field at the call site is
	 * what keeps the decision provider-agnostic (ai/RULES.md §2) — *which* ids a card
	 * carries is each provider's own answer, while the 0/1/many verdict is shared
	 * once in `./repository-routing.ts`.
	 *
	 * Keyed on the item id rather than a {@link WorkItem} because two of the four
	 * axes are not on a work item at all: GitHub's backing repository is internal to
	 * the adapter, and Jira's components are read by nothing else. Passing the
	 * candidates in — see {@link RepositoryRoutingCandidate} — is what lets a
	 * provider built from a repository-scoped config answer at all.
	 *
	 * Never guesses: a card that claims nothing is `unrouted` and a card claimed by
	 * two entries is `ambiguous` ({@link ItemRepositoryRoute}). Throws only when the
	 * item itself does not resolve, exactly as {@link getWorkItem} does.
	 */
	resolveItemRepository(
		id: string,
		candidates: readonly RepositoryRoutingCandidate[],
	): Promise<ItemRepositoryRoute>;

	/**
	 * Whether this provider models work-item assignees at all. `false` for a
	 * provider with no assignee concept: it returns `assignees: []` on every item,
	 * so a caller treats that item as unassigned instead of branching on the
	 * provider (ai/RULES.md §2). A capability flag rather than an optional field
	 * for the same reason as {@link supportsDependencies} — a second provider opts
	 * out explicitly.
	 */
	readonly supportsAssignees: boolean;

	/**
	 * Whether this provider models cross-item "blocked by" dependencies at all.
	 * `false` for a provider with no dependency concept: callers then skip the
	 * dependency gate and rely on the human-readable comment guard instead of
	 * calling {@link listBlockers} / {@link addBlockedBy} (which return `[]` / no-op).
	 * A capability flag rather than an optional method so a second provider
	 * (Bitbucket, GitLab, Jira) opts out explicitly (ai/RULES.md §2).
	 *
	 * Such a provider has **no automated gate at all**, and that is unchanged by
	 * issue #643: the gate short-circuits on this flag before `listBlockers` is
	 * called, so it never gated on prose there either. Its guard stays the prose
	 * Planning writes into each split child, for a human to read.
	 */
	readonly supportsDependencies: boolean;

	/**
	 * List the prerequisites this work item is *blocked by*, each with its
	 * open/closed state, so the pipeline can refuse to start dependent work while a
	 * prerequisite is unfinished. Combines the provider's native dependency
	 * relationships with dependencies referenced in the item's own description and
	 * comments (deduplicated). Returns `[]` when the item has none, or when the
	 * provider has no dependency concept ({@link supportsDependencies} is `false`).
	 *
	 * Both kinds are still reported, and each carries its {@link
	 * WorkItemBlocker.source}: the caller *gates* on the native relationships and
	 * *surfaces* the prose ones to a human (issue #643), so a provider that dropped
	 * the mentions here would lose the notice rather than tighten the gate.
	 */
	listBlockers(id: string): Promise<WorkItemBlocker[]>;

	/**
	 * List the items this one *blocks* — the reverse edge of {@link listBlockers},
	 * read from the provider's **native** dependency graph only, never from prose.
	 * Returns `[]` when the item blocks nothing, or when the provider has no
	 * dependency concept ({@link supportsDependencies} is `false`).
	 *
	 * It exists so that no run can ever be gated by a cycle (issue #639): the shared
	 * dependency gate drops an open blocker the item itself natively blocks, because
	 * such a blocker cannot close until the gated item lands, so waiting on it could
	 * only ever run the wait budget out and settle the run failed. That happened —
	 * item 633 deferred ~2000 times on an issue whose own `blocked_by` list named
	 * 633 — which is why this is a structural backstop on the gate rather than an
	 * improvement to whatever produced the blocker.
	 *
	 * A method rather than a field on {@link WorkItemBlocker} because the question is
	 * about *this* item's outgoing edges, which the provider reads once per gate
	 * check instead of once per candidate blocker. Native-only for the same reason
	 * `source` decides a blocker's authority (issue #643): a prose-derived reverse
	 * edge would let the heuristic that invented a blocker also excuse it.
	 */
	listDependents(id: string): Promise<WorkItemDependent[]>;

	/**
	 * Record that work item `id` is *blocked by* `blockerId` (a prerequisite that
	 * must finish first). Idempotent — re-adding an existing relationship is a
	 * no-op — and a no-op entirely when the provider has no dependency concept
	 * ({@link supportsDependencies} is `false`). Both are provider-native work-item
	 * ids. Planning's task-splitting uses this to chain the ordered phases so a
	 * later phase can't start before its predecessors land (widen-the-interface,
	 * ai/RULES.md §2).
	 */
	addBlockedBy(id: string, blockerId: string): Promise<void>;

	/**
	 * Discover the provider's selectable boards, or the workflow states of one
	 * selected board, so an administrator can build the board mapping by picking
	 * from real names rather than typing opaque IDs. Registry consumers (the `pm`
	 * API router) dispatch here after checking {@link PMProviderManifest.discovery}
	 * declares the capability; a provider that declares a capability implements it,
	 * and throws for one it does not.
	 *
	 * Optional because discovery is a per-provider capability declared on the
	 * manifest (`discovery`), not part of the pipeline surface every provider
	 * needs: a provider whose manifest declares no capabilities can omit
	 * it entirely. Dispatch stays provider-agnostic — the router looks the method
	 * up through the manifest rather than branching on a concrete provider
	 * (ai/RULES.md §2).
	 *
	 * Runs inside the provider's own credential scope — the browser never supplies
	 * a token, and the raw credential is never returned. Throws an actionable error
	 * when a selected board can't be resolved or has no usable states.
	 */
	discover?<C extends PMDiscoveryCapability>(
		capability: C,
		args: PMDiscoveryArgs[C],
	): Promise<PMDiscoveryResult[C]>;
}
