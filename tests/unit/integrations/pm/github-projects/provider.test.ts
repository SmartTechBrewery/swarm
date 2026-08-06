import { beforeEach, describe, expect, it, vi } from 'vitest';

const graphql = vi.fn();
const createComment = vi.fn();
const createIssue = vi.fn();
const updateIssue = vi.fn();
const getLabel = vi.fn();
const createLabel = vi.fn();
const addLabels = vi.fn();
const getIssue = vi.fn();
const listComments = vi.fn();
const paginate = vi.fn();
const request = vi.fn();
vi.mock('@/integrations/scm/github/client.js', () => ({
	// The credential-scoping wrapper the PM credential seam binds through
	// (`withGitHubProjectsCredentials`) — run straight through, so the provider's own
	// logic is what's under test.
	withGitHubToken: <T>(_token: string, fn: () => Promise<T>) => fn(),
	getScopedClient: () => ({
		graphql,
		request,
		paginate,
		issues: {
			createComment,
			create: createIssue,
			update: updateIssue,
			get: getIssue,
			listComments,
			getLabel,
			createLabel,
			addLabels,
		},
	}),
}));
// The board credential this provider resolves for itself (issue #537). Stubbed at
// the `credentials.pm` resolution seam rather than at the SCM persona helper it used
// to borrow: that borrowing is precisely what #537 removed.
vi.mock('@/config/provider.js', () => ({
	requirePmCredential: vi.fn(async () => 'ghp_board_token'),
}));

import { requirePmCredential } from '@/config/provider.js';
import { requireGitHubProjectsConfig } from '@/integrations/pm/github-projects/config-schema.js';
import { GITHUB_PROJECTS_API_TOKEN_ROLE } from '@/integrations/pm/github-projects/credentials.js';
import {
	createGitHubProjectsProvider,
	GitHubProjectsPMProvider,
} from '@/integrations/pm/github-projects/provider.js';
import { createMockProjectConfig } from '../../../../helpers/factories.js';

const PROJECT = createMockProjectConfig();
const PROJECT_PM = requireGitHubProjectsConfig(PROJECT);

const ITEM_NODE = {
	id: 'PVTI_x',
	createdAt: '2026-07-01T00:00:00Z',
	updatedAt: '2026-07-02T00:00:00Z',
	content: {
		__typename: 'Issue',
		number: 10,
		title: 'Wire triggers',
		body: 'Do the thing.',
		url: 'https://github.com/SmartTechBrewery/swarm/issues/10',
		repository: { nameWithOwner: 'SmartTechBrewery/swarm' },
		labels: { nodes: [{ id: 'L1', name: 'phase-4', color: 'blue' }] },
	},
	fieldValueByName: { name: 'In progress', optionId: '47fc9ee4' },
};

