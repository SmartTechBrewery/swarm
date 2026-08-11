/**
 * TrelloPMProvider — the concrete `PMProvider` (`src/pm/types.ts`) for Trello.
 * With this phase **no method of the contract is a stub**: the board reads and
 * `discover` landed previously, and the writes (`moveWorkItem`, `addComment`,
 * `createWorkItem`, `updateWorkItem`, `addLabel`) plus the declared dependency
 * opt-out land here. Nothing registers this provider yet — the manifest is its
 * own phase — but the gate that phase is held behind is now clear (ai/RULES.md §2
 * "Register when the contract is satisfied, not when the folder appears", the
 * sequencing GitLab's #295, Linear's #491 and Jira's #490 all used).
 *
 * Every operation is REST over `trelloRequest` (`./client.ts`), which picks the
 * API key/token pair up off the async scope — credentials are never arguments,
 * so each method wraps its work in `withTrelloProjectCredentials(this.project, …)`
 * exactly as the Linear and Jira providers do.
 *
 * A **container is a board and a state is a list**: a Trello card has no status
 * field, its status *is* the list it sits in (`./config-schema.ts`). So
 * `statusId` is the card's `idList`, `status` is that list's name (resolved from
 * the board's own lists, which is the one extra request every board read pays),
 * `statusKey` is the canonical key the mapping translates that list id to, and
 * moving a card is `PUT /cards/{id}` with a new `idList`.
 *
 * Trello takes a write's parameters either in the query string or in the request
 * body, and this provider **sends a body**: a comment carries a whole
 * agent-written plan and a description a whole issue body, either of which would
 * overflow a request line if it rode the query. The one exception is applying an
 * existing label, whose payload is a single id and which Trello documents only as
 * `?value=`.
 *
 * Two Trello-specific costs are deliberate and visible rather than hidden.
 * Trello indexes nothing SWARM looks a card up by — not the card's URL, not its
 * description text, not an attachment's URL — and its `/search` is an eventually
 * consistent index, which Planning's retried split cannot rely on. So the three
 * `find…` lookups over the board are client-side scans of one board read rather
 * than server-side queries. And a card carries no creation timestamp at all,
 * only `dateLastActivity`, so {@link WorkItem.createdAt} stays unset rather than
 * synthesised (the same call Cascade's adapter makes).
 */

import type { ProjectConfig } from '../../../config/schema.js';
import { logger } from '../../../lib/logger.js';
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
import { collectTrelloPage, PAGE_LIMIT, TrelloApiError, trelloRequest } from './client.js';
import { requireTrelloConfig, type TrelloIntegrationConfig } from './config-schema.js';
import { withTrelloProjectCredentials } from './credentials.js';
import { requireListIdForStatusKey, resolveStatusKeyByListId } from './status-mapping.js';

/**
 * The card fields and nested resources every read requests, so one card maps the
 * same way whichever endpoint found it. Trello returns the *whole* card model
 * when `fields` is omitted, and nests nothing by default.
 *
 * `labels` is in the selection deliberately: it is what the automation opt-in
 * gate reads (`src/pm/automation-label.ts`, ai/ARCHITECTURE.md "Automation opt-in
 * gate"), and Trello returns whole label objects here rather than a page, so
 * there is no size that could truncate the gate's label away. `attachments`
 * supplies `taskRef` — the card↔SCM-artifact link (ai/ARCHITECTURE.md "Task
 * identity") — and `idBoard` is what lets a single-card read prove the card
 * belongs to this project's board.
 */
const CARD_QUERY = {
	fields: 'name,desc,url,shortUrl,idList,idBoard,labels,dateLastActivity',
	members: true,
	member_fields: 'username,fullName',
	attachments: true,
	attachment_fields: 'url',
} as const;

/**
 * The colour a board label SWARM creates is given. Trello requires one on
 * `POST /boards/{id}/labels` — a label is a board-scoped *object*, not a free
 * string — and nothing here ever reads it back: every lookup matches on the name.
 * So this is only what the operator sees on the board for a label SWARM had to
 * invent, and `green` is Trello's own default swatch.
 */
const CREATED_LABEL_COLOR = 'green';

