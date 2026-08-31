import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	createMockGitLabCommitStatusResponse,
	createMockGitLabMergeRequestPayload,
	createMockGitLabMergeRequestResponse,
	createMockProjectConfig,
	createMockScmEvent,
} from '../../../../helpers/factories.js';

// Capture git invocations without spawning a process. `promisify(execFile)` calls
// the mocked `execFile` with a node-style callback, so resolve it successfully.
const execFileCalls: Array<{ args: string[]; env: NodeJS.ProcessEnv; cwd: string }> = [];
vi.mock('node:child_process', () => ({
	execFile: (
		_cmd: string,
		args: string[],
		opts: { env: NodeJS.ProcessEnv; cwd: string },
		cb: (err: unknown, res: { stdout: string; stderr: string }) => void,
	) => {
		execFileCalls.push({ args, env: opts.env, cwd: opts.cwd });
		cb(null, { stdout: '', stderr: '' });
	},
}));

// Only the persona-credential and identity seams are stubbed. `withGitLabToken` is
// spied but still establishes the *real* async-context scope, so a read test can
// assert both the token the class chose to bind and the `PRIVATE-TOKEN` header the
// underlying request went out with — the two halves of "this read ran as that
// persona" — and `GitLabApiError` stays real so the merge classifier is exercised
// against the actual shape.
vi.mock('@/integrations/scm/gitlab/client.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/integrations/scm/gitlab/client.js')>();
	return {
		...actual,
		withGitLabToken: vi.fn(actual.withGitLabToken),
		getScopedGitLabUser: vi.fn<() => Promise<{ username: string | null; email: string | null }>>(),
	};
});
vi.mock('@/integrations/scm/gitlab/credentials.js', () => ({
	getGitLabToken: vi.fn<(project: unknown, persona: string) => Promise<string>>(),
	getGitLabTokenOrNull: vi.fn<(project: unknown, persona: string) => Promise<string | null>>(),
}));
vi.mock('@/integrations/scm/gitlab/personas.js', () => ({
	resolveGitLabPersonaIdentities: vi.fn(),
	isSwarmGitLabActor: vi.fn(),
	getGitLabPersonaForLogin: vi.fn(),
}));
vi.mock('@/integrations/scm/gitlab/operator-delivery.js', () => ({
	createGitLabOperatorDeliveryProvider: vi.fn(),
}));
// The reads keep their **real** implementations behind spies: their own suite proves
// each endpoint and mapping, and the read tests below assert the request that
// actually went out. The merge tests then override only the two reads the
// eligibility recheck consults, so the outcome matrix drives state directly instead
// of staging a fetch script per case.
vi.mock('@/integrations/scm/gitlab/merge-requests.js', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('@/integrations/scm/gitlab/merge-requests.js')>();
	return {
		...actual,
		findOpenGitLabMergeRequest: vi.fn(actual.findOpenGitLabMergeRequest),
		getGitLabMergeRequestApprovals: vi.fn(actual.getGitLabMergeRequestApprovals),
		getGitLabMergeRequestMergeState: vi.fn(actual.getGitLabMergeRequestMergeState),
	};
});
vi.mock('@/integrations/scm/gitlab/writes.js', () => ({
	createGitLabMergeRequest: vi.fn(),
	mergeGitLabMergeRequestDirect: vi.fn(),
	postGitLabMergeRequestNote: vi.fn(),
	postIdempotentGitLabMergeRequestNote: vi.fn(),
	submitGitLabReview: vi.fn(),
}));

