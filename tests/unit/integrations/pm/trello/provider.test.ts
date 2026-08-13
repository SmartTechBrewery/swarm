import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted so the mock factory below can use it before the hoisted `import`s run.
const { requirePmCredential } = vi.hoisted(() => ({
	requirePmCredential: vi.fn<(project: unknown, role: string) => Promise<string>>(),
}));

// A PM credential role resolves against the *registered* manifest, and Trello
// registers none until its final phase (ai/RULES.md §2), so the seam is mocked.
// Nothing else is: `fetch` is the only other stand-in, so the real client, its
// key/token query scoping, and its id-cursor paging all run.
vi.mock('@/config/provider.js', () => ({ requirePmCredential }));

import { PAGE_LIMIT } from '@/integrations/pm/trello/client.js';
import { requireTrelloConfig } from '@/integrations/pm/trello/config-schema.js';
import { createTrelloProvider, TrelloPMProvider } from '@/integrations/pm/trello/provider.js';
import {
	createMockProjectRepositoryPair,
	createMockTrelloProjectConfig,
} from '../../../../helpers/factories.js';

const PROJECT = createMockTrelloProjectConfig();
const CONFIG = requireTrelloConfig(PROJECT);
const REPO = PROJECT.repo;

const CARD_ID = '6b1c2d3e4f5061728394a5b6';
const IN_PROGRESS_LIST = CONFIG.statusOptions.inProgress;
const TODO_LIST = CONFIG.statusOptions.todo;

/** A `fetch` stand-in typed with the real signature so `mock.calls` indexes. */
type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

/** A route answers with a body to serialize, a whole `Response`, or nothing at all. */
type ResponseBody = Response | Record<string, unknown> | unknown[] | undefined;
type Responder = ResponseBody | ((url: URL, method: string) => ResponseBody);

let fetchMock: FetchMock;

/**
 * Route the stubbed transport by the REST path, anchored, so an unexpected
 * endpoint fails loudly instead of silently reusing another route's payload.
 * Each handler sees the request URL — where the `fields`, `filter` and paging
 * parameters the provider built show up — and its method, which is what tells a
 * board-label *read* from the *create* that follows it on the same path.
 */
