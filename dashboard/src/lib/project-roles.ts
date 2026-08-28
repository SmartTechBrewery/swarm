import { type ProjectRole, ProjectRoleSchema } from '../../../src/identity/membership.js';

/**
 * How the dashboard words the three project roles (issue #806) — extracted from
 * `components/profile/my-projects-panel.tsx`, which held it privately, so the
 * profile's read-only **My Projects** tab and the project's **Members** tab
 * cannot describe the same role differently.
 *
 * A `Record` over the enum rather than a lookup with a fallback: a fourth role
 * added to `ProjectRoleSchema` is a compile error here rather than an unlabelled
 * badge or an empty `<option>` (the pattern `account-panel.tsx` applies to
 * installation roles).
 */
export const PROJECT_ROLE_COPY: Record<ProjectRole, { label: string; description: string }> = {
	projectAdmin: {
		label: 'Project administrator',
		description: 'Administers this project’s configuration, credentials, and membership.',
	},
	member: {
		label: 'Member',
		description: 'Works on this project and may drive its runs.',
	},
	contributor: {
		label: 'Contributor',
		description: 'Read-only access to this project and its runs.',
	},
};

/**
 * The roles a `<select>` offers, most-privileged first. The domain's own option
 * list (`ProjectRoleSchema.options`), not a hand-written array beside it, so the
 * vocabulary and the order come from `src/identity/membership.ts`.
 */
export const PROJECT_ROLE_OPTIONS: readonly ProjectRole[] = ProjectRoleSchema.options;