import {
	GitLabApiError,
	getScopedGitLabUser,
	withGitLabToken,
} from '@/integrations/scm/gitlab/client.js';
import { getGitLabToken, getGitLabTokenOrNull } from '@/integrations/scm/gitlab/credentials.js';
import {
	findOpenGitLabMergeRequest,
	getGitLabMergeRequestApprovals,
	getGitLabMergeRequestMergeState,
} from '@/integrations/scm/gitlab/merge-requests.js';
import { createGitLabOperatorDeliveryProvider } from '@/integrations/scm/gitlab/operator-delivery.js';
import {
	getGitLabPersonaForLogin,
	isSwarmGitLabActor,
	resolveGitLabPersonaIdentities,
} from '@/integrations/scm/gitlab/personas.js';
import { GitLabSCMIntegration } from '@/integrations/scm/gitlab/scm-integration.js';
import {
	createGitLabMergeRequest,
	mergeGitLabMergeRequestDirect,
	postGitLabMergeRequestNote,
	postIdempotentGitLabMergeRequestNote,
	submitGitLabReview,
} from '@/integrations/scm/gitlab/writes.js';
import type { ScmDeliveryProvider } from '@/scm/delivery.js';
import { SWARM_GENERATED_FOOTER } from '@/scm/swarm-origin.js';
import type { ScmPersonaIdentities } from '@/scm/types.js';

const project = createMockProjectConfig();
const IDENTITIES: ScmPersonaIdentities = { implementer: 'swarm-impl', reviewer: 'swarm-rev' };
/** GitLab reports full 40-character SHAs, so a reviewed head is compared exactly. */
const APPROVED_SHA = 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7';
const OTHER_SHA = 'aaaa560886d4f094c3e6c9ef40349f7d38b5d27d7';

