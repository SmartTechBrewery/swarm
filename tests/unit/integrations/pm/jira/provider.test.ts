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

/** One issued request, reduced to what an assertion cares about. */
interface IssuedRequest {
	method: string;
	path: string;
	url: URL;
	body: unknown;
}

/** Every request the provider issued, in order, with its REST path and parsed body. */
function issuedRequests(): IssuedRequest[] {
	return fetchMock.mock.calls.map(([input, init]) => {
		const url = new URL(String(input));
		return {
			method: init?.method ?? 'GET',
			path: url.pathname.slice(`${JIRA_API_PATH}/`.length),
			url,
			body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
		};
	});
}

/** The requests issued to one REST path with one method. */
function requestsTo(path: string, method: string): IssuedRequest[] {
	return issuedRequests().filter(
		(request) => request.path === path && request.method === method.toUpperCase(),
	);
}

/** The single request issued to one REST path with one method — the usual write assertion. */
function writeTo(path: string, method: string): IssuedRequest {
	const matches = requestsTo(path, method);
	expect(matches, `${method} ${path}`).toHaveLength(1);
	return matches[0] as IssuedRequest;
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

/** Wrap plain text as the ADF document REST v3 carries a description or a comment body as. */
function adfText(text: string) {
	return {
		version: 1,
		type: 'doc',
		content: text.split('\n').map((line) => ({
			type: 'paragraph',
			content: line ? [{ type: 'text', text: line }] : [],
		})),
	};
}

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

	// Issue #686 phase 1: Jira's routing axis is components — the `projectKey` is
	// already the board container, so it cannot also name a repository.
	describe('resolveItemRepository', () => {
		const CANDIDATES = [
			{ repo: 'acme/default', routingToken: 'component-default' },
			{ repo: 'acme/second', routingToken: 'component-second' },
		];

		/** The issue read answering with the given component ids and nothing else. */
		function mockComponents(...ids: string[]): void {
			mockJira({
				'issue/SWARM-42': { key: 'SWARM-42', fields: { components: ids.map((id) => ({ id })) } },
			});
		}

		it('routes a card to the non-default repository whose component it carries', async () => {
			mockComponents('component-second');

			await expect(provider.resolveItemRepository('SWARM-42', CANDIDATES)).resolves.toEqual({
				status: 'routed',
				repo: 'acme/second',
			});
		});

		it('reports a card with no components as unrouted', async () => {
			mockJira({ 'issue/SWARM-42': { key: 'SWARM-42', fields: {} } });

			await expect(provider.resolveItemRepository('SWARM-42', CANDIDATES)).resolves.toEqual({
				status: 'unrouted',
			});
		});

		it('reports a card claimed by two repositories as ambiguous rather than picking one', async () => {
			mockComponents('component-second', 'component-default');

			await expect(provider.resolveItemRepository('SWARM-42', CANDIDATES)).resolves.toEqual({
				status: 'ambiguous',
				repos: ['acme/default', 'acme/second'],
			});
		});

		it('matches the component id, never its name', async () => {
			mockJira({
				'issue/SWARM-42': {
					key: 'SWARM-42',
					fields: { components: [{ id: '10101', name: 'component-second' }] },
				},
			});

			await expect(provider.resolveItemRepository('SWARM-42', CANDIDATES)).resolves.toEqual({
				status: 'unrouted',
			});
		});

		// Its own narrow read: adding `components` to the shared field list would make
		// every other board read pay for a field none of them look at.
		it('asks for the components field alone, in one request', async () => {
			mockComponents('component-second');

			await provider.resolveItemRepository('SWARM-42', CANDIDATES);

			const reads = requestsTo('issue/SWARM-42', 'GET');
			expect(reads).toHaveLength(1);
			expect(reads[0]?.url.searchParams.get('fields')).toBe('components');
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

	describe('moveWorkItem', () => {
		it('executes the transition whose target is the mapped status id', async () => {
			mockJira({
				'issue/SWARM-42': { fields: { status: { id: '3', name: 'In Progress' } } },
				'issue/SWARM-42/transitions': {
					transitions: [
						{ id: '11', name: 'Back to backlog', to: { id: CONFIG.statusOptions.backlog } },
						{ id: '31', name: 'Review', to: { id: CONFIG.statusOptions.inReview } },
						// Neither of these can be matched or executed.
						{ id: '41', name: 'Half a transition' },
						null,
					],
				},
			});

			await provider.moveWorkItem('SWARM-42', 'inReview');

			// The *transition* id, never the status id: Jira moves an issue through its
			// workflow rather than accepting a status assignment.
			expect(writeTo('issue/SWARM-42/transitions', 'POST').body).toEqual({
				transition: { id: '31' },
			});
		});

		it('throws naming the status it is stuck in and every transition Jira offers', async () => {
			mockJira({
				'issue/SWARM-42': { fields: { status: { id: '3', name: 'In Progress' } } },
				'issue/SWARM-42/transitions': {
					transitions: [
						{ id: '11', name: 'Back to backlog', to: { id: '10000', name: 'Backlog' } },
					],
				},
			});

			await expect(provider.moveWorkItem('SWARM-42', 'done')).rejects.toThrow(
				/cannot reach canonical status 'done' \(Jira status id 10004\).*current status 'In Progress' \(id 3\).*11:Back to backlog → Backlog \(id 10000\)/s,
			);
			// Warning and returning — what Cascade's adapter does — would leave the
			// pipeline believing it reported progress, so nothing is posted either.
			expect(requestsTo('issue/SWARM-42/transitions', 'POST')).toHaveLength(0);
		});

		it('treats a move to the status the card already holds as a no-op', async () => {
			mockJira({ 'issue/SWARM-42': { fields: { status: { id: '3', name: 'In Progress' } } } });

			await provider.moveWorkItem('SWARM-42', 'inProgress');

			// `autoAdvance` re-requests the status a card is already in, and no
			// transition *to* the current status exists — so the workflow is never read.
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});
	});

	describe('addComment', () => {
		it('posts the body as ADF on the issue itself and returns the comment id', async () => {
			mockJira({ 'issue/SWARM-42/comment': { id: '10500' } });

			await expect(provider.addComment('SWARM-42', 'Plan published.\n\nSee above.')).resolves.toBe(
				'10500',
			);

			// Unlike GitHub Projects, whose card has no thread, a Jira issue *is* the
			// card — there is no backing artifact to resolve first.
			expect(writeTo('issue/SWARM-42/comment', 'POST').body).toEqual({
				body: adfText('Plan published.\n\nSee above.'),
			});
		});

		it('fails when Jira accepts the comment without returning its id', async () => {
			mockJira({ 'issue/SWARM-42/comment': {} });

			await expect(provider.addComment('SWARM-42', 'Plan published.')).rejects.toThrow(
				/returned no comment id/,
			);
		});
	});

	describe('findComment', () => {
		/** Three pages of two comments each; the marker sits on the last page. */
		function commentThread(markerBody: string): Responder {
			return (url) => {
				const startAt = Number(url.searchParams.get('startAt') ?? 0);
				const pages = [
					[
						{ id: 'c1', body: adfText('First look') },
						{ id: 'c2', body: adfText('Second look') },
					],
					[
						{ id: 'c3', body: adfText('Third look') },
						{ id: 'c4', body: adfText('Fourth look') },
					],
					[
						{ id: 'c5', body: adfText(markerBody) },
						{ id: 'c6', body: adfText('Last word') },
					],
				];
				return { startAt, maxResults: 2, total: 6, comments: pages[startAt / 2] ?? [] };
			};
		}

		it('walks the whole thread, finding a marker that only appears on page 3', async () => {
			mockJira({
				'issue/SWARM-42/comment': commentThread(`Plan published.\n${DESCRIPTION_MARKER}`),
			});

			// A marker beyond page 1 that is missed posts a duplicate on the retry.
			await expect(provider.findComment('SWARM-42', DESCRIPTION_MARKER)).resolves.toBe('c5');
			expect(requestsTo('issue/SWARM-42/comment', 'GET')).toHaveLength(3);
		});

		it('returns undefined when nothing in the thread carries the marker', async () => {
			mockJira({ 'issue/SWARM-42/comment': commentThread('Plan published.') });

			await expect(provider.findComment('SWARM-42', DESCRIPTION_MARKER)).resolves.toBeUndefined();
		});
	});

	describe('createWorkItem', () => {
		const NEW_CARD = jiraIssue({
			key: 'SWARM-99',
			fields: { status: { id: CONFIG.statusOptions.planning, name: 'Planning' } },
		});

		/** Create → transition → read-back, with the workflow offering `transitions`. */
		function createRoutes(transitions: unknown[]): Record<string, Responder> {
			return {
				'project/SWARM': {
					issueTypes: [
						// A sub-task needs a parent, so it can never be the type of a card.
						{ id: '10100', name: 'Sub-task', subtask: true },
						{ id: '10101', name: 'Bug', subtask: false },
						{ id: '10102', name: 'Task', subtask: false },
					],
				},
				issue: { id: '10999', key: 'SWARM-99' },
				'issue/SWARM-99': (url) =>
					url.searchParams.get('fields') === 'status'
						? { fields: { status: { id: CONFIG.statusOptions.backlog, name: 'Backlog' } } }
						: NEW_CARD,
				'issue/SWARM-99/transitions': { transitions },
				'issue/SWARM-99/remotelink': [],
			};
		}

		const INPUT = {
			title: 'Phase 2/6',
			description: 'Do the board reads.',
			status: 'planning',
			labels: ['swarm', 'enhancement'],
		};

		it('creates as a standard issue type, transitions into the status, and reads the card back', async () => {
			mockJira(
				createRoutes([
					{ id: '21', name: 'Start planning', to: { id: CONFIG.statusOptions.planning } },
				]),
			);

			const created = await provider.createWorkItem(INPUT);

			expect(writeTo('issue', 'POST').body).toEqual({
				fields: {
					project: { key: 'SWARM' },
					summary: 'Phase 2/6',
					description: adfText('Do the board reads.'),
					// `Task` wins over the project's other standard type, and no config
					// field names an issue type (issue #490's non-goal).
					issuetype: { id: '10102' },
					// Jira labels are free-form and auto-create, so the names go straight on.
					labels: ['swarm', 'enhancement'],
				},
			});
			// Jira cannot create an issue directly *into* an arbitrary status, so the
			// requested one is reached through the workflow.
			expect(writeTo('issue/SWARM-99/transitions', 'POST').body).toEqual({
				transition: { id: '21' },
			});
			// Read back rather than assembled locally, so the fresh card reads exactly
			// like one off a board read.
			expect(created).toMatchObject({ id: 'SWARM-99', statusKey: 'planning' });
		});

		it('falls back to the first non-subtask type when the project offers no Task', async () => {
			mockJira({
				...createRoutes([
					{ id: '21', name: 'Start planning', to: { id: CONFIG.statusOptions.planning } },
				]),
				'project/SWARM': {
					issueTypes: [
						{ id: '10100', name: 'Sub-task', subtask: true },
						{ id: '10101', name: 'Story', subtask: false },
					],
				},
			});

			await provider.createWorkItem(INPUT);

			expect(writeTo('issue', 'POST').body).toMatchObject({
				fields: { issuetype: { id: '10101' } },
			});
		});

		it('throws rather than leaving the child in the workflow’s initial status', async () => {
			mockJira(createRoutes([{ id: '31', name: 'Done', to: { id: CONFIG.statusOptions.done } }]));

			// A child left in the initial status would never start; Planning's retry is
			// idempotent through `findWorkItemByDescriptionMarker`, so a loud failure is
			// recoverable where a silent one is not.
			await expect(provider.createWorkItem(INPUT)).rejects.toThrow(
				/cannot reach canonical status 'planning'/,
			);
			expect(requestsTo('issue', 'POST')).toHaveLength(1);
		});
	});

	describe('updateWorkItem', () => {
		it('writes the summary and the description as ADF', async () => {
			mockJira({ 'issue/SWARM-42': undefined });

			await provider.updateWorkItem('SWARM-42', {
				title: 'Phase 1/6',
				description: 'Reduced scope.',
			});

			expect(writeTo('issue/SWARM-42', 'PUT').body).toEqual({
				fields: { summary: 'Phase 1/6', description: adfText('Reduced scope.') },
			});
		});

		it('skips an empty patch rather than touching the issue’s updated timestamp', async () => {
			mockJira({});

			await provider.updateWorkItem('SWARM-42', {});

			expect(fetchMock).not.toHaveBeenCalled();
		});
	});

	describe('addLabel', () => {
		it('adds through Jira’s set-insert update verb', async () => {
			mockJira({ 'issue/SWARM-42': { fields: { labels: ['enhancement'] } } });

			await provider.addLabel('SWARM-42', 'swarm');

			// Not read-all-then-write-the-whole-list (what Cascade does): that loses a
			// label a concurrent writer added in between.
			expect(writeTo('issue/SWARM-42', 'PUT').body).toEqual({
				update: { labels: [{ add: 'swarm' }] },
			});
		});

		it('no-ops on a label the issue already carries', async () => {
			mockJira({ 'issue/SWARM-42': { fields: { labels: ['swarm'] } } });

			await provider.addLabel('SWARM-42', 'swarm');

			expect(requestsTo('issue/SWARM-42', 'PUT')).toHaveLength(0);
		});

		it('names the constraint for a label Jira could never accept', async () => {
			mockJira({});

			await expect(provider.addLabel('SWARM-42', 'needs triage')).rejects.toThrow(
				/Jira labels are single tokens and cannot contain spaces/,
			);
			expect(fetchMock).not.toHaveBeenCalled();
		});
	});

	describe('the dependency gate', () => {
		const BLOCKS_TYPE = {
			id: '10000',
			name: 'Blocks',
			inward: 'is blocked by',
			outward: 'blocks',
		};
		const RELATES_TYPE = {
			id: '10001',
			name: 'Relates',
			inward: 'relates to',
			outward: 'relates to',
		};

		function linkedIssue(key: string, summary: string, statusCategory: string) {
			return { key, fields: { summary, status: { statusCategory: { key: statusCategory } } } };
		}

		/** Both directions of the Blocks type plus an unrelated one — only one gates. */
		const ISSUE_LINKS = [
			{
				type: BLOCKS_TYPE,
				inwardIssue: linkedIssue('SWARM-7', 'Land the client', 'indeterminate'),
			},
			// The same type the other way round: this issue *blocks* SWARM-8.
			{ type: BLOCKS_TYPE, outwardIssue: linkedIssue('SWARM-8', 'Register the manifest', 'new') },
			{ type: RELATES_TYPE, inwardIssue: linkedIssue('SWARM-9', 'Dashboard tab', 'new') },
			{ type: BLOCKS_TYPE, inwardIssue: linkedIssue('SWARM-5', 'Ship the foundation', 'done') },
			null,
		];

		const LINK_TYPES = {
			issueLinkTypes: [
				RELATES_TYPE,
				// A renamed Blocks type: the write must find it by its `inward`
				// description rather than assuming the English built-in name is present.
				{ id: '10002', name: 'Bloqueia', inward: 'is blocked by', outward: 'blocks' },
			],
		};

		describe('listBlockers', () => {
			it('merges the inward links with the prose prerequisites, deduplicated', async () => {
				mockJira({
					'issue/SWARM-42': (url) =>
						url.searchParams.get('fields') === 'issuelinks'
							? { key: 'SWARM-42', fields: { issuelinks: ISSUE_LINKS } }
							: {
									key: 'SWARM-42',
									fields: {
										description: adfText('Blocked by #7 and #42; depends on #123.'),
									},
								},
					'issue/SWARM-42/comment': {
						startAt: 0,
						total: 2,
						comments: [
							{ id: 'c1', body: adfText('Requires #404 as well.') },
							// SWARM's own comment: its dependency phrase must not become a
							// blocker nobody declared (issue #431).
							{
								id: 'c2',
								body: adfText('This depends on #900.\n<!-- swarm-delivery:d-1 -->'),
							},
						],
					},
					'issue/SWARM-7': linkedIssue('SWARM-7', 'Land the client', 'indeterminate'),
					'issue/SWARM-123': linkedIssue('SWARM-123', 'Prose-only prerequisite', 'new'),
					// A referenced number that names no Jira issue is a soft miss, not a gate.
					'issue/SWARM-404': new Response('Issue does not exist', { status: 404 }),
				});

				await expect(provider.listBlockers('SWARM-42')).resolves.toEqual([
					{
						id: 'SWARM-7',
						reference: 'SWARM-7',
						url: 'https://example.atlassian.net/browse/SWARM-7',
						title: 'Land the client',
						open: true,
						// Written down *and* linked — the native link wins the dedupe.
						source: 'dependency',
					},
					{
						id: 'SWARM-5',
						reference: 'SWARM-5',
						url: 'https://example.atlassian.net/browse/SWARM-5',
						title: 'Ship the foundation',
						// Jira has no finished flag: the status *category* is the signal.
						open: false,
						source: 'dependency',
					},
					{
						id: 'SWARM-123',
						reference: 'SWARM-123',
						url: 'https://example.atlassian.net/browse/SWARM-123',
						title: 'Prose-only prerequisite',
						open: true,
						source: 'mention',
					},
				]);
			});

			it('reports nothing for a card with neither a link nor a prose prerequisite', async () => {
				mockJira({
					'issue/SWARM-42': { key: 'SWARM-42', fields: { issuelinks: [], description: null } },
					'issue/SWARM-42/comment': { startAt: 0, total: 0, comments: [] },
				});

				await expect(provider.listBlockers('SWARM-42')).resolves.toEqual([]);
			});
		});

		// Issue #639 — the reverse edge the shared cycle backstop reads.
		describe('listDependents', () => {
			it('takes the outward side of the same links the blocker read reads inward', async () => {
				mockJira({
					'issue/SWARM-42': { key: 'SWARM-42', fields: { issuelinks: ISSUE_LINKS } },
				});

				// Only SWARM-8, the one `Blocks` link naming an `outwardIssue`: the two
				// inward ones are what blocks *this* issue, and the `Relates` link is no
				// dependency in either direction.
				await expect(provider.listDependents('SWARM-42')).resolves.toEqual([
					{
						id: 'SWARM-8',
						reference: 'SWARM-8',
						url: 'https://example.atlassian.net/browse/SWARM-8',
						title: 'Register the manifest',
						open: true,
					},
				]);
			});

			it('reports nothing for an issue that blocks nothing', async () => {
				mockJira({ 'issue/SWARM-42': { key: 'SWARM-42', fields: { issuelinks: [] } } });
				await expect(provider.listDependents('SWARM-42')).resolves.toEqual([]);
			});
		});

		describe('addBlockedBy', () => {
			it('records the link in the direction that means “id is blocked by blockerId”', async () => {
				mockJira({
					'issue/SWARM-42': { key: 'SWARM-42', fields: { issuelinks: [] } },
					issueLinkType: LINK_TYPES,
					issueLink: undefined,
				});

				await provider.addBlockedBy('SWARM-42', 'SWARM-7');

				// `outwardIssue` is the link's *from* side, so this reads
				// "SWARM-7 blocks SWARM-42" — which SWARM-42 reads back as an
				// `inwardIssue` entry.
				expect(writeTo('issueLink', 'POST').body).toEqual({
					type: { name: 'Bloqueia' },
					inwardIssue: { key: 'SWARM-42' },
					outwardIssue: { key: 'SWARM-7' },
				});
			});

			it('is a no-op when Jira already records the link', async () => {
				mockJira({
					'issue/SWARM-42': {
						key: 'SWARM-42',
						fields: {
							issuelinks: [
								{ type: BLOCKS_TYPE, inwardIssue: linkedIssue('SWARM-7', 'Land it', 'new') },
							],
						},
					},
				});

				await provider.addBlockedBy('SWARM-42', 'SWARM-7');

				// Re-chaining a split's phases must not fail on a retry — and the link
				// type is not even resolved.
				expect(fetchMock).toHaveBeenCalledTimes(1);
			});

			it('swallows a duplicate-link rejection racing the read above', async () => {
				mockJira({
					'issue/SWARM-42': { key: 'SWARM-42', fields: { issuelinks: [] } },
					issueLinkType: LINK_TYPES,
					issueLink: new Response('{"errorMessages":["That issue link already exists"]}', {
						status: 400,
					}),
				});

				await expect(provider.addBlockedBy('SWARM-42', 'SWARM-7')).resolves.toBeUndefined();
			});

			it('rethrows any other rejection rather than reporting a link it never made', async () => {
				mockJira({
					'issue/SWARM-42': { key: 'SWARM-42', fields: { issuelinks: [] } },
					issueLinkType: LINK_TYPES,
					issueLink: new Response('{"errorMessages":["Link issues is not available"]}', {
						status: 403,
					}),
				});

				await expect(provider.addBlockedBy('SWARM-42', 'SWARM-7')).rejects.toThrow(/\(403\)/);
			});

			it('throws when the site defines no “is blocked by” link type at all', async () => {
				mockJira({
					'issue/SWARM-42': { key: 'SWARM-42', fields: { issuelinks: [] } },
					issueLinkType: { issueLinkTypes: [RELATES_TYPE] },
				});

				await expect(provider.addBlockedBy('SWARM-42', 'SWARM-7')).rejects.toThrow(
					/defines no 'is blocked by' issue link type.*Relates/s,
				);
			});
		});
	});
});
