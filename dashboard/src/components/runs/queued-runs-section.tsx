import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ExternalLink, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { formatRelativeTime, formatTimeUntil } from '@/lib/format.js';
import type { QueuedDisplayRow } from '@/lib/queued-runs.js';
import {
	groupQueuedRuns,
	hideBoardRowsWithActiveRun,
	NO_TRIGGER_GROUP_EXPLANATION,
	noTriggerGroupLabel,
	queuedPhaseLabel,
	queuedRunKey,
	queuedWaitReasonLabel,
	queuedWorkItemLabel,
	queuedWorkItemTitle,
	queuedWorkItemUrl,
	REVIEW_GATE_GROUP_LABEL,
	reviewGateSourceEventLabel,
} from '@/lib/queued-runs.js';
import { runTableColumnWidths } from '@/lib/run-table-layout.js';
import { runsListRefetchInterval } from '@/lib/runs-refresh.js';
import { trpc, trpcClient } from '@/lib/trpc.js';
import type { QueuedRun, RunRow } from '@/types/runs.js';
import { Modal, ModalFooter } from '../ui/modal.js';
import { RunStatusBadge } from './run-status-badge.js';

/**
 * Phase content for one queued row, shared by the desktop table cell and the
 * mobile card so their wording, review-gate diagnostics, and board-duplicate
 * count (issue #366) stay identical. A review-gate group lists its folded
 * source events; a board-duplicate group shows the phase plus how many queued
 * events for the card were collapsed into this one row; every other row is just
 * its phase label.
 */
function QueuedPhaseContent({ row }: { row: QueuedDisplayRow }) {
	const item = row.representative;
	if (row.isReviewGateGroup) {
		return (
			<div className="flex flex-col gap-1">
				<span className="font-semibold text-zinc-100">{REVIEW_GATE_GROUP_LABEL}</span>
				<span className="text-[11px] font-normal text-zinc-400">
					{row.sourceEvents.length} source events
				</span>
				<ul className="space-y-0.5 font-mono text-[11px] font-normal text-zinc-500">
					{row.sourceEvents.map((event) => (
						<li key={event.jobId}>{reviewGateSourceEventLabel(event)}</li>
					))}
				</ul>
			</div>
		);
	}
	const phaseLabel = (
		<span className="font-semibold text-zinc-100">{queuedPhaseLabel(item.phaseHint)}</span>
	);
	if (row.boardDuplicateCount > 0) {
		return (
			<div className="flex flex-col gap-1">
				{phaseLabel}
				<span className="text-[11px] font-normal text-zinc-400">
					{row.boardDuplicateCount + 1} queued events for this card
				</span>
			</div>
		);
	}
	return phaseLabel;
}

/** Task reference for one queued row, shared by the table cell and the card. */
function QueuedWorkItemContent({
	item,
	variant = 'cell',
}: {
	item: QueuedRun;
	variant?: 'cell' | 'card';
}) {
	const title = queuedWorkItemTitle(item);
	const url = queuedWorkItemUrl(item);
	const isCard = variant === 'card';
	return (
		<div className="flex w-full min-w-0 flex-col gap-1">
			{title &&
				(isCard ? (
					<span className="block w-full break-words text-sm font-medium text-zinc-100">
						{title}
					</span>
				) : (
					<span className="block w-full truncate text-zinc-200" title={title}>
						{title}
					</span>
				))}
			{url ? (
				<a
					href={url}
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex self-start items-center gap-1 text-zinc-400 hover:text-zinc-300 font-mono text-xs hover:underline"
				>
					{queuedWorkItemLabel(item)}
					<ExternalLink className="h-3 w-3" />
				</a>
			) : (
				<span className="font-mono text-xs text-zinc-400">{queuedWorkItemLabel(item)}</span>
			)}
		</div>
	);
}

/**
 * A compact badge marking a capacity-`blocked` row as a prioritized SCM
 * continuation (Review / Respond-to-review / Respond-to-CI / Resolve-conflicts
 * resumed after a capacity wait). Rendered only for `state === 'blocked' &&
 * continuation`, alongside the Queued status, so an operator can see why such a
 * row will win a freed project slot ahead of ordinary new work (issue #374).
 */