describe('GitLabSCMIntegration', () => {
	const scm = new GitLabSCMIntegration();

	beforeEach(() => {
		vi.mocked(getGitLabToken).mockReset();
		vi.mocked(getGitLabTokenOrNull).mockReset();
		vi.mocked(withGitLabToken).mockClear();
	});

	it('declares itself as the gitlab SCM provider', () => {
		expect(scm.type).toBe('gitlab');
		expect(scm.category).toBe('scm');
	});

	describe('hasIntegration', () => {
		it('is an OR over the two persona tokens', async () => {
			vi.mocked(getGitLabTokenOrNull).mockImplementation(async (_p, persona) =>
				persona === 'reviewer' ? 'token-rev' : null,
			);

			await expect(scm.hasIntegration(project)).resolves.toBe(true);
		});

		it('is false only when neither persona resolves', async () => {
			vi.mocked(getGitLabTokenOrNull).mockResolvedValue(null);

			await expect(scm.hasIntegration(project)).resolves.toBe(false);
		});
	});

	describe('hasPersonaToken', () => {
		it('reports per persona', async () => {
			vi.mocked(getGitLabTokenOrNull).mockImplementation(async (_p, persona) =>
				persona === 'implementer' ? 'token-impl' : null,
			);

			await expect(scm.hasPersonaToken(project, 'implementer')).resolves.toBe(true);
			await expect(scm.hasPersonaToken(project, 'reviewer')).resolves.toBe(false);
		});
	});

	describe('withPersonaCredentials', () => {
		it('binds the requested persona’s own token', async () => {
			vi.mocked(getGitLabToken).mockImplementation(async (_p, persona) =>
				persona === 'implementer' ? 'token-impl' : 'token-rev',
			);

			await scm.withPersonaCredentials(project, 'reviewer', async () => undefined);

			expect(vi.mocked(getGitLabToken)).toHaveBeenCalledWith(project, 'reviewer');
			expect(vi.mocked(withGitLabToken).mock.calls[0]?.[0]).toBe('token-rev');
		});

		it('runs fn inside the scope and returns its value', async () => {
			vi.mocked(getGitLabToken).mockResolvedValue('token-impl');

			await expect(
				scm.withPersonaCredentials(project, 'implementer', async () => 'done'),
			).resolves.toBe('done');
		});

		it('throws before running fn when the token is missing', async () => {
			vi.mocked(getGitLabToken).mockRejectedValue(new Error('No GitLab implementer token'));
			const fn = vi.fn(async () => 'never');

			await expect(scm.withPersonaCredentials(project, 'implementer', fn)).rejects.toThrow(
				/No GitLab implementer token/,
			);
			expect(fn).not.toHaveBeenCalled();
		});
	});

	describe('persona identity + actor resolution', () => {
		it('delegates identity resolution to the cached resolver', async () => {
			vi.mocked(resolveGitLabPersonaIdentities).mockResolvedValue(IDENTITIES);

			await expect(scm.resolvePersonaIdentities(project)).resolves.toEqual(IDENTITIES);
			expect(vi.mocked(resolveGitLabPersonaIdentities)).toHaveBeenCalledWith(project);
		});

		it('delegates actor → persona mapping', () => {
			vi.mocked(getGitLabPersonaForLogin).mockReturnValue('reviewer');

			expect(scm.personaForActor('swarm-rev', IDENTITIES)).toBe('reviewer');
			expect(vi.mocked(getGitLabPersonaForLogin)).toHaveBeenCalledWith('swarm-rev', IDENTITIES);
		});

		it('delegates the SWARM-actor check', () => {
			vi.mocked(isSwarmGitLabActor).mockReturnValue(true);

			expect(scm.isSwarmActor('swarm-impl', IDENTITIES)).toBe(true);
			expect(vi.mocked(isSwarmGitLabActor)).toHaveBeenCalledWith('swarm-impl', IDENTITIES);
		});
	});

	// The four webhook-ingress methods delegate to `./webhook.ts`, whose own suite
	// covers the header names, every event mapping, and the token comparison. These
	// assert only that the contract methods are wired to it rather than still
	// throwing their phase-1 stub.
	describe('webhook ingress', () => {
		it('reads GitLab headers through the provider', () => {
			const headers: Record<string, string> = {
				'x-gitlab-event': 'Merge Request Hook',
				'x-gitlab-event-uuid': 'delivery-1',
				'x-gitlab-token': 'sh4red-t0ken',
			};
			expect(scm.readWebhookRequest((name) => headers[name.toLowerCase()])).toEqual({
				eventName: 'Merge Request Hook',
				deliveryId: 'delivery-1',
				signature: 'sh4red-t0ken',
			});
		});

		it('accepts the configured secret token and rejects anything else', () => {
			const rawBody = '{"object_kind":"merge_request"}';
			const secret = 'sh4red-t0ken';

			expect(scm.verifyWebhookSignature(rawBody, secret, secret)).toBe(true);
			expect(scm.verifyWebhookSignature(rawBody, 'other-token', secret)).toBe(false);
			expect(scm.verifyWebhookSignature(rawBody, '', secret)).toBe(false);
		});

		it('normalizes a supported event and drops an unsupported one', () => {
			const payload = createMockGitLabMergeRequestPayload();
			expect(scm.parseWebhookEvent('Merge Request Hook', payload)).toMatchObject({
				kind: 'pull-request',
				action: 'opened',
				workItemId: '17',
			});
			expect(scm.parseWebhookEvent('Push Hook', payload)).toBeNull();
		});

		it('applies the comment-scoped SWARM-origin gate', async () => {
			const marked = createMockScmEvent({
				kind: 'work-item-comment',
				isCommentEvent: true,
				commentBody: `Done.\n\n${SWARM_GENERATED_FOOTER}`,
			});
			await expect(scm.isSwarmGeneratedEvent(marked, project)).resolves.toBe(true);

			const human = createMockScmEvent({
				kind: 'work-item-comment',
				isCommentEvent: true,
				commentBody: 'please rebase',
			});
			await expect(scm.isSwarmGeneratedEvent(human, project)).resolves.toBe(false);
		});
	});

	// The four read methods delegate to `./merge-requests.ts`, whose own suite covers
	// every endpoint path and field mapping. These assert what only the class decides:
	// that the project comes off `project.repo`, and that each read runs inside the
	// documented persona's credential scope — asserted on the token the request itself
	// carried, not just on the wrapper call.
	describe('merge-request reads', () => {
		let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

		function jsonResponse(body: unknown): Response {
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		}

		/** The token the first outbound GitLab request authenticated as. */
		function tokenOnTheWire(): string | undefined {
			const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
			return headers['private-token'];
		}

		function requestedPath(): string {
			return new URL(String(fetchMock.mock.calls[0]?.[0])).pathname;
		}

		beforeEach(() => {
			fetchMock = vi.fn<typeof fetch>();
			vi.stubGlobal('fetch', fetchMock);
			vi.mocked(getGitLabToken).mockImplementation(async (_p, persona) => `token-${persona}`);
		});

		it('reads a merge request as the reviewer by default', async () => {
			fetchMock.mockResolvedValue(jsonResponse(createMockGitLabMergeRequestResponse()));

			await expect(scm.getPullRequest(project, 17)).resolves.toMatchObject({
				number: 17,
				headBranch: 'swarm/issue-17',
				mergeable: true,
			});
			expect(vi.mocked(getGitLabToken)).toHaveBeenCalledWith(project, 'reviewer');
			expect(tokenOnTheWire()).toBe('token-reviewer');
			expect(requestedPath()).toBe('/api/v4/projects/SmartTechBrewery%2Fswarm/merge_requests/17');
		});

		it('honours an explicitly requested persona', async () => {
			fetchMock.mockResolvedValue(jsonResponse(createMockGitLabMergeRequestResponse()));

			await scm.getPullRequest(project, 17, 'implementer');

			expect(tokenOnTheWire()).toBe('token-implementer');
		});

		it('reads a title as the implementer — the merge request’s own author', async () => {
			fetchMock.mockResolvedValue(jsonResponse(createMockGitLabMergeRequestResponse()));

			await expect(scm.getPullRequestTitle(project, 17)).resolves.toBe('Add a thing');
			expect(tokenOnTheWire()).toBe('token-implementer');
		});

		it('aggregates commit statuses as the reviewer', async () => {
			fetchMock.mockResolvedValue(jsonResponse([createMockGitLabCommitStatusResponse()]));

			await expect(scm.getAggregateCheckStatus(project, 'abc123')).resolves.toEqual({
				totalCount: 1,
				checkRuns: [{ name: 'unit-tests', status: 'completed', conclusion: 'success' }],
			});
			expect(tokenOnTheWire()).toBe('token-reviewer');
			expect(requestedPath()).toBe(
				'/api/v4/projects/SmartTechBrewery%2Fswarm/repository/commits/abc123/statuses',
			);
		});

		// The read a **branch** pipeline's `checks` event depends on (issue #618): GitLab
		// includes `merge_request` only for a merge-request pipeline, so ingress resolves
		// one through this contract method. Its four-state vocabulary must collapse to
		// the neutral pair, or a merged merge request would read as open.
		it("maps a commit's merge requests onto the contract's open/closed pair, as the reviewer", async () => {
			fetchMock.mockResolvedValue(
				jsonResponse([
					{ iid: 17, state: 'opened', source_branch: 'swarm/issue-17' },
					{ iid: 16, state: 'merged', source_branch: 'swarm/issue-16' },
					{ iid: 15, state: 'closed', source_branch: 'swarm/issue-15' },
					{ iid: 14, state: 'locked', source_branch: 'swarm/issue-14' },
				]),
			);

			await expect(scm.listPullRequestsForCommit(project, 'abc123')).resolves.toEqual([
				{ number: 17, state: 'open', headBranch: 'swarm/issue-17' },
				{ number: 16, state: 'closed', headBranch: 'swarm/issue-16' },
				{ number: 15, state: 'closed', headBranch: 'swarm/issue-15' },
				{ number: 14, state: 'closed', headBranch: 'swarm/issue-14' },
			]);
			expect(tokenOnTheWire()).toBe('token-reviewer');
			expect(requestedPath()).toBe(
				'/api/v4/projects/SmartTechBrewery%2Fswarm/repository/commits/abc123/merge_requests',
			);
		});

		it('lists conflict candidates as the implementer, the persona that pushes the fix', async () => {
			fetchMock.mockResolvedValue(jsonResponse([]));

			await expect(scm.listConflictCandidates(project, 'main')).resolves.toEqual([]);
			expect(tokenOnTheWire()).toBe('token-implementer');
			expect(requestedPath()).toBe('/api/v4/projects/SmartTechBrewery%2Fswarm/merge_requests');
		});

		it('lets a GitLabApiError propagate instead of reporting an empty read', async () => {
			// A fresh `Response` per call — one body can only be consumed once.
			fetchMock.mockImplementation(
				async () =>
					new Response(JSON.stringify({ message: '404 Project Not Found' }), { status: 404 }),
			);

			await expect(scm.listConflictCandidates(project, 'main')).rejects.toBeInstanceOf(
				GitLabApiError,
			);
			await expect(scm.getAggregateCheckStatus(project, 'abc123')).rejects.toBeInstanceOf(
				GitLabApiError,
			);
			await expect(scm.getPullRequest(project, 17)).rejects.toBeInstanceOf(GitLabApiError);
		});
	});

	// A pure grammar, so it is asserted as one: no credential, no request. GitLab
	// spells a merge request `/-/merge_requests/<iid>`, which is the whole reason
	// shared code must not derive `github.com/<repo>/pull/<n>` for itself.
	describe('pullRequestUrl', () => {
		it('spells GitLab’s own merge-request web path', () => {
			expect(scm.pullRequestUrl('team/app', 42)).toBe(
				'https://gitlab.com/team/app/-/merge_requests/42',
			);
			expect(scm.pullRequestUrl('team/app', '42')).toBe(
				'https://gitlab.com/team/app/-/merge_requests/42',
			);
		});

		// The repository is the caller's, not `project.repo`: a stalled row records
		// the repository its run actually acted on (issue #683).
		it('uses the repository it is handed rather than the project’s', () => {
			expect(scm.pullRequestUrl('other/repo', 7)).toBe(
				'https://gitlab.com/other/repo/-/merge_requests/7',
			);
		});
	});

	describe('commentOnPullRequest', () => {
		beforeEach(() => {
			vi.mocked(getGitLabToken).mockImplementation(async (_p, persona) => `token-${persona}`);
			vi.mocked(postGitLabMergeRequestNote).mockResolvedValue(991);
		});

		it('comments as the implementer by default — the merge request’s own author', async () => {
			await expect(scm.commentOnPullRequest(project, 17, 'reclaimed mid-run')).resolves.toBe(991);
			expect(vi.mocked(postGitLabMergeRequestNote)).toHaveBeenCalledWith(
				'SmartTechBrewery/swarm',
				17,
				'reclaimed mid-run',
			);
			expect(vi.mocked(getGitLabToken)).toHaveBeenCalledWith(project, 'implementer');
		});

		it('honours an explicitly requested persona', async () => {
			await scm.commentOnPullRequest(project, 17, 'note', 'reviewer');

			expect(vi.mocked(getGitLabToken)).toHaveBeenCalledWith(project, 'reviewer');
		});
	});

	// The merge capability is the one contract method that must never throw: every
	// refusal maps onto a terminal `MergePullRequestOutcome` so a completed Review
	// can't be retroactively failed (issue #253/#292).
	describe('mergePullRequest', () => {
		function openAt(headSha: string) {
			return {
				merged: false,
				state: 'open',
				draft: false,
				headSha,
				changesRequested: false,
			};
		}

		beforeEach(() => {
			vi.mocked(getGitLabToken).mockImplementation(async (_p, persona) => `token-${persona}`);
			vi.mocked(getGitLabMergeRequestMergeState).mockReset();
			vi.mocked(getGitLabMergeRequestApprovals).mockReset();
			vi.mocked(mergeGitLabMergeRequestDirect).mockReset();
			vi.mocked(getGitLabMergeRequestApprovals).mockResolvedValue([
				{ state: 'APPROVED', commitId: APPROVED_SHA },
			]);
		});

		it('merges as the implementer, pinned to the approved head', async () => {
			vi.mocked(getGitLabMergeRequestMergeState).mockResolvedValue(openAt(APPROVED_SHA));
			vi.mocked(mergeGitLabMergeRequestDirect).mockResolvedValue({
				merged: true,
				message: 'merge request merged',
				sha: 'abcdef0123456789abcdef0123456789abcdef01',
			});

			await expect(scm.mergePullRequest(project, 17, APPROVED_SHA)).resolves.toEqual({
				status: 'merged',
				message: 'merge request merged',
				sha: 'abcdef0123456789abcdef0123456789abcdef01',
			});
			expect(vi.mocked(getGitLabToken)).toHaveBeenCalledWith(project, 'implementer');
			expect(vi.mocked(mergeGitLabMergeRequestDirect)).toHaveBeenCalledWith(
				'SmartTechBrewery/swarm',
				17,
				APPROVED_SHA,
			);
		});

		it('reports an already-merged merge request as merged without attempting a merge', async () => {
			vi.mocked(getGitLabMergeRequestMergeState).mockResolvedValue({
				...openAt(APPROVED_SHA),
				merged: true,
				state: 'closed',
			});

			await expect(scm.mergePullRequest(project, 17, APPROVED_SHA)).resolves.toEqual({
				status: 'merged',
				message: 'merge request already merged',
			});
			expect(vi.mocked(mergeGitLabMergeRequestDirect)).not.toHaveBeenCalled();
		});

		it('refuses when the head moved since the reviewed commit', async () => {
			vi.mocked(getGitLabMergeRequestMergeState).mockResolvedValue(openAt(OTHER_SHA));

			await expect(scm.mergePullRequest(project, 17, APPROVED_SHA)).resolves.toMatchObject({
				status: 'not-eligible',
				message: expect.stringContaining('head changed'),
			});
			expect(vi.mocked(mergeGitLabMergeRequestDirect)).not.toHaveBeenCalled();
		});

		it('refuses a merge request converted back to a draft', async () => {
			vi.mocked(getGitLabMergeRequestMergeState).mockResolvedValue({
				...openAt(APPROVED_SHA),
				draft: true,
			});

			await expect(scm.mergePullRequest(project, 17, APPROVED_SHA)).resolves.toMatchObject({
				status: 'not-eligible',
				message: expect.stringContaining('draft'),
			});
		});

		it('refuses a closed merge request', async () => {
			vi.mocked(getGitLabMergeRequestMergeState).mockResolvedValue({
				...openAt(APPROVED_SHA),
				state: 'closed',
			});

			await expect(scm.mergePullRequest(project, 17, APPROVED_SHA)).resolves.toMatchObject({
				status: 'not-eligible',
				message: 'merge request is closed',
			});
		});

		// Terminal rather than the `not-ready` GitLab's own 405 would produce: a reviewer
		// decision does not clear on its own, so retrying it is wrong.
		it('refuses when a reviewer has since requested changes', async () => {
			vi.mocked(getGitLabMergeRequestMergeState).mockResolvedValue({
				...openAt(APPROVED_SHA),
				changesRequested: true,
			});

			await expect(scm.mergePullRequest(project, 17, APPROVED_SHA)).resolves.toMatchObject({
				status: 'not-eligible',
				message: expect.stringContaining('changes have since been requested'),
			});
			expect(vi.mocked(mergeGitLabMergeRequestDirect)).not.toHaveBeenCalled();
		});

		it('refuses when the approval has been dismissed', async () => {
			vi.mocked(getGitLabMergeRequestMergeState).mockResolvedValue(openAt(APPROVED_SHA));
			vi.mocked(getGitLabMergeRequestApprovals).mockResolvedValue([]);

			await expect(scm.mergePullRequest(project, 17, APPROVED_SHA)).resolves.toMatchObject({
				status: 'not-eligible',
				message: expect.stringContaining('dismissed'),
			});
		});

		it('reports a non-merged 2xx as not-ready rather than a silent success', async () => {
			vi.mocked(getGitLabMergeRequestMergeState).mockResolvedValue(openAt(APPROVED_SHA));
			vi.mocked(mergeGitLabMergeRequestDirect).mockResolvedValue({
				merged: false,
				message: 'still opened',
			});

			await expect(scm.mergePullRequest(project, 17, APPROVED_SHA)).resolves.toEqual({
				status: 'not-ready',
				message: 'still opened',
			});
		});

		const classifications: Array<[status: number, detail: string, expected: string]> = [
			[409, 'SHA does not match HEAD of source branch', 'not-eligible'],
			[405, 'Method Not Allowed', 'not-ready'],
			[406, 'Branch cannot be merged', 'not-ready'],
			[422, 'Branch cannot be merged', 'not-ready'],
			[401, 'Unauthorized', 'policy-blocked'],
			[403, 'Forbidden', 'policy-blocked'],
			[404, 'Not found', 'provider-error'],
			[500, 'Internal server error', 'provider-error'],
		];

		for (const [status, detail, expected] of classifications) {
			it(`maps a ${status} merge refusal onto ${expected}`, async () => {
				vi.mocked(getGitLabMergeRequestMergeState).mockResolvedValue(openAt(APPROVED_SHA));
				vi.mocked(mergeGitLabMergeRequestDirect).mockRejectedValue(
					new GitLabApiError(status, 'PUT', '/merge_requests/17/merge', detail),
				);

				await expect(scm.mergePullRequest(project, 17, APPROVED_SHA)).resolves.toMatchObject({
					status: expected,
				});
			});
		}

		it('reports a failed state read as provider-error rather than throwing', async () => {
			vi.mocked(getGitLabMergeRequestMergeState).mockRejectedValue(
				new GitLabApiError(404, 'GET', '/merge_requests/17', '404 Not found'),
			);

			await expect(scm.mergePullRequest(project, 17, APPROVED_SHA)).resolves.toMatchObject({
				status: 'provider-error',
			});
		});

		it('reports a failed approvals read as provider-error rather than throwing', async () => {
			vi.mocked(getGitLabMergeRequestMergeState).mockResolvedValue(openAt(APPROVED_SHA));
			vi.mocked(getGitLabMergeRequestApprovals).mockRejectedValue(
				new GitLabApiError(500, 'GET', '/merge_requests/17/approvals', 'boom'),
			);

			await expect(scm.mergePullRequest(project, 17, APPROVED_SHA)).resolves.toMatchObject({
				status: 'provider-error',
			});
		});

		it('reports a missing implementer token as provider-error rather than throwing', async () => {
			vi.mocked(getGitLabToken).mockRejectedValue(
				new Error('No GitLab implementer token configured'),
			);

			await expect(scm.mergePullRequest(project, 17, APPROVED_SHA)).resolves.toEqual({
				status: 'provider-error',
				message: 'No GitLab implementer token configured',
			});
		});
	});

	describe('deliveryProvider', () => {
		beforeEach(() => {
			execFileCalls.length = 0;
			vi.mocked(getGitLabToken).mockImplementation(async (_p, persona) => `token-${persona}`);
			vi.mocked(getScopedGitLabUser).mockResolvedValue({
				username: 'swarm-impl',
				email: 'impl@example.com',
			});
		});

		it('signs commits with the account username and its exposed email', async () => {
			const delivery = await scm.deliveryProvider(project, 'implementer');

			expect(delivery.commitIdentity).toEqual({
				name: 'swarm-impl',
				email: 'impl@example.com',
			});
		});

		it('falls back to the noreply placeholder when the token exposes no email', async () => {
			vi.mocked(getScopedGitLabUser).mockResolvedValue({ username: 'swarm-impl', email: null });

			const delivery = await scm.deliveryProvider(project, 'implementer');

			expect(delivery.commitIdentity.email).toBe('swarm-impl@users.noreply.gitlab.com');
		});

		it('throws when the token resolves to no GitLab account', async () => {
			vi.mocked(getScopedGitLabUser).mockResolvedValue({ username: null, email: null });

			await expect(scm.deliveryProvider(project, 'reviewer')).rejects.toThrow(
				/Could not resolve GitLab identity for reviewer persona/,
			);
		});

		it('runs every scoped operation under the requested persona’s token', async () => {
			vi.mocked(findOpenGitLabMergeRequest).mockResolvedValue(undefined);
			vi.mocked(createGitLabMergeRequest).mockResolvedValue({
				number: 21,
				url: 'https://gitlab.com/SmartTechBrewery/swarm/-/merge_requests/21',
			});
			vi.mocked(getGitLabMergeRequestMergeState).mockResolvedValue({
				merged: false,
				state: 'open',
				draft: false,
				headSha: APPROVED_SHA,
				changesRequested: false,
			});
			vi.mocked(submitGitLabReview).mockResolvedValue(55);
			vi.mocked(postIdempotentGitLabMergeRequestNote).mockResolvedValue(42);
			const delivery = await scm.deliveryProvider(project, 'reviewer');
			vi.mocked(withGitLabToken).mockClear();

			await delivery.findPullRequest('issue-485');
			await delivery.createPullRequest({
				baseBranch: 'main',
				branch: 'issue-485',
				title: 't',
				body: 'b',
			});
			await delivery.submitReview({
				prNumber: 21,
				verdict: 'approve',
				body: 'LGTM',
				deliveryId: 'd1',
			});
			await delivery.postComment({ prNumber: 21, body: 'note', deliveryId: 'd1' });

			expect(vi.mocked(findOpenGitLabMergeRequest)).toHaveBeenCalledWith(
				'SmartTechBrewery/swarm',
				'issue-485',
			);
			expect(vi.mocked(createGitLabMergeRequest)).toHaveBeenCalledWith(
				'SmartTechBrewery/swarm',
				expect.objectContaining({ branch: 'issue-485' }),
			);
			// The contract's `submitReview` carries no reviewed head, so the seam reads the
			// merge request's own head and pins the approval to it.
			expect(vi.mocked(submitGitLabReview)).toHaveBeenCalledWith('SmartTechBrewery/swarm', {
				iid: 21,
				verdict: 'approve',
				body: 'LGTM',
				deliveryId: 'd1',
				headSha: APPROVED_SHA,
			});
			expect(vi.mocked(postIdempotentGitLabMergeRequestNote)).toHaveBeenCalledWith(
				'SmartTechBrewery/swarm',
				{ iid: 21, body: 'note', deliveryId: 'd1' },
			);
			for (const call of vi.mocked(withGitLabToken).mock.calls) {
				expect(call[0]).toBe('token-reviewer');
			}
			expect(vi.mocked(withGitLabToken)).toHaveBeenCalledTimes(4);
		});

		it('pushes the exact expected commit to GitLab with the token out of argv', async () => {
			const delivery = await scm.deliveryProvider(project, 'implementer');

			await delivery.pushBranch('/worktree', 'issue-485', 'abc1234');

			expect(execFileCalls).toHaveLength(1);
			const call = execFileCalls[0];
			expect(call.cwd).toBe('/worktree');
			expect(call.args).toEqual([
				'push',
				'--no-verify',
				'https://gitlab.com/SmartTechBrewery/swarm.git',
				'abc1234:refs/heads/issue-485',
			]);
			expect(call.env.GIT_CONFIG_COUNT).toBe('1');
			expect(call.env.GIT_CONFIG_KEY_0).toBe('http.https://gitlab.com/.extraheader');
			// GitLab authenticates any token form as the reserved `oauth2` user.
			expect(call.env.GIT_CONFIG_VALUE_0).toBe(
				`AUTHORIZATION: basic ${Buffer.from('oauth2:token-implementer').toString('base64')}`,
			);
			expect(call.args.join(' ')).not.toContain('token-implementer');
		});
	});

	describe('operatorDeliveryProvider', () => {
		it('builds the operator-credential seam with no project lookup', async () => {
			const operatorDelivery = { commitIdentity: { name: 'op', email: 'op@example.com' } };
			vi.mocked(createGitLabOperatorDeliveryProvider).mockResolvedValue(
				operatorDelivery as unknown as ScmDeliveryProvider,
			);

			await expect(
				scm.operatorDeliveryProvider('SmartTechBrewery/swarm', 'operator-token'),
			).resolves.toBe(operatorDelivery);
			expect(vi.mocked(createGitLabOperatorDeliveryProvider)).toHaveBeenCalledWith(
				'SmartTechBrewery/swarm',
				'operator-token',
			);
			expect(vi.mocked(getGitLabToken)).not.toHaveBeenCalled();
		});
	});
});
