import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronDown, ChevronRight, X } from 'lucide-react';
import { useState } from 'react';
import { formatRelativeTime } from '@/lib/format.js';
import { runTableColumnWidths } from '@/lib/run-table-layout.js';
import {
	STALLED_SECTION_EXPLANATION,
	stalledItemKey,
	stalledItemRun,
	stalledPhaseLabel,
} from '@/lib/stalled-items.js';
import { trpc, trpcClient } from '@/lib/trpc.js';
import type { StalledItem } from '@/types/runs.js';
import { WorkItemCell } from './work-item-cell.js';

/** When the unit last moved — relative, with the absolute instant on hover. */
function StoppedContent({ item }: { item: StalledItem }) {
	return (
		<span title={new Date(item.lastActivityAt).toLocaleString()}>
			{formatRelativeTime(item.lastActivityAt)}
		</span>
	);
}

/**
 * Which project and repository the unit belongs to — the cross-project screen
 * only. Both are machine identifiers, so both are `font-mono`.
 */
function ProjectContent({ item, projectName }: { item: StalledItem; projectName: string }) {
	return (
		<div className="flex min-w-0 flex-col gap-0.5">
			<span className="block break-all font-mono text-zinc-300">{projectName}</span>
			<span className="block break-all font-mono text-[11px] text-zinc-500">{item.repository}</span>
		</div>
	);
}

interface StalledItemsSectionProps {
	/**
	 * The server's own `runs.stalled` rows, already ordered longest-silent first.
	 * This component never re-sorts, re-groups, or re-classifies them.
	 */
	items: StalledItem[];
	/**
	 * Whether to render the Project column. `true` for the global `/runs` view;
	 * `false` for the project-scoped Runs tab, where every row is the same project
	 * — matching {@link RunsTable} and {@link QueuedRunsSection}'s `showProject`.
	 */
	showProject?: boolean;
}

/**
 * The **Stalled** section shown above the Queued section on both Runs surfaces
 * (issue #847): the work items the item-liveness read model found with no forward
 * path — no live run, no waiting dispatch, and no recorded hand-off explaining the
 * silence (`src/dispatch/item-liveness.ts`, issue #840).
 *
 * - **Hidden entirely when nothing is stalled** — returns `null`, so a healthy
 *   installation gets no permanent empty box and no layout shift.
 * - **A view, not an alert.** It reports on render only: no toast, no pulsing
 *   badge, no notification. An item stays listed until it actually moves, rather
 *   than re-announcing itself on a timer.
 * - Rows render in the exact order the server returns them (longest-silent
 *   first); nothing here re-sorts.
 * - Attention-toned rather than error-toned (`ai/DESIGN_SYSTEM.md`'s warning
 *   amber): a stall needs a look, which is not the same as something having
 *   crashed — and is what sets it apart from the neutral Queued section below.
 * - **One** per-row action: **Dismiss** (issue #880). Retrying, cancelling, or
 *   forcing a re-review stays the Runs table's job; a stalled row still links
 *   *out* to the pull request or board card for everything else. Dismiss exists
 *   because `stalled` is the deliberate default when no *recorded* hand-off
 *   explains a unit's silence, so a pull request a human merged is reported until
 *   it ages out of the 30-day lookback — and an operator can see at a glance that
 *   it is done. It writes a `stalled_dismissals` row keyed on the liveness unit
 *   (`runs.dismissStalled`), never a status on the unit, and a unit that genuinely
 *   moves again is reported normally.
 * - **A dismissal is auditable in the record, not in this view.** The durable row
 *   names the unit, the activity instant it was dismissed at, the wall-clock time
 *   and the user. Surfacing dismissed items here — a collapsed count, an undo —
 *   would be a feature with its own read and its own authorization question, and
 *   is deliberately not part of #880; recording who and when is what keeps it
 *   cheap to add later.
 */