/** The substring Trello answers `POST /cards/{id}/idLabels` with when the card already carries the label. */
const LABEL_ALREADY_APPLIED = 'already on the card';

/** A Trello label as the card reads select it, and as the board's own label list reports it. */
interface TrelloLabel {
	id?: string;
	name?: string | null;
	color?: string | null;
}

/** A card member — Trello's assignee concept. */
interface TrelloMember {
	id?: string;
	username?: string | null;
	fullName?: string | null;
}

/** A card attachment, narrowed to the one field the artifact link needs. */
interface TrelloAttachment {
	url?: string | null;
}

/** The subset of the card model {@link CARD_QUERY} asks for. Every field is optional defensively. */
interface TrelloCard {
	id?: string;
	name?: string | null;
	desc?: string | null;
	url?: string | null;
	shortUrl?: string | null;
	idList?: string | null;
	idBoard?: string | null;
	dateLastActivity?: string | null;
	labels?: Array<TrelloLabel | null> | null;
	members?: Array<TrelloMember | null> | null;
	attachments?: Array<TrelloAttachment | null> | null;
}

/** A card whose id is known — what every read narrows to before mapping. */
type IdentifiedCard = TrelloCard & { id: string };

/** A board list — a state, in the contract's neutral vocabulary. */
interface TrelloList {
	id?: string;
	name?: string | null;
	/** Trello's own ordering key for the list within its board. */
	pos?: number | null;
}

/** A board the member can see — a container, in the contract's neutral vocabulary. */
interface TrelloBoard {
	id?: string;
	name?: string | null;
	url?: string | null;
}

/** One `commentCard` action — Trello models a card comment as an action, not a comment resource. */
interface TrelloCommentAction {
	id?: string;
	data?: { text?: string | null } | null;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether this is Trello refusing to apply a label the card already carries.
 * `addLabel` checks the card first, so this only covers a label applied between
 * that read and the write — the outcome the caller asked for either way.
 */
function isLabelAlreadyApplied(error: unknown): boolean {
	return (
		error instanceof TrelloApiError &&
		error.status === 400 &&
		error.message.toLowerCase().includes(LABEL_ALREADY_APPLIED)
	);
}

/**
 * The URLs a card links a GitHub artifact through: its attachments first — the
 * linkage Trello's own GitHub Power-Up records — then its description, where a
 * link pasted by hand ends up. Order matters: {@link taskRefFromCard} takes the
 * first match, and an attachment is the deliberate link.
 */
function cardLinkUrls(card: TrelloCard): string[] {
	const attachments = (card.attachments ?? [])
		.map((attachment) => attachment?.url)
		.filter((url): url is string => Boolean(url));
	return card.desc ? [...attachments, card.desc] : attachments;
}

/**
 * The issue number this card is the board's card *for*, from a GitHub issue URL
 * on the card. Read-only linkage, exactly as Linear derives `taskRef` from a
 * GitHub issue attachment — not attachment modelling, which is an issue #492
 * non-goal.
 *
 * A **pull-request** URL is an artifact link, not a task id, so it deliberately
 * cannot fill this: a card with only a PR link leaves `taskRef` unset and cannot
 * start an SCM-driven phase, which is honest (ai/ARCHITECTURE.md "Task identity").
 */
function taskRefFromCard(card: TrelloCard, repository: string): string | undefined {
	const issueUrl = new RegExp(
		`https://github\\.com/${escapeRegExp(repository)}/issues/(\\d+)(?![0-9])`,
	);
	for (const url of cardLinkUrls(card)) {
		const match = url.match(issueUrl);
		if (match) return match[1];
	}
	return undefined;
}

/**
 * Whether this card links one repository-scoped artifact. The trailing
 * non-digit guard is what keeps `/issues/100` from matching a card linking
 * `/issues/1001`.
 */
function artifactUrlPattern({ repository, kind, number }: WorkItemArtifact): RegExp {
	const path = kind === 'issue' ? 'issues' : 'pull';
	return new RegExp(
		`https://github\\.com/${escapeRegExp(repository)}/${path}/${escapeRegExp(number)}(?![0-9])`,
	);
}

function mapLabels(card: TrelloCard): WorkItemLabel[] {
	return (card.labels ?? [])
		.filter((label): label is TrelloLabel & { id: string } => Boolean(label?.id))
		.map((label) => ({
			// A Trello label may legitimately be colour-only, with an empty name. It is
			// kept rather than dropped: `WorkItem.labels` is the automation gate's input,
			// and a nameless label simply never matches the configured name.
			id: label.id,
			name: label.name ?? '',
			color: label.color ?? undefined,
		}));
}

/**
 * Map the card's members onto the provider-neutral assignees. Trello allows
 * several members per card, so this is the one provider so far that can return
 * more than one. `handle` ← `username`, the short unique name SWARM's identity
 * link matches on (`src/identity/assignee-resolver.ts`).
 */
function mapAssignees(card: TrelloCard): WorkItemAssignee[] {
	return (card.members ?? [])
		.filter((member): member is TrelloMember & { username: string } => Boolean(member?.username))
		.map((member) => ({
			handle: member.username,
			displayName: member.fullName ?? undefined,
			providerId: member.id,
		}));
}

/**
 * The card's web URL. Trello reports two — the long `…/c/<shortLink>/<n>-<slug>`
 * form and the canonical `shortUrl` (`https://trello.com/c/<shortLink>`) — and
 * the long one is preferred because it is what a person reading a comment sees,
 * with the short one as the fallback when a read narrowed the fields.
 */
function cardUrl(card: TrelloCard): string {
	return card.url || card.shortUrl || '';
}

/**
 * Reduce discovered boards to stable picker options: keep only boards carrying
 * both an id and a name, deduplicate by id, and sort by name (case-insensitive)
 * so the picker order doesn't jump between refreshes — the same normalisation
 * Linear's containers get.
 */
function normalizeContainers(boards: Array<TrelloBoard | null>): DiscoveredContainer[] {
	const byId = new Map<string, DiscoveredContainer>();
	for (const board of boards) {
		if (!board?.id || !board.name || byId.has(board.id)) continue;
		byId.set(board.id, {
			id: board.id,
			name: board.name,
			...(board.url ? { url: board.url } : {}),
		});
	}
	return [...byId.values()].sort((a, b) =>
		a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
	);
}

export class TrelloPMProvider implements PMProvider {
	readonly type: PMType = 'trello';

