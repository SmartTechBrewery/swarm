import { describe, expect, it } from 'vitest';
import { azureDevOpsRequestChangesMarker } from '@/integrations/scm/azure-devops/review-marker.js';
import {
	isSwarmGeneratedAzureDevOpsEvent,
	parseAzureDevOpsWebhook,
	readAzureDevOpsWebhookRequest,
	verifyAzureDevOpsWebhookAuth,
} from '@/integrations/scm/azure-devops/webhook.js';
import { SWARM_GENERATED_FOOTER, swarmMarker } from '@/scm/swarm-origin.js';
import {
	createMockAzureDevOpsBuildPayload,
	createMockAzureDevOpsCommentPayload,
	createMockAzureDevOpsPullRequestPayload,
	createMockProjectConfig,
} from '../../../../helpers/factories.js';

const project = createMockProjectConfig({
	id: 'proj-1',
	scm: 'azure-devops',
	repo: 'Fabrikam/Fiber/Web',
});

const HEAD_SHA = 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7';
const PULL_REQUEST_URL = 'https://dev.azure.com/Fabrikam/Fiber/_git/Web/pullrequest/17';
const HUMAN_ID = '11bb11bb-cc22-dd33-ee44-55ff55ff55ff';
const REVIEWER_ID = '22cc22cc-dd33-ee44-ff55-66aa66aa66aa';

const PR_CREATED = 'git.pullrequest.created';
const PR_UPDATED = 'git.pullrequest.updated';
const PR_COMMENT = 'ms.vss-code.git-pullrequest-comment-event';
const BUILD_COMPLETE = 'build.complete';

/** `Authorization: Basic base64(user:password)`, as a service-hook subscription sends it. */
function basic(credential: string): string {
	return `Basic ${Buffer.from(credential, 'utf8').toString('base64')}`;
}

