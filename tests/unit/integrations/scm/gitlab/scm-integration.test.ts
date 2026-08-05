import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
	createMockGitLabCommitStatusResponse,
	createMockGitLabMergeRequestPayload,
	createMockGitLabMergeRequestResponse,
	createMockProjectConfig,
	createMockScmEvent,
} from '../../../../helpers/factories.js';

// Only the persona-credential seam is stubbed. `withGitLabToken` is spied but still
// establishes the *real* async-context scope, so a read test can assert both the
// token the class chose to bind and the `PRIVATE-TOKEN` header the underlying
// request went out with — the two halves of "this read ran as that persona".
vi.mock('@/integrations/scm/gitlab/client.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@/integrations/scm/gitlab/client.js')>();
	return { ...actual, withGitLabToken: vi.fn(actual.withGitLabToken) };
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

import { GitLabApiError, withGitLabToken } from '@/integrations/scm/gitlab/client.js';
import { getGitLabToken, getGitLabTokenOrNull } from '@/integrations/scm/gitlab/credentials.js';
import {
	getGitLabPersonaForLogin,
	isSwarmGitLabActor,
	resolveGitLabPersonaIdentities,
} from '@/integrations/scm/gitlab/personas.js';
import { GitLabSCMIntegration } from '@/integrations/scm/gitlab/scm-integration.js';
import { SWARM_GENERATED_FOOTER } from '@/scm/swarm-origin.js';
import type { ScmPersonaIdentities } from '@/scm/types.js';

const project = createMockProjectConfig();
const IDENTITIES: ScmPersonaIdentities = { implementer: 'swarm-impl', reviewer: 'swarm-rev' };

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

	// Every contract method a later phase owns must fail loudly and name that
	// phase — never return a misleading `null`/`[]`/no-op that a caller would
	// mistake for a real answer (issue #295).
	describe('deferred contract methods', () => {
		const deferred: Array<[method: string, phase: string, call: () => unknown]> = [
			['commentOnPullRequest', 'phase 4/4', () => scm.commentOnPullRequest()],
			['deliveryProvider', 'phase 4/4', () => scm.deliveryProvider()],
			['operatorDeliveryProvider', 'phase 4/4', () => scm.operatorDeliveryProvider()],
			['mergePullRequest', 'phase 4/4', () => scm.mergePullRequest()],
		];

		for (const [method, phase, call] of deferred) {
			it(`${method} throws naming itself and ${phase}`, async () => {
				// Sync methods throw, async ones reject — assert on whichever happens.
				const thrown = await Promise.resolve()
					.then(call)
					.then(
						() => null,
						(err: unknown) => err,
					);

				expect(String(thrown)).toContain(`${method}() is not implemented yet`);
				expect(String(thrown)).toContain(phase);
				expect(String(thrown)).toContain('issue #295');
			});
		}
	});
});
