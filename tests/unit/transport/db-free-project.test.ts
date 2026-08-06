import { describe, expect, it } from 'vitest';

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
		// The placeholder is a fixed sentinel, never a real secret reference.
		expect(reconstructed.credentials).toEqual({
			reviewer: 'db-free-unused',
			webhookSecret: 'db-free-unused',
		});
	});

	it('does not carry the original credential references onto the reconstructed config', () => {
		const project = createMockProjectConfig({
			credentials: {
				reviewer: 'REAL_REVIEWER_REF',
				webhookSecret: 'REAL_WEBHOOK_REF',
			},
		});
		const reconstructed = reconstructProjectConfig(
			toNonSecretProjectConfig(project),
			'/remote-worker/swarm',
		);

		expect(reconstructed.credentials.reviewer).not.toBe('REAL_REVIEWER_REF');
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
