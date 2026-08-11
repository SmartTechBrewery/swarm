import { createRoute, Navigate } from '@tanstack/react-router';
import { landingRouteFor } from '@/lib/instance-admin.js';
import { useCurrentUser } from '@/lib/use-current-user.js';
import { rootRoute } from './__root.js';

/**
 * `/` forwards into the app. Where to depends on the caller's installation role
 * (issue #647): an administrator lands on the installation-wide `/runs` view as
 * before, anyone else on `/projects`, since the global runs and workers screens
 * are not theirs and their runs/workers live on a project's own page.
 *
 * A component rather than `beforeLoad`, because the role lives in the `auth.me`
 * query — not in router context. The authenticated shell (`routes/__root.tsx`)
 * has already blocked on that query, so `user` is resolved by the time this
 * mounts; rendering nothing for the transient frame avoids forwarding anyone to
 * a page their role hasn't been read for yet.
 */
function IndexRedirect() {
	const { data: user } = useCurrentUser();
	if (!user) return null;
	return <Navigate to={landingRouteFor(user)} />;
}

export const indexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/',
	component: IndexRedirect,
});
