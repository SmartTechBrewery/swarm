import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockJiraProjectConfig } from '../../../helpers/factories.js';

vi.mock('@/config/provider.js', () => ({
	findProjectByJiraProject: vi.fn(),
}));
vi.mock('@/integrations/pm/jira/identity.js', () => ({
	resolveJiraAccountId: vi.fn(),
}));

import { findProjectByJiraProject } from '@/config/provider.js';
import { requireJiraConfig } from '@/integrations/pm/jira/config-schema.js';
import { resolveJiraAccountId } from '@/integrations/pm/jira/identity.js';
import { logger } from '@/lib/logger.js';
import { JiraRouterAdapter } from '@/router/adapters/jira.js';

const project = createMockJiraProjectConfig({ id: 'proj-jira' });
const config = requireJiraConfig(project);

/** The Atlassian account id the project's API token authenticates as. */
const BOARD_ACCOUNT_ID = '5b10ac8d82e05b22cc7d4ef5';
const HUMAN_ACCOUNT_ID = '712020:9c6f7d1e-3b2a-4d5e-8f01-2a3b4c5d6e7f';
const ISSUE_KEY = 'SWARM-42';

/**
 * A Jira Cloud issue delivery, shaped as Jira actually sends one
 * (developer.atlassian.com/cloud/jira/platform/webhooks): the event name in the
 * body's `webhookEvent`, the actor in `user`, and *what* changed in
 * `changelog.items[]`.
 */
function jiraPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		timestamp: 1_775_000_000_000,
		webhookEvent: 'jira:issue_updated',
		issue_event_type_name: 'issue_generic',
		user: { accountId: HUMAN_ACCOUNT_ID, displayName: 'Ada Lovelace', accountType: 'atlassian' },
		issue: {
			id: '10042',
			key: ISSUE_KEY,
			fields: {
				summary: 'Wire triggers',
				project: { id: '10000', key: config.projectKey, name: 'SWARM' },
				issuetype: { id: '10001', name: 'Task' },
				status: { id: config.statusOptions.inProgress, name: 'In Progress' },
			},
		},
		changelog: {
			id: '10124',
			items: [
				{
					field: 'status',
					fieldtype: 'jira',
					fieldId: 'status',
					from: config.statusOptions.todo,
					fromString: 'To Do',
					to: config.statusOptions.inProgress,
					toString: 'In Progress',
				},
			],
		},
		...overrides,
	};
}

/** The same delivery for a field edit that is *not* a workflow transition. */
function priorityEditPayload() {
	return jiraPayload({
		changelog: {
			id: '10125',
			items: [
				{
					field: 'priority',
					fieldtype: 'jira',
					fieldId: 'priority',
					fromString: 'Medium',
					toString: 'High',
				},
			],
		},
	});
}

