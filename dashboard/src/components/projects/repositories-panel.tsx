import type React from 'react';
import type { RepositoryForm } from '@/lib/project-repository.js';
import { RepositoryList } from './repository-list.js';

/**
 * The Source Control tab's third card: the project's repository list, under the
 * provider and its credentials (issue #729).
 *
 * It lived on the Settings tab between issues #700 and #729, which meant configuring
 * source control took two tabs — one to say *which* provider, another to say what it
 * operates on. Nothing in a row is project identity or host layout: `repo` is an
 * `owner/repo` slug, `baseBranch` is what pull requests target and worktrees are cut
 * from, `branchPrefix` names task branches. So the tab now reads top-to-bottom as
 * provider → credentials → repositories, the shape issue #630 gave Project Management.
 * Settings keeps `name`, `repoRoot`, `worktreeRoot` and `maxConcurrentJobs`.
 *
 * `repoRoot`/`worktreeRoot` deliberately stayed there: they are **host** layout — one
 * local checkout path per project on whichever machine runs the work — rather than
 * repository configuration, which is also why a second repository is still refused at
 * provisioning (the caveat {@link RepositoryList} raises).
 *
 * **Saving is this card's own**, not shared with Settings: `projects.update` is a
 * partial patch, so this sends `repositories` alone and the Settings form sends
 * `name`/`repoRoot`/`worktreeRoot`/`maxConcurrentJobs` alone. That is what the other
 * tabs already do (Agents sends `agents`, Pipeline `pipeline`, Project Management `pm`),
 * and it is what keeps each tab's Save from carrying the other's unsaved edits — the
 * lost-update shape issue #369 removed. Both writes still go through the route's single
 * serialization gate, so only one is ever in flight.
 */
export interface RepositoriesPanelProps {
	repositories: RepositoryForm[];
	/** Repositories more than one row claims; Save is blocked while this is non-empty. */
	duplicates: string[];
	onChange: (index: number, patch: Partial<Omit<RepositoryForm, 'id'>>) => void;
	onAdd: () => void;
	onRemove: (index: number) => void;
	onMove: (index: number, direction: 'up' | 'down') => void;
	handleSubmit: (e: React.FormEvent) => void;
	handleReset: () => void;
	isDirty: boolean;
	isPending: boolean;
	isSuccess: boolean;
	isError: boolean;
	errorMessage?: string;
}

export function RepositoriesPanel({
	repositories,
	duplicates,
	onChange,
	onAdd,
	onRemove,
	onMove,
	handleSubmit,
	handleReset,
	isDirty,
	isPending,
	isSuccess,
	isError,
	errorMessage,
}: RepositoriesPanelProps) {
	return (
		<div className="border border-zinc-800 rounded-lg bg-panel/40 p-6 shadow-sm">
			<form onSubmit={handleSubmit} className="space-y-6">
				<RepositoryList
					repositories={repositories}
					duplicates={duplicates}
					isPending={isPending}
					onChange={onChange}
					onAdd={onAdd}
					onRemove={onRemove}
					onMove={onMove}
				/>

				{isSuccess && (
					<div className="p-3 bg-emerald-950/20 border border-emerald-900/30 text-sm text-emerald-400 rounded">
						Repositories saved successfully.
					</div>
				)}

				{/* Where a repository **another** project owns surfaces: `projects.update`
				    answers that with a CONFLICT rather than the client pre-checking it. */}
				{isError && (
					<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
						Failed to save repositories: {errorMessage}
					</div>
				)}

				<div className="flex items-center gap-2 border-t border-zinc-800 pt-4">
					{/* A repository listed twice would be accepted server-side — the conflict guard
					    only refuses one *another* project owns — so this is the one rule Save has
					    to hold on its own. */}
					<button
						type="submit"
						disabled={isPending || !isDirty || duplicates.length > 0}
						className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-violet-600 rounded-md hover:bg-violet-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-violet-500 transition-colors shadow-lg shadow-violet-650/10 disabled:opacity-55 disabled:cursor-not-allowed"
					>
						{isPending ? 'Saving…' : 'Save Changes'}
					</button>
					<button
						type="button"
						onClick={handleReset}
						disabled={isPending || !isDirty}
						className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-white focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors disabled:opacity-55 disabled:cursor-not-allowed"
					>
						Reset
					</button>
				</div>
			</form>
		</div>
	);
}