	// A Trello card carries members natively, so every item this provider maps
	// reports them — several, unlike Linear's single assignee.
	readonly supportsAssignees = true;

	// Trello models no cross-card dependency: there is no "blocked by" relation on
	// a board, only prose in a description or a checklist. So this provider opts
	// out and callers fall back to the human-readable comment guard rather than
	// the dependency gate (ai/RULES.md §2).
	readonly supportsDependencies = false;

	/**
	 * This project's board mapping, narrowed out of the `pm` union once at
	 * construction instead of at each read — the only place this provider asserts
	 * which union member it was built for (issue #495).
	 */
	private readonly config: TrelloIntegrationConfig;

	constructor(private readonly project: ProjectConfig) {
		this.config = requireTrelloConfig(project);
	}

	/** Run `fn` with this project's Trello key/token pair bound to scope. */
	private run<T>(fn: () => Promise<T>): Promise<T> {
		return withTrelloProjectCredentials(this.project, fn);
	}

	async getWorkItem(id: string): Promise<WorkItem> {
		return this.run(async () => {
			const [card, listNames] = await Promise.all([
				trelloRequest<TrelloCard | undefined>(`cards/${encodeURIComponent(id)}`, {
					query: CARD_QUERY,
				}),
				this.fetchListNames(),
			]);
			// A non-resolving id is bad input, not a soft miss: it came from a webhook
			// or a prior board read (ai/CODING_STANDARDS.md "Error handling"). Trello
			// answers an unknown id with a 404, which `trelloRequest` already throws —
			// this covers the empty/partial-body case and states the contract here.
			if (!card?.id) {
				throw new Error(`Trello card '${id}' did not resolve`);
			}
			// Unlike the board-scoped reads below, a card id addresses any card the
			// token can see. A card from another board would map against this board's
			// list mapping and resolve a nonsense status, so reject it here.
			if (card.idBoard && card.idBoard !== this.config.boardId) {
				throw new Error(
					`Trello card '${id}' belongs to board '${card.idBoard}', not this project's board '${this.config.boardId}'`,
				);
			}
			return this.toWorkItem({ ...card, id: card.id }, listNames);
		});
	}

