import { describe, expect, it } from 'vitest';

import {
	isSwarmGeneratedGitLabEvent,
	parseGitLabWebhook,
	readGitLabWebhookRequest,
	verifyGitLabWebhookToken,
} from '@/integrations/scm/gitlab/webhook.js';
import { SWARM_GENERATED_FOOTER, swarmMarker } from '@/scm/swarm-origin.js';
import {
	createMockGitLabMergeRequestPayload,
	createMockGitLabNotePayload,
	createMockGitLabPipelinePayload,
	createMockProjectConfig,
} from '../../../../helpers/factories.js';

const project = createMockProjectConfig({ id: 'proj-1', repo: 'jkwiecien/swarm' });

/** The full 40-character SHA every factory reports — GitLab never abbreviates. */
const FULL_SHA = 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7';
const MERGE_REQUEST_URL = 'https://gitlab.com/jkwiecien/swarm/-/merge_requests/17';

/** A reviewer entry as it appears in the top-level `reviewers[]` array. */
function reviewer(id: number, username: string, state: string): Record<string, unknown> {
	return { id, name: username, username, state };
}

describe('GitLab webhook ingress', () => {
	// Every delivery under test here is one SWARM acts on, so parseGitLabWebhook
	// never returns null — narrow it once so the assertions don't repeat `!`.
	function parse(eventName: string, payload: unknown) {
		const event = parseGitLabWebhook(eventName, payload);
		if (!event) throw new Error(`expected ${eventName} to parse`);
		return event;
	}

	describe('parseGitLabWebhook — events SWARM does not act on', () => {
		it('returns null for an event name outside the processable set', () => {
			expect(parseGitLabWebhook('Push Hook', {})).toBeNull();
			expect(parseGitLabWebhook('Tag Push Hook', {})).toBeNull();
			expect(parseGitLabWebhook('Wiki Page Hook', {})).toBeNull();
		});

		it('returns null for GitLab Issues hooks, which are out of scope', () => {
			expect(parseGitLabWebhook('Issue Hook', { object_kind: 'issue' })).toBeNull();
		});

		it('returns null for an unknown event name', () => {
			expect(parseGitLabWebhook('unknown', createMockGitLabMergeRequestPayload())).toBeNull();
		});

		it('returns null when the body’s object_kind contradicts the header', () => {
			expect(
				parseGitLabWebhook(
					'Merge Request Hook',
					createMockGitLabMergeRequestPayload({ objectKind: 'note' }),
				),
			).toBeNull();
		});

		it('returns null for a merge-request action SWARM has no mapping for', () => {
			expect(
				parseGitLabWebhook(
					'Merge Request Hook',
					createMockGitLabMergeRequestPayload({ objectAttributes: { action: 'some_new_action' } }),
				),
			).toBeNull();
		});

		it('returns null for a merge-request hook carrying no action at all', () => {
			expect(
				parseGitLabWebhook('Merge Request Hook', {
					object_kind: 'merge_request',
					object_attributes: { iid: 17 },
				}),
			).toBeNull();
		});

		it('returns null for a note on anything but a merge request', () => {
			expect(
				parseGitLabWebhook(
					'Note Hook',
					createMockGitLabNotePayload({
						objectAttributes: { noteable_type: 'Issue' },
						mergeRequest: null,
					}),
				),
			).toBeNull();
		});

		it('returns null for a system note, which narrates activity rather than being input', () => {
			expect(
				parseGitLabWebhook(
					'Note Hook',
					createMockGitLabNotePayload({
						objectAttributes: { system: true, note: 'approved this merge request' },
					}),
				),
			).toBeNull();
		});
	});

	describe('parseGitLabWebhook — merge-request lifecycle', () => {
		it('parses an opened merge request into the whole neutral event', () => {
			expect(parse('Merge Request Hook', createMockGitLabMergeRequestPayload())).toEqual({
				kind: 'pull-request',
				action: 'opened',
				repoFullName: 'jkwiecien/swarm',
				workItemId: '17',
				workItemUrl: MERGE_REQUEST_URL,
				actorLogin: 'human-dev',
				isCommentEvent: false,
				commentBody: undefined,
				headSha: FULL_SHA,
				prBranch: 'swarm/issue-17',
				baseBranch: 'main',
				isCrossRepo: false,
				isDraft: false,
				merged: false,
			});
		});

		it('collapses reopen onto opened', () => {
			const parsed = parse(
				'Merge Request Hook',
				createMockGitLabMergeRequestPayload({
					objectAttributes: { action: 'reopen', state: 'opened' },
				}),
			);
			expect(parsed).toMatchObject({ kind: 'pull-request', action: 'opened', merged: false });
		});

		it('parses update as an updated merge request', () => {
			const parsed = parse(
				'Merge Request Hook',
				createMockGitLabMergeRequestPayload({ objectAttributes: { action: 'update' } }),
			);
			expect(parsed).toMatchObject({ kind: 'pull-request', action: 'updated', merged: false });
		});

		it('parses close as closed but not merged', () => {
			const parsed = parse(
				'Merge Request Hook',
				createMockGitLabMergeRequestPayload({
					objectAttributes: { action: 'close', state: 'closed' },
				}),
			);
			expect(parsed).toMatchObject({ action: 'closed', merged: false });
		});

		it('parses merge as closed and merged', () => {
			const parsed = parse(
				'Merge Request Hook',
				createMockGitLabMergeRequestPayload({
					objectAttributes: { action: 'merge', state: 'merged' },
				}),
			);
			expect(parsed).toMatchObject({ action: 'closed', merged: true });
		});

		it('reads merged off the state when the payload carries a merged state under another action', () => {
			const parsed = parse(
				'Merge Request Hook',
				createMockGitLabMergeRequestPayload({
					objectAttributes: { action: 'update', state: 'merged' },
				}),
			);
			expect(parsed.merged).toBe(true);
		});

		it('marks a fork merge request as cross-repo', () => {
			const parsed = parse(
				'Merge Request Hook',
				createMockGitLabMergeRequestPayload({
					objectAttributes: { source_project_id: 77, target_project_id: 42 },
				}),
			);
			expect(parsed.isCrossRepo).toBe(true);
		});

		it('leaves isCrossRepo undefined when a project id is missing from the payload', () => {
			const parsed = parse('Merge Request Hook', {
				object_kind: 'merge_request',
				project: { path_with_namespace: 'jkwiecien/swarm' },
				object_attributes: { iid: 17, action: 'open', target_project_id: 42 },
			});
			expect(parsed.isCrossRepo).toBeUndefined();
		});

		it('reads a draft from GitLab’s current draft field', () => {
			const parsed = parse(
				'Merge Request Hook',
				createMockGitLabMergeRequestPayload({ objectAttributes: { draft: true } }),
			);
			expect(parsed.isDraft).toBe(true);
		});

		it('falls back to the deprecated work_in_progress spelling', () => {
			// Built raw rather than through the factory, whose defaults include `draft`.
			const parsed = parse('Merge Request Hook', {
				object_kind: 'merge_request',
				project: { path_with_namespace: 'jkwiecien/swarm' },
				object_attributes: { iid: 17, action: 'open', work_in_progress: true },
			});
			expect(parsed.isDraft).toBe(true);
		});

		it('leaves isDraft undefined when the payload carries neither spelling', () => {
			const parsed = parse('Merge Request Hook', {
				object_kind: 'merge_request',
				project: { path_with_namespace: 'jkwiecien/swarm' },
				object_attributes: { iid: 17, action: 'open' },
			});
			expect(parsed.isDraft).toBeUndefined();
		});

		it('leaves prAuthorLogin unset — GitLab names the author only by numeric id', () => {
			expect(
				parse('Merge Request Hook', createMockGitLabMergeRequestPayload()).prAuthorLogin,
			).toBeUndefined();
		});

		it('falls back to "unknown" when the payload has no project', () => {
			const parsed = parse('Merge Request Hook', {
				object_kind: 'merge_request',
				object_attributes: { iid: 17, action: 'open' },
			});
			expect(parsed.repoFullName).toBe('unknown');
		});
	});

	describe('parseGitLabWebhook — review verdicts', () => {
		const swarmRev = { id: 9, name: 'swarm-rev', username: 'swarm-rev' };

		function verdictPayload(action: string, extra: Record<string, unknown> = {}) {
			return createMockGitLabMergeRequestPayload({
				user: swarmRev,
				objectAttributes: { action },
				...extra,
			});
		}

		it('parses an approval into the whole neutral review event', () => {
			expect(parse('Merge Request Hook', verdictPayload('approved'))).toEqual({
				kind: 'pull-request-review',
				action: 'submitted',
				repoFullName: 'jkwiecien/swarm',
				workItemId: '17',
				workItemUrl: MERGE_REQUEST_URL,
				actorLogin: 'swarm-rev',
				isCommentEvent: false,
				commentBody: undefined,
				headSha: FULL_SHA,
				prBranch: 'swarm/issue-17',
				reviewState: 'approved',
				reviewId: `17:approved:9:${FULL_SHA}`,
			});
		});

		it('maps GitLab’s per-user approval spelling the same way as the threshold one', () => {
			expect(parse('Merge Request Hook', verdictPayload('approval'))).toMatchObject({
				kind: 'pull-request-review',
				action: 'submitted',
				reviewState: 'approved',
			});
		});

		it('maps both withdrawal spellings to dismissed, so neither re-triggers Respond-to-review', () => {
			for (const action of ['unapproved', 'unapproval']) {
				expect(parse('Merge Request Hook', verdictPayload(action))).toMatchObject({
					kind: 'pull-request-review',
					action: 'dismissed',
					reviewState: 'dismissed',
				});
			}
		});

		it('derives changes-requested from the acting reviewer’s own standing state', () => {
			// GitLab has no "request changes" action — the verdict arrives as an `update`
			// whose acting user now stands at `requested_changes` in `reviewers[]`.
			const parsed = parse(
				'Merge Request Hook',
				verdictPayload('update', {
					reviewers: [reviewer(9, 'swarm-rev', 'requested_changes')],
				}),
			);
			expect(parsed).toMatchObject({
				kind: 'pull-request-review',
				action: 'submitted',
				reviewState: 'changes-requested',
				reviewId: `17:changes-requested:9:${FULL_SHA}`,
			});
		});

		it('stays a plain update when the acting reviewer has not requested changes', () => {
			const parsed = parse(
				'Merge Request Hook',
				verdictPayload('update', { reviewers: [reviewer(9, 'swarm-rev', 'unreviewed')] }),
			);
			expect(parsed).toMatchObject({ kind: 'pull-request', action: 'updated' });
			expect(parsed.reviewState).toBeUndefined();
		});

		it('does not re-emit a standing verdict when somebody else triggers the update', () => {
			// The implementer's push is an `update` too. Keying on the *acting* user is
			// what stops the reviewer's standing verdict from being cast again on it.
			const parsed = parse(
				'Merge Request Hook',
				createMockGitLabMergeRequestPayload({
					objectAttributes: { action: 'update' },
					reviewers: [reviewer(9, 'swarm-rev', 'requested_changes')],
				}),
			);
			expect(parsed).toMatchObject({ kind: 'pull-request', action: 'updated' });
		});
	});

	describe('parseGitLabWebhook — merge-request notes', () => {
		it('parses a merge-request note into the whole neutral comment event', () => {
			expect(parse('Note Hook', createMockGitLabNotePayload())).toEqual({
				kind: 'work-item-comment',
				action: 'created',
				repoFullName: 'jkwiecien/swarm',
				workItemId: '17',
				workItemUrl: MERGE_REQUEST_URL,
				actorLogin: 'human-dev',
				isCommentEvent: true,
				// Carried for loop prevention only (`isSwarmGeneratedGitLabEvent`).
				commentBody: 'can you rebase this?',
				headSha: FULL_SHA,
				prBranch: 'swarm/issue-17',
			});
		});

		it('leaves commentBody undefined for a non-comment event', () => {
			expect(
				parse('Merge Request Hook', createMockGitLabMergeRequestPayload()).commentBody,
			).toBeUndefined();
		});
	});

	describe('parseGitLabWebhook — pipelines', () => {
		function pipeline(status: string, mergeRequest?: null) {
			return parse(
				'Pipeline Hook',
				createMockGitLabPipelinePayload({
					objectAttributes: { status },
					...(mergeRequest === null ? { mergeRequest: null } : {}),
				}),
			);
		}

		it('parses a successful pipeline into the whole neutral checks event', () => {
			expect(parse('Pipeline Hook', createMockGitLabPipelinePayload())).toEqual({
				kind: 'checks',
				action: 'completed',
				repoFullName: 'jkwiecien/swarm',
				workItemId: '17',
				workItemUrl: MERGE_REQUEST_URL,
				actorLogin: 'ci-bot',
				isCommentEvent: false,
				commentBody: undefined,
				headSha: FULL_SHA,
				prBranch: 'swarm/issue-17',
				checkConclusion: 'success',
			});
		});

		it('normalizes every terminal status onto the neutral conclusion vocabulary', () => {
			expect(pipeline('success').checkConclusion).toBe('success');
			expect(pipeline('failed').checkConclusion).toBe('failure');
			expect(pipeline('canceled').checkConclusion).toBe('cancelled');
			expect(pipeline('skipped').checkConclusion).toBe('skipped');
		});

		it('reports every terminal status as completed', () => {
			for (const status of ['success', 'failed', 'canceled', 'skipped']) {
				expect(pipeline(status).action).toBe('completed');
			}
		});

		it('does not report a still-running pipeline as completed', () => {
			// `kind === 'checks' && action === 'completed'` is the Review handler's gate,
			// so a running pipeline must normalize and enqueue while matching no trigger.
			expect(pipeline('running')).toMatchObject({ action: 'updated', checkConclusion: 'running' });
			expect(pipeline('pending').action).toBe('updated');
		});

		it('treats an unrecognized status as non-terminal and passes it through verbatim', () => {
			const parsed = pipeline('some_new_status');
			expect(parsed.action).toBe('updated');
			expect(parsed.checkConclusion).toBe('some_new_status');
		});

		it('leaves the merge-request association unset for a branch pipeline', () => {
			// A branch pipeline carries no `merge_request`; resolving it needs phase 3/4's
			// credential-scoped commit→merge-request lookup, not this pure parse.
			const parsed = pipeline('success', null);
			expect(parsed.workItemId).toBeUndefined();
			expect(parsed.workItemUrl).toBeUndefined();
			expect(parsed.prBranch).toBeUndefined();
			// The commit is still named, which is what the lookup keys on.
			expect(parsed.headSha).toBe(FULL_SHA);
		});
	});

	describe('full-SHA invariant', () => {
		it('reports the same unabbreviated commit from a merge-request and a pipeline hook', () => {
			const mergeRequest = parse('Merge Request Hook', createMockGitLabMergeRequestPayload());
			const pipeline = parse('Pipeline Hook', createMockGitLabPipelinePayload());
			expect(mergeRequest.headSha).toHaveLength(40);
			expect(pipeline.headSha).toBe(mergeRequest.headSha);
		});
	});

	describe('synthesized review id', () => {
		function reviewIdFor(overrides: Parameters<typeof createMockGitLabMergeRequestPayload>[0]) {
			return parse(
				'Merge Request Hook',
				createMockGitLabMergeRequestPayload({
					user: { id: 9, username: 'swarm-rev' },
					...overrides,
					objectAttributes: { action: 'approved', ...overrides?.objectAttributes },
				}),
			).reviewId;
		}

		it('is identical across two deliveries of the same verdict on the same head', () => {
			expect(reviewIdFor({})).toBe(reviewIdFor({}));
		});

		it('differs across merge requests', () => {
			expect(reviewIdFor({ objectAttributes: { iid: 17 } })).not.toBe(
				reviewIdFor({ objectAttributes: { iid: 18 } }),
			);
		});

		it('differs across verdict states on the same merge request', () => {
			expect(reviewIdFor({ objectAttributes: { action: 'approved' } })).not.toBe(
				reviewIdFor({ objectAttributes: { action: 'unapproved' } }),
			);
		});

		it('differs across the accounts that cast the verdict', () => {
			expect(reviewIdFor({})).not.toBe(reviewIdFor({ user: { id: 10, username: 'other-rev' } }));
		});

		it('differs across head commits, so a re-review of a new push is a new verdict', () => {
			expect(reviewIdFor({})).not.toBe(
				reviewIdFor({
					objectAttributes: { last_commit: { id: 'f'.repeat(40) } },
				}),
			);
		});

		it('survives a username change, keying on the numeric account id instead', () => {
			expect(reviewIdFor({ user: { id: 9, username: 'old-name' } })).toBe(
				reviewIdFor({ user: { id: 9, username: 'new-name' } }),
			);
		});

		it('still produces an id when the payload names no account or commit', () => {
			const parsed = parse('Merge Request Hook', {
				object_kind: 'merge_request',
				project: { path_with_namespace: 'jkwiecien/swarm' },
				object_attributes: { iid: 17, action: 'approved' },
			});
			expect(parsed.reviewId).toBe('17:approved:unknown:unknown');
		});
	});

	describe('isSwarmGeneratedGitLabEvent (loop prevention)', () => {
		function commentEvent(body: string | undefined) {
			return parse('Note Hook', createMockGitLabNotePayload({ objectAttributes: { note: body } }));
		}

		it('drops a comment carrying a hidden SWARM delivery marker', async () => {
			const event = commentEvent(`Ready.\n\n${swarmMarker('delivery', 'abc123')}`);
			await expect(isSwarmGeneratedGitLabEvent(event, project)).resolves.toBe(true);
		});

		it('drops a comment carrying the generated-by-SWARM footer', async () => {
			const event = commentEvent(`Findings…\n\n${SWARM_GENERATED_FOOTER}`);
			await expect(isSwarmGeneratedGitLabEvent(event, project)).resolves.toBe(true);
		});

		it('does NOT drop a plain human comment', async () => {
			await expect(
				isSwarmGeneratedGitLabEvent(commentEvent('can you rebase this?'), project),
			).resolves.toBe(false);
		});

		it('does not drop a comment event whose body is absent', async () => {
			await expect(isSwarmGeneratedGitLabEvent(commentEvent(undefined), project)).resolves.toBe(
				false,
			);
		});

		it('never drops a non-comment event, even one SWARM produced', async () => {
			const event = parse('Merge Request Hook', createMockGitLabMergeRequestPayload());
			await expect(isSwarmGeneratedGitLabEvent(event, project)).resolves.toBe(false);
		});
	});

	describe('readGitLabWebhookRequest', () => {
		it('reads GitLab’s event, event-UUID and token headers', () => {
			const headers: Record<string, string> = {
				'x-gitlab-event': 'Merge Request Hook',
				'x-gitlab-event-uuid': 'a3f1-delivery',
				'x-gitlab-token': 'sh4red-t0ken',
				// The hook's own id, deliberately NOT used as the delivery identity.
				'x-gitlab-webhook-uuid': 'hook-1',
			};
			expect(readGitLabWebhookRequest((name) => headers[name.toLowerCase()])).toEqual({
				eventName: 'Merge Request Hook',
				deliveryId: 'a3f1-delivery',
				signature: 'sh4red-t0ken',
			});
		});

		it('falls back to an unknown event name and an empty token', () => {
			expect(readGitLabWebhookRequest(() => undefined)).toEqual({
				eventName: 'unknown',
				signature: '',
			});
		});

		it('omits deliveryId entirely when the event-UUID header is absent', () => {
			const headers: Record<string, string> = { 'x-gitlab-event': 'Pipeline Hook' };
			const request = readGitLabWebhookRequest((name) => headers[name.toLowerCase()]);
			expect(Object.hasOwn(request, 'deliveryId')).toBe(false);
		});
	});

	describe('verifyGitLabWebhookToken', () => {
		const secret = 'sh4red-s3cret';
		const rawBody = JSON.stringify(createMockGitLabMergeRequestPayload());

		it('accepts the exact configured token', () => {
			expect(verifyGitLabWebhookToken(rawBody, secret, secret)).toBe(true);
		});

		it('rejects a different token of the same length', () => {
			const wrong = `${secret.slice(0, -1)}${secret.endsWith('t') ? 'x' : 't'}`;
			expect(wrong).toHaveLength(secret.length);
			expect(verifyGitLabWebhookToken(rawBody, wrong, secret)).toBe(false);
		});

		it('rejects a token of a different length', () => {
			expect(verifyGitLabWebhookToken(rawBody, `${secret}extra`, secret)).toBe(false);
			expect(verifyGitLabWebhookToken(rawBody, secret.slice(0, -1), secret)).toBe(false);
		});

		it('rejects an absent token, so a secret-less hook fails closed', () => {
			expect(verifyGitLabWebhookToken(rawBody, '', secret)).toBe(false);
		});

		it('cannot be passed with an empty configured secret', () => {
			expect(verifyGitLabWebhookToken(rawBody, '', '')).toBe(false);
			expect(verifyGitLabWebhookToken(rawBody, 'anything', '')).toBe(false);
		});

		it('authenticates the sender, not the body — GitLab signs nothing', () => {
			// Documents the difference from GitHub's and Bitbucket's HMAC, and why the
			// GitLab 19.0 signing-token upgrade is worth a follow-up (see the module header).
			const tampered = rawBody.replace('"iid":17', '"iid":99');
			expect(tampered).not.toBe(rawBody);
			expect(verifyGitLabWebhookToken(tampered, secret, secret)).toBe(true);
		});
	});
});
