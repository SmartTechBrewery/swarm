import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, ExternalLink, Gauge } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge.js';
import { formatRelativeTime } from '@/lib/format.js';
import { trpc } from '@/lib/trpc.js';
import {
	WIP_SECTION_EXPLANATION,
	WIP_SECTION_TITLE,
	wipInFlightLabel,
	wipOperatorReasonLabel,
	wipPipelineReasonLabel,
	wipTicketActivityLabel,
	wipTicketRun,
	wipUsageKey,
} from '@/lib/wip-usage.js';
import type { WipTicket, WipUsageEntry } from '@/types/runs.js';
import { WorkItemCell } from './work-item-cell.js';

/** The holder's pull request, linked through the server-resolved URL when there is one. */
function PullRequestReference({ ticket }: { ticket: WipTicket }) {
	if (!ticket.prNumber) return null;
	if (!ticket.prUrl) {
		return <span className="font-mono text-zinc-400">PR #{ticket.prNumber}</span>;
	}
	return (
		<a
			href={ticket.prUrl}
			target="_blank"
			rel="noopener noreferrer"
			className="inline-flex items-center gap-1 font-mono text-violet-400 hover:text-violet-300 hover:underline"
		>
			PR #{ticket.prNumber}
			<ExternalLink className="h-3 w-3" />
		</a>
	);
}

/** One slot holder: what it is, since when it holds the slot, and what it is doing. */
function WipTicketRow({ ticket, repository }: { ticket: WipTicket; repository: string }) {
	const waitingOnOperator = ticket.state === 'waiting-on-operator';
	return (
		<li
			data-testid="wip-ticket"
			className="flex flex-col gap-2 px-3 py-2 md:flex-row md:items-start md:justify-between"
		>
			<div className="min-w-0 md:flex-1">
				<WorkItemCell run={wipTicketRun(ticket, repository)} variant="card" />
			</div>
			<div className="flex flex-col gap-1 text-xs text-zinc-400 md:w-[45%] md:items-end md:text-right">
				<div className="flex flex-wrap items-center gap-2 md:justify-end">
					{waitingOnOperator && <Badge tone="caution">Waiting on you</Badge>}
					<span className="font-semibold text-zinc-200">{wipTicketActivityLabel(ticket)}</span>
				</div>
				{waitingOnOperator && ticket.operatorReason && (
					<span className="text-amber-200/80">{wipOperatorReasonLabel(ticket.operatorReason)}</span>
				)}
				{ticket.state === 'waiting-on-pipeline' && ticket.pipelineReason && (
					<span className="text-zinc-400">{wipPipelineReasonLabel(ticket.pipelineReason)}</span>
				)}
				<div className="flex flex-wrap items-center gap-2 md:justify-end">
					<PullRequestReference ticket={ticket} />
					<span title={new Date(ticket.openedAt).toLocaleString()}>
						in flight since {formatRelativeTime(ticket.openedAt)}
					</span>
				</div>
			</div>
		</li>
	);
}

interface WipUsageSectionProps {
	/** The server's own `runs.wip` entries, already ordered; never re-sorted here. */
	entries: WipUsageEntry[];
	/**
	 * Whether to name each repository's project — `true` for the cross-project
	 * `/runs` view, matching {@link StalledItemsSection}'s `showProject`.
	 */
	showProject?: boolean;
}

/**
 * The **Tickets in progress** section on the Runs screen (issue #1192, renamed from
 * "WIP" by #1204): each repository's WIP limit in use (issue #1185) — `x / y in
 * flight`, how many new tickets wait for a slot, and every ticket holding one with
 * what it is doing. A holder the pipeline cannot move on its own carries a **Waiting
 * on you** badge and the reason, so a full limit reads as "these need you" rather
 * than as a hung SWARM.
 *
 * - **Hidden entirely when no repository holds a slot or a waiter** — like the
 *   Stalled section, no permanent empty box.
 * - **Laid out like {@link QueuedRunsSection}**: a plain heading with a muted count
 *   sits on the page, and only the per-repository listings are cards — no panel
 *   around them, so no card nests in a card.
 * - **A view, not a control.** The limit is edited in the repository editor and a
 *   slot frees when its ticket is merged, closed or put back; nothing here acts.
 * - Neutral-toned: a full limit is the limit working. Only the per-holder badge is
 *   attention-toned, because that is the one thing that needs a person.
 */
export function WipUsageSection({ entries, showProject = true }: WipUsageSectionProps) {
	const [expanded, setExpanded] = useState(true);
	const projectsQuery = useQuery({
		...trpc.projects.list.queryOptions(),
		enabled: showProject,
	});
	const projectsMap = new Map(projectsQuery.data?.map((p) => [p.id, p]) ?? []);

	if (entries.length === 0) return null;

	// Every ticket holding a slot across the listed repositories — the rows below.
	const ticketCount = entries.reduce((count, entry) => count + entry.tickets.length, 0);
	const waitingOnYou = entries.reduce(
		(count, entry) =>
			count + entry.tickets.filter((ticket) => ticket.state === 'waiting-on-operator').length,
		0,
	);

	return (
		<section data-testid="wip-usage-section" className="space-y-2">
			<h2>
				<button
					type="button"
					aria-expanded={expanded}
					onClick={() => setExpanded((current) => !current)}
					className="flex w-full items-center gap-1.5 text-left text-sm font-semibold tracking-tight text-zinc-300 hover:text-zinc-200"
				>
					{expanded ? (
						<ChevronDown className="h-3.5 w-3.5 shrink-0" />
					) : (
						<ChevronRight className="h-3.5 w-3.5 shrink-0" />
					)}
					<Gauge className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />
					{WIP_SECTION_TITLE} <span className="text-zinc-500">({ticketCount})</span>
					{waitingOnYou > 0 && (
						<span className="font-normal text-amber-200/80">({waitingOnYou} waiting on you)</span>
					)}
				</button>
			</h2>
			<p className="text-xs text-zinc-400">{WIP_SECTION_EXPLANATION}</p>

			{expanded && (
				<div className="space-y-3">
					{entries.map((entry) => (
						<div
							key={wipUsageKey(entry)}
							data-testid="wip-repository"
							className="overflow-hidden rounded-md border border-zinc-800 bg-panel/20 shadow-sm"
						>
							<div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 bg-zinc-800/30 px-3 py-2">
								<div className="flex min-w-0 flex-col gap-0.5">
									{showProject && (
										<span className="break-all font-mono text-xs text-zinc-300">
											{projectsMap.get(entry.projectId)?.name || entry.projectId}
										</span>
									)}
									<span className="break-all font-mono text-xs text-zinc-400">
										{entry.repository}
									</span>
								</div>
								<div className="flex items-center gap-2 text-xs">
									<span className="font-semibold text-zinc-100">{wipInFlightLabel(entry)}</span>
									{entry.waiting > 0 && <Badge>{entry.waiting} waiting</Badge>}
								</div>
							</div>
							{entry.tickets.length > 0 ? (
								<ul className="divide-y divide-zinc-800/60">
									{entry.tickets.map((ticket) => (
										<WipTicketRow
											key={ticket.taskId}
											ticket={ticket}
											repository={entry.repository}
										/>
									))}
								</ul>
							) : (
								<p className="px-3 py-2 text-xs text-zinc-500">
									No ticket holds a slot; the waiting tickets start as soon as a worker takes them.
								</p>
							)}
						</div>
					))}
				</div>
			)}
		</section>
	);
}
