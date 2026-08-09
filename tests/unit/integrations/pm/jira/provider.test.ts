import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted so the mock factory below can use it before the hoisted `import`s run.
const { requirePmCredential } = vi.hoisted(() => ({
	requirePmCredential: vi.fn<(project: unknown, role: string) => Promise<string>>(),
}));

// A PM credential role resolves against the *registered* manifest, and Jira
// registers none until its final phase (ai/RULES.md §2), so the seam is mocked.
// Nothing else is: `fetch` is the only other stand-in, so the real client, its
// basic-auth scoping, and its paging all run.
vi.mock('@/config/provider.js', () => ({ requirePmCredential }));

import { JIRA_API_PATH } from '@/integrations/pm/jira/client.js';
import { requireJiraConfig } from '@/integrations/pm/jira/config-schema.js';
import { createJiraProvider, JiraPMProvider } from '@/integrations/pm/jira/provider.js';
import { createMockJiraProjectConfig } from '../../../../helpers/factories.js';

const PROJECT = createMockJiraProjectConfig();
const CONFIG = requireJiraConfig(PROJECT);
const REPO = PROJECT.repo;

/** A `fetch` stand-in typed with the real signature so `mock.calls` indexes. */
type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

/** A route answers with a body to serialize, a whole `Response`, or nothing at all. */
type ResponseBody = Response | Record<string, unknown> | unknown[] | undefined;
type Responder = ResponseBody | ((url: URL) => ResponseBody);

let fetchMock: FetchMock;

/**
 * Route the stubbed transport by the REST path, anchored, so an unexpected
 * endpoint fails loudly instead of silently reusing another route's payload.
 * Each handler sees the request URL, which is where the JQL and the paging
 * parameters the provider built show up.
 */
function mockJira(routes: Record<string, Responder>): void {
	fetchMock.mockImplementation(async (input) => {
		const url = new URL(String(input));
		const path = url.pathname.slice(`${JIRA_API_PATH}/`.length);
		const pattern = Object.keys(routes).find((candidate) =>
			new RegExp(`^${candidate}$`).test(path),
		);
		if (pattern === undefined) {
			throw new Error(`Unexpected Jira request '${path}'`);
		}
		const responder = routes[pattern];
		const body = typeof responder === 'function' ? responder(url) : responder;
		if (body instanceof Response) return body;
		if (body === undefined) return new Response(null, { status: 200 });
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		});
	});
}

/** The request URLs the provider issued, in order. */
function requestedUrls(): URL[] {
	return fetchMock.mock.calls.map(([input]) => new URL(String(input)));
}

/** The `jql` parameter of the first search request issued. */
function jqlSent(): string | null {
	const search = requestedUrls().find((url) => url.pathname.endsWith('/search/jql'));
	return search?.searchParams.get('jql') ?? null;
}

const DESCRIPTION_MARKER = '<!-- swarm-split-child:2490f13f:0 -->';

/** An ADF description, the wire shape REST v3 carries rich text in. */
const DESCRIPTION_ADF = {
	version: 1,
	type: 'doc',
	content: [
		{ type: 'paragraph', content: [{ type: 'text', text: 'Wire the triggers.' }] },
		{ type: 'paragraph', content: [{ type: 'text', text: DESCRIPTION_MARKER }] },
	],
};

const DESCRIPTION_TEXT = `Wire the triggers.\n\n${DESCRIPTION_MARKER}`;

function jiraIssue(overrides: { key?: string; fields?: Record<string, unknown> } = {}) {
	return {
		key: overrides.key ?? 'SWARM-42',
		id: '10042',
		fields: {
			summary: 'Wire triggers',
			description: DESCRIPTION_ADF,
			status: { id: CONFIG.statusOptions.inProgress, name: 'In Progress' },
			labels: ['swarm', 'enhancement'],
			assignee: {
				accountId: '5b10a2844c20165700ede21g',
				displayName: 'Ada Lovelace',
				emailAddress: 'ada@example.com',
			},
			created: '2026-07-01T00:00:00.000+0000',
			updated: '2026-07-02T00:00:00.000+0000',
			...overrides.fields,
		},
	};
}

