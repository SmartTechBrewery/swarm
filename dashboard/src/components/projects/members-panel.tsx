import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2, Users } from 'lucide-react';
import type React from 'react';
import { useRef, useState } from 'react';
import { PROJECT_ROLE_COPY, PROJECT_ROLE_OPTIONS } from '@/lib/project-roles.js';
import { trpc, trpcClient } from '@/lib/trpc.js';
import type { ProjectRole } from '../../../../src/identity/membership.js';
import { Modal, ModalFooter } from '../ui/modal.js';

/**
 * The project detail screen's **Members** tab (issue #806) — who belongs to this
 * project and in what role, administered from the dashboard instead of only from
 * the machine holding `DATABASE_URL`.
 *
 * It adds **no API surface**: its four operations are exactly the `members` router
 * phase 1 landed (`src/api/routers/members.ts`) — `list`, `add` by login handle,
 * and `setRole`/`remove` keyed on the `userId` `list` returned.
 *
 * **No client-side authorization.** `canAdminister` is deliberately not a prop and
 * no role is checked here: `ProjectAdminOnly` is the frame this renders inside, so a
 * non-administrator never mounts it, and every `members` procedure re-asserts
 * `projectAdmin` server-side regardless. A third opinion here could only drift from
 * those two.
 *
 * **Not polled.** Membership is configuration, not liveness — the roster changes
 * only when someone on this screen changes it, so refresh comes from invalidating
 * this query after each write rather than from a timer.
 *
 * **Errors are the server's own words.** Phase 1's copy already names the fix (a
 * duplicate points at changing the role, an unknown identifier at `swarm users add`),
 * so nothing here paraphrases it — a failed write renders its message verbatim,
 * beside the control that caused it.
 */

/** One row of `members.list` — the whole of what this panel reads. */
interface ProjectMember {
	userId: string;
	identifier: string;
	displayName: string;
	role: ProjectRole;
}

const INPUT_CLASS =
	'block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 font-mono transition-shadow disabled:opacity-50 disabled:cursor-not-allowed';

const SELECT_CLASS =
	'block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 disabled:opacity-50 disabled:bg-zinc-950 disabled:border-zinc-800 disabled:text-zinc-500';

const PRIMARY_BUTTON_CLASS =
	'inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-violet-600 rounded-md hover:bg-violet-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-violet-500 transition-colors shadow-lg shadow-violet-650/10 disabled:opacity-55 disabled:cursor-not-allowed';

const SECONDARY_BUTTON_CLASS =
	'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors disabled:opacity-55 disabled:cursor-not-allowed';

const ERROR_BANNER_CLASS =
	'p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded';

