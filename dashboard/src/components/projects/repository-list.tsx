import { ChevronDown, ChevronUp, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { buttonClass } from '@/components/ui/button.js';
import {
	branchPatternPatch,
	effectiveBranchPattern,
	type RepositoryForm,
	repoInputShape,
} from '@/lib/project-repository.js';
import type { ReviewChecksPolicy } from '../../../../src/config/schema.js';
import { branchPatternFromPrefix } from '../../../../src/pipeline/branch-pattern.js';
import { BranchPatternDialog } from './branch-pattern-dialog.js';

/** Input/select recipe shared with the rest of the tab (ai/DESIGN_SYSTEM.md §4). */
const FIELD_CLASS =
	'block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 transition-shadow disabled:opacity-50 disabled:cursor-not-allowed';

const LABEL_CLASS = 'block text-xs font-medium text-zinc-400 mb-1';

/**
 * Review's two zero-check policies (issue #274), offered per repository since issue
 * #1109 — whether a repository has CI on its pull requests is that repository's own
 * property, so it is decided here rather than on the Pipeline tab.
 */
const REVIEW_CHECKS_POLICY_OPTIONS: Array<{
	value: ReviewChecksPolicy;
	label: string;
	description: string;
}> = [
	{
		value: 'required',
		label: 'Require CI checks',
		description:
			'A pull request whose head commit reports zero checks stays pending and is rechecked. Use this when the repository runs CI on pull requests.',
	},
	{
		value: 'if-present',
		label: 'Review when no checks exist',
		description:
			'Dispatches Review immediately when the source-control provider reports zero checks at all. Only for repositories with no CI on pull requests — a pull request with real pending, passing, or failing checks keeps the same behavior either way; this is not a way to bypass CI that exists.',
	},
];

/** Icon-button recipe for a row's reorder/remove actions (ai/DESIGN_SYSTEM.md §4). */
const ROW_ACTION_CLASS =
	'p-1.5 rounded text-zinc-500 hover:bg-zinc-800/60 focus:outline-none focus:ring-1 focus:ring-violet-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

interface RepositoryRowProps {
	entry: RepositoryForm;
	index: number;
	/** Total number of rows — the last one can't move down, or be removed at all. */
	total: number;
	/** The project's SCM provider, which decides how many segments `repo` has. */
	scm: string | null | undefined;
	isPending: boolean;
	onChange: (index: number, patch: Partial<Omit<RepositoryForm, 'id'>>) => void;
	onRemove: (index: number) => void;
	onMove: (index: number, direction: 'up' | 'down') => void;
}

/**
 * One repository in the project's list: its rank, the reorder/remove actions, and the
 * settings that are genuinely per-repository — merge automation among them since issue
 * #1066, Review's check policy and check wait since issue #1109, each moved off the
 * Pipeline tab's project-wide control, and the WIP limit since issue #1185. Each field's accessible name carries the rank,
 * since a project can hold several identical-looking rows.
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
	scm,
	isPending,
	onChange,
	onRemove,
	onMove,
}: RepositoryRowProps) {
	const rank = index + 1;
	const repoShape = repoInputShape(scm);
	const idBase = `repository-${index}`;
	const isOnly = total === 1;
	const policy = REVIEW_CHECKS_POLICY_OPTIONS.find(({ value }) => value === entry.reviewChecks);
	const branchPattern = effectiveBranchPattern(entry);
	const [editingPattern, setEditingPattern] = useState(false);

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
						pattern={repoShape.pattern}
						title={`Must be in format "${repoShape.placeholder}"`}
						placeholder={repoShape.placeholder}
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
					<label htmlFor={`${idBase}-branch-pattern`} className={LABEL_CLASS}>
						Branch Name Pattern
					</label>
					{/* Read-only on purpose (issue #1241): the pattern is composed and validated in
					    the editor, never typed here unchecked. */}
					<div className="flex gap-2">
						<input
							type="text"
							id={`${idBase}-branch-pattern`}
							aria-label={`Branch name pattern, entry ${rank}`}
							value={branchPattern}
							readOnly
							className={`${FIELD_CLASS} font-mono`}
						/>
						<button
							type="button"
							onClick={() => setEditingPattern(true)}
							disabled={isPending}
							aria-label={`Edit branch name pattern, entry ${rank}`}
							className={buttonClass('secondary')}
						>
							Edit
						</button>
					</div>
				</div>
			</div>
			<BranchPatternDialog
				open={editingPattern}
				pattern={branchPattern}
				legacyPattern={branchPatternFromPrefix(entry.branchPrefix)}
				rank={rank}
				onApply={(pattern) => {
					onChange(index, branchPatternPatch(entry, pattern));
					setEditingPattern(false);
				}}
				onCancel={() => setEditingPattern(false)}
			/>

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

			<div className="grid gap-4 sm:grid-cols-2">
				<div>
					<label htmlFor={`${idBase}-review-checks`} className={LABEL_CLASS}>
						Review Check Policy
					</label>
					<select
						id={`${idBase}-review-checks`}
						aria-label={`Review check policy, entry ${rank}`}
						value={entry.reviewChecks}
						onChange={(e) =>
							onChange(index, { reviewChecks: e.target.value as ReviewChecksPolicy })
						}
						disabled={isPending}
						className={FIELD_CLASS}
					>
						{REVIEW_CHECKS_POLICY_OPTIONS.map(({ value, label }) => (
							<option key={value} value={value}>
								{label}
							</option>
						))}
					</select>
					{policy && <p className="text-xs text-zinc-400 mt-1">{policy.description}</p>}
				</div>
				<div>
					<label htmlFor={`${idBase}-checks-wait`} className={LABEL_CLASS}>
						Check Wait (minutes)
					</label>
					<input
						type="number"
						id={`${idBase}-checks-wait`}
						aria-label={`Check wait in minutes, entry ${rank}`}
						value={entry.reviewChecksWaitMinutes}
						onChange={(e) => onChange(index, { reviewChecksWaitMinutes: e.target.value })}
						disabled={isPending}
						min={1}
						max={120}
						step={1}
						placeholder="10"
						className={FIELD_CLASS}
					/>
					<p className="text-xs text-zinc-400 mt-1">
						How long Review waits for this repository's checks to finish before giving up. Leave
						blank for 10 minutes.
					</p>
				</div>
				<div>
					<label htmlFor={`${idBase}-wip-limit`} className={LABEL_CLASS}>
						WIP Limit
					</label>
					<input
						type="number"
						id={`${idBase}-wip-limit`}
						aria-label={`WIP limit, entry ${rank}`}
						value={entry.wipLimit}
						onChange={(e) => onChange(index, { wipLimit: e.target.value })}
						disabled={isPending}
						min={1}
						step={1}
						placeholder="1"
						className={FIELD_CLASS}
					/>
					<p className="text-xs text-zinc-400 mt-1">
						How many tickets may be in flight at once in this repository, from Planning until their
						pull request is merged or closed. A new ticket waits in the queue for a free slot. Leave
						blank for 1.
					</p>
				</div>
			</div>
		</li>
	);
}

export interface RepositoryListProps {
	repositories: RepositoryForm[];
	/** Repositories more than one row claims; Save is blocked while this is non-empty. */
	duplicates: string[];
	/**
	 * The project's SCM provider — every repository it owns lives on it (issue #727) —
	 * so each row's input takes that provider's shape: three segments on Azure DevOps.
	 */
	scm?: string | null;
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
 * above. Only the settings that are genuinely per-repository are here.
 */
export function RepositoryList({
	repositories,
	duplicates,
	scm,
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
					Every repository this project operates on, with the branch, merge, Review check and WIP
					limit settings SWARM uses for each. Each piece of work runs against the repository it
					belongs to — a board card against the repository that claims it — and none of them is a
					fallback for the others: with several repositories, a card none of them claims is refused
					rather than run against the first. All of them live on the provider selected above, using
					the credentials configured with it.
				</p>
			</div>

			<ol className="space-y-3">
				{repositories.map((entry, index) => (
					<RepositoryRow
						key={entry.id}
						entry={entry}
						index={index}
						total={repositories.length}
						scm={scm}
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
