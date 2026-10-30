import { useEffect, useId, useRef, useState } from 'react';
import { buttonClass } from '@/components/ui/button.js';
import {
	COMMIT_SUBJECT_PATTERN_ELEMENT_DESCRIPTIONS,
	COMMIT_SUBJECT_PATTERN_ELEMENTS,
	renderCommitSubject,
	SAMPLE_COMMIT_SUBJECT_PARTS,
	validateCommitSubjectPattern,
} from '../../../../src/pipeline/commit-subject-pattern.js';
import { Modal, ModalFooter } from '../ui/modal.js';

/** Input recipe shared with the rest of the tab (ai/DESIGN_SYSTEM.md §4). */
const FIELD_CLASS =
	'block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-800 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 transition-shadow';

/** The length limit's bounds — the config schema's (`commitSubjectMaxLength`). */
const MIN_MAX_LENGTH = 20;
const MAX_MAX_LENGTH = 200;

interface CommitSubjectPatternDialogProps {
	open: boolean;
	/** The pattern the repository words its commit subjects by now — its own, or the default. */
	pattern: string;
	/** The rendered length the repository aims to stay within now. */
	maxLength: number;
	/** The repository's rank in the list, so the dialog says which entry it edits. */
	rank: number;
	onApply: (pattern: string, maxLength: number) => void;
	onCancel: () => void;
}

/**
 * The commit subject pattern editor (issue #1242), the branch name pattern editor's
 * twin: describes every element, composes the pattern, previews it for the same sample
 * task, warns when the preview runs over the repository's length limit, and refuses to
 * apply a pattern the server would refuse. The rules are `validateCommitSubjectPattern`
 * (`src/pipeline/commit-subject-pattern.ts`) — the very function the config schema
 * runs — so the two cannot disagree.
 *
 * Applying only edits the row: the pattern is persisted by the tab's own Save, like
 * every other repository setting.
 */
export function CommitSubjectPatternDialog({
	open,
	pattern,
	maxLength,
	rank,
	onApply,
	onCancel,
}: CommitSubjectPatternDialogProps) {
	const [draft, setDraft] = useState(pattern);
	const [lengthDraft, setLengthDraft] = useState(String(maxLength));
	const inputRef = useRef<HTMLInputElement>(null);
	const inputId = useId();
	const lengthId = useId();

	// Every opening starts from the repository's current values, not a cancelled draft.
	useEffect(() => {
		if (open) {
			setDraft(pattern);
			setLengthDraft(String(maxLength));
		}
	}, [open, pattern, maxLength]);

	const limit = Number(lengthDraft);
	const limitValid = Number.isInteger(limit) && limit >= MIN_MAX_LENGTH && limit <= MAX_MAX_LENGTH;
	const validation = validateCommitSubjectPattern(draft, limitValid ? limit : maxLength);
	const errors = limitValid
		? validation.errors
		: [
				...validation.errors,
				`The length limit must be a whole number from ${MIN_MAX_LENGTH} to ${MAX_MAX_LENGTH}.`,
			];
	const preview =
		validation.errors.length === 0 ? renderCommitSubject(draft, SAMPLE_COMMIT_SUBJECT_PARTS) : null;

	/** Insert `{name}` at the caret (or replacing the selection), keeping focus in the field. */
	const insertElement = (name: string): void => {
		const input = inputRef.current;
		const token = `{${name}}`;
		const start = input?.selectionStart ?? draft.length;
		const end = input?.selectionEnd ?? draft.length;
		const next = `${draft.slice(0, start)}${token}${draft.slice(end)}`;
		setDraft(next);
		requestAnimationFrame(() => {
			input?.focus();
			input?.setSelectionRange(start + token.length, start + token.length);
		});
	};

	return (
		<Modal open={open} onClose={onCancel} title={`Commit subject pattern — repository ${rank}`}>
			<div className="space-y-4">
				<p className="text-xs text-zinc-400">
					How SWARM words every commit it makes for a task in this repository — the implementation
					and every review or CI fix — and, once the repository has a pattern of its own, the title
					of the task's pull request. Combine literal text with these elements; write an element
					with a capital first letter, e.g. <span className="font-mono">{'{Subject}'}</span>, to
					capitalise it. The subject is decided once per task, with the same work type as its branch
					name. Without a pattern of its own the repository uses{' '}
					<span className="font-mono">{'{work_type}: {subject}'}</span> and titles pull requests by
					their card.
				</p>

				<ul className="space-y-2">
					{COMMIT_SUBJECT_PATTERN_ELEMENTS.map((name) => (
						<li key={name} className="flex items-start gap-3">
							<button
								type="button"
								onClick={() => insertElement(name)}
								aria-label={`Insert {${name}}`}
								className={`${buttonClass('secondary', 'xs')} font-mono shrink-0`}
							>
								{`{${name}}`}
							</button>
							<span className="text-xs text-zinc-400">
								{COMMIT_SUBJECT_PATTERN_ELEMENT_DESCRIPTIONS[name]}
							</span>
						</li>
					))}
				</ul>

				<div className="grid gap-4 sm:grid-cols-3">
					<div className="sm:col-span-2">
						<label htmlFor={inputId} className="block text-xs font-medium text-zinc-400 mb-1">
							Pattern
						</label>
						<input
							ref={inputRef}
							id={inputId}
							type="text"
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							spellCheck={false}
							autoComplete="off"
							placeholder="{issue_key} {Subject}"
							className={`${FIELD_CLASS} font-mono`}
						/>
					</div>
					<div>
						<label htmlFor={lengthId} className="block text-xs font-medium text-zinc-400 mb-1">
							Length Limit
						</label>
						<input
							id={lengthId}
							type="number"
							value={lengthDraft}
							onChange={(e) => setLengthDraft(e.target.value)}
							min={MIN_MAX_LENGTH}
							max={MAX_MAX_LENGTH}
							step={1}
							className={FIELD_CLASS}
						/>
					</div>
				</div>

				<div className="p-3 bg-zinc-900/50 border border-zinc-800 text-sm text-zinc-300 rounded">
					<span className="block text-xs text-zinc-500 mb-1">
						Preview for task {SAMPLE_COMMIT_SUBJECT_PARTS.issueKey} (
						{SAMPLE_COMMIT_SUBJECT_PARTS.workType})
						{preview !== null && ` — ${preview.length} characters`}
					</span>
					<span className="font-mono" data-testid="commit-subject-pattern-preview">
						{preview ?? '—'}
					</span>
				</div>

				{errors.length > 0 && (
					<ul className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded space-y-1">
						{errors.map((error) => (
							<li key={error}>{error}</li>
						))}
					</ul>
				)}
				{validation.warnings.length > 0 && (
					<ul className="p-4 bg-amber-950/20 border border-amber-900/30 rounded text-xs text-amber-200/70 space-y-1">
						{validation.warnings.map((warning) => (
							<li key={warning}>{warning}</li>
						))}
					</ul>
				)}
			</div>

			<ModalFooter
				primary={
					<button
						type="button"
						onClick={() => onApply(draft, limit)}
						disabled={errors.length > 0}
						className={buttonClass('primary')}
					>
						Apply
					</button>
				}
				secondary={
					<button type="button" onClick={onCancel} className={buttonClass('secondary')}>
						Cancel
					</button>
				}
			/>
		</Modal>
	);
}
