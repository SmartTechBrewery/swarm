/**
 * `swarm init` writes a `swarm.config.json` template and validates it only on the
 * *next* run, so a template that no longer parses would surface as a rejected `swarm
 * config apply` rather than as a failed `init`. This suite closes that gap.
 *
 * It imports the real integrations entrypoint, because both credential cross-field
 * checks run against the *registered* manifests — the template must satisfy the roles
 * its stated providers actually declare, not just the field shape.
 */

import { describe, expect, it } from 'vitest';

import { CONFIG_TEMPLATE } from '@/cli/commands/init.js';
import { validateConfig } from '@/config/schema.js';
import '@/integrations/entrypoint.js';

describe('swarm init config template', () => {
	it('validates against SwarmConfigSchema', () => {
		expect(() => validateConfig(CONFIG_TEMPLATE)).not.toThrow();
	});

	// Required in practice since issue #618 (nothing resolves a provider without it) and,
	// since issue #628, also the key `credentials.scm` is read under.
	it('states an SCM provider and stores that provider’s own credential references', () => {
		const [project] = validateConfig(CONFIG_TEMPLATE).projects;

		expect(project?.scm).toBe('github');
		expect(project?.credentials.scm?.github).toEqual({
			reviewer: 'GITHUB_TOKEN_REVIEWER',
			webhookSecret: 'GITHUB_WEBHOOK_SECRET',
		});
	});

	// The keys the template names are the ones the GitHub manifest declares, so a fresh
	// project's `swarm config apply` reads the variables the docs tell an operator to export.
	it('names exactly the reference keys the registered GitHub manifest declares', async () => {
		const { githubScmManifest } = await import('@/integrations/scm/github/index.js');
		const [project] = validateConfig(CONFIG_TEMPLATE).projects;

		for (const spec of githubScmManifest.credentialRoles) {
			expect(project?.credentials.scm?.github?.[spec.role]).toBe(spec.envVarKey);
		}
	});
});
