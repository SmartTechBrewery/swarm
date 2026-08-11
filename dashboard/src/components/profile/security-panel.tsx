import { useMutation, useQueryClient } from '@tanstack/react-query';
import type React from 'react';
import { useState } from 'react';
import {
	canSaveDisplayName,
	DISPLAY_NAME_MAX_LENGTH,
	describePasswordFormError,
	type PasswordFormFields,
} from '@/lib/profile-security.js';
import { trpc, trpcClient } from '@/lib/trpc.js';
import { useDraftSync } from '@/lib/use-draft-sync.js';
import type { SwarmUser } from '../../../../src/identity/schema.js';

/**
 * The self-service account changes a signed-in user may make (issue #662) — the
 * profile's **Security** tab, and the first place the dashboard lets someone
 * change anything about their own account.
 *
 * **Only the viewer's own account, and only the two things they own.** Both
 * mutations (`auth.updateDisplayName`, `auth.changePassword`) resolve their
 * subject from the session server-side and take no user id, so this panel has no
 * account to address but the caller's. The login identifier, the installation
 * role, and project membership roles are deliberately absent — they are read-only
 * facts an operator manages, shown on the Account tab.
 *
 * **No password value survives a submit.** All three fields are cleared once the
 * mutation settles — success *or* failure — so nothing submitted stays in
 * component state or in the DOM; a wrong-current-password error asks for a
 * retype. No value is rendered as text, put in a `title`/`aria-label`, or
 * logged, and the API returns none.
 *
 * Signing out is not duplicated here: it stays in the sidebar, where it already
 * is on every screen.
 */

const CARD_CLASS = 'border border-zinc-800 rounded-lg bg-panel/40 p-6 shadow-sm';
const SECTION_HEADING_CLASS =
	'text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4';
const LABEL_CLASS = 'block text-xs font-medium text-zinc-400 mb-1';
const INPUT_CLASS =
	'block w-full max-w-sm px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 transition-shadow disabled:opacity-50 disabled:cursor-not-allowed';
const SECONDARY_BUTTON_CLASS =
	'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors disabled:opacity-55 disabled:cursor-not-allowed';
const PRIMARY_BUTTON_CLASS =
	'inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-violet-600 rounded-md hover:bg-violet-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-violet-500 transition-colors shadow-lg shadow-violet-650/10 disabled:opacity-55 disabled:cursor-not-allowed';
const ERROR_CLASS = 'p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded';
const SUCCESS_CLASS =
	'p-2.5 bg-emerald-950/30 border border-emerald-900/30 text-xs text-emerald-400 rounded';

/** The fields this panel reads — the same `auth.me` read model the Account tab takes. */
export type SecurityUser = Pick<SwarmUser, 'displayName'>;

const EMPTY_PASSWORD_FORM: PasswordFormFields = { current: '', next: '', confirm: '' };

/**
 * The user's own label, draft-and-save (the shape `WorkerNameField` uses): a
 * free-text field can't fire a mutation per keystroke, and the draft re-syncs
 * only when the server's value actually changes.
 */
function DisplayNameSection({ displayName }: { displayName: string }) {
	const queryClient = useQueryClient();
	const [draft, setDraft] = useDraftSync(displayName, (name) => name);

	const renameMutation = useMutation({
		mutationFn: (nextDisplayName: string) =>
			trpcClient.auth.updateDisplayName.mutate({ displayName: nextDisplayName }),
		// The name is on every screen (the sidebar, the Account tab), so the whole
		// `auth.me` read model is refetched rather than patched here.
		onSuccess: () =>
			queryClient.invalidateQueries({ queryKey: trpc.auth.me.queryOptions().queryKey }),
	});

	const canSave = canSaveDisplayName(draft, displayName);

	return (
		<div className={CARD_CLASS}>
			<h2 className={SECTION_HEADING_CLASS}>Display name</h2>
			<p className="text-xs text-zinc-400 mb-4">
				How you are named across the dashboard. It is a label only — your login identifier stays
				what you sign in with.
			</p>

			<div className="flex items-end gap-2">
				<div className="flex-1 max-w-sm">
					<label htmlFor="profile-display-name" className={LABEL_CLASS}>
						Display name
					</label>
					<input
						id="profile-display-name"
						aria-label="Display name"
						type="text"
						value={draft}
						onChange={(event) => {
							setDraft(event.target.value);
							// A fresh edit clears the previous outcome, so a stale "updated"
							// or error line never describes what is now in the field.
							renameMutation.reset();
						}}
						disabled={renameMutation.isPending}
						maxLength={DISPLAY_NAME_MAX_LENGTH}
						className={INPUT_CLASS}
					/>
				</div>
				<button
					type="button"
					onClick={() => renameMutation.mutate(draft.trim())}
					disabled={renameMutation.isPending || !canSave}
					className={SECONDARY_BUTTON_CLASS}
				>
					{renameMutation.isPending ? 'Saving…' : 'Save'}
				</button>
			</div>

			{renameMutation.isError ? (
				<p className={`mt-3 ${ERROR_CLASS}`}>{renameMutation.error.message}</p>
			) : null}
			{renameMutation.isSuccess ? (
				<p className={`mt-3 ${SUCCESS_CLASS}`}>Display name updated.</p>
			) : null}
		</div>
	);
}