	async listWorkItems(filter?: ListWorkItemsFilter): Promise<WorkItem[]> {
		// Resolve the canonical key to a list id *before* the read. An unmapped
		// status is a config/logic error, not "match everything": dropping the
		// narrowing would silently return the whole board, so this fails loudly,
		// exactly as the other providers' `listWorkItems` do (ai/CODING_STANDARDS.md
		// "Error handling").
		const listId =
			filter?.status === undefined
				? undefined
				: requireListIdForStatusKey(this.config, filter.status);
		return this.run(async () => {
			const { cards, listNames } = await this.readBoard(listId);
			return cards.map((card) => this.toWorkItem(card, listNames));
		});
	}

	async findWorkItemByUrlSuffix(urlSuffix: string): Promise<WorkItem | undefined> {
		// Trello offers no filter on a card's own URL, so the match runs client-side
		// over the board read.
		//
		// SWARM's only caller passes a GitHub-shaped `/issues/<n>` suffix — the
		// documented legacy fallback in `src/pipeline/respond-to-review.ts`, used only
		// for a pull request with no recorded card (ai/ARCHITECTURE.md "Task
		// identity"). A Trello card's URL is `https://trello.com/c/<shortLink>`, which
		// never ends with that, so for those pre-existing PRs this honestly resolves
		// nothing; a Trello board reports through SWARM's own durable
		// `runs.work_item_id` link instead, which is provider-neutral.
		return this.findCard((card) => cardUrl(card).endsWith(urlSuffix));
	}

	async findWorkItemForArtifact(artifact: WorkItemArtifact): Promise<WorkItem | undefined> {
		// Trello has no linkage of its own to query — a GitHub artifact reaches a card
		// as an attachment (what its GitHub Power-Up records) or as a link pasted into
		// the description — and neither is indexed, so this scans the board. A miss is
		// the ordinary answer: the artifact simply has no card.
		const artifactUrl = artifactUrlPattern(artifact);
		return this.findCard((card) => cardLinkUrls(card).some((url) => artifactUrl.test(url)));
	}

	async findWorkItemByDescriptionMarker(marker: string): Promise<WorkItem | undefined> {
		// Client-side over the board read rather than through Trello's `/search`:
		// search is index-backed and eventually consistent, and the caller is
		// Planning's retried split, where a child created seconds ago has to be
		// findable *now* or the guard silently creates a second one. Callers pass a
		// marker at most one card can carry, so the first match is the match.
		return this.findCard((card) => (card.desc ?? '').includes(marker));
	}

	async findComment(id: string, marker: string): Promise<string | undefined> {
		return this.run(async () => {
			// Every page, not just the first: an earlier delivery's marker can sit
			// beyond page 1, and missing it would post a duplicate on a retry. Comment
			// actions are the one card collection Trello returns newest-first with an
			// id cursor, which is exactly what `collectTrelloPage` walks.
			const actions = await collectTrelloPage<TrelloCommentAction>(async (before) => {
				const page = await trelloRequest<Array<TrelloCommentAction | null> | undefined>(
					`cards/${encodeURIComponent(id)}/actions`,
					{ query: { filter: 'commentCard', limit: PAGE_LIMIT, before } },
				);
				return page ?? null;
			});
			return actions.find((action) => action.id && action.data?.text?.includes(marker))?.id;
		});
	}

	async moveWorkItem(id: string, status: string): Promise<void> {
		// Resolve the canonical key before the write: a status the board mapping
		// can't resolve is a config/logic error, not a value to send blindly — the
		// same fail-loud contract `listWorkItems` and the other three providers'
		// `moveWorkItem` keep (ai/CODING_STANDARDS.md "Error handling").
		const idList = requireListIdForStatusKey(this.config, status);
		await this.run(async () => {
			// One write, and no transition graph to negotiate: a Trello card's status is
			// which list holds it, so a move is an ordinary field update and every list
			// is reachable from every other. Re-asserting the list a card already sits in
			// is accepted by Trello, so `autoAdvance` needs no already-there check.
			await trelloRequest<void>(`cards/${encodeURIComponent(id)}`, {
				method: 'PUT',
				body: { idList },
			});
		});
		logger.debug('pm: moved work item', { itemId: id, status });
	}