describe('JiraRouterAdapter', () => {
	const adapter = new JiraRouterAdapter();

	/** Parse a payload the way the receiver does for a provider on its own route. */
	function parse(payload: unknown) {
		const event = adapter.parseWebhook('', payload);
		if (!event) throw new Error('expected the Jira payload to parse');
		return event;
	}

	beforeEach(() => {
		vi.mocked(findProjectByJiraProject).mockReset();
		vi.mocked(resolveJiraAccountId).mockReset();
	});

	describe('parseWebhook', () => {
		it('normalizes a workflow transition into the provider-neutral event', () => {
			expect(adapter.parseWebhook('', jiraPayload())).toEqual({
				itemId: ISSUE_KEY,
				containerId: config.projectKey,
				action: 'updated',
				changedField: 'status',
				changedFieldType: 'status',
				contentType: 'Task',
				actorHandle: HUMAN_ACCOUNT_ID,
			});
		});

		it.each([
			['jira:issue_created', 'created'],
			['jira:issue_updated', 'updated'],
			['jira:issue_deleted', 'deleted'],
		])("maps Jira's %s event to the neutral %s action", (webhookEvent, neutral) => {
			expect(parse(jiraPayload({ webhookEvent })).action).toBe(neutral);
		});

		it('carries an issue event outside the neutral vocabulary through verbatim', () => {
			expect(parse(jiraPayload({ webhookEvent: 'jira:issue_property_set' })).action).toBe(
				'jira:issue_property_set',
			);
		});

		// The whole point of the changelog scan: an unrelated field edit ships a
		// changelog too, so it must still parse (it is a real board event) but must
		// carry no changed field, so the status gate below drops it.
		it('marks no changed field for an edit that did not touch the status', () => {
			const parsed = parse(priorityEditPayload());
			expect(parsed.action).toBe('updated');
			expect(parsed.changedField).toBeUndefined();
			expect(parsed.changedFieldType).toBeUndefined();
		});

		it('marks no changed field on a create (no changelog block at all)', () => {
			const payload = jiraPayload({ webhookEvent: 'jira:issue_created' });
			delete payload.changelog;
			expect(parse(payload).changedField).toBeUndefined();
		});

		it('detects the status entry among several changed fields', () => {
			const payload = jiraPayload({
				changelog: {
					items: [
						{ field: 'assignee', fieldId: 'assignee' },
						{ field: 'status', fieldId: 'status', to: config.statusOptions.done },
					],
				},
			});
			expect(parse(payload).changedField).toBe('status');
		});

		// Jira names the changed field twice per entry; older/renderer-specific
		// entries carry only the display name.
		it('detects a status entry that carries only the display field name', () => {
			const payload = jiraPayload({
				changelog: { items: [{ field: 'status', fieldtype: 'jira' }] },
			});
			expect(parse(payload).changedField).toBe('status');
		});

		it.each([
			['comment_created', { comment: { id: '10000', body: 'hi' } }],
			['jira:worklog_updated', {}],
			['project_updated', {}],
		])('returns null for a %s delivery (not an issue event)', (webhookEvent, extra) => {
			expect(adapter.parseWebhook('', jiraPayload({ webhookEvent, ...extra }))).toBeNull();
		});

		it('returns null for a payload that is not an object at all', () => {
			expect(adapter.parseWebhook('', 'not json')).toBeNull();
			expect(adapter.parseWebhook('', null)).toBeNull();
		});

		it('returns null when the issue key is missing', () => {
			const payload = jiraPayload();
			payload.issue = { id: '10042', fields: { project: { key: config.projectKey } } };
			expect(adapter.parseWebhook('', payload)).toBeNull();
		});

		it('returns null when the project key is missing', () => {
			const payload = jiraPayload();
			payload.issue = { id: '10042', key: ISSUE_KEY, fields: { summary: 'Wire triggers' } };
			expect(adapter.parseWebhook('', payload)).toBeNull();
		});

		it('parses a delivery that carries no actor at all', () => {
			const payload = jiraPayload();
			delete payload.user;
			expect(parse(payload).actorHandle).toBeUndefined();
		});
	});

	describe('resolveProject', () => {
		it('resolves the owning project by Jira project key', async () => {
			vi.mocked(findProjectByJiraProject).mockResolvedValue(project);
			expect(await adapter.resolveProject(parse(jiraPayload()))).toBe(project);
			expect(findProjectByJiraProject).toHaveBeenCalledWith(config.projectKey);
		});

		it('returns null for an untracked Jira project', async () => {
			vi.mocked(findProjectByJiraProject).mockResolvedValue(undefined);
			expect(await adapter.resolveProject(parse(jiraPayload()))).toBeNull();
		});
	});

	describe('isStatusChange', () => {
		// Dragging a card between Jira board columns executes a workflow transition,
		// which is a `status` changelog entry — so unlike GitHub Projects there is no
		// drag case to special-case here.
		it('is true for a workflow transition', () => {
			expect(adapter.isStatusChange(parse(jiraPayload()), project)).toBe(true);
		});

		it('is true for an issue created in the project', () => {
			const payload = jiraPayload({ webhookEvent: 'jira:issue_created' });
			delete payload.changelog;
			expect(adapter.isStatusChange(parse(payload), project)).toBe(true);
		});

		it('is false for an edit to a different field', () => {
			expect(adapter.isStatusChange(parse(priorityEditPayload()), project)).toBe(false);
		});

		it.each([
			'jira:issue_deleted',
			'jira:issue_property_set',
		])('is false for a %s delivery', (webhookEvent) => {
			expect(adapter.isStatusChange(parse(jiraPayload({ webhookEvent })), project)).toBe(false);
		});
	});

	describe('isSelfAuthored (loop prevention)', () => {
		it("is true when SWARM's own Jira credential made the change", async () => {
			vi.mocked(resolveJiraAccountId).mockResolvedValue(BOARD_ACCOUNT_ID);
			const event = parse(jiraPayload({ user: { accountId: BOARD_ACCOUNT_ID } }));
			expect(await adapter.isSelfAuthored(event, project)).toBe(true);
			expect(resolveJiraAccountId).toHaveBeenCalledWith(project);
		});

		it('is false for a human actor', async () => {
			vi.mocked(resolveJiraAccountId).mockResolvedValue(BOARD_ACCOUNT_ID);
			expect(await adapter.isSelfAuthored(parse(jiraPayload()), project)).toBe(false);
		});

		it('is false (without resolving the identity) when there is no actor', async () => {
			const payload = jiraPayload();
			delete payload.user;
			expect(await adapter.isSelfAuthored(parse(payload), project)).toBe(false);
			expect(resolveJiraAccountId).not.toHaveBeenCalled();
		});

		// Fails *open*: a swallowed identity-resolution error must never drop a real
		// human status change as "ours" (ai/RULES.md §2).
		it('fails open (and logs) when identity resolution errors', async () => {
			const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
			vi.mocked(resolveJiraAccountId).mockRejectedValue(new Error('no API token configured'));

			const event = parse(jiraPayload({ user: { accountId: BOARD_ACCOUNT_ID } }));
			expect(await adapter.isSelfAuthored(event, project)).toBe(false);
			expect(errorSpy).toHaveBeenCalledWith(
				expect.stringContaining('Failed to resolve Jira board identity'),
				expect.objectContaining({ projectId: 'proj-jira', containerId: config.projectKey }),
			);
			errorSpy.mockRestore();
		});
	});

	describe('synthesizeStateChange', () => {
		it('produces an event this adapter’s own isStatusChange accepts', () => {
			const event = adapter.synthesizeStateChange(project, ISSUE_KEY);
			expect(event).toEqual({
				itemId: ISSUE_KEY,
				containerId: config.projectKey,
				action: 'updated',
				changedField: 'status',
				changedFieldType: 'status',
			});
			expect(adapter.isStatusChange(event, project)).toBe(true);
		});
	});
});
