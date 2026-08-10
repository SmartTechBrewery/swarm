import { describe, expect, it } from 'vitest';
// Importing the entrypoint is what a real runtime surface does; it triggers the
// github SCM side-effect registration. Vitest isolates module state per test
// file, so this registration is independent of registry.test.ts's resets.
import '@/integrations/entrypoint.js';
import { githubScmManifest } from '@/integrations/scm/github/index.js';
import { isRuntimeReadySCMProvider } from '@/integrations/scm/manifest.js';
import { getSCMProvider, listSCMProviders } from '@/integrations/scm/registry.js';

describe('github SCM manifest registration', () => {
	it('registers itself into the registry via the entrypoint import', () => {
		expect(getSCMProvider('github')).toBe(githubScmManifest);
	});

	it('registers exactly once, and stays runtime-ready alongside Bitbucket and GitLab', () => {
		const registered = listSCMProviders();
		expect(registered.filter((m) => m.id === 'github')).toHaveLength(1);
		// Bitbucket joined it as a runtime-ready provider with issue #618 and GitLab with
		// #619. GitHub carrying traffic is what must not regress here — a project on
		// GitHub still resolves to it.
		expect(registered.filter(isRuntimeReadySCMProvider).map((m) => m.id)).toEqual([
			'github',
			'bitbucket',
			'gitlab',
		]);
	});

	it('declares the expected identity, and claims runtime readiness by omission', () => {
		expect(githubScmManifest).toMatchObject({
			id: 'github',
			label: 'GitHub',
			category: 'scm',
		});
		expect(isRuntimeReadySCMProvider(githubScmManifest)).toBe(true);
	});

	it('exposes a provider that satisfies the SCMProvider contract without naming the class', () => {
		// The registry's whole point: a consumer resolves the contract by id and
		// never imports GitHubSCMIntegration (ai/RULES.md §2).
		const provider = getSCMProvider('github')?.provider;
		expect(provider).toMatchObject({ type: 'github', category: 'scm' });
		for (const member of [
			'hasIntegration',
			'hasPersonaToken',
			'withPersonaCredentials',
			'resolvePersonaIdentities',
			'personaForActor',
			'isSwarmActor',
			'verifyWebhookSignature',
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
