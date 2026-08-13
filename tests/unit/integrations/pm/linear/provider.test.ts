import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted because both factories below use these eagerly — the client factory
// spreads the real module and overrides one export, so the mock has to exist
// before the hoisted `import`s run.
const { linearGraphQL, requirePmCredential } = vi.hoisted(() => ({
	linearGraphQL: vi.fn(),
	requirePmCredential: vi.fn(),
}));

// Only the transport is replaced: `withLinearApiKey`/`getScopedApiKey` and
// `collectLinearConnection` stay real, so credential scoping and pagination are
// genuinely exercised rather than stubbed out.
vi.mock('@/integrations/pm/linear/client.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('@/integrations/pm/linear/client.js')>()),
	linearGraphQL,
}));

// A PM credential role resolves against the *registered* manifest, and Linear
// registers none until its final phase (ai/RULES.md §2), so the seam is mocked.
vi.mock('@/config/provider.js', () => ({ requirePmCredential }));

import { getScopedApiKey } from '@/integrations/pm/linear/client.js';
import { requireLinearConfig } from '@/integrations/pm/linear/config-schema.js';
import { LINEAR_API_KEY_ROLE } from '@/integrations/pm/linear/credentials.js';
import { createLinearProvider, LinearPMProvider } from '@/integrations/pm/linear/provider.js';
import { createMockLinearProjectConfig } from '../../../../helpers/factories.js';

const PROJECT = createMockLinearProjectConfig();
const CONFIG = requireLinearConfig(PROJECT);
const API_KEY = 'lin_api_test_key';

const ISSUE_NODE = {
	id: '0d5c3e5e-2d8e-4a3f-9f9a-0f5b1c0f0e21',
	title: 'Wire triggers',
	description: 'Do the thing.',
	url: 'https://linear.app/acme/issue/ENG-42/wire-triggers',
	createdAt: '2026-07-01T00:00:00.000Z',
	updatedAt: '2026-07-02T00:00:00.000Z',
	team: { id: CONFIG.teamId },
	state: { id: CONFIG.statusOptions.inProgress, name: 'In Progress' },
	attachments: { nodes: [] },
	labels: { nodes: [{ id: 'label-swarm', name: 'swarm', color: '#4cb782' }] },
	assignee: { id: 'user-1', name: 'Ada Lovelace', displayName: 'ada' },
};

const TEAM_FILTER = { team: { id: { eq: CONFIG.teamId } } };

function issuesPage(nodes: unknown[], endCursor: string | null = null) {
	return { issues: { nodes, pageInfo: { hasNextPage: Boolean(endCursor), endCursor } } };
}

/** The operation name of a GraphQL document, which is how the router below keys them. */
function operationName(query: string): string {
	return /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? '';
}

/**
 * Route the mocked transport by operation name. The write methods each issue two
 * or three different documents, so ordered `mockResolvedValueOnce` chains would
 * encode call order rather than behaviour — and an operation a test didn't
 * declare fails loudly instead of silently reusing another one's payload.
 */
type Responder =
	| Record<string, unknown>
	| ((variables: Record<string, unknown>) => Record<string, unknown>);
function mockGraphQL(handlers: Record<string, Responder>): void {
	linearGraphQL.mockImplementation(async (query: string, variables: Record<string, unknown>) => {
		const name = operationName(query);
		if (!(name in handlers)) {
			throw new Error(`Unexpected Linear operation '${name}'`);
		}
		const handler = handlers[name];
		return typeof handler === 'function' ? handler(variables) : handler;
	});
}

/** Every `(document, variables)` pair the provider issued, in order. */
function graphQLCalls(): Array<[string, Record<string, unknown>]> {
	return linearGraphQL.mock.calls as Array<[string, Record<string, unknown>]>;
}

/** The variables every call to one operation sent — where a direction or id mix-up shows up. */
function variablesSentTo(name: string): unknown[] {
	return graphQLCalls()
		.filter(([query]) => operationName(query) === name)
		.map(([, variables]) => variables);
}

/** The document one operation was issued with, for asserting on the selection itself. */
function documentSentTo(name: string): string {
	return graphQLCalls().find(([query]) => operationName(query) === name)?.[0] ?? '';
}

function commentsPage(nodes: unknown[], endCursor: string | null = null) {
	return {
		issue: { comments: { nodes, pageInfo: { hasNextPage: Boolean(endCursor), endCursor } } },
	};
}

function relationsPage(nodes: unknown[], endCursor: string | null = null) {
	return {
		issue: {
			inverseRelations: { nodes, pageInfo: { hasNextPage: Boolean(endCursor), endCursor } },
		},
	};
}

/** The mirror of {@link relationsPage}: the relations this issue is the *source* of. */
function dependentRelationsPage(nodes: unknown[], endCursor: string | null = null) {
	return {
		issue: { relations: { nodes, pageInfo: { hasNextPage: Boolean(endCursor), endCursor } } },
	};
}

