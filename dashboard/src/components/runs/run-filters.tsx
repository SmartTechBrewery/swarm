import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { sortPipelinePhases } from '@/lib/pipeline-phases.js';
import { trpc } from '@/lib/trpc.js';
import { type RunPhaseFilter, runPhaseFilterSchema } from '@/types/runs.js';

/**
 * The Phase filter's labels. Title Case with an upper-case "CI", which `formatPhase`
 * (`@/lib/format.ts`, a hyphen→space replace) does not produce, so they are stated
 * rather than derived. Keyed by `RunPhaseFilter`, so a phase added to the filter
 * vocabulary fails to type-check until it is labelled here.
 */
const PHASE_FILTER_LABELS: Record<RunPhaseFilter, string> = {
	planning: 'Planning',
	implementation: 'Implementation',
	review: 'Review',
	'respond-to-review': 'Respond to Review',
	'respond-to-ci': 'Respond to CI',
	'resolve-conflicts': 'Resolve Conflicts',
};

/**
 * The phases this view can filter by, in the one canonical display order (issue
 * #548) — the sequence comes from the pipeline vocabulary, not from the order the
 * values happen to be written in above or in `runPhaseFilterSchema`.
 */
const PHASE_FILTER_OPTIONS = sortPipelinePhases(runPhaseFilterSchema.options);

interface RunFiltersProps {
	projectId?: string;
	status?: string;
	phase?: string;
	onProjectIdChange: (id: string | undefined) => void;
	onStatusChange: (status: string | undefined) => void;
	onPhaseChange: (phase: string | undefined) => void;
	onClear: () => void;
	/**
	 * Whether to render the Project selector. `true` for the global `/runs` view;
	 * `false` for the project-scoped Runs tab, where the project is already fixed
	 * so the selector would be redundant (issue #168).
	 */
	showProject?: boolean;
}

export function RunFilters({
	projectId,
	status,
	phase,
	onProjectIdChange,
	onStatusChange,
	onPhaseChange,
	onClear,
	showProject = true,
}: RunFiltersProps) {
	// Only the Project selector consumes this list, so skip the fetch when it's
	// hidden (scoped Runs tab). The global view keeps its default `showProject`,
	// so it still loads projects.
	const projectsQuery = useQuery({ ...trpc.projects.list.queryOptions(), enabled: showProject });

	// The project filter is excluded from the "active filters" check when hidden,
	// so a scoped view's Clear button reflects only its status/phase filters.
	const hasActiveFilters = (showProject && projectId) || status || phase;

	return (
		<div className="flex flex-wrap items-end gap-4 p-4 border border-zinc-800 rounded-lg bg-panel/40 shadow-sm">
			{showProject && (
				<div className="flex-1 min-w-[200px]">
					<label
						htmlFor="filter-project"
						className="block text-xs font-medium text-zinc-400 mb-1.5"
					>
						Project
					</label>
					<select
						id="filter-project"
						value={projectId || ''}
						onChange={(e) => onProjectIdChange(e.target.value || undefined)}
						className="block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500"
					>
						<option value="">All Projects</option>
						{projectsQuery.data?.map((p) => (
							<option key={p.id} value={p.id}>
								{p.name} ({p.id})
							</option>
						))}
					</select>
				</div>
			)}

			<div className="w-[180px]">
				<label htmlFor="filter-status" className="block text-xs font-medium text-zinc-400 mb-1.5">
					Status
				</label>
				<select
					id="filter-status"
					value={status || ''}
					onChange={(e) => onStatusChange(e.target.value || undefined)}
					className="block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500"
				>
					<option value="">All Statuses</option>
					<option value="running">Running</option>
					<option value="completed">Completed</option>
					<option value="failed">Failed</option>
					<option value="deferred">Deferred</option>
					<option value="checkpointed">Checkpointed</option>
				</select>
			</div>

			<div className="w-[200px]">
				<label htmlFor="filter-phase" className="block text-xs font-medium text-zinc-400 mb-1.5">
					Phase
				</label>
				<select
					id="filter-phase"
					value={phase || ''}
					onChange={(e) => onPhaseChange(e.target.value || undefined)}
					className="block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500"
				>
					<option value="">All Phases</option>
					{PHASE_FILTER_OPTIONS.map((phaseOption) => (
						<option key={phaseOption} value={phaseOption}>
							{PHASE_FILTER_LABELS[phaseOption]}
						</option>
					))}
				</select>
			</div>

			{hasActiveFilters && (
				<button
					type="button"
					onClick={onClear}
					className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-zinc-400 hover:text-zinc-200 bg-zinc-900/50 border border-zinc-800 rounded hover:bg-zinc-800/60 transition-colors cursor-pointer h-[38px]"
				>
					<X className="h-3.5 w-3.5" />
					Clear Filters
				</button>
			)}
		</div>
	);
}
