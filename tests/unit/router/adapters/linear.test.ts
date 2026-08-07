import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockLinearProjectConfig } from '../../../helpers/factories.js';

vi.mock('@/config/provider.js', () => ({
	findProjectByLinearTeam: vi.fn(),
}));
vi.mock('@/integrations/pm/linear/identity.js', () => ({
	resolveLinearActorId: vi.fn(),
}));

import { findProjectByLinearTeam } from '@/config/provider.js';
import { requireLinearConfig } from '@/integrations/pm/linear/config-schema.js';
import { resolveLinearActorId } from '@/integrations/pm/linear/identity.js';
import { logger } from '@/lib/logger.js';
import { LinearRouterAdapter } from '@/router/adapters/linear.js';

const project = createMockLinearProjectConfig({ id: 'proj-linear' });
const config = requireLinearConfig(project);

/** The Linear actor id the project's API key authenticates as. */
const BOARD_ACTOR_ID = 'b5ea5f1f-8adc-4f52-b4bd-ab4e84cf51ba';
const HUMAN_ACTOR_ID = 'aacdca22-6266-4c0a-ab3c-8fa70a26765c';
const ISSUE_ID = '539068e2-ae88-4d09-bd75-22eb4a59612f';

/**
 * A Linear data-change delivery, shaped as Linear actually sends one
 * (https://linear.app/developers/webhooks): the entity in `type`, the verb in
 * `action`, the serialized entity in `data`, the previous values of an update in
 * `updatedFrom`.
 */
function linearPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		action: 'update',
		type: 'Issue',
		actor: { id: HUMAN_ACTOR_ID, type: 'user', name: 'Ada Lovelace' },
		data: {
			id: ISSUE_ID,
			title: 'Wire triggers',
			teamId: config.teamId,
			stateId: config.statusOptions.inProgress,
		},
		updatedFrom: { updatedAt: '2026-07-02T00:00:00.000Z', stateId: config.statusOptions.todo },
		url: 'https://linear.app/acme/issue/ENG-42/wire-triggers',
		organizationId: 'dc844923-f9a4-40a3-825c-dea7747e57d6',
		webhookTimestamp: 1_676_056_940_508,
		webhookId: '000042e3-d123-4980-b49f-8e140eef9329',
		...overrides,
	};
}

/** The same delivery for a field edit that is *not* a column move. */
function priorityEditPayload() {
	return linearPayload({
		updatedFrom: { updatedAt: '2026-07-02T00:00:00.000Z', priority: 2 },
	});
}

