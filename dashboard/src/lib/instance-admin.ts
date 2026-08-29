import type { CurrentUser } from './auth.js';

/**
 * Who may open SWARM's **installation-wide** screens — the global `/workers` view
 * and the unscoped run queue, which read across every project on the instance
 * (issue #647). That is an operator's view of the installation, so it sits on the
 * installation role and no project membership grants it.
 *
 * The global `/runs` list is no longer one of them (issue #821): it is open to
 * every signed-in user and bounded server-side to the reader's own projects, so
 * this predicate governs only the queue section on that screen.
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
 * Where `/` forwards a signed-in user: an administrator to the cross-project runs
 * view as before, anyone else to their projects — the page a worker owner reaches
 * their project-scoped runs and workers from. Also governs where the login screen
 * lands, since it navigates to `/`. Unchanged by issue #821: `/runs` is now
 * reachable by everyone, but a member's own projects remain the more useful
 * landing page, so opening it stays a deliberate navigation.
 */
export function landingRouteFor(
	user: Pick<CurrentUser, 'instanceAdmin'> | null | undefined,
): '/runs' | '/projects' {
	return canViewInstanceWide(user) ? '/runs' : '/projects';
}
