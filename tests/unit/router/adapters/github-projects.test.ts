import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	createMockProjectConfig,
	createMockProjectsV2ItemPayload,
} from '../../../helpers/factories.js';

vi.mock('@/config/provider.js', () => ({
	findProjectByBoard: vi.fn(),
}));
vi.mock('@/integrations/scm/github/personas.js', () => ({
	resolvePersonaIdentities: vi.fn(),
	isSwarmBot: vi.fn(),
}));

import { findProjectByBoard } from '@/config/provider.js';
import { requireGitHubProjectsConfig } from '@/integrations/pm/github-projects/config-schema.js';
import {
	isSwarmBot,
	type PersonaIdentities,
	resolvePersonaIdentities,
} from '@/integrations/scm/github/personas.js';
import { GitHubProjectsRouterAdapter } from '@/router/adapters/github-projects.js';

const IDENTITIES: PersonaIdentities = { implementer: 'swarm-impl', reviewer: 'swarm-rev' };
const STATUS_FIELD_ID = 'PVTSSF_lAHOAC3TF84BcNwDzhW4MKo';
const project = createMockProjectConfig({ id: 'proj-1' });
const projectPm = requireGitHubProjectsConfig(project);

describe('GitHubProjectsRouterAdapter', () => {
	const adapter = new GitHubProjectsRouterAdapter();

	function parse(payload: unknown) {
		const event = adapter.parseWebhook('projects_v2_item', payload);
		if (!event) throw new Error('expected projects_v2_item to parse');
		return event;
	}

	beforeEach(() => {
		vi.mocked(findProjectByBoard).mockReset();
		vi.mocked(resolvePersonaIdentities).mockReset();
		vi.mocked(isSwarmBot).mockReset();
	});

	describe('parseWebhook', () => {
		it('returns null for a non-projects event type', () => {
			expect(adapter.parseWebhook('pull_request', createMockProjectsV2ItemPayload())).toBeNull();
		});

		it('normalizes a Status-field edit into the provider-neutral event', () => {
			const parsed = adapter.parseWebhook('projects_v2_item', createMockProjectsV2ItemPayload());
			expect(parsed).toEqual({
				action: 'updated',
				itemId: 'PVTI_lAHOAC3TF84BcNwDzgxczms',
				containerId: 'PVT_kwHOAC3TF84BcNwD',
				contentId: 'I_kwDONODE',
				contentType: 'Issue',
				changedField: STATUS_FIELD_ID,
				changedFieldType: 'single_select',
				actorHandle: 'human-dev',
			});
		});

		it.each([
			['edited', 'updated'],
			['reordered', 'moved'],
			['created', 'created'],
			['deleted', 'deleted'],
		])("maps GitHub's %s action to the neutral %s", (action, neutral) => {
			expect(parse(createMockProjectsV2ItemPayload({ action })).action).toBe(neutral);
		});

		it('carries an action outside the neutral vocabulary through verbatim', () => {
			expect(parse(createMockProjectsV2ItemPayload({ action: 'archived' })).action).toBe(
				'archived',
			);
		});

		it('parses a created event (no changes block)', () => {
			const parsed = parse(createMockProjectsV2ItemPayload({ action: 'created', changes: null }));
			expect(parsed.action).toBe('created');
			expect(parsed.changedField).toBeUndefined();
		});

		it('returns null when the item node ID is missing', () => {
			const payload = createMockProjectsV2ItemPayload({
				projectsV2Item: { node_id: undefined, project_node_id: 'PVT_kwHOAC3TF84BcNwD' },
			});
			expect(adapter.parseWebhook('projects_v2_item', payload)).toBeNull();
		});

		it('returns null when the board node ID is missing', () => {
			const payload = createMockProjectsV2ItemPayload({
				projectsV2Item: { node_id: 'PVTI_x', project_node_id: undefined },
			});
			expect(adapter.parseWebhook('projects_v2_item', payload)).toBeNull();
		});
	});

	describe('resolveProject', () => {
		it('resolves the owning project by board node ID', async () => {
			vi.mocked(findProjectByBoard).mockResolvedValue(project);
			const event = parse(createMockProjectsV2ItemPayload());
			expect(await adapter.resolveProject(event)).toBe(project);
			expect(findProjectByBoard).toHaveBeenCalledWith('PVT_kwHOAC3TF84BcNwD');
		});

		it('returns null for an untracked board', async () => {
			vi.mocked(findProjectByBoard).mockResolvedValue(undefined);
			const event = parse(createMockProjectsV2ItemPayload());
			expect(await adapter.resolveProject(event)).toBeNull();
		});
	});

	describe('isStatusChange', () => {
		it('is true for an edit to the Status field', () => {
			const event = parse(createMockProjectsV2ItemPayload());
			expect(adapter.isStatusChange(event, project)).toBe(true);
		});

		it('is true for a created event regardless of the changes block', () => {
			const event = parse(createMockProjectsV2ItemPayload({ action: 'created', changes: null }));
			expect(adapter.isStatusChange(event, project)).toBe(true);
		});

		it('is true for a reordered/moved event (Board-view drag between columns), even though its changes block carries no field_value', () => {
			const event = parse(
				createMockProjectsV2ItemPayload({
					action: 'reordered',
					changes: { previous_projects_v2_item_node_id: { from: null, to: null } },
				}),
			);
			expect(adapter.isStatusChange(event, project)).toBe(true);
		});

		it('is false for an edit to a different field', () => {
			const event = parse(
				createMockProjectsV2ItemPayload({
					changes: { field_value: { field_node_id: 'PVTSSF_other', field_type: 'single_select' } },
				}),
			);
			expect(adapter.isStatusChange(event, project)).toBe(false);
		});

		it.each([
			'deleted',
			'archived',
			'restored',
			'converted',
		])('is false for the %s action', (action) => {
			const event = parse(createMockProjectsV2ItemPayload({ action }));
			expect(adapter.isStatusChange(event, project)).toBe(false);
		});
	});

	describe('isSelfAuthored (loop prevention)', () => {
		it('is true when a SWARM persona moved the card', async () => {
			vi.mocked(resolvePersonaIdentities).mockResolvedValue(IDENTITIES);
			vi.mocked(isSwarmBot).mockReturnValue(true);
			const event = parse(createMockProjectsV2ItemPayload({ sender: { login: 'swarm-impl' } }));
			expect(await adapter.isSelfAuthored(event, project)).toBe(true);
			expect(isSwarmBot).toHaveBeenCalledWith('swarm-impl', IDENTITIES);
		});

		it('is false for a human actor', async () => {
			vi.mocked(resolvePersonaIdentities).mockResolvedValue(IDENTITIES);
			vi.mocked(isSwarmBot).mockReturnValue(false);
			const event = parse(createMockProjectsV2ItemPayload({ sender: { login: 'human-dev' } }));
			expect(await adapter.isSelfAuthored(event, project)).toBe(false);
		});

		it('is false (without resolving identities) when there is no actor', async () => {
			const payload = createMockProjectsV2ItemPayload();
			delete (payload as { sender?: unknown }).sender;
			const event = parse(payload);
			expect(await adapter.isSelfAuthored(event, project)).toBe(false);
			expect(resolvePersonaIdentities).not.toHaveBeenCalled();
		});

		it('fails safe to false (and does not throw) when identity resolution errors', async () => {
			vi.mocked(resolvePersonaIdentities).mockRejectedValue(new Error('no token'));
			const event = parse(createMockProjectsV2ItemPayload({ sender: { login: 'swarm-impl' } }));
			expect(await adapter.isSelfAuthored(event, project)).toBe(false);
		});
	});

	describe('synthesizeStateChange', () => {
		it('produces an event this adapter’s own isStatusChange accepts', () => {
			const event = adapter.synthesizeStateChange(project, 'PVTI_next');
			expect(event).toEqual({
				itemId: 'PVTI_next',
				containerId: projectPm.projectId,
				action: 'updated',
				changedField: STATUS_FIELD_ID,
				changedFieldType: 'single_select',
			});
			expect(adapter.isStatusChange(event, project)).toBe(true);
		});
	});
});
