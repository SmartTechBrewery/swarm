import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted so the mock factory below can use it before the hoisted `import`s run.
const { requirePmCredential } = vi.hoisted(() => ({
	requirePmCredential: vi.fn<(project: unknown, role: string) => Promise<string>>(),
}));

// The credential seam is mocked so these run without a secret store; `fetch` is the
// only other stand-in, so the real client — its key/token query scoping and its
// error redaction — runs for real.
vi.mock('@/config/provider.js', () => ({ requirePmCredential }));

import {
	createTrelloWebhook,
	deleteTrelloWebhook,
	listTrelloWebhooks,
	swarmWebhookDescription,
} from '@/integrations/pm/trello/webhooks.js';
import { createMockTrelloProjectConfig } from '../../../../helpers/factories.js';

const PROJECT = createMockTrelloProjectConfig({ id: 'proj-trello' });
const TOKEN = 'trello-token';
const BOARD_ID = '5d1b2c3d4e5f60718293a4b5';
const CALLBACK_URL = 'https://swarm.example.com/trello/webhook';

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

function respondWith(body: unknown, status = 200): void {
	fetchMock.mockResolvedValue(
		new Response(body === undefined ? null : JSON.stringify(body), {
			status,
			headers: { 'content-type': 'application/json' },
		}),
	);
}

/** The URL of the one request made, parsed. */
function requestedUrl(): URL {
	return new URL(String(fetchMock.mock.calls[0]?.[0]));
}

describe('trello webhook administration', () => {
	beforeEach(() => {
		fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal('fetch', fetchMock);
		requirePmCredential.mockImplementation(async (_project, role) =>
			role === 'apiKey' ? 'trello-api-key' : TOKEN,
		);
	});

	describe('listTrelloWebhooks', () => {
		it("addresses the scoped token's collection and flattens the response", async () => {
			respondWith([
				{
					id: 'hook-1',
					idModel: BOARD_ID,
					callbackURL: CALLBACK_URL,
					description: 'SWARM board webhook (project proj-trello)',
					active: true,
				},
				// Dropped: unusable without the two fields every caller matches on.
				null,
				{ id: 'hook-2', callbackURL: CALLBACK_URL },
				{ id: 'hook-3', idModel: 'other-board', callbackURL: 'https://elsewhere/hook' },
			]);

			const webhooks = await listTrelloWebhooks(PROJECT);

			expect(webhooks.map((webhook) => webhook.id)).toEqual(['hook-1', 'hook-3']);
			// An absent `active` reads as active — Trello only sets it false itself.
			expect(webhooks[1]).toMatchObject({ active: true, description: '' });

			// The token in the path is the scoped credential's, never an argument, and the
			// key/token pair still rides the query.
			const url = requestedUrl();
			expect(url.pathname).toBe(`/1/tokens/${TOKEN}/webhooks`);
			expect(url.searchParams.get('key')).toBe('trello-api-key');
			expect(url.searchParams.get('token')).toBe(TOKEN);
			expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('GET');
		});

		it('answers an empty list for an empty body', async () => {
			respondWith(undefined);

			expect(await listTrelloWebhooks(PROJECT)).toEqual([]);
		});

		// The whole point of the client's path redaction: the token addresses this
		// collection, so an unredacted failure message would log a live credential.
		it('never puts the token in a failed request error', async () => {
			respondWith({ message: 'invalid token' }, 401);

			const error = await listTrelloWebhooks(PROJECT).catch((err: unknown) => err);

			expect(String(error)).toContain(
				'Trello API request failed (401) for /tokens/{token}/webhooks',
			);
			expect(String(error)).not.toContain(TOKEN);
		});
	});

	describe('createTrelloWebhook', () => {
		it('posts the callback URL, the board id and a SWARM-identifying description', async () => {
			respondWith({
				id: 'hook-new',
				idModel: BOARD_ID,
				callbackURL: CALLBACK_URL,
				description: swarmWebhookDescription(PROJECT),
				active: true,
			});

			const created = await createTrelloWebhook(PROJECT, {
				idModel: BOARD_ID,
				callbackUrl: CALLBACK_URL,
			});

			expect(created).toEqual({
				id: 'hook-new',
				idModel: BOARD_ID,
				callbackURL: CALLBACK_URL,
				description: 'SWARM board webhook (project proj-trello)',
				active: true,
			});

			const [, init] = fetchMock.mock.calls[0] ?? [];
			expect(requestedUrl().pathname).toBe(`/1/tokens/${TOKEN}/webhooks`);
			expect(init?.method).toBe('POST');
			expect(JSON.parse(String(init?.body))).toEqual({
				callbackURL: CALLBACK_URL,
				idModel: BOARD_ID,
				description: 'SWARM board webhook (project proj-trello)',
			});
		});

		it('throws when Trello answers without a webhook object', async () => {
			respondWith(undefined);

			await expect(
				createTrelloWebhook(PROJECT, { idModel: BOARD_ID, callbackUrl: CALLBACK_URL }),
			).rejects.toThrow(/returned no webhook object/);
		});

		// Trello confirms a subscription with a HEAD probe first, so this is the failure
		// the CLI turns into its reachability hint.
		it('propagates Trello refusing the subscription', async () => {
			respondWith(`URL (${CALLBACK_URL}) did not return 200 status code`, 400);

			await expect(
				createTrelloWebhook(PROJECT, { idModel: BOARD_ID, callbackUrl: CALLBACK_URL }),
			).rejects.toThrow(/Trello API request failed \(400\)/);
		});
	});

	describe('deleteTrelloWebhook', () => {
		it('targets the webhook by id', async () => {
			respondWith(undefined);

			await deleteTrelloWebhook(PROJECT, 'hook-1');

			expect(requestedUrl().pathname).toBe('/1/webhooks/hook-1');
			expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('DELETE');
		});
	});
});