	async addComment(id: string, text: string): Promise<string> {
		// Unlike GitHub Projects — whose board card has no comment thread, so the
		// comment is redirected onto the backing Issue — a Trello card *is* the work
		// item, and the comment lands natively on it. There is no backing artifact to
		// resolve first.
		return this.run(async () => {
			// Trello models a card comment as an **action**, so what comes back is a
			// `commentCard` action and its id is the comment id — the same id space
			// `findComment` scans, which is what lets an idempotency marker match.
			const action = await trelloRequest<TrelloCommentAction | undefined>(
				`cards/${encodeURIComponent(id)}/actions/comments`,
				{ method: 'POST', body: { text } },
			);
			if (!action?.id) {
				throw new Error(`Trello returned no comment id for the comment posted on card '${id}'`);
			}
			return action.id;
		});
	}

	async createWorkItem(input: CreateWorkItemInput): Promise<WorkItem> {
		const idList = requireListIdForStatusKey(this.config, input.status);
		const labels = input.labels ?? [];
		return this.run(async () => {
			// `POST /cards` takes label *ids*, and a Trello label is an object owned by
			// the board, so every name has to be resolved (and created when the board
			// has none) before the card exists.
			const idLabels: string[] = [];
			for (const name of labels) {
				idLabels.push(await this.ensureBoardLabelId(name));
			}
			const [card, listNames] = await Promise.all([
				trelloRequest<TrelloCard | undefined>('cards', {
					method: 'POST',
					body: {
						idList,
						name: input.title,
						desc: input.description,
						...(idLabels.length > 0 ? { idLabels } : {}),
					},
				}),
				// The card's list name is not on the create response, and this read does
				// not depend on the write, so the two go out together.
				this.fetchListNames(),
			]);
			if (!card?.id) {
				throw new Error(`Trello returned no card id for the card created as '${input.title}'`);
			}
			logger.debug('pm: created work item', { itemId: card.id, status: input.status });
			// One write, unlike GitHub Projects' create-then-place pair: `idList` is part
			// of the create. Mapped through the same `toWorkItem` the reads use so the
			// fresh card reads exactly like one off a board read. Its `taskRef` is unset
			// and that is honest — a Trello card is not an SCM artifact, and nothing has
			// linked one to it yet (ai/ARCHITECTURE.md "Task identity").
			return this.toWorkItem({ ...card, id: card.id }, listNames);
		});
	}

	async updateWorkItem(id: string, patch: UpdateWorkItemPatch): Promise<void> {
		// Nothing to write is not an empty write: an empty `PUT /cards/{id}` still
		// bumps the card's `dateLastActivity` for no reason.
		if (patch.title === undefined && patch.description === undefined) return;
		await this.run(async () => {
			await trelloRequest<void>(`cards/${encodeURIComponent(id)}`, {
				method: 'PUT',
				body: {
					...(patch.title !== undefined ? { name: patch.title } : {}),
					...(patch.description !== undefined ? { desc: patch.description } : {}),
				},
			});
		});
		logger.debug('pm: updated work item', { itemId: id });
	}

	async addLabel(id: string, name: string): Promise<void> {
		await this.run(async () => {
			// Re-applying a label the card already carries is contractually a no-op, so
			// check before writing rather than leaning on how Trello happens to answer a
			// repeat. Compared case-insensitively, since a board label's name is display
			// text an operator may have capitalised differently.
			const card = await trelloRequest<TrelloCard | undefined>(`cards/${encodeURIComponent(id)}`, {
				query: { fields: 'labels' },
			});
			const already = (card?.labels ?? []).some(
				(label) => label?.name?.toLowerCase() === name.toLowerCase(),
			);
			if (already) return;
			const labelId = await this.ensureBoardLabelId(name);
			try {
				await trelloRequest<void>(`cards/${encodeURIComponent(id)}/idLabels`, {
					method: 'POST',
					query: { value: labelId },
				});
			} catch (error) {
				// The label was applied between the read above and this write — the card
				// carries it, which is all the caller asked for.
				if (!isLabelAlreadyApplied(error)) throw error;
				return;
			}
			logger.debug('pm: applied label', { itemId: id, label: name });
		});
	}

