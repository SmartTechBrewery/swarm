import { useEffect, useId, useRef, useState } from 'react';
import { buttonClass } from '@/components/ui/button.js';
import {
	BRANCH_PATTERN_ELEMENT_DESCRIPTIONS,
	BRANCH_PATTERN_ELEMENTS,
	renderBranchName,
	SAMPLE_BRANCH_NAME_PARTS,
	validateBranchPattern,
} from '../../../../src/pipeline/branch-pattern.js';
import { Modal, ModalFooter } from '../ui/modal.js';

/** Input recipe shared with the rest of the tab (ai/DESIGN_SYSTEM.md §4). */
const FIELD_CLASS =
	'block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-800 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 transition-shadow';

interface BranchPatternDialogProps {
	open: boolean;
	/** The pattern the repository names its branches by now — its own, or its prefix's. */
	pattern: string;
	/**
	 * The pattern the repository's legacy prefix stands for (`<prefix>{issue_key}`) — the
	 * one shape `taskIdFromTaskBranch` keeps recognising whatever the pattern is.
	 */
	legacyPattern: string;
	/** The repository's rank in the list, so the dialog says which entry it edits. */
	rank: number;
	onApply: (pattern: string) => void;
	onCancel: () => void;
}

/**
 * The branch name pattern editor (issue #1241): describes every element, composes the
 * pattern, previews it for a sample task, and refuses to apply one the server would
 * refuse. The rules are `validateBranchPattern` (`src/pipeline/branch-pattern.ts`) —
 * the very function the config schema runs — so the two cannot disagree.
 *
 * Applying only edits the row: the pattern is persisted by the tab's own Save, like
 * every other repository setting.
 *
 * Only the legacy `<prefix>{issue_key}` shape stays recognised after a change, so
 * replacing any other pattern warns that pull requests open under it stop being
 * SWARM's own.
 */
export function BranchPatternDialog({
	open,
	pattern,
	legacyPattern,
	rank,
	onApply,
	onCancel,
}: BranchPatternDialogProps) {
	const [draft, setDraft] = useState(pattern);
	const inputRef = useRef<HTMLInputElement>(null);
	const inputId = useId();

	// Every opening starts from the repository's current pattern, not a cancelled draft.
	useEffect(() => {
		if (open) setDraft(pattern);
	}, [open, pattern]);

	const validation = validateBranchPattern(draft);
	const { errors } = validation;
	const strandsOpenBranches = draft !== pattern && pattern !== legacyPattern;
	const warnings = strandsOpenBranches
		? [
				...validation.warnings,
				`Pull requests already open on branches named by ${pattern} will no longer be recognised as SWARM's own — no Review, WIP release or merge automation. Only the legacy ${legacyPattern} shape stays recognised after a change.`,
			]
		: validation.warnings;
	const preview = errors.length === 0 ? renderBranchName(draft, SAMPLE_BRANCH_NAME_PARTS) : null;

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
		<Modal open={open} onClose={onCancel} title={`Branch name pattern — repository ${rank}`}>
			<div className="space-y-4">
				<p className="text-xs text-zinc-400">
					How SWARM names this repository's task branches. Combine literal text — letters, digits
					and the separators <span className="font-mono">/</span>,{' '}
					<span className="font-mono">-</span> and <span className="font-mono">_</span> — with these
					elements. The name is decided once per task and kept for every later phase. After a
					change, branches already open stay recognised only in the legacy{' '}
					<span className="font-mono">{legacyPattern}</span> shape.
				</p>

				<ul className="space-y-2">
					{BRANCH_PATTERN_ELEMENTS.map((name) => (
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
								{BRANCH_PATTERN_ELEMENT_DESCRIPTIONS[name]}
							</span>
						</li>
					))}
				</ul>

				<div>
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
						placeholder="{issue_key}/{friendly_name}"
						className={`${FIELD_CLASS} font-mono`}
					/>
				</div>

				<div className="p-3 bg-zinc-900/50 border border-zinc-800 text-sm text-zinc-300 rounded">
					<span className="block text-xs text-zinc-500 mb-1">
						Preview for task {SAMPLE_BRANCH_NAME_PARTS.issueKey} (
						{SAMPLE_BRANCH_NAME_PARTS.workType})
					</span>
					<span className="font-mono" data-testid="branch-pattern-preview">
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
				{warnings.length > 0 && (
					<ul className="p-4 bg-amber-950/20 border border-amber-900/30 rounded text-xs text-amber-200/70 space-y-1">
						{warnings.map((warning) => (
							<li key={warning}>{warning}</li>
						))}
					</ul>
				)}
			</div>

			<ModalFooter
				primary={
					<button
						type="button"
						onClick={() => onApply(draft)}
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
