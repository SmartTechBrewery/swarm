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
import { createMockTrelloProjectConfig } from '../../../../helpers/factories.js';

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
type Responder = ResponseBody | ((url: URL) => ResponseBody);

let fetchMock: FetchMock;

/**
 * Route the stubbed transport by the REST path, anchored, so an unexpected
 * endpoint fails loudly instead of silently reusing another route's payload.
 * Each handler sees the request URL, which is where the `fields`, `filter` and
 * paging parameters the provider built show up.
 */
function mockTrello(routes: Record<string, Responder>): void {
	fetchMock.mockImplementation(async (input) => {
		const url = new URL(String(input));
		const path = url.pathname.replace(/^\/1\//, '');
		const pattern = Object.keys(routes).find((candidate) =>
			new RegExp(`^${candidate}$`).test(path),
		);
		if (pattern === undefined) {
			throw new Error(`Unexpected Trello request '${path}'`);
		}
		const responder = routes[pattern];
		const body = typeof responder === 'function' ? responder(url) : responder;
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

/** The board's lists, as `GET /boards/{id}/lists` reports them. */
const BOARD_LISTS = [
	{ id: CONFIG.statusOptions.backlog, name: 'Backlog', pos: 65536 },
	{ id: TODO_LIST, name: 'Ready', pos: 131072 },
	{ id: IN_PROGRESS_LIST, name: 'In progress', pos: 196608 },
];

const LISTS_PATH = `boards/${CONFIG.boardId}/lists`;
const BOARD_CARDS_PATH = `boards/${CONFIG.boardId}/cards`;

const DESCRIPTION_MARKER = '<!-- swarm-split-child:2490f13f:0 -->';

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
			{
				label: 'an issue link in another repository',
				attachments: [{ url: 'https://github.com/acme/other/issues/585' }],
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
			await expect(provider.findWorkItemByUrlSuffix('/issues/585')).resolves.toBeUndefined();
		});

		it('matches a Trello-shaped suffix over the board read', async () => {
			mockTrello({
				[BOARD_CARDS_PATH]: [
					trelloCard({ id: 'card-2', url: 'https://trello.com/c/AAAAAAAA/5-other' }),
					trelloCard(),
				],
				[LISTS_PATH]: BOARD_LISTS,
			});

			await expect(
				provider.findWorkItemByUrlSuffix('/c/H0TZyzbK/4-wire-triggers'),
			).resolves.toMatchObject({ id: CARD_ID });
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

	describe('phase 3 stubs', () => {
		it.each([
			['moveWorkItem', () => provider.moveWorkItem()],
			['addComment', () => provider.addComment()],
			['createWorkItem', () => provider.createWorkItem()],
			['updateWorkItem', () => provider.updateWorkItem()],
			['addLabel', () => provider.addLabel()],
			['listBlockers', () => provider.listBlockers()],
			['addBlockedBy', () => provider.addBlockedBy()],
		])('%s carries the not-implemented sentinel until the writes land', async (name, call) => {
			// The sentinel is what the PM conformance suite scans a *registered*
			// provider's source for; Trello registers nothing yet, which is why these
			// may still throw (ai/RULES.md §2).
			await expect(call()).rejects.toThrow(`${name} is not implemented for the Trello PM provider`);
		});
	});
});
