import { describe, expect, it } from 'vitest';
import { PmEventSchema, PmProviderIdSchema, upgradeLegacyProjectsEvent } from '@/pm/events.js';
import { createMockPmEvent } from '../../helpers/factories.js';

/** The pre-#297 wire encoding: GitHub's own board vocabulary, verbatim. */
const LEGACY_EVENT = {
	eventType: 'projects_v2_item',
	action: 'edited',
	itemNodeId: 'PVTI_item',
	projectNodeId: 'PVT_board',
	contentNodeId: 'I_content',
	contentType: 'Issue',
	changedFieldNodeId: 'PVTSSF_status',
	changedFieldType: 'single_select',
	actorLogin: 'human-dev',
};

describe('PmProviderIdSchema', () => {
	it('accepts every planned provider id', () => {
		for (const id of ['github-projects', 'jira', 'linear', 'trello']) {
			expect(PmProviderIdSchema.parse(id)).toBe(id);
		}
	});

	it('rejects an id outside the vocabulary', () => {
		expect(() => PmProviderIdSchema.parse('asana')).toThrow();
	});
});

describe('PmEventSchema', () => {
	it('parses the neutral encoding', () => {
		const event = createMockPmEvent();
		expect(PmEventSchema.parse(event)).toEqual(event);
	});

	it('requires the item and container ids — nothing is actionable without both', () => {
		expect(() => PmEventSchema.parse({ containerId: 'PVT_board' })).toThrow();
		expect(() => PmEventSchema.parse({ itemId: 'PVTI_item' })).toThrow();
	});

	it('accepts an action outside the neutral vocabulary verbatim', () => {
		// A provider emits board actions SWARM doesn't act on; they must still
		// normalize and enqueue rather than fail the durable envelope's validation.
		expect(PmEventSchema.parse(createMockPmEvent({ action: 'archived' }))).toMatchObject({
			action: 'archived',
		});
	});

	it('accepts a field-less event (a card added to the board)', () => {
		const parsed = PmEventSchema.parse({
			itemId: 'PVTI_item',
			containerId: 'PVT_board',
			action: 'created',
		});
		expect(parsed).toEqual({ itemId: 'PVTI_item', containerId: 'PVT_board', action: 'created' });
	});
});

describe('upgradeLegacyProjectsEvent (pre-#297 durable rows)', () => {
	it('remaps every legacy field name to its neutral counterpart', () => {
		expect(PmEventSchema.parse(LEGACY_EVENT)).toEqual({
			action: 'updated',
			itemId: 'PVTI_item',
			containerId: 'PVT_board',
			contentId: 'I_content',
			contentType: 'Issue',
			changedField: 'PVTSSF_status',
			changedFieldType: 'single_select',
			actorHandle: 'human-dev',
		});
	});

	it.each([
		['edited', 'updated'],
		['reordered', 'moved'],
		['created', 'created'],
		['deleted', 'deleted'],
		['archived', 'archived'],
	])('translates the legacy %s action to %s', (legacy, neutral) => {
		expect(PmEventSchema.parse({ ...LEGACY_EVENT, action: legacy })).toMatchObject({
			action: neutral,
		});
	});

	it('drops the legacy eventType discriminator', () => {
		expect(PmEventSchema.parse(LEGACY_EVENT)).not.toHaveProperty('eventType');
	});

	it('omits absent optional fields rather than materializing them as undefined', () => {
		const parsed = PmEventSchema.parse({
			eventType: 'projects_v2_item',
			action: 'created',
			itemNodeId: 'PVTI_item',
			projectNodeId: 'PVT_board',
		});
		expect(parsed).toEqual({ itemId: 'PVTI_item', containerId: 'PVT_board', action: 'created' });
	});

	it('passes an already-neutral event through untouched', () => {
		const event = createMockPmEvent();
		expect(upgradeLegacyProjectsEvent(event)).toBe(event);
	});

	it('passes a non-object through untouched', () => {
		expect(upgradeLegacyProjectsEvent(null)).toBeNull();
		expect(upgradeLegacyProjectsEvent('nope')).toBe('nope');
	});

	it('leaves an unrecognized legacy event type alone so the schema rejects it loudly', () => {
		// Not a board event at all — it must fail validation rather than be coerced
		// into one with missing ids.
		expect(() => PmEventSchema.parse({ eventType: 'pull_request', itemNodeId: 'x' })).toThrow();
	});
});
