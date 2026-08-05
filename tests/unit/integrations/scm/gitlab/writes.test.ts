import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitLabApiError, withGitLabToken } from '@/integrations/scm/gitlab/client.js';
import {
	createGitLabMergeRequest,
	mergeGitLabMergeRequestDirect,
	postGitLabMergeRequestNote,
	postIdempotentGitLabMergeRequestNote,
	submitGitLabReview,
} from '@/integrations/scm/gitlab/writes.js';
import { deliveryMarker } from '@/scm/swarm-origin.js';

import {
	createMockGitLabMergeRequestResponse,
	createMockGitLabNoteResponse,
} from '../../../../helpers/factories.js';

/** A `fetch` stand-in typed with the real signature so `mock.calls` indexes. */
type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

const REPO = 'jkwiecien/swarm';
const MR_PATH = '/api/v4/projects/jkwiecien%2Fswarm/merge_requests/17';
const HEAD_SHA = 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7';
const DELIVERY_ID = 'delivery-abc';
const MARKER = deliveryMarker(DELIVERY_ID);

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

/** Every write must run inside a token scope — the persona wrapper's job in production. */
function scoped<T>(fn: () => Promise<T>): Promise<T> {
	return withGitLabToken('token-abc', fn);
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

describe('gitlab merge-request writes', () => {
	let fetchMock: FetchMock;

	beforeEach(() => {
		fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal('fetch', fetchMock);
	});

	describe('postGitLabMergeRequestNote', () => {
		it('posts the body verbatim as GitLab’s note body', async () => {
			fetchMock.mockResolvedValue(jsonResponse(createMockGitLabNoteResponse({ id: 991 })));

			await expect(scoped(() => postGitLabMergeRequestNote(REPO, 17, 'stalled'))).resolves.toBe(
				991,
			);
			expect(requestSequence(fetchMock)).toEqual([['POST', `${MR_PATH}/notes`]]);
			expect(requestBody(fetchMock)).toEqual({ body: 'stalled' });
		});

		it('throws rather than reporting a note id GitLab never returned', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ body: 'stalled' }));

			await expect(scoped(() => postGitLabMergeRequestNote(REPO, 17, 'stalled'))).rejects.toThrow(
				/returned no note id/,
			);
		});
	});

	describe('postIdempotentGitLabMergeRequestNote', () => {
		it('appends the delivery marker to the posted body', async () => {
			fetchMock
				.mockResolvedValueOnce(jsonResponse([]))
				.mockResolvedValueOnce(jsonResponse(createMockGitLabNoteResponse({ id: 42 })));

			await expect(
				scoped(() =>
					postIdempotentGitLabMergeRequestNote(REPO, {
						iid: 17,
						body: 'CI is red',
						deliveryId: DELIVERY_ID,
					}),
				),
			).resolves.toBe(42);
			expect(requestBody(fetchMock, 1)).toEqual({ body: `CI is red\n\n${MARKER}` });
		});

		it('returns the earlier attempt’s note without posting a second one', async () => {
			fetchMock.mockResolvedValueOnce(
				jsonResponse([
					createMockGitLabNoteResponse({ id: 1, body: 'unrelated' }),
					createMockGitLabNoteResponse({ id: 7, body: `CI is red\n\n${MARKER}` }),
				]),
			);

			await expect(
				scoped(() =>
					postIdempotentGitLabMergeRequestNote(REPO, {
						iid: 17,
						body: 'CI is red',
						deliveryId: DELIVERY_ID,
					}),
				),
			).resolves.toBe(7);
			expect(requestSequence(fetchMock)).toEqual([['GET', `${MR_PATH}/notes`]]);
		});

		// A system note quoting the marker is GitLab's own activity entry, not this
		// delivery's write — treating it as one would leave the real body unposted.
		it('ignores a system note carrying the marker, so the retry actually posts', async () => {
			fetchMock
				.mockResolvedValueOnce(
					jsonResponse([
						createMockGitLabNoteResponse({
							id: 7,
							system: true,
							body: `commented: CI is red\n\n${MARKER}`,
						}),
					]),
				)
				.mockResolvedValueOnce(jsonResponse(createMockGitLabNoteResponse({ id: 8 })));

			await expect(
				scoped(() =>
					postIdempotentGitLabMergeRequestNote(REPO, {
						iid: 17,
						body: 'CI is red',
						deliveryId: DELIVERY_ID,
					}),
				),
			).resolves.toBe(8);
		});

		it('scans every page of notes for the marker', async () => {
			fetchMock
				.mockResolvedValueOnce(
					new Response(JSON.stringify([createMockGitLabNoteResponse({ id: 1, body: 'first' })]), {
						status: 200,
						headers: { 'content-type': 'application/json', 'x-next-page': '2' },
					}),
				)
				.mockResolvedValueOnce(
					jsonResponse([createMockGitLabNoteResponse({ id: 9, body: MARKER })]),
				);

			await expect(
				scoped(() =>
					postIdempotentGitLabMergeRequestNote(REPO, {
						iid: 17,
						body: 'CI is red',
						deliveryId: DELIVERY_ID,
					}),
				),
			).resolves.toBe(9);
			expect(fetchMock).toHaveBeenCalledTimes(2);
		});
	});

	describe('submitGitLabReview', () => {
		function submit(verdict: 'approve' | 'request-changes') {
			return scoped(() =>
				submitGitLabReview(REPO, {
					iid: 17,
					verdict,
					body: 'LGTM',
					deliveryId: DELIVERY_ID,
					headSha: HEAD_SHA,
				}),
			);
		}

		it('approves against the reviewed head, then anchors the verdict with the marker note', async () => {
			fetchMock
				.mockResolvedValueOnce(jsonResponse([]))
				.mockResolvedValueOnce(jsonResponse(createMockGitLabMergeRequestResponse()))
				.mockResolvedValueOnce(jsonResponse(createMockGitLabNoteResponse({ id: 55 })));

			// The note id is the neutral review id — GitLab has no review object.
			await expect(submit('approve')).resolves.toBe(55);
			// Verdict before note: the marker is the retry anchor, so it is written last.
			expect(requestSequence(fetchMock)).toEqual([
				['GET', `${MR_PATH}/notes`],
				['POST', `${MR_PATH}/approve`],
				['POST', `${MR_PATH}/notes`],
			]);
			// `sha` is what makes GitLab refuse an approval against a moved head.
			expect(requestBody(fetchMock, 1)).toEqual({ sha: HEAD_SHA });
			expect(requestBody(fetchMock, 2)).toEqual({ body: `LGTM\n\n${MARKER}` });
		});

		// GitLab exposes no REST endpoint for a reviewer's `requested_changes` state, so
		// clearing the standing approval is what the verdict amounts to.
		it('clears a standing approval for request-changes, then posts the findings note', async () => {
			fetchMock
				.mockResolvedValueOnce(jsonResponse([]))
				.mockResolvedValueOnce(jsonResponse(createMockGitLabMergeRequestResponse()))
				.mockResolvedValueOnce(jsonResponse(createMockGitLabNoteResponse({ id: 56 })));

			await expect(submit('request-changes')).resolves.toBe(56);
			expect(requestSequence(fetchMock)).toEqual([
				['GET', `${MR_PATH}/notes`],
				['POST', `${MR_PATH}/unapprove`],
				['POST', `${MR_PATH}/notes`],
			]);
		});

		it('short-circuits on an existing marker — no re-vote, no second note', async () => {
			fetchMock.mockResolvedValueOnce(
				jsonResponse([createMockGitLabNoteResponse({ id: 55, body: `LGTM\n\n${MARKER}` })]),
			);

			await expect(submit('approve')).resolves.toBe(55);
			expect(requestSequence(fetchMock)).toEqual([['GET', `${MR_PATH}/notes`]]);
		});

		// GitLab refuses a redundant verdict rather than absorbing it, and that is exactly
		// the state a retry re-enters after the verdict landed and the note POST did not.
		it('posts the note anyway when GitLab reports the account already approved', async () => {
			fetchMock
				.mockResolvedValueOnce(jsonResponse([]))
				.mockResolvedValueOnce(jsonResponse({ message: '401 Unauthorized' }, 401))
				.mockResolvedValueOnce(jsonResponse(createMockGitLabNoteResponse({ id: 57 })));

			await expect(submit('approve')).resolves.toBe(57);
			expect(requestSequence(fetchMock)).toEqual([
				['GET', `${MR_PATH}/notes`],
				['POST', `${MR_PATH}/approve`],
				['POST', `${MR_PATH}/notes`],
			]);
		});

		it('posts the note anyway when there is no standing approval to withdraw', async () => {
			fetchMock
				.mockResolvedValueOnce(jsonResponse([]))
				.mockResolvedValueOnce(jsonResponse({ message: '404 Not found' }, 404))
				.mockResolvedValueOnce(jsonResponse(createMockGitLabNoteResponse({ id: 58 })));

			await expect(submit('request-changes')).resolves.toBe(58);
			expect(requestSequence(fetchMock).filter(([method]) => method === 'POST')).toEqual([
				['POST', `${MR_PATH}/unapprove`],
				['POST', `${MR_PATH}/notes`],
			]);
		});

		it('leaves no marker behind when the head moved under the approval, so a retry re-applies it', async () => {
			fetchMock
				.mockResolvedValueOnce(jsonResponse([]))
				.mockResolvedValueOnce(
					jsonResponse({ message: 'SHA does not match HEAD of source branch' }, 409),
				);

			await expect(submit('approve')).rejects.toBeInstanceOf(GitLabApiError);
			expect(requestSequence(fetchMock).filter(([method]) => method === 'POST')).toEqual([
				['POST', `${MR_PATH}/approve`],
			]);
		});
	});

	describe('createGitLabMergeRequest', () => {
		it('opens the merge request with GitLab’s source/target shape', async () => {
			fetchMock.mockResolvedValue(jsonResponse(createMockGitLabMergeRequestResponse({ iid: 21 })));

			await expect(
				scoped(() =>
					createGitLabMergeRequest(REPO, {
						baseBranch: 'main',
						branch: 'issue-485',
						title: 'feat: a thing',
						body: 'Closes #485',
					}),
				),
			).resolves.toEqual({
				number: 21,
				url: 'https://gitlab.com/jkwiecien/swarm/-/merge_requests/17',
			});
			expect(requestSequence(fetchMock)).toEqual([
				['POST', '/api/v4/projects/jkwiecien%2Fswarm/merge_requests'],
			]);
			expect(requestBody(fetchMock)).toEqual({
				source_branch: 'issue-485',
				target_branch: 'main',
				title: 'feat: a thing',
				description: 'Closes #485',
			});
		});

		it('derives the web URL when GitLab’s response carries none', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ iid: 21 }));

			await expect(
				scoped(() =>
					createGitLabMergeRequest(REPO, {
						baseBranch: 'main',
						branch: 'issue-485',
						title: 't',
						body: 'b',
					}),
				),
			).resolves.toEqual({
				number: 21,
				url: 'https://gitlab.com/jkwiecien/swarm/-/merge_requests/21',
			});
		});
	});

	describe('mergeGitLabMergeRequestDirect', () => {
		it('pins the merge to the approved head and leaves the source branch alone', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({
					state: 'merged',
					merge_commit_sha: 'abcdef0123456789abcdef0123456789abcdef01',
				}),
			);

			await expect(
				scoped(() => mergeGitLabMergeRequestDirect(REPO, 17, HEAD_SHA)),
			).resolves.toEqual({
				merged: true,
				message: 'merge request merged',
				sha: 'abcdef0123456789abcdef0123456789abcdef01',
			});
			expect(requestSequence(fetchMock)).toEqual([['PUT', `${MR_PATH}/merge`]]);
			// No merge method, no squash flag, no commit message: the project's own
			// configured defaults win.
			expect(requestBody(fetchMock)).toEqual({
				sha: HEAD_SHA,
				should_remove_source_branch: false,
			});
		});

		it('reports the squash commit when the project squashes', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({
					state: 'merged',
					merge_commit_sha: null,
					squash_commit_sha: 'fedcba9876543210fedcba9876543210fedcba98',
				}),
			);

			await expect(
				scoped(() => mergeGitLabMergeRequestDirect(REPO, 17, HEAD_SHA)),
			).resolves.toMatchObject({ sha: 'fedcba9876543210fedcba9876543210fedcba98' });
		});

		it('reports merged: false when a 200 leaves the merge request open', async () => {
			fetchMock.mockResolvedValue(jsonResponse({ state: 'opened' }));

			await expect(
				scoped(() => mergeGitLabMergeRequestDirect(REPO, 17, HEAD_SHA)),
			).resolves.toMatchObject({ merged: false, message: expect.stringContaining('opened') });
		});

		it('lets a refusal propagate as a GitLabApiError for the adapter to classify', async () => {
			fetchMock.mockResolvedValue(
				jsonResponse({ message: '405 Method Not Allowed: Branch cannot be merged' }, 405),
			);

			const thrown = await scoped(() =>
				mergeGitLabMergeRequestDirect(REPO, 17, HEAD_SHA).catch((err: unknown) => err),
			);

			expect(thrown).toBeInstanceOf(GitLabApiError);
			expect((thrown as GitLabApiError).status).toBe(405);
		});
	});

	it('refuses to write outside a token scope', async () => {
		await expect(postGitLabMergeRequestNote(REPO, 17, 'x')).rejects.toThrow(
			/No GitLab token in scope/,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
