import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { FolderGit2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge.js';
import { trpc } from '@/lib/trpc.js';
import { useCurrentUser } from '@/lib/use-current-user.js';
import type { ProjectRole } from '../../../../src/identity/membership.js';

/**
 * The projects the signed-in user can open, and what they hold on each (issue
 * #661) — the profile's **My Projects** tab, and the first place the dashboard
 * shows a per-project membership role as personal data rather than as a project's
 * own roster.
 *
 * **Visibility is the server's, and this adds none of its own.** Its one source is
 * the `projects.listMine` read model, an `authedProcedure` that resolves the viewer
 * from the session and takes no input, so the panel passes no user id and applies
 * no client-side filter. That procedure scopes with the same
 * `filterAccessibleProjects` rule `projects.list` runs on, so a project the viewer
 * may not discover is absent here for exactly the reason it is absent there — and a
 * `discoverable` project they have not joined is not listed either, since this tab
 * is about access already held rather than access available to ask for.
 *
 * **A missing role is reported, not invented.** Only an `instanceAdmin` reaches a
 * project with no membership row, so a `null` role means "access comes from the
 * installation role" and reads as {@link INSTALLATION_WIDE_COPY} rather than as a
 * fabricated `projectAdmin` — a membership the viewer would keep if their
 * installation role were removed, which they would not.
 *
 * **It is read-only.** Joining, leaving, and role changes stay with a project's
 * administrators and the `swarm members` CLI, so this tab offers no control and
 * each entry simply links to the existing `/projects/$projectId` screen.
 */

/** One row of `projects.listMine` — the whole of what this panel reads. */
interface MyProject {
	id: string;
	name: string;
	role: ProjectRole | null;
}

/**
 * The project roles in the viewer's own terms. A `Record` over the enum, so a role
 * added to `ProjectRoleSchema` is a compile error here rather than a silently
 * unlabelled badge (the pattern `account-panel.tsx` applies to installation roles).
 */
const ROLE_COPY: Record<ProjectRole, { label: string; description: string }> = {
	projectAdmin: {
		label: 'Project administrator',
		description: 'Administers this project’s configuration, credentials, and membership.',
	},
	member: {
		label: 'Member',
		description: 'Works on this project and may drive its runs.',
	},
	contributor: {
		label: 'Contributor',
		description: 'Read-only access to this project and its runs.',
	},
};

/**
 * What a `null` role says. Deliberately not a fourth entry in {@link ROLE_COPY}:
 * this is the *absence* of a membership, and wording it as a project role would be
 * the invented membership the read model refuses to return.
 */
const INSTALLATION_WIDE_COPY = {
	label: 'Installation-wide',
	description:
		'You reach this project through your instance administrator role — you hold no membership on it.',
};

export function MyProjectsPanel() {
	const projectsQuery = useQuery(trpc.projects.listMine.queryOptions());
	// Only to word the helper line: an instance administrator's access to a project
	// they *are* a member of also comes from the installation role, which the per-row
	// membership badge cannot say on its own.
	const currentUser = useCurrentUser();

	// Annotated, not cast: the query's inferred type has to *satisfy* the shape this
	// panel renders, so a read-model change the panel does not handle fails the
	// typecheck instead of surfacing as a runtime surprise.
	const projects: MyProject[] | undefined = projectsQuery.data;

	if (projectsQuery.isLoading) {
		return <div className="text-sm text-zinc-400">Loading projects…</div>;
	}
	// A failure is stated verbatim rather than degraded to the empty state, which
	// would tell a member of several projects that they belong to none.
	if (projectsQuery.isError) {
		return (
			<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
				{projectsQuery.error.message}
			</div>
		);
	}
	if (!projects || projects.length === 0) {
		return (
			<div className="border border-zinc-800 rounded-lg bg-panel/20 p-8 text-center space-y-2">
				<FolderGit2 className="w-12 h-12 stroke-1 text-zinc-700 mx-auto" />
				<p className="text-sm text-zinc-400">You are not a member of any project yet.</p>
				<p className="text-xs text-zinc-500">
					A project administrator can add you, or you can ask to join an open project from the
					Projects screen.
				</p>
			</div>
		);
	}

	return (
		<div className="space-y-3">
			<p className="text-xs text-zinc-400">
				The projects you can open, and what you hold on each. Membership is granted by a project's
				own administrators with the <span className="font-mono">swarm members</span> CLI — it is not
				editable here.
			</p>
			{currentUser.data?.instanceAdmin ? (
				<p className="text-xs text-zinc-500">
					You are an instance administrator, so every project on this installation is listed and you
					administer each one whatever role is shown. A row marked{' '}
					<span className="text-zinc-400">{INSTALLATION_WIDE_COPY.label}</span> is one you hold no
					membership on.
				</p>
			) : null}
			{/* Server order is kept — no client-side sort is invented on top of it. */}
			<div className="border border-zinc-800 rounded-md overflow-hidden bg-panel/20 shadow-sm">
				<table className="w-full text-left border-collapse">
					<thead>
						<tr className="bg-zinc-800/30 border-b border-zinc-800">
							<th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
								Project
							</th>
							<th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
								Your role
							</th>
						</tr>
					</thead>
					<tbody className="divide-y divide-zinc-800/60">
						{projects.map((project) => {
							const copy = project.role ? ROLE_COPY[project.role] : INSTALLATION_WIDE_COPY;
							return (
								<tr key={project.id} className="hover:bg-zinc-800/40 transition-colors">
									<td className="px-4 py-3">
										<Link
											to="/projects/$projectId"
											params={{ projectId: project.id }}
											className="text-sm text-zinc-200 hover:text-violet-300 transition-colors break-words"
										>
											{project.name}
										</Link>
										{/* The generated identifier under the human-written name (§2's mono/sans split). */}
										<div className="text-xs font-mono text-zinc-500 break-all">{project.id}</div>
									</td>
									<td className="px-4 py-3">
										{/* Neutral for every row: a badge's hue carries state, and using one to
										    promote a role would rank the set by colour. */}
										<Badge>{copy.label}</Badge>
										<p className="mt-1.5 text-xs text-zinc-400">{copy.description}</p>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</div>
	);
}