function ContinuationBadge({ item }: { item: QueuedRun }) {
	if (item.state !== 'blocked' || !item.continuation || !item.prioritizeContinuations) return null;
	return (
		<span
			title="Prioritized continuation — takes the next freed project slot ahead of new work."
			className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-semibold border bg-violet-500/10 text-violet-400 border-violet-500/20 shrink-0"
		>
			Continuation
		</span>
	);
}

/** Enqueued / delayed / wait-reason text for one queued row, shared by both presentations. */
function QueuedEnqueuedContent({ item }: { item: QueuedRun }) {
	return (
		<>
			{formatRelativeTime(item.enqueuedAt)}
			{item.state === 'delayed' && item.runsAt && (
				<span className="text-zinc-500"> · runs {formatTimeUntil(item.runsAt)}</span>
			)}
			{item.waitReason && (
				<span className="text-zinc-500"> · {queuedWaitReasonLabel(item.waitReason)}</span>
			)}
		</>
	);
}

/**
 * The board dispatches the server proved cannot start a phase (issue #570),
 * rendered as one collapsed, counted line below the queue instead of as pending
 * rows inside it. The server has already kept them out of `items`, so this
 * component never has to recognize them — it only makes sure they stay
 * *observable*: a count on the collapsed line, and each row's card and enqueue
 * time when expanded, so an accumulation (one survived a router restart and was
 * re-imported by the dispatch reconciler) can't hide.
 *
 * No Put back / View run action: nothing here is pending work to intervene in,
 * and the board card these rows name is not necessarily the one an operator would
 * be putting back.
 */