describe('LinearRouterAdapter', () => {
	const adapter = new LinearRouterAdapter();

	/** Parse a payload the way the receiver does for a provider on its own route. */
	function parse(payload: unknown) {
		const event = adapter.parseWebhook('', payload);
		if (!event) throw new Error('expected the Linear payload to parse');
		return event;
	}

	beforeEach(() => {
		vi.mocked(findProjectByLinearTeam).mockReset();
		vi.mocked(resolveLinearActorId).mockReset();
	});

	describe('parseWebhook', () => {
		it('normalizes a workflow-state change into the provider-neutral event', () => {
			expect(adapter.parseWebhook('', linearPayload())).toEqual({
				itemId: ISSUE_ID,
				containerId: config.teamId,
				action: 'updated',
				changedField: 'stateId',
				changedFieldType: 'workflowState',
				contentType: 'Issue',
				actorHandle: HUMAN_ACTOR_ID,
			});
		});

		it.each([
			['create', 'created'],
			['update', 'updated'],
			['remove', 'deleted'],
		])("maps Linear's %s action to the neutral %s", (action, neutral) => {
			expect(parse(linearPayload({ action })).action).toBe(neutral);
		});

		it('carries an action outside the neutral vocabulary through verbatim', () => {
			expect(parse(linearPayload({ action: 'restore' })).action).toBe('restore');
		});

		// The whole point of the `updatedFrom` read: an unrelated field edit must still
		// parse (it is a real board event) but must carry no changed field, so the
		// status gate below drops it.
		it('marks no changed field for an edit that did not touch the workflow state', () => {
			const parsed = parse(priorityEditPayload());
			expect(parsed.action).toBe('updated');
			expect(parsed.changedField).toBeUndefined();
			expect(parsed.changedFieldType).toBeUndefined();
		});

		it('marks no changed field on a create (no updatedFrom block at all)', () => {
			const payload = linearPayload({ action: 'create' });
			delete payload.updatedFrom;
			expect(parse(payload).changedField).toBeUndefined();
		});

		it('falls back to the nested team object when the payload carries no scalar teamId', () => {
			const payload = linearPayload({
				data: { id: ISSUE_ID, team: { id: config.teamId, key: 'ENG' } },
			});
			expect(parse(payload).containerId).toBe(config.teamId);
		});

		it.each([
			'Comment',
			'IssueLabel',
			'Project',
		])('returns null for a %s payload (not an entity SWARM acts on)', (type) => {
			expect(adapter.parseWebhook('', linearPayload({ type }))).toBeNull();
		});

		it('returns null for a payload that is not an object at all', () => {
			expect(adapter.parseWebhook('', 'not json')).toBeNull();
			expect(adapter.parseWebhook('', null)).toBeNull();
		});

		it('returns null when the issue id is missing', () => {
			expect(
				adapter.parseWebhook('', linearPayload({ data: { teamId: config.teamId } })),
			).toBeNull();
		});

		it('returns null when the team id is missing', () => {
			expect(adapter.parseWebhook('', linearPayload({ data: { id: ISSUE_ID } }))).toBeNull();
		});
	});

	describe('resolveProject', () => {
		it('resolves the owning project by Linear team id', async () => {
			vi.mocked(findProjectByLinearTeam).mockResolvedValue(project);
			expect(await adapter.resolveProject(parse(linearPayload()))).toBe(project);
			expect(findProjectByLinearTeam).toHaveBeenCalledWith(config.teamId);
		});

		it('returns null for an untracked team', async () => {
			vi.mocked(findProjectByLinearTeam).mockResolvedValue(undefined);
			expect(await adapter.resolveProject(parse(linearPayload()))).toBeNull();
		});
	});

	describe('isStatusChange', () => {
		// Dragging a card between columns *is* a state update in Linear, carrying
		// `updatedFrom.stateId` — so unlike GitHub Projects there is no drag case to
		// special-case here.
		it('is true for a workflow-state change', () => {
			expect(adapter.isStatusChange(parse(linearPayload()), project)).toBe(true);
		});

		it('is true for an issue created on the team', () => {
			const payload = linearPayload({ action: 'create' });
			delete payload.updatedFrom;
			expect(adapter.isStatusChange(parse(payload), project)).toBe(true);
		});

		it('is false for an edit to a different field', () => {
			expect(adapter.isStatusChange(parse(priorityEditPayload()), project)).toBe(false);
		});

		it.each(['remove', 'restore'])('is false for the %s action', (action) => {
			expect(adapter.isStatusChange(parse(linearPayload({ action })), project)).toBe(false);
		});
	});

	describe('isSelfAuthored (loop prevention)', () => {
		it("is true when SWARM's own Linear credential made the change", async () => {
			vi.mocked(resolveLinearActorId).mockResolvedValue(BOARD_ACTOR_ID);
			const event = parse(linearPayload({ actor: { id: BOARD_ACTOR_ID, type: 'user' } }));
			expect(await adapter.isSelfAuthored(event, project)).toBe(true);
			expect(resolveLinearActorId).toHaveBeenCalledWith(project);
		});

		it('is false for a human actor', async () => {
			vi.mocked(resolveLinearActorId).mockResolvedValue(BOARD_ACTOR_ID);
			expect(await adapter.isSelfAuthored(parse(linearPayload()), project)).toBe(false);
		});

		it('is false (without resolving the identity) when there is no actor', async () => {
			const payload = linearPayload();
			delete payload.actor;
			expect(await adapter.isSelfAuthored(parse(payload), project)).toBe(false);
			expect(resolveLinearActorId).not.toHaveBeenCalled();
		});

		// Fails *open*: a swallowed identity-resolution error must never drop a real
		// human state change as "ours" (ai/RULES.md §2).
		it('fails open (and logs) when identity resolution errors', async () => {
			const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
			vi.mocked(resolveLinearActorId).mockRejectedValue(new Error('no API key configured'));

			const event = parse(linearPayload({ actor: { id: BOARD_ACTOR_ID, type: 'user' } }));
			expect(await adapter.isSelfAuthored(event, project)).toBe(false);
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining('Failed to resolve Linear board identity'),
				expect.objectContaining({ projectId: 'proj-linear', containerId: config.teamId }),
			);
			errorSpy.mockRestore();
		});
	});

	describe('synthesizeStateChange', () => {
		it('produces an event this adapter’s own isStatusChange accepts', () => {
			const event = adapter.synthesizeStateChange(project, ISSUE_ID);
			expect(event).toEqual({
				itemId: ISSUE_ID,
				containerId: config.teamId,
				action: 'updated',
				changedField: 'stateId',
				changedFieldType: 'workflowState',
			});
			expect(adapter.isStatusChange(event, project)).toBe(true);
		});
	});
});
