import { describe, expect, it } from 'vitest';
// Importing the entrypoint is what a real runtime surface does; it triggers the
// bitbucket SCM side-effect registration. Vitest isolates module state per test
// file, so this registration is independent of registry.test.ts's resets.
import '@/integrations/entrypoint.js';
import { bitbucketScmManifest } from '@/integrations/scm/bitbucket/index.js';
import { BitbucketSCMIntegration } from '@/integrations/scm/bitbucket/scm-integration.js';
import { isRuntimeReadySCMProvider } from '@/integrations/scm/manifest.js';
import { getSCMProvider, listSCMProviders } from '@/integrations/scm/registry.js';

describe('bitbucket SCM manifest registration', () => {
	it('registers itself into the registry via the entrypoint import', () => {
		expect(getSCMProvider('bitbucket')).toBe(bitbucketScmManifest);
	});

	it('registers exactly once, alongside GitHub', () => {
		expect(listSCMProviders().map((m) => m.id)).toEqual(['github', 'bitbucket']);
	});

	it('declares the expected identity and its future webhook route', () => {
		expect(bitbucketScmManifest).toMatchObject({
			id: 'bitbucket',
			label: 'Bitbucket',
			category: 'scm',
			webhookRoute: '/bitbucket/webhook',
		});
	});

	// The contract is complete (issue #296 phase 4/4), and this still holds:
	// discoverable by id, but not answering for any project and not served a webhook
	// route, because nothing selects a project's SCM provider yet.
	it('opts out of runtime traffic', () => {
		expect(bitbucketScmManifest.runtimeReady).toBe(false);
		expect(isRuntimeReadySCMProvider(bitbucketScmManifest)).toBe(false);
	});

	it('exposes a provider that satisfies the SCMProvider contract without naming the class', () => {
		// The registry's whole point: a consumer resolves the contract by id and
		// never imports BitbucketSCMIntegration (ai/RULES.md §2).
		const provider = getSCMProvider('bitbucket')?.provider;
		expect(provider).toBeInstanceOf(BitbucketSCMIntegration);
		expect(provider).toMatchObject({ type: 'bitbucket', category: 'scm' });
		for (const member of [
			'hasIntegration',
			'hasPersonaToken',
			'withPersonaCredentials',
			'resolvePersonaIdentities',
			'personaForActor',
			'isSwarmActor',
			'verifyWebhookSignature',
			'readWebhookRequest',
			'parseWebhookEvent',
			'isSwarmGeneratedEvent',
			'getPullRequest',
			'getPullRequestTitle',
			'getAggregateCheckStatus',
			'listConflictCandidates',
			'commentOnPullRequest',
			'deliveryProvider',
			'mergePullRequest',
		] as const) {
			expect(provider?.[member], member).toBeTypeOf('function');
		}
	});
});
