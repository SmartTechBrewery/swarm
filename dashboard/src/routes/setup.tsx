import { useQueryClient } from '@tanstack/react-query';
import { createRoute, Link, Navigate, useNavigate } from '@tanstack/react-router';
import type React from 'react';
import { useState } from 'react';
import { z } from 'zod';
import { buttonClass } from '@/components/ui/button.js';
import { completeSetup } from '@/lib/auth.js';
import { trpc } from '@/lib/trpc.js';
import { useCurrentUser } from '@/lib/use-current-user.js';
import { rootRoute } from './__root.js';

const INPUT_CLASS =
	'block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500';

export const setupSearchSchema = z.object({
	token: z.string().optional().catch(undefined),
});

/**
 * First-run setup screen (issue #1150). Opened from the one-time
 * `/setup?token=…` link the server logs when it starts with no users; creates the
 * first installation admin through `/auth/setup`, which also signs them in, then
 * enters the app as the login screen does.
 *
 * Like `/login` it renders outside the authenticated shell, and a caller who
 * already resolves (a live session, or single-user mode) is sent straight into
 * the app.
 */
export function SetupScreen({ token }: { token: string | undefined }) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { data: currentUser, isLoading: sessionLoading } = useCurrentUser();
	const [identifier, setIdentifier] = useState('');
	const [password, setPassword] = useState('');
	const [confirmPassword, setConfirmPassword] = useState('');
	const [error, setError] = useState('');
	const [alreadySetUp, setAlreadySetUp] = useState(false);
	const [submitting, setSubmitting] = useState(false);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!token) return;
		setError('');
		setAlreadySetUp(false);
		if (password !== confirmPassword) {
			setError('The passwords do not match.');
			return;
		}
		setSubmitting(true);
		const result = await completeSetup(token, identifier, password);
		setSubmitting(false);
		setPassword('');
		setConfirmPassword('');
		if (!result.ok) {
			setError(result.error ?? 'Setup failed.');
			setAlreadySetUp(result.alreadySetUp ?? false);
			return;
		}
		await queryClient.invalidateQueries({ queryKey: trpc.auth.me.queryOptions().queryKey });
		navigate({ to: '/' });
	};

	if (currentUser) {
		return <Navigate to="/" />;
	}
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
					<h1 className="text-lg font-semibold text-zinc-100">Set up SWARM</h1>
					<p className="mt-1 text-xs text-zinc-500">Create the installation administrator.</p>
				</div>
				{!token ? (
					<p className="text-sm text-zinc-400">
						This page needs the one-time setup link the SWARM server writes to its logs when it
						starts with no users.
					</p>
				) : (
					<form onSubmit={handleSubmit} className="space-y-4">
						<div>
							<label
								htmlFor="setup-identifier"
								className="block text-xs font-medium text-zinc-400 mb-1"
							>
								E-mail
							</label>
							<input
								type="email"
								id="setup-identifier"
								value={identifier}
								onChange={(e) => setIdentifier(e.target.value)}
								autoComplete="username"
								required
								className={INPUT_CLASS}
							/>
						</div>
						<div>
							<label
								htmlFor="setup-password"
								className="block text-xs font-medium text-zinc-400 mb-1"
							>
								Password
							</label>
							<input
								type="password"
								id="setup-password"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								autoComplete="new-password"
								required
								className={INPUT_CLASS}
							/>
						</div>
						<div>
							<label
								htmlFor="setup-confirm-password"
								className="block text-xs font-medium text-zinc-400 mb-1"
							>
								Confirm password
							</label>
							<input
								type="password"
								id="setup-confirm-password"
								value={confirmPassword}
								onChange={(e) => setConfirmPassword(e.target.value)}
								autoComplete="new-password"
								required
								className={INPUT_CLASS}
							/>
						</div>
						{error && (
							<p role="alert" className="text-xs text-red-400">
								{error}
								{alreadySetUp && (
									<>
										{' '}
										<Link to="/login" className="text-violet-400 hover:text-violet-300">
											Go to sign in
										</Link>
									</>
								)}
							</p>
						)}
						<button
							type="submit"
							disabled={submitting}
							className={`${buttonClass('primary')} w-full justify-center`}
						>
							{submitting ? 'Creating…' : 'Create administrator'}
						</button>
					</form>
				)}
			</div>
		</div>
	);
}

function SetupRouteComponent() {
	const { token } = setupRoute.useSearch();
	return <SetupScreen token={token} />;
}

export const setupRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/setup',
	validateSearch: (search) => setupSearchSchema.parse(search),
	component: SetupRouteComponent,
});
