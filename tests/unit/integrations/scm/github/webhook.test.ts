import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
	isSwarmGeneratedGitHubEvent,
	parseGitHubWebhook,
	readGitHubWebhookRequest,
	verifyGitHubSignature,
} from '@/integrations/scm/github/webhook.js';
import type { ScmPersonaIdentities } from '@/scm/types.js';
import { createMockProjectConfig } from '../../../../helpers/factories.js';

const IDENTITIES: ScmPersonaIdentities = { implementer: 'swarm-impl', reviewer: 'swarm-rev' };
const project = createMockProjectConfig({ id: 'proj-1', repo: 'SmartTechBrewery/swarm' });

function repo() {
	return { full_name: 'SmartTechBrewery/swarm' };
}

describe('GitHub webhook ingress', () => {
	// The event types under test are all processable, so parseGitHubWebhook never
	// returns null here — narrow it once so the assertions don't repeat `!`.
	function parse(eventType: string, payload: unknown) {
		const event = parseGitHubWebhook(eventType, payload);
		if (!event) throw new Error(`expected ${eventType} to parse`);
		return event;
	}

	describe('parseGitHubWebhook', () => {
		it('returns null for an event type SWARM does not act on', () => {
			expect(parseGitHubWebhook('projects_v2_item', { repository: repo() })).toBeNull();
		});

		it('parses a pull_request event', () => {
			const parsed = parseGitHubWebhook('pull_request', {
				action: 'opened',
				repository: repo(),
				pull_request: { number: 42 },
				sender: { login: 'a-human' },
			});
			expect(parsed).toEqual({
				kind: 'pull-request',
				action: 'opened',
				repoFullName: 'SmartTechBrewery/swarm',
				workItemId: '42',
				actorLogin: 'a-human',
				isCommentEvent: false,
			});
		});

		it('parses an issue_comment event and flags it as a comment event', () => {
			const parsed = parseGitHubWebhook('issue_comment', {
				action: 'created',
				repository: repo(),
				issue: { number: 7 },
				comment: { id: 1, body: 'looks good' },
				sender: { login: 'swarm-rev' },
			});
			expect(parsed?.workItemId).toBe('7');
			expect(parsed?.isCommentEvent).toBe(true);
			expect(parsed?.actorLogin).toBe('swarm-rev');
			// Carried for loop prevention only (`isSwarmGeneratedGitHubEvent`).
			expect(parsed?.commentBody).toBe('looks good');
		});

		it('leaves commentBody undefined for a non-comment event that carries a body', () => {
			const parsed = parseGitHubWebhook('pull_request', {
				action: 'opened',
				repository: repo(),
				pull_request: { number: 42, body: 'Closes #7' },
				sender: { login: 'a-human' },
			});
			expect(parsed?.commentBody).toBeUndefined();
		});

		// The normalizer maps `issues` to a `work-item` event and carries these fields
		// because the durable envelope is provider-neutral, not because a handler reads
		// them: no trigger consumes `work-item` since issue #737, and the repository
		// webhook does not subscribe to `issues` in the first place.
		it('parses an issue body edit', () => {
			const parsed = parseGitHubWebhook('issues', {
				action: 'edited',
				repository: repo(),
				issue: {
					number: 7,
					html_url: 'https://github.com/SmartTechBrewery/swarm/issues/7',
				},
				changes: { body: { from: 'old scope' } },
				sender: { login: 'a-human' },
			});
			expect(parsed).toMatchObject({
				kind: 'work-item',
				action: 'edited',
				workItemId: '7',
				workItemUrl: 'https://github.com/SmartTechBrewery/swarm/issues/7',
				workItemBodyChanged: true,
				isCommentEvent: false,
			});
		});

		it('parses the label changed by an issues event', () => {
			const parsed = parseGitHubWebhook('issues', {
				action: 'labeled',
				repository: repo(),
				issue: { number: 7 },
				label: { name: 'needs-triage' },
			});
			expect(parsed).toMatchObject({
				kind: 'work-item',
				labelName: 'needs-triage',
				workItemBodyChanged: false,
			});
		});

		it('extracts the PR number from a check_suite event', () => {
			const parsed = parseGitHubWebhook('check_suite', {
				action: 'completed',
				repository: repo(),
				check_suite: { conclusion: 'success', pull_requests: [{ number: 9 }] },
			});
			expect(parsed?.workItemId).toBe('9');
			expect(parsed?.actorLogin).toBeUndefined();
		});

		it('leaves workItemId undefined for a check_suite with no PRs', () => {
			const parsed = parseGitHubWebhook('check_suite', {
				action: 'completed',
				repository: repo(),
				check_suite: { conclusion: 'success', pull_requests: [] },
			});
			expect(parsed?.workItemId).toBeUndefined();
		});

		it('falls back to "unknown" when the payload has no repository', () => {
			const parsed = parseGitHubWebhook('pull_request', { pull_request: { number: 1 } });
			expect(parsed?.repoFullName).toBe('unknown');
		});

		it('parses a pull_request_review event', () => {
			const parsed = parseGitHubWebhook('pull_request_review', {
				action: 'submitted',
				repository: repo(),
				pull_request: { number: 3 },
				review: { state: 'changes_requested' },
				sender: { login: 'swarm-rev' },
			});
			expect(parsed?.kind).toBe('pull-request-review');
			expect(parsed?.workItemId).toBe('3');
		});

		it('enriches a pull_request event with head SHA, branch, draft and fork state', () => {
			const parsed = parseGitHubWebhook('pull_request', {
				action: 'opened',
				repository: repo(),
				pull_request: {
					number: 42,
					draft: true,
					head: { sha: 'abc123', ref: 'issue-42', repo: { full_name: 'a-fork/swarm' } },
					base: { ref: 'main', repo: { full_name: 'SmartTechBrewery/swarm' } },
				},
			});
			expect(parsed).toMatchObject({
				headSha: 'abc123',
				prBranch: 'issue-42',
				isDraft: true,
				isCrossRepo: true,
			});
		});

		it('extracts the PR author login from a pull_request event', () => {
			const parsed = parseGitHubWebhook('pull_request', {
				action: 'opened',
				repository: repo(),
				pull_request: {
					number: 42,
					user: { login: 'swarm-impl' },
					head: { sha: 'abc', ref: 'issue-42', repo: { full_name: 'SmartTechBrewery/swarm' } },
					base: { ref: 'main', repo: { full_name: 'SmartTechBrewery/swarm' } },
				},
			});
			expect(parsed?.prAuthorLogin).toBe('swarm-impl');
		});

		it('extracts merged and base branch fields from a closed pull_request event', () => {
			const parsed = parseGitHubWebhook('pull_request', {
				action: 'closed',
				repository: repo(),
				pull_request: { number: 42, merged: true, base: { ref: 'main' } },
			});
			expect(parsed).toMatchObject({ merged: true, baseBranch: 'main' });
		});

		it('leaves prAuthorLogin undefined when the pull_request has no user', () => {
			const parsed = parseGitHubWebhook('pull_request', {
				action: 'opened',
				repository: repo(),
				pull_request: { number: 42 },
			});
			expect(parsed?.prAuthorLogin).toBeUndefined();
		});

		it('marks a same-repo pull_request as not cross-repo', () => {
			const parsed = parseGitHubWebhook('pull_request', {
				action: 'opened',
				repository: repo(),
				pull_request: {
					number: 42,
					head: { sha: 'abc', ref: 'issue-42', repo: { full_name: 'SmartTechBrewery/swarm' } },
					base: { ref: 'main', repo: { full_name: 'SmartTechBrewery/swarm' } },
				},
			});
			expect(parsed?.isCrossRepo).toBe(false);
		});

		it('leaves isCrossRepo undefined when a repo is missing from the payload', () => {
			const parsed = parseGitHubWebhook('pull_request', {
				action: 'opened',
				repository: repo(),
				pull_request: {
					number: 42,
					// base carries no repo — can't tell fork from same-repo, so don't guess.
					head: { sha: 'abc', ref: 'issue-42', repo: { full_name: 'SmartTechBrewery/swarm' } },
					base: { ref: 'main' },
				},
			});
			expect(parsed?.isCrossRepo).toBeUndefined();
		});

		it('enriches a pull_request_review event with state, id, branch and head SHA', () => {
			const parsed = parseGitHubWebhook('pull_request_review', {
				action: 'submitted',
				repository: repo(),
				pull_request: { number: 3, head: { sha: 'deadbeef', ref: 'issue-3' } },
				review: { id: 987654, state: 'changes_requested' },
				sender: { login: 'swarm-rev' },
			});
			expect(parsed).toMatchObject({
				reviewState: 'changes-requested',
				reviewId: '987654',
				prBranch: 'issue-3',
				headSha: 'deadbeef',
			});
		});

		it('falls back to the review commit SHA when the pull request head SHA is absent', () => {
			const parsed = parseGitHubWebhook('pull_request_review', {
				action: 'submitted',
				repository: repo(),
				pull_request: { number: 3, head: { ref: 'issue-3' } },
				review: { id: 987654, state: 'changes_requested', commit_id: 'reviewed-sha' },
				sender: { login: 'swarm-rev' },
			});
			expect(parsed).toMatchObject({
				reviewId: '987654',
				prBranch: 'issue-3',
				headSha: 'reviewed-sha',
			});
		});

		it('leaves the review head SHA undefined when neither SHA source is present', () => {
			const parsed = parseGitHubWebhook('pull_request_review', {
				action: 'submitted',
				repository: repo(),
				pull_request: { number: 3, head: { ref: 'issue-3' } },
				review: { id: 987654, state: 'changes_requested' },
				sender: { login: 'swarm-rev' },
			});
			expect(parsed?.headSha).toBeUndefined();
		});

		it('enriches a check_suite event with head SHA, conclusion, and the PR branch', () => {
			const parsed = parseGitHubWebhook('check_suite', {
				action: 'completed',
				repository: repo(),
				check_suite: {
					conclusion: 'failure',
					head_sha: 'cafe',
					pull_requests: [{ number: 9, head: { ref: 'issue-9' } }],
				},
			});
			// The PR branch is what the Respond-to-CI phase checks out to push the fix.
			expect(parsed).toMatchObject({
				headSha: 'cafe',
				checkConclusion: 'failure',
				prBranch: 'issue-9',
			});
		});

		it('leaves prBranch undefined for a check_suite with no PRs', () => {
			const parsed = parseGitHubWebhook('check_suite', {
				action: 'completed',
				repository: repo(),
				check_suite: { conclusion: 'failure', head_sha: 'cafe', pull_requests: [] },
			});
			expect(parsed?.prBranch).toBeUndefined();
		});
	});

	describe('isSwarmGeneratedGitHubEvent (loop prevention)', () => {
		/** An `issue_comment` webhook carrying `body`, posted by `login`. */
		function comment(body: string | undefined, login = 'the-operator') {
			return parse('issue_comment', {
				repository: repo(),
				issue: { number: 1 },
				comment: body === undefined ? {} : { body },
				sender: { login },
			});
		}

		it('drops a comment carrying a hidden SWARM delivery marker', async () => {
			const event = comment('## 👀 Review\n\n<!-- swarm-delivery:run-42 -->');
			expect(await isSwarmGeneratedGitHubEvent(event, project)).toBe(true);
		});

		it('drops a comment carrying a planning-delivery marker', async () => {
			const event = comment('## 🗺️ Proposed plan\n\n<!-- swarm-planning-delivery:run-42 -->');
			expect(await isSwarmGeneratedGitHubEvent(event, project)).toBe(true);
		});

		it('drops a comment carrying the generated-by-SWARM footer', async () => {
			const event = comment('## ⚠️ SWARM run failed\n\n---\n_Generated by SWARM._');
			expect(await isSwarmGeneratedGitHubEvent(event, project)).toBe(true);
		});

		it('drops a marked comment whatever account posted it', async () => {
			// The federated case the marker exists for: SWARM delivered this through
			// some *other* operator's account, whose login this process cannot resolve.
			const event = comment('plan\n\n<!-- swarm-planning-delivery:run-9 -->', 'someone-else');
			expect(await isSwarmGeneratedGitHubEvent(event, project)).toBe(true);
		});

		it('does NOT drop a human comment posted from the login SWARM implements as', async () => {
			// The regression this fixes: under the federated model the implementer
			// credential is the operator's own token, so an author check swallowed the
			// operator's genuine review feedback (ADR-004 §2/§3, issues #396/#443).
			const event = comment('Please also handle the empty-list case.', IDENTITIES.implementer);
			expect(await isSwarmGeneratedGitHubEvent(event, project)).toBe(false);
		});

		it('does NOT drop a human quote-reply quoting a prior SWARM comment', async () => {
			const quoteReplyBody =
				'> ## 🗺️ Proposed implementation plan\n> \n> plan\n> \n> ---\n> _Generated by SWARM (Planning phase). Move this item..._\n> <!-- swarm-planning-delivery:run-42 -->\n\nI disagree with step 2.';
			const event = comment(quoteReplyBody, 'a-human');
			expect(await isSwarmGeneratedGitHubEvent(event, project)).toBe(false);
		});

		it('does not drop a comment event whose body is absent', async () => {
			expect(await isSwarmGeneratedGitHubEvent(comment(undefined), project)).toBe(false);
		});

		it.each([
			'pull_request',
			'pull_request_review',
			'check_suite',
		])('does not drop a %s event even with a marker-like body', async (eventType) => {
			// The reviewer opening/acting on a PR must reach the implementer — this
			// drop gate is comment-scoped, so lifecycle events flow through
			// regardless of what any body in the payload says.
			const event = parse(eventType, {
				repository: repo(),
				pull_request: { number: 1, body: '<!-- swarm-delivery:run-42 -->' },
				review: { id: 5, body: '_Generated by SWARM._' },
				check_suite: { pull_requests: [{ number: 1 }] },
				sender: { login: IDENTITIES.reviewer },
			});
			expect(await isSwarmGeneratedGitHubEvent(event, project)).toBe(false);
		});
	});

	describe('neutral vocabulary mapping', () => {
		it("maps GitHub's `synchronize` action to the neutral `updated`", () => {
			const parsed = parseGitHubWebhook('pull_request', {
				action: 'synchronize',
				repository: repo(),
				pull_request: { number: 42 },
			});
			expect(parsed?.action).toBe('updated');
		});

		it('passes an action SWARM does not act on through verbatim', () => {
			// It must still normalize and enqueue — the worker completes it as
			// `no-trigger` — rather than fail the durable envelope's validation.
			const parsed = parseGitHubWebhook('pull_request', {
				action: 'review_requested',
				repository: repo(),
				pull_request: { number: 42 },
			});
			expect(parsed?.action).toBe('review_requested');
		});

		it('passes a review state SWARM does not act on through verbatim', () => {
			const parsed = parseGitHubWebhook('pull_request_review', {
				action: 'submitted',
				repository: repo(),
				pull_request: { number: 3 },
				review: { id: 1, state: 'approved' },
			});
			expect(parsed?.reviewState).toBe('approved');
		});
	});

	describe('readGitHubWebhookRequest', () => {
		it("reads GitHub's event, delivery and signature headers", () => {
			const headers: Record<string, string> = {
				'x-github-event': 'pull_request',
				'x-github-delivery': 'delivery-1',
				'x-hub-signature-256': 'sha256=abc',
			};
			expect(readGitHubWebhookRequest((name) => headers[name])).toEqual({
				eventName: 'pull_request',
				deliveryId: 'delivery-1',
				signature: 'sha256=abc',
			});
		});

		it('falls back to an unknown event name and an empty signature', () => {
			// An unrecognized POST must be acknowledged as an unhandled event type,
			// not crash the receiver.
			expect(readGitHubWebhookRequest(() => undefined)).toEqual({
				eventName: 'unknown',
				signature: '',
			});
		});
	});

	describe('verifyGitHubSignature', () => {
		const BODY = '{"action":"opened"}';
		const SECRET = 'whsec_test';
		const signature = (body: string, secret: string) =>
			`sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;

		it('accepts a correctly signed body', () => {
			expect(verifyGitHubSignature(BODY, signature(BODY, SECRET), SECRET)).toBe(true);
		});

		it('rejects a signature computed with the wrong secret', () => {
			expect(verifyGitHubSignature(BODY, signature(BODY, 'wrong'), SECRET)).toBe(false);
		});

		it('rejects a body that changed after signing', () => {
			expect(verifyGitHubSignature(`${BODY} `, signature(BODY, SECRET), SECRET)).toBe(false);
		});

		it('rejects an absent signature', () => {
			expect(verifyGitHubSignature(BODY, '', SECRET)).toBe(false);
		});

		it("rejects a signature missing GitHub's `sha256=` prefix", () => {
			expect(verifyGitHubSignature(BODY, signature(BODY, SECRET).slice(7), SECRET)).toBe(false);
		});

		it('rejects a signature of the wrong length', () => {
			expect(verifyGitHubSignature(BODY, 'sha256=deadbeef', SECRET)).toBe(false);
		});
	});
});