describe('GitHubProjectsPMProvider', () => {
	const provider = new GitHubProjectsPMProvider(PROJECT);

	beforeEach(() => {
		graphql.mockReset();
		createComment.mockReset();
		createIssue.mockReset();
		updateIssue.mockReset();
		getLabel.mockReset();
		createLabel.mockReset();
		addLabels.mockReset();
		getIssue.mockReset();
		listComments.mockReset();
		paginate.mockReset();
		request.mockReset();
	});

	it('createGitHubProjectsProvider builds the provider', () => {
		expect(createGitHubProjectsProvider(PROJECT)).toBeInstanceOf(GitHubProjectsPMProvider);
	});

	// Issue #537: every board operation authenticates with the *provider's own*
	// declared credential role, never the SCM implementer persona / operator token it
	// used to borrow.
	it("authenticates board work with the project's declared PM apiToken role", async () => {
		graphql.mockResolvedValue({ node: ITEM_NODE });

		await provider.getWorkItem('PVTI_x');

		expect(requirePmCredential).toHaveBeenCalledWith(PROJECT, GITHUB_PROJECTS_API_TOKEN_ROLE);
	});

	describe('getWorkItem', () => {
		it('maps the GraphQL item to a WorkItem', async () => {
			graphql.mockResolvedValue({ node: ITEM_NODE });

			const item = await provider.getWorkItem('PVTI_x');

			expect(item).toEqual({
				id: 'PVTI_x',
				title: 'Wire triggers',
				description: 'Do the thing.',
				url: 'https://github.com/SmartTechBrewery/swarm/issues/10',
				// The provider resolves the card's SCM artifact from its own linkage,
				// so no shared module has to regex the URL for it (issue #498).
				taskRef: '10',
				status: 'In progress',
				statusId: '47fc9ee4',
				// The provider resolves the board option id to its canonical pipeline key
				// so shared code never inverts `statusOptions` itself (issue #297).
				statusKey: 'inProgress',
				labels: [{ id: 'L1', name: 'phase-4', color: 'blue' }],
				// The node carries no `assignees` at all — an unassigned item is `[]`.
				assignees: [],
				createdAt: '2026-07-01T00:00:00Z',
				updatedAt: '2026-07-02T00:00:00Z',
			});
			expect(graphql).toHaveBeenCalledWith(expect.stringContaining('ProjectV2Item'), {
				itemId: 'PVTI_x',
			});
		});

		it('requests the complete label set using first: 100 in the query', async () => {
			graphql.mockResolvedValue({ node: ITEM_NODE });

			await provider.getWorkItem('PVTI_x');

			expect(graphql).toHaveBeenCalledWith(expect.stringContaining('labels(first: 100)'), {
				itemId: 'PVTI_x',
			});
		});

		it('correctly maps more than 50 labels returned by the GraphQL API', async () => {
			const dummyLabels = Array.from({ length: 55 }, (_, i) => ({
				id: `L_${i}`,
				name: `label-${i}`,
				color: 'grey',
			}));
			graphql.mockResolvedValue({
				node: {
					...ITEM_NODE,
					content: {
						...ITEM_NODE.content,
						labels: { nodes: dummyLabels },
					},
				},
			});

			const item = await provider.getWorkItem('PVTI_x');

			expect(item.labels).toHaveLength(55);
			expect(item.labels[54]).toEqual({ id: 'L_54', name: 'label-54', color: 'grey' });
		});

		it('throws when the item does not resolve', async () => {
			graphql.mockResolvedValue({ node: null });
			await expect(provider.getWorkItem('PVTI_missing')).rejects.toThrow('did not resolve');
		});
	});

	// The card→SCM-artifact seam (issue #498): shared code keys its worktree, branch,
	// and PR on `taskRef`, so the provider is the only place that knows how its own
	// board links to an Issue/PR.
	describe('taskRef', () => {
		it('carries the backing pull request number for a PR-backed card', async () => {
			graphql.mockResolvedValue({
				node: {
					...ITEM_NODE,
					content: {
						...ITEM_NODE.content,
						__typename: 'PullRequest',
						number: 42,
						url: 'https://github.com/SmartTechBrewery/swarm/pull/42',
					},
				},
			});

			const item = await provider.getWorkItem('PVTI_x');

			expect(item.taskRef).toBe('42');
		});

		it('is undefined for a draft card, which has no backing Issue/PR', async () => {
			graphql.mockResolvedValue({
				node: {
					id: 'PVTI_draft',
					content: { __typename: 'DraftIssue' },
					fieldValueByName: { name: 'In progress', optionId: '47fc9ee4' },
				},
			});

			const item = await provider.getWorkItem('PVTI_draft');

			expect(item.taskRef).toBeUndefined();
		});
	});

	describe('assignees', () => {
		it('declares assignee support', () => {
			expect(provider.supportsAssignees).toBe(true);
		});

		it('maps GitHub logins to provider-neutral assignees', async () => {
			graphql.mockResolvedValue({
				node: {
					...ITEM_NODE,
					content: {
						...ITEM_NODE.content,
						assignees: {
							nodes: [
								{ id: 'U_ada', login: 'ada', name: 'Ada Lovelace' },
								// A GitHub account with no profile name reports null/'' — that's
								// "no display name", not an empty one.
								{ id: 'U_grace', login: 'grace', name: null },
							],
						},
					},
				},
			});

			const item = await provider.getWorkItem('PVTI_x');

			expect(item.assignees).toEqual([
				{ handle: 'ada', displayName: 'Ada Lovelace', providerId: 'U_ada' },
				{ handle: 'grace', displayName: undefined, providerId: 'U_grace' },
			]);
			expect(graphql).toHaveBeenCalledWith(expect.stringContaining('assignees(first: 10)'), {
				itemId: 'PVTI_x',
			});
		});

		it('drops a node with no login and carries assignees through listWorkItems', async () => {
			graphql.mockResolvedValue({
				node: {
					items: {
						nodes: [
							{
								...ITEM_NODE,
								content: {
									...ITEM_NODE.content,
									assignees: { nodes: [{ login: 'ada' }, { id: 'U_broken' }] },
								},
							},
						],
					},
				},
			});

			const [item] = await provider.listWorkItems();

			expect(item.assignees).toEqual([
				{ handle: 'ada', displayName: undefined, providerId: undefined },
			]);
		});
	});

	describe('listWorkItems', () => {
		// A second item in a different Status, so the client-side filter has
		// something to exclude.
		const TODO_NODE = {
			...ITEM_NODE,
			id: 'PVTI_y',
			content: { ...ITEM_NODE.content, number: 11, title: 'Later work' },
			fieldValueByName: { name: 'ToDo', optionId: '3121a97d' },
		};

		it('maps every page node to a WorkItem when no filter is given', async () => {
			graphql.mockResolvedValue({ node: { items: { nodes: [ITEM_NODE, TODO_NODE] } } });

			const items = await provider.listWorkItems();

			expect(items.map((i) => i.id)).toEqual(['PVTI_x', 'PVTI_y']);
			expect(graphql).toHaveBeenCalledTimes(1);
			expect(graphql).toHaveBeenCalledWith(expect.stringContaining('ProjectV2'), {
				projectId: PROJECT_PM.projectId,
				cursor: undefined,
			});
		});

		it('requests the complete label set using first: 100 in the query', async () => {
			graphql.mockResolvedValue({ node: { items: { nodes: [ITEM_NODE] } } });

			await provider.listWorkItems();

			expect(graphql).toHaveBeenCalledWith(expect.stringContaining('labels(first: 100)'), {
				projectId: PROJECT_PM.projectId,
				cursor: undefined,
			});
		});

		it('walks every page, following the cursor until hasNextPage is false', async () => {
			graphql
				.mockResolvedValueOnce({
					node: {
						items: {
							nodes: [ITEM_NODE],
							pageInfo: { hasNextPage: true, endCursor: 'CURSOR_1' },
						},
					},
				})
				.mockResolvedValueOnce({
					node: {
						items: {
							nodes: [TODO_NODE],
							pageInfo: { hasNextPage: false, endCursor: null },
						},
					},
				});

			const items = await provider.listWorkItems();

			expect(items.map((i) => i.id)).toEqual(['PVTI_x', 'PVTI_y']);
			expect(graphql).toHaveBeenCalledTimes(2);
			expect(graphql).toHaveBeenNthCalledWith(1, expect.any(String), {
				projectId: PROJECT_PM.projectId,
				cursor: undefined,
			});
			expect(graphql).toHaveBeenNthCalledWith(2, expect.any(String), {
				projectId: PROJECT_PM.projectId,
				cursor: 'CURSOR_1',
			});
		});

		it('stops paging when hasNextPage is true but no cursor is returned', async () => {
			graphql.mockResolvedValue({
				node: { items: { nodes: [ITEM_NODE], pageInfo: { hasNextPage: true, endCursor: null } } },
			});

			const items = await provider.listWorkItems();

			expect(items.map((i) => i.id)).toEqual(['PVTI_x']);
			expect(graphql).toHaveBeenCalledTimes(1);
		});

		it('stops paging when a page repeats the cursor it was fetched with', async () => {
			// A misbehaving server that keeps claiming another page while handing back
			// the same cursor must not loop forever.
			graphql
				.mockResolvedValueOnce({
					node: {
						items: {
							nodes: [ITEM_NODE],
							pageInfo: { hasNextPage: true, endCursor: 'CURSOR_1' },
						},
					},
				})
				.mockResolvedValueOnce({
					node: {
						items: {
							nodes: [TODO_NODE],
							pageInfo: { hasNextPage: true, endCursor: 'CURSOR_1' },
						},
					},
				});

			const items = await provider.listWorkItems();

			expect(items.map((i) => i.id)).toEqual(['PVTI_x', 'PVTI_y']);
			expect(graphql).toHaveBeenCalledTimes(2);
		});

		it('filters client-side by the option ID resolved from the status key', async () => {
			graphql.mockResolvedValue({ node: { items: { nodes: [ITEM_NODE, TODO_NODE] } } });

			const items = await provider.listWorkItems({ status: 'inProgress' });

			expect(items.map((i) => i.id)).toEqual(['PVTI_x']);
		});

		it('throws for a requested status with no option mapping (rather than returning all)', async () => {
			// An unmapped status key must not fall through to the no-filter path and
			// return every item — it's a config/logic error, like moveWorkItem's.
			graphql.mockResolvedValue({ node: { items: { nodes: [ITEM_NODE, TODO_NODE] } } });

			await expect(provider.listWorkItems({ status: 'nonsense' })).rejects.toThrow(
				"status 'nonsense' has no option ID",
			);
			expect(graphql).not.toHaveBeenCalled();
		});

		it('drops null/id-less nodes', async () => {
			graphql.mockResolvedValue({ node: { items: { nodes: [null, ITEM_NODE, { id: '' }] } } });

			const items = await provider.listWorkItems();

			expect(items.map((i) => i.id)).toEqual(['PVTI_x']);
		});
	});

	describe('findWorkItemByUrlSuffix', () => {
		// `/issues/10` and `/issues/100`: the suffix match must not confuse them.
		const LONGER_NUMBER_NODE = {
			...ITEM_NODE,
			id: 'PVTI_z',
			content: {
				...ITEM_NODE.content,
				number: 100,
				url: 'https://github.com/SmartTechBrewery/swarm/issues/100',
			},
		};

		it('returns the one card whose backing URL ends with the suffix', async () => {
			graphql.mockResolvedValue({
				node: { items: { nodes: [LONGER_NUMBER_NODE, ITEM_NODE] } },
			});

			const item = await provider.findWorkItemByUrlSuffix('/issues/10');

			expect(item?.id).toBe('PVTI_x');
		});

		it('returns undefined when nothing on the board wraps that URL', async () => {
			graphql.mockResolvedValue({ node: { items: { nodes: [ITEM_NODE] } } });

			await expect(provider.findWorkItemByUrlSuffix('/issues/999')).resolves.toBeUndefined();
		});
	});

	describe('findWorkItemByDescriptionMarker', () => {
		// The marker Planning's split stamps into a child it creates, so a retried
		// delivery adopts that child instead of duplicating it (issue #543).
		const MARKER = '<!-- swarm-split-child:run-42:0 -->';

		it('returns the one card whose body carries the marker', async () => {
			const stamped = {
				...ITEM_NODE,
				id: 'PVTI_child',
				content: { ...ITEM_NODE.content, body: `The second slice.\n\n${MARKER}` },
			};
			graphql.mockResolvedValue({ node: { items: { nodes: [ITEM_NODE, stamped] } } });

			await expect(provider.findWorkItemByDescriptionMarker(MARKER)).resolves.toMatchObject({
				id: 'PVTI_child',
			});
		});

		it('returns undefined when no card carries it — the answer that means "create it"', async () => {
			graphql.mockResolvedValue({ node: { items: { nodes: [ITEM_NODE] } } });

			await expect(provider.findWorkItemByDescriptionMarker(MARKER)).resolves.toBeUndefined();
		});
	});

	describe('findWorkItemForArtifact', () => {
		it('selects the card from the requested repository when a board contains same-numbered issues', async () => {
			const foreignNode = {
				...ITEM_NODE,
				id: 'PVTI_foreign',
				content: {
					...ITEM_NODE.content,
					url: 'https://github.com/SmartTechBrewery/other/issues/10',
				},
			};
			graphql.mockResolvedValue({ node: { items: { nodes: [foreignNode, ITEM_NODE] } } });

			const item = await provider.findWorkItemForArtifact({
				repository: 'SmartTechBrewery/swarm',
				kind: 'issue',
				number: '10',
			});

			expect(item?.id).toBe('PVTI_x');
		});
	});

	describe('moveWorkItem', () => {
		it('writes the mapped option ID to the Status field', async () => {
			graphql.mockResolvedValue({
				updateProjectV2ItemFieldValue: { projectV2Item: { id: 'PVTI_x' } },
			});

			await provider.moveWorkItem('PVTI_x', 'inProgress');

			expect(graphql).toHaveBeenCalledWith(
				expect.stringContaining('updateProjectV2ItemFieldValue'),
				{
					projectId: PROJECT_PM.projectId,
					itemId: 'PVTI_x',
					fieldId: PROJECT_PM.statusFieldId,
					optionId: '47fc9ee4',
				},
			);
		});

		it('throws for a status with no option mapping', async () => {
			await expect(provider.moveWorkItem('PVTI_x', 'nonsense')).rejects.toThrow(
				"status 'nonsense' has no option ID",
			);
			expect(graphql).not.toHaveBeenCalled();
		});
	});

	describe('addComment', () => {
		it('posts on the backing Issue and returns the comment ID', async () => {
			graphql.mockResolvedValue({ node: ITEM_NODE });
			createComment.mockResolvedValue({ data: { id: 999888 } });

			const id = await provider.addComment('PVTI_x', 'a plan');

			expect(createComment).toHaveBeenCalledWith({
				owner: 'SmartTechBrewery',
				repo: 'swarm',
				issue_number: 10,
				body: 'a plan',
			});
			expect(id).toBe('999888');
		});

		it('throws when the item has no backing Issue (draft)', async () => {
			graphql.mockResolvedValue({
				node: { id: 'PVTI_draft', content: { __typename: 'DraftIssue' }, fieldValueByName: null },
			});
			await expect(provider.addComment('PVTI_draft', 'x')).rejects.toThrow('no backing Issue/PR');
			expect(createComment).not.toHaveBeenCalled();
		});
	});

	describe('findComment', () => {
		const MARKER = '<!-- swarm-planning-delivery:run-42 -->';

		it('returns the ID of the comment containing the marker, scanning all pages', async () => {
			graphql.mockResolvedValue({ node: ITEM_NODE });
			paginate.mockResolvedValue([
				{ id: 111, body: 'some unrelated comment' },
				{ id: 222, body: `## 🗺️ Proposed implementation plan\n1. Do the thing\n\n${MARKER}` },
			]);

			const id = await provider.findComment('PVTI_x', MARKER);

			// All pages are scanned via octokit's paginate, not a single listComments page.
			expect(paginate).toHaveBeenCalledWith(listComments, {
				owner: 'SmartTechBrewery',
				repo: 'swarm',
				issue_number: 10,
				per_page: 100,
			});
			expect(id).toBe('222');
		});

		it('finds a marker that lies beyond the first 100 comments', async () => {
			graphql.mockResolvedValue({ node: ITEM_NODE });
			// paginate() flattens every page; the matching comment sits well past page 1
			// (index 120), which a single-page read would have missed.
			const comments = Array.from({ length: 150 }, (_, i) => ({
				id: 1000 + i,
				body: i === 120 ? `plan\n\n${MARKER}` : `unrelated ${i}`,
			}));
			paginate.mockResolvedValue(comments);

			const id = await provider.findComment('PVTI_x', MARKER);
			expect(id).toBe('1120');
		});

		it('returns undefined if no comment contains the marker', async () => {
			graphql.mockResolvedValue({ node: ITEM_NODE });
			paginate.mockResolvedValue([{ id: 111, body: 'some unrelated comment' }]);

			const id = await provider.findComment('PVTI_x', MARKER);
			expect(id).toBeUndefined();
		});

		it('returns undefined when the item has no backing Issue (draft)', async () => {
			graphql.mockResolvedValue({
				node: { id: 'PVTI_draft', content: { __typename: 'DraftIssue' }, fieldValueByName: null },
			});
			const id = await provider.findComment('PVTI_draft', MARKER);
			expect(id).toBeUndefined();
			expect(paginate).not.toHaveBeenCalled();
		});
	});

	describe('createWorkItem', () => {
		it('creates the Issue, adds it to the board, sets its status, and applies labels', async () => {
			getLabel.mockResolvedValue({ data: {} }); // label already exists
			createIssue.mockResolvedValue({
				data: {
					node_id: 'I_new',
					number: 42,
					title: 'Sibling task',
					body: 'Second half',
					html_url: 'https://github.com/SmartTechBrewery/swarm/issues/42',
					labels: [{ id: 1, name: 'swarm:split-child', color: 'ededed' }],
				},
			});
			graphql
				.mockResolvedValueOnce({ addProjectV2ItemById: { item: { id: 'PVTI_new' } } })
				.mockResolvedValueOnce({});

			const created = await provider.createWorkItem({
				title: 'Sibling task',
				description: 'Second half',
				status: 'planning',
				labels: ['swarm:split-child'],
			});

			expect(createIssue).toHaveBeenCalledWith({
				owner: 'SmartTechBrewery',
				repo: 'swarm',
				title: 'Sibling task',
				body: 'Second half',
				labels: ['swarm:split-child'],
			});
			// Added to the board...
			expect(graphql).toHaveBeenNthCalledWith(1, expect.stringContaining('addProjectV2ItemById'), {
				projectId: PROJECT_PM.projectId,
				contentId: 'I_new',
			});
			// ...then placed in Planning (option 61e4505c per the mock config).
			expect(graphql).toHaveBeenNthCalledWith(
				2,
				expect.stringContaining('updateProjectV2ItemFieldValue'),
				{
					projectId: PROJECT_PM.projectId,
					itemId: 'PVTI_new',
					fieldId: PROJECT_PM.statusFieldId,
					optionId: '61e4505c',
				},
			);
			expect(created).toMatchObject({
				id: 'PVTI_new',
				title: 'Sibling task',
				statusId: '61e4505c',
				url: 'https://github.com/SmartTechBrewery/swarm/issues/42',
				// A freshly created card reads like one off a board read (issue #498) —
				// otherwise the split child SWARM just made could not be dispatched.
				taskRef: '42',
			});
			expect(created.labels.map((l) => l.name)).toContain('swarm:split-child');
		});

		it('creates a missing label before creating the Issue', async () => {
			getLabel.mockRejectedValue({ status: 404 });
			createLabel.mockResolvedValue({ data: {} });
			createIssue.mockResolvedValue({
				data: { node_id: 'I_new', number: 43, title: 'T', body: '', html_url: 'u', labels: [] },
			});
			graphql
				.mockResolvedValueOnce({ addProjectV2ItemById: { item: { id: 'PVTI_new' } } })
				.mockResolvedValueOnce({});

			await provider.createWorkItem({
				title: 'T',
				description: '',
				status: 'planning',
				labels: ['swarm:split-child'],
			});

			expect(createLabel).toHaveBeenCalledWith(
				expect.objectContaining({
					owner: 'SmartTechBrewery',
					repo: 'swarm',
					name: 'swarm:split-child',
				}),
			);
		});

		it('throws for a status with no option mapping without creating anything', async () => {
			await expect(
				provider.createWorkItem({ title: 'T', description: '', status: 'nonsense' }),
			).rejects.toThrow("status 'nonsense' has no option ID");
			expect(createIssue).not.toHaveBeenCalled();
		});
	});

	describe('updateWorkItem', () => {
		it('updates only the fields provided on the backing Issue', async () => {
			graphql.mockResolvedValue({ node: ITEM_NODE });
			updateIssue.mockResolvedValue({ data: {} });

			await provider.updateWorkItem('PVTI_x', { title: 'Renamed' });

			expect(updateIssue).toHaveBeenCalledWith({
				owner: 'SmartTechBrewery',
				repo: 'swarm',
				issue_number: 10,
				title: 'Renamed',
			});
		});

		it('is a no-op write when the patch is empty', async () => {
			graphql.mockResolvedValue({ node: ITEM_NODE });
			await provider.updateWorkItem('PVTI_x', {});
			expect(updateIssue).not.toHaveBeenCalled();
		});

		it('throws when the item has no backing Issue (draft)', async () => {
			graphql.mockResolvedValue({
				node: { id: 'PVTI_draft', content: { __typename: 'DraftIssue' }, fieldValueByName: null },
			});
			await expect(provider.updateWorkItem('PVTI_draft', { title: 'x' })).rejects.toThrow(
				'no backing Issue',
			);
			expect(updateIssue).not.toHaveBeenCalled();
		});
	});

	describe('addLabel', () => {
		it('applies an existing label without recreating it', async () => {
			graphql.mockResolvedValue({ node: ITEM_NODE });
			getLabel.mockResolvedValue({ data: {} }); // label already exists
			addLabels.mockResolvedValue({ data: [] });

			await provider.addLabel('PVTI_x', 'planned');

			expect(createLabel).not.toHaveBeenCalled();
			expect(addLabels).toHaveBeenCalledWith({
				owner: 'SmartTechBrewery',
				repo: 'swarm',
				issue_number: 10,
				labels: ['planned'],
			});
		});

		it('creates the label when it does not yet exist, then applies it', async () => {
			graphql.mockResolvedValue({ node: ITEM_NODE });
			getLabel.mockRejectedValue({ status: 404 });
			createLabel.mockResolvedValue({ data: {} });
			addLabels.mockResolvedValue({ data: [] });

			await provider.addLabel('PVTI_x', 'planned');

			expect(createLabel).toHaveBeenCalledWith(
				expect.objectContaining({ owner: 'SmartTechBrewery', repo: 'swarm', name: 'planned' }),
			);
			expect(addLabels).toHaveBeenCalledWith(
				expect.objectContaining({ issue_number: 10, labels: ['planned'] }),
			);
		});

		it('throws when the item has no backing Issue (draft)', async () => {
			graphql.mockResolvedValue({
				node: { id: 'PVTI_draft', content: { __typename: 'DraftIssue' }, fieldValueByName: null },
			});
			await expect(provider.addLabel('PVTI_draft', 'planned')).rejects.toThrow('no backing Issue');
			expect(addLabels).not.toHaveBeenCalled();
		});
	});

	describe('supportsDependencies', () => {
		it('is true — GitHub Issues models dependencies natively', () => {
			expect(provider.supportsDependencies).toBe(true);
		});
	});

	describe('listBlockers', () => {
		it('merges native "blocked by" relationships with prerequisites mentioned in prose', async () => {
			// resolveItem → the item (issue #10 in SmartTechBrewery/swarm, body has no refs).
			graphql.mockResolvedValue({ node: ITEM_NODE });
			// Native blocked-by: issue #5, still open.
			request.mockResolvedValue({
				data: [
					{
						id: 500,
						number: 5,
						title: 'Prereq',
						html_url: 'https://github.com/SmartTechBrewery/swarm/issues/5',
						state: 'open',
					},
				],
			});
			// A comment names a prose dependency on #7.
			listComments.mockResolvedValue({ data: [{ body: 'This depends on #7 landing first.' }] });
			getIssue.mockResolvedValue({
				data: {
					number: 7,
					title: 'Seven',
					html_url: 'https://github.com/SmartTechBrewery/swarm/issues/7',
					state: 'closed',
				},
			});

			const blockers = await provider.listBlockers('PVTI_x');

			expect(request).toHaveBeenCalledWith(
				'GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by',
				expect.objectContaining({ owner: 'SmartTechBrewery', repo: 'swarm', issue_number: 10 }),
			);
			expect(blockers).toEqual([
				expect.objectContaining({ reference: '#5', open: true, source: 'dependency' }),
				expect.objectContaining({ reference: '#7', open: false, source: 'mention' }),
			]);
		});

		it("ignores dependency prose in SWARM's own comments, but not in a human's", async () => {
			// A published plan is agent prose about its own work (issue #431); read as a
			// dependency declaration it would defer — then fail — Implementation on an
			// issue nobody gated the item on.
			graphql.mockResolvedValue({ node: ITEM_NODE });
			request.mockResolvedValue({ data: [] });
			listComments.mockResolvedValue({
				data: [
					{ body: 'This phase requires #266 to land first.\n\n<!-- swarm-preplan-comment:s:1 -->' },
					{
						body: '## 🗺️ Proposed implementation plan\n\nDepends on #267.\n\n_Generated by SWARM (Planning phase)._',
					},
					{ body: 'Heads up: this also depends on #268 landing first.' },
				],
			});
			getIssue.mockImplementation(async ({ issue_number }: { issue_number: number }) => ({
				data: {
					number: issue_number,
					title: `Issue ${issue_number}`,
					html_url: `https://github.com/SmartTechBrewery/swarm/issues/${issue_number}`,
					state: 'open',
				},
			}));

			const blockers = await provider.listBlockers('PVTI_x');

			expect(blockers).toEqual([
				expect.objectContaining({ reference: '#268', open: true, source: 'mention' }),
			]);
			expect(getIssue).not.toHaveBeenCalledWith(expect.objectContaining({ issue_number: 266 }));
			expect(getIssue).not.toHaveBeenCalledWith(expect.objectContaining({ issue_number: 267 }));
		});

		it('treats a missing issue-dependencies API (404) as no native blockers', async () => {
			graphql.mockResolvedValue({ node: ITEM_NODE });
			request.mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }));
			listComments.mockResolvedValue({ data: [] });

			await expect(provider.listBlockers('PVTI_x')).resolves.toEqual([]);
		});

		it('returns [] for a draft item with no backing Issue', async () => {
			graphql.mockResolvedValue({
				node: { id: 'PVTI_draft', content: { __typename: 'DraftIssue' }, fieldValueByName: null },
			});
			await expect(provider.listBlockers('PVTI_draft')).resolves.toEqual([]);
			expect(request).not.toHaveBeenCalled();
		});
	});

	describe('addBlockedBy', () => {
		it('POSTs the blocker by its numeric database id to the dependencies API', async () => {
			graphql.mockImplementation(async (_q: string, vars: { itemId: string }) => ({
				node: {
					...ITEM_NODE,
					id: vars.itemId,
					content: {
						...ITEM_NODE.content,
						number: vars.itemId === 'PVTI_blocker' ? 5 : 20,
					},
				},
			}));
			getIssue.mockResolvedValue({ data: { id: 9999, number: 5 } });
			request.mockResolvedValue({ data: {} });

			await provider.addBlockedBy('PVTI_target', 'PVTI_blocker');

			expect(request).toHaveBeenCalledWith(
				'POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by',
				expect.objectContaining({
					owner: 'SmartTechBrewery',
					repo: 'swarm',
					issue_number: 20,
					issue_id: 9999,
				}),
			);
		});

		it('is idempotent — swallows a 422 (dependency already recorded)', async () => {
			graphql.mockImplementation(async (_q: string, vars: { itemId: string }) => ({
				node: {
					...ITEM_NODE,
					id: vars.itemId,
					content: { ...ITEM_NODE.content, number: vars.itemId === 'PVTI_blocker' ? 5 : 20 },
				},
			}));
			getIssue.mockResolvedValue({ data: { id: 9999, number: 5 } });
			request.mockRejectedValue(Object.assign(new Error('Unprocessable'), { status: 422 }));

			await expect(provider.addBlockedBy('PVTI_target', 'PVTI_blocker')).resolves.toBeUndefined();
		});
	});

	describe('discover', () => {
		/**
		 * Route the shared `graphql` mock by the query it receives: board discovery
		 * fires three distinct queries (viewer boards, viewer orgs, per-org boards)
		 * and state discovery a fourth (the board's fields), all through the same
		 * scoped client.
		 */
		function routeDiscovery(handlers: {
			viewerProjects?: unknown;
			orgs?: unknown;
			orgProjects?: (login: string) => unknown;
			fields?: unknown;
		}) {
			graphql.mockImplementation(async (query: string, vars: { login?: string }) => {
				if (query.includes('organizations'))
					return handlers.orgs ?? { viewer: { organizations: { nodes: [] } } };
				if (query.includes('organization(login'))
					return (
						handlers.orgProjects?.(vars.login ?? '') ?? {
							organization: { projectsV2: { nodes: [] } },
						}
					);
				if (query.includes('ProjectV2SingleSelectField')) return handlers.fields ?? { node: null };
				if (query.includes('projectsV2'))
					return handlers.viewerProjects ?? { viewer: { projectsV2: { nodes: [] } } };
				throw new Error(`unexpected discovery query: ${query}`);
			});
		}

		describe('containers', () => {
			it('returns user- and org-owned boards, deduped by id and sorted by name', async () => {
				routeDiscovery({
					viewerProjects: {
						viewer: {
							projectsV2: {
								nodes: [
									{ id: 'PVT_me', title: 'Zeta', url: 'https://github.com/users/me/projects/1' },
									// Also owned via the org below — must appear once.
									{ id: 'PVT_shared', title: 'Shared' },
								],
								pageInfo: { hasNextPage: false, endCursor: null },
							},
						},
					},
					orgs: {
						viewer: {
							organizations: {
								nodes: [{ login: 'acme' }],
								pageInfo: { hasNextPage: false, endCursor: null },
							},
						},
					},
					orgProjects: () => ({
						organization: {
							projectsV2: {
								nodes: [
									{ id: 'PVT_org', title: 'Alpha', url: 'https://github.com/orgs/acme/projects/2' },
									{ id: 'PVT_shared', title: 'Shared' },
								],
								pageInfo: { hasNextPage: false, endCursor: null },
							},
						},
					}),
				});

				const result = await provider.discover?.('containers', {});

				expect(result?.containers).toEqual([
					{ id: 'PVT_org', name: 'Alpha', url: 'https://github.com/orgs/acme/projects/2' },
					{ id: 'PVT_shared', name: 'Shared', url: undefined },
					{ id: 'PVT_me', name: 'Zeta', url: 'https://github.com/users/me/projects/1' },
				]);
			});

			it('walks every page of the viewer boards connection', async () => {
				let viewerCalls = 0;
				graphql.mockImplementation(async (query: string) => {
					if (query.includes('organizations')) return { viewer: { organizations: { nodes: [] } } };
					if (query.includes('projectsV2')) {
						viewerCalls += 1;
						return viewerCalls === 1
							? {
									viewer: {
										projectsV2: {
											nodes: [{ id: 'PVT_1', title: 'One' }],
											pageInfo: { hasNextPage: true, endCursor: 'C1' },
										},
									},
								}
							: {
									viewer: {
										projectsV2: {
											nodes: [{ id: 'PVT_2', title: 'Two' }],
											pageInfo: { hasNextPage: false, endCursor: null },
										},
									},
								};
					}
					throw new Error('unexpected');
				});

				const result = await provider.discover?.('containers', {});

				expect(viewerCalls).toBe(2);
				expect(result?.containers.map((c) => c.id).sort()).toEqual(['PVT_1', 'PVT_2']);
			});

			// The reported #537 failure: a board token with `repo`/`project` but no
			// `read:org` can't answer `viewer.organizations`. The operator needs to be told
			// which permission to grant, not GitHub's raw resource wording.
			it('names the missing read:org permission when org enumeration is refused', async () => {
				graphql.mockImplementation(async (query: string) => {
					if (query.includes('organizations')) {
						throw new Error('Resource not accessible by personal access token');
					}
					return { viewer: { projectsV2: { nodes: [], pageInfo: { hasNextPage: false } } } };
				});

				const error = await provider.discover?.('containers', {}).catch((err) => err);

				expect(String(error?.message)).toContain('read:org');
				expect(String(error?.message)).toContain('Resource not accessible');
				// Never the credential itself.
				expect(String(error?.message)).not.toContain('ghp_board_token');
			});

			it('names the missing permission from a typed GraphQL FORBIDDEN error', async () => {
				// What Octokit actually raises for a scope-refused GraphQL query: HTTP 200
				// with an `errors` array, surfaced as a GraphqlResponseError.
				graphql.mockImplementation(async (query: string) => {
					if (query.includes('organizations')) {
						throw Object.assign(new Error('Request failed'), {
							errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible' }],
						});
					}
					return { viewer: { projectsV2: { nodes: [], pageInfo: { hasNextPage: false } } } };
				});

				const error = await provider.discover?.('containers', {}).catch((err) => err);

				expect(String(error?.message)).toContain('read:org');
			});

			// A diagnosis asserted over an outage is the same failure mode #537 was
			// reported for, one layer up: the operator goes hunting for a permission
			// problem that isn't there.
			it.each([
				['a 502 from GitHub', Object.assign(new Error('Bad gateway'), { status: 502 })],
				['a socket failure', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
				[
					'a rate limit',
					Object.assign(new Error('API rate limit exceeded'), {
						errors: [{ type: 'RATE_LIMITED' }],
					}),
				],
			])('surfaces %s unchanged instead of blaming read:org', async (_case, thrown) => {
				graphql.mockImplementation(async (query: string) => {
					if (query.includes('organizations')) throw thrown;
					return { viewer: { projectsV2: { nodes: [], pageInfo: { hasNextPage: false } } } };
				});

				const error = await provider.discover?.('containers', {}).catch((err) => err);

				expect(error).toBe(thrown);
				expect(String(error?.message)).not.toContain('read:org');
			});
		});

		describe('states', () => {
			const FIELDS_RESPONSE = {
				node: {
					id: 'PVT_me',
					fields: {
						nodes: [
							// A non-single-select field comes back empty (fragment didn't match).
							{},
							{
								id: 'PVTSSF_status',
								name: 'Status',
								options: [
									{ id: '61e4505c', name: 'Ready' },
									{ id: '47fc9ee4', name: 'In progress' },
								],
							},
						],
						pageInfo: { hasNextPage: false, endCursor: null },
					},
				},
			};

			it('returns the Status field options and its field id as provider context', async () => {
				routeDiscovery({ fields: FIELDS_RESPONSE });

				const result = await provider.discover?.('states', { containerId: 'PVT_me' });

				expect(result?.states).toEqual([
					{ id: '61e4505c', name: 'Ready' },
					{ id: '47fc9ee4', name: 'In progress' },
				]);
				expect(result?.providerContext).toEqual({ statusFieldId: 'PVTSSF_status' });
			});

			it('throws when the board does not resolve', async () => {
				routeDiscovery({ fields: { node: null } });
				await expect(provider.discover?.('states', { containerId: 'PVT_missing' })).rejects.toThrow(
					'did not resolve',
				);
			});

			it('throws when the board has no single-select Status field', async () => {
				routeDiscovery({
					fields: {
						node: { id: 'PVT_me', fields: { nodes: [{ id: 'X', name: 'Priority', options: [] }] } },
					},
				});
				await expect(provider.discover?.('states', { containerId: 'PVT_me' })).rejects.toThrow(
					'no single-select "Status" field',
				);
			});

			it('throws when the Status field has no options', async () => {
				routeDiscovery({
					fields: {
						node: { id: 'PVT_me', fields: { nodes: [{ id: 'S', name: 'Status', options: [] }] } },
					},
				});
				await expect(provider.discover?.('states', { containerId: 'PVT_me' })).rejects.toThrow(
					'has no options',
				);
			});
		});

		it('throws for an unsupported discovery capability', async () => {
			await expect(
				(provider.discover as (c: string, a: unknown) => Promise<unknown>)('bogus', {}),
			).rejects.toThrow('does not support discovery capability');
		});
	});
});
