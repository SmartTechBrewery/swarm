/**
 * Linear provider integration config schema.
 *
 * This covers only the board mapping. Linear credentials and provider wiring
 * arrive with later phases, so this module deliberately registers nothing.
 */

import { z } from 'zod';

import type { ProjectConfig, ProjectPm } from '../../../config/schema.js';

export const linearConfigSchema = z
	.object({
		/**
		 * Linear team UUID — the board container. Workflow states belong to teams,
		 * and a team+project scope cannot be honored on ingress because `PmEvent`
		 * carries no sub-scope field.
		 */
		teamId: z.string().min(1),

		/**
		 * Canonical SWARM status key → Linear workflow state UUID. Values are IDs,
		 * never state names: names are rename-prone. Linear's state type is only a
		 * picker hint; operators choose this mapping explicitly.
		 */
		statusOptions: z
			.record(z.string().min(1), z.string().min(1))
			.refine((record) => Object.keys(record).length > 0, {
				message: 'statusOptions must map at least one pipeline status to a workflow state ID',
			}),
	})
	.strict()
	.describe('Linear board integration config');

export type LinearIntegrationConfig = z.infer<typeof linearConfigSchema>;

/**
 * This provider's `pm` member with no team selected — the manifest's `blankPm`
 * (`../manifest.ts`), which the credential/discovery API projects onto a project that
 * is not (yet) on Linear so an operator can pick a team before saving a switch.
 *
 * Deliberately not a persistable member: `statusOptions` must map at least one status.
 */
export const linearBlankPm: ProjectPm = {
	type: 'linear',
	teamId: '',
	statusOptions: {},
};

/**
 * Narrow a project's `pm` union member to Linear's board mapping. A mismatch is
 * a wiring bug: the registry will eventually select this provider from `pm.type`.
 */
export function requireLinearConfig(project: ProjectConfig): LinearIntegrationConfig {
	const pm = project.pm;
	const providerId: string = pm.type;
	if (pm.type !== 'linear') {
		throw new Error(
			`Project '${project.id}' is configured for PM provider '${providerId}', not 'linear' — ` +
				'the Linear provider was resolved for a board it does not own',
		);
	}
	const { type: _type, ...config } = pm;
	return config;
}
