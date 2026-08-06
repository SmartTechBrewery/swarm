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

		it('takes taskRef only from a GitHub artifact attachment in this project repository', async () => {
			linearGraphQL.mockResolvedValue({
				issue: {
					...ISSUE_NODE,
					attachments: {
						nodes: [
							{ url: 'https://github.com/another/repo/issues/9' },
							{ url: 'https://github.com/SmartTechBrewery/swarm/pull/19/files' },
						],
					},
				},
			});

			await expect(provider.getWorkItem(ISSUE_NODE.id)).resolves.toMatchObject({ taskRef: '19' });
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

	// The safety property this phase leans on: the writes are still stubs, and the
	// PM conformance suite fails any *registered* manifest whose method source
	// carries this wording — so registering Linear before the next phase lands
	// breaks the build instead of shipping an unwritable board.
	it('keeps the not-implemented sentinel on every method a later phase lands', () => {
		const pending = [
			'moveWorkItem',
			'addComment',
			'findComment',
			'createWorkItem',
			'updateWorkItem',
			'addLabel',
			'listBlockers',
			'addBlockedBy',
		] as const;
		for (const method of pending) {
			expect(String(provider[method]), method).toMatch(/\bnot\s+implemented\b/i);
		}
	});
});
