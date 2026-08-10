import { describe, expect, it } from 'vitest';
// Importing the entrypoint is what a real runtime surface does; it triggers the
// gitlab SCM side-effect registration. Vitest isolates module state per test file,
// so this registration is independent of registry.test.ts's resets.
import '@/integrations/entrypoint.js';
import { gitlabScmManifest } from '@/integrations/scm/gitlab/index.js';
import { GitLabSCMIntegration } from '@/integrations/scm/gitlab/scm-integration.js';
import { isRuntimeReadySCMProvider } from '@/integrations/scm/manifest.js';
import { getSCMProvider, listSCMProviders } from '@/integrations/scm/registry.js';

describe('gitlab SCM manifest registration', () => {
	it('registers itself into the registry via the entrypoint import', () => {
		expect(getSCMProvider('gitlab')).toBe(gitlabScmManifest);
	});

	it('registers exactly once, alongside GitHub and Bitbucket', () => {
		expect(listSCMProviders().map((m) => m.id)).toEqual(['github', 'bitbucket', 'gitlab']);
	});

	it('declares the expected identity and its served webhook route', () => {
		expect(gitlabScmManifest).toMatchObject({
			id: 'gitlab',
			label: 'GitLab',
			category: 'scm',
			webhookRoute: '/gitlab/webhook',
		});
	});

	// The flip issue #619 owns: the contract has been complete since issue #295 phase
	// 4/4, and this is what makes it reachable — `requireProjectSCMProvider` routes a
	// project stating `"scm": "gitlab"` here, and the receiver mounts the route above.
	it('carries runtime traffic', () => {
		expect(gitlabScmManifest.runtimeReady).toBe(true);
		expect(isRuntimeReadySCMProvider(gitlabScmManifest)).toBe(true);
	});

	it('exposes a provider that satisfies the SCMProvider contract without naming the class', () => {
		// The registry's whole point: a consumer resolves the contract by id and
		// never imports GitLabSCMIntegration (ai/RULES.md §2).
		const provider = getSCMProvider('gitlab')?.provider;
		expect(provider).toBeInstanceOf(GitLabSCMIntegration);
		expect(provider).toMatchObject({ type: 'gitlab', category: 'scm' });
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
			'operatorDeliveryProvider',
			'mergePullRequest',
		] as const) {
			expect(provider?.[member], member).toBeTypeOf('function');
		}
	});
});