	/**
	 * The **declared capability opt-out**, not an unfinished method: this provider
	 * sets `supportsDependencies: false`, and the contract (`src/pm/types.ts`)
	 * defines that as `listBlockers` answering `[]` and {@link addBlockedBy} doing
	 * nothing, so callers skip the dependency gate and fall back to the
	 * human-readable comment guard (`src/pipeline/dependency-guard.ts`).
	 *
	 * Trello models no cross-card blocking relationship at all — a board has lists,
	 * labels and checklists, and nothing that says one card must finish before
	 * another. The only prerequisites a card can express are prose in its
	 * description, and in SWARM those are GitHub issue numbers whose open/closed
	 * state only an **SCM** provider could resolve; reaching for one here would be
	 * exactly the cross-category reach ai/RULES.md §2 forbids (the PM provider
	 * borrowing another category's model). Synthesising a blocker SWARM cannot
	 * answer `open` for would be worse than reporting none: the gate would defer
	 * work on a prerequisite it could never see finish.
	 *
	 * **Issue #643 changes nothing here, and takes nothing away.** Prose stopped
	 * gating a run anywhere, but this provider never gated on prose in the first
	 * place: the guard short-circuits on `supportsDependencies` before it asks for
	 * blockers at all, so a Trello project's automated gating was, and remains,
	 * empty. What it has instead is what it always had — the prose Planning writes
	 * into each split child's description, for a human to read.
	 */
	async listBlockers(): Promise<WorkItemBlocker[]> {
		return [];
	}

	/**
	 * The reverse-edge half of the same opt-out (issue #639) — see
	 * {@link listBlockers} for why. Trello records no cross-card blocking
	 * relationship in either direction, so there is nothing for this to read: the
	 * contract (`src/pm/types.ts`) defines `supportsDependencies: false` as this
	 * answering `[]`, and a provider that gates on nothing has no cycle to suppress
	 * either.
	 *
	 * Deliberately *not* answered from prose, exactly as `listBlockers` refuses to:
	 * this read is what excuses a blocker, so a heuristic answer here would be worse
	 * than none — it could drop a real gate on a sentence.
	 */
	async listDependents(): Promise<WorkItemDependent[]> {
		return [];
	}

	/**
	 * The write half of the same opt-out — see {@link listBlockers} for why. There
	 * is no Trello relationship to record, so Planning's split chains its phases in
	 * the prose it already writes into each child's description; the contract makes
	 * this a no-op rather than a failure precisely so a split still succeeds against
	 * a board with no dependency concept.
	 */
	async addBlockedBy(): Promise<void> {
		// Intentionally empty — see the doc comment above.
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
				throw new Error(`Trello does not support discovery capability '${capability}'`);
		}
	}

	/**
	 * Enumerate the open boards the token's member can see — the containers a board
	 * mapping is scoped to. `/members/me/boards` already returns only boards the
	 * member has access to, so there is no second path to union in.
	 */
	private async discoverContainers(): Promise<ContainerDiscoveryResult> {
		return this.run(async () => {
			const boards = await trelloRequest<Array<TrelloBoard | null> | undefined>(
				'members/me/boards',
				{ query: { filter: 'open', fields: 'name,url' } },
			);
			return { containers: normalizeContainers(boards ?? []) };
		});
	}

