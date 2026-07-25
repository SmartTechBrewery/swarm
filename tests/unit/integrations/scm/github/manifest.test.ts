import { describe, expect, it } from 'vitest';
// Importing the entrypoint is what a real runtime surface does; it triggers the
// github SCM side-effect registration. Vitest isolates module state per test
// file, so this registration is independent of registry.test.ts's resets.
import '@/integrations/entrypoint.js';
import { githubScmManifest } from '@/integrations/scm/github/index.js';
import { getSCMProvider, listSCMProviders } from '@/integrations/scm/registry.js';

describe('github SCM manifest registration', () => {
	it('registers itself into the registry via the entrypoint import', () => {
		expect(getSCMProvider('github')).toBe(githubScmManifest);
	});

	it('registers exactly once (the entrypoint has one SCM provider today)', () => {
		expect(listSCMProviders().map((m) => m.id)).toEqual(['github']);
	});

	it('declares the expected identity', () => {
		expect(githubScmManifest).toMatchObject({
			id: 'github',
			label: 'GitHub',
			category: 'scm',
		});
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
			'getPullRequestAuthor',
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
