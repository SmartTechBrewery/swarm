import { describe, expect, it } from 'vitest';

// A DB-free worker loads the integrations entrypoint at startup
// (`src/transport/connect-entry.ts`), so the PM manifests are registered while it
// reconstructs a project config. Importing it here is what makes these tests
// exercise the same validation path a real remote worker takes (issue #537).
import '@/integrations/entrypoint.js';
import { toNonSecretProjectConfig } from '@/config/project-config-slice.js';
import { CredentialsSchema } from '@/config/schema.js';
import { reconstructProjectConfig } from '@/transport/db-free-project.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

describe('reconstructProjectConfig', () => {
	it('round-trips the non-secret slice back to a schema-valid ProjectConfig', () => {
		const project = createMockProjectConfig();
		const slice = toNonSecretProjectConfig(project);

		const reconstructed = reconstructProjectConfig(slice, '/remote-worker/swarm');

		// Every non-secret field is preserved verbatim.
		expect(reconstructed.id).toBe(project.id);
		expect(reconstructed.name).toBe(project.name);
		expect(reconstructed.repo).toBe(project.repo);
		expect(reconstructed.repoRoot).toBe('/remote-worker/swarm');
		expect(reconstructed.baseBranch).toBe(project.baseBranch);
		expect(reconstructed.pm).toEqual(project.pm);
	});

	it('fills an inert placeholder credentials block that satisfies CredentialsSchema', () => {
		const reconstructed = reconstructProjectConfig(
			toNonSecretProjectConfig(createMockProjectConfig()),
			'/remote-worker/swarm',
		);

		expect(() => CredentialsSchema.parse(reconstructed.credentials)).not.toThrow();
		// Empty since issue #628 made every credential key optional: the honest
		// representation of "this worker holds no references", and it names no key a host
		// environment could accidentally satisfy.
		expect(reconstructed.credentials).toEqual({});
	});

	it('does not carry the original credential references onto the reconstructed config', () => {
		const project = createMockProjectConfig({
			credentials: {
				scm: { github: { reviewer: 'REAL_REVIEWER_REF', webhookSecret: 'REAL_WEBHOOK_REF' } },
				pm: { apiToken: 'REAL_PM_TOKEN_REF' },
			},
		});
		const reconstructed = reconstructProjectConfig(
			toNonSecretProjectConfig(project),
			'/remote-worker/swarm',
		);

		expect(reconstructed.credentials.scm).toBeUndefined();
		expect(JSON.stringify(reconstructed)).not.toContain('REAL_REVIEWER_REF');
		expect(JSON.stringify(reconstructed)).not.toContain('REAL_WEBHOOK_REF');
	});

	// Issue #537: PM credentials are control-plane-only. A DB-free worker gets no PM
	// credential *and no PM reference either* — not even a placeholder one, which would
	// otherwise let this host's own environment resolve the role's declared env var.
	it('carries no PM credential reference at all', () => {
		const project = createMockProjectConfig({
			credentials: {
				reviewer: 'SCM_TOKEN_REVIEWER',
				webhookSecret: 'SCM_WEBHOOK_SECRET',
				pm: { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' },
			},
		});
		const reconstructed = reconstructProjectConfig(
			toNonSecretProjectConfig(project),
			'/remote-worker/swarm',
		);

		expect(reconstructed.credentials.pm).toBeUndefined();
		expect(JSON.stringify(reconstructed)).not.toContain('PM_GITHUB_PROJECTS_TOKEN');
	});

	it('replaces the control-plane repoRoot with this worker host checkout', () => {
		const project = createMockProjectConfig({ repoRoot: '/control-plane/swarm' });
		const reconstructed = reconstructProjectConfig(
			toNonSecretProjectConfig(project),
			'/remote-worker/swarm',
		);

		expect(reconstructed.repoRoot).toBe('/remote-worker/swarm');
	});
});