export function MembersPanel({ projectId }: { projectId: string }) {
	const queryClient = useQueryClient();
	const membersQueryOptions = trpc.members.list.queryOptions({ projectId });
	const membersQuery = useQuery(membersQueryOptions);

	// Annotated, not cast: the query's inferred type has to *satisfy* the shape this
	// panel renders, so a read-model change it does not handle fails the typecheck
	// instead of surfacing as a runtime surprise.
	const members: ProjectMember[] | undefined = membersQuery.data;

	const [identifier, setIdentifier] = useState('');
	const [role, setRole] = useState<ProjectRole>('member');
	const [removeTarget, setRemoveTarget] = useState<ProjectMember | null>(null);
	const [pendingRoleUserIds, setPendingRoleUserIds] = useState<Set<string>>(() => new Set());
	const [roleErrors, setRoleErrors] = useState<Record<string, string>>({});
	const pendingRoleUserIdsRef = useRef(new Set<string>());

	const invalidateMembers = () =>
		queryClient.invalidateQueries({ queryKey: membersQueryOptions.queryKey });

	const addMutation = useMutation({
		mutationFn: (input: { identifier: string; role: ProjectRole }) =>
			trpcClient.members.add.mutate({ projectId, ...input }),
		onSuccess: () => {
			// The identifier is cleared because it named one person; the role is kept,
			// since adding several people in the same role is the common case. A failure
			// clears neither, so a typo can be corrected rather than retyped.
			setIdentifier('');
			invalidateMembers();
		},
	});

	const removeMutation = useMutation({
		mutationFn: (input: { userId: string }) =>
			trpcClient.members.remove.mutate({ projectId, userId: input.userId }),
		onSuccess: () => {
			setRemoveTarget(null);
			invalidateMembers();
		},
	});

	const handleAdd = (e: React.FormEvent) => {
		e.preventDefault();
		const trimmed = identifier.trim();
		if (trimmed.length === 0) return;
		addMutation.mutate({ identifier: trimmed, role });
	};

	const handleRoleChange = async (userId: string, nextRole: ProjectRole) => {
		if (pendingRoleUserIdsRef.current.has(userId)) return;

		pendingRoleUserIdsRef.current.add(userId);
		setPendingRoleUserIds((current) => new Set(current).add(userId));
		setRoleErrors((current) => {
			const { [userId]: _previousError, ...remaining } = current;
			return remaining;
		});

		try {
			await trpcClient.members.setRole.mutate({ projectId, userId, role: nextRole });
			invalidateMembers();
		} catch (error) {
			setRoleErrors((current) => ({
				...current,
				[userId]: error instanceof Error ? error.message : 'Failed to change member role.',
			}));
		} finally {
			pendingRoleUserIdsRef.current.delete(userId);
			setPendingRoleUserIds((current) => {
				const next = new Set(current);
				next.delete(userId);
				return next;
			});
		}
	};

	const closeRemoveDialog = () => {
		setRemoveTarget(null);
		removeMutation.reset();
	};

	return (
		<div className="border border-zinc-800 rounded-lg bg-panel/40 p-6 shadow-sm space-y-6">
			<div>
				<h2 className="text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4">
					Members
				</h2>
				<p className="text-xs text-zinc-400">
					Who belongs to this project and what each of them may do on it. Roles are this project's
					alone — an instance administrator reaches every project whatever this table says, and
					holds no membership row here.
				</p>
			</div>

			{membersQuery.isLoading && <div className="text-sm text-zinc-400">Loading members…</div>}

			{/* Stated verbatim rather than degraded to the empty state, which would tell an
			    administrator of a populated project that it has nobody on it. */}
			{membersQuery.isError && (
				<div className={ERROR_BANNER_CLASS}>
					Failed to load members: {membersQuery.error.message}
				</div>
			)}

			{members && members.length === 0 && (
				<div className="border border-zinc-800 rounded-lg bg-panel/20 p-8 text-center space-y-2">
					<Users className="w-12 h-12 stroke-1 text-zinc-700 mx-auto" />
					<p className="text-sm text-zinc-400">This project has no members yet.</p>
					<p className="text-xs text-zinc-500">
						Add an existing SWARM user below by their login identifier.
					</p>
				</div>
			)}

			{members && members.length > 0 && (
				// Server order is kept — `members.list` is alphabetical by login handle, and
				// no client-side sort is invented on top of it.
				<div className="border border-zinc-800 rounded-md overflow-hidden bg-panel/20 shadow-sm">
					<table className="w-full text-left border-collapse">
						<thead>
							<tr className="bg-zinc-800/30 border-b border-zinc-800">
								<th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
									Member
								</th>
								<th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
									Identifier
								</th>
								<th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
									Role
								</th>
								<th className="px-4 py-3">
									<span className="sr-only">Remove</span>
								</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-zinc-800/60">
							{members.map((member) => (
								<tr key={member.userId} className="hover:bg-zinc-800/40 transition-colors">
									<td className="px-4 py-3 text-sm text-zinc-200 break-words">
										{member.displayName}
									</td>
									{/* The login handle is a generated identifier, so it is mono and wraps
									    rather than forcing the table sideways (§2's mono/sans split). */}
									<td className="px-4 py-3 text-sm font-mono text-zinc-400 break-all">
										{member.identifier}
									</td>
									<td className="px-4 py-3">
										<select
											aria-label={`Role for ${member.identifier}`}
											value={member.role}
											disabled={pendingRoleUserIds.has(member.userId)}
											onChange={(e) => {
												void handleRoleChange(member.userId, e.target.value as ProjectRole);
											}}
											className={SELECT_CLASS}
										>
											{PROJECT_ROLE_OPTIONS.map((option) => (
												<option key={option} value={option}>
													{PROJECT_ROLE_COPY[option].label}
												</option>
											))}
										</select>
										{pendingRoleUserIds.has(member.userId) && (
											<p className="mt-1.5 text-xs text-zinc-400">Saving…</p>
										)}
										{roleErrors[member.userId] && (
											<p className="mt-1.5 text-xs text-red-400">{roleErrors[member.userId]}</p>
										)}
									</td>
									<td className="px-4 py-3 text-right">
										<button
											type="button"
											onClick={() => {
												removeMutation.reset();
												setRemoveTarget(member);
											}}
											aria-label={`Remove ${member.identifier}`}
											title="Remove"
											className="text-zinc-500 hover:text-red-400 p-1.5 rounded hover:bg-zinc-800/60 transition-colors"
										>
											<Trash2 className="w-4 h-4" />
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			<form onSubmit={handleAdd} className="border-t border-zinc-800 pt-6 space-y-4">
				<div>
					<h3 className="text-sm font-semibold text-zinc-200">Add a member</h3>
					<p className="text-xs text-zinc-400 mt-1">
						Name an existing SWARM user by their login identifier. Accounts themselves are still
						created with <span className="font-mono">swarm users add</span> — this grants access to
						the project, it does not sign anybody up.
					</p>
				</div>
				<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
					<div>
						<label
							htmlFor="add-member-identifier"
							className="block text-xs font-medium text-zinc-400"
						>
							Login identifier
						</label>
						<input
							id="add-member-identifier"
							value={identifier}
							onChange={(e) => {
								setIdentifier(e.target.value);
								addMutation.reset();
							}}
							disabled={addMutation.isPending}
							autoComplete="off"
							placeholder="ada"
							className={`${INPUT_CLASS} mt-1.5`}
						/>
					</div>
					<div>
						<label htmlFor="add-member-role" className="block text-xs font-medium text-zinc-400">
							Role
						</label>
						<select
							id="add-member-role"
							value={role}
							onChange={(e) => setRole(e.target.value as ProjectRole)}
							disabled={addMutation.isPending}
							className={`${SELECT_CLASS} mt-1.5`}
						>
							{PROJECT_ROLE_OPTIONS.map((option) => (
								<option key={option} value={option}>
									{PROJECT_ROLE_COPY[option].label}
								</option>
							))}
						</select>
						<p className="mt-1.5 text-xs text-zinc-500">{PROJECT_ROLE_COPY[role].description}</p>
					</div>
				</div>
				{addMutation.isError && (
					<div className={ERROR_BANNER_CLASS}>{addMutation.error.message}</div>
				)}
				<button
					type="submit"
					disabled={addMutation.isPending || identifier.trim().length === 0}
					className={PRIMARY_BUTTON_CLASS}
				>
					{addMutation.isPending ? 'Adding…' : 'Add member'}
				</button>
			</form>

			{/* Removing a member is not recoverable from this screen, so it is never a single
			    stray click — and never a native `confirm()` (`ai/DESIGN_SYSTEM.md` §7). */}
			<Modal open={!!removeTarget} onClose={closeRemoveDialog} title="Remove member">
				<div className="space-y-4">
					<p className="text-sm text-zinc-300">
						This removes{' '}
						<span className="font-semibold text-zinc-200">{removeTarget?.displayName}</span> (
						<span className="font-mono">{removeTarget?.identifier}</span>) from this project. They
						lose access to it and its runs until an administrator adds them back; their SWARM
						account and their membership of other projects are untouched.
					</p>
					{removeMutation.isError && (
						<div className={ERROR_BANNER_CLASS}>{removeMutation.error.message}</div>
					)}
					<ModalFooter
						primary={
							<button
								type="button"
								onClick={() =>
									removeTarget && removeMutation.mutate({ userId: removeTarget.userId })
								}
								disabled={removeMutation.isPending}
								className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-red-600 rounded-md hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 transition-colors disabled:opacity-55 disabled:cursor-not-allowed"
							>
								{removeMutation.isPending ? 'Removing…' : 'Remove'}
							</button>
						}
						secondary={
							<button
								type="button"
								onClick={closeRemoveDialog}
								disabled={removeMutation.isPending}
								className={SECONDARY_BUTTON_CLASS}
							>
								Cancel
							</button>
						}
					/>
				</div>
			</Modal>
		</div>
	);
}
