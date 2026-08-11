import { beforeEach, describe, expect, it, vi } from 'vitest';

const { findProjectByIdFromDb } = vi.hoisted(() => ({ findProjectByIdFromDb: vi.fn() }));
const { closeDb } = vi.hoisted(() => ({ closeDb: vi.fn(async () => undefined) }));
const { listTrelloWebhooks, createTrelloWebhook, deleteTrelloWebhook } = vi.hoisted(() => ({
	listTrelloWebhooks: vi.fn(),
	createTrelloWebhook: vi.fn(),
	deleteTrelloWebhook: vi.fn(),
}));

vi.mock('@/db/repositories/projectsRepository.js', () => ({ findProjectByIdFromDb }));
vi.mock('@/db/client.js', () => ({ closeDb }));
// The three API calls are the seam: this suite is about the command's decisions
// (provider check, callback URL, idempotency, error reporting), not Trello's REST
// shapes — those are covered by tests/unit/integrations/pm/trello/webhooks.test.ts.
vi.mock('@/integrations/pm/trello/webhooks.js', () => ({
	listTrelloWebhooks,
	createTrelloWebhook,
	deleteTrelloWebhook,
	swarmWebhookDescription: (project: { id: string }) =>
		`SWARM board webhook (project ${project.id})`,
}));

import { run } from '@/cli/commands/pm.js';
import { trelloManifest } from '@/integrations/pm/trello/index.js';
import {
	createMockProjectConfig,
	createMockTrelloProjectConfig,
} from '../../../helpers/factories.js';

const BASE_URL = 'https://swarm.example.com';
const TRELLO_PROJECT = createMockTrelloProjectConfig({ id: 'proj-trello' });
const BOARD_ID = TRELLO_PROJECT.pm.type === 'trello' ? TRELLO_PROJECT.pm.boardId : '';
const CALLBACK_URL = `${BASE_URL}${trelloManifest.webhookRoute}`;

function existingWebhook(overrides: Record<string, unknown> = {}) {
	return {
		id: 'hook-1',
		idModel: BOARD_ID,
		callbackURL: CALLBACK_URL,
		description: 'SWARM board webhook (project proj-trello)',
		active: true,
		...overrides,
	};
}

/** Everything the command printed, across all three streams. */
function printed(): string {
	return [
		...vi.mocked(console.log).mock.calls,
		...vi.mocked(console.warn).mock.calls,
		...vi.mocked(console.error).mock.calls,
	]
		.map((args) => args.join(' '))
		.join('\n');
}

