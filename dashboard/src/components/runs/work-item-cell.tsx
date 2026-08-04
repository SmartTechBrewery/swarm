import { ExternalLink } from 'lucide-react';
import { parseWorkItemRef, workItemLabel } from '@/lib/work-item.js';

/**
 * How SWARM describes the work one run is doing: the resolved Issue/PR title over
 * its provider reference. Extracted from `RunsTable` (issue #473) so the Workers
 * screen's **Active job** column renders the identical description instead of a
 * run UUID — one component, so a change to how a job reads lands on both screens.
 */

/**
 * The run fields this cell needs. Deliberately narrower than `RunRow` so a
 * caller with only a summary of the run — the Workers screen's `currentRun`
 * (`WorkerActiveRun`) — can render the same cell.
 */
export interface WorkItemCellRun {
	taskId: string;
	phase: string;
	workItemId: string | null;
	workItemTitle: string | null;
	workItemUrl: string | null;
	prNumber: string | null;
	prTitle: string | null;
}

/** Phases whose subject is the pull request, so the PR title/number leads the cell. */
export const PR_DRIVEN_PHASES = new Set([
	'review',
	'respond-to-review',
	'respond-to-ci',
	'resolve-conflicts',
]);

/** The title line: prose naming the work, optionally linking to the run itself. */
function WorkItemTitle({
	title,
	isCard,
	titleHref,
}: {
	title: string | null;
	isCard: boolean;
	titleHref?: string;
}) {
	const titleClass = isCard
		? 'block w-full break-words text-sm font-medium text-zinc-100'
		: 'block w-full truncate text-zinc-200';
	if (titleHref) {
		// A run whose title hasn't resolved still needs a way in, so the link falls
		// back to naming itself rather than leaving the cell blank.
		return (
			<a
				href={titleHref}
				className={`${titleClass} hover:text-violet-300 hover:underline`}
				title={title ?? undefined}
			>
				{title ?? 'View run'}
			</a>
		);
	}
	if (!title) return null;
	return (
		<span className={titleClass} title={isCard ? undefined : title}>
			{title}
		</span>
	);
}

/**
 * The provider reference under the title — the PR for a PR-driven phase, else the
 * work item. Both open on the provider, so they stop propagation: the runs list
 * navigates on row click and must not swallow the outbound link.
 */
function WorkItemReference({
	run,
	repo,
	isPrDriven,
}: {
	run: WorkItemCellRun;
	repo: string;
	isPrDriven: boolean;
}) {
	const stopPropagation = (event: React.MouseEvent) => event.stopPropagation();
	const handleLinkKeyDown = (event: React.KeyboardEvent) => {
		event.stopPropagation();
	};
	const workItemRef = parseWorkItemRef(run.workItemUrl);

	if (isPrDriven && run.prNumber) {
		return (
			<a
				href={`https://github.com/${repo}/pull/${run.prNumber}`}
				target="_blank"
				rel="noopener noreferrer"
				onClick={stopPropagation}
				onKeyDown={handleLinkKeyDown}
				className="inline-flex self-start items-center gap-1 text-violet-400 hover:text-violet-300 font-mono hover:underline"
			>
				PR #{run.prNumber}
				<ExternalLink className="h-3 w-3" />
			</a>
		);
	}
	if (!run.workItemId) return null;
	if (workItemRef) {
		return (
			<a
				href={run.workItemUrl ?? undefined}
				target="_blank"
				rel="noopener noreferrer"
				onClick={stopPropagation}
				onKeyDown={handleLinkKeyDown}
				className="inline-flex self-start items-center gap-1 text-zinc-400 hover:text-zinc-300 font-mono hover:underline"
			>
				{workItemLabel(workItemRef)}
				<ExternalLink className="h-3 w-3" />
			</a>
		);
	}
	return <span className="text-zinc-400 font-mono">Issue: #{run.taskId}</span>;
}

export function WorkItemCell({
	run,
	repo,
	variant = 'cell',
	titleHref,
	phaseLabel,
}: {
	run: WorkItemCellRun;
	repo?: string;
	/**
	 * `'cell'` truncates the title to one line for the fixed-width desktop table;
	 * `'card'` lets it grow to the dominant, wrapping primary line of a mobile
	 * run card (issue #381) so nothing is clipped and no field forces horizontal
	 * scroll.
	 */
	variant?: 'cell' | 'card';
	/**
	 * Makes the title a link to the run — for a caller whose row isn't already
	 * clickable (the Workers table, issue #473). The runs list omits it: its whole
	 * row navigates to the run, and a nested link there would just swallow clicks.
	 */
	titleHref?: string;
	/**
	 * Names the phase on a leading line of its own, above the title — for a caller
	 * with no Phase column to put it in (the Workers table's Active job, issue
	 * #473). The runs list omits it: its Phase column already says this, in the
	 * same words.
	 */
	phaseLabel?: string;
}) {
	const isPrDriven = PR_DRIVEN_PHASES.has(run.phase);
	const title = isPrDriven ? run.prTitle : run.workItemTitle;
	// The reference line needs the repo to build a PR URL, and something to point
	// at; without both there is nothing to reference.
	const referenceRepo = repo && (run.workItemId || run.prNumber) ? repo : null;

	// Nothing to say at all — the runs list's long-standing behaviour, which drops
	// even a resolved title when the reference is unavailable.
	if (!referenceRepo && !titleHref && !phaseLabel) {
		return <span className="text-zinc-500 font-mono">—</span>;
	}

	return (
		<div className="flex w-full min-w-0 flex-col gap-1 text-xs">
			{phaseLabel ? (
				<span className="block w-full truncate font-semibold capitalize text-zinc-100">
					{phaseLabel}
				</span>
			) : null}
			<WorkItemTitle title={title} isCard={variant === 'card'} titleHref={titleHref} />
			{referenceRepo ? (
				<WorkItemReference run={run} repo={referenceRepo} isPrDriven={isPrDriven} />
			) : null}
		</div>
	);
}
