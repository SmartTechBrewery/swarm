import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, UserPlus, X } from 'lucide-react';
import type React from 'react';
import { useState } from 'react';
import { buttonClass } from '@/components/ui/button.js';
import { ToggleSwitch } from '@/components/ui/toggle-switch.js';
import {
	groupIdentitiesByUser,
	IDENTITY_PROVIDER_OPTIONS,
	identityProviderLabel,
	type LinkedIdentity,
} from '@/lib/identity-links.js';
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
 * **Linked identities** (issue #1167, the `users.identities` procedures) are the
 * board accounts each user owns — the dashboard twin of `swarm identities`. An item
 * assigned to one routes to that user's own workers (assignee affinity, ADR-001);
 * resolution reads the links on every dispatch, so a change applies with no restart.
 * Provider names and handle copy come from `lib/identity-links.ts`, never this file.
 *
 * **Errors are the server's own words** — a taken identifier, the last-admin
 * refusal, a handle already linked to someone else — rendered verbatim beside the
 * control that caused them.
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
	const identitiesQuery = useQuery(trpc.users.identities.list.queryOptions());
	const [identityTarget, setIdentityTarget] = useState<InstallationUser | null>(null);
	const [unlinkTarget, setUnlinkTarget] = useState<{
		user: InstallationUser;
		identity: LinkedIdentity;
	} | null>(null);

	const invalidateList = () =>
		queryClient.invalidateQueries({ queryKey: trpc.users.list.queryOptions().queryKey });
	const invalidateIdentities = () =>
		queryClient.invalidateQueries({
			queryKey: trpc.users.identities.list.queryOptions().queryKey,
		});

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
	// Undefined while loading or failed, so a cell shows a dash rather than a false "None".
	const identitiesByUser = identitiesQuery.isSuccess
		? groupIdentitiesByUser(identitiesQuery.data as LinkedIdentity[])
		: undefined;

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
				<p className="text-xs text-zinc-400 mt-2">
					Linked identities are the board accounts each user owns. A work item assigned to one runs
					only on that user's own workers, from the next dispatch — no restart needed.
				</p>
			</div>

			{adminMutation.isError && (
				<div className={ERROR_BANNER_CLASS}>{adminMutation.error.message}</div>
			)}

			{identitiesQuery.isError && (
				<div className={ERROR_BANNER_CLASS}>
					Failed to load linked identities: {identitiesQuery.error.message}
				</div>
			)}

			<div className="border border-zinc-800 rounded-md overflow-hidden bg-panel/20 shadow-sm">
				<table className="w-full text-left border-collapse">
					<thead>
						<tr className="bg-zinc-800/30 border-b border-zinc-800 text-xs uppercase tracking-wider text-zinc-400 font-semibold">
							<th className="px-4 py-3">Identifier</th>
							<th className="px-4 py-3">Display name</th>
							<th className="px-4 py-3">Installation admin</th>
							<th className="px-4 py-3">Linked identities</th>
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
								<td className="px-4 py-3.5">
									<LinkedIdentitiesCell
										identities={identitiesByUser && (identitiesByUser.get(user.id) ?? [])}
										user={user}
										onUnlink={(identity) => setUnlinkTarget({ user, identity })}
									/>
								</td>
								<td className="px-4 py-3.5">
									<div className="flex justify-end gap-2">
										<button
											type="button"
											onClick={() => setIdentityTarget(user)}
											className={buttonClass('secondary', 'sm')}
										>
											Link identity
										</button>
										<button
											type="button"
											onClick={() => setLinkTarget(user)}
											className={buttonClass('secondary', 'sm')}
										>
											Password link
										</button>
									</div>
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

			{identityTarget && (
				<LinkIdentityModal
					user={identityTarget}
					onLinked={invalidateIdentities}
					onClose={() => setIdentityTarget(null)}
				/>
			)}

			{unlinkTarget && (
				<UnlinkIdentityModal
					user={unlinkTarget.user}
					identity={unlinkTarget.identity}
					onUnlinked={invalidateIdentities}
					onClose={() => setUnlinkTarget(null)}
				/>
			)}
		</div>
	);
}

