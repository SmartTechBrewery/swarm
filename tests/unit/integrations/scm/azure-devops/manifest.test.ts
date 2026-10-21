import { describe, expect, it } from 'vitest';
// Importing the entrypoint is what a real runtime surface does; it triggers the
// azure-devops SCM side-effect registration. Vitest isolates module state per test
// file, so this registration is independent of registry.test.ts's resets.
import '@/integrations/entrypoint.js';
import { azureDevOpsScmManifest } from '@/integrations/scm/azure-devops/index.js';
import { AzureDevOpsSCMIntegration } from '@/integrations/scm/azure-devops/scm-integration.js';
import { isRuntimeReadySCMProvider } from '@/integrations/scm/manifest.js';
import {
	getSCMProvider,
	listInstanceDefaultScmRoles,
	listSCMProviders,
} from '@/integrations/scm/registry.js';

describe('azure-devops SCM manifest registration', () => {
	it('registers itself into the registry via the entrypoint import', () => {
		expect(getSCMProvider('azure-devops')).toBe(azureDevOpsScmManifest);
	});

	it('registers exactly once, after the three existing providers', () => {
		expect(listSCMProviders().map((m) => m.id)).toEqual([
			'github',
			'bitbucket',
			'gitlab',
			'azure-devops',
		]);
	});

	it('declares the expected identity and its (not yet served) webhook route', () => {
		expect(azureDevOpsScmManifest).toMatchObject({
			id: 'azure-devops',
			label: 'Azure DevOps',
			category: 'scm',
			webhookRoute: '/azure-devops/webhook',
		});
	});

	// Issue #1089 phase 5/6 registers the complete contract; phase 6/6 serves the route
	// and flips this. Until then no project routes here and no instance default is offered.
	it('does not carry runtime traffic yet', () => {
		expect(azureDevOpsScmManifest.runtimeReady).toBe(false);
		expect(isRuntimeReadySCMProvider(azureDevOpsScmManifest)).toBe(false);
		expect(listInstanceDefaultScmRoles().map((entry) => entry.providerId)).not.toContain(
			'azure-devops',
		);
	});

	it('declares its own credential reference names', () => {
		expect(azureDevOpsScmManifest.credentialRoles).toEqual([
			{ role: 'reviewer', envVarKey: 'AZURE_DEVOPS_TOKEN_REVIEWER', instanceDefault: true },
			{ role: 'webhookSecret', envVarKey: 'AZURE_DEVOPS_WEBHOOK_SECRET' },
		]);
	});

	it('exposes the provider without naming the class', () => {
		const provider = getSCMProvider('azure-devops')?.provider;
		expect(provider).toBeInstanceOf(AzureDevOpsSCMIntegration);
		expect(provider).toMatchObject({ type: 'azure-devops', category: 'scm' });
	});
});
