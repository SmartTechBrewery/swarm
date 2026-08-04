import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProjectConfig, createMockScmEvent } from '../../../../helpers/factories.js';

vi.mock('@/integrations/scm/bitbucket/client.js', () => ({
	// Pass-through so a probe inside the scope can observe the credential that
	// would have been bound, without a real API call.
	withBitbucketCredential: vi.fn(
		(_credential: string, fn: () => Promise<unknown>): Promise<unknown> => fn(),
	),
}));
vi.mock('@/integrations/scm/bitbucket/credentials.js', () => ({
	getBitbucketCredential: vi.fn<(project: unknown, persona: string) => Promise<string>>(),
	getBitbucketCredentialOrNull:
		vi.fn<(project: unknown, persona: string) => Promise<string | null>>(),
}));
vi.mock('@/integrations/scm/bitbucket/personas.js', () => ({
	resolveBitbucketPersonaIdentities: vi.fn(),
	isSwarmBitbucketActor: vi.fn(),
	getBitbucketPersonaForLogin: vi.fn(),
}));

import { withBitbucketCredential } from '@/integrations/scm/bitbucket/client.js';
import {
	getBitbucketCredential,
	getBitbucketCredentialOrNull,
} from '@/integrations/scm/bitbucket/credentials.js';
import {
	getBitbucketPersonaForLogin,
	isSwarmBitbucketActor,
	resolveBitbucketPersonaIdentities,
} from '@/integrations/scm/bitbucket/personas.js';
import { BitbucketSCMIntegration } from '@/integrations/scm/bitbucket/scm-integration.js';
import { SWARM_GENERATED_FOOTER } from '@/scm/swarm-origin.js';
import type { ScmPersonaIdentities } from '@/scm/types.js';

const project = createMockProjectConfig();
const IDENTITIES: ScmPersonaIdentities = { implementer: 'swarm-impl', reviewer: 'swarm-rev' };

