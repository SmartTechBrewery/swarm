import { useNavigate } from '@tanstack/react-router';

interface Project {
	id: string;
	name: string;
	repo: string;
	repoRoot: string;
}

interface ProjectsTableProps {
	projects: Project[];
}

export function ProjectsTable({ projects }: ProjectsTableProps) {
	const navigate = useNavigate();

	return (
		<div className="border border-zinc-800 rounded-md overflow-hidden bg-panel/20 shadow-sm">
			<table className="w-full text-left border-collapse">
				<thead>
					<tr className="bg-zinc-800/30 border-b border-zinc-800">
						<th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
							ID
						</th>
						<th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
							Name
						</th>
						<th className="px-4 py-3 text-xs font-semibold uppercase tracking-wider text-zinc-400">
							Repository
						</th>
					</tr>
				</thead>
				<tbody className="divide-y divide-zinc-800/60">
					{projects.map((project) => (
						<tr
							key={project.id}
							onClick={() =>
								navigate({ to: '/projects/$projectId', params: { projectId: project.id } })
							}
							className="hover:bg-zinc-800/40 transition-colors cursor-pointer"
						>
							<td className="px-4 py-3 text-sm font-mono text-zinc-300">{project.id}</td>
							<td className="px-4 py-3 text-sm text-zinc-200">{project.name}</td>
							<td className="px-4 py-3 text-sm font-mono text-zinc-300">{project.repo}</td>
						</tr>
					))}
				</tbody>
			</table>
		</div>
	);
}