function mockTrello(routes: Record<string, Responder>): void {
	fetchMock.mockImplementation(async (input, init) => {
		const url = new URL(String(input));
		const path = url.pathname.replace(/^\/1\//, '');
		const pattern = Object.keys(routes).find((candidate) =>
			new RegExp(`^${candidate}$`).test(path),
		);
		if (pattern === undefined) {
			throw new Error(`Unexpected Trello request '${path}'`);
		}
		const responder = routes[pattern];
		const body =
			typeof responder === 'function' ? responder(url, init?.method ?? 'GET') : responder;
		if (body instanceof Response) return body;
		if (body === undefined) return new Response(null, { status: 200 });
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	});
}

/** The request URLs the provider issued, in order. */
function requestedUrls(): URL[] {
	return fetchMock.mock.calls.map(([input]) => new URL(String(input)));
}

/** The REST paths the provider issued, in order, without the `/1` API root. */
function requestedPaths(): string[] {
	return requestedUrls().map((url) => url.pathname.replace(/^\/1\//, ''));
}

/** The URLs issued to one REST path. */
function requestsTo(path: string): URL[] {
	return requestedUrls().filter((url) => url.pathname === `/1/${path}`);
}

/** The writes issued to one REST path, with their method and parsed JSON body. */
function callsTo(path: string): Array<{ url: URL; method: string; body: unknown }> {
	return fetchMock.mock.calls
		.map(([input, init]) => ({
			url: new URL(String(input)),
			method: init?.method ?? 'GET',
			body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
		}))
		.filter((call) => call.url.pathname === `/1/${path}`);
}

/** The board's lists, as `GET /boards/{id}/lists` reports them. */
const BOARD_LISTS = [
	{ id: CONFIG.statusOptions.backlog, name: 'Backlog', pos: 65536 },
	{ id: TODO_LIST, name: 'Ready', pos: 131072 },
	{ id: IN_PROGRESS_LIST, name: 'In progress', pos: 196608 },
];

const LISTS_PATH = `boards/${CONFIG.boardId}/lists`;
const BOARD_CARDS_PATH = `boards/${CONFIG.boardId}/cards`;

const DESCRIPTION_MARKER = '<!-- swarm-split-child:2490f13f:0 -->';

/**
 * Every method `PMProvider` declares, plus the optional `discover`. Kept here
 * rather than imported from the conformance suite because that suite only ever
 * sees a *registered* manifest, and Trello registers none until its final phase.
 */
const CONTRACT_METHODS = [
	'getWorkItem',
	'listWorkItems',
	'findWorkItemByUrlSuffix',
	'findWorkItemForArtifact',
	'findWorkItemByDescriptionMarker',
	'moveWorkItem',
	'addComment',
	'findComment',
	'createWorkItem',
	'updateWorkItem',
	'addLabel',
	'listBlockers',
	'listDependents',
	'addBlockedBy',
	'resolveItemRepository',
	'discover',
] as const;

/** A card as the reads select it, overridable field by field. */
function trelloCard(overrides: Record<string, unknown> = {}) {
	return {
		id: CARD_ID,
		name: 'Wire triggers',
		desc: `Wire the triggers.\n\n${DESCRIPTION_MARKER}`,
		url: 'https://trello.com/c/H0TZyzbK/4-wire-triggers',
		shortUrl: 'https://trello.com/c/H0TZyzbK',
		idList: IN_PROGRESS_LIST,
		idBoard: CONFIG.boardId,
		dateLastActivity: '2026-07-02T00:00:00.000Z',
		labels: [
			{ id: 'label-swarm', name: 'swarm', color: 'green' },
			{ id: 'label-colour-only', name: '', color: 'purple' },
		],
		members: [
			{ id: '5abbe4b7ddc1b351ef961414', username: 'ada', fullName: 'Ada Lovelace' },
			{ id: '5abbe4b7ddc1b351ef961415', username: 'grace', fullName: null },
		],
		attachments: [
			{ url: `https://github.com/${REPO}/pull/601` },
			{ url: `https://github.com/${REPO}/issues/585` },
		],
		...overrides,
	};
}

describe('TrelloPMProvider', () => {
	let provider: TrelloPMProvider;

	beforeEach(() => {
		fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal('fetch', fetchMock);
		requirePmCredential.mockImplementation(async (_project, role) =>
			role === 'apiKey' ? 'trello-api-key' : 'trello-token',
		);
		provider = new TrelloPMProvider(PROJECT);
	});

	it('declares the Trello provider id and both capability flags', () => {
		expect(provider.type).toBe('trello');
		// A card carries members natively; a board models no cross-card dependency.
		expect(provider.supportsAssignees).toBe(true);
		expect(provider.supportsDependencies).toBe(false);
		expect(createTrelloProvider(PROJECT)).toBeInstanceOf(TrelloPMProvider);
	});

	describe('getWorkItem', () => {
		it('maps every field, resolving the list into all three status forms', async () => {
			mockTrello({ [`cards/${CARD_ID}`]: trelloCard(), [LISTS_PATH]: BOARD_LISTS });

			await expect(provider.getWorkItem(CARD_ID)).resolves.toEqual({
				id: CARD_ID,
				title: 'Wire triggers',
				description: `Wire the triggers.\n\n${DESCRIPTION_MARKER}`,
				url: 'https://trello.com/c/H0TZyzbK/4-wire-triggers',
				taskRef: '585',
				// A bare number names nothing, so the repository it numbers an artifact in
				// travels with it, read off the same linked URL (issue #710).
				taskRepository: REPO,
				// The card's status *is* its list: the display name, the list id, and the
				// canonical key the mapping translates that id to.
				status: 'In progress',
				statusId: IN_PROGRESS_LIST,
				statusKey: 'inProgress',
				// A colour-only label has an empty name and is still reported — the
				// automation gate reads this field, so nothing may be truncated out of it.
				labels: [
					{ id: 'label-swarm', name: 'swarm', color: 'green' },
					{ id: 'label-colour-only', name: '', color: 'purple' },
				],
				assignees: [
					{ handle: 'ada', displayName: 'Ada Lovelace', providerId: '5abbe4b7ddc1b351ef961414' },
					{ handle: 'grace', providerId: '5abbe4b7ddc1b351ef961415' },
				],
				// Trello reports no creation timestamp, so `createdAt` stays unset.
				createdAt: undefined,
				updatedAt: '2026-07-02T00:00:00.000Z',
			});

			// The card read names its fields and nests the two collections the mapping
			// needs, and the credentials ride the query rather than a header.
			const card = requestsTo(`cards/${CARD_ID}`)[0];
			expect(card?.searchParams.get('fields')).toBe(
				'name,desc,url,shortUrl,idList,idBoard,labels,dateLastActivity',
			);
			expect(card?.searchParams.get('members')).toBe('true');
			expect(card?.searchParams.get('attachments')).toBe('true');
			expect(card?.searchParams.get('key')).toBe('trello-api-key');
			expect(card?.searchParams.get('token')).toBe('trello-token');
			// An archived list still holds cards, so the status-name lookup reads them all.
			expect(requestsTo(LISTS_PATH)[0]?.searchParams.get('filter')).toBe('all');
		});

		it.each([
			{
				label: 'only a pull-request attachment',
				attachments: [{ url: `https://github.com/${REPO}/pull/601` }],
			},
			{ label: 'no attachments at all', attachments: [] },
		])('leaves taskRef unset for a card with $label', async ({ attachments }) => {
			mockTrello({
				[`cards/${CARD_ID}`]: trelloCard({ attachments, desc: 'No links here.' }),
				[LISTS_PATH]: BOARD_LISTS,
			});

			// A pull request is an artifact *of* the task, not its id, and a Trello card
			// id is never a task id — so an unlinked card honestly has none
			// (ai/ARCHITECTURE.md "Task identity"). The phase dispatcher logs and skips.
			await expect(provider.getWorkItem(CARD_ID)).resolves.toMatchObject({
				taskRef: undefined,
				taskRepository: undefined,
			});
		});

		// Issue #710 moved the repository half of this rule out of the provider: a link
		// naming a repository this project does not own used to be skipped over, leaving
		// `taskRef` unset. It now resolves honestly — with the repository that makes it
		// refusable — because a provider built from a config scoped to one repository
		// cannot know which repositories the project owns.
		it('reports an issue link in another repository rather than skipping it', async () => {
			mockTrello({
				[`cards/${CARD_ID}`]: trelloCard({
					attachments: [{ url: 'https://github.com/acme/other/issues/585' }],
					desc: 'No links here.',
				}),
				[LISTS_PATH]: BOARD_LISTS,
			});

			await expect(provider.getWorkItem(CARD_ID)).resolves.toMatchObject({
				taskRef: '585',
				taskRepository: 'acme/other',
			});
		});

		it('falls back to an issue link in the description when no attachment carries one', async () => {
			mockTrello({
				[`cards/${CARD_ID}`]: trelloCard({
					attachments: [{ url: `https://github.com/${REPO}/pull/601` }],
					desc: `Implements https://github.com/${REPO}/issues/5850 and https://github.com/${REPO}/issues/585.`,
				}),
				[LISTS_PATH]: BOARD_LISTS,
			});

			// The first match wins, and `5850` is a different issue from `585` — the
			// digit boundary is what keeps them apart.
			await expect(provider.getWorkItem(CARD_ID)).resolves.toMatchObject({ taskRef: '5850' });
		});

		it('reports no status name or key for a card in a list the mapping does not name', async () => {
			mockTrello({
				[`cards/${CARD_ID}`]: trelloCard({ idList: '6a1b2c3d4e5f60718293a4ff' }),
				[LISTS_PATH]: BOARD_LISTS,
			});

			const item = await provider.getWorkItem(CARD_ID);

			expect(item.statusId).toBe('6a1b2c3d4e5f60718293a4ff');
			expect(item.status).toBeUndefined();
			expect(item.statusKey).toBeUndefined();
		});

		it('treats an id that does not resolve as bad input rather than a soft miss', async () => {
			mockTrello({ [`cards/${CARD_ID}`]: undefined, [LISTS_PATH]: BOARD_LISTS });

			await expect(provider.getWorkItem(CARD_ID)).rejects.toThrow(
				`Trello card '${CARD_ID}' did not resolve`,
			);
		});

		it('propagates the API error for an unknown card, without the credentials in the message', async () => {
			mockTrello({
				[`cards/${CARD_ID}`]: new Response('card not found', { status: 404 }),
				[LISTS_PATH]: BOARD_LISTS,
			});

			await expect(provider.getWorkItem(CARD_ID)).rejects.toThrow(
				`Trello API request failed (404) for /cards/${CARD_ID}: card not found`,
			);
		});

		it('refuses a card belonging to another board', async () => {
			mockTrello({
				[`cards/${CARD_ID}`]: trelloCard({ idBoard: '5f2b9c1a4e6d7f0a1b2c3dff' }),
				[LISTS_PATH]: BOARD_LISTS,
			});

			// A card id addresses any card the token can see; another board's card would
			// map against this board's list mapping and resolve a nonsense status.
			await expect(provider.getWorkItem(CARD_ID)).rejects.toThrow(
				`belongs to board '5f2b9c1a4e6d7f0a1b2c3dff', not this project's board '${CONFIG.boardId}'`,
			);
		});
	});

	// Issue #686 phase 1: Trello's routing axis is labels — a card's list is already
	// its status, so a label is what is left to claim a card.
	describe('resolveItemRepository', () => {
		const CANDIDATES = [
			{ repo: 'acme/default', routingToken: 'label-default' },
			{ repo: 'acme/second', routingToken: 'label-second' },
		];

		/** The card read answering with the given label ids and nothing else. */
		function mockIdLabels(...ids: string[]): void {
			mockTrello({ [`cards/${CARD_ID}`]: { id: CARD_ID, idLabels: ids } });
		}

		it('routes a card to the non-default repository whose label it carries', async () => {
			mockIdLabels('label-second');

			await expect(provider.resolveItemRepository(CARD_ID, CANDIDATES)).resolves.toEqual({
				status: 'routed',
				repo: 'acme/second',
			});
		});

		it('reports a card with no labels as unrouted', async () => {
			mockIdLabels();

			await expect(provider.resolveItemRepository(CARD_ID, CANDIDATES)).resolves.toEqual({
				status: 'unrouted',
			});
		});

		it('reports a card claimed by two repositories as ambiguous rather than picking one', async () => {
			mockIdLabels('label-second', 'label-default');

			await expect(provider.resolveItemRepository(CARD_ID, CANDIDATES)).resolves.toEqual({
				status: 'ambiguous',
				repos: ['acme/default', 'acme/second'],
			});
		});

		// The one case that makes ids rather than names load-bearing here: a Trello
		// label may legitimately be colour-only, with an empty name.
		it('routes a colour-only label by its id, exactly like any other', async () => {
			mockIdLabels('label-colour-only');

			await expect(
				provider.resolveItemRepository(CARD_ID, [
					{ repo: 'acme/second', routingToken: 'label-colour-only' },
				]),
			).resolves.toEqual({ status: 'routed', repo: 'acme/second' });
		});

		// The narrow read: `idLabels` is the plain id array, unlike the whole label
		// objects the shared card query selects for the automation gate.
		it('asks for the idLabels field alone, in one request', async () => {
			mockIdLabels('label-second');

			await provider.resolveItemRepository(CARD_ID, CANDIDATES);

			const reads = requestsTo(`cards/${CARD_ID}`);
			expect(reads).toHaveLength(1);
			expect(reads[0]?.searchParams.get('fields')).toBe('idLabels');
		});
	});

	// Issue #710: the linked URL names its own repository, so a card linked in *any*
	// of the project's repositories resolves — the provider is built from a config
	// scoped to one of them and no longer matches against that scope.
	describe('taskRepository', () => {
		// The real `scopeProjectToRepository` over one two-entry record, so this is the
		// config `processJob` genuinely hands a provider for the *default* repository.
		const [scopedToDefault] = createMockProjectRepositoryPair(['acme/android', 'acme/backend'], {
			pm: PROJECT.pm,
			credentials: PROJECT.credentials,
		});

		const linkedTo = (repository: string, number: number, id?: string) =>
			trelloCard({
				...(id ? { id } : {}),
				attachments: [{ url: `https://github.com/${repository}/issues/${number}` }],
				desc: 'No links here.',
			});

		it("resolves a card linked in the project's non-default repository", async () => {
			mockTrello({
				[`cards/${CARD_ID}`]: linkedTo('acme/backend', 7),
				[LISTS_PATH]: BOARD_LISTS,
			});

			await expect(
				new TrelloPMProvider(scopedToDefault).getWorkItem(CARD_ID),
			).resolves.toMatchObject({ taskRef: '7', taskRepository: 'acme/backend' });
		});

		// The assertion a fix applied one call site at a time cannot pass: one board
		// read, two repositories, each card answering for itself.
		it('resolves each card of a board-wide read against its own repository', async () => {
			mockTrello({
				[BOARD_CARDS_PATH]: [linkedTo('acme/android', 10), linkedTo('acme/backend', 11, 'card-2')],
				[LISTS_PATH]: BOARD_LISTS,
			});

			const items = await new TrelloPMProvider(scopedToDefault).listWorkItems();

			expect(items.map((item) => [item.taskRepository, item.taskRef])).toEqual([
				['acme/android', '10'],
				['acme/backend', '11'],
			]);
		});
	});

	describe('listWorkItems', () => {
		it('reads the whole board, scoped to this project and to open cards', async () => {
			mockTrello({
				[BOARD_CARDS_PATH]: [trelloCard(), trelloCard({ id: 'card-2', idList: TODO_LIST })],
				[LISTS_PATH]: BOARD_LISTS,
			});

			const items = await provider.listWorkItems();

			expect(items.map((item) => [item.id, item.statusKey])).toEqual([
				[CARD_ID, 'inProgress'],
				['card-2', 'todo'],
			]);
			expect(requestsTo(BOARD_CARDS_PATH)[0]?.searchParams.get('filter')).toBe('open');
			expect(requestsTo(BOARD_CARDS_PATH)[0]?.searchParams.get('limit')).toBe(String(PAGE_LIMIT));
		});

		it('narrows a status-filtered read to the mapped list endpoint', async () => {
			mockTrello({
				[`lists/${IN_PROGRESS_LIST}/cards`]: [trelloCard()],
				[LISTS_PATH]: BOARD_LISTS,
			});

			await expect(provider.listWorkItems({ status: 'inProgress' })).resolves.toMatchObject([
				{ id: CARD_ID },
			]);

			// Server-side narrowing: the whole board is never read for one status.
			expect(requestedPaths()).not.toContain(BOARD_CARDS_PATH);
			expect(requestsTo(`lists/${IN_PROGRESS_LIST}/cards`)[0]?.searchParams.get('filter')).toBe(
				'open',
			);
		});

		it('fails loudly on an unmapped status rather than widening to the whole board', async () => {
			mockTrello({ [BOARD_CARDS_PATH]: [], [LISTS_PATH]: BOARD_LISTS });

			await expect(provider.listWorkItems({ status: 'archived' })).rejects.toThrow(
				/no list ID mapped for canonical status 'archived'/,
			);
			expect(fetchMock).not.toHaveBeenCalled();
		});
	});

	describe('findWorkItemByUrlSuffix', () => {
		it("resolves nothing for the caller's GitHub-shaped suffix, which a card URL never carries", async () => {
			mockTrello({ [BOARD_CARDS_PATH]: [trelloCard()], [LISTS_PATH]: BOARD_LISTS });

			// The only caller is the legacy fallback in `respond-to-review.ts`; a Trello
			// board reports through SWARM's own durable `runs.work_item_id` link instead.
			// Since issue #735 that honest miss costs no request at all — and it is still
			// a miss, never a false positive.
			await expect(provider.findWorkItemByUrlSuffix('/issues/585')).resolves.toBeUndefined();
			expect(fetchMock).not.toHaveBeenCalled();
		});

		// Issue #735: the short link in a Trello URL *addresses* the card, so the
		// suffix is parsed into it rather than matched against every card on the board.
		it('reads the card the suffix’s short link names, without reading the board', async () => {
			mockTrello({ 'cards/H0TZyzbK': trelloCard(), [LISTS_PATH]: BOARD_LISTS });

			await expect(
				provider.findWorkItemByUrlSuffix('/c/H0TZyzbK/4-wire-triggers'),
			).resolves.toMatchObject({ id: CARD_ID });
		});

		it('rejects a card whose URL does not actually end with the suffix', async () => {
			mockTrello({ 'cards/H0TZyzbK': trelloCard(), [LISTS_PATH]: BOARD_LISTS });

			await expect(
				provider.findWorkItemByUrlSuffix('/c/H0TZyzbK/5-something-else'),
			).resolves.toBeUndefined();
		});

		// A short link addresses any card the token can see, so the board check is what
		// keeps this as board-scoped as the scan it replaced.
		it('rejects a card belonging to another board', async () => {
			mockTrello({
				'cards/H0TZyzbK': trelloCard({ idBoard: 'someone-elses-board' }),
				[LISTS_PATH]: BOARD_LISTS,
			});

			await expect(
				provider.findWorkItemByUrlSuffix('/c/H0TZyzbK/4-wire-triggers'),
			).resolves.toBeUndefined();
		});

		it('keeps a short link Trello cannot resolve a soft miss rather than a throw', async () => {
			mockTrello({
				'cards/H0TZyzbK': () => new Response(null, { status: 404 }),
				[LISTS_PATH]: BOARD_LISTS,
			});

			await expect(
				provider.findWorkItemByUrlSuffix('/c/H0TZyzbK/4-wire-triggers'),
			).resolves.toBeUndefined();
		});
	});

	describe('findWorkItemForArtifact', () => {
		it('matches the card whose attachment carries the issue URL', async () => {
			mockTrello({
				[BOARD_CARDS_PATH]: [
					trelloCard({ id: 'card-2', attachments: [], desc: 'unrelated' }),
					trelloCard(),
				],
				[LISTS_PATH]: BOARD_LISTS,
			});

			await expect(
				provider.findWorkItemForArtifact({ repository: REPO, kind: 'issue', number: '585' }),
			).resolves.toMatchObject({ id: CARD_ID, taskRef: '585' });
		});

		it('matches a pull-request artifact without letting it fill taskRef', async () => {
			mockTrello({
				[BOARD_CARDS_PATH]: [
					trelloCard({ attachments: [{ url: `https://github.com/${REPO}/pull/601` }], desc: '' }),
				],
				[LISTS_PATH]: BOARD_LISTS,
			});

			await expect(
				provider.findWorkItemForArtifact({ repository: REPO, kind: 'pullRequest', number: '601' }),
			).resolves.toMatchObject({ id: CARD_ID, taskRef: undefined });
		});

		it('misses softly when no card links the artifact', async () => {
			mockTrello({
				[BOARD_CARDS_PATH]: [trelloCard({ attachments: [], desc: 'no links' })],
				[LISTS_PATH]: BOARD_LISTS,
			});

			await expect(
				provider.findWorkItemForArtifact({ repository: REPO, kind: 'issue', number: '585' }),
			).resolves.toBeUndefined();
		});

		it('does not confuse a longer issue number sharing the requested prefix', async () => {
			mockTrello({
				[BOARD_CARDS_PATH]: [
					trelloCard({
						attachments: [{ url: `https://github.com/${REPO}/issues/5850` }],
						desc: '',
					}),
				],
				[LISTS_PATH]: BOARD_LISTS,
			});

			await expect(
				provider.findWorkItemForArtifact({ repository: REPO, kind: 'issue', number: '585' }),
			).resolves.toBeUndefined();
		});
	});

	describe('findWorkItemByDescriptionMarker', () => {
		it('matches the card whose description carries the marker', async () => {
			mockTrello({
				[BOARD_CARDS_PATH]: [trelloCard({ id: 'card-2', desc: 'nothing here' }), trelloCard()],
				[LISTS_PATH]: BOARD_LISTS,
			});

			await expect(
				provider.findWorkItemByDescriptionMarker(DESCRIPTION_MARKER),
			).resolves.toMatchObject({ id: CARD_ID });
		});

		it('misses softly so a retried split creates the child it has not created yet', async () => {
			mockTrello({
				[BOARD_CARDS_PATH]: [trelloCard({ desc: 'nothing here' })],
				[LISTS_PATH]: BOARD_LISTS,
			});

			await expect(
				provider.findWorkItemByDescriptionMarker(DESCRIPTION_MARKER),
			).resolves.toBeUndefined();
		});
	});

	describe('findComment', () => {
		const ACTIONS_PATH = `cards/${CARD_ID}/actions`;
		/** A full first page — what makes `collectTrelloPage` ask for a second one. */
		const FIRST_PAGE = Array.from({ length: PAGE_LIMIT }, (_, index) => ({
			id: `action-${index}`,
			data: { text: `progress update ${index}` },
		}));
		const LAST_OF_FIRST_PAGE = `action-${PAGE_LIMIT - 1}`;

		it('finds a marker beyond the first page, advancing the id cursor', async () => {
			mockTrello({
				[ACTIONS_PATH]: (url) =>
					url.searchParams.get('before') === LAST_OF_FIRST_PAGE
						? [{ id: 'action-old', data: { text: `plan published ${DESCRIPTION_MARKER}` } }]
						: FIRST_PAGE,
			});

			// Paging is load-bearing: a marker missed beyond page 1 makes a retry post a
			// duplicate comment.
			await expect(provider.findComment(CARD_ID, DESCRIPTION_MARKER)).resolves.toBe('action-old');

			const [first, second] = requestsTo(ACTIONS_PATH);
			expect(first?.searchParams.get('filter')).toBe('commentCard');
			expect(first?.searchParams.get('limit')).toBe(String(PAGE_LIMIT));
			expect(first?.searchParams.has('before')).toBe(false);
			expect(second?.searchParams.get('before')).toBe(LAST_OF_FIRST_PAGE);
		});

		it('answers undefined when no comment carries the marker', async () => {
			mockTrello({ [ACTIONS_PATH]: [{ id: 'action-1', data: { text: 'unrelated' } }] });

			await expect(provider.findComment(CARD_ID, DESCRIPTION_MARKER)).resolves.toBeUndefined();
		});
	});

	describe('discover', () => {
		it("lists the member's open boards, deduplicated and sorted by name", async () => {
			mockTrello({
				'members/me/boards': [
					{ id: 'board-z', name: 'zeta', url: 'https://trello.com/b/z' },
					{ id: 'board-a', name: 'Alpha', url: 'https://trello.com/b/a' },
					{ id: 'board-z', name: 'zeta duplicate' },
					{ id: 'board-nameless' },
					{ id: 'board-m', name: 'Mid' },
				],
			});

			await expect(provider.discover('containers', {})).resolves.toEqual({
				containers: [
					{ id: 'board-a', name: 'Alpha', url: 'https://trello.com/b/a' },
					{ id: 'board-m', name: 'Mid' },
					{ id: 'board-z', name: 'zeta', url: 'https://trello.com/b/z' },
				],
			});
			expect(requestsTo('members/me/boards')[0]?.searchParams.get('filter')).toBe('open');
		});

		it("lists a board's open lists in the board's own order, with no provider context", async () => {
			mockTrello({
				'boards/board-a/lists': [
					{ id: 'list-3', name: 'Done', pos: 196608 },
					{ id: 'list-unpositioned', name: 'Parked' },
					{ id: 'list-1', name: 'Backlog', pos: 65536 },
					{ id: 'list-nameless', pos: 1 },
				],
			});

			// Trello's own `pos` is the left-to-right order the operator is reading down;
			// a list id is the whole mapping, so nothing is threaded back.
			await expect(provider.discover('states', { containerId: 'board-a' })).resolves.toEqual({
				states: [
					{ id: 'list-1', name: 'Backlog' },
					{ id: 'list-3', name: 'Done' },
					{ id: 'list-unpositioned', name: 'Parked' },
				],
			});
			// The board being mapped, not the one already configured.
			expect(requestsTo('boards/board-a/lists')[0]?.searchParams.get('fields')).toBe('name,pos');
		});

		it('reports a board that does not resolve', async () => {
			mockTrello({ 'boards/board-missing/lists': undefined });

			await expect(provider.discover('states', { containerId: 'board-missing' })).rejects.toThrow(
				"Trello board 'board-missing' did not resolve",
			);
		});

		it('reports a board with no lists to map', async () => {
			mockTrello({ 'boards/board-empty/lists': [] });

			await expect(provider.discover('states', { containerId: 'board-empty' })).rejects.toThrow(
				"Trello board 'board-empty' has no lists to map",
			);
		});
	});

	describe('moveWorkItem', () => {
		it('moves the card into the list the mapping names for the canonical key', async () => {
			mockTrello({ [`cards/${CARD_ID}`]: undefined });

			await provider.moveWorkItem(CARD_ID, 'todo');

			// A card's status *is* its list, so a move is one ordinary field write —
			// there is no transition graph to negotiate the way Jira has.
			const [move] = callsTo(`cards/${CARD_ID}`);
			expect(move?.method).toBe('PUT');
			expect(move?.body).toEqual({ idList: TODO_LIST });
		});

		it('fails loudly on an unmapped status rather than writing blindly', async () => {
			mockTrello({ [`cards/${CARD_ID}`]: undefined });

			await expect(provider.moveWorkItem(CARD_ID, 'archived')).rejects.toThrow(
				/no list ID mapped for canonical status 'archived'/,
			);
			expect(fetchMock).not.toHaveBeenCalled();
		});
	});

	describe('addComment', () => {
		const COMMENTS_PATH = `cards/${CARD_ID}/actions/comments`;

		it('comments natively on the card and returns the comment action id', async () => {
			mockTrello({
				[COMMENTS_PATH]: { id: 'action-new', data: { text: 'Plan published' } },
			});

			// Trello models a card comment as an action, so the action id *is* the
			// comment id — the same id space `findComment` scans.
			await expect(provider.addComment(CARD_ID, 'Plan published')).resolves.toBe('action-new');

			const [posted] = callsTo(COMMENTS_PATH);
			expect(posted?.method).toBe('POST');
			// The body, not the query: an agent-written plan would overflow a request line.
			expect(posted?.body).toEqual({ text: 'Plan published' });
			expect(posted?.url.searchParams.has('text')).toBe(false);
		});

		it('reports a response carrying no comment id', async () => {
			mockTrello({ [COMMENTS_PATH]: {} });

			await expect(provider.addComment(CARD_ID, 'Plan published')).rejects.toThrow(
				`Trello returned no comment id for the comment posted on card '${CARD_ID}'`,
			);
		});
	});

	describe('updateWorkItem', () => {
		it('writes the patched fields under their Trello names', async () => {
			mockTrello({ [`cards/${CARD_ID}`]: undefined });

			await provider.updateWorkItem(CARD_ID, { title: 'Phase 1/2', description: 'First slice.' });

			const [update] = callsTo(`cards/${CARD_ID}`);
			expect(update?.method).toBe('PUT');
			expect(update?.body).toEqual({ name: 'Phase 1/2', desc: 'First slice.' });
		});

		it('leaves a field the patch does not name untouched', async () => {
			mockTrello({ [`cards/${CARD_ID}`]: undefined });

			await provider.updateWorkItem(CARD_ID, { description: 'Rescoped.' });

			expect(callsTo(`cards/${CARD_ID}`)[0]?.body).toEqual({ desc: 'Rescoped.' });
		});

		it('issues no request at all for an empty patch', async () => {
			mockTrello({ [`cards/${CARD_ID}`]: undefined });

			// An empty write is not "nothing to write": it would still bump the card's
			// `dateLastActivity`.
			await provider.updateWorkItem(CARD_ID, {});

			expect(fetchMock).not.toHaveBeenCalled();
		});
	});

	describe('createWorkItem', () => {
		const BOARD_LABELS_PATH = `boards/${CONFIG.boardId}/labels`;

		/** A card as `POST /cards` answers it — no `members`, no `attachments`. */
		const CREATED_CARD = {
			id: 'card-new',
			name: 'Wire triggers',
			desc: 'Wire the triggers.',
			url: 'https://trello.com/c/NEWCARD01/9-wire-triggers',
			shortUrl: 'https://trello.com/c/NEWCARD01',
			idList: TODO_LIST,
			idBoard: CONFIG.boardId,
			dateLastActivity: '2026-08-10T00:00:00.000Z',
			labels: [{ id: 'label-swarm', name: 'swarm', color: 'green' }],
		};

		const INPUT = {
			title: 'Wire triggers',
			description: 'Wire the triggers.',
			status: 'todo',
			labels: ['Swarm'],
		};

		it('creates in the mapped list with resolved label ids, and maps the response back', async () => {
			mockTrello({
				[BOARD_LABELS_PATH]: [{ id: 'label-swarm', name: 'swarm' }],
				cards: CREATED_CARD,
				[LISTS_PATH]: BOARD_LISTS,
			});

			const item = await provider.createWorkItem(INPUT);

			const [created] = callsTo('cards');
			expect(created?.method).toBe('POST');
			// A Trello label is a board-scoped object, so the *name* the contract takes
			// is resolved to the board's own id before the card exists.
			expect(created?.body).toEqual({
				idList: TODO_LIST,
				name: 'Wire triggers',
				desc: 'Wire the triggers.',
				idLabels: ['label-swarm'],
			});
			// The board already carried the label, in another case — nothing was created.
			expect(callsTo(BOARD_LABELS_PATH).map((call) => call.method)).toEqual(['GET']);
			// Mapped through the same `toWorkItem` the reads use, so a fresh card reads
			// identically to one off a board read.
			expect(item).toEqual({
				id: 'card-new',
				title: 'Wire triggers',
				description: 'Wire the triggers.',
				url: 'https://trello.com/c/NEWCARD01/9-wire-triggers',
				// Nothing has linked an SCM artifact to a card that was created seconds ago,
				// so neither half of the pair is set (issue #710).
				taskRef: undefined,
				taskRepository: undefined,
				status: 'Ready',
				statusId: TODO_LIST,
				statusKey: 'todo',
				labels: [{ id: 'label-swarm', name: 'swarm', color: 'green' }],
				assignees: [],
				createdAt: undefined,
				updatedAt: '2026-08-10T00:00:00.000Z',
			});
		});

		it('creates a board label the board does not carry yet', async () => {
			mockTrello({
				[BOARD_LABELS_PATH]: (_url, method) => (method === 'POST' ? { id: 'label-made' } : []),
				cards: { ...CREATED_CARD, labels: [{ id: 'label-made', name: 'Swarm' }] },
				[LISTS_PATH]: BOARD_LISTS,
			});

			await provider.createWorkItem(INPUT);

			const [, made] = callsTo(BOARD_LABELS_PATH);
			expect(made?.method).toBe('POST');
			expect(made?.body).toEqual({ name: 'Swarm', color: 'green' });
			expect(callsTo('cards')[0]?.body).toMatchObject({ idLabels: ['label-made'] });
		});

		it('omits the label list entirely when the input names none', async () => {
			mockTrello({ cards: CREATED_CARD, [LISTS_PATH]: BOARD_LISTS });

			await provider.createWorkItem({ ...INPUT, labels: undefined });

			expect(callsTo('cards')[0]?.body).toEqual({
				idList: TODO_LIST,
				name: 'Wire triggers',
				desc: 'Wire the triggers.',
			});
		});

		it('fails loudly on an unmapped status rather than creating an unplaced card', async () => {
			mockTrello({ cards: CREATED_CARD });

			await expect(provider.createWorkItem({ ...INPUT, status: 'archived' })).rejects.toThrow(
				/no list ID mapped for canonical status 'archived'/,
			);
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it('reports a response carrying no card id', async () => {
			mockTrello({ cards: {}, [BOARD_LABELS_PATH]: [], [LISTS_PATH]: BOARD_LISTS });

			await expect(provider.createWorkItem({ ...INPUT, labels: [] })).rejects.toThrow(
				"Trello returned no card id for the card created as 'Wire triggers'",
			);
		});
	});

	describe('addLabel', () => {
		const BOARD_LABELS_PATH = `boards/${CONFIG.boardId}/labels`;
		const CARD_LABELS_PATH = `cards/${CARD_ID}/idLabels`;
		const UNLABELLED_CARD = { id: CARD_ID, labels: [] };

		it('no-ops when the card already carries the name in another case', async () => {
			mockTrello({
				[`cards/${CARD_ID}`]: { id: CARD_ID, labels: [{ id: 'label-planned', name: 'Planned' }] },
			});

			await provider.addLabel(CARD_ID, 'planned');

			// Contractual idempotence, checked rather than left to how Trello answers a
			// repeat: neither the board's labels nor the card were written.
			expect(requestedPaths()).toEqual([`cards/${CARD_ID}`]);
		});

		it('creates the missing board label, then applies it to the card', async () => {
			mockTrello({
				[`cards/${CARD_ID}`]: UNLABELLED_CARD,
				[BOARD_LABELS_PATH]: (_url, method) => (method === 'POST' ? { id: 'label-made' } : []),
				[CARD_LABELS_PATH]: ['label-made'],
			});

			await provider.addLabel(CARD_ID, 'planned');

			const [lookup, create] = callsTo(BOARD_LABELS_PATH);
			// Load-bearing: `GET /boards/{id}/labels` defaults to 50, so without this a
			// busy board would miss an existing label and create a duplicate.
			expect(lookup?.url.searchParams.get('limit')).toBe(String(PAGE_LIMIT));
			expect(create?.method).toBe('POST');
			expect(create?.body).toEqual({ name: 'planned', color: 'green' });
			// A single label id is bounded, so it rides the query Trello documents.
			const [applied] = callsTo(CARD_LABELS_PATH);
			expect(applied?.method).toBe('POST');
			expect(applied?.url.searchParams.get('value')).toBe('label-made');
		});

		it('re-resolves the board label when a concurrent writer wins the create', async () => {
			let createAttempted = false;
			mockTrello({
				[`cards/${CARD_ID}`]: UNLABELLED_CARD,
				[BOARD_LABELS_PATH]: (_url, method) => {
					if (method !== 'POST') {
						return createAttempted ? [{ id: 'label-raced', name: 'Planned' }] : [];
					}
					createAttempted = true;
					return new Response('label already exists', { status: 400 });
				},
				[CARD_LABELS_PATH]: ['label-raced'],
			});

			await provider.addLabel(CARD_ID, 'planned');

			// The label the race left behind is the one applied — the caller's need is met.
			expect(callsTo(CARD_LABELS_PATH)[0]?.url.searchParams.get('value')).toBe('label-raced');
		});

		it('rethrows a failed label create the re-read cannot explain away', async () => {
			mockTrello({
				[`cards/${CARD_ID}`]: UNLABELLED_CARD,
				[BOARD_LABELS_PATH]: (_url, method) =>
					method === 'POST' ? new Response('invalid token', { status: 401 }) : [],
			});

			// Nothing carries the name afterwards, so this was not a lost race.
			await expect(provider.addLabel(CARD_ID, 'planned')).rejects.toThrow(
				`Trello API request failed (401) for /boards/${CONFIG.boardId}/labels: invalid token`,
			);
		});

		it('treats Trello refusing an already-applied label as success', async () => {
			mockTrello({
				[`cards/${CARD_ID}`]: UNLABELLED_CARD,
				[BOARD_LABELS_PATH]: [{ id: 'label-planned', name: 'planned' }],
				[CARD_LABELS_PATH]: new Response('that label is already on the card', { status: 400 }),
			});

			// Applied between the card read and this write — the card carries it either way.
			await expect(provider.addLabel(CARD_ID, 'planned')).resolves.toBeUndefined();
		});

		it('propagates any other rejection of the label write', async () => {
			mockTrello({
				[`cards/${CARD_ID}`]: UNLABELLED_CARD,
				[BOARD_LABELS_PATH]: [{ id: 'label-planned', name: 'planned' }],
				[CARD_LABELS_PATH]: new Response('invalid value for idLabels', { status: 400 }),
			});

			await expect(provider.addLabel(CARD_ID, 'planned')).rejects.toThrow(
				/invalid value for idLabels/,
			);
		});
	});

	describe('the declared dependency opt-out', () => {
		it('reports no blockers and records none, without touching the API', async () => {
			mockTrello({});

			// `supportsDependencies: false` is the contract's opt-out (`src/pm/types.ts`),
			// not an unfinished method: Trello models no cross-card blocking
			// relationship, and the prose references a description can carry are GitHub
			// issue numbers only an SCM provider could resolve — the cross-category reach
			// ai/RULES.md §2 forbids. Callers fall back to the comment guard instead.
			await expect(provider.listBlockers()).resolves.toEqual([]);
			await expect(provider.addBlockedBy()).resolves.toBeUndefined();
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it('reports no dependents either — the reverse edge opts out the same way', async () => {
			mockTrello({});

			// Issue #639's cycle backstop reads this, and a provider that gates on
			// nothing has no cycle to suppress. Answering it from prose would be worse
			// than answering `[]`: this read is what *excuses* a blocker.
			await expect(provider.listDependents()).resolves.toEqual([]);
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it('stubs no contract method, which is what the manifest phase is gated on', () => {
			// The same scan the PM conformance suite runs against every *registered*
			// manifest (ai/TESTING.md "Provider conformance"). Asserted here because
			// Trello registers nothing yet, so that suite cannot see it.
			for (const method of CONTRACT_METHODS) {
				expect(String(provider[method]), method).not.toMatch(/\bnot\s+implemented\b/i);
			}
		});
	});
});