/** One page of the enhanced JQL search — token-paged, unlike every other operation. */
function searchPage(issues: unknown[], nextPageToken?: string) {
	return nextPageToken ? { issues, nextPageToken, isLast: false } : { issues, isLast: true };
}

const GITHUB_ISSUE_LINK = { object: { url: `https://github.com/${REPO}/issues/577` } };
const GITHUB_PR_LINK = { object: { url: `https://github.com/${REPO}/pull/601` } };

describe('JiraPMProvider', () => {
	let provider: JiraPMProvider;

	beforeEach(() => {
		fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal('fetch', fetchMock);
		requirePmCredential.mockImplementation(async (_project, role) =>
			role === 'email' ? 'bot@example.com' : 'jira-api-token',
		);
		provider = new JiraPMProvider(PROJECT);
	});

	it('declares the Jira provider id and both capability flags', () => {
		expect(provider.type).toBe('jira');
		expect(provider.supportsAssignees).toBe(true);
		expect(provider.supportsDependencies).toBe(true);
		expect(createJiraProvider(PROJECT)).toBeInstanceOf(JiraPMProvider);
	});

	describe('getWorkItem', () => {
		it('maps every field, resolving the canonical status key and the ADF description', async () => {
			mockJira({
				'issue/SWARM-42': jiraIssue(),
				'issue/SWARM-42/remotelink': [GITHUB_PR_LINK, GITHUB_ISSUE_LINK],
			});

			await expect(provider.getWorkItem('SWARM-42')).resolves.toEqual({
				// The human key, not the numeric issue id: it is what a webhook carries
				// and what every other seam speaks.
				id: 'SWARM-42',
				title: 'Wire triggers',
				description: DESCRIPTION_TEXT,
				url: 'https://example.atlassian.net/browse/SWARM-42',
				taskRef: '577',
				status: 'In Progress',
				statusId: CONFIG.statusOptions.inProgress,
				statusKey: 'inProgress',
				// Jira labels are free-form strings, so the name is also the id.
				labels: [
					{ id: 'swarm', name: 'swarm' },
					{ id: 'enhancement', name: 'enhancement' },
				],
				assignees: [
					{
						handle: 'ada@example.com',
						displayName: 'Ada Lovelace',
						providerId: '5b10a2844c20165700ede21g',
					},
				],
				createdAt: '2026-07-01T00:00:00.000+0000',
				updatedAt: '2026-07-02T00:00:00.000+0000',
			});

			// Every request runs inside the provider's own credential scope, and the read
			// names the fields it needs rather than pulling a site's custom fields down.
			const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
			expect(headers.Authorization).toMatch(/^Basic /);
			expect(requestedUrls()[0]?.searchParams.get('fields')).toBe(
				'summary,description,status,labels,assignee,created,updated',
			);
		});

		it('falls back to the display name when Jira Cloud hides the assignee email', async () => {
			mockJira({
				'issue/SWARM-42': jiraIssue({
					fields: { assignee: { accountId: 'acc-1', displayName: 'Ada Lovelace' } },
				}),
				'issue/SWARM-42/remotelink': [],
			});

			const item = await provider.getWorkItem('SWARM-42');

			expect(item.assignees).toEqual([
				{ handle: 'Ada Lovelace', displayName: 'Ada Lovelace', providerId: 'acc-1' },
			]);
		});

		it('reports no assignee and no status key for an unassigned, unmapped card', async () => {
			mockJira({
				'issue/SWARM-42': jiraIssue({
					fields: { assignee: null, status: { id: '99999', name: 'Awaiting Legal' } },
				}),
				'issue/SWARM-42/remotelink': [],
			});

			const item = await provider.getWorkItem('SWARM-42');

			expect(item.assignees).toEqual([]);
			expect(item.status).toBe('Awaiting Legal');
			expect(item.statusKey).toBeUndefined();
		});

		it.each([
			{ label: 'only a pull-request remote link', links: [GITHUB_PR_LINK] },
			{
				label: 'a GitHub issue link in another repository',
				links: [{ object: { url: 'https://github.com/acme/other/issues/12' } }],
			},
			{ label: 'no remote links at all', links: [] },
		])('leaves taskRef unset for a card with $label', async ({ links }) => {
			mockJira({ 'issue/SWARM-42': jiraIssue(), 'issue/SWARM-42/remotelink': links });

			// A PR is an artifact *of* the task, not its id, and the Jira key is never a
			// task id — so an unlinked card honestly has none (ai/ARCHITECTURE.md "Task
			// identity"). The phase dispatcher logs and skips.
			await expect(provider.getWorkItem('SWARM-42')).resolves.toMatchObject({
				taskRef: undefined,
			});
		});

		it('treats an id that does not resolve as bad input rather than a soft miss', async () => {
			mockJira({ 'issue/SWARM-9999': undefined });

			await expect(provider.getWorkItem('SWARM-9999')).rejects.toThrow(
				"Jira issue 'SWARM-9999' did not resolve",
			);
		});

		it('propagates the API error for an unknown key', async () => {
			mockJira({ 'issue/SWARM-9999': new Response('Issue does not exist', { status: 404 }) });

			await expect(provider.getWorkItem('SWARM-9999')).rejects.toThrow(/\(404\)/);
		});
	});

	describe('listWorkItems', () => {
		it('pages the whole board through the search token', async () => {
			mockJira({
				'search/jql': (url) =>
					url.searchParams.get('nextPageToken') === 'page-2'
						? searchPage([jiraIssue({ key: 'SWARM-43' })])
						: searchPage([jiraIssue()], 'page-2'),
			});

			const items = await provider.listWorkItems();

			expect(items.map((item) => item.id)).toEqual(['SWARM-42', 'SWARM-43']);
			expect(jqlSent()).toBe('project = "SWARM" ORDER BY created DESC');
			// A whole-board read deliberately spends no remote-link request per card, so
			// the only calls are the two search pages.
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(items.every((item) => item.taskRef === undefined)).toBe(true);
		});

		it('narrows the read to the mapped Jira status id, unquoted so JQL reads it as an id', async () => {
			mockJira({ 'search/jql': searchPage([jiraIssue()]) });

			await provider.listWorkItems({ status: 'inProgress' });

			expect(jqlSent()).toBe(
				`project = "SWARM" AND status = ${CONFIG.statusOptions.inProgress} ORDER BY created DESC`,
			);
		});

		it('fails loudly on an unmapped status rather than widening to the whole board', async () => {
			mockJira({ 'search/jql': searchPage([]) });

			await expect(provider.listWorkItems({ status: 'archived' })).rejects.toThrow(
				/no status ID mapped for canonical status 'archived'/,
			);
			expect(fetchMock).not.toHaveBeenCalled();
		});

		it('names the offending mapping when a configured status is not a Jira status id', async () => {
			const named = new JiraPMProvider(
				createMockJiraProjectConfig({
					pm: { type: 'jira', ...CONFIG, statusOptions: { ...CONFIG.statusOptions, done: 'Done' } },
				}),
			);
			mockJira({ 'search/jql': searchPage([]) });

			await expect(named.listWorkItems({ status: 'done' })).rejects.toThrow(
				/maps canonical status 'done' to 'Done', which is not a Jira status ID/,
			);
			expect(fetchMock).not.toHaveBeenCalled();
		});
	});

	describe('findWorkItemByUrlSuffix', () => {
		it("resolves nothing for the caller's GitHub-shaped suffix, which a Jira URL never carries", async () => {
			mockJira({ 'search/jql': searchPage([jiraIssue()]) });

			// The only caller is the legacy fallback in `respond-to-review.ts`; a Jira
			// board reports through SWARM's own durable `runs.work_item_id` link instead.
			await expect(provider.findWorkItemByUrlSuffix('/issues/577')).resolves.toBeUndefined();
		});

		it('matches a Jira-shaped suffix and pays the one remote-link read for its taskRef', async () => {
			mockJira({
				'search/jql': searchPage([jiraIssue({ key: 'SWARM-43' }), jiraIssue()]),
				'issue/SWARM-42/remotelink': [GITHUB_ISSUE_LINK],
			});

			await expect(provider.findWorkItemByUrlSuffix('/browse/SWARM-42')).resolves.toMatchObject({
				id: 'SWARM-42',
				taskRef: '577',
			});
		});
	});

	describe('findWorkItemForArtifact', () => {
		it('confirms a candidate by an exact remote-link URL and fills taskRef from the same read', async () => {
			mockJira({
				'search/jql': searchPage([jiraIssue({ key: 'SWARM-41' }), jiraIssue()]),
				'issue/SWARM-41/remotelink': [{ object: { url: `https://github.com/${REPO}/issues/12` } }],
				'issue/SWARM-42/remotelink': [GITHUB_PR_LINK, GITHUB_ISSUE_LINK],
			});

			await expect(
				provider.findWorkItemForArtifact({ repository: REPO, kind: 'issue', number: '577' }),
			).resolves.toMatchObject({ id: 'SWARM-42', taskRef: '577' });

			// The scan orders by recency, since the card behind an active pull request is
			// one SWARM has been moving.
			expect(jqlSent()).toBe('project = "SWARM" ORDER BY updated DESC');
		});

		it('confirms a pull-request artifact through its own remote link', async () => {
			mockJira({
				'search/jql': searchPage([jiraIssue()]),
				'issue/SWARM-42/remotelink': [GITHUB_PR_LINK],
			});

			await expect(
				provider.findWorkItemForArtifact({ repository: REPO, kind: 'pullRequest', number: '601' }),
			).resolves.toMatchObject({ id: 'SWARM-42', taskRef: undefined });
		});

		it('misses softly when the board only links the same number in another repository', async () => {
			mockJira({
				'search/jql': searchPage([jiraIssue()]),
				'issue/SWARM-42/remotelink': [
					{ object: { url: 'https://github.com/acme/other/issues/577' } },
				],
			});

			await expect(
				provider.findWorkItemForArtifact({ repository: REPO, kind: 'issue', number: '577' }),
			).resolves.toBeUndefined();
		});

		it('caps the scan rather than reading remote links for an unbounded board', async () => {
			const board = Array.from({ length: 80 }, (_, index) =>
				jiraIssue({ key: `SWARM-${index + 1}` }),
			);
			mockJira({
				'search/jql': searchPage(board),
				'issue/SWARM-\\d+/remotelink': [],
			});

			await expect(
				provider.findWorkItemForArtifact({ repository: REPO, kind: 'issue', number: '577' }),
			).resolves.toBeUndefined();

			// One search page plus 50 confirmations — the cap, not the whole board.
			expect(fetchMock).toHaveBeenCalledTimes(51);
		});
	});

	describe('findWorkItemByDescriptionMarker', () => {
		it('narrows server-side with the marker escaped past Jira’s text operators', async () => {
			mockJira({
				'search/jql': searchPage([jiraIssue()]),
				'issue/SWARM-42/remotelink': [GITHUB_ISSUE_LINK],
			});

			await expect(
				provider.findWorkItemByDescriptionMarker(DESCRIPTION_MARKER),
			).resolves.toMatchObject({ id: 'SWARM-42', taskRef: '577' });

			// `-` and `!` are query operators for Jira's text index, so they reach it
			// backslash-escaped through the JQL string literal.
			expect(jqlSent()).toBe(
				'project = "SWARM" AND description ~ "<\\\\!\\\\-\\\\- swarm\\\\-split\\\\-child\\\\:2490f13f\\\\:0 \\\\-\\\\->" ORDER BY created DESC',
			);
		});

		it('rejects a JQL false positive at the client-side confirmation, since `~` is a token match', async () => {
			mockJira({
				'search/jql': searchPage([
					jiraIssue({
						key: 'SWARM-7',
						fields: {
							description: {
								version: 1,
								type: 'doc',
								content: [
									{
										type: 'paragraph',
										content: [{ type: 'text', text: 'swarm split child 2490f13f 1' }],
									},
								],
							},
						},
					}),
				]),
			});

			await expect(
				provider.findWorkItemByDescriptionMarker(DESCRIPTION_MARKER),
			).resolves.toBeUndefined();
		});
	});

	describe('discover', () => {
		it('answers containers with project keys, deduplicated and sorted by name', async () => {
			mockJira({
				'project/search': (url) =>
					url.searchParams.get('startAt') === '0'
						? {
								startAt: 0,
								values: [
									{ id: '10001', key: 'SWARM', name: 'Swarm' },
									{ id: '10002', key: 'OPS', name: 'operations' },
								],
							}
						: {
								startAt: 2,
								isLast: true,
								values: [
									// A project repeated across pages, and one too partial to pick.
									{ id: '10001', key: 'SWARM', name: 'Swarm' },
									{ id: '10003', name: 'Nameless key' },
								],
							},
			});

			// The id is the project KEY, not the numeric project id: it is what an issue
			// key is prefixed with and what the board mapping stores.
			await expect(provider.discover('containers', {})).resolves.toEqual({
				containers: [
					{
						id: 'OPS',
						name: 'operations',
						url: 'https://example.atlassian.net/browse/OPS',
					},
					{ id: 'SWARM', name: 'Swarm', url: 'https://example.atlassian.net/browse/SWARM' },
				],
			});
		});

		it('flattens and deduplicates the statuses Jira groups by issue type', async () => {
			mockJira({
				'project/SWARM/statuses': [
					{
						id: '10001',
						name: 'Task',
						statuses: [{ id: '10000', name: 'Backlog' }, { id: '3', name: 'In Progress' }, null],
					},
					{
						id: '10002',
						name: 'Bug',
						statuses: [
							{ id: '3', name: 'In Progress' },
							{ id: '10004', name: 'Done' },
							{ name: 'Unidentifiable' },
						],
					},
				],
			});

			await expect(provider.discover('states', { containerId: 'SWARM' })).resolves.toEqual({
				// No `providerContext`: a Jira status id is the whole mapping.
				states: [
					{ id: '10000', name: 'Backlog' },
					{ id: '3', name: 'In Progress' },
					{ id: '10004', name: 'Done' },
				],
			});
		});

		it('throws an actionable error for a project key that does not resolve', async () => {
			mockJira({ 'project/NOPE/statuses': undefined });

			await expect(provider.discover('states', { containerId: 'NOPE' })).rejects.toThrow(
				"Jira project 'NOPE' did not resolve",
			);
		});

		it('throws an actionable error for a project with no mappable statuses', async () => {
			mockJira({ 'project/SWARM/statuses': [{ id: '10001', name: 'Task', statuses: [] }] });

			await expect(provider.discover('states', { containerId: 'SWARM' })).rejects.toThrow(
				"Jira project 'SWARM' has no workflow statuses to map",
			);
		});

		it('throws for a capability it does not declare', async () => {
			await expect(
				provider.discover('epics' as unknown as 'containers', {} as never),
			).rejects.toThrow("Jira does not support discovery capability 'epics'");
		});
	});

	// The writes, the transition, and the dependency gate are phase 3/6. The wording
	// is the sentinel the conformance suite scans a *registered* provider for, which
	// is why nothing registers this provider yet (ai/RULES.md §2).
	describe('the methods still to be built', () => {
		it.each([
			['moveWorkItem', () => provider.moveWorkItem()],
			['addComment', () => provider.addComment()],
			['findComment', () => provider.findComment()],
			['createWorkItem', () => provider.createWorkItem()],
			['updateWorkItem', () => provider.updateWorkItem()],
			['addLabel', () => provider.addLabel()],
			['listBlockers', () => provider.listBlockers()],
			['addBlockedBy', () => provider.addBlockedBy()],
		])('%s throws the generic not-implemented sentinel', async (name, call) => {
			await expect(call()).rejects.toThrow(`${name} is not implemented for the Jira PM provider`);
		});
	});
});
