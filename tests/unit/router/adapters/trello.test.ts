import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockTrelloProjectConfig } from '../../../helpers/factories.js';

vi.mock('@/config/provider.js', () => ({
	findProjectByTrelloBoard: vi.fn(),
}));
vi.mock('@/integrations/pm/trello/identity.js', () => ({
	resolveTrelloMemberId: vi.fn(),
}));

import { findProjectByTrelloBoard } from '@/config/provider.js';
import { requireTrelloConfig } from '@/integrations/pm/trello/config-schema.js';
import { resolveTrelloMemberId } from '@/integrations/pm/trello/identity.js';
import { logger } from '@/lib/logger.js';
import { TrelloRouterAdapter } from '@/router/adapters/trello.js';

const project = createMockTrelloProjectConfig({ id: 'proj-trello' });
const config = requireTrelloConfig(project);

/** The Trello member id the project's token authenticates as. */
const BOARD_MEMBER_ID = '5d1b2c3d4e5f60718293a4b5';
const HUMAN_MEMBER_ID = '61a2b3c4d5e6f70819243a5b';
const CARD_ID = '65e0a1b2c3d4e5f60718293a';

/**
 * A Trello card action delivery, shaped as Trello actually sends one
 * (developer.atlassian.com/cloud/trello/guides/rest-api/webhooks): the action
 * name in the body's `action.type`, the actor in `action.idMemberCreator`, and —
 * for a card that changed column — `listBefore`/`listAfter` in `action.data`.
 */
function trelloPayload(actionOverrides: Record<string, unknown> = {}): Record<string, unknown> {
	const { data, ...rest } = actionOverrides as { data?: Record<string, unknown> };
	return {
		action: {
			id: '65f0a1b2c3d4e5f60718293a',
			idMemberCreator: HUMAN_MEMBER_ID,
			type: 'updateCard',
			date: '2026-08-10T12:00:00.000Z',
			memberCreator: { id: HUMAN_MEMBER_ID, username: 'ada' },
			data: {
				card: { id: CARD_ID, name: 'Wire triggers', idShort: 42, shortLink: 'aBcDeFgH' },
				board: { id: config.boardId, name: 'SWARM', shortLink: 'ZyXwVuTs' },
				old: { idList: config.statusOptions.todo },
				listBefore: { id: config.statusOptions.todo, name: 'Ready' },
				listAfter: { id: config.statusOptions.inProgress, name: 'In progress' },
				...data,
			},
			...rest,
		},
		model: { id: config.boardId, name: 'SWARM' },
	};
}

/** The same delivery for a card edit that did *not* change the card's list. */
function renamePayload() {
	return trelloPayload({
		data: {
			old: { name: 'Wire trigger' },
			listBefore: undefined,
			listAfter: undefined,
		},
	});
}

