/**
 * The authenticated **SWARM user** identity — the single source of truth for the
 * shape (ai/CODING_STANDARDS.md "Zod is the source of truth"). This is the first
 * slice of the multi-user foundation (ADR-001, issue #281): a SWARM user is a
 * person who signs in to *this* installation, modelled entirely in SWARM's own
 * `users` table.
 *
 * It is deliberately **provider-neutral**: a SWARM user is **not** an SCM
 * identity and **not** an implementer/reviewer GitHub credential (those stay in
 * `project_credentials`, per persona per project). Nothing here couples to an
 * external identity provider or SCM — #281 does not pick one, and this domain
 * doesn't need one. Linking a SWARM user to an SCM/GitHub persona is explicitly
 * out of scope for this task.
 */

import { z } from 'zod';

/**
 * A user's installation-level role. Modelled as a named enum (rather than a bare
 * boolean at every call site) so later phases — session auth, membership,
 * authorization — can speak in terms of a role; the *persisted* form stays the
 * single `instanceAdmin` boolean column on `users` (`src/db/schema/users.ts`).
 * `instanceAdmin` is admin of every project/membership/enrollment on the
 * installation; `user` is an ordinary authenticated user. Extend the enum here
 * if more installation roles are ever needed.
 */
export const InstallationRoleSchema = z.enum(['instanceAdmin', 'user']);

export type InstallationRole = z.infer<typeof InstallationRoleSchema>;

/**
 * A user's own human-facing label — trimmed and bounded (1–80 chars), the same
 * rule a worker's own label follows ({@link WorkerDisplayNameSchema},
 * `./worker.ts`). Declared separately from {@link SwarmUserSchema} because it is
 * also the API input of the self-service rename (issue #662), so the boundary
 * and the domain shape cannot drift. It carries no login/identity semantics —
 * that is `identifier`, which stays operator-managed.
 */
export const UserDisplayNameSchema = z.string().trim().min(1).max(80);

/**
 * An authenticated SWARM user. `identifier` is the stable login handle
 * (username/email) and is unique across the installation; `displayName` is the
 * human-friendly label shown in the dashboard. `instanceAdmin` is the single
 * installation-role flag (see {@link InstallationRoleSchema}). `id` is generated
 * (`uuid`), not externally supplied.
 */
export const SwarmUserSchema = z.object({
	id: z.string().uuid(),
	identifier: z.string().min(1),
	displayName: UserDisplayNameSchema,
	instanceAdmin: z.boolean(),
	createdAt: z.date(),
	updatedAt: z.date(),
});

export type SwarmUser = z.infer<typeof SwarmUserSchema>;

/**
 * The domain predicate for the installation-admin role — a named seam later
 * phases (membership, authorization) call rather than reaching into the raw
 * `instanceAdmin` field. Takes only the flag it reads so callers can pass a
 * partial user.
 */
export function isInstanceAdmin(user: Pick<SwarmUser, 'instanceAdmin'>): boolean {
	return user.instanceAdmin;
}

/** The named installation role for a user — the enum form of {@link isInstanceAdmin}. */
export function installationRoleFor(user: Pick<SwarmUser, 'instanceAdmin'>): InstallationRole {
	return isInstanceAdmin(user) ? 'instanceAdmin' : 'user';
}
