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

	it('declares the expected identity and its served webhook route', () => {
		expect(azureDevOpsScmManifest).toMatchObject({
			id: 'azure-devops',
			label: 'Azure DevOps',
			category: 'scm',
			webhookRoute: '/azure-devops/webhook',
		});
	});

	// The flip issue #1089 phase 6/6 owns: the contract has been complete since phase 5/6,
	// and this is what makes it reachable — `requireProjectSCMProvider` routes a project
	// stating `"scm": "azure-devops"` here, the receiver mounts the route above, and the
	// reviewer role becomes eligible for an installation-wide default.
	it('carries runtime traffic', () => {
		expect(azureDevOpsScmManifest.runtimeReady).toBe(true);
		expect(isRuntimeReadySCMProvider(azureDevOpsScmManifest)).toBe(true);
		expect(listInstanceDefaultScmRoles()).toContainEqual(
			expect.objectContaining({ providerId: 'azure-devops', role: 'reviewer' }),
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