	/**
	 * Discover one board's open lists — the states a mapping is built from —
	 * ordered by Trello's own `pos` (the left-to-right order the board shows) with
	 * the name as a tiebreak so the picker is stable.
	 *
	 * Reads the board the operator picked, not `config.boardId`: the mapping screen
	 * calls this *while* choosing which board to map. Returns **no**
	 * `providerContext`: a list id is the whole mapping, so there is no extra scope
	 * to thread back — that field exists for GitHub Projects' `statusFieldId`.
	 */
	private async discoverStates(containerId: string): Promise<StateDiscoveryResult> {
		return this.run(async () => {
			const lists = await trelloRequest<Array<TrelloList | null> | undefined>(
				`boards/${encodeURIComponent(containerId)}/lists`,
				{ query: { filter: 'open', fields: 'name,pos' } },
			);
			// A board id Trello cannot resolve answers 404, which `trelloRequest`
			// throws; this is the partial/empty-body case. Both are actionable at the
			// mapping screen.
			if (!Array.isArray(lists)) {
				throw new Error(`Trello board '${containerId}' did not resolve`);
			}
			const states: DiscoveredState[] = lists
				.filter((list): list is TrelloList & { id: string; name: string } =>
					Boolean(list?.id && list.name),
				)
				// A list without a `pos` sorts last rather than to the front, so a partial
				// response degrades to "unknown order at the end".
				.sort(
					(a, b) =>
						(a.pos ?? Number.POSITIVE_INFINITY) - (b.pos ?? Number.POSITIVE_INFINITY) ||
						a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
				)
				.map((list) => ({ id: list.id, name: list.name }));
			if (states.length === 0) {
				throw new Error(`Trello board '${containerId}' has no lists to map`);
			}
			return { states };
		});
	}

	/**
	 * The first card on this board matching `predicate`, mapped — the shared body
	 * of the three client-side board lookups. A miss answers `undefined`, which is
	 * the contract's soft "no card for that" for all three.
	 */
	private async findCard(
		predicate: (card: IdentifiedCard) => boolean,
	): Promise<WorkItem | undefined> {
		return this.run(async () => {
			const { cards, listNames } = await this.readBoard();
			const match = cards.find(predicate);
			return match ? this.toWorkItem(match, listNames) : undefined;
		});
	}

	/**
	 * One board read: the open cards (of the whole board, or of one mapped list)
	 * together with the board's list names, which is what turns a card's `idList`
	 * into a human-readable {@link WorkItem.status}. Issued concurrently because
	 * neither depends on the other. Runs inside a credential scope (its callers do).
	 */
	private async readBoard(
		listId?: string,
	): Promise<{ cards: IdentifiedCard[]; listNames: Map<string, string> }> {
		const [cards, listNames] = await Promise.all([this.fetchCards(listId), this.fetchListNames()]);
		return { cards, listNames };
	}

	/**
	 * The open cards of one list, or of the whole board when no list is given.
	 *
	 * Read as a single page of at most {@link PAGE_LIMIT} — Trello's own maximum —
	 * rather than walked with `collectTrelloPage`: that helper's cursor assumes a
	 * newest-first collection (the shape `/actions` has), while a card collection
	 * comes back in board/list position order, so advancing `before` past the last
	 * element would skip cards rather than page them. A board that fills the page
	 * is logged rather than silently truncated. Runs inside a credential scope
	 * (its callers do).
	 */
	private async fetchCards(listId?: string): Promise<IdentifiedCard[]> {
		const path =
			listId === undefined
				? `boards/${encodeURIComponent(this.config.boardId)}/cards`
				: `lists/${encodeURIComponent(listId)}/cards`;
		const cards = await trelloRequest<Array<TrelloCard | null> | undefined>(path, {
			query: { ...CARD_QUERY, filter: 'open', limit: PAGE_LIMIT },
		});
		const identified = (cards ?? []).filter((card): card is IdentifiedCard => Boolean(card?.id));
		if (identified.length >= PAGE_LIMIT) {
			logger.warn('pm: Trello card read filled a whole page — later cards were not read', {
				projectId: this.project.id,
				path,
				limit: PAGE_LIMIT,
			});
		}
		return identified;
	}

	/**
	 * This board's list ids mapped to their names, for {@link WorkItem.status}.
	 * Read with `filter=all` rather than `open`: an archived list still holds its
	 * cards, so a card sitting in one must still report a status name. Runs inside
	 * a credential scope (its callers do).
	 */
	private async fetchListNames(): Promise<Map<string, string>> {
		const lists = await trelloRequest<Array<TrelloList | null> | undefined>(
			`boards/${encodeURIComponent(this.config.boardId)}/lists`,
			{ query: { filter: 'all', fields: 'name' } },
		);
		const names = new Map<string, string>();
		for (const list of lists ?? []) {
			if (list?.id && list.name) names.set(list.id, list.name);
		}
		return names;
	}