describe('BitbucketSCMIntegration', () => {
	const scm = new BitbucketSCMIntegration();

	beforeEach(() => {
		vi.mocked(getBitbucketCredential).mockReset();
		vi.mocked(getBitbucketCredentialOrNull).mockReset();
		vi.mocked(withBitbucketCredential).mockClear();
	});

	it('declares itself as the bitbucket SCM provider', () => {
		expect(scm.type).toBe('bitbucket');
		expect(scm.category).toBe('scm');
	});

	describe('hasIntegration', () => {
		it('is an OR over the two persona credentials', async () => {
			vi.mocked(getBitbucketCredentialOrNull).mockImplementation(async (_p, persona) =>
				persona === 'reviewer' ? 'cred-rev' : null,
			);

			await expect(scm.hasIntegration(project)).resolves.toBe(true);
		});

		it('is false only when neither persona resolves', async () => {
			vi.mocked(getBitbucketCredentialOrNull).mockResolvedValue(null);

			await expect(scm.hasIntegration(project)).resolves.toBe(false);
		});
	});

	describe('hasPersonaToken', () => {
		it('reports per persona', async () => {
			vi.mocked(getBitbucketCredentialOrNull).mockImplementation(async (_p, persona) =>
				persona === 'implementer' ? 'cred-impl' : null,
			);

			await expect(scm.hasPersonaToken(project, 'implementer')).resolves.toBe(true);
			await expect(scm.hasPersonaToken(project, 'reviewer')).resolves.toBe(false);
		});
	});

	describe('withPersonaCredentials', () => {
		it('binds the requested persona’s own credential', async () => {
			vi.mocked(getBitbucketCredential).mockImplementation(async (_p, persona) =>
				persona === 'implementer' ? 'cred-impl' : 'cred-rev',
			);

			await scm.withPersonaCredentials(project, 'reviewer', async () => undefined);

			expect(vi.mocked(getBitbucketCredential)).toHaveBeenCalledWith(project, 'reviewer');
			expect(vi.mocked(withBitbucketCredential).mock.calls[0]?.[0]).toBe('cred-rev');
		});

		it('runs fn inside the scope and returns its value', async () => {
			vi.mocked(getBitbucketCredential).mockResolvedValue('cred-impl');

			await expect(
				scm.withPersonaCredentials(project, 'implementer', async () => 'done'),
			).resolves.toBe('done');
		});

		it('throws before running fn when the credential is missing', async () => {
			vi.mocked(getBitbucketCredential).mockRejectedValue(new Error('No Bitbucket implementer'));
			const fn = vi.fn(async () => 'never');

			await expect(scm.withPersonaCredentials(project, 'implementer', fn)).rejects.toThrow(
				/No Bitbucket implementer/,
			);
			expect(fn).not.toHaveBeenCalled();
		});
	});

	describe('persona identity + actor resolution', () => {
		it('delegates identity resolution to the cached resolver', async () => {
			vi.mocked(resolveBitbucketPersonaIdentities).mockResolvedValue(IDENTITIES);

			await expect(scm.resolvePersonaIdentities(project)).resolves.toEqual(IDENTITIES);
			expect(vi.mocked(resolveBitbucketPersonaIdentities)).toHaveBeenCalledWith(project);
		});

		it('delegates actor → persona mapping', () => {
			vi.mocked(getBitbucketPersonaForLogin).mockReturnValue('reviewer');

			expect(scm.personaForActor('swarm-rev', IDENTITIES)).toBe('reviewer');
			expect(vi.mocked(getBitbucketPersonaForLogin)).toHaveBeenCalledWith('swarm-rev', IDENTITIES);
		});

		it('delegates the SWARM-actor check', () => {
			vi.mocked(isSwarmBitbucketActor).mockReturnValue(true);

			expect(scm.isSwarmActor('swarm-impl', IDENTITIES)).toBe(true);
			expect(vi.mocked(isSwarmBitbucketActor)).toHaveBeenCalledWith('swarm-impl', IDENTITIES);
		});
	});

	// The four webhook-ingress methods delegate to `./webhook.ts`, whose own suite
	// covers the header names, every event-key mapping, and the signature framing.
	// These assert only that the contract methods are wired to it rather than still
	// throwing their phase-1 stub.
	describe('webhook ingress', () => {
		it('reads Bitbucket headers through the provider', () => {
			const headers: Record<string, string> = {
				'x-event-key': 'pullrequest:created',
				'x-request-uuid': 'req-1',
				'x-hub-signature': 'sha256=deadbeef',
			};
			expect(scm.readWebhookRequest((name) => headers[name.toLowerCase()])).toEqual({
				eventName: 'pullrequest:created',
				deliveryId: 'req-1',
				signature: 'sha256=deadbeef',
			});
		});

		it('verifies a correctly signed body and rejects a forged one', () => {
			const rawBody = '{"pullrequest":{"id":17}}';
			const secret = 'sh4red-s3cret';
			const valid = `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;

			expect(scm.verifyWebhookSignature(rawBody, valid, secret)).toBe(true);
			expect(scm.verifyWebhookSignature(rawBody, valid, 'other-secret')).toBe(false);
			expect(scm.verifyWebhookSignature(rawBody, '', secret)).toBe(false);
		});

		it('normalizes a supported event key and drops an unsupported one', () => {
			const payload = {
				repository: { full_name: 'jkwiecien/swarm' },
				pullrequest: { id: 17 },
			};
			expect(scm.parseWebhookEvent('pullrequest:created', payload)).toMatchObject({
				kind: 'pull-request',
				action: 'opened',
				workItemId: '17',
			});
			expect(scm.parseWebhookEvent('repo:push', payload)).toBeNull();
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

	// Every contract method a later phase owns must fail loudly and name that
	// phase — never return a misleading `null`/`[]`/no-op that a caller
	// would mistake for a real answer (issue #296).
	describe('deferred contract methods', () => {
		const deferred: Array<[method: string, phase: string, call: () => unknown]> = [
			['getPullRequest', 'phase 3/4', () => scm.getPullRequest()],
			['getPullRequestTitle', 'phase 3/4', () => scm.getPullRequestTitle()],
			['getAggregateCheckStatus', 'phase 3/4', () => scm.getAggregateCheckStatus()],
			['listConflictCandidates', 'phase 3/4', () => scm.listConflictCandidates()],
			['commentOnPullRequest', 'phase 4/4', () => scm.commentOnPullRequest()],
			['deliveryProvider', 'phase 4/4', () => scm.deliveryProvider()],
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
				expect(String(thrown)).toContain('issue #296');
			});
		}
	});
});