describe('TrelloRouterAdapter', () => {
	const adapter = new TrelloRouterAdapter();

	/** Parse a payload the way the receiver does for a provider on its own route. */
	function parse(payload: unknown) {
		const event = adapter.parseWebhook('', payload);
		if (!event) throw new Error('expected the Trello payload to parse');
		return event;
	}

	beforeEach(() => {
		vi.mocked(findProjectByTrelloBoard).mockReset();
		vi.mocked(resolveTrelloMemberId).mockReset();
	});

	describe('parseWebhook', () => {
		it('normalizes a card moved between lists into the provider-neutral event', () => {
			expect(adapter.parseWebhook('', trelloPayload())).toEqual({
				itemId: CARD_ID,
				containerId: config.boardId,
				action: 'updated',
				changedField: 'idList',
				changedFieldType: 'list',
				contentType: 'Card',
				actorHandle: HUMAN_MEMBER_ID,
			});
		});

		it.each([
			['createCard', 'created'],
			['updateCard', 'updated'],
			['deleteCard', 'deleted'],
		])("maps Trello's %s action to the neutral %s action", (type, neutral) => {
			expect(parse(trelloPayload({ type })).action).toBe(neutral);
		});

		it('carries a card action outside the neutral vocabulary through verbatim', () => {
			expect(parse(trelloPayload({ type: 'commentCard' })).action).toBe('commentCard');
		});

		// The whole point of keying on `listAfter`: Trello delivers an `updateCard`
		// for *every* card edit, so a rename must still parse (it is a real board
		// event) but must carry no changed field, so the status gate below drops it.
		it('marks no changed field for a card edit that did not change its list', () => {
			const parsed = parse(renamePayload());
			expect(parsed.action).toBe('updated');
			expect(parsed.changedField).toBeUndefined();
			expect(parsed.changedFieldType).toBeUndefined();
		});

		it('marks no changed field on a card created in a list', () => {
			const parsed = parse(
				trelloPayload({
					type: 'createCard',
					data: {
						list: { id: config.statusOptions.todo, name: 'Ready' },
						listBefore: undefined,
						listAfter: undefined,
						old: undefined,
					},
				}),
			);
			expect(parsed.changedField).toBeUndefined();
		});

		// A board-scoped delivery names the board only on the webhook's own `model`.
		it('falls back to model.id when the action carries no board', () => {
			const payload = trelloPayload({ data: { board: undefined } });
			expect(parse(payload).containerId).toBe(config.boardId);
		});

		it('returns null for a payload that is not an object at all', () => {
			expect(adapter.parseWebhook('', 'not json')).toBeNull();
			expect(adapter.parseWebhook('', null)).toBeNull();
		});

		it('returns null when the delivery names no card', () => {
			expect(adapter.parseWebhook('', trelloPayload({ data: { card: undefined } }))).toBeNull();
		});

		it('returns null when neither the action nor the model names a board', () => {
			const payload = trelloPayload({ data: { board: undefined } });
			delete payload.model;
			expect(adapter.parseWebhook('', payload)).toBeNull();
		});

		it('parses a delivery that carries no actor at all', () => {
			expect(parse(trelloPayload({ idMemberCreator: undefined })).actorHandle).toBeUndefined();
		});
	});

	describe('resolveProject', () => {
		it('resolves the owning project by Trello board id', async () => {
			vi.mocked(findProjectByTrelloBoard).mockResolvedValue(project);
			expect(await adapter.resolveProject(parse(trelloPayload()))).toBe(project);
			expect(findProjectByTrelloBoard).toHaveBeenCalledWith(config.boardId);
		});

		it('returns null for an untracked board', async () => {
			vi.mocked(findProjectByTrelloBoard).mockResolvedValue(undefined);
			expect(await adapter.resolveProject(parse(trelloPayload()))).toBeNull();
		});
	});

	describe('isStatusChange', () => {
		// A Trello card's status *is* its list, so dragging it between columns is the
		// only way its status changes — and it arrives as this `listAfter` action.
		it('is true for a card moved between lists', () => {
			expect(adapter.isStatusChange(parse(trelloPayload()), project)).toBe(true);
		});

		it('is true for a card created on the board', () => {
			const payload = trelloPayload({
				type: 'createCard',
				data: { listAfter: undefined, listBefore: undefined },
			});
			expect(adapter.isStatusChange(parse(payload), project)).toBe(true);
		});

		it('is false for a card edit that did not change its list', () => {
			expect(adapter.isStatusChange(parse(renamePayload()), project)).toBe(false);
		});

		it.each([
			'deleteCard',
			'commentCard',
			'addLabelToCard',
		])('is false for a %s delivery', (type) => {
			const payload = trelloPayload({
				type,
				data: { listAfter: undefined, listBefore: undefined },
			});
			expect(adapter.isStatusChange(parse(payload), project)).toBe(false);
		});
	});

	describe('isSelfAuthored (loop prevention)', () => {
		it("is true when SWARM's own Trello token made the change", async () => {
			vi.mocked(resolveTrelloMemberId).mockResolvedValue(BOARD_MEMBER_ID);
			const event = parse(trelloPayload({ idMemberCreator: BOARD_MEMBER_ID }));
			expect(await adapter.isSelfAuthored(event, project)).toBe(true);
			expect(resolveTrelloMemberId).toHaveBeenCalledWith(project);
		});

		it('is false for a human actor', async () => {
			vi.mocked(resolveTrelloMemberId).mockResolvedValue(BOARD_MEMBER_ID);
			expect(await adapter.isSelfAuthored(parse(trelloPayload()), project)).toBe(false);
		});

		it('is false (without resolving the identity) when there is no actor', async () => {
			const event = parse(trelloPayload({ idMemberCreator: undefined }));
			expect(await adapter.isSelfAuthored(event, project)).toBe(false);
			expect(resolveTrelloMemberId).not.toHaveBeenCalled();
		});

		// Fails *open*: a swallowed identity-resolution error must never drop a real
		// human card move as "ours" (ai/RULES.md §2).
		it('fails open (and logs) when identity resolution errors', async () => {
			const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
			vi.mocked(resolveTrelloMemberId).mockRejectedValue(new Error('no Trello token configured'));

			const event = parse(trelloPayload({ idMemberCreator: BOARD_MEMBER_ID }));
			expect(await adapter.isSelfAuthored(event, project)).toBe(false);
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining('Failed to resolve Trello board identity'),
				expect.objectContaining({ projectId: 'proj-trello', containerId: config.boardId }),
			);
			errorSpy.mockRestore();
		});
	});

	describe('synthesizeStateChange', () => {
		it('produces an event this adapter’s own isStatusChange accepts', () => {
			const event = adapter.synthesizeStateChange(project, CARD_ID);
			expect(event).toEqual({
				itemId: CARD_ID,
				containerId: config.boardId,
				action: 'updated',
				changedField: 'idList',
				changedFieldType: 'list',
			});
			expect(adapter.isStatusChange(event, project)).toBe(true);
		});
	});
});
