import { describe, expect, it } from 'vitest';

import {
	NonSecretProjectConfigSchema,
	toNonSecretProjectConfig,
} from '@/config/project-config-slice.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

describe('toNonSecretProjectConfig', () => {
	it('drops credentials and the control-plane repoRoot, preserving every transport field', () => {
		const project = createMockProjectConfig();
		const slice = toNonSecretProjectConfig(project);

		expect('credentials' in slice).toBe(false);
		expect('repoRoot' in slice).toBe(false);

		const { credentials: _credentials, repoRoot: _repoRoot, ...rest } = project;
		expect(slice).toEqual(rest);
	});

	it('returns a value that parses cleanly through the slice schema', () => {
		const slice = toNonSecretProjectConfig(createMockProjectConfig());
		expect(NonSecretProjectConfigSchema.safeParse(slice).success).toBe(true);
	});

	it('preserves the credential reference values nowhere in the slice', () => {
		const project = createMockProjectConfig({
			credentials: {
				reviewer: 'SENTINEL_REVIEWER_REF',
				webhookSecret: 'SENTINEL_WEBHOOK_REF',
			},
		});
		const serialized = JSON.stringify(toNonSecretProjectConfig(project));
		expect(serialized).not.toContain('SENTINEL_REVIEWER_REF');
		expect(serialized).not.toContain('SENTINEL_WEBHOOK_REF');
	});
});

describe('NonSecretProjectConfigSchema', () => {
	it('strips a credentials key rather than rejecting it (omit drops the field)', () => {
		const project = createMockProjectConfig();
		const parsed = NonSecretProjectConfigSchema.parse(project);
		expect('credentials' in parsed).toBe(false);
		expect('repoRoot' in parsed).toBe(false);
		expect(parsed.id).toBe(project.id);
	});
});
