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

	it('registers exactly once, alongside GitHub and GitLab', () => {
		expect(listSCMProviders().map((m) => m.id)).toEqual(['github', 'bitbucket', 'gitlab']);
	});

	it('declares the expected identity and its served webhook route', () => {
		expect(bitbucketScmManifest).toMatchObject({
			id: 'bitbucket',
			label: 'Bitbucket',
			category: 'scm',
			webhookRoute: '/bitbucket/webhook',
		});
	});

	// The flip issue #618 exists for: the contract has been complete since issue #296
	// phase 4/4, and this is what makes `requireProjectSCMProvider` route a project
	// naming `bitbucket` here and the receiver mount `/bitbucket/webhook`.
	it('declares itself ready to carry runtime traffic', () => {
		expect(bitbucketScmManifest.runtimeReady).toBe(true);
		expect(isRuntimeReadySCMProvider(bitbucketScmManifest)).toBe(true);
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
			'listPullRequestsForCommit',
			'listConflictCandidates',
			'commentOnPullRequest',
			'deliveryProvider',
			'mergePullRequest',
		] as const) {
			expect(provider?.[member], member).toBeTypeOf('function');
		}
	});
});
