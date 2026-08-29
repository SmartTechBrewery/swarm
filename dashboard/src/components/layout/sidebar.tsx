import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import {
	CircleCheck,
	CircleDashed,
	CircleX,
	FolderGit2,
	Gauge,
	LogOut,
	Play,
	Plus,
	Server,
	Settings,
	User,
} from 'lucide-react';
import { useState } from 'react';
import { ProjectCreateDialog } from '@/components/projects/project-create-dialog.js';
import { logout } from '@/lib/auth.js';
import { canViewInstanceWide } from '@/lib/instance-admin.js';
import { trpc } from '@/lib/trpc.js';
import { useCurrentUser } from '@/lib/use-current-user.js';
import { version } from '../../../../package.json';

// Each connection state gets its own icon shape (not just a color), so the
// state reads without relying on color perception (issue #665).
const CONNECTION_STATE_META = {
	connected: {
		Icon: CircleCheck,
		label: 'Connected',
		iconClassName: 'h-3.5 w-3.5 text-emerald-500',
	},
	disconnected: { Icon: CircleX, label: 'Disconnected', iconClassName: 'h-3.5 w-3.5 text-red-500' },
	connecting: {
		Icon: CircleDashed,
		label: 'Connecting…',
		iconClassName: 'h-3.5 w-3.5 text-zinc-500',
	},
} as const;

export function Sidebar() {
	const currentPath = useRouterState({ select: (s) => s.location.pathname });
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const pingQuery = useQuery(trpc.ping.ping.queryOptions());
	const projectsQuery = useQuery(trpc.projects.list.queryOptions());
	const currentUser = useCurrentUser();
	const [createOpen, setCreateOpen] = useState(false);

	const connectionState: keyof typeof CONNECTION_STATE_META = pingQuery.isSuccess
		? 'connected'
		: pingQuery.isError
			? 'disconnected'
			: 'connecting';
	const {
		Icon: ConnectionIcon,
		label: connectionLabel,
		iconClassName: connectionIconClassName,
	} = CONNECTION_STATE_META[connectionState];

	const handleLogout = async () => {
		await logout();
		// Drop all cached (now-unauthenticated) query state and return to login.
		queryClient.clear();
		navigate({ to: '/login' });
	};

	return (
		<div className="flex w-full md:sticky md:top-0 md:h-screen md:w-64 flex-col border-r border-zinc-800 bg-panel">
			{/* Only the wordmark + nav column scrolls, so the account row below stays
			    pinned to the bottom of the sidebar however long the project list grows
			    (issue #665). Desktop only: below `md` the sidebar stacks full-width
			    above the content, where a pinned full-height column would eat the
			    whole phone screen, so there it flows with the page as before. */}
			<div className="md:min-h-0 md:flex-1 md:overflow-y-auto">
				<div className="flex h-14 items-center justify-between border-b border-zinc-850 px-4">
					<span className="text-sm font-semibold text-zinc-100">SWARM</span>
					<span className="px-2 py-0.5 text-[10px] uppercase font-mono font-bold tracking-wider bg-zinc-850 text-zinc-400 rounded border border-zinc-800">
						v{version}
					</span>
				</div>
				<nav className="space-y-1 p-2">
					{/* Runs is offered to everyone since issue #821: the cross-project list
					    is bounded server-side to the reader's own projects, so a member
					    reaching it here sees their work across every project rather than
					    one project at a time. */}
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

					{/* Workers stays installation-wide, so it is still offered only to an
					    instance administrator (issue #647) — a worker owner reaches their
					    own machines, scoped, through their project links below. */}
					{canViewInstanceWide(currentUser.data) && (
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
			{/* The account area: one compact row that never scrolls away, so the
			    profile and Sign out stay reachable from anywhere in the nav (#665). */}
			{currentUser.data && (
				<div className="flex shrink-0 items-center gap-2 border-t border-zinc-850 px-4 py-3">
					{/* The signed-in user's name is the way into their own profile
					    (issue #659) — it was a label until then. Its leading icon says so:
					    a plain outlined profile bust, decorative (`aria-hidden`) because the
					    visible name is still the link's accessible name. It used to be the
					    connection status that sat here, which read as a checkmark labelling
					    the account (issue #680). `min-w-0 truncate` stays on the name so a
					    long one can't push the Sign out button off the row. */}
					<Link
						to="/profile"
						className={
							currentPath.startsWith('/profile')
								? 'flex min-w-0 flex-1 items-center gap-2 text-xs text-zinc-100'
								: 'flex min-w-0 flex-1 items-center gap-2 text-xs text-zinc-400 hover:text-zinc-200 transition-colors'
						}
						title={currentUser.data.identifier}
					>
						<User aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
						<span className="truncate">{currentUser.data.displayName}</span>
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
					{/* The connection state survived the removal of its "Connected" text
					    (#665) — the footer is an account area now, and the status reads
					    fine as an icon. Each state gets its own shape (not just a color),
					    and `role="status"` + `aria-label` give it an accessible, live-
					    announced name without needing a focusable control or a visible
					    label put back: nothing renders `connectionLabel` in the sidebar.
					    It trails the row rather than leading it (#680): a state icon in
					    front of the name was read as the account entry's own icon. */}
					<span
						role="status"
						aria-label={connectionLabel}
						title={connectionLabel}
						className="shrink-0"
					>
						<ConnectionIcon aria-hidden="true" className={connectionIconClassName} />
					</span>
				</div>
			)}
			<ProjectCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
		</div>
	);
}