/**
 * The password change. The current password is required and is only ever checked
 * server-side against the stored hash; the confirmation field is this form's own
 * idea, so a typo in it never reaches the API.
 */
function PasswordSection() {
	const [fields, setFields] = useState<PasswordFormFields>(EMPTY_PASSWORD_FORM);
	// The last thing the *form* objected to, as opposed to the server's message.
	const [formError, setFormError] = useState<string | null>(null);

	const changeMutation = useMutation({
		mutationFn: (input: { currentPassword: string; newPassword: string }) =>
			trpcClient.auth.changePassword.mutate(input),
		// Whatever the outcome, nothing submitted is kept — a retry retypes it.
		onSettled: () => setFields(EMPTY_PASSWORD_FORM),
	});

	const set = (key: keyof PasswordFormFields) => (event: React.ChangeEvent<HTMLInputElement>) => {
		const value = event.target.value;
		setFields((previous) => ({ ...previous, [key]: value }));
		setFormError(null);
	};

	const handleSubmit = (event: React.FormEvent) => {
		event.preventDefault();
		const problem = describePasswordFormError(fields);
		if (problem) {
			// Nothing is sent — the form states the problem itself.
			setFormError(problem);
			return;
		}
		changeMutation.reset();
		changeMutation.mutate({ currentPassword: fields.current, newPassword: fields.next });
	};

	return (
		<div className={CARD_CLASS}>
			<h2 className={SECTION_HEADING_CLASS}>Password</h2>
			<p className="text-xs text-zinc-400 mb-4">
				Changing your password requires your current one. Other devices you are signed in on stay
				signed in.
			</p>

			<form onSubmit={handleSubmit} className="space-y-3 max-w-sm">
				<div>
					<label htmlFor="profile-current-password" className={LABEL_CLASS}>
						Current password
					</label>
					<input
						id="profile-current-password"
						type="password"
						autoComplete="current-password"
						value={fields.current}
						onChange={set('current')}
						disabled={changeMutation.isPending}
						className={INPUT_CLASS}
					/>
				</div>
				<div>
					<label htmlFor="profile-new-password" className={LABEL_CLASS}>
						New password
					</label>
					<input
						id="profile-new-password"
						type="password"
						autoComplete="new-password"
						value={fields.next}
						onChange={set('next')}
						disabled={changeMutation.isPending}
						className={INPUT_CLASS}
					/>
				</div>
				<div>
					<label htmlFor="profile-confirm-password" className={LABEL_CLASS}>
						Confirm new password
					</label>
					<input
						id="profile-confirm-password"
						type="password"
						autoComplete="new-password"
						value={fields.confirm}
						onChange={set('confirm')}
						disabled={changeMutation.isPending}
						className={INPUT_CLASS}
					/>
				</div>

				{formError ? <p className={ERROR_CLASS}>{formError}</p> : null}
				{changeMutation.isError ? (
					<p className={ERROR_CLASS}>{changeMutation.error.message}</p>
				) : null}
				{changeMutation.isSuccess ? <p className={SUCCESS_CLASS}>Password changed.</p> : null}

				<button type="submit" disabled={changeMutation.isPending} className={PRIMARY_BUTTON_CLASS}>
					{changeMutation.isPending ? 'Changing…' : 'Change password'}
				</button>
			</form>
		</div>
	);
}

export function SecurityPanel({ user }: { user: SecurityUser }) {
	return (
		<div className="space-y-6">
			<DisplayNameSection displayName={user.displayName} />
			<PasswordSection />
			<p className="text-xs text-zinc-500">
				Your login identifier, your installation role, and your role in each project are set by an
				operator and cannot be changed here — the Account tab shows what they are.
			</p>
		</div>
	);
}