	/**
	 * Resolve a label *name* to the board label id every Trello label write takes,
	 * creating the label on this board when it carries none by that name. Runs
	 * inside a credential scope (its callers do).
	 *
	 * Create-if-missing tolerating a lost race, like Linear's `ensureLabelId` and
	 * GitHub Projects' `ensureLabel`: a concurrent writer that got there first
	 * leaves the label existing, which is all the caller needs. The race is caught
	 * by *re-reading* rather than by recognising a rejection message, because
	 * Trello documents no duplicate-name rejection to recognise — a board may
	 * legitimately hold two labels sharing a name — so a failed create only becomes
	 * a success if the name actually resolves afterwards; otherwise the original
	 * error is rethrown rather than swallowed.
	 */
	private async ensureBoardLabelId(name: string): Promise<string> {
		const existing = await this.findBoardLabelId(name);
		if (existing) return existing;
		try {
			const created = await trelloRequest<TrelloLabel | undefined>(
				`boards/${encodeURIComponent(this.config.boardId)}/labels`,
				{ method: 'POST', body: { name, color: CREATED_LABEL_COLOR } },
			);
			if (created?.id) return created.id;
		} catch (error) {
			const raced = await this.findBoardLabelId(name);
			if (raced) return raced;
			throw error;
		}
		const resolved = await this.findBoardLabelId(name);
		if (!resolved) {
			throw new Error(`Trello board label '${name}' could neither be resolved nor created`);
		}
		return resolved;
	}

	/**
	 * The id of this board's label named `name`, or `undefined` when it has none.
	 * Board-scoped because that is the only scope a Trello label has — there is no
	 * workspace-wide label to also consider, unlike Linear's shared labels.
	 *
	 * The explicit `limit` is load-bearing: `GET /boards/{id}/labels` defaults to
	 * **50**, so a board with more labels than that would silently miss an existing
	 * one and create a duplicate. Runs inside a credential scope (its callers do).
	 */
	private async findBoardLabelId(name: string): Promise<string | undefined> {
		const labels = await trelloRequest<Array<TrelloLabel | null> | undefined>(
			`boards/${encodeURIComponent(this.config.boardId)}/labels`,
			{ query: { fields: 'name', limit: PAGE_LIMIT } },
		);
		return (labels ?? []).find(
			(label) => label?.id && label.name?.toLowerCase() === name.toLowerCase(),
		)?.id;
	}

	/**
	 * Map a Trello card onto a `WorkItem`. The card's list is its status, in all
	 * three of the contract's forms: the opaque `statusId` (the list id), the
	 * display-only `status` (the list's name), and the canonical `statusKey` shared
	 * code resolves a pipeline phase from, so no caller inverts `statusOptions`
	 * itself (ai/RULES.md §2).
	 */
	private toWorkItem(card: IdentifiedCard, listNames: Map<string, string>): WorkItem {
		const listId = card.idList ?? undefined;
		return {
			id: card.id,
			title: card.name ?? '',
			description: card.desc ?? '',
			url: cardUrl(card),
			taskRef: taskRefFromCard(card, this.project.repo),
			status: listId === undefined ? undefined : listNames.get(listId),
			statusId: listId,
			statusKey: listId === undefined ? undefined : resolveStatusKeyByListId(this.config, listId),
			labels: mapLabels(card),
			assignees: mapAssignees(card),
			// Trello reports no creation timestamp on a card, only its last activity,
			// so `createdAt` stays unset rather than synthesised from it.
			updatedAt: card.dateLastActivity ?? undefined,
		};
	}
}

/**
 * Build the Trello PM provider for a project. The one construction seam callers
 * use, so they depend on the `PMProvider` interface rather than the concrete
 * class — and what the manifest's `createProvider` points at (`./index.ts`).
 */
export function createTrelloProvider(project: ProjectConfig): PMProvider {
	return new TrelloPMProvider(project);
}
