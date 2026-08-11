/**
 * GitHub Projects (v2) provider integration config schema.
 *
 * This was SWARM's first PM provider (see ai/ARCHITECTURE.md "PM: GitHub
 * Projects") and has no Cascade equivalent — Cascade ships Trello/JIRA/Linear,
 * not GitHub Projects. It follows the same `config-schema.ts` shape those
 * providers use (Zod schema + `z.infer` type, the provider owns its own
 * contract) — the shape `../linear/config-schema.ts` follows too — so the
 * central project config can compose it by import rather than
 * re-declaring the board mapping — the single-source-of-truth rule from
 * ai/CODING_STANDARDS.md "Zod is the source of truth".
 *
 * This schema covers only the board *mapping* — the opaque GraphQL node IDs
 * SWARM needs to read and move items. GitHub credentials (implementer/reviewer
 * tokens, webhook secret) are referenced from the project config's
 * `credentials` block, not stored here (PROJECT.md §6.1).
 *
 * The string IDs below are branded at the boundary via `src/pm/ids.ts`
 * (`parseProjectV2Id`, `parseFieldId`, `parseSingleSelectOptionId`) — storing
 * them as plain validated strings here keeps the config round-trippable, the
 * same way Cascade keeps state IDs as strings in config and brands them when
 * they leave the config layer.
 */

import { z } from 'zod';

import type { ProjectConfig, ProjectPm } from '../../../config/schema.js';

export const githubProjectsConfigSchema = z
	.object({
		/**
		 * The Projects v2 project node ID — the board itself
		 * (e.g. `PVT_kwHOAC3TF84BcNwD`). GitHub Projects v2 is GraphQL-only, so
		 * this is a node ID, not the human-facing project number.
		 */
		projectId: z.string().min(1),

		/**
		 * The single-select "Status" field's node ID
		 * (e.g. `PVTSSF_lAHOAC3TF84BcNwDzhW4MKo`). Moving an item through the
		 * pipeline means writing one of `statusOptions`' values to this field.
		 */
		statusFieldId: z.string().min(1),

		/**
		 * Mapping from SWARM pipeline status keys to the Status field's
		 * single-select *option* IDs (not option names — names are display-only
		 * and rename-prone; the option ID is stable).
		 *
		 * Recognized keys are the canonical SWARM pipeline status keys
		 * (`PM_STATUS_KEYS` in `src/pm/pipeline.ts` — the single source of truth),
		 * which mirror the board's Status options (ai/RULES.md §5) one-for-one:
		 * `backlog`, `planning`, `todo`, `inProgress`, `inReview`, `done`.
		 * Kept as an open record — a board may add or omit options, and validating
		 * exact key presence belongs to setup/wizard code, not this schema. The
		 * one bound the schema does enforce: the record can't be empty, since a
		 * board mapping with zero status→optionId entries gives the PM adapter no
		 * transition targets to move items to.
		 */
		statusOptions: z
			.record(z.string().min(1), z.string().min(1))
			.refine((r) => Object.keys(r).length > 0, {
				message: 'statusOptions must map at least one pipeline status to an option ID',
			}),

		/**
		 * Optional mapping from SWARM phase keys (`phase-0` … `phase-5`) to the
		 * repo label names used to mirror them (ai/RULES.md §5 — the board has no
		 * native "phase" field). Optional because phase labels are organizational,
		 * not required for the pipeline to run.
		 */
		phaseLabels: z.record(z.string().min(1), z.string().min(1)).optional(),
	})
	.describe('GitHub Projects (v2) board integration config');

export type GitHubProjectsIntegrationConfig = z.infer<typeof githubProjectsConfigSchema>;

/**
 * This provider's `pm` member with no board selected — the manifest's `blankPm`
 * (`../manifest.ts`), and the `pm` block a dashboard-created project starts on
 * (`DEFAULT_PM_CONFIG`, `src/api/routers/projects.ts`).
 *
 * Lives here rather than in `./index.ts` so both readers share one definition without
 * importing a module whose load registers the provider. It deliberately does **not**
 * satisfy the schema above: `statusOptions` must map at least one status to be
 * persisted, and this maps none — the operator fills it in on the Project Management
 * tab, and a board read against it fails loudly on the unmappable status rather than
 * writing to a wrong board.
 */
export const githubProjectsBlankPm: ProjectPm = {
	type: 'github-projects',
	projectId: '',
	statusFieldId: '',
	statusOptions: {},
};

/**
 * Narrow a project's `pm` union member (`ProjectPmSchema`, `src/config/schema.ts`)
 * to *this* provider's board mapping.
 *
 * Since issue #495 the board mapping lives under `project.pm`, keyed by
 * `pm.type` — so reading it means narrowing the union, and narrowing it is the
 * provider's own job: this helper is the single place a `pm.type === 'github-projects'`
 * assertion is allowed to live, and every read inside this folder (plus the
 * provider's router adapter, `src/router/adapters/github-projects.ts`) goes
 * through it. Shared code never branches on `pm.type` (ai/RULES.md §2) — it
 * resolves a `PMProvider`/`PMRouterAdapter` through the registry, and the
 * implementation it gets back is the one that knows which member it holds.
 *
 * A mismatch is a wiring bug, not a runtime condition: the registry resolved this
 * provider *from* `pm.type`, so the only way to get here with another provider's
 * config is a call site that named this provider directly
 * (ai/CODING_STANDARDS.md "Error handling").
 */
export function requireGitHubProjectsConfig(
	project: ProjectConfig,
): GitHubProjectsIntegrationConfig {
	const pm = project.pm;
	// Keep the configured provider id for the wiring-error message before narrowing.
	const providerId: string = pm.type;
	if (pm.type !== 'github-projects') {
		throw new Error(
			`Project '${project.id}' is configured for PM provider '${providerId}', not 'github-projects' — ` +
				'the GitHub Projects provider was resolved for a board it does not own',
		);
	}
	const { type: _type, ...config } = pm;
	return config;
}
