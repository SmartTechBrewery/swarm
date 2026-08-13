import type { ProjectConfig } from '../../../src/config/schema.js';
import { getDb } from '../../../src/db/client.js';
import { projects } from '../../../src/db/schema/projects.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

/**
 * Seed a `projects` row for integration tests — the persisted form of the
 * `createMockProjectConfig` fixture, so seeded state and unit-test fixtures
 * describe the same project. Mirrors Cascade's `tests/integration/helpers/seed.ts`
 * `seedProject`, minus the org layer (ai/ARCHITECTURE.md "Single-user scope").
 */
export async function seedProject(overrides: Partial<ProjectConfig> = {}): Promise<ProjectConfig> {
	const config = createMockProjectConfig(overrides);
	// `pm` persists split into its discriminator and the provider's own config blob
	// (`src/db/schema/projects.ts`), the same way the repository writes it.
	const { type: pmType, ...pmConfig } = config.pm;
	await getDb()
		.insert(projects)
		.values({
			id: config.id,
			name: config.name,
			// The fixture is a project *scoped to one repository* (`ProjectConfig`), so the
			// persisted list is that one entry. A test needing several seeds the record through
			// `createProjectInDb` instead — issue #684 phase 2 lifted the one-entry cap, so a
			// multi-repository project is writable.
			repositories: [
				{
					repo: config.repo,
					baseBranch: config.baseBranch,
					branchPrefix: config.branchPrefix,
				},
			],
			// The SCM discriminator (issue #478), which this helper used to drop — so a test
			// passing `scm` still seeded a project stating none, and anything resolving through
			// `requireProjectSCMProvider` threw once #618 made a second provider runtime-ready.
			// Left absent when the fixture states none, which is a distinct case the lookup
			// reports on, so it is deliberately not defaulted here.
			scmType: config.scm,
			repoRoot: config.repoRoot,
			worktreeRoot: config.worktreeRoot,
			visibility: config.visibility,
			pmType,
			pmConfig,
			credentials: config.credentials,
		});
	return config;
}
