import { describe, expect, it } from 'vitest';
import { ProjectConfigBaseSchema } from '@/config/schema.js';
import {
	SERVER_ONLY_KEYS,
	toWorkerConfig,
	WORKER_SAFE_KEYS,
	WorkerProjectConfigSchema,
} from '@/config/worker-config.js';
import { requireGitHubProjectsConfig } from '@/integrations/pm/github-projects/config-schema.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

describe('toWorkerConfig', () => {
	it('excludes the secret-bearing credentials block', () => {
		const worker = toWorkerConfig(createMockProjectConfig());
		expect('credentials' in worker).toBe(false);
	});

	it('leaks no credential reference or webhook secret into the projection', () => {
		// Both credential shapes: the per-provider references the runtime resolves
		// (`credentials.scm`, issue #628) and the legacy pair a migrated project still carries.
		const project = createMockProjectConfig({
			scm: 'gitlab',
			credentials: {
				reviewer: 'LEGACY_REVIEWER_REF',
				webhookSecret: 'LEGACY_WEBHOOK_REF',
				scm: {
					github: { reviewer: 'GH_REVIEWER_REF', webhookSecret: 'GH_WEBHOOK_REF' },
					gitlab: { reviewer: 'GL_REVIEWER_REF', webhookSecret: 'GL_WEBHOOK_REF' },
				},
				pm: { 'github-projects': { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' } },
			},
		});
		const serialized = JSON.stringify(toWorkerConfig(project));
		for (const reference of [
			'LEGACY_REVIEWER_REF',
			'LEGACY_WEBHOOK_REF',
			'GH_REVIEWER_REF',
			'GH_WEBHOOK_REF',
			'GL_REVIEWER_REF',
			'GL_WEBHOOK_REF',
			'PM_GITHUB_PROJECTS_TOKEN',
		]) {
			expect(serialized).not.toContain(reference);
		}
	});

	it('excludes every server-only field', () => {
		const worker = toWorkerConfig(createMockProjectConfig()) as Record<string, unknown>;
		for (const key of SERVER_ONLY_KEYS) {
			expect(key in worker).toBe(false);
		}
	});

	it('strips the board mapping along with the pm block it now lives under', () => {
		const project = createMockProjectConfig();
		const pm = requireGitHubProjectsConfig(project);
		const worker = toWorkerConfig(project) as Record<string, unknown>;
		expect('pm' in worker).toBe(false);
		// Since issue #495 the board's opaque node ids live *inside* `pm`, so dropping
		// the block is what keeps them off the wire — there is no sibling key left that
		// could carry them to a worker.
		const serialized = JSON.stringify(worker);
		for (const boardId of [pm.projectId, pm.statusFieldId]) {
			expect(serialized).not.toContain(boardId);
		}
	});

	it('preserves every worker-safe field value-for-value', () => {
		const project = createMockProjectConfig();
		const worker = toWorkerConfig(project) as Record<string, unknown>;
		for (const key of WORKER_SAFE_KEYS) {
			expect(worker[key]).toEqual((project as Record<string, unknown>)[key]);
		}
	});

	// The DB-free worker resolves its own SCM provider from the assignment's config
	// (`src/transport/assignment-execution.ts`), so the discriminator has to survive
	// the projection — and stay absent when the project states none (issue #478).
	it("carries the project's scm discriminator, and omits it when unstated", () => {
		expect(toWorkerConfig(createMockProjectConfig({ scm: 'bitbucket' })).scm).toBe('bitbucket');
		expect(toWorkerConfig(createMockProjectConfig()).scm).toBeUndefined();
	});

	it('returns a fresh object and does not mutate the source (local path intact)', () => {
		const project = createMockProjectConfig();
		const worker = toWorkerConfig(project);
		expect(worker).not.toBe(project);
		// The full config the local / single-user path relies on is untouched.
		expect(project.credentials.reviewer).toBe('SCM_TOKEN_REVIEWER');
		expect(project.pm).toBeDefined();
	});
});

describe('worker/server key classification', () => {
	it('classifies every ProjectConfig field exactly once (drift guard)', () => {
		const classified = [...WORKER_SAFE_KEYS, ...SERVER_ONLY_KEYS];
		// Disjoint: no field is both worker-safe and server-only.
		expect(new Set(classified).size).toBe(classified.length);
		// Exhaustive: every field on the live schema is classified, so a future
		// ProjectConfig field forces a conscious safe-vs-server decision here.
		expect(new Set(classified)).toEqual(new Set(Object.keys(ProjectConfigBaseSchema.shape)));
	});

	it('exposes exactly the worker-safe keys on the projection schema', () => {
		expect(new Set(Object.keys(WorkerProjectConfigSchema.shape))).toEqual(
			new Set(WORKER_SAFE_KEYS),
		);
	});

	// Issue #686: the routing token is board-side config, and which repository a card
	// claims is a control-plane decision keyed on the whole repository list — so it
	// belongs with `pm` on the server side rather than travelling to a worker.
	it('keeps the repository routing token off the worker payload', () => {
		expect(SERVER_ONLY_KEYS as readonly string[]).toContain('pmRoutingToken');
		const worker = toWorkerConfig({
			...createMockProjectConfig(),
			pmRoutingToken: 'component-1',
		}) as Record<string, unknown>;
		expect('pmRoutingToken' in worker).toBe(false);
	});

	// The projection is built from the *scoped* config (issue #684), which carries one
	// repository's settings and no list — so a worker structurally cannot be handed the
	// other repositories a project owns, whatever the allowlist says.
	it('carries one repository, never the project’s repository list', () => {
		const worker = toWorkerConfig(createMockProjectConfig()) as Record<string, unknown>;
		expect(worker.repo).toBe('SmartTechBrewery/swarm');
		expect('repositories' in worker).toBe(false);
		expect(WORKER_SAFE_KEYS as readonly string[]).not.toContain('repositories');
		expect(Object.keys(ProjectConfigBaseSchema.shape)).not.toContain('repositories');
	});
});
