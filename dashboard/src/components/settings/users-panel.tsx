import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, UserPlus } from 'lucide-react';
import type React from 'react';
import { useState } from 'react';
import { buttonClass } from '@/components/ui/button.js';
import { ToggleSwitch } from '@/components/ui/toggle-switch.js';
import { passwordLinkUrl } from '@/lib/password-link.js';
import { trpc, trpcClient } from '@/lib/trpc.js';
import { Modal, ModalFooter } from '../ui/modal.js';

const INPUT_CLASS =
	'block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 transition-shadow disabled:opacity-50 disabled:cursor-not-allowed';

const ERROR_BANNER_CLASS =
	'p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded';

/**
 * The General Settings → **Users** tab (issue #1151): the dashboard face of the
 * `users` router (`src/api/routers/users.ts`), so an installation admin can add a
 * colleague, reset a forgotten password, and grant or revoke installation admin
 * without a shell. `swarm users` stays the shell alternative.
 *
 * The tab is offered only to an instance administrator (`INSTANCE_ADMIN_ONLY_TABS`,
 * `lib/settings-nav.ts`); every `users` procedure is administrator-only in the router
 * itself, so that is a courtesy, not the enforcement point.
 *
 * **Passwords travel as links.** `create` and `issuePasswordLink` return a raw
 * single-use token exactly once; this panel builds the `/set-password` URL from its
 * own origin, shows it in the modal that asked for it, and drops it when that modal
 * closes — the modals are mounted only while open, so the token never outlives them.
 *
 * **Errors are the server's own words** — a taken identifier, the last-admin
 * refusal — rendered verbatim beside the control that caused them.
 */

/** One row of `users.list` — the whole of what this panel reads. */
interface InstallationUser {
	id: string;
	identifier: string;
	displayName: string;
	instanceAdmin: boolean;
}

/** What `create` / `issuePasswordLink` return, less the user (serialized: no transformer). */
interface IssuedLink {
	token: string;
	expiresAt: string | Date;
}

