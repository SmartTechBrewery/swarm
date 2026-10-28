import { useQueryClient } from '@tanstack/react-query';
import { createRoute, useNavigate } from '@tanstack/react-router';
import type React from 'react';
import { useState } from 'react';
import { z } from 'zod';
import { buttonClass } from '@/components/ui/button.js';
import { redeemPasswordLink } from '@/lib/auth.js';
import { trpc } from '@/lib/trpc.js';
import { rootRoute } from './__root.js';

const INPUT_CLASS =
	'block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500';

export const setPasswordSearchSchema = z.object({
	token: z.string().optional().catch(undefined),
});

/**
 * Set-password screen (issue #1151). Opened from the single-use
 * `/set-password?token=…` link an installation admin issued under Settings →
 * Users — a new user's first password, or a reset. Redeeming it through
 * `/auth/set-password` sets the password, signs that user out of every other
 * session, and signs the redeemer in, so success enters the app.
 *
 * Like `/setup` it renders outside the authenticated shell, but unlike `/setup`
 * it does **not** send an already signed-in viewer away: the link is the action,
 * and an admin may well open one in their own browser to check it.
 */
export function SetPasswordScreen({ token }: { token: string | undefined }) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [password, setPassword] = useState('');
	const [confirmPassword, setConfirmPassword] = useState('');
	const [error, setError] = useState('');
	const [submitting, setSubmitting] = useState(false);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!token) return;
		setError('');
		if (password !== confirmPassword) {
			setError('The passwords do not match.');
			return;
		}
		setSubmitting(true);
		const result = await redeemPasswordLink(token, password);
		setSubmitting(false);
		setPassword('');
		setConfirmPassword('');
		if (!result.ok) {
			setError(result.error ?? 'Setting the password failed.');
			return;
		}
		await queryClient.invalidateQueries({ queryKey: trpc.auth.me.queryOptions().queryKey });
		navigate({ to: '/' });
	};

	return (
		<div className="flex min-h-screen items-center justify-center bg-canvas p-4">
			<div className="w-full max-w-sm">
				<div className="mb-6 text-center">
					<h1 className="text-lg font-semibold text-zinc-100">Set your SWARM password</h1>
					<p className="mt-1 text-xs text-zinc-500">
						This link works once. Using it signs you out of every other session.
					</p>
				</div>
				{!token ? (
					<p className="text-sm text-zinc-400">
						This page needs the password link an installation administrator issued for you. Ask them
						for one if you don't have it.
					</p>
				) : (
					<form onSubmit={handleSubmit} className="space-y-4">
						<div>
							<label
								htmlFor="set-password-password"
								className="block text-xs font-medium text-zinc-400 mb-1"
							>
								New password
							</label>
							<input
								type="password"
								id="set-password-password"
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								autoComplete="new-password"
								required
								className={INPUT_CLASS}
							/>
						</div>
						<div>
							<label
								htmlFor="set-password-confirm"
								className="block text-xs font-medium text-zinc-400 mb-1"
							>
								Confirm password
							</label>
							<input
								type="password"
								id="set-password-confirm"
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
							</p>
						)}
						<button
							type="submit"
							disabled={submitting}
							className={`${buttonClass('primary')} w-full justify-center`}
						>
							{submitting ? 'Saving…' : 'Set password'}
						</button>
					</form>
				)}
			</div>
		</div>
	);
}

function SetPasswordRouteComponent() {
	const { token } = setPasswordRoute.useSearch();
	return <SetPasswordScreen token={token} />;
}

export const setPasswordRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/set-password',
	validateSearch: (search) => setPasswordSearchSchema.parse(search),
	component: SetPasswordRouteComponent,
});
