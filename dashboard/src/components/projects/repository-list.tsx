import { AlertTriangle, ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import type { RepositoryForm } from '@/lib/project-repository.js';

/** Input/select recipe shared with the rest of the General tab (ai/DESIGN_SYSTEM.md §4). */
const FIELD_CLASS =
	'block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 transition-shadow disabled:opacity-50 disabled:cursor-not-allowed';

const LABEL_CLASS = 'block text-xs font-medium text-zinc-400 mb-1';

/** Icon-button recipe for a row's reorder/remove actions (ai/DESIGN_SYSTEM.md §4). */
const ROW_ACTION_CLASS =
	'p-1.5 rounded text-zinc-500 hover:bg-zinc-800/60 focus:outline-none focus:ring-1 focus:ring-violet-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

interface RepositoryRowProps {
	entry: RepositoryForm;
	index: number;
	/** Total number of rows — the last one can't move down, or be removed at all. */
	total: number;
	isPending: boolean;
	onChange: (index: number, patch: Partial<Omit<RepositoryForm, 'id'>>) => void;
	onRemove: (index: number) => void;
	onMove: (index: number, direction: 'up' | 'down') => void;
}

/**
 * One repository in the project's list: its rank, the reorder/remove actions, and the
 * three settings that are genuinely per-repository. Each field's accessible name carries
 * the rank, since a project can hold several identical-looking rows.
 *
 * The source-control provider is **not** among them (issue #727): it is the project's,
 * stated once on the Source Control tab, and every repository the project owns lives on
 * it. A per-row selector existed here between issues #700 and #727 and could not be
 * completed — the credentials an overridden provider needs are project-wide, so there
 * was nowhere to enter them.
 */
function RepositoryRow({
	entry,
	index,
	total,
	isPending,
	onChange,
	onRemove,
	onMove,
}: RepositoryRowProps) {
	const rank = index + 1;
	const idBase = `repository-${index}`;
	const isOnly = total === 1;

	return (
		<li className="p-4 border border-zinc-800 rounded-md bg-panel/20 space-y-3">
			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
						Repository {rank}
					</span>
					{index === 0 && (
						<span className="px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-violet-300 bg-violet-950/40 border border-violet-900/40 rounded">
							Default
						</span>
					)}
				</div>
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={() => onMove(index, 'up')}
						disabled={isPending || index === 0}
						aria-label={`Move repository ${rank} up`}
						className={`${ROW_ACTION_CLASS} hover:text-zinc-200`}
					>
						<ChevronUp className="h-4 w-4" aria-hidden="true" />
					</button>
					<button
						type="button"
						onClick={() => onMove(index, 'down')}
						disabled={isPending || index === total - 1}
						aria-label={`Move repository ${rank} down`}
						className={`${ROW_ACTION_CLASS} hover:text-zinc-200`}
					>
						<ChevronDown className="h-4 w-4" aria-hidden="true" />
					</button>
					{/* Disabled rather than hidden on the last row, with the reason on it: the
					    control states the rule instead of quietly disappearing. */}
					<button
						type="button"
						onClick={() => onRemove(index)}
						disabled={isPending || isOnly}
						aria-label={`Remove repository ${rank}`}
						title={isOnly ? 'A project must operate on at least one repository.' : undefined}
						className={`${ROW_ACTION_CLASS} hover:text-red-400`}
					>
						<Trash2 className="h-4 w-4" aria-hidden="true" />
					</button>
				</div>
			</div>

			<div className="grid gap-4 sm:grid-cols-2">
				<div className="sm:col-span-2">
					<label htmlFor={`${idBase}-repo`} className={LABEL_CLASS}>
						Repository <span className="text-red-500">*</span>
					</label>
					<input
						type="text"
						id={`${idBase}-repo`}
						aria-label={`Repository, entry ${rank}`}
						value={entry.repo}
						onChange={(e) => onChange(index, { repo: e.target.value })}
						disabled={isPending}
						required
						pattern="[^/]+/[^/]+"
						placeholder="owner/repo"
						className={`${FIELD_CLASS} font-mono`}
					/>
				</div>
				<div>
					<label htmlFor={`${idBase}-base-branch`} className={LABEL_CLASS}>
						Base Branch <span className="text-red-500">*</span>
					</label>
					<input
						type="text"
						id={`${idBase}-base-branch`}
						aria-label={`Base branch, entry ${rank}`}
						value={entry.baseBranch}
						onChange={(e) => onChange(index, { baseBranch: e.target.value })}
						disabled={isPending}
						required
						placeholder="main"
						className={FIELD_CLASS}
					/>
				</div>
				<div>
					<label htmlFor={`${idBase}-branch-prefix`} className={LABEL_CLASS}>
						Branch Prefix
					</label>
					<input
						type="text"
						id={`${idBase}-branch-prefix`}
						aria-label={`Branch prefix, entry ${rank}`}
						value={entry.branchPrefix}
						onChange={(e) => onChange(index, { branchPrefix: e.target.value })}
						disabled={isPending}
						placeholder="issue-"
						className={`${FIELD_CLASS} font-mono`}
					/>
				</div>
			</div>
		</li>
	);
}

export interface RepositoryListProps {
	repositories: RepositoryForm[];
	/** Repositories more than one row claims; Save is blocked while this is non-empty. */
	duplicates: string[];
	isPending: boolean;
	onChange: (index: number, patch: Partial<Omit<RepositoryForm, 'id'>>) => void;
	onAdd: () => void;
	onRemove: (index: number) => void;
	onMove: (index: number, direction: 'up' | 'down') => void;
}

/**
 * The project's repositories, in order, with add/remove/reorder (issue #684 phase 3).
 *
 * Order is what the list means: the **first** entry is the project's default, the one
 * work that names no repository of its own runs against — board-driven Planning and
 * Implementation — so the helper text and the "Default" badge say so rather than leaving
 * the ranking to look decorative. Everything shared by the whole project stays on its own
 * tabs: the board mapping and the PM credentials on Project Management, the SCM provider
 * and its credentials on Source Control. Only the three settings that are genuinely
 * per-repository are here.
 */
export function RepositoryList({
	repositories,
	duplicates,
	isPending,
	onChange,
	onAdd,
	onRemove,
	onMove,
}: RepositoryListProps) {
	return (
		<div className="space-y-3">
			<div>
				<h3 className="text-sm font-semibold text-zinc-200">Repositories</h3>
				<p className="text-xs text-zinc-400 mt-1">
					Every repository this project operates on, with the branch settings SWARM uses for each.
					The first is the project's <strong className="font-semibold">default</strong>: work that
					names no repository of its own — board-driven Planning and Implementation — runs against
					it, so reorder the list to change which that is. All of them live on the project's
					source-control provider, which is set on the Source Control tab along with its
					credentials.
				</p>
			</div>

			<ol className="space-y-3">
				{repositories.map((entry, index) => (
					<RepositoryRow
						key={entry.id}
						entry={entry}
						index={index}
						total={repositories.length}
						isPending={isPending}
						onChange={onChange}
						onRemove={onRemove}
						onMove={onMove}
					/>
				))}
			</ol>

			<button
				type="button"
				onClick={onAdd}
				disabled={isPending}
				aria-label="Add repository"
				className="flex w-full items-center gap-3 border border-dashed border-zinc-800 rounded-md bg-panel/20 p-4 text-left transition-colors hover:bg-zinc-800/20 focus:outline-none focus:ring-2 focus:ring-violet-500 disabled:cursor-not-allowed disabled:opacity-55"
			>
				<Plus className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />
				<span>
					<span className="block text-sm font-medium text-zinc-200">Add repository</span>
					<span className="block text-xs text-zinc-400 mt-1">
						Add another repository this project operates on.
					</span>
				</span>
			</button>

			{duplicates.length > 0 && (
				<p className="text-xs text-red-400">
					Each repository can appear at most once — remove the duplicate entry for{' '}
					<span className="font-mono">{duplicates.join(', ')}</span> before saving.
				</p>
			)}

			{/* The list routes (issue #684 phase 2), but `repoRoot` is still one checkout per
			    project and a worker declares the single repository its checkout is, so a run for
			    a non-default repository is refused at provisioning (docs/configuration.md). Said
			    only once a second entry exists, where it is actually a consequence. */}
			{repositories.length > 1 && (
				<div className="p-4 bg-amber-950/20 border border-amber-900/30 rounded flex gap-3">
					<AlertTriangle className="w-5 h-5 shrink-0 text-amber-500" aria-hidden="true" />
					<div>
						<h4 className="text-xs font-semibold text-amber-200">
							A second repository is not yet fully usable
						</h4>
						<p className="text-xs text-amber-200/70 mt-1">
							The local repository root is a single checkout per project, and a worker host declares
							the one repository its checkout actually is. A run for anything other than the default
							repository is refused at provisioning rather than worked on in the wrong tree.
							Per-repository checkout roots are a follow-up.
						</p>
					</div>
				</div>
			)}
		</div>
	);
}
