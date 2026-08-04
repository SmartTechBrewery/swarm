import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	BITBUCKET_API_BASE,
	BitbucketApiError,
	withBitbucketCredential,
} from '@/integrations/scm/bitbucket/client.js';
import {
	createBitbucketPullRequest,
	mergeBitbucketPullRequestDirect,
	postBitbucketPullRequestComment,
	postIdempotentBitbucketPullRequestComment,
	submitBitbucketReview,
} from '@/integrations/scm/bitbucket/writes.js';
import { deliveryMarker } from '@/scm/swarm-origin.js';

import {
	createMockBitbucketCommentResponse,
	createMockBitbucketPullRequestResponse,
} from '../../../../helpers/factories.js';

/** A `fetch` stand-in typed with the real signature so `mock.calls` indexes. */
type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

const WORKSPACE = 'jkwiecien';
const SLUG = 'swarm';
const REPO_PATH = `${BITBUCKET_API_BASE}/repositories/${WORKSPACE}/${SLUG}`;
const PR_PATH = `${REPO_PATH}/pullrequests/17`;
const DELIVERY_ID = 'delivery-abc';
const MARKER = deliveryMarker(DELIVERY_ID);

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

/** Every write must run inside a credential scope — the persona wrapper's job in production. */
function scoped<T>(fn: () => Promise<T>): Promise<T> {
	return withBitbucketCredential('token-abc', fn);
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

describe('bitbucket pull-request writes', () => {
	let fetchMock: FetchMock;

	beforeEach(() => {
		fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal('fetch', fetchMock);
	});

	describe('postBitbucketPullRequestComment', () => {
		it('posts the body verbatim as Bitbucket’s raw content', async () => {
			fetchMock.mockResolvedValue(jsonResponse(createMockBitbucketCommentResponse({ id: 991 })));

			await expect(
				scoped(() => postBitbucketPullRequestComment(WORKSPACE, SLUG, 17, 'stalled')),
			).resolves.toBe(991);
			expect(requestSequence(fetchMock)).toEqual([
				['POST', '/2.0/repositories/jkwiecien/swarm/pullrequests/17/comments'],
			]);
			expect(requestBody(fetchMock)).toEqual({ content: { raw: 'stalled' } });
		});

		it('throws rather than reporting a comment id Bitbucket never returned', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ content: { raw: 'stalled' } }));

			await expect(
				scoped(() => postBitbucketPullRequestComment(WORKSPACE, SLUG, 17, 'stalled')),
			).rejects.toThrow(/returned no comment id/);
		});
	});

	describe('postIdempotentBitbucketPullRequestComment', () => {
		it('appends the delivery marker to the posted body', async () => {
			fetchMock
				.mockResolvedValueOnce(jsonResponse({ values: [] }))
				.mockResolvedValueOnce(jsonResponse(createMockBitbucketCommentResponse({ id: 42 })));

			await expect(
				scoped(() =>
					postIdempotentBitbucketPullRequestComment(WORKSPACE, SLUG, {
						prNumber: 17,
						body: 'CI is red',
						deliveryId: DELIVERY_ID,
					}),
				),
			).resolves.toBe(42);
			expect(requestBody(fetchMock, 1)).toEqual({ content: { raw: `CI is red\n\n${MARKER}` } });
		});

		it('returns the earlier attempt’s comment without posting a second one', async () => {
			fetchMock.mockResolvedValueOnce(
				jsonResponse({
					values: [
						createMockBitbucketCommentResponse({ id: 1, content: { raw: 'unrelated' } }),
						createMockBitbucketCommentResponse({
							id: 7,
							content: { raw: `CI is red\n\n${MARKER}` },
						}),
					],
				}),
			);

			await expect(
				scoped(() =>
					postIdempotentBitbucketPullRequestComment(WORKSPACE, SLUG, {
						prNumber: 17,
						body: 'CI is red',
						deliveryId: DELIVERY_ID,
					}),
				),
			).resolves.toBe(7);
			expect(requestSequence(fetchMock)).toEqual([
				['GET', '/2.0/repositories/jkwiecien/swarm/pullrequests/17/comments'],
			]);
		});

		it('ignores a deleted marker comment, so the retry actually posts', async () => {
			fetchMock
				.mockResolvedValueOnce(
					jsonResponse({
						values: [
							createMockBitbucketCommentResponse({
								id: 7,
								deleted: true,
								content: { raw: `CI is red\n\n${MARKER}` },
							}),
						],
					}),
				)
				.mockResolvedValueOnce(jsonResponse(createMockBitbucketCommentResponse({ id: 8 })));

			await expect(
				scoped(() =>
					postIdempotentBitbucketPullRequestComment(WORKSPACE, SLUG, {
						prNumber: 17,
						body: 'CI is red',
						deliveryId: DELIVERY_ID,
					}),
				),
			).resolves.toBe(8);
		});

		it('scans every page of comments for the marker', async () => {
			fetchMock
				.mockResolvedValueOnce(
					jsonResponse({
						values: [createMockBitbucketCommentResponse({ id: 1, content: { raw: 'first' } })],
						next: `${PR_PATH}/comments?page=2`,
					}),
				)
				.mockResolvedValueOnce(
					jsonResponse({
						values: [createMockBitbucketCommentResponse({ id: 9, content: { raw: MARKER } })],
					}),
				);

			await expect(
				scoped(() =>
					postIdempotentBitbucketPullRequestComment(WORKSPACE, SLUG, {
						prNumber: 17,
						body: 'CI is red',
						deliveryId: DELIVERY_ID,
					}),
				),
			).resolves.toBe(9);
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});
	});

	describe('submitBitbucketReview', () => {
		const verdicts = [
			['approve', 'approve'],
			['request-changes', 'request-changes'],
		] as const;

		for (const [verdict, endpoint] of verdicts) {
			it(`records ${verdict} through the ${endpoint} endpoint, then anchors it with the marker comment`, async () => {
				fetchMock
					.mockResolvedValueOnce(jsonResponse({ values: [] }))
					.mockResolvedValueOnce(jsonResponse({ state: verdict }))
					.mockResolvedValueOnce(jsonResponse(createMockBitbucketCommentResponse({ id: 55 })));

				// The comment id is the neutral review id — Bitbucket has no review object.
				await expect(
					scoped(() =>
						submitBitbucketReview(WORKSPACE, SLUG, {
							prNumber: 17,
							verdict,
							body: 'LGTM',
							deliveryId: DELIVERY_ID,
						}),
					),
				).resolves.toBe(55);
				// Verdict before comment: the marker is the retry anchor, so it is written last.
				expect(requestSequence(fetchMock)).toEqual([
					['GET', '/2.0/repositories/jkwiecien/swarm/pullrequests/17/comments'],
					['POST', `/2.0/repositories/jkwiecien/swarm/pullrequests/17/${endpoint}`],
					['POST', '/2.0/repositories/jkwiecien/swarm/pullrequests/17/comments'],
				]);
				expect(requestBody(fetchMock, 2)).toEqual({ content: { raw: `LGTM\n\n${MARKER}` } });
			});
		}

		it('short-circuits on an existing marker — no re-vote, no second comment', async () => {
			fetchMock.mockResolvedValueOnce(
				jsonResponse({
					values: [
						createMockBitbucketCommentResponse({ id: 55, content: { raw: `LGTM\n\n${MARKER}` } }),
					],
				}),
			);

			await expect(
				scoped(() =>
					submitBitbucketReview(WORKSPACE, SLUG, {
						prNumber: 17,
						verdict: 'approve',
						body: 'LGTM',
						deliveryId: DELIVERY_ID,
					}),
				),
			).resolves.toBe(55);
			expect(requestSequence(fetchMock)).toEqual([
				['GET', '/2.0/repositories/jkwiecien/swarm/pullrequests/17/comments'],
			]);
		});

		it('leaves no marker behind when the verdict itself fails, so a retry re-applies it', async () => {
			fetchMock
				.mockResolvedValueOnce(jsonResponse({ values: [] }))
				.mockResolvedValueOnce(jsonResponse({ error: { message: 'nope' } }, 401));

			await expect(
				scoped(() =>
					submitBitbucketReview(WORKSPACE, SLUG, {
						prNumber: 17,
						verdict: 'approve',
						body: 'LGTM',
						deliveryId: DELIVERY_ID,
					}),
				),
			).rejects.toBeInstanceOf(BitbucketApiError);
			expect(requestSequence(fetchMock).filter(([method]) => method === 'POST')).toEqual([
				['POST', '/2.0/repositories/jkwiecien/swarm/pullrequests/17/approve'],
			]);
		});
	});

	describe('createBitbucketPullRequest', () => {
		it('opens the pull request with Bitbucket’s source/destination shape', async () => {
			fetchMock.mockResolvedValue(jsonResponse(createMockBitbucketPullRequestResponse({ id: 21 })));

			await expect(
				scoped(() =>
					createBitbucketPullRequest(WORKSPACE, SLUG, {
						baseBranch: 'main',
						branch: 'issue-457',
						title: 'feat: a thing',
						body: 'Closes #457',
					}),
				),
			).resolves.toEqual({
				number: 21,
				url: 'https://bitbucket.org/jkwiecien/swarm/pull-requests/17',
			});
			expect(requestSequence(fetchMock)).toEqual([
				['POST', '/2.0/repositories/jkwiecien/swarm/pullrequests'],
			]);
			expect(requestBody(fetchMock)).toEqual({
				title: 'feat: a thing',
				description: 'Closes #457',
				source: { branch: { name: 'issue-457' } },
				destination: { branch: { name: 'main' } },
			});
		});

		it('derives the web URL when Bitbucket’s response carries no html link', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ id: 21 }));

			await expect(
				scoped(() =>
					createBitbucketPullRequest(WORKSPACE, SLUG, {
						baseBranch: 'main',
						branch: 'issue-457',
						title: 't',
						body: 'b',
					}),
				),
			).resolves.toEqual({
				number: 21,
				url: 'https://bitbucket.org/jkwiecien/swarm/pull-requests/21',
			});
		});
	});

	describe('mergeBitbucketPullRequestDirect', () => {
		it('merges without naming a strategy and without closing the source branch', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({
					state: 'MERGED',
					merge_commit: { hash: 'abcdef0123456789abcdef0123456789abcdef01' },
				}),
			);

			await expect(
				scoped(() =>
					mergeBitbucketPullRequestDirect(WORKSPACE, SLUG, 17, 'Merge pull request #17'),
				),
			).resolves.toEqual({
				merged: true,
				message: 'pull request merged',
				sha: 'abcdef012345',
			});
			expect(requestSequence(fetchMock)).toEqual([
				['POST', '/2.0/repositories/jkwiecien/swarm/pullrequests/17/merge'],
			]);
			expect(requestBody(fetchMock)).toEqual({
				message: 'Merge pull request #17',
				close_source_branch: false,
			});
		});

		it('reports merged: false when a 200 leaves the pull request open', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ state: 'OPEN' }));

			await expect(
				scoped(() => mergeBitbucketPullRequestDirect(WORKSPACE, SLUG, 17, 'msg')),
			).resolves.toMatchObject({ merged: false });
		});

		it('lets a refusal propagate as a BitbucketApiError for the adapter to classify', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({ error: { message: 'There are merge conflicts' } }, 409),
			);

			const thrown = await scoped(() =>
				mergeBitbucketPullRequestDirect(WORKSPACE, SLUG, 17, 'msg').catch((err: unknown) => err),
			);

			expect(thrown).toBeInstanceOf(BitbucketApiError);
			expect((thrown as BitbucketApiError).status).toBe(409);
		});
	});

	it('refuses to write outside a credential scope', async () => {
		await expect(postBitbucketPullRequestComment(WORKSPACE, SLUG, 17, 'x')).rejects.toThrow(
			/No Bitbucket credential in scope/,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