describe('swarm pm webhook', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.stubEnv('WEBHOOK_CALLBACK_BASE_URL', BASE_URL);
		findProjectByIdFromDb.mockReset().mockResolvedValue(TRELLO_PROJECT);
		listTrelloWebhooks.mockReset().mockResolvedValue([]);
		createTrelloWebhook.mockReset().mockResolvedValue(existingWebhook({ id: 'hook-new' }));
		deleteTrelloWebhook.mockReset().mockResolvedValue(undefined);
		closeDb.mockClear();
	});

	it('creates the webhook against the board and the manifest-derived callback URL', async () => {
		expect(await run(['webhook', 'create', '--project', 'proj-trello'])).toBe(0);

		expect(createTrelloWebhook).toHaveBeenCalledWith(TRELLO_PROJECT, {
			idModel: BOARD_ID,
			callbackUrl: `${BASE_URL}/trello/webhook`,
		});
		expect(printed()).toContain('hook-new');
		expect(closeDb).toHaveBeenCalledTimes(1);
	});

	// Trello creates a second identical subscription happily, which would double every
	// delivery — so `create` matches on board + callback URL first.
	it('is idempotent against an identical existing webhook', async () => {
		listTrelloWebhooks.mockResolvedValue([existingWebhook()]);

		expect(await run(['webhook', 'create', '--project', 'proj-trello'])).toBe(0);

		expect(createTrelloWebhook).not.toHaveBeenCalled();
		expect(printed()).toContain('already registered as hook-1');
	});

	it('creates when an existing webhook watches the same board at a different URL', async () => {
		listTrelloWebhooks.mockResolvedValue([
			existingWebhook({
				id: 'hook-stale',
				callbackURL: 'https://old-tunnel.example.com/trello/webhook',
			}),
		]);

		expect(await run(['webhook', 'create', '--project', 'proj-trello'])).toBe(0);

		expect(createTrelloWebhook).toHaveBeenCalledTimes(1);
	});

	it("surfaces Trello's refusal with the HEAD-confirmation hint and exits 1", async () => {
		createTrelloWebhook.mockRejectedValue(
			new Error(
				'Trello API request failed (400) for /tokens/{token}/webhooks: URL did not return 200',
			),
		);

		expect(await run(['webhook', 'create', '--project', 'proj-trello'])).toBe(1);

		const output = printed();
		expect(output).toContain('URL did not return 200');
		expect(output).toContain('HEAD request to the callback URL');
		expect(output).toContain(CALLBACK_URL);
	});

	// The HMAC covers the exact callback URL, so a webhook registered against a
	// request-derived one would 401 every later delivery.
	it('refuses every action when WEBHOOK_CALLBACK_BASE_URL is unset', async () => {
		vi.stubEnv('WEBHOOK_CALLBACK_BASE_URL', '');

		expect(await run(['webhook', 'create', '--project', 'proj-trello'])).toBe(1);

		expect(createTrelloWebhook).not.toHaveBeenCalled();
		expect(listTrelloWebhooks).not.toHaveBeenCalled();
		expect(printed()).toContain('WEBHOOK_CALLBACK_BASE_URL is not set');
	});

	it('refuses a project on another PM provider', async () => {
		findProjectByIdFromDb.mockResolvedValue(createMockProjectConfig({ id: 'proj-gh' }));

		expect(await run(['webhook', 'create', '--project', 'proj-gh'])).toBe(1);

		expect(createTrelloWebhook).not.toHaveBeenCalled();
		expect(printed()).toContain('only supported for Trello');
	});

	it('reports an unknown project', async () => {
		findProjectByIdFromDb.mockResolvedValue(undefined);

		expect(await run(['webhook', 'create', '--project', 'nope'])).toBe(1);
		expect(printed()).toContain("no project with id 'nope'");
	});

	it("lists the token's webhooks, marking this project's own", async () => {
		listTrelloWebhooks.mockResolvedValue([
			existingWebhook(),
			existingWebhook({ id: 'hook-other', idModel: 'other-board', active: false }),
		]);

		expect(await run(['webhook', 'list', '--project', 'proj-trello'])).toBe(0);

		const output = printed();
		expect(output).toContain(
			`hook-1\tboard ${BOARD_ID}\t${CALLBACK_URL}\t(this project's board webhook)`,
		);
		expect(output).toContain('hook-other');
		expect(output).toContain('inactive');
	});

	it('deletes by id, and requires one', async () => {
		expect(await run(['webhook', 'delete', '--project', 'proj-trello', '--id', 'hook-1'])).toBe(0);
		expect(deleteTrelloWebhook).toHaveBeenCalledWith(TRELLO_PROJECT, 'hook-1');

		expect(await run(['webhook', 'delete', '--project', 'proj-trello'])).toBe(1);
		expect(deleteTrelloWebhook).toHaveBeenCalledTimes(1);
		expect(printed()).toContain('--id <webhook-id> is required');
	});

	it('reports a failed call and still closes the db', async () => {
		listTrelloWebhooks.mockRejectedValue(new Error('Trello API request failed (401)'));

		expect(await run(['webhook', 'list', '--project', 'proj-trello'])).toBe(1);
		expect(printed()).toContain('pm webhook list failed');
		expect(closeDb).toHaveBeenCalledTimes(1);
	});

	it('requires --project', async () => {
		expect(await run(['webhook', 'create'])).toBe(1);
		expect(findProjectByIdFromDb).not.toHaveBeenCalled();
	});

	it('returns 1 for an unknown subcommand or action, and 0 for --help', async () => {
		expect(await run(['frobnicate'])).toBe(1);
		expect(await run(['webhook', 'frobnicate'])).toBe(1);
		expect(await run([])).toBe(1);
		expect(await run(['--help'])).toBe(0);
		expect(await run(['webhook', '--help'])).toBe(0);
		expect(findProjectByIdFromDb).not.toHaveBeenCalled();
	});
});
