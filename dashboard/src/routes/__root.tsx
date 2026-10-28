import { createRootRoute, Navigate, Outlet, useRouterState } from '@tanstack/react-router';
import { Sidebar } from '@/components/layout/sidebar.js';
import { useCurrentUser } from '@/lib/use-current-user.js';

/**
 * The authenticated app shell. Gates every non-login route on the session: while
 * `auth.me` is in flight we show a neutral loader, an auth error (no/expired
 * session) redirects to `/login`, and only a resolved user renders the sidebar +
 * content (#281 task 2).
 */
function AuthenticatedShell() {
	const { isLoading, isError } = useCurrentUser();

	if (isError) {
		return <Navigate to="/login" />;
	}
	if (isLoading) {
		return (
			<div className="flex min-h-screen items-center justify-center bg-canvas text-sm text-zinc-500">
				Loading…
			</div>
		);
	}

	return (
		<div className="flex min-h-screen flex-col md:flex-row bg-canvas">
			<Sidebar />
			<main className="flex-1 overflow-y-auto">
				<div className="p-4 md:p-8">
					<Outlet />
				</div>
			</main>
		</div>
	);
}

function RootLayout() {
	const pathname = useRouterState({ select: (s) => s.location.pathname });
	// The login screen is its own full-screen route and must not itself be gated
	// (that would loop); so is first-run setup (issue #1150), which by definition
	// runs before anyone can sign in. Everything else runs inside the
	// authenticated shell.
	if (pathname === '/login' || pathname === '/setup') {
		return <Outlet />;
	}
	return <AuthenticatedShell />;
}

export const rootRoute = createRootRoute({ component: RootLayout });