export function UsersPanel() {
	const queryClient = useQueryClient();
	const listQuery = useQuery(trpc.users.list.queryOptions());
	const [adding, setAdding] = useState(false);
	const [linkTarget, setLinkTarget] = useState<InstallationUser | null>(null);

	const invalidateList = () =>
		queryClient.invalidateQueries({ queryKey: trpc.users.list.queryOptions().queryKey });

	// No optimistic flip: the switch shows the server's value, so a refused revoke
	// (the last admin) leaves it where it was and the refusal says why.
	const adminMutation = useMutation({
		mutationFn: ({ userId, grant }: { userId: string; grant: boolean }) =>
			grant
				? trpcClient.users.grantAdmin.mutate({ userId })
				: trpcClient.users.revokeAdmin.mutate({ userId }),
		onSettled: invalidateList,
	});

	if (listQuery.isLoading) {
		return <div className="text-sm text-zinc-400">Loading users…</div>;
	}

	if (listQuery.isError) {
		return (
			<div className={ERROR_BANNER_CLASS}>Failed to load users: {listQuery.error.message}</div>
		);
	}

	const users = (listQuery.data ?? []) as InstallationUser[];

	return (
		<div className="border border-zinc-800 rounded-lg bg-panel/40 p-6 shadow-sm space-y-6">
			<div>
				<div className="flex items-center justify-between gap-4 border-b border-zinc-800 pb-2 mb-4">
					<h2 className="text-sm font-semibold text-zinc-200">Users</h2>
					<button
						type="button"
						onClick={() => setAdding(true)}
						className={buttonClass('primary', 'sm')}
					>
						<UserPlus className="w-3.5 h-3.5" />
						Add user
					</button>
				</div>
				<p className="text-xs text-zinc-400">
					Everyone who can sign in to this installation. Add a colleague or reset a forgotten
					password without a shell: SWARM issues a single-use link that expires after 72 hours, and
					the user sets their own password through it — nobody else chooses or sees it. A link is
					shown only once, because SWARM keeps only its hash. Installation admins manage users and
					installation-wide settings; project access is granted per project, on its Members tab.
				</p>
			</div>

			{adminMutation.isError && (
				<div className={ERROR_BANNER_CLASS}>{adminMutation.error.message}</div>
			)}

			<div className="border border-zinc-800 rounded-md overflow-hidden bg-panel/20 shadow-sm">
				<table className="w-full text-left border-collapse">
					<thead>
						<tr className="bg-zinc-800/30 border-b border-zinc-800 text-xs uppercase tracking-wider text-zinc-400 font-semibold">
							<th className="px-4 py-3">Identifier</th>
							<th className="px-4 py-3">Display name</th>
							<th className="px-4 py-3">Installation admin</th>
							<th className="px-4 py-3 text-right">Actions</th>
						</tr>
					</thead>
					<tbody className="divide-y divide-zinc-800/60">
						{users.map((user) => (
							<tr key={user.id} className="hover:bg-zinc-800/40 transition-colors">
								<td className="px-4 py-3.5 text-sm font-mono text-zinc-200 break-all">
									{user.identifier}
								</td>
								<td className="px-4 py-3.5 text-sm text-zinc-300">{user.displayName}</td>
								<td className="px-4 py-3.5">
									<ToggleSwitch
										checked={user.instanceAdmin}
										label={`Installation admin for ${user.identifier}`}
										disabled={
											adminMutation.isPending && adminMutation.variables?.userId === user.id
										}
										onChange={() =>
											adminMutation.mutate({ userId: user.id, grant: !user.instanceAdmin })
										}
									/>
								</td>
								<td className="px-4 py-3.5 text-right">
									<button
										type="button"
										onClick={() => setLinkTarget(user)}
										className={buttonClass('secondary', 'sm')}
									>
										Password link
									</button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			{adding && <AddUserModal onCreated={invalidateList} onClose={() => setAdding(false)} />}

			{linkTarget && (
				<IssuePasswordLinkModal user={linkTarget} onClose={() => setLinkTarget(null)} />
			)}
		</div>
	);
}

/**
 * A freshly issued link, shown once: the full URL read-only with Copy, its expiry,
 * and why it cannot be shown again.
 */
function IssuedLinkView({ identifier, link }: { identifier: string; link: IssuedLink }) {
	const [copied, setCopied] = useState(false);
	const url = passwordLinkUrl(window.location.origin, link.token);

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(url);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		} catch (err) {
			console.error('Failed to copy text: ', err);
		}
	};

	return (
		<div className="space-y-3">
			<p className="text-sm text-zinc-300">
				Send this link to <span className="font-mono text-zinc-200">{identifier}</span>. Opening it
				lets them choose their password and signs them in.
			</p>
			<div className="flex items-center gap-2">
				<input
					type="text"
					readOnly
					aria-label="Password link"
					value={url}
					onFocus={(e) => e.target.select()}
					className={`${INPUT_CLASS} font-mono`}
				/>
				<button type="button" onClick={handleCopy} className={buttonClass('secondary')}>
					{copied ? (
						<>
							<Check className="w-3.5 h-3.5 text-emerald-400" />
							Copied
						</>
					) : (
						<>
							<Copy className="w-3.5 h-3.5" />
							Copy
						</>
					)}
				</button>
			</div>
			<p className="text-xs text-zinc-400">
				Single use · expires {new Date(link.expiresAt).toLocaleString()}
			</p>
			<p className="text-xs text-zinc-500">
				This is the only time the link is shown — SWARM keeps only its hash. If it is lost, issue a
				new one.
			</p>
		</div>
	);
}

function DoneFooter({ onClose }: { onClose: () => void }) {
	return (
		<ModalFooter
			primary={
				<button type="button" onClick={onClose} className={buttonClass('primary')}>
					Done
				</button>
			}
			secondary={null}
		/>
	);
}

/** Add user: the form, then — once created — the new user's first password link. */
function AddUserModal({ onCreated, onClose }: { onCreated: () => void; onClose: () => void }) {
	const [identifier, setIdentifier] = useState('');
	const [displayName, setDisplayName] = useState('');
	const [instanceAdmin, setInstanceAdmin] = useState(false);

	const createMutation = useMutation({
		mutationFn: (input: { identifier: string; displayName?: string; instanceAdmin: boolean }) =>
			trpcClient.users.create.mutate(input),
		onSuccess: onCreated,
	});

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		const trimmedName = displayName.trim();
		createMutation.mutate({
			identifier: identifier.trim(),
			displayName: trimmedName || undefined,
			instanceAdmin,
		});
	};

	const created = createMutation.data;

	return (
		<Modal open onClose={onClose} title={created ? 'User created' : 'Add user'}>
			{created ? (
				<>
					<IssuedLinkView identifier={created.user.identifier} link={created} />
					<DoneFooter onClose={onClose} />
				</>
			) : (
				<form onSubmit={handleSubmit} className="space-y-4">
					<div>
						<label
							htmlFor="add-user-identifier"
							className="block text-xs font-medium text-zinc-400 mb-1"
						>
							Identifier <span className="text-red-500">*</span>
						</label>
						<input
							id="add-user-identifier"
							value={identifier}
							onChange={(e) => {
								setIdentifier(e.target.value);
								createMutation.reset();
							}}
							disabled={createMutation.isPending}
							autoComplete="off"
							placeholder="ada@example.com"
							className={`${INPUT_CLASS} font-mono`}
						/>
						<p className="text-xs text-zinc-500 mt-1">
							The login handle — usually their e-mail address. It cannot be changed later.
						</p>
					</div>
					<div>
						<label
							htmlFor="add-user-display-name"
							className="block text-xs font-medium text-zinc-400 mb-1"
						>
							Display name
						</label>
						<input
							id="add-user-display-name"
							value={displayName}
							onChange={(e) => setDisplayName(e.target.value)}
							disabled={createMutation.isPending}
							autoComplete="off"
							placeholder="Defaults to the identifier"
							className={INPUT_CLASS}
						/>
					</div>
					<div className="flex items-center gap-3">
						<ToggleSwitch
							checked={instanceAdmin}
							label="Installation admin"
							disabled={createMutation.isPending}
							onChange={() => setInstanceAdmin((value) => !value)}
						/>
						<span className="text-sm text-zinc-300">Installation admin</span>
					</div>
					{createMutation.isError && (
						<div className={ERROR_BANNER_CLASS}>{createMutation.error.message}</div>
					)}
					<ModalFooter
						primary={
							<button
								type="submit"
								disabled={createMutation.isPending || identifier.trim().length === 0}
								className={buttonClass('primary')}
							>
								{createMutation.isPending ? 'Creating…' : 'Create'}
							</button>
						}
						secondary={
							<button
								type="button"
								onClick={onClose}
								disabled={createMutation.isPending}
								className={buttonClass('secondary')}
							>
								Cancel
							</button>
						}
					/>
				</form>
			)}
		</Modal>
	);
}

