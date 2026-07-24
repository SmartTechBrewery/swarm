import { describe, expect, it } from 'vitest';
import { ProjectConfigSchema } from '@/config/schema.js';
import {
	SERVER_ONLY_KEYS,
	toWorkerConfig,
	WORKER_SAFE_KEYS,
	WorkerProjectConfigSchema,
} from '@/config/worker-config.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

describe('toWorkerConfig', () => {
	it('excludes the secret-bearing credentials block', () => {
		const worker = toWorkerConfig(createMockProjectConfig());
		expect('credentials' in worker).toBe(false);
	});

	it('leaks no credential reference or webhook secret into the projection', () => {
		const project = createMockProjectConfig();
		const serialized = JSON.stringify(toWorkerConfig(project));
		for (const secret of [project.credentials.reviewer, project.credentials.webhookSecret]) {
			expect(serialized).not.toContain(secret);
		}
	});

	it('excludes every server-only field', () => {
		const worker = toWorkerConfig(createMockProjectConfig()) as Record<string, unknown>;
		for (const key of SERVER_ONLY_KEYS) {
			expect(key in worker).toBe(false);
		}
	});

	it('preserves every worker-safe field value-for-value', () => {
		const project = createMockProjectConfig();
		const worker = toWorkerConfig(project) as Record<string, unknown>;
		for (const key of WORKER_SAFE_KEYS) {
			expect(worker[key]).toEqual((project as Record<string, unknown>)[key]);
		}
	});

	it('returns a fresh object and does not mutate the source (local path intact)', () => {
		const project = createMockProjectConfig();
		const worker = toWorkerConfig(project);
		expect(worker).not.toBe(project);
		// The full config the local / single-user path relies on is untouched.
		expect(project.credentials.reviewer).toBe('SCM_TOKEN_REVIEWER');
		expect(project.githubProjects).toBeDefined();
	});
});

describe('worker/server key classification', () => {
	it('classifies every ProjectConfig field exactly once (drift guard)', () => {
		const classified = [...WORKER_SAFE_KEYS, ...SERVER_ONLY_KEYS];
		// Disjoint: no field is both worker-safe and server-only.
		expect(new Set(classified).size).toBe(classified.length);
		// Exhaustive: every field on the live schema is classified, so a future
		// ProjectConfig field forces a conscious safe-vs-server decision here.
		expect(new Set(classified)).toEqual(new Set(Object.keys(ProjectConfigSchema.shape)));
	});

	it('exposes exactly the worker-safe keys on the projection schema', () => {
		expect(new Set(Object.keys(WorkerProjectConfigSchema.shape))).toEqual(
			new Set(WORKER_SAFE_KEYS),
		);
	});
});
