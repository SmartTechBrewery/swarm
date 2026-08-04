import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
	isSwarmGeneratedBitbucketEvent,
	parseBitbucketWebhook,
	readBitbucketWebhookRequest,
	verifyBitbucketSignature,
} from '@/integrations/scm/bitbucket/webhook.js';
import { SWARM_GENERATED_FOOTER, swarmMarker } from '@/scm/swarm-origin.js';
import {
	createMockBitbucketApprovalPayload,
	createMockBitbucketCommitStatusPayload,
	createMockBitbucketPullRequestPayload,
	createMockProjectConfig,
} from '../../../../helpers/factories.js';

const project = createMockProjectConfig({ id: 'proj-1', repo: 'jkwiecien/swarm' });

/** The full 40-char SHA the commit-status factory's `links.commit.href` ends in. */
const FULL_SHA = 'd3022fc0ca3d65c7f6654eea129d6bf0cf0ee08e';
/** The 12-char abbreviated hash a pull-request payload carries for the same commit. */
const ABBREVIATED_SHA = 'd3022fc0ca3d';

describe('Bitbucket webhook ingress', () => {
	// Every event key under test is processable, so parseBitbucketWebhook never
	// returns null here — narrow it once so the assertions don't repeat `!`.
	function parse(eventKey: string, payload: unknown) {
		const event = parseBitbucketWebhook(eventKey, payload);
		if (!event) throw new Error(`expected ${eventKey} to parse`);
		return event;
	}

	describe('parseBitbucketWebhook', () => {
		it('returns null for an event key SWARM does not act on', () => {
			expect(
				parseBitbucketWebhook('repo:push', createMockBitbucketPullRequestPayload()),
			).toBeNull();
		});

		it('returns null for Bitbucket Issues events, which are out of scope', () => {
			expect(parseBitbucketWebhook('issue:created', {})).toBeNull();
			expect(parseBitbucketWebhook('issue:comment_created', {})).toBeNull();
		});

		it('parses pullrequest:created as an opened pull request', () => {
			expect(parse('pullrequest:created', createMockBitbucketPullRequestPayload())).toEqual({
				kind: 'pull-request',
				action: 'opened',
				repoFullName: 'jkwiecien/swarm',
				workItemId: '17',
				workItemUrl: 'https://bitbucket.org/jkwiecien/swarm/pull-requests/17',
				actorLogin: 'human-dev',
				isCommentEvent: false,
				commentBody: undefined,
				headSha: ABBREVIATED_SHA,
				prBranch: 'swarm/issue-17',
				baseBranch: 'main',
				isCrossRepo: false,
				isDraft: false,
				prAuthorLogin: 'human-dev',
				merged: false,
			});
		});

		it('parses pullrequest:updated as an updated pull request', () => {
			const parsed = parse('pullrequest:updated', createMockBitbucketPullRequestPayload());
			expect(parsed.kind).toBe('pull-request');
			expect(parsed.action).toBe('updated');
			expect(parsed.merged).toBe(false);
		});

		it('parses pullrequest:fulfilled as closed and merged', () => {
			const parsed = parse(
				'pullrequest:fulfilled',
				createMockBitbucketPullRequestPayload({ pullrequest: { id: 17, state: 'MERGED' } }),
			);
			expect(parsed.action).toBe('closed');
			expect(parsed.merged).toBe(true);
		});

		it('parses pullrequest:rejected as closed but not merged', () => {
			const parsed = parse(
				'pullrequest:rejected',
				createMockBitbucketPullRequestPayload({ pullrequest: { id: 17, state: 'DECLINED' } }),
			);
			expect(parsed.action).toBe('closed');
			expect(parsed.merged).toBe(false);
		});

		it('marks a fork pull request as cross-repo', () => {
			const parsed = parse(
				'pullrequest:created',
				createMockBitbucketPullRequestPayload({
					pullrequest: {
						id: 17,
						source: {
							branch: { name: 'patch-1' },
							commit: { hash: 'aaaaaaaaaaaa' },
							repository: { full_name: 'a-fork/swarm' },
						},
						destination: {
							branch: { name: 'main' },
							repository: { full_name: 'jkwiecien/swarm' },
						},
					},
				}),
			);
			expect(parsed.isCrossRepo).toBe(true);
		});

		it('leaves isCrossRepo undefined when a repo is missing from the payload', () => {
			const parsed = parse(
				'pullrequest:created',
				createMockBitbucketPullRequestPayload({
					pullrequest: {
						id: 17,
						source: { branch: { name: 'patch-1' }, commit: { hash: 'aaaaaaaaaaaa' } },
						destination: { branch: { name: 'main' }, repository: { full_name: 'jkwiecien/swarm' } },
					},
				}),
			);
			expect(parsed.isCrossRepo).toBeUndefined();
		});

		it('leaves isDraft undefined when the payload omits the flag', () => {
			// Built raw rather than through the factory, whose defaults include `draft`.
			const parsed = parse('pullrequest:created', {
				repository: { full_name: 'jkwiecien/swarm' },
				pullrequest: { id: 17 },
			});
			expect(parsed.isDraft).toBeUndefined();
		});

		it('carries a draft pull request through as a draft', () => {
			const parsed = parse(
				'pullrequest:created',
				createMockBitbucketPullRequestPayload({ pullrequest: { id: 17, draft: true } }),
			);
			expect(parsed.isDraft).toBe(true);
		});

		it('falls back to "unknown" when the payload has no repository', () => {
			expect(parse('pullrequest:created', { pullrequest: { id: 17 } }).repoFullName).toBe(
				'unknown',
			);
		});

		it('parses pullrequest:approved as a submitted approval', () => {
			const parsed = parse('pullrequest:approved', createMockBitbucketApprovalPayload());
			expect(parsed.kind).toBe('pull-request-review');
			expect(parsed.action).toBe('submitted');
			expect(parsed.reviewState).toBe('approved');
			expect(parsed.actorLogin).toBe('swarm-rev');
			expect(parsed.headSha).toBe(ABBREVIATED_SHA);
			expect(parsed.prBranch).toBe('swarm/issue-17');
		});

		it('parses pullrequest:changes_request_created as the neutral changes-requested verdict', () => {
			const parsed = parse(
				'pullrequest:changes_request_created',
				createMockBitbucketApprovalPayload({ verdictKey: 'changes_request' }),
			);
			expect(parsed.kind).toBe('pull-request-review');
			expect(parsed.reviewState).toBe('changes-requested');
		});

		it('maps both verdict removals to dismissed, so neither re-triggers Respond-to-review', () => {
			expect(
				parse('pullrequest:unapproved', createMockBitbucketApprovalPayload()).reviewState,
			).toBe('dismissed');
			expect(
				parse(
					'pullrequest:changes_request_removed',
					createMockBitbucketApprovalPayload({ verdictKey: 'changes_request' }),
				).reviewState,
			).toBe('dismissed');
		});

		it("prefers the verdict user's login over the event actor", () => {
			const parsed = parse(
				'pullrequest:approved',
				createMockBitbucketApprovalPayload({
					actor: { nickname: 'an-app-acting-for-them' },
					user: { nickname: 'swarm-rev', uuid: '{uuid-swarm-rev}' },
				}),
			);
			expect(parsed.actorLogin).toBe('swarm-rev');
		});

		it('falls back to the event actor when the verdict carries no user', () => {
			const payload = {
				...createMockBitbucketPullRequestPayload({ actor: { nickname: 'swarm-rev' } }),
				approval: { date: '2026-08-04T10:00:00.000000+00:00' },
			};
			expect(parse('pullrequest:approved', payload).actorLogin).toBe('swarm-rev');
		});

		it('parses pullrequest:comment_created and flags it as a comment event', () => {
			const payload = {
				...createMockBitbucketPullRequestPayload({ actor: { nickname: 'swarm-rev' } }),
				comment: { id: 42, content: { raw: 'looks good', html: '<p>looks good</p>' } },
			};
			const parsed = parse('pullrequest:comment_created', payload);
			expect(parsed.kind).toBe('work-item-comment');
			expect(parsed.action).toBe('created');
			expect(parsed.isCommentEvent).toBe(true);
			expect(parsed.workItemId).toBe('17');
			expect(parsed.actorLogin).toBe('swarm-rev');
			// Carried for loop prevention only (`isSwarmGeneratedBitbucketEvent`).
			expect(parsed.commentBody).toBe('looks good');
		});

		it('leaves commentBody undefined for a non-comment event that carries a comment', () => {
			const payload = {
				...createMockBitbucketPullRequestPayload(),
				comment: { id: 42, content: { raw: 'looks good' } },
			};
			expect(parse('pullrequest:created', payload).commentBody).toBeUndefined();
		});

		it('parses a successful commit status as a completed check', () => {
			const parsed = parse('repo:commit_status_updated', createMockBitbucketCommitStatusPayload());
			expect(parsed.kind).toBe('checks');
			expect(parsed.action).toBe('completed');
			expect(parsed.checkConclusion).toBe('success');
			expect(parsed.headSha).toBe(FULL_SHA);
		});

		it('leaves the PR association unset on a commit status, which Bitbucket does not send', () => {
			const parsed = parse('repo:commit_status_updated', createMockBitbucketCommitStatusPayload());
			expect(parsed.workItemId).toBeUndefined();
			expect(parsed.prBranch).toBeUndefined();
			expect(parsed.workItemUrl).toBeUndefined();
		});

		it('normalizes every commit-status state onto the neutral conclusion vocabulary', () => {
			const conclusionFor = (state: string) =>
				parse(
					'repo:commit_status_updated',
					createMockBitbucketCommitStatusPayload({ commitStatus: { state } }),
				).checkConclusion;

			expect(conclusionFor('SUCCESSFUL')).toBe('success');
			expect(conclusionFor('FAILED')).toBe('failure');
			expect(conclusionFor('INPROGRESS')).toBe('pending');
			expect(conclusionFor('STOPPED')).toBe('cancelled');
		});

		it('passes an unrecognized commit-status state through verbatim', () => {
			const parsed = parse(
				'repo:commit_status_updated',
				createMockBitbucketCommitStatusPayload({ commitStatus: { state: 'SOMETHING_NEW' } }),
			);
			expect(parsed.checkConclusion).toBe('SOMETHING_NEW');
		});

		it('does not report a still-running commit status as completed', () => {
			// `kind === 'checks' && action === 'completed'` is the Review handler's gate, so
			// an INPROGRESS status must normalize and enqueue while matching no trigger.
			const parsed = parse(
				'repo:commit_status_created',
				createMockBitbucketCommitStatusPayload({ commitStatus: { state: 'INPROGRESS' } }),
			);
			expect(parsed.action).toBe('created');
			const updated = parse(
				'repo:commit_status_updated',
				createMockBitbucketCommitStatusPayload({ commitStatus: { state: 'INPROGRESS' } }),
			);
			expect(updated.action).toBe('updated');
		});

		it('prefers an explicit commit hash over parsing the commit link', () => {
			const parsed = parse(
				'repo:commit_status_created',
				createMockBitbucketCommitStatusPayload({
					commitStatus: { state: 'FAILED', commit: { hash: 'abc123abc123' } },
				}),
			);
			expect(parsed.headSha).toBe('abc123abc123');
		});

		it('leaves headSha undefined when a commit status names no commit at all', () => {
			const parsed = parse(
				'repo:commit_status_created',
				createMockBitbucketCommitStatusPayload({ commitStatus: { state: 'FAILED', links: {} } }),
			);
			expect(parsed.headSha).toBeUndefined();
		});
	});

	describe('abbreviated-hash invariant', () => {
		it("carries a PR payload's 12-character hash verbatim, without padding or truncation", () => {
			const parsed = parse('pullrequest:created', createMockBitbucketPullRequestPayload());
			expect(parsed.headSha).toBe(ABBREVIATED_SHA);
			expect(parsed.headSha).toHaveLength(12);
		});

		it('yields a full-length SHA for the same commit on a commit-status event', () => {
			const parsed = parse('repo:commit_status_updated', createMockBitbucketCommitStatusPayload());
			expect(parsed.headSha).toHaveLength(40);
			// The two spellings of one commit are prefix-related, never equal — which is
			// why a SHA comparison inside this provider must be prefix-tolerant.
			expect(FULL_SHA.startsWith(ABBREVIATED_SHA)).toBe(true);
			expect(parsed.headSha).not.toBe(ABBREVIATED_SHA);
		});
	});

	describe('synthesized review id', () => {
		function reviewIdFor(eventKey: string, payload: unknown) {
			return parse(eventKey, payload).reviewId;
		}

		it('is identical across two deliveries of the same verdict', () => {
			expect(reviewIdFor('pullrequest:approved', createMockBitbucketApprovalPayload())).toBe(
				reviewIdFor('pullrequest:approved', createMockBitbucketApprovalPayload()),
			);
		});

		it('differs across pull requests', () => {
			expect(
				reviewIdFor(
					'pullrequest:approved',
					createMockBitbucketApprovalPayload({ pullrequest: { id: 17 } }),
				),
			).not.toBe(
				reviewIdFor(
					'pullrequest:approved',
					createMockBitbucketApprovalPayload({ pullrequest: { id: 18 } }),
				),
			);
		});

		it('differs across verdict states on the same pull request', () => {
			expect(reviewIdFor('pullrequest:approved', createMockBitbucketApprovalPayload())).not.toBe(
				reviewIdFor(
					'pullrequest:changes_request_created',
					createMockBitbucketApprovalPayload({ verdictKey: 'changes_request' }),
				),
			);
		});

		it('differs across the accounts that cast the verdict', () => {
			expect(reviewIdFor('pullrequest:approved', createMockBitbucketApprovalPayload())).not.toBe(
				reviewIdFor(
					'pullrequest:approved',
					createMockBitbucketApprovalPayload({
						user: { nickname: 'other-rev', uuid: '{uuid-other-rev}' },
					}),
				),
			);
		});

		it('differs across head commits, so a re-review of a new push is a new verdict', () => {
			expect(reviewIdFor('pullrequest:approved', createMockBitbucketApprovalPayload())).not.toBe(
				reviewIdFor(
					'pullrequest:approved',
					createMockBitbucketApprovalPayload({
						pullrequest: {
							id: 17,
							source: {
								branch: { name: 'swarm/issue-17' },
								commit: { hash: 'ffffffffffff' },
								repository: { full_name: 'jkwiecien/swarm' },
							},
							destination: {
								branch: { name: 'main' },
								repository: { full_name: 'jkwiecien/swarm' },
							},
						},
					}),
				),
			);
		});

		it('survives a nickname change, keying on the account uuid instead', () => {
			const before = reviewIdFor(
				'pullrequest:approved',
				createMockBitbucketApprovalPayload({
					user: { nickname: 'old-name', uuid: '{uuid-stable}' },
				}),
			);
			const after = reviewIdFor(
				'pullrequest:approved',
				createMockBitbucketApprovalPayload({
					user: { nickname: 'new-name', uuid: '{uuid-stable}' },
				}),
			);
			expect(after).toBe(before);
		});

		it('still produces an id when the payload names no account or commit', () => {
			const payload = {
				repository: { full_name: 'jkwiecien/swarm' },
				pullrequest: { id: 17 },
				approval: { date: '2026-08-04T10:00:00.000000+00:00' },
			};
			expect(reviewIdFor('pullrequest:approved', payload)).toBe('17:approved:unknown:unknown');
		});
	});

	describe('isSwarmGeneratedBitbucketEvent (loop prevention)', () => {
		function commentEvent(body: string | undefined) {
			const payload = {
				...createMockBitbucketPullRequestPayload(),
				comment: { id: 1, content: body === undefined ? {} : { raw: body } },
			};
			return parse('pullrequest:comment_created', payload);
		}

		it('drops a comment carrying a hidden SWARM delivery marker', async () => {
			const event = commentEvent(`Ready.\n\n${swarmMarker('delivery', 'abc123')}`);
			await expect(isSwarmGeneratedBitbucketEvent(event, project)).resolves.toBe(true);
		});

		it('drops a comment carrying the generated-by-SWARM footer', async () => {
			const event = commentEvent(`Findings…\n\n${SWARM_GENERATED_FOOTER}`);
			await expect(isSwarmGeneratedBitbucketEvent(event, project)).resolves.toBe(true);
		});

		it('does NOT drop a plain human comment', async () => {
			await expect(
				isSwarmGeneratedBitbucketEvent(commentEvent('can you rebase this?'), project),
			).resolves.toBe(false);
		});

		it('does not drop a comment event whose body is absent', async () => {
			await expect(isSwarmGeneratedBitbucketEvent(commentEvent(undefined), project)).resolves.toBe(
				false,
			);
		});

		it('never drops a non-comment event, even one SWARM produced', async () => {
			const event = parse('pullrequest:created', createMockBitbucketPullRequestPayload());
			await expect(isSwarmGeneratedBitbucketEvent(event, project)).resolves.toBe(false);
		});
	});

	describe('readBitbucketWebhookRequest', () => {
		it("reads Bitbucket's event-key, request-uuid and signature headers", () => {
			const headers: Record<string, string> = {
				'x-event-key': 'pullrequest:created',
				'x-request-uuid': 'a3f1-req',
				'x-hub-signature': 'sha256=deadbeef',
				// The hook's own id, deliberately NOT used as the delivery identity.
				'x-hook-uuid': 'hook-1',
			};
			expect(readBitbucketWebhookRequest((name) => headers[name.toLowerCase()])).toEqual({
				eventName: 'pullrequest:created',
				deliveryId: 'a3f1-req',
				signature: 'sha256=deadbeef',
			});
		});

		it('falls back to an unknown event name and an empty signature', () => {
			expect(readBitbucketWebhookRequest(() => undefined)).toEqual({
				eventName: 'unknown',
				signature: '',
			});
		});
	});

	describe('verifyBitbucketSignature', () => {
		const secret = 'sh4red-s3cret';
		const rawBody = JSON.stringify(createMockBitbucketPullRequestPayload());
		const sign = (body: string, key: string) =>
			`sha256=${createHmac('sha256', key).update(body, 'utf8').digest('hex')}`;
		const valid = sign(rawBody, secret);

		it('accepts a correctly signed body', () => {
			expect(verifyBitbucketSignature(rawBody, valid, secret)).toBe(true);
		});

		it('rejects a signature computed with the wrong secret', () => {
			expect(verifyBitbucketSignature(rawBody, sign(rawBody, 'wrong-secret'), secret)).toBe(false);
		});

		it('rejects a body that changed after signing', () => {
			const tampered = rawBody.replace('"id":17', '"id":99');
			expect(tampered).not.toBe(rawBody);
			expect(verifyBitbucketSignature(tampered, valid, secret)).toBe(false);
		});

		it('rejects an absent signature, so an unsigned hook fails closed', () => {
			expect(verifyBitbucketSignature(rawBody, '', secret)).toBe(false);
		});

		it('rejects a signature missing the `sha256=` prefix', () => {
			expect(verifyBitbucketSignature(rawBody, valid.replace('sha256=', ''), secret)).toBe(false);
		});

		it('rejects a signature framed with the wrong algorithm prefix', () => {
			expect(verifyBitbucketSignature(rawBody, valid.replace('sha256=', 'sha1='), secret)).toBe(
				false,
			);
		});

		it('rejects a signature of the wrong length', () => {
			expect(verifyBitbucketSignature(rawBody, `${valid}00`, secret)).toBe(false);
		});

		it('rejects a same-length signature with one flipped hex digit', () => {
			const flipped = `${valid.slice(0, -1)}${valid.endsWith('0') ? '1' : '0'}`;
			expect(verifyBitbucketSignature(rawBody, flipped, secret)).toBe(false);
		});
	});
});
