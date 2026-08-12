import type { CurrentUser } from './auth.js';

/**
 * Who may open SWARM's **installation-wide** screens — the global `/runs` and
 * `/workers` views, which read across every project on the instance (issue #647).
 * That is an operator's view of the installation, so it sits on the installation
 * role and no project membership grants it.
 *
 * The server is the enforcement point (`assertInstanceAdmin`, `src/api/authz.ts`,
 * which denies the underlying unscoped reads whatever the client does); these
 * predicates decide only what the dashboard *offers*, so a route it would be
 * denied is never navigated to and its links are never drawn.
 */

/** Whether `user` may open the installation-wide screens. Absent/unresolved denies. */
export function canViewInstanceWide(
	user: Pick<CurrentUser, 'instanceAdmin'> | null | undefined,
): boolean {
	return user?.instanceAdmin === true;
}

/**
 * Where `/` forwards a signed-in user: an administrator to the installation-wide
 * runs view as before, anyone else to their projects — the page a worker owner
 * reaches their project-scoped runs and workers from. Also governs where the
 * login screen lands, since it navigates to `/`.
 */
export function landingRouteFor(
	user: Pick<CurrentUser, 'instanceAdmin'> | null | undefined,
): '/runs' | '/projects' {
	return canViewInstanceWide(user) ? '/runs' : '/projects';
}
