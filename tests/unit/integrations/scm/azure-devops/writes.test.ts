import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	AzureDevOpsApiError,
	withAzureDevOpsToken,
} from '@/integrations/scm/azure-devops/client.js';
import { azureDevOpsRequestChangesMarker } from '@/integrations/scm/azure-devops/review-marker.js';
import {
	completeAzureDevOpsPullRequest,
	createAzureDevOpsPullRequest,
	MAX_PULL_REQUEST_DESCRIPTION_CHARS,
	postAzureDevOpsPullRequestThread,
	postIdempotentAzureDevOpsPullRequestThread,
	submitAzureDevOpsReview,
} from '@/integrations/scm/azure-devops/writes.js';
import { deliveryMarker } from '@/scm/swarm-origin.js';

import { createMockAzureDevOpsPullRequestResponse } from '../../../../helpers/factories.js';

/** A `fetch` stand-in typed with the real signature so `mock.calls` indexes. */
type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

/** A project name with a space, so every path assertion also proves segment encoding. */
const REPO = 'Fabrikam/Fiber Team/Web';
const PR_PATH = '/Fabrikam/Fiber%20Team/_apis/git/repositories/Web/pullrequests/17';
const HEAD_SHA = 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7';
const DELIVERY_ID = 'delivery-abc';
const MARKER = deliveryMarker(DELIVERY_ID);
const REVIEWER_ID = 'aa11aa11-bb22-cc33-dd44-ee55ee55ee55';

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8' },
	});
}

/** Every write must run inside a token scope — the persona wrapper's job in production. */
function scoped<T>(fn: () => Promise<T>): Promise<T> {
	return withAzureDevOpsToken('pat-abc', fn);
}

/** `[method, path]` for each recorded call, so an assertion reads as the request sequence. */
function requestSequence(fetchMock: FetchMock): Array<[string, string]> {
	return fetchMock.mock.calls.map((call) => [
		String((call[1] as RequestInit | undefined)?.method),
		new URL(String(call[0])).pathname,
	]);
}

function requestBody(fetchMock: FetchMock, call = 0): unknown {
	return JSON.parse(String((fetchMock.mock.calls[call]?.[1] as RequestInit | undefined)?.body));
}

/** A thread listing holding `threads`, each `[threadId, comments]`. */
function threadListing(
	threads: Array<[id: number, comments: Array<{ content: string; commentType?: string }>]>,
): unknown {
	return {
		count: threads.length,
		value: threads.map(([id, comments]) => ({
			id,
			comments: comments.map((comment, index) => ({
				id: index + 1,
				commentType: 'text',
				...comment,
			})),
		})),
	};
}