export function StalledItemsSection({ items, showProject = true }: StalledItemsSectionProps) {
	// Expanded by default — the whole point is that it is noticed without being
	// looked for — but foldable, so a long list can be put away.
	const [expanded, setExpanded] = useState(true);
	// Resolve project display names the same way RunsTable and QueuedRunsSection do.
	// Hook order is stable across renders, so the early return below stays after
	// every hook.
	const projectsQuery = useQuery({
		...trpc.projects.list.queryOptions(),
		enabled: showProject,
	});
	const projectsMap = new Map(projectsQuery.data?.map((p) => [p.id, p]) ?? []);
	const columnWidths = runTableColumnWidths(showProject);

	// The row a dismissal is in flight for, so only *that* button disables. The
	// section can list a dozen rows, and greying out all of them would misreport
	// which one the operator acted on.
	const [dismissingKey, setDismissingKey] = useState<string | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const queryClient = useQueryClient();
	const dismissMutation = useMutation({
		mutationFn: (item: StalledItem) =>
			trpcClient.runs.dismissStalled.mutate({
				projectId: item.projectId,
				repository: item.repository,
				unit: item.unit,
				reference: item.reference,
				// Verbatim, so the server records the instant the operator actually saw.
				// A run that landed between render and click leaves the unit past this
				// instant, and the row is simply reported again — a stale client can only
				// ever under-suppress.
				lastActivityAt: item.lastActivityAt,
			}),
		onSuccess: () => {
			setErrorMessage(null);
			// No success toast: the row disappearing *is* the confirmation.
			queryClient.invalidateQueries({ queryKey: trpc.runs.stalled.queryKey() });
		},
		onError: (error: Error) => {
			setErrorMessage(error.message || 'Failed to dismiss the stalled item.');
		},
		onSettled: () => setDismissingKey(null),
	});

	const handleDismiss = (item: StalledItem) => {
		setDismissingKey(stalledItemKey(item));
		setErrorMessage(null);
		dismissMutation.mutate(item);
	};

	if (items.length === 0) return null;

	const projectNameFor = (item: StalledItem) =>
		projectsMap.get(item.projectId)?.name || item.projectId;

	return (
		<section
			data-testid="stalled-items-section"
			className="space-y-2 rounded-md border border-amber-900/30 bg-amber-950/20 p-3"
		>
			<h2>
				<button
					type="button"
					aria-expanded={expanded}
					onClick={() => setExpanded((current) => !current)}
					className="flex w-full items-center gap-1.5 text-left text-sm font-semibold tracking-tight text-amber-200/90 hover:text-amber-200"
				>
					{expanded ? (
						<ChevronDown className="h-3.5 w-3.5 shrink-0" />
					) : (
						<ChevronRight className="h-3.5 w-3.5 shrink-0" />
					)}
					<AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" aria-hidden="true" />
					Stalled <span className="font-normal text-amber-200/70">({items.length})</span>
				</button>
			</h2>
			<p className="text-xs text-amber-200/70">{STALLED_SECTION_EXPLANATION}</p>
			{/* The server's own message, verbatim; cleared on the next attempt. */}
			{errorMessage && <p className="text-xs text-red-400">{errorMessage}</p>}

			{expanded && (
				<>
					{/*
					 * Mobile (< md): one card per stalled item — no horizontal scroll
					 * (issue #381). Same content and same helpers as the table below, so the
					 * two presentations cannot drift.
					 */}
					<div className="space-y-3 md:hidden">
						{items.map((item) => (
							<div
								key={stalledItemKey(item)}
								data-testid="stalled-item-card"
								className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-panel/20 p-4 shadow-sm"
							>
								<WorkItemCell run={stalledItemRun(item)} variant="card" />
								<div className="flex flex-col gap-1 text-xs text-zinc-400">
									<span>
										Stopped in{' '}
										<span className="font-semibold text-zinc-200">
											{stalledPhaseLabel(item.phase)}
										</span>
									</span>
									<span>
										Last moved <StoppedContent item={item} />
									</span>
								</div>
								{showProject && (
									<div className="border-t border-zinc-800/60 pt-2 text-xs">
										<ProjectContent item={item} projectName={projectNameFor(item)} />
									</div>
								)}
								{/*
								 * The same action as the table's Dismiss column, in a separated
								 * action row: `ai/DESIGN_SYSTEM.md`'s responsive-list rule drops
								 * no field and no action below `md`.
								 */}
								<div className="flex flex-wrap items-center gap-2 border-t border-zinc-800/60 pt-2">
									<button
										type="button"
										onClick={() => handleDismiss(item)}
										disabled={dismissingKey === stalledItemKey(item)}
										className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-3 text-xs font-medium text-zinc-300 hover:bg-zinc-800 hover:text-white focus:outline-none focus:ring-1 focus:ring-violet-500 transition-colors disabled:opacity-55 disabled:cursor-not-allowed"
									>
										<X className="h-3.5 w-3.5" />
										Dismiss
									</button>
								</div>
							</div>
						))}
					</div>

					{/* Desktop (md+): the stalled table. */}
					<div className="hidden overflow-hidden rounded-md border border-zinc-800 bg-panel/20 shadow-sm md:block">
						<table className="w-full table-fixed border-collapse text-left">
							<colgroup>
								{/* The prose column takes the slack the sized columns leave. */}
								<col />
								<col className={columnWidths.phase} />
								<col className={columnWidths.started} />
								{showProject && <col className={columnWidths.project} />}
								{/* Matches QueuedRunsSection's action column, so the two cannot drift. */}
								<col className="w-[120px]" />
							</colgroup>
							<thead>
								<tr className="border-b border-zinc-800 bg-zinc-800/30">
									<th className="px-2 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
										Item
									</th>
									<th className="px-2 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
										Phase
									</th>
									<th className="px-2 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
										Stopped
									</th>
									{showProject && (
										<th className="px-2 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
											Project
										</th>
									)}
									<th className="px-2 py-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
										Dismiss
									</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-zinc-800/60">
								{items.map((item) => (
									<tr key={stalledItemKey(item)} data-testid="stalled-item-row">
										<td className="px-2 py-2 text-xs">
											<WorkItemCell run={stalledItemRun(item)} />
										</td>
										<td className="px-2 py-2 text-xs font-semibold text-zinc-100">
											{stalledPhaseLabel(item.phase)}
										</td>
										<td className="px-2 py-2 text-xs text-zinc-400">
											<StoppedContent item={item} />
										</td>
										{showProject && (
											<td className="px-2 py-2 text-xs">
												<ProjectContent item={item} projectName={projectNameFor(item)} />
											</td>
										)}
										<td className="px-2 py-2 text-xs">
											<button
												type="button"
												onClick={() => handleDismiss(item)}
												disabled={dismissingKey === stalledItemKey(item)}
												className="inline-flex items-center gap-1.5 px-2 py-1 text-[11px] font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded hover:bg-zinc-800 hover:text-white focus:outline-none focus:ring-1 focus:ring-violet-500 transition-colors disabled:opacity-55 disabled:cursor-not-allowed"
											>
												<X className="w-3.5 h-3.5" />
												Dismiss
											</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				</>
			)}
		</section>
	);
}