function NoTriggerGroup({ items }: { items: QueuedRun[] }) {
	const [expanded, setExpanded] = useState(false);
	if (items.length === 0) return null;

	return (
		<div
			data-testid="queued-no-trigger-group"
			className="rounded-md border border-zinc-800 bg-panel/10 px-3 py-2"
		>
			<button
				type="button"
				aria-expanded={expanded}
				onClick={() => setExpanded((current) => !current)}
				className="flex w-full items-center gap-1.5 text-left text-xs font-medium text-zinc-400 hover:text-zinc-300"
			>
				{expanded ? (
					<ChevronDown className="h-3.5 w-3.5 shrink-0" />
				) : (
					<ChevronRight className="h-3.5 w-3.5 shrink-0" />
				)}
				{noTriggerGroupLabel(items.length)}
			</button>
			{expanded && (
				<div className="mt-2 space-y-2 border-t border-zinc-800/60 pt-2">
					<p className="text-[11px] text-zinc-500">{NO_TRIGGER_GROUP_EXPLANATION}</p>
					<ul className="space-y-1.5">
						{items.map((item) => (
							<li
								key={queuedRunKey(item)}
								data-testid="queued-no-trigger-row"
								className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs text-zinc-500"
							>
								{queuedWorkItemTitle(item) && (
									<span className="min-w-0 break-words text-zinc-400">
										{queuedWorkItemTitle(item)}
									</span>
								)}
								<span className="font-mono">{queuedWorkItemLabel(item)}</span>
								<span>
									<QueuedEnqueuedContent item={item} />
								</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

interface QueuedRunsSectionProps {
	items: QueuedRun[];
	/**
	 * The board dispatches `runs.queued` reported as proven no-trigger (issue
	 * #570) — server-partitioned, never mixed into `items`. Rendered as one
	 * collapsed line by {@link NoTriggerGroup}; omitted by callers that don't read
	 * that half of the response.
	 */
	noTriggerItems?: QueuedRun[];
	/**
	 * Whether to render the Project column. `true` for the global `/runs` view;
	 * `false` for the project-scoped Runs tab, where every row is the same project
	 * — matching {@link RunsTable}'s `showProject`.
	 */
	showProject?: boolean;
	/**
	 * The project scope for the in-progress-run lookup (issue #421), matching the
	 * scope of `items`. Left undefined by the global `/runs` view, where the lookup
	 * runs unscoped — a work-item URL is globally unique, so an unscoped match can
	 * only be the same card.
	 */
	projectId?: string;
}

/**
 * A compact, distinct **Queued** section shown above the Runs table (issue #238):
 * work already enqueued in BullMQ but not yet picked up by the worker, so users
 * see pending work even when nothing is currently running.
 *
 * - Hidden entirely when there is nothing queued — returns `null` so there's no
 *   empty box and no layout shift for the table below.
 * - Rows render in the exact order the server returns them (dispatch priority +
 *   FIFO); this component never re-sorts — it only folds pending review-gate
 *   jobs sharing the same project/repo/PR/head SHA into one logical row via
 *   {@link groupQueuedRuns} (issue #275), so a duplicate raw lifecycle event
 *   (e.g. a Respond-to-review follow-up alongside a pull-request update) doesn't read as two queued Review agents.
 * - A row linked to an existing deferred attempt exposes its run detail page;
 *   fresh queued work has no run yet and therefore no detail action.
 */
export function QueuedRunsSection({
	items,
	noTriggerItems = [],
	showProject = true,
	projectId,
}: QueuedRunsSectionProps) {
	// Resolve project display names the same way RunsTable does. Hook order is
	// stable across renders, so the early return below stays after all hooks.
	const projectsQuery = useQuery(trpc.projects.list.queryOptions());
	const projectsMap = new Map(projectsQuery.data?.map((p) => [p.id, p]) ?? []);
	const columnWidths = runTableColumnWidths(showProject);

	// Dedicated running-run lookup (issue #421): a claimed board dispatch has left
	// the waiting set and become a run in the Runs table, but its leftover sibling
	// dispatches linger here as `pending`. Scoped only by project — deliberately
	// independent of the Runs table's own status/phase filters and pagination — so
	// the dedup holds even when that table is filtered away from `running`.
	const runningRunsQuery = useQuery({
		...trpc.runs.list.queryOptions({ projectId, status: 'running', limit: 200, offset: 0 }),
		refetchInterval: (query) => runsListRefetchInterval(query.state.data),
	});
	const activeBoardRunUrls = new Set<string>();
	for (const run of (runningRunsQuery.data?.data ?? []) as RunRow[]) {
		if ((run.phase === 'planning' || run.phase === 'implementation') && run.workItemUrl) {
			activeBoardRunUrls.add(run.workItemUrl);
		}
	}

	const rows = hideBoardRowsWithActiveRun(groupQueuedRuns(items), activeBoardRunUrls);

	const [confirmOpen, setConfirmOpen] = useState(false);
	const [selectedItem, setSelectedItem] = useState<QueuedRun | null>(null);
	const [successMessage, setSuccessMessage] = useState<string | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);

	const queryClient = useQueryClient();
	const putBackMutation = useMutation({
		mutationFn: (item: QueuedRun) =>
			trpcClient.runs.putBack.mutate({ jobId: item.jobId, projectId: item.projectId }),
		onSuccess: () => {
			setConfirmOpen(false);
			setSelectedItem(null);
			setSuccessMessage('Successfully returned the work item to Backlog.');
			setErrorMessage(null);
			queryClient.invalidateQueries({ queryKey: trpc.runs.queued.queryKey() });
			setTimeout(() => setSuccessMessage(null), 5000);
		},
		onError: (err) => {
			setErrorMessage(err.message || 'An error occurred while putting back the item.');
		},
	});

	// Collapse the section when nothing remains to show — either no queued items at
	// all, or every queued item was a fresh board row hidden as a duplicate of an
	// in-progress run (issue #421). Computed from `rows` (post-hide) so the header
	// count and the section presence stay consistent. Proven no-trigger dispatches
	// keep the section alive on their own (issue #570) — they are not queued work, so
	// they get no heading, count or table, but an accumulation of them must not become
	// invisible either.
	if (rows.length === 0) {
		if (noTriggerItems.length === 0) return null;
		return (
			<section data-testid="queued-runs-section" className="space-y-2">
				<NoTriggerGroup items={noTriggerItems} />
			</section>
		);
	}

	const handleOpenConfirm = (item: QueuedRun) => {
		setSelectedItem(item);
		setErrorMessage(null);
		setConfirmOpen(true);
	};

	const handleCloseConfirm = () => {
		if (putBackMutation.isPending) return;
		setConfirmOpen(false);
		setSelectedItem(null);
		setErrorMessage(null);
	};

	return (
		<section data-testid="queued-runs-section" className="space-y-2">
			<h2 className="text-sm font-semibold tracking-tight text-zinc-300">
				Queued <span className="text-zinc-500">({rows.length})</span>
			</h2>
			{successMessage && (
				<div className="p-3 bg-emerald-950/40 border border-emerald-800 rounded text-xs text-emerald-200">
					{successMessage}
				</div>
			)}
			{/*
			 * Mobile (< md): one card per grouped queued row — no horizontal scroll
			 * (issue #381). Task + Queued badge are the primary line, phase (with
			 * review-gate diagnostics) and Enqueued details are lighter metadata, and
			 * the View-run / Put-back actions sit in a clearly separated action row
			 * with generous tap targets.
			 */}
			<div className="space-y-3 md:hidden">
				{rows.map((row) => {
					const item = row.representative;
					const isSupportedPhase = item.phaseHint === 'board' || item.phaseHint === 'review';
					const hasLinkedCard = !!item.workItemNodeId;
					const showPutBack = isSupportedPhase && hasLinkedCard;

					return (
						<div
							key={queuedRunKey(item)}
							data-testid="queued-run-card"
							className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-panel/20 p-4 shadow-sm"
						>
							<div className="flex items-start justify-between gap-3">
								<div className="min-w-0 flex-1">
									<QueuedWorkItemContent item={item} variant="card" />
								</div>
								<div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
									<ContinuationBadge item={item} />
									<RunStatusBadge status="queued" />
								</div>
							</div>
							<div className="flex flex-col gap-1 text-xs text-zinc-400">
								<QueuedPhaseContent row={row} />
								<span>
									<QueuedEnqueuedContent item={item} />
								</span>
								{showProject && (
									<span className="min-w-0 break-all text-zinc-500">
										Project:{' '}
										<span className="font-mono text-zinc-300">
											{projectsMap.get(item.projectId)?.name || item.projectId}
										</span>
									</span>
								)}
							</div>
							{(item.runId || showPutBack) && (
								<div className="flex flex-wrap items-center gap-2 border-t border-zinc-800/60 pt-3">
									{item.runId && (
										<a
											href={`/runs/${item.runId}`}
											className="inline-flex min-h-[40px] items-center gap-1 rounded-md border border-zinc-800 bg-zinc-900 px-3 text-xs font-medium text-violet-300 hover:bg-zinc-800 hover:text-violet-200"
										>
											View run
										</a>
									)}
									{showPutBack && (
										<button
											type="button"
											onClick={() => handleOpenConfirm(item)}
											className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-3 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white focus:outline-none focus:ring-1 focus:ring-violet-500 transition-colors disabled:opacity-55 disabled:cursor-not-allowed"
										>
											<RotateCcw className="w-3.5 h-3.5" />
											Put back
										</button>
									)}
								</div>
							)}
						</div>
					);
				})}
			</div>

			{/* Desktop (md+): the unchanged queued table. */}
			<div className="hidden border border-zinc-800 rounded-md overflow-hidden bg-panel/20 shadow-sm md:block">
				<table className="w-full table-fixed text-left border-collapse">
					<colgroup>
						<col className={columnWidths.phase} />
						{showProject && <col className={columnWidths.project} />}
						<col className={columnWidths.task} />
						<col className={columnWidths.status} />
						<col />
						<col className="w-[120px]" />
					</colgroup>
					<thead>
						<tr className="bg-zinc-800/30 border-b border-zinc-800">
							<th className="px-2 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
								Phase
							</th>
							{showProject && (
								<th className="px-2 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
									Project
								</th>
							)}
							<th className="px-2 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
								Task
							</th>
							<th className="px-2 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
								Status
							</th>
							<th className="px-2 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
								Enqueued
							</th>
							<th className="px-2 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
								Actions
							</th>
						</tr>
					</thead>
					<tbody className="divide-y divide-zinc-800/60">
						{rows.map((row) => {
							const item = row.representative;
							const isSupportedPhase = item.phaseHint === 'board' || item.phaseHint === 'review';
							const hasLinkedCard = !!item.workItemNodeId;
							const showPutBack = isSupportedPhase && hasLinkedCard;

							return (
								<tr key={queuedRunKey(item)}>
									<td className="px-2 py-2 text-xs">
										<QueuedPhaseContent row={row} />
									</td>
									{showProject && (
										<td className="px-2 py-2 text-xs text-zinc-300 font-mono">
											{projectsMap.get(item.projectId)?.name || item.projectId}
										</td>
									)}
									<td className="px-2 py-2 text-xs">
										<QueuedWorkItemContent item={item} />
									</td>
									<td className="px-2 py-2 text-xs">
										<div className="flex flex-wrap items-center gap-1.5">
											<RunStatusBadge status="queued" />
											<ContinuationBadge item={item} />
										</div>
									</td>
									<td className="px-2 py-2 text-xs text-zinc-400">
										<QueuedEnqueuedContent item={item} />
									</td>
									<td className="px-2 py-2 text-xs">
										<div className="flex flex-wrap items-center gap-2">
											{item.runId && (
												<a
													href={`/runs/${item.runId}`}
													className="inline-flex items-center gap-1 text-[11px] font-medium text-violet-300 hover:text-violet-200 hover:underline"
												>
													View run
												</a>
											)}
											{showPutBack && (
												<button
													type="button"
													onClick={() => handleOpenConfirm(item)}
													className="inline-flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded hover:bg-zinc-800 hover:text-white focus:outline-none focus:ring-1 focus:ring-violet-500 transition-colors disabled:opacity-55 disabled:cursor-not-allowed"
												>
													<RotateCcw className="w-3 h-3" />
													Put back
												</button>
											)}
										</div>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>

			{/*
			 * Board dispatches the server proved cannot start a phase (issue #570) —
			 * below the queue, collapsed, and never counted as queued work.
			 */}
			<NoTriggerGroup items={noTriggerItems} />

			<Modal open={confirmOpen} onClose={handleCloseConfirm} title="Put Back Work Item">
				<div className="space-y-4">
					{errorMessage && (
						<div className="p-3 bg-red-950/40 border border-red-800 rounded text-xs text-red-200">
							{errorMessage}
						</div>
					)}
					<p className="text-xs text-zinc-400">
						Are you sure you want to put this queued work item back? This will cancel the pending
						queue job and return the associated board card to Backlog.
					</p>
					{selectedItem && (
						<div className="p-3 bg-zinc-900/60 border border-zinc-800 rounded text-xs space-y-1">
							<div className="font-semibold text-zinc-200">
								{queuedWorkItemTitle(selectedItem) || 'Work Item'}
							</div>
							<div className="font-mono text-zinc-500">{queuedWorkItemLabel(selectedItem)}</div>
						</div>
					)}
					<ModalFooter
						primary={
							<button
								type="button"
								disabled={putBackMutation.isPending}
								onClick={() => selectedItem && putBackMutation.mutate(selectedItem)}
								className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold text-white bg-violet-600 rounded-md hover:bg-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors disabled:opacity-55"
							>
								{putBackMutation.isPending ? 'Putting back...' : 'Confirm'}
							</button>
						}
						secondary={
							<button
								type="button"
								disabled={putBackMutation.isPending}
								onClick={handleCloseConfirm}
								className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-350 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-white transition-colors"
							>
								Cancel
							</button>
						}
					/>
				</div>
			</Modal>
		</section>
	);
}
