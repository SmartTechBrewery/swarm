import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { FolderGit2, Gauge, LogOut, Play, Plus, Server, Settings } from 'lucide-react';
import { useState } from 'react';
import { ProjectCreateDialog } from '@/components/projects/project-create-dialog.js';
import { logout } from '@/lib/auth.js';
import { canViewInstanceWide } from '@/lib/instance-admin.js';
import { trpc } from '@/lib/trpc.js';
import { useCurrentUser } from '@/lib/use-current-user.js';
import { version } from '../../../../package.json';

export function Sidebar() {
	const currentPath = useRouterState({ select: (s) => s.location.pathname });
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const pingQuery = useQuery(trpc.ping.ping.queryOptions());
	const projectsQuery = useQuery(trpc.projects.list.queryOptions());
	const currentUser = useCurrentUser();
	const [createOpen, setCreateOpen] = useState(false);

	const handleLogout = async () => {
		await logout();
		// Drop all cached (now-unauthenticated) query state and return to login.
		queryClient.clear();
		navigate({ to: '/login' });
	};

	return (
		<div className="flex w-full md:w-64 flex-col justify-between border-r border-zinc-800 bg-panel">
			<div>
				<div className="flex h-14 items-center justify-between border-b border-zinc-850 px-4">
					<span className="text-sm font-semibold text-zinc-100">SWARM</span>
					<span className="px-2 py-0.5 text-[10px] uppercase font-mono font-bold tracking-wider bg-zinc-850 text-zinc-400 rounded border border-zinc-800">
						v{version}
					</span>
				</div>
				<nav className="space-y-1 p-2">
					{/* The two installation-wide screens, offered only to an instance
					    administrator (issue #647) — a worker owner reaches the same runs
					    and workers, scoped, through their project links below. */}
					{canViewInstanceWide(currentUser.data) && (
						<>
							<Link
								to="/runs"
								className={
									currentPath.startsWith('/runs')
										? 'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium bg-zinc-800/40 text-zinc-100'
										: 'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800/40'
								}
							>
								<Play className="h-4 w-4" />
								Runs
							</Link>

							<Link
								to="/workers"
								className={
									currentPath.startsWith('/workers')
										? 'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium bg-zinc-800/40 text-zinc-100'
										: 'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800/40'
								}
							>
								<Server className="h-4 w-4" />
								Workers
							</Link>
						</>
					)}

					<div className="flex items-center justify-between px-3 pt-4 pb-1">
						<span className="text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
							Projects
						</span>
						<button
							type="button"
							onClick={() => setCreateOpen(true)}
							className="flex h-5 w-5 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800/40 hover:text-zinc-100 transition-colors"
							title="New Project"
						>
							<Plus className="h-3.5 w-3.5" />
						</button>
					</div>

					<div className="flex flex-col gap-0.5">
						{projectsQuery.isLoading ? (
							<div className="px-3 py-2 text-xs text-zinc-500">Loading…</div>
						) : projectsQuery.isError ? (
							<div className="px-3 py-2 text-xs text-red-400">Error loading projects</div>
						) : projectsQuery.data && projectsQuery.data.length > 0 ? (
							projectsQuery.data.map((project) => (
								<Link
									key={project.id}
									to="/projects/$projectId"
									params={{ projectId: project.id }}
									className={
										currentPath === `/projects/${project.id}`
											? 'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium bg-zinc-800/40 text-zinc-100'
											: 'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800/40'
									}
								>
									<FolderGit2 className="h-4 w-4 shrink-0 text-zinc-400" />
									<span className="truncate">{project.name}</span>
								</Link>
							))
						) : (
							<button
								type="button"
								onClick={() => setCreateOpen(true)}
								className="flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-zinc-500 hover:bg-zinc-800/40 hover:text-zinc-300 text-left transition-colors"
							>
								<Plus className="h-4 w-4" />
								Create a project
							</button>
						)}
					</div>

					<div className="px-3 pt-4 pb-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
						Settings
					</div>
					<Link
						to="/settings"
						className={
							currentPath.startsWith('/settings')
								? 'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium bg-zinc-800/40 text-zinc-100'
								: 'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800/40'
						}
					>
						<Settings className="h-4 w-4" />
						General
					</Link>

					<div className="px-3 pt-4 pb-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
						Other
					</div>
					<Link
						to="/quota"
						className={
							currentPath.startsWith('/quota')
								? 'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium bg-zinc-800/40 text-zinc-100'
								: 'flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-zinc-300 hover:bg-zinc-800/40'
						}
					>
						<Gauge className="h-4 w-4" />
						CLI Quota
					</Link>
				</nav>
			</div>
			<div>
				{currentUser.data && (
					<div className="flex items-center justify-between gap-2 border-t border-zinc-850 px-4 py-3">
						{/* The signed-in user's name is the way into their own profile
						    (issue #659) — it was a label until then. `min-w-0 truncate` stays
						    so a long name can't push the Sign out button off the row. */}
						<Link
							to="/profile"
							className={
								currentPath.startsWith('/profile')
									? 'min-w-0 truncate text-xs text-zinc-100'
									: 'min-w-0 truncate text-xs text-zinc-400 hover:text-zinc-200 transition-colors'
							}
							title={currentUser.data.identifier}
						>
							{currentUser.data.displayName}
						</Link>
						<button
							type="button"
							onClick={handleLogout}
							className="flex items-center gap-1 rounded px-1.5 py-1 text-xs text-zinc-500 hover:bg-zinc-800/40 hover:text-zinc-200 transition-colors shrink-0"
							title="Sign out"
						>
							<LogOut className="h-3.5 w-3.5" />
							Sign out
						</button>
					</div>
				)}
				<div className="flex items-center gap-2 border-t border-zinc-850 p-4">
					<span
						className={
							pingQuery.isSuccess
								? 'h-2 w-2 rounded-full bg-emerald-500 ring-4 ring-emerald-500/10'
								: pingQuery.isError
									? 'h-2 w-2 rounded-full bg-red-500 ring-4 ring-red-500/10'
									: 'h-2 w-2 rounded-full bg-zinc-600 ring-4 ring-zinc-600/10'
						}
					/>
					<span className="text-xs text-zinc-500">
						{pingQuery.isSuccess ? 'Connected' : pingQuery.isError ? 'Disconnected' : 'Connecting…'}
					</span>
				</div>
			</div>
			<ProjectCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
		</div>
	);
}
