import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProjectConfig } from '../../helpers/factories.js';

vi.mock('@/db/repositories/projectsRepository.js', () => ({
	upsertProjectToDb: vi.fn(async () => undefined),
}));
vi.mock('@/db/repositories/credentialsRepository.js', () => ({
	writeProjectCredential: vi.fn(async () => undefined),
}));
vi.mock('@/harness/quota-discovery.js', () => ({
	discoverCliQuotas: vi.fn(async () => []),
}));
vi.mock('@/db/repositories/cliQuotasRepository.js', () => ({
	upsertCliQuota: vi.fn(async () => undefined),
}));

import { applyConfig } from '@/config/apply.js';
import { SwarmConfigSchema } from '@/config/schema.js';
import { writeProjectCredential } from '@/db/repositories/credentialsRepository.js';
import { upsertProjectToDb } from '@/db/repositories/projectsRepository.js';

const project = createMockProjectConfig({
	id: 'proj-1',
	credentials: {
		reviewer: 'REV_KEY',
		webhookSecret: 'HOOK_KEY',
	},
});
const config = SwarmConfigSchema.parse({ projects: [project] });

describe('applyConfig', () => {
	beforeEach(() => {
		vi.mocked(upsertProjectToDb).mockClear();
		vi.mocked(writeProjectCredential).mockClear();
		process.env.REV_KEY = 'test-token-reviewer';
		process.env.HOOK_KEY = 'whsec';
	});

	afterEach(() => {
		delete process.env.REV_KEY;
		delete process.env.HOOK_KEY;
	});

	it('upserts each project and stores every referenced credential from the environment', async () => {
		const result = await applyConfig(config);

		expect(upsertProjectToDb).toHaveBeenCalledWith(project);
		expect(result.projects).toEqual(['proj-1']);
		// The implementer persona is worker-local (SWARM_OPERATOR_GH_TOKEN), never a
		// project credential, so only reviewer + webhookSecret are stored (issue #396).
		expect(result.credentialsWritten).toBe(2);
		expect(result.credentialsSkipped).toEqual([]);
		expect(writeProjectCredential).toHaveBeenCalledWith('proj-1', 'REV_KEY', 'test-token-reviewer');
		expect(writeProjectCredential).toHaveBeenCalledWith('proj-1', 'HOOK_KEY', 'whsec');
	});

	it('writes the project row before its credentials (FK-safety ordering)', async () => {
		await applyConfig(config);

		// project_credentials.project_id FKs the project row, so upsertProjectToDb
		// must run before any writeProjectCredential for that project.
		const projectOrder = vi.mocked(upsertProjectToDb).mock.invocationCallOrder[0];
		const firstCredentialOrder = vi.mocked(writeProjectCredential).mock.invocationCallOrder[0];
		expect(projectOrder).toBeLessThan(firstCredentialOrder);
	});

	it('skips (does not write) a credential reference whose env var is unset', async () => {
		delete process.env.REV_KEY;

		const result = await applyConfig(config);

		expect(result.credentialsWritten).toBe(1);
		expect(result.credentialsSkipped).toEqual(['proj-1/REV_KEY']);
		expect(writeProjectCredential).not.toHaveBeenCalledWith('proj-1', 'REV_KEY', expect.anything());
	});

	it('treats an empty-string env var as unset', async () => {
		process.env.HOOK_KEY = '';

		const result = await applyConfig(config);

		expect(result.credentialsSkipped).toEqual(['proj-1/HOOK_KEY']);
	});

	it('dedupes references so a key shared by two credentials is written once', async () => {
		const shared = createMockProjectConfig({
			id: 'proj-2',
			credentials: { reviewer: 'SHARED', webhookSecret: 'SHARED' },
		});
		process.env.SHARED = 'test-token-shared';

		const result = await applyConfig(SwarmConfigSchema.parse({ projects: [shared] }));

		expect(result.credentialsWritten).toBe(1);
		expect(
			vi.mocked(writeProjectCredential).mock.calls.filter(([, key]) => key === 'SHARED'),
		).toHaveLength(1);
		delete process.env.SHARED;
	});

	// The PM provider's role map is a nested record beside the SCM references
	// (issue #497), so its values are references too and must be applied the same way.
	it("stores the PM provider's credential references from the environment", async () => {
		const withPmReferences = createMockProjectConfig({
			id: 'proj-4',
			repo: 'owner/pm',
			credentials: {
				reviewer: 'REV_KEY',
				webhookSecret: 'HOOK_KEY',
				pm: { webhookSecret: 'PM_HOOK_KEY' },
			},
		});
		process.env.PM_HOOK_KEY = 'pm-whsec';

		const result = await applyConfig(SwarmConfigSchema.parse({ projects: [withPmReferences] }));

		expect(result.credentialsWritten).toBe(3);
		expect(writeProjectCredential).toHaveBeenCalledWith('proj-4', 'PM_HOOK_KEY', 'pm-whsec');
		delete process.env.PM_HOOK_KEY;
	});

	// Issue #628: `credentials.scm` is a nested record too, one block per provider, so
	// every provider's references are applied — including a provider the project retains
	// but is not currently running on, which is what makes switching back reversible.
	it("stores every SCM provider's credential references from the environment", async () => {
		const multiProvider = createMockProjectConfig({
			id: 'proj-5',
			repo: 'owner/multi',
			scm: 'gitlab',
			credentials: {
				scm: {
					github: { reviewer: 'GH_REVIEWER', webhookSecret: 'GH_HOOK' },
					gitlab: { reviewer: 'GL_REVIEWER', webhookSecret: 'GL_HOOK' },
				},
				pm: { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' },
			},
		});
		for (const key of ['GH_REVIEWER', 'GH_HOOK', 'GL_REVIEWER', 'GL_HOOK']) {
			process.env[key] = `value-of-${key}`;
		}
		process.env.PM_GITHUB_PROJECTS_TOKEN = 'pm-token';

		try {
			const result = await applyConfig(SwarmConfigSchema.parse({ projects: [multiProvider] }));

			expect(result.credentialsWritten).toBe(5);
			expect(writeProjectCredential).toHaveBeenCalledWith('proj-5', 'GH_HOOK', 'value-of-GH_HOOK');
			expect(writeProjectCredential).toHaveBeenCalledWith('proj-5', 'GL_HOOK', 'value-of-GL_HOOK');
		} finally {
			for (const key of ['GH_REVIEWER', 'GH_HOOK', 'GL_REVIEWER', 'GL_HOOK']) {
				delete process.env[key];
			}
			delete process.env.PM_GITHUB_PROJECTS_TOKEN;
		}
	});

	// A migrated project names the same two keys twice — once under the legacy pair, once
	// under `credentials.scm` — and must still write each row exactly once.
	it('dedupes a migrated project’s legacy pair against its per-provider references', async () => {
		const result = await applyConfig(config);

		expect(project.credentials.scm?.github).toEqual({
			reviewer: 'REV_KEY',
			webhookSecret: 'HOOK_KEY',
		});
		expect(result.credentialsWritten).toBe(2);
	});

	it('applies every project in the config', async () => {
		const other = createMockProjectConfig({ id: 'proj-3', repo: 'owner/other' });
		const result = await applyConfig(SwarmConfigSchema.parse({ projects: [project, other] }));

		expect(upsertProjectToDb).toHaveBeenCalledTimes(2);
		expect(result.projects).toEqual(['proj-1', 'proj-3']);
	});
});