describe('Azure DevOps webhook ingress', () => {
	// Every delivery under test here is one SWARM acts on, so the parser never
	// returns null — narrow it once so the assertions don't repeat `!`.
	function parse(payload: Record<string, unknown>) {
		const event = parseAzureDevOpsWebhook(String(payload.eventType), payload);
		if (!event) throw new Error(`expected ${String(payload.eventType)} to parse`);
		return event;
	}

	describe('readAzureDevOpsWebhookRequest', () => {
		it('reads the event type and dedup id from the body, the credential from Authorization', () => {
			const payload = createMockAzureDevOpsPullRequestPayload({ id: 'event-guid-1' });
			const headers: Record<string, string> = { authorization: basic('swarm:s3cret') };

			expect(readAzureDevOpsWebhookRequest((name) => headers[name], payload)).toEqual({
				eventName: PR_CREATED,
				deliveryId: 'event-guid-1',
				signature: basic('swarm:s3cret'),
			});
		});

		it('keys dedup on the event id, never the per-subscription notification or subscription id', () => {
			const request = readAzureDevOpsWebhookRequest(
				() => undefined,
				createMockAzureDevOpsPullRequestPayload({ id: 'event-guid-2' }),
			);
			expect(request.deliveryId).toBe('event-guid-2');
		});

		it('falls back to unknown, no delivery id, and an empty signature for a bare request', () => {
			expect(readAzureDevOpsWebhookRequest(() => undefined, 'not an object')).toEqual({
				eventName: 'unknown',
				signature: '',
			});
		});
	});

	describe('verifyAzureDevOpsWebhookAuth', () => {
		const rawBody = '{"eventType":"git.pullrequest.created"}';
		const secret = 's3cret';

		it('accepts the configured password whatever the username', () => {
			expect(verifyAzureDevOpsWebhookAuth(rawBody, basic('swarm:s3cret'), secret)).toBe(true);
			expect(verifyAzureDevOpsWebhookAuth(rawBody, basic('anyone-at-all:s3cret'), secret)).toBe(
				true,
			);
			expect(verifyAzureDevOpsWebhookAuth(rawBody, basic(':s3cret'), secret)).toBe(true);
		});

		it('takes the password after the first colon, so it may itself contain one', () => {
			expect(verifyAzureDevOpsWebhookAuth(rawBody, basic('swarm:a:b'), 'a:b')).toBe(true);
		});

		it('rejects a wrong password', () => {
			expect(verifyAzureDevOpsWebhookAuth(rawBody, basic('swarm:wrong!'), secret)).toBe(false);
			expect(verifyAzureDevOpsWebhookAuth(rawBody, basic('swarm:s3cre'), secret)).toBe(false);
		});

		it('fails closed on an absent or malformed credential', () => {
			expect(verifyAzureDevOpsWebhookAuth(rawBody, '', secret)).toBe(false);
			expect(verifyAzureDevOpsWebhookAuth(rawBody, 'Bearer s3cret', secret)).toBe(false);
			expect(verifyAzureDevOpsWebhookAuth(rawBody, 'Basic', secret)).toBe(false);
			// No colon at all: not a user:password pair, even though it "contains" the secret.
			expect(verifyAzureDevOpsWebhookAuth(rawBody, basic('s3cret'), secret)).toBe(false);
			// The raw secret is not a Basic credential.
			expect(verifyAzureDevOpsWebhookAuth(rawBody, secret, secret)).toBe(false);
		});

		it('fails closed when no secret is configured', () => {
			expect(verifyAzureDevOpsWebhookAuth(rawBody, basic('swarm:'), '')).toBe(false);
		});
	});

	describe('parseAzureDevOpsWebhook — deliveries SWARM does not act on', () => {
		it('returns null for an event type outside the processable set', () => {
			expect(
				parseAzureDevOpsWebhook('git.push', { eventType: 'git.push', resource: {} }),
			).toBeNull();
			const merged = createMockAzureDevOpsPullRequestPayload({
				eventType: 'git.pullrequest.merged',
			});
			expect(parseAzureDevOpsWebhook('git.pullrequest.merged', merged)).toBeNull();
			expect(parseAzureDevOpsWebhook('unknown', {})).toBeNull();
		});

		it('returns null when the event name contradicts the body’s own eventType', () => {
			expect(
				parseAzureDevOpsWebhook(PR_UPDATED, createMockAzureDevOpsPullRequestPayload()),
			).toBeNull();
		});

		it('returns null for a resource missing what its event type promises', () => {
			expect(
				parseAzureDevOpsWebhook(PR_CREATED, {
					eventType: PR_CREATED,
					resource: { status: 'active' },
				}),
			).toBeNull();
			expect(
				parseAzureDevOpsWebhook(PR_COMMENT, { eventType: PR_COMMENT, resource: { comment: {} } }),
			).toBeNull();
			expect(parseAzureDevOpsWebhook(PR_CREATED, { eventType: PR_CREATED })).toBeNull();
		});

		it('returns null for one of Azure’s own system comments', () => {
			const payload = createMockAzureDevOpsCommentPayload({ comment: { commentType: 'system' } });
			expect(parseAzureDevOpsWebhook(PR_COMMENT, payload)).toBeNull();
		});

		it('returns null for a build of a repository that is not Azure Repos Git', () => {
			const payload = createMockAzureDevOpsBuildPayload({
				build: { repository: { id: 'x', type: 'GitHub', name: 'fabrikam/web' } },
			});
			expect(parseAzureDevOpsWebhook(BUILD_COMPLETE, payload)).toBeNull();
		});

		it('returns null rather than guessing when the repository cannot be named', () => {
			const payload = createMockAzureDevOpsBuildPayload({ build: { project: undefined } });
			expect(parseAzureDevOpsWebhook(BUILD_COMPLETE, payload)).toBeNull();
		});
	});

	describe('pull-request events', () => {
		it('normalizes git.pullrequest.created to an opened pull request', () => {
			expect(parse(createMockAzureDevOpsPullRequestPayload())).toEqual({
				kind: 'pull-request',
				action: 'opened',
				repoFullName: 'Fabrikam/Fiber/Web',
				workItemId: '17',
				workItemUrl: PULL_REQUEST_URL,
				actorLogin: HUMAN_ID,
				isCommentEvent: false,
				commentBody: undefined,
				headSha: HEAD_SHA,
				prBranch: 'swarm/issue-17',
				baseBranch: 'main',
				isCrossRepo: false,
				isDraft: false,
				prAuthorLogin: HUMAN_ID,
				merged: false,
			});
		});

		it('normalizes an update to an active pull request (a push) to updated with the new head', () => {
			const event = parse(
				createMockAzureDevOpsPullRequestPayload({
					eventType: PR_UPDATED,
					pullRequest: { lastMergeSourceCommit: { commitId: 'b'.repeat(40) } },
				}),
			);
			expect(event).toMatchObject({
				kind: 'pull-request',
				action: 'updated',
				headSha: 'b'.repeat(40),
				merged: false,
			});
			// An updated delivery names no actor.
			expect(event.actorLogin).toBeUndefined();
		});

		it('normalizes a completed pull request to closed and merged', () => {
			const event = parse(
				createMockAzureDevOpsPullRequestPayload({
					eventType: PR_UPDATED,
					pullRequest: { status: 'completed' },
				}),
			);
			expect(event).toMatchObject({
				kind: 'pull-request',
				action: 'closed',
				merged: true,
				baseBranch: 'main',
			});
		});

		it('normalizes an abandoned pull request to closed and not merged', () => {
			const event = parse(
				createMockAzureDevOpsPullRequestPayload({
					eventType: PR_UPDATED,
					pullRequest: { status: 'abandoned' },
				}),
			);
			expect(event).toMatchObject({ kind: 'pull-request', action: 'closed', merged: false });
		});

		it('marks a pull request from a fork as cross-repo and reports drafts', () => {
			const event = parse(
				createMockAzureDevOpsPullRequestPayload({
					pullRequest: { forkSource: { name: 'refs/heads/feature' }, isDraft: true },
				}),
			);
			expect(event.isCrossRepo).toBe(true);
			expect(event.isDraft).toBe(true);
		});

		it('preserves Azure’s casing in the repository and reads a legacy-host organization', () => {
			const repository = {
				id: 'c2c2c2c2',
				name: 'Fabrikam-Fiber-Git',
				url: 'https://fabrikam.visualstudio.com/DefaultCollection/_apis/git/repositories/c2c2c2c2',
				project: { id: 'd3d3d3d3', name: 'Fabrikam' },
				remoteUrl: 'https://fabrikam.visualstudio.com/DefaultCollection/_git/Fabrikam-Fiber-Git',
			};
			const event = parse(createMockAzureDevOpsPullRequestPayload({ pullRequest: { repository } }));
			expect(event.repoFullName).toBe('fabrikam/Fabrikam/Fabrikam-Fiber-Git');
		});
	});

	describe('pull-request comment events', () => {
		it('normalizes a human comment to a work-item comment carrying its body', () => {
			expect(parse(createMockAzureDevOpsCommentPayload())).toEqual({
				kind: 'work-item-comment',
				action: 'created',
				repoFullName: 'Fabrikam/Fiber/Web',
				workItemId: '17',
				workItemUrl: PULL_REQUEST_URL,
				actorLogin: HUMAN_ID,
				isCommentEvent: true,
				commentBody: 'can you rebase this?',
				headSha: HEAD_SHA,
				prBranch: 'swarm/issue-17',
			});
		});

		it('maps SWARM’s request-changes findings comment to a changes-requested review', () => {
			const payload = createMockAzureDevOpsCommentPayload({
				comment: {
					author: { id: REVIEWER_ID, displayName: 'swarm-reviewer' },
					content: `## Findings\n\n${azureDevOpsRequestChangesMarker('delivery-9')}`,
				},
			});
			expect(parse(payload)).toEqual({
				kind: 'pull-request-review',
				action: 'submitted',
				repoFullName: 'Fabrikam/Fiber/Web',
				workItemId: '17',
				workItemUrl: PULL_REQUEST_URL,
				actorLogin: REVIEWER_ID,
				isCommentEvent: false,
				commentBody: undefined,
				headSha: HEAD_SHA,
				prBranch: 'swarm/issue-17',
				reviewState: 'changes-requested',
				reviewId: `17:changes-requested:${REVIEWER_ID}:${HEAD_SHA}`,
			});
		});

		it('keeps the synthesized review id stable across redeliveries of one verdict', () => {
			const make = (id: string) =>
				createMockAzureDevOpsCommentPayload({
					id,
					comment: {
						author: { id: REVIEWER_ID },
						content: azureDevOpsRequestChangesMarker('delivery-9'),
					},
				});
			expect(parse(make('event-a')).reviewId).toBe(parse(make('event-b')).reviewId);
		});
	});

	describe('build.complete', () => {
		it('normalizes a pull-request build to completed checks on the pull request’s head', () => {
			expect(parse(createMockAzureDevOpsBuildPayload())).toEqual({
				kind: 'checks',
				action: 'completed',
				repoFullName: 'Fabrikam/Fiber/Web',
				workItemId: '17',
				workItemUrl: PULL_REQUEST_URL,
				actorLogin: undefined,
				isCommentEvent: false,
				commentBody: undefined,
				// The head, not the merge commit `sourceVersion` names.
				headSha: HEAD_SHA,
				prBranch: 'swarm/issue-17',
				checkConclusion: 'success',
			});
		});

		it('leaves a branch build’s pull request for the receiver’s commit lookup', () => {
			const event = parse(createMockAzureDevOpsBuildPayload({ branchBuild: true }));
			expect(event).toMatchObject({ kind: 'checks', action: 'completed', headSha: HEAD_SHA });
			expect(event.workItemId).toBeUndefined();
			expect(event.workItemUrl).toBeUndefined();
			expect(event.prBranch).toBeUndefined();
		});

		it('maps the build result onto the neutral conclusion, passing unknown results through', () => {
			const conclusion = (result: string) =>
				parse(createMockAzureDevOpsBuildPayload({ build: { result } })).checkConclusion;
			expect(conclusion('failed')).toBe('failure');
			expect(conclusion('canceled')).toBe('cancelled');
			expect(conclusion('partiallySucceeded')).toBe('neutral');
			expect(conclusion('none')).toBe('none');
		});

		it('reads the organization from the envelope when the repository URL does not name it', () => {
			const event = parse(
				createMockAzureDevOpsBuildPayload({
					build: { repository: { id: 'c2c2c2c2', type: 'TfsGit', name: 'Web' } },
				}),
			);
			expect(event.repoFullName).toBe('Fabrikam/Fiber/Web');
		});
	});

	describe('isSwarmGeneratedAzureDevOpsEvent', () => {
		it('flags a comment carrying a SWARM-origin marker or footer', async () => {
			for (const content of [
				`Done.\n\n${SWARM_GENERATED_FOOTER}`,
				`Done.\n\n${swarmMarker('delivery', 'abc')}`,
			]) {
				const event = parse(createMockAzureDevOpsCommentPayload({ comment: { content } }));
				await expect(isSwarmGeneratedAzureDevOpsEvent(event, project)).resolves.toBe(true);
			}
		});

		it('passes a human comment and every non-comment event', async () => {
			const human = parse(createMockAzureDevOpsCommentPayload());
			await expect(isSwarmGeneratedAzureDevOpsEvent(human, project)).resolves.toBe(false);

			const verdict = parse(
				createMockAzureDevOpsCommentPayload({
					comment: {
						content: `${azureDevOpsRequestChangesMarker('d')}\n${SWARM_GENERATED_FOOTER}`,
					},
				}),
			);
			// The verdict must reach Respond-to-review even though SWARM wrote it.
			await expect(isSwarmGeneratedAzureDevOpsEvent(verdict, project)).resolves.toBe(false);
		});
	});
});