/** Password link: confirm what issuing one does, then show the link. */
function IssuePasswordLinkModal({
	user,
	onClose,
}: {
	user: InstallationUser;
	onClose: () => void;
}) {
	const issueMutation = useMutation({
		mutationFn: () => trpcClient.users.issuePasswordLink.mutate({ userId: user.id }),
	});

	const issued = issueMutation.data;

	return (
		<Modal open onClose={onClose} title="Password link">
			{issued ? (
				<>
					<IssuedLinkView identifier={user.identifier} link={issued} />
					<DoneFooter onClose={onClose} />
				</>
			) : (
				<div className="space-y-4">
					<p className="text-sm text-zinc-300">
						Issue a password link for{' '}
						<span className="font-semibold text-zinc-200">{user.displayName}</span> (
						<span className="font-mono">{user.identifier}</span>). It replaces any earlier link they
						were sent. Their current password keeps working until the link is used; using it sets a
						new password and signs them out of every session they have.
					</p>
					{issueMutation.isError && (
						<div className={ERROR_BANNER_CLASS}>{issueMutation.error.message}</div>
					)}
					<ModalFooter
						primary={
							<button
								type="button"
								onClick={() => issueMutation.mutate()}
								disabled={issueMutation.isPending}
								className={buttonClass('primary')}
							>
								{issueMutation.isPending ? 'Issuing…' : 'Issue link'}
							</button>
						}
						secondary={
							<button
								type="button"
								onClick={onClose}
								disabled={issueMutation.isPending}
								className={buttonClass('secondary')}
							>
								Cancel
							</button>
						}
					/>
				</div>
			)}
		</Modal>
	);
}
