import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import type { RepositoryForm } from '@/lib/project-repository.js';

/** Input/select recipe shared with the rest of the tab (ai/DESIGN_SYSTEM.md §4). */
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
 * four settings that are genuinely per-repository — merge automation among them since
 * issue #1066, which moved it off the Pipeline tab's project-wide toggle. Each field's accessible name carries
 * the rank, since a project can hold several identical-looking rows.
 *
 * The source-control provider is **not** among them (issue #727): it is the project's,
 * stated once for the whole project, and every repository the project owns lives on it.
 * A per-row selector existed here between issues #700 and #727 and could not be
 * completed — the credentials an overridden provider needs are project-wide, so there
 * was nowhere to enter them. Since issue #729 that one provider is stated directly
 * above this list, at the top of the same tab.
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
				<span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
					Repository {rank}
				</span>
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

			<label className="flex items-start gap-3 p-4 border border-zinc-800 rounded-md bg-panel/20 cursor-pointer hover:bg-zinc-800/20 transition-colors">
				<input
					type="checkbox"
					id={`${idBase}-auto-merge`}
					aria-label={`Merge automation, entry ${rank}`}
					checked={entry.autoMerge}
					onChange={(e) => onChange(index, { autoMerge: e.target.checked })}
					disabled={isPending}
					className="mt-0.5 h-4 w-4 accent-violet-600 disabled:opacity-50"
				/>
				<span>
					<span className="block text-sm font-medium text-zinc-200">Merge automation</span>
					<span className="block text-xs text-zinc-400 mt-1">
						After a SWARM review approves a pull request, merge it directly using the implementer
						credential, retrying briefly while checks settle. Repository rules still apply; SWARM
						never uses the provider's native auto-merge.
					</span>
				</span>
			</label>
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
 * The project's repositories, in order, with add/remove/reorder (issue #684 phase 3),
 * rendered as the last section of the Source Control tab since issue #729 — under the
 * provider these repositories live on and the credentials it authenticates with, so one
 * screen answers "which provider, authenticated how, operating on what".
 *
 * No entry is singled out as a default (issue #1063). Since issue #713 a board card runs
 * against the repository that claims it, and in a multi-repository project an unrouted or
 * ambiguous card is refused rather than sent to the first entry
 * (`src/router/webhook-receiver.ts`), so a "Default" badge and copy describing a fallback
 * made list order look load-bearing for work it does not route. The reorder controls stay:
 * order is still persisted, and the Projects list still shows the first entry.
 *
 * What is *not* here is anything shared by the whole project: the board mapping and the
 * PM credentials on Project Management, the provider and its credentials in the cards
 * above. Only the four settings that are genuinely per-repository are here.
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
				<h2 className="text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4">
					Repositories
				</h2>
				<p className="text-xs text-zinc-400">
					Every repository this project operates on, with the branch and merge settings SWARM uses
					for each. Each piece of work runs against the repository it belongs to — a board card
					against the repository that claims it — and none of them is a fallback for the others:
					with several repositories, a card none of them claims is refused rather than run against
					the first. All of them live on the provider selected above, using the credentials
					configured with it.
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
		</div>
	);
}
