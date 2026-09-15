import { useQuery } from '@tanstack/react-query';
import { createRoute } from '@tanstack/react-router';
import { FolderGit2, Plus } from 'lucide-react';
import { useState } from 'react';
import { ProjectCreateDialog } from '@/components/projects/project-create-dialog.js';
import { ProjectsTable } from '@/components/projects/projects-table.js';
import { buttonClass } from '@/components/ui/button.js';
import { trpc } from '@/lib/trpc.js';
import { rootRoute } from '../__root.js';

function ProjectsRouteComponent() {
	const [createOpen, setCreateOpen] = useState(false);
	const projectsQuery = useQuery(trpc.projects.list.queryOptions());

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Projects</h1>
				<button
					type="button"
					onClick={() => setCreateOpen(true)}
					className={buttonClass('primary')}
				>
					<Plus className="h-4 w-4" />
					New Project
				</button>
			</div>

			{projectsQuery.isLoading ? (
				<div className="text-sm text-zinc-400">Loading projects…</div>
			) : projectsQuery.isError ? (
				<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
					{projectsQuery.error.message}
				</div>
			) : projectsQuery.data && projectsQuery.data.length > 0 ? (
				<ProjectsTable projects={projectsQuery.data} />
			) : (
				<div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-zinc-800 bg-panel/40 p-12 text-center shadow-sm">
					<FolderGit2 className="h-12 w-12 stroke-1 text-zinc-700" />
					<p className="text-sm text-zinc-400">
						No projects found. Get started by creating your first project.
					</p>
					<button
						type="button"
						onClick={() => setCreateOpen(true)}
						className={`${buttonClass('secondary', 'sm')} mt-2`}
					>
						New Project
					</button>
				</div>
			)}

			<ProjectCreateDialog open={createOpen} onOpenChange={setCreateOpen} />
		</div>
	);
}

export const projectsIndexRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/projects',
	component: ProjectsRouteComponent,
});