function labelsPage(nodes: unknown[], endCursor: string | null = null) {
	return { issueLabels: { nodes, pageInfo: { hasNextPage: Boolean(endCursor), endCursor } } };
}

/** A blocking-issue fixture in the shape `BLOCKER_ISSUE_FIELDS` selects. */
function blockerIssue(number: number, stateType = 'started') {
	return {
		id: `issue-${number}`,
		identifier: `ENG-${number}`,
		number,
		title: `Prerequisite ${number}`,
		url: `https://linear.app/acme/issue/ENG-${number}/prerequisite-${number}`,
		state: { type: stateType },
	};
}

describe('LinearPMProvider', () => {
	const provider = new LinearPMProvider(PROJECT);

	beforeEach(() => {
		linearGraphQL.mockReset();
		requirePmCredential.mockReset();
		requirePmCredential.mockResolvedValue(API_KEY);
	});

	it('declares its provider id and both capability flags', () => {
		expect(provider.type).toBe('linear');
		expect(provider.supportsAssignees).toBe(true);
		expect(provider.supportsDependencies).toBe(true);
		expect(createLinearProvider(PROJECT).type).toBe('linear');
	});

	it('resolves the declared API-key role and scopes it around the request', async () => {
		let observedKey: string | undefined;
		linearGraphQL.mockImplementation(async () => {
			observedKey = getScopedApiKey();
			return { issue: ISSUE_NODE };
		});

		await provider.getWorkItem(ISSUE_NODE.id);

		expect(requirePmCredential).toHaveBeenCalledWith(PROJECT, LINEAR_API_KEY_ROLE);
		expect(observedKey).toBe(API_KEY);
	});

	describe('getWorkItem', () => {
		it('leaves taskRef unset when a Linear issue has no linked SCM artifact', async () => {
			linearGraphQL.mockResolvedValue({ issue: ISSUE_NODE });

			await expect(provider.getWorkItem(ISSUE_NODE.id)).resolves.toEqual({
				id: ISSUE_NODE.id,
				title: 'Wire triggers',
				description: 'Do the thing.',
				url: ISSUE_NODE.url,
				taskRef: undefined,
				status: 'In Progress',
				statusId: CONFIG.statusOptions.inProgress,
				statusKey: 'inProgress',
				labels: [{ id: 'label-swarm', name: 'swarm', color: '#4cb782' }],
				// Linear's `displayName` is the handle and `name` the full name — the
				// opposite of GitHub's `login`/`name` pairing.
				assignees: [{ handle: 'ada', displayName: 'Ada Lovelace', providerId: 'user-1' }],
				createdAt: ISSUE_NODE.createdAt,
				updatedAt: ISSUE_NODE.updatedAt,
			});
			expect(linearGraphQL).toHaveBeenCalledWith(expect.stringContaining('issue(id: $id)'), {
				id: ISSUE_NODE.id,
			});
			expect(linearGraphQL).toHaveBeenCalledWith(
				expect.stringContaining('labels(first: 100)'),
				expect.anything(),
			);
			expect(linearGraphQL.mock.calls[0]?.[0]).not.toContain('identifier');
		});

		it('takes taskRef only from a GitHub issue attachment in this project repository', async () => {
			linearGraphQL.mockResolvedValue({
				issue: {
					...ISSUE_NODE,
					attachments: {
						nodes: [
							{ url: 'https://github.com/another/repo/issues/9' },
							{ url: 'https://github.com/SmartTechBrewery/swarm/issues/19/comments' },
						],
					},
				},
			});

			await expect(provider.getWorkItem(ISSUE_NODE.id)).resolves.toMatchObject({ taskRef: '19' });
		});

		it.each([
			[
				'https://github.com/SmartTechBrewery/swarm/pull/205',
				'https://github.com/SmartTechBrewery/swarm/issues/100',
			],
			[
				'https://github.com/SmartTechBrewery/swarm/issues/100',
				'https://github.com/SmartTechBrewery/swarm/pull/205',
			],
		])('uses the issue attachment as taskRef regardless of attachment order', async (...urls) => {
			linearGraphQL.mockResolvedValue({
				issue: {
					...ISSUE_NODE,
					attachments: { nodes: urls.map((url) => ({ url })) },
				},
			});

			await expect(provider.getWorkItem(ISSUE_NODE.id)).resolves.toMatchObject({ taskRef: '100' });
		});

		it('does not use a pull-request attachment as a taskRef fallback', async () => {
			linearGraphQL.mockResolvedValue({
				issue: {
					...ISSUE_NODE,
					attachments: {
						nodes: [{ url: 'https://github.com/SmartTechBrewery/swarm/pull/205' }],
					},
				},
			});

			await expect(provider.getWorkItem(ISSUE_NODE.id)).resolves.toMatchObject({
				taskRef: undefined,
			});
		});

		it('leaves statusKey unset for an unmapped state and assignees empty when nobody is assigned', async () => {
			linearGraphQL.mockResolvedValue({
				issue: {
					...ISSUE_NODE,
					description: null,
					state: { id: 'ffffffff-0000-0000-0000-000000000000', name: 'Triage' },
					assignee: null,
				},
			});

			const item = await provider.getWorkItem(ISSUE_NODE.id);

			expect(item.status).toBe('Triage');
			expect(item.statusId).toBe('ffffffff-0000-0000-0000-000000000000');
			expect(item.statusKey).toBeUndefined();
			expect(item.assignees).toEqual([]);
			expect(item.description).toBe('');
		});

		it('throws when the id does not resolve', async () => {
			linearGraphQL.mockResolvedValue({ issue: null });

			await expect(provider.getWorkItem('missing-id')).rejects.toThrow(
				"Linear issue 'missing-id' did not resolve",
			);
		});
	});

	// Issue #686 phase 1: Linear's routing axis is labels — the `teamId` is already
	// the board container, so a label is what is left to claim a card.
	describe('resolveItemRepository', () => {
		const CANDIDATES = [
			{ repo: 'acme/default', routingToken: 'label-default' },
			{ repo: 'acme/second', routingToken: 'label-second' },
		];

		/** The issue-labels read answering with the given label ids. */
		function mockLabels(...ids: string[]): void {
			mockGraphQL({
				IssueLabels: { issue: { labels: { nodes: ids.map((id) => ({ id, name: 'whatever' })) } } },
			});
		}

		it('routes a card to the non-default repository whose label it carries', async () => {
			mockLabels('label-second');

			await expect(provider.resolveItemRepository(ISSUE_NODE.id, CANDIDATES)).resolves.toEqual({
				status: 'routed',
				repo: 'acme/second',
			});
		});

		it('reports a card with no labels as unrouted', async () => {
			mockGraphQL({ IssueLabels: { issue: { labels: { nodes: [] } } } });

			await expect(provider.resolveItemRepository(ISSUE_NODE.id, CANDIDATES)).resolves.toEqual({
				status: 'unrouted',
			});
		});

		it('reports a card claimed by two repositories as ambiguous rather than picking one', async () => {
			mockLabels('label-second', 'label-default');

			await expect(provider.resolveItemRepository(ISSUE_NODE.id, CANDIDATES)).resolves.toEqual({
				status: 'ambiguous',
				repos: ['acme/default', 'acme/second'],
			});
		});

		// The token is a label *id*, so it can never be confused with the automation
		// opt-in gate, which matches labels by name.
		it('matches the label id, never its name', async () => {
			mockGraphQL({
				IssueLabels: { issue: { labels: { nodes: [{ id: 'label-xyz', name: 'label-second' }] } } },
			});

			await expect(provider.resolveItemRepository(ISSUE_NODE.id, CANDIDATES)).resolves.toEqual({
				status: 'unrouted',
			});
		});

		it("reuses addLabel's own issue-labels read rather than adding a query", async () => {
			mockLabels('label-second');

			await provider.resolveItemRepository(ISSUE_NODE.id, CANDIDATES);

			expect(variablesSentTo('IssueLabels')).toEqual([{ id: ISSUE_NODE.id }]);
			expect(graphQLCalls()).toHaveLength(1);
		});
	});

	describe('listWorkItems', () => {
		it("filters id-less nodes and concatenates every page from the project's team", async () => {
			linearGraphQL
				.mockResolvedValueOnce(
					issuesPage([null, { ...ISSUE_NODE, id: undefined }, ISSUE_NODE], 'cursor-1'),
				)
				.mockResolvedValueOnce(issuesPage([{ ...ISSUE_NODE, id: 'issue-2' }]));

			const items = await provider.listWorkItems();

			expect(items.map((item) => item.id)).toEqual([ISSUE_NODE.id, 'issue-2']);
			expect(linearGraphQL).toHaveBeenNthCalledWith(1, expect.stringContaining('issues(filter:'), {
				filter: TEAM_FILTER,
				cursor: undefined,
			});
			expect(linearGraphQL).toHaveBeenNthCalledWith(2, expect.stringContaining('issues(filter:'), {
				filter: TEAM_FILTER,
				cursor: 'cursor-1',
			});
		});

		it('adds the mapped workflow-state filter for a canonical status', async () => {
			linearGraphQL.mockResolvedValue(issuesPage([]));

			await provider.listWorkItems({ status: 'todo' });

			expect(linearGraphQL).toHaveBeenCalledWith(expect.stringContaining('issues(filter:'), {
				filter: { ...TEAM_FILTER, state: { id: { eq: CONFIG.statusOptions.todo } } },
				cursor: undefined,
			});
		});

		it('refuses an unmapped status instead of silently listing the whole board', async () => {
			await expect(provider.listWorkItems({ status: 'triage' })).rejects.toThrow(
				/no workflow state ID mapped for canonical status 'triage'/,
			);
			expect(linearGraphQL).not.toHaveBeenCalled();
		});
	});

	describe('findWorkItemByUrlSuffix', () => {
		beforeEach(() => {
			linearGraphQL.mockResolvedValue(issuesPage([ISSUE_NODE]));
		});

		it('matches a suffix of the issue URL', async () => {
			await expect(
				provider.findWorkItemByUrlSuffix('/issue/ENG-42/wire-triggers'),
			).resolves.toMatchObject({ id: ISSUE_NODE.id });
		});

		it("misses the caller's GitHub-shaped legacy suffix, honestly", async () => {
			// respond-to-review's documented fallback for a PR with no recorded card
			// passes `/issues/<n>`, which no linear.app URL ends with.
			await expect(provider.findWorkItemByUrlSuffix('/issues/42')).resolves.toBeUndefined();
		});
	});

	describe('findWorkItemForArtifact', () => {
		it('resolves an issue artifact through the attachment Linear recorded for its URL', async () => {
			linearGraphQL.mockResolvedValue({
				attachmentsForURL: {
					nodes: [
						{
							id: 'attachment-issue',
							issue: {
								...ISSUE_NODE,
								attachments: {
									nodes: [{ url: 'https://github.com/SmartTechBrewery/swarm/issues/42' }],
								},
							},
						},
					],
				},
			});

			await expect(
				provider.findWorkItemForArtifact({
					repository: 'SmartTechBrewery/swarm',
					kind: 'issue',
					number: '42',
				}),
			).resolves.toMatchObject({ id: ISSUE_NODE.id, taskRef: '42' });
			expect(linearGraphQL).toHaveBeenCalledWith(
				expect.stringContaining('attachmentsForURL(url: $url'),
				{ url: 'https://github.com/SmartTechBrewery/swarm/issues/42' },
			);
		});

		it('returns undefined when Linear has no attachment for an issue artifact', async () => {
			linearGraphQL.mockResolvedValue({ attachmentsForURL: { nodes: [] } });

			await expect(
				provider.findWorkItemForArtifact({
					repository: 'SmartTechBrewery/swarm',
					kind: 'issue',
					number: '999',
				}),
			).resolves.toBeUndefined();
		});

		it('resolves a pull request through the attachment Linear recorded for its URL', async () => {
			linearGraphQL.mockResolvedValue({
				attachmentsForURL: {
					nodes: [
						// attachmentsForURL is workspace-wide, so another team's card for the
						// same pull request must not be mistaken for this board's.
						{
							id: 'attachment-other',
							issue: { ...ISSUE_NODE, id: 'other-issue', team: { id: 'another-team' } },
						},
						{
							id: 'attachment-1',
							issue: {
								...ISSUE_NODE,
								attachments: {
									nodes: [{ url: 'https://github.com/SmartTechBrewery/swarm/pull/7' }],
								},
							},
						},
					],
				},
			});

			await expect(
				provider.findWorkItemForArtifact({
					repository: 'SmartTechBrewery/swarm',
					kind: 'pullRequest',
					number: '7',
				}),
			).resolves.toMatchObject({ id: ISSUE_NODE.id });
			expect(linearGraphQL).toHaveBeenCalledWith(
				expect.stringContaining('attachmentsForURL(url: $url'),
				{ url: 'https://github.com/SmartTechBrewery/swarm/pull/7' },
			);
		});

		it('returns undefined for a pull request Linear never attached to an issue', async () => {
			linearGraphQL.mockResolvedValue({ attachmentsForURL: { nodes: [] } });

			await expect(
				provider.findWorkItemForArtifact({
					repository: 'SmartTechBrewery/swarm',
					kind: 'pullRequest',
					number: '7',
				}),
			).resolves.toBeUndefined();
		});
	});

	describe('discover', () => {
		it('returns teams as containers, deduped by id and sorted by name', async () => {
			linearGraphQL
				.mockResolvedValueOnce({
					teams: {
						nodes: [
							{ id: 'team-b', name: 'platform' },
							{ id: 'team-a', name: 'Engineering' },
						],
						pageInfo: { hasNextPage: true, endCursor: 'cursor-1' },
					},
				})
				.mockResolvedValueOnce({
					teams: {
						nodes: [
							{ id: 'team-a', name: 'Engineering' },
							{ id: 'team-c', name: 'Design' },
							{ id: 'team-d' },
						],
						pageInfo: { hasNextPage: false, endCursor: null },
					},
				});

			// Sorted case-insensitively, and carrying no `url` — a Linear team has none.
			await expect(provider.discover('containers', {})).resolves.toEqual({
				containers: [
					{ id: 'team-c', name: 'Design' },
					{ id: 'team-a', name: 'Engineering' },
					{ id: 'team-b', name: 'platform' },
				],
			});
		});

		it("returns a team's workflow states ordered by position, with no providerContext", async () => {
			linearGraphQL.mockResolvedValue({
				team: {
					id: CONFIG.teamId,
					states: {
						nodes: [
							{ id: 'state-done', name: 'Done', position: 3 },
							{ id: 'state-todo', name: 'Todo', position: 1 },
							{ id: 'state-backlog', name: 'Backlog', position: 0 },
						],
						pageInfo: { hasNextPage: false, endCursor: null },
					},
				},
			});

			const result = await provider.discover('states', { containerId: CONFIG.teamId });

			expect(result).toEqual({
				states: [
					{ id: 'state-backlog', name: 'Backlog' },
					{ id: 'state-todo', name: 'Todo' },
					{ id: 'state-done', name: 'Done' },
				],
			});
			expect(result.providerContext).toBeUndefined();
			expect(linearGraphQL).toHaveBeenCalledWith(expect.stringContaining('team(id: $teamId)'), {
				teamId: CONFIG.teamId,
				cursor: undefined,
			});
		});

		it('throws when the selected team does not resolve', async () => {
			linearGraphQL.mockResolvedValue({ team: null });

			await expect(provider.discover('states', { containerId: 'nope' })).rejects.toThrow(
				"Linear team 'nope' did not resolve",
			);
		});

		it('throws when the selected team has no states to map', async () => {
			linearGraphQL.mockResolvedValue({
				team: { id: 'team-a', states: { nodes: [], pageInfo: { hasNextPage: false } } },
			});

			await expect(provider.discover('states', { containerId: 'team-a' })).rejects.toThrow(
				"Linear team 'team-a' has no workflow states to map",
			);
		});

		it('throws for a capability it does not declare', async () => {
			await expect(
				provider.discover('epics' as unknown as 'containers', {} as never),
			).rejects.toThrow("Linear does not support discovery capability 'epics'");
		});
	});

	describe('findWorkItemByDescriptionMarker', () => {
		it("narrows the team read server-side by the marker the caller's description carries", async () => {
			mockGraphQL({ ListIssues: issuesPage([ISSUE_NODE]) });

			await expect(
				provider.findWorkItemByDescriptionMarker('<!-- swarm-split:abc:1 -->'),
			).resolves.toMatchObject({ id: ISSUE_NODE.id });
			expect(variablesSentTo('ListIssues')).toEqual([
				{
					filter: { ...TEAM_FILTER, description: { contains: '<!-- swarm-split:abc:1 -->' } },
					cursor: undefined,
				},
			]);
		});

		it('returns undefined when no card carries the marker', async () => {
			mockGraphQL({ ListIssues: issuesPage([]) });

			await expect(provider.findWorkItemByDescriptionMarker('nope')).resolves.toBeUndefined();
		});
	});

	describe('moveWorkItem', () => {
		it("writes the canonical status key's mapped workflow state", async () => {
			mockGraphQL({ UpdateIssue: { issueUpdate: { success: true } } });

			await provider.moveWorkItem(ISSUE_NODE.id, 'inReview');

			expect(variablesSentTo('UpdateIssue')).toEqual([
				{ id: ISSUE_NODE.id, input: { stateId: CONFIG.statusOptions.inReview } },
			]);
		});

		it('refuses an unmapped status instead of writing an unknown state', async () => {
			await expect(provider.moveWorkItem(ISSUE_NODE.id, 'triage')).rejects.toThrow(
				/no workflow state ID mapped for canonical status 'triage'/,
			);
			expect(linearGraphQL).not.toHaveBeenCalled();
		});

		it('treats a falsy success in the payload as a failed move', async () => {
			mockGraphQL({ UpdateIssue: { issueUpdate: { success: false } } });

			await expect(provider.moveWorkItem(ISSUE_NODE.id, 'done')).rejects.toThrow(
				`Linear rejected the request to move item '${ISSUE_NODE.id}' to 'done'`,
			);
		});
	});

	describe('addComment', () => {
		it('posts natively on the Linear issue and returns the new comment id', async () => {
			mockGraphQL({
				CreateComment: { commentCreate: { success: true, comment: { id: 'comment-1' } } },
			});

			await expect(provider.addComment(ISSUE_NODE.id, 'Plan published.')).resolves.toBe(
				'comment-1',
			);
			expect(variablesSentTo('CreateComment')).toEqual([
				{ input: { issueId: ISSUE_NODE.id, body: 'Plan published.' } },
			]);
		});

		it('fails when Linear accepts the mutation but returns no comment', async () => {
			mockGraphQL({ CreateComment: { commentCreate: { success: true, comment: null } } });

			await expect(provider.addComment(ISSUE_NODE.id, 'Plan published.')).rejects.toThrow(
				`Linear rejected the request to comment on item '${ISSUE_NODE.id}'`,
			);
		});
	});

	describe('findComment', () => {
		it('finds a marker that sits beyond the first page of comments', async () => {
			mockGraphQL({
				IssueComments: ({ cursor }) =>
					cursor === undefined
						? commentsPage([{ id: 'comment-1', body: 'first' }], 'cursor-1')
						: commentsPage([{ id: 'comment-2', body: 'notes\n<!-- marker-7 -->' }]),
			});

			await expect(provider.findComment(ISSUE_NODE.id, '<!-- marker-7 -->')).resolves.toBe(
				'comment-2',
			);
			expect(variablesSentTo('IssueComments')).toEqual([
				{ id: ISSUE_NODE.id, cursor: undefined },
				{ id: ISSUE_NODE.id, cursor: 'cursor-1' },
			]);
		});

		it('returns undefined when no comment carries the marker', async () => {
			mockGraphQL({ IssueComments: commentsPage([{ id: 'comment-1', body: 'first' }]) });

			await expect(
				provider.findComment(ISSUE_NODE.id, '<!-- marker-7 -->'),
			).resolves.toBeUndefined();
		});
	});

	describe('createWorkItem', () => {
		const CREATE_INPUT = {
			title: 'Phase 2',
			description: 'Second slice.',
			status: 'planning',
			labels: ['swarm'],
		};

		it('creates the label it needs, then the issue in its starting state', async () => {
			mockGraphQL({
				FindIssueLabels: labelsPage([]),
				CreateIssueLabel: { issueLabelCreate: { success: true, issueLabel: { id: 'label-new' } } },
				CreateIssue: { issueCreate: { success: true, issue: ISSUE_NODE } },
			});

			await expect(provider.createWorkItem(CREATE_INPUT)).resolves.toMatchObject({
				id: ISSUE_NODE.id,
				title: 'Wire triggers',
				statusKey: 'inProgress',
				labels: [{ id: 'label-swarm', name: 'swarm', color: '#4cb782' }],
			});
			expect(variablesSentTo('CreateIssueLabel')).toEqual([
				{ input: { teamId: CONFIG.teamId, name: 'swarm' } },
			]);
			expect(variablesSentTo('CreateIssue')).toEqual([
				{
					input: {
						teamId: CONFIG.teamId,
						title: 'Phase 2',
						description: 'Second slice.',
						stateId: CONFIG.statusOptions.planning,
						labelIds: ['label-new'],
					},
				},
			]);
		});

		it('reuses an existing label rather than creating a second one', async () => {
			mockGraphQL({
				FindIssueLabels: labelsPage([
					{ id: 'label-workspace', name: 'swarm', team: null },
					{ id: 'label-team', name: 'Swarm', team: { id: CONFIG.teamId } },
				]),
				CreateIssue: { issueCreate: { success: true, issue: ISSUE_NODE } },
			});

			await provider.createWorkItem(CREATE_INPUT);

			// This team's own label wins over a workspace-wide one of the same name.
			expect(variablesSentTo('CreateIssue')).toMatchObject([
				{ input: { labelIds: ['label-team'] } },
			]);
		});

		it("tolerates Linear's duplicate-name rejection when a label appears mid-flight", async () => {
			let lookups = 0;
			mockGraphQL({
				FindIssueLabels: () => {
					lookups += 1;
					return lookups === 1
						? labelsPage([])
						: labelsPage([{ id: 'label-raced', name: 'swarm', team: { id: CONFIG.teamId } }]);
				},
				CreateIssueLabel: () => {
					throw new Error('Linear API error: duplicate label name');
				},
				CreateIssue: { issueCreate: { success: true, issue: ISSUE_NODE } },
			});

			await provider.createWorkItem(CREATE_INPUT);

			expect(variablesSentTo('CreateIssue')).toMatchObject([
				{ input: { labelIds: ['label-raced'] } },
			]);
		});

		it('rethrows a label-create failure that is not a duplicate name', async () => {
			mockGraphQL({
				FindIssueLabels: labelsPage([]),
				CreateIssueLabel: () => {
					throw new Error('Linear API error: insufficient permissions');
				},
			});

			await expect(provider.createWorkItem(CREATE_INPUT)).rejects.toThrow(
				'insufficient permissions',
			);
		});

		it('refuses a starting status the board mapping cannot resolve', async () => {
			await expect(provider.createWorkItem({ ...CREATE_INPUT, status: 'triage' })).rejects.toThrow(
				/no workflow state ID mapped for canonical status 'triage'/,
			);
			expect(linearGraphQL).not.toHaveBeenCalled();
		});

		it('omits labelIds entirely when the caller named no labels', async () => {
			mockGraphQL({ CreateIssue: { issueCreate: { success: true, issue: ISSUE_NODE } } });

			await provider.createWorkItem({ ...CREATE_INPUT, labels: undefined });

			expect(variablesSentTo('CreateIssue')).toEqual([
				{
					input: {
						teamId: CONFIG.teamId,
						title: 'Phase 2',
						description: 'Second slice.',
						stateId: CONFIG.statusOptions.planning,
					},
				},
			]);
		});
	});

	describe('updateWorkItem', () => {
		it('sends only the fields the patch carries', async () => {
			mockGraphQL({ UpdateIssue: { issueUpdate: { success: true } } });

			await provider.updateWorkItem(ISSUE_NODE.id, { title: 'Renamed' });

			expect(variablesSentTo('UpdateIssue')).toEqual([
				{ id: ISSUE_NODE.id, input: { title: 'Renamed' } },
			]);
		});

		it('writes nothing at all for an empty patch', async () => {
			await provider.updateWorkItem(ISSUE_NODE.id, {});

			expect(linearGraphQL).not.toHaveBeenCalled();
		});
	});

	describe('addLabel', () => {
		it("attaches a resolved label through Linear's dedicated add mutation", async () => {
			mockGraphQL({
				IssueLabels: { issue: { labels: { nodes: [{ id: 'label-other', name: 'bug' }] } } },
				FindIssueLabels: labelsPage([
					{ id: 'label-planned', name: 'planned', team: { id: CONFIG.teamId } },
				]),
				AddIssueLabel: { issueAddLabel: { success: true } },
			});

			await provider.addLabel(ISSUE_NODE.id, 'planned');

			expect(variablesSentTo('FindIssueLabels')).toEqual([{ name: 'planned', cursor: undefined }]);
			expect(variablesSentTo('AddIssueLabel')).toEqual([
				{ id: ISSUE_NODE.id, labelId: 'label-planned' },
			]);
		});

		it('is a no-op when the issue already carries the label', async () => {
			mockGraphQL({
				IssueLabels: { issue: { labels: { nodes: [{ id: 'label-planned', name: 'Planned' }] } } },
			});

			await provider.addLabel(ISSUE_NODE.id, 'planned');

			// Neither a lookup nor a write — the router above would have thrown on either.
			expect(variablesSentTo('AddIssueLabel')).toEqual([]);
		});

		it('creates a label the workspace does not have yet', async () => {
			let lookups = 0;
			mockGraphQL({
				IssueLabels: { issue: { labels: { nodes: [] } } },
				FindIssueLabels: () => {
					lookups += 1;
					return labelsPage([]);
				},
				CreateIssueLabel: {
					issueLabelCreate: { success: true, issueLabel: { id: 'label-planned' } },
				},
				AddIssueLabel: { issueAddLabel: { success: true } },
			});

			await provider.addLabel(ISSUE_NODE.id, 'planned');

			expect(lookups).toBe(1);
			expect(variablesSentTo('AddIssueLabel')).toEqual([
				{ id: ISSUE_NODE.id, labelId: 'label-planned' },
			]);
		});
	});

	describe('listBlockers', () => {
		it('merges native relations with prose mentions, deduping a doubly declared prerequisite', async () => {
			mockGraphQL({
				IssueBlockingRelations: relationsPage([
					// A `related` relation is not a dependency and must not gate work.
					{ type: 'related', issue: blockerIssue(3) },
					{ type: 'blocks', issue: blockerIssue(7) },
				]),
				IssueDependencyProse: {
					issue: {
						number: 42,
						description: 'Blocked by #7. Depends on #9. Requires #404. Requires #42.',
						comments: { nodes: [{ body: 'Also needs to land #11 first.' }] },
					},
				},
				IssueByNumber: ({ filter }) => {
					const number = (filter as { number: { eq: number } }).number.eq;
					if (number === 404) return { issues: { nodes: [] } };
					return {
						issues: { nodes: [blockerIssue(number, number === 9 ? 'completed' : 'started')] },
					};
				},
			});

			const blockers = await provider.listBlockers(ISSUE_NODE.id);

			expect(blockers).toEqual([
				{
					id: 'issue-7',
					reference: 'ENG-7',
					url: blockerIssue(7).url,
					title: 'Prerequisite 7',
					open: true,
					// The native relation wins over the same issue's bare mention.
					source: 'dependency',
				},
				{
					id: 'issue-9',
					reference: 'ENG-9',
					url: blockerIssue(9).url,
					title: 'Prerequisite 9',
					// A `completed` workflow state means the prerequisite no longer gates.
					open: false,
					source: 'mention',
				},
				{
					// Declared in a human comment rather than the description.
					id: 'issue-11',
					reference: 'ENG-11',
					url: blockerIssue(11).url,
					title: 'Prerequisite 11',
					open: true,
					source: 'mention',
				},
			]);
			// #404 resolved to nothing on this team and is not a gate, and the item's
			// own number is never looked up as its own blocker.
			expect(variablesSentTo('IssueByNumber')).toEqual(
				[7, 9, 404, 11].map((number) => ({ filter: { ...TEAM_FILTER, number: { eq: number } } })),
			);
		});

		it('reads the relations pointing at the item, mapping their source as the blocker', async () => {
			mockGraphQL({
				IssueBlockingRelations: relationsPage([
					// Both sides are present in Linear's payload; only the source blocks us.
					{ type: 'blocks', issue: blockerIssue(7), relatedIssue: blockerIssue(42) },
				]),
				IssueDependencyProse: { issue: { number: 42, description: '', comments: { nodes: [] } } },
			});

			await expect(provider.listBlockers(ISSUE_NODE.id)).resolves.toMatchObject([
				{ id: 'issue-7', source: 'dependency' },
			]);
			// "Who blocks me" is the inverse direction — `relations` would answer
			// "what do I block?" and silently gate nothing.
			expect(documentSentTo('IssueBlockingRelations')).toContain('inverseRelations(');
			expect(documentSentTo('IssueBlockingRelations')).not.toMatch(/\brelations\(/);
		});

		it('reports a canceled blocker as no longer open', async () => {
			mockGraphQL({
				IssueBlockingRelations: relationsPage([
					{ type: 'blocks', issue: blockerIssue(7, 'canceled') },
				]),
				IssueDependencyProse: { issue: { number: 42, description: '', comments: { nodes: [] } } },
			});

			await expect(provider.listBlockers(ISSUE_NODE.id)).resolves.toMatchObject([{ open: false }]);
		});

		it('returns [] for an item with neither a relation nor a prose prerequisite', async () => {
			mockGraphQL({
				IssueBlockingRelations: relationsPage([]),
				IssueDependencyProse: {
					issue: { number: 42, description: 'Mentions #9 in passing.', comments: { nodes: [] } },
				},
			});

			await expect(provider.listBlockers(ISSUE_NODE.id)).resolves.toEqual([]);
		});
	});

	// Issue #639 — the reverse edge the shared cycle backstop reads.
	describe('listDependents', () => {
		it('reads the relations this issue is the source of, mapping their target', async () => {
			mockGraphQL({
				IssueDependentRelations: dependentRelationsPage([
					// A `related` relation is not a dependency and must not excuse a blocker.
					{ type: 'related', relatedIssue: blockerIssue(3) },
					{ type: 'blocks', issue: blockerIssue(42), relatedIssue: blockerIssue(7) },
				]),
			});

			await expect(provider.listDependents(ISSUE_NODE.id)).resolves.toEqual([
				{
					id: 'issue-7',
					reference: 'ENG-7',
					url: blockerIssue(7).url,
					title: 'Prerequisite 7',
					open: true,
				},
			]);
			// The exact mirror of the blocker read: `relations` + `relatedIssue`, where
			// that one takes `inverseRelations` + `issue`. Reading either the wrong
			// connection or the wrong side would answer "who blocks me?" again and
			// suppress a genuine blocker.
			expect(documentSentTo('IssueDependentRelations')).toMatch(/\brelations\(/);
			expect(documentSentTo('IssueDependentRelations')).not.toContain('inverseRelations(');
			expect(documentSentTo('IssueDependentRelations')).toContain('relatedIssue {');
		});

		it('returns [] for an issue that blocks nothing', async () => {
			mockGraphQL({ IssueDependentRelations: dependentRelationsPage([]) });
			await expect(provider.listDependents(ISSUE_NODE.id)).resolves.toEqual([]);
		});
	});

	describe('addBlockedBy', () => {
		it('records the blocker as the relation source', async () => {
			mockGraphQL({
				IssueBlockingRelations: relationsPage([]),
				CreateIssueRelation: { issueRelationCreate: { success: true } },
			});

			await provider.addBlockedBy(ISSUE_NODE.id, 'issue-7');

			expect(variablesSentTo('CreateIssueRelation')).toEqual([
				{ input: { issueId: 'issue-7', relatedIssueId: ISSUE_NODE.id, type: 'blocks' } },
			]);
		});

		it('does not write again when Linear already holds the relation', async () => {
			mockGraphQL({
				IssueBlockingRelations: relationsPage([{ type: 'blocks', issue: blockerIssue(7) }]),
			});

			await provider.addBlockedBy(ISSUE_NODE.id, 'issue-7');

			expect(variablesSentTo('CreateIssueRelation')).toEqual([]);
		});

		it('treats a duplicate-relation rejection as success', async () => {
			mockGraphQL({
				IssueBlockingRelations: relationsPage([]),
				CreateIssueRelation: () => {
					throw new Error('Linear API error: duplicate issue relation');
				},
			});

			await expect(provider.addBlockedBy(ISSUE_NODE.id, 'issue-7')).resolves.toBeUndefined();
		});

		it('rethrows any other failure to record the relation', async () => {
			mockGraphQL({
				IssueBlockingRelations: relationsPage([]),
				CreateIssueRelation: () => {
					throw new Error('Linear API error: insufficient permissions');
				},
			});

			await expect(provider.addBlockedBy(ISSUE_NODE.id, 'issue-7')).rejects.toThrow(
				'insufficient permissions',
			);
		});
	});

	// The gate the phase-5 registration depends on, asserted here too so it fails in
	// this suite rather than only once a manifest exists: the PM conformance suite
	// rejects any *registered* provider whose method source still carries the
	// stubbed-method wording (`tests/unit/integrations/pm/pm-conformance.test.ts`).
	it('carries no stub sentinel on any contract method', () => {
		const contractMethods = [
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
		] as const;
		for (const method of contractMethods) {
			expect(String(provider[method]), method).not.toMatch(/\bnot\s+implemented\b/i);
		}
	});
});