/** One user's links, each with its unlink button; a dash while they are unknown. */
function LinkedIdentitiesCell({
	identities,
	user,
	onUnlink,
}: {
	identities: LinkedIdentity[] | undefined;
	user: InstallationUser;
	onUnlink: (identity: LinkedIdentity) => void;
}) {
	if (!identities) return <span className="text-xs text-zinc-500">—</span>;
	if (identities.length === 0) return <span className="text-xs text-zinc-500">None</span>;
	return (
		<ul className="space-y-1">
			{identities.map((identity) => {
				const label = identityProviderLabel(identity.provider);
				return (
					<li key={identity.id} className="flex items-center gap-2">
						<span className="text-xs text-zinc-400">{label}</span>
						<span className="font-mono text-sm text-zinc-200 break-all">{identity.handle}</span>
						<button
							type="button"
							onClick={() => onUnlink(identity)}
							aria-label={`Unlink ${identity.handle} on ${label} from ${user.identifier}`}
							title="Unlink"
							className="text-zinc-500 hover:text-red-400 p-1.5 rounded hover:bg-zinc-800/60 transition-colors"
						>
							<X className="w-3.5 h-3.5" />
						</button>
					</li>
				);
			})}
		</ul>
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

/** Link identity: pick a board provider and enter that provider's handle for the user. */
function LinkIdentityModal({
	user,
	onLinked,
	onClose,
}: {
	user: InstallationUser;
	onLinked: () => void;
	onClose: () => void;
}) {
	const [providerId, setProviderId] = useState(IDENTITY_PROVIDER_OPTIONS[0].id);
	const [handle, setHandle] = useState('');
	const provider =
		IDENTITY_PROVIDER_OPTIONS.find((option) => option.id === providerId) ??
		IDENTITY_PROVIDER_OPTIONS[0];

	const linkMutation = useMutation({
		mutationFn: () =>
			trpcClient.users.identities.link.mutate({
				userId: user.id,
				provider: provider.id,
				handle: handle.trim(),
			}),
		onSuccess: () => {
			onLinked();
			onClose();
		},
	});

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		linkMutation.mutate();
	};

	return (
		<Modal open onClose={onClose} title="Link identity">
			<form onSubmit={handleSubmit} className="space-y-4">
				<p className="text-sm text-zinc-300">
					Link a board account to{' '}
					<span className="font-semibold text-zinc-200">{user.displayName}</span> (
					<span className="font-mono">{user.identifier}</span>). Items assigned to it run on their
					workers.
				</p>
				<div>
					<label
						htmlFor="link-identity-provider"
						className="block text-xs font-medium text-zinc-400 mb-1"
					>
						Provider
					</label>
					<select
						id="link-identity-provider"
						value={provider.id}
						onChange={(e) => {
							setProviderId(e.target.value as typeof providerId);
							linkMutation.reset();
						}}
						disabled={linkMutation.isPending}
						className={INPUT_CLASS}
					>
						{IDENTITY_PROVIDER_OPTIONS.map((option) => (
							<option key={option.id} value={option.id}>
								{option.label}
							</option>
						))}
					</select>
				</div>
				<div>
					<label
						htmlFor="link-identity-handle"
						className="block text-xs font-medium text-zinc-400 mb-1"
					>
						{provider.handleLabel} <span className="text-red-500">*</span>
					</label>
					<input
						id="link-identity-handle"
						value={handle}
						onChange={(e) => {
							setHandle(e.target.value);
							linkMutation.reset();
						}}
						disabled={linkMutation.isPending}
						autoComplete="off"
						placeholder={provider.placeholder}
						className={`${INPUT_CLASS} font-mono`}
					/>
					<p className="text-xs text-zinc-500 mt-1">{provider.hint}</p>
				</div>
				{linkMutation.isError && (
					<div className={ERROR_BANNER_CLASS}>{linkMutation.error.message}</div>
				)}
				<ModalFooter
					primary={
						<button
							type="submit"
							disabled={linkMutation.isPending || handle.trim().length === 0}
							className={buttonClass('primary')}
						>
							{linkMutation.isPending ? 'Linking…' : 'Link'}
						</button>
					}
					secondary={
						<button
							type="button"
							onClick={onClose}
							disabled={linkMutation.isPending}
							className={buttonClass('secondary')}
						>
							Cancel
						</button>
					}
				/>
			</form>
		</Modal>
	);
}

/**
 * Unlink: never a single stray click, and never a native `confirm()`
 * (`ai/DESIGN_SYSTEM.md` §7) — it changes where that account's work runs.
 */
function UnlinkIdentityModal({
	user,
	identity,
	onUnlinked,
	onClose,
}: {
	user: InstallationUser;
	identity: LinkedIdentity;
	onUnlinked: () => void;
	onClose: () => void;
}) {
	const unlinkMutation = useMutation({
		mutationFn: () =>
			trpcClient.users.identities.unlink.mutate({
				provider: identity.provider,
				handle: identity.handle,
			}),
		onSuccess: () => {
			onUnlinked();
			onClose();
		},
	});

	return (
		<Modal open onClose={onClose} title="Unlink identity">
			<div className="space-y-4">
				<p className="text-sm text-zinc-300">
					This unlinks <span className="font-mono text-zinc-200">{identity.handle}</span> on{' '}
					{identityProviderLabel(identity.provider)} from{' '}
					<span className="font-semibold text-zinc-200">{user.displayName}</span> (
					<span className="font-mono">{user.identifier}</span>). Items assigned to that account stop
					routing to their workers from the next dispatch.
				</p>
				{unlinkMutation.isError && (
					<div className={ERROR_BANNER_CLASS}>{unlinkMutation.error.message}</div>
				)}
				<ModalFooter
					primary={
						<button
							type="button"
							onClick={() => unlinkMutation.mutate()}
							disabled={unlinkMutation.isPending}
							className={buttonClass('danger')}
						>
							{unlinkMutation.isPending ? 'Unlinking…' : 'Unlink'}
						</button>
					}
					secondary={
						<button
							type="button"
							onClick={onClose}
							disabled={unlinkMutation.isPending}
							className={buttonClass('secondary')}
						>
							Cancel
						</button>
					}
				/>
			</div>
		</Modal>
	);
}
