import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	createMockProjectConfig,
	createMockProjectsV2ItemPayload,
} from '../../../helpers/factories.js';

vi.mock('@/config/provider.js', () => ({
	findProjectByBoard: vi.fn(),
}));
// Only the credential-resolving half is stubbed; the login comparison itself is pure,
// so the real one runs (`[bot]` suffix handling included).
vi.mock('@/integrations/pm/github-projects/credentials.js', async (importOriginal) => ({
	...(await importOriginal<object>()),
	resolveGitHubProjectsIdentity: vi.fn(),
}));

import { findProjectByBoard } from '@/config/provider.js';
import { requireGitHubProjectsConfig } from '@/integrations/pm/github-projects/config-schema.js';
import { resolveGitHubProjectsIdentity } from '@/integrations/pm/github-projects/credentials.js';
import { GitHubProjectsRouterAdapter } from '@/router/adapters/github-projects.js';

/** The login the project's board credential authenticates as (issue #537). */
const BOARD_IDENTITY = 'swarm-board';
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
		vi.mocked(resolveGitHubProjectsIdentity).mockReset();
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

	// Since issue #537 this gate keys on the *board credential's* identity — the
	// account every SWARM board write is now made by — instead of the SCM personas the
	// provider used to borrow.
	describe('isSelfAuthored (loop prevention)', () => {
		it('is true when the board credential itself moved the card', async () => {
			vi.mocked(resolveGitHubProjectsIdentity).mockResolvedValue(BOARD_IDENTITY);
			const event = parse(createMockProjectsV2ItemPayload({ sender: { login: BOARD_IDENTITY } }));
			expect(await adapter.isSelfAuthored(event, project)).toBe(true);
			expect(resolveGitHubProjectsIdentity).toHaveBeenCalledWith(project);
		});

		it('is true for the GitHub App form of that identity', async () => {
			vi.mocked(resolveGitHubProjectsIdentity).mockResolvedValue(BOARD_IDENTITY);
			const event = parse(
				createMockProjectsV2ItemPayload({ sender: { login: `${BOARD_IDENTITY}[bot]` } }),
			);
			expect(await adapter.isSelfAuthored(event, project)).toBe(true);
		});

		it('is false for a human actor', async () => {
			vi.mocked(resolveGitHubProjectsIdentity).mockResolvedValue(BOARD_IDENTITY);
			const event = parse(createMockProjectsV2ItemPayload({ sender: { login: 'human-dev' } }));
			expect(await adapter.isSelfAuthored(event, project)).toBe(false);
		});

		it('is false (without resolving the identity) when there is no actor', async () => {
			const payload = createMockProjectsV2ItemPayload();
			delete (payload as { sender?: unknown }).sender;
			const event = parse(payload);
			expect(await adapter.isSelfAuthored(event, project)).toBe(false);
			expect(resolveGitHubProjectsIdentity).not.toHaveBeenCalled();
		});

		it('fails safe to false (and does not throw) when identity resolution errors', async () => {
			vi.mocked(resolveGitHubProjectsIdentity).mockRejectedValue(
				new Error('no PM credential configured'),
			);
			const event = parse(createMockProjectsV2ItemPayload({ sender: { login: BOARD_IDENTITY } }));
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