describe('azure devops pull-request writes', () => {
	let fetchMock: FetchMock;

	beforeEach(() => {
		fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal('fetch', fetchMock);
	});

	describe('postAzureDevOpsPullRequestThread', () => {
		it('posts the content verbatim as a new active thread and returns the thread id', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ id: 88, comments: [{ id: 1 }] }));

			await expect(scoped(() => postAzureDevOpsPullRequestThread(REPO, 17, 'hello'))).resolves.toBe(
				88,
			);
			expect(requestSequence(fetchMock)).toEqual([['POST', `${PR_PATH}/threads`]]);
			expect(requestBody(fetchMock)).toEqual({
				comments: [{ parentCommentId: 0, content: 'hello', commentType: 1 }],
				status: 'active',
			});
		});

		it('throws when Azure answers without a thread id', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ comments: [] }));

			await expect(scoped(() => postAzureDevOpsPullRequestThread(REPO, 17, 'x'))).rejects.toThrow(
				/returned no thread id/,
			);
		});
	});

	describe('postIdempotentAzureDevOpsPullRequestThread', () => {
		const post = () =>
			scoped(() =>
				postIdempotentAzureDevOpsPullRequestThread(REPO, {
					pullRequestId: 17,
					body: 'summary',
					deliveryId: DELIVERY_ID,
				}),
			);

		it('posts the body with the delivery marker when no thread carries it yet', async () => {
			fetchMock
				.mockResolvedValueOnce(jsonResponse(threadListing([[5, [{ content: 'a human' }]]])))
				.mockResolvedValueOnce(jsonResponse({ id: 6 }));

			await expect(post()).resolves.toBe(6);
			expect(requestSequence(fetchMock)).toEqual([
				['GET', `${PR_PATH}/threads`],
				['POST', `${PR_PATH}/threads`],
			]);
			expect(requestBody(fetchMock, 1)).toMatchObject({
				comments: [{ content: `summary\n\n${MARKER}` }],
			});
		});

		it('returns the earlier thread on a retry instead of posting again', async () => {
			fetchMock.mockResolvedValueOnce(
				jsonResponse(threadListing([[9, [{ content: `summary\n\n${MARKER}` }]]])),
			);

			await expect(post()).resolves.toBe(9);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		it('ignores a system comment quoting the marker', async () => {
			fetchMock
				.mockResolvedValueOnce(
					jsonResponse(
						threadListing([[3, [{ content: `edited: ${MARKER}`, commentType: 'system' }]]]),
					),
				)
				.mockResolvedValueOnce(jsonResponse({ id: 4 }));

			await expect(post()).resolves.toBe(4);
			expect(requestSequence(fetchMock)[1]).toEqual(['POST', `${PR_PATH}/threads`]);
		});
	});

	describe('submitAzureDevOpsReview', () => {
		const submit = (verdict: 'approve' | 'request-changes') =>
			scoped(() =>
				submitAzureDevOpsReview(REPO, {
					pullRequestId: 17,
					verdict,
					body: 'findings',
					deliveryId: DELIVERY_ID,
					reviewerId: REVIEWER_ID,
				}),
			);

		it.each([
			['approve', 10],
			['request-changes', -5],
		] as const)('casts %s as vote %s, then posts the findings thread last', async (verdict, vote) => {
			fetchMock
				.mockResolvedValueOnce(jsonResponse(threadListing([])))
				.mockResolvedValueOnce(jsonResponse({ id: REVIEWER_ID, vote }))
				.mockResolvedValueOnce(jsonResponse({ id: 21 }));

			await expect(submit(verdict)).resolves.toBe(21);
			expect(requestSequence(fetchMock)).toEqual([
				['GET', `${PR_PATH}/threads`],
				['PUT', `${PR_PATH}/reviewers/${REVIEWER_ID}`],
				['POST', `${PR_PATH}/threads`],
			]);
			expect(requestBody(fetchMock, 1)).toEqual({ vote });
		});

		it('marks only a request-changes findings thread for ingress', async () => {
			fetchMock
				.mockResolvedValueOnce(jsonResponse(threadListing([])))
				.mockResolvedValueOnce(jsonResponse({}))
				.mockResolvedValueOnce(jsonResponse({ id: 21 }));
			await submit('request-changes');
			expect(requestBody(fetchMock, 2)).toMatchObject({
				comments: [
					{
						content: `findings\n\n${MARKER}\n${azureDevOpsRequestChangesMarker(DELIVERY_ID)}`,
					},
				],
			});

			fetchMock.mockReset();
			fetchMock
				.mockResolvedValueOnce(jsonResponse(threadListing([])))
				.mockResolvedValueOnce(jsonResponse({}))
				.mockResolvedValueOnce(jsonResponse({ id: 22 }));
			await submit('approve');
			expect(requestBody(fetchMock, 2)).toMatchObject({
				comments: [{ content: `findings\n\n${MARKER}` }],
			});
		});

		it('neither re-votes nor re-posts once the findings thread exists', async () => {
			fetchMock.mockResolvedValueOnce(
				jsonResponse(threadListing([[30, [{ content: `findings\n\n${MARKER}` }]]])),
			);

			await expect(submit('approve')).resolves.toBe(30);
			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		// The window the vote-first ordering leaves open: the vote landed, the thread did
		// not. No marker exists, so the retry re-casts the (idempotent) vote and posts.
		it('re-casts the vote and posts the thread on a retry after only the vote landed', async () => {
			fetchMock
				.mockResolvedValueOnce(jsonResponse(threadListing([])))
				.mockResolvedValueOnce(jsonResponse({}))
				.mockResolvedValueOnce(jsonResponse({ message: 'boom' }, 500));
			await expect(submit('approve')).rejects.toBeInstanceOf(AzureDevOpsApiError);

			fetchMock.mockReset();
			fetchMock
				.mockResolvedValueOnce(jsonResponse(threadListing([])))
				.mockResolvedValueOnce(jsonResponse({}))
				.mockResolvedValueOnce(jsonResponse({ id: 40 }));
			await expect(submit('approve')).resolves.toBe(40);
			expect(requestSequence(fetchMock).map(([method]) => method)).toEqual(['GET', 'PUT', 'POST']);
		});
	});

	describe('createAzureDevOpsPullRequest', () => {
		it('opens the pull request between the two branch refs and returns its web URL', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse(createMockAzureDevOpsPullRequestResponse({ pullRequestId: 23 })),
			);

			await expect(
				scoped(() =>
					createAzureDevOpsPullRequest(REPO, {
						baseBranch: 'main',
						branch: 'swarm/issue-23',
						title: 'Add a thing',
						body: 'summary',
					}),
				),
			).resolves.toEqual({
				number: 23,
				url: 'https://dev.azure.com/Fabrikam/Fiber%20Team/_git/Web/pullrequest/23',
			});
			expect(requestSequence(fetchMock)).toEqual([
				['POST', '/Fabrikam/Fiber%20Team/_apis/git/repositories/Web/pullrequests'],
			]);
			expect(requestBody(fetchMock)).toEqual({
				sourceRefName: 'refs/heads/swarm/issue-23',
				targetRefName: 'refs/heads/main',
				title: 'Add a thing',
				description: 'summary',
			});
		});

		it('truncates a description past Azure’s limit rather than failing the delivery', async () => {
			fetchMock.mockResolvedValue(jsonResponse(createMockAzureDevOpsPullRequestResponse()));

			await scoped(() =>
				createAzureDevOpsPullRequest(REPO, {
					baseBranch: 'main',
					branch: 'b',
					title: 't',
					body: 'x'.repeat(MAX_PULL_REQUEST_DESCRIPTION_CHARS + 500),
				}),
			);

			const { description } = requestBody(fetchMock) as { description: string };
			expect(description).toHaveLength(MAX_PULL_REQUEST_DESCRIPTION_CHARS);
			expect(description).toMatch(/truncated/);
		});
	});

	describe('completeAzureDevOpsPullRequest', () => {
		it('completes pinned to the approved head, keeping the branch and every policy', async () => {
			fetchMock.mockResolvedValue(jsonResponse(createMockAzureDevOpsPullRequestResponse()));

			await scoped(() => completeAzureDevOpsPullRequest(REPO, 17, HEAD_SHA));

			expect(requestSequence(fetchMock)).toEqual([['PATCH', PR_PATH]]);
			expect(requestBody(fetchMock)).toEqual({
				status: 'completed',
				lastMergeSourceCommit: { commitId: HEAD_SHA },
				completionOptions: { deleteSourceBranch: false, bypassPolicy: false },
			});
		});

		it('propagates a refusal with its status for the adapter to classify', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ message: 'stale', typeKey: 'X' }, 409));

			await expect(
				scoped(() => completeAzureDevOpsPullRequest(REPO, 17, HEAD_SHA)),
			).rejects.toMatchObject({ status: 409 });
		});
	});
});
