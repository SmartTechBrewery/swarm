import { useState } from 'react';
import { buttonClass } from '@/components/ui/button.js';
import {
	effectiveBranchPattern,
	effectiveCommitSubjectMaxLength,
	effectiveCommitSubjectPattern,
	legacyBranchPattern,
	type RepositoryForm,
	sharedBranchPattern,
	sharedCommitSubjectNaming,
} from '@/lib/project-repository.js';
import { BranchPatternDialog } from './branch-pattern-dialog.js';
import { CommitSubjectPatternDialog } from './commit-subject-pattern-dialog.js';

/** Input recipe shared with the rest of the tab (ai/DESIGN_SYSTEM.md §4). */
const FIELD_CLASS =
	'block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 transition-shadow font-mono';

const LABEL_CLASS = 'block text-xs font-medium text-zinc-400 mb-1';

const DIFFERS_PLACEHOLDER = 'Differs between repositories';

export interface NamingPatternsProps {
	/** The repository rows the patterns are stored on — at least one, as the list guarantees. */
	repositories: RepositoryForm[];
	isPending: boolean;
	onApplyBranchPattern: (pattern: string) => void;
	onApplyCommitSubjectPattern: (pattern: string, maxLength: number) => void;
}

function repositoryName(row: RepositoryForm, index: number): string {
	return row.repo.trim() || `Repository ${index + 1}`;
}

/** The warning naming each repository's own value while the repositories disagree. */
function DifferingValues({
	heading,
	items,
}: {
	heading: string;
	items: Array<{ key: string; repository: string; value: string; note?: string }>;
}) {
	return (
		<div className="mt-2 p-4 bg-amber-950/20 border border-amber-900/30 rounded">
			<p className="text-xs font-semibold text-amber-200">{heading}</p>
			<p className="text-xs text-amber-200/70 mt-1">
				Each keeps its own until a pattern is applied here, which sets it for every repository.
			</p>
			<ul className="mt-2 space-y-1 text-xs text-amber-200/70">
				{items.map(({ key, repository, value, note }) => (
					<li key={key} className="break-all">
						<span className="font-mono">{repository}</span>:{' '}
						<span className="font-mono">{value}</span>
						{note && ` (${note})`}
					</li>
				))}
			</ul>
		</div>
	);
}

/**
 * The project's branch name and commit subject patterns (issue #1246), set once for every
 * repository on the Source Control tab rather than once per repository row.
 *
 * Storage did not move: each repository still carries `branchPattern` and
 * `commitSubjectPattern` (issues #1241, #1242), and everything that names a branch or a
 * commit keeps reading them per repository. This card is the one place they are edited,
 * and applying a pattern writes it to every row, so the tab's Save sends the same value
 * for each repository.
 *
 * A project whose repositories were configured apart may still hold different values.
 * The card then shows no project pattern — it lists each repository's instead — and the
 * editor states where it starts from, so nothing is silently picked.
 */
export function NamingPatterns({
	repositories,
	isPending,
	onApplyBranchPattern,
	onApplyCommitSubjectPattern,
}: NamingPatternsProps) {
	const [editingBranch, setEditingBranch] = useState(false);
	const [editingCommitSubject, setEditingCommitSubject] = useState(false);
	const [first] = repositories;
	if (!first) return null;

	const branchPattern = sharedBranchPattern(repositories);
	const commitSubject = sharedCommitSubjectNaming(repositories);
	const commitSubjectStart = commitSubject ?? first;

	return (
		<div className="space-y-3">
			<div>
				<h2 className="text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4">
					Branch and commit naming
				</h2>
				<p className="text-xs text-zinc-400">
					Set once for the whole project: every repository below names its task branches and words
					its commits by these patterns, and a repository added later starts on them.
				</p>
			</div>

			<div className="grid gap-4 sm:grid-cols-2">
				<div>
					<label htmlFor="project-branch-pattern" className={LABEL_CLASS}>
						Branch name pattern
					</label>
					{/* Read-only on purpose (issue #1241): the pattern is composed and validated in
					    the editor, never typed here unchecked. */}
					<div className="flex gap-2">
						<input
							type="text"
							id="project-branch-pattern"
							value={branchPattern ?? ''}
							placeholder={branchPattern === undefined ? DIFFERS_PLACEHOLDER : undefined}
							readOnly
							className={FIELD_CLASS}
						/>
						<button
							type="button"
							onClick={() => setEditingBranch(true)}
							disabled={isPending}
							aria-label="Edit branch name pattern"
							className={buttonClass('secondary')}
						>
							Edit
						</button>
					</div>
					{branchPattern === undefined && (
						<DifferingValues
							heading="The repositories use different branch name patterns."
							items={repositories.map((row, index) => ({
								key: row.id,
								repository: repositoryName(row, index),
								value: effectiveBranchPattern(row),
							}))}
						/>
					)}
				</div>
				<div>
					<label htmlFor="project-commit-subject-pattern" className={LABEL_CLASS}>
						Commit subject pattern
					</label>
					<div className="flex gap-2">
						<input
							type="text"
							id="project-commit-subject-pattern"
							value={commitSubject ? effectiveCommitSubjectPattern(commitSubject) : ''}
							placeholder={commitSubject ? undefined : DIFFERS_PLACEHOLDER}
							readOnly
							className={FIELD_CLASS}
						/>
						<button
							type="button"
							onClick={() => setEditingCommitSubject(true)}
							disabled={isPending}
							aria-label="Edit commit subject pattern"
							className={buttonClass('secondary')}
						>
							Edit
						</button>
					</div>
					<p className="text-xs text-zinc-400 mt-1">
						How SWARM words the project's commits and, once set, its pull request titles.
					</p>
					{!commitSubject && (
						<DifferingValues
							heading="The repositories use different commit subject patterns."
							items={repositories.map((row, index) => ({
								key: row.id,
								repository: repositoryName(row, index),
								value: effectiveCommitSubjectPattern(row),
								// Stating none differs from stating the default: pull requests keep their card's title.
								note: [
									...(row.commitSubjectPattern
										? []
										: ["not set, so pull requests keep their card's title"]),
									`limit ${effectiveCommitSubjectMaxLength(row)} characters`,
								].join('; '),
							}))}
						/>
					)}
				</div>
			</div>

			<BranchPatternDialog
				open={editingBranch}
				pattern={branchPattern ?? effectiveBranchPattern(first)}
				legacyPatterns={repositories.map(legacyBranchPattern)}
				differs={branchPattern === undefined}
				onApply={(pattern) => {
					onApplyBranchPattern(pattern);
					setEditingBranch(false);
				}}
				onCancel={() => setEditingBranch(false)}
			/>
			<CommitSubjectPatternDialog
				open={editingCommitSubject}
				pattern={effectiveCommitSubjectPattern(commitSubjectStart)}
				maxLength={effectiveCommitSubjectMaxLength(commitSubjectStart)}
				differs={!commitSubject}
				onApply={(pattern, maxLength) => {
					onApplyCommitSubjectPattern(pattern, maxLength);
					setEditingCommitSubject(false);
				}}
				onCancel={() => setEditingCommitSubject(false)}
			/>
		</div>
	);
}
