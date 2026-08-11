import { useQueryClient } from '@tanstack/react-query';
import { createRoute, Navigate, useNavigate } from '@tanstack/react-router';
import type React from 'react';
import { useState } from 'react';
import { login } from '@/lib/auth.js';
import { trpc } from '@/lib/trpc.js';
import { useCurrentUser } from '@/lib/use-current-user.js';
import { rootRoute } from './__root.js';

/**
 * The dashboard login screen (#281 task 2). Posts credentials to `/auth/login`
 * (which sets the HTTP-only session cookie); on success it refetches `auth.me`
 * and navigates into the app. No token is stored in JS — the session lives only
 * in the cookie.
 *
 * Before showing the form it consults `auth.me`: an already-resolved user is
 * redirected straight to `/` (which forwards into the app). This makes a direct
 * visit to `/login` skip the screen entirely in single-user mode (issue #298),
 * where the API resolves the local admin with no session — without adding any
 * browser-visible mode flag or weakening the normal login form, which still
 * renders once the query reports the caller unauthenticated.
 */
export function LoginScreen() {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { data: currentUser, isLoading: sessionLoading } = useCurrentUser();
	const [identifier, setIdentifier] = useState('');
	const [password, setPassword] = useState('');
	const [error, setError] = useState('');
	const [submitting, setSubmitting] = useState(false);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError('');
		setSubmitting(true);
		const result = await login(identifier, password);
		setSubmitting(false);
		if (!result.ok) {
			setError(result.error ?? 'Login failed.');
			return;
		}
		// The session cookie is set; drop any cached (unauthenticated) session
		// state and enter the app. The index route forwards on by role (issue #647):
		// an instance admin to /runs, anyone else to /projects.
		await queryClient.invalidateQueries({ queryKey: trpc.auth.me.queryOptions().queryKey });
		navigate({ to: '/' });
	};

	// A caller who already resolves (a live session, or the local admin in
	// single-user mode) never needs the form — send them into the app.
	if (currentUser) {
		return <Navigate to="/" />;
	}
	// Neutral loader while `auth.me` is in flight, so the form doesn't flash
	// before we know whether a session already resolves.
	if (sessionLoading) {
		return (
			<div className="flex min-h-screen items-center justify-center bg-canvas text-sm text-zinc-500">
				Loading…
			</div>
		);
	}

	return (
		<div className="flex min-h-screen items-center justify-center bg-canvas p-4">
			<div className="w-full max-w-sm">
				<div className="mb-6 text-center">
					<h1 className="text-lg font-semibold text-zinc-100">Sign in to SWARM</h1>
					<p className="mt-1 text-xs text-zinc-500">Enter your credentials to continue.</p>
				</div>
				<form onSubmit={handleSubmit} className="space-y-4">
					<div>
						<label
							htmlFor="login-identifier"
							className="block text-xs font-medium text-zinc-400 mb-1"
						>
							Username or email
						</label>
						<input
							type="text"
							id="login-identifier"
							value={identifier}
							onChange={(e) => setIdentifier(e.target.value)}
							autoComplete="username"
							className="block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500"
						/>
					</div>
					<div>
						<label
							htmlFor="login-password"
							className="block text-xs font-medium text-zinc-400 mb-1"
						>
							Password
						</label>
						<input
							type="password"
							id="login-password"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							autoComplete="current-password"
							className="block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500"
						/>
					</div>
					{error && (
						<p role="alert" className="text-xs text-red-400">
							{error}
						</p>
					)}
					<button
						type="submit"
						disabled={submitting}
						className="w-full px-3 py-2 text-sm font-medium rounded bg-violet-600 text-white hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
					>
						{submitting ? 'Signing in…' : 'Sign in'}
					</button>
				</form>
			</div>
		</div>
	);
}

export const loginRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/login',
	component: LoginScreen,
});
