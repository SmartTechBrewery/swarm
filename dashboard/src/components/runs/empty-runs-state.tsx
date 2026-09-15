import { Play } from 'lucide-react';
import { buttonClass } from '@/components/ui/button.js';

interface EmptyRunsStateProps {
	hasFilters: boolean;
	onClear: () => void;
}

/**
 * Shared empty state for run-history views — the global `/runs` route and the
 * project-scoped Runs tab. When filters are active it offers a "Clear Filters"
 * action; otherwise it hints how runs get created.
 */
export function EmptyRunsState({ hasFilters, onClear }: EmptyRunsStateProps) {
	return (
		<div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-zinc-800 bg-panel/40 p-12 text-center shadow-sm">
			<Play className="h-12 w-12 stroke-1 text-zinc-700" />
			<p className="text-sm text-zinc-400">No pipeline runs found.</p>
			{hasFilters ? (
				<button
					type="button"
					onClick={onClear}
					className={`${buttonClass('secondary', 'sm')} mt-2`}
				>
					Clear Filters
				</button>
			) : (
				<p className="text-xs text-zinc-500">
					Run pipeline tasks from your terminal to see them listed here.
				</p>
			)}
		</div>
	);
}
