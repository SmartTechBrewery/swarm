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
	await getDb().insert(projects).values({
		id: config.id,
		name: config.name,
		repo: config.repo,
		repoRoot: config.repoRoot,
		worktreeRoot: config.worktreeRoot,
		baseBranch: config.baseBranch,
		branchPrefix: config.branchPrefix,
		visibility: config.visibility,
		pmType,
		pmConfig,
		credentials: config.credentials,
	});
	return config;
}
