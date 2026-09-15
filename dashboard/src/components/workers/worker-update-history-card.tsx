import { RunStatusBadge } from '@/components/runs/run-status-badge.js';
import { formatDuration, formatRelativeTime } from '@/lib/format.js';
import type { WorkerUpdateHistoryEntry } from '@/types/workers.js';

/**
 * **Update history** (issue #977) — what this machine was asked to move to, when,
 * and how it ended, on the machine's own page rather than by filtering the global
 * runs list.
 *
 * A self-contained card body, the same shape as `worker-drain-card.tsx`: the section
 * wrapper and heading stay in `worker-detail.tsx`, so `WorkerDetailView` doesn't grow
 * another concern.
 *
 * **The rows are the history, and the only one.** Each is a `runs` row of
 * `kind = 'worker-update'` (issue #971), so a request is still readable after the
 * next one is made — unlike `swarm workers list`, which keeps only the machine's
 * latest outcome. Nothing from that latest outcome is repeated beside these rows: it
 * is already the newest of them, and stating it twice would be two sources for one
 * fact.
 *
 * **No badge for the kind.** The card's own title says what these are, so the
 * `MaintenanceRunBadge` the runs surfaces carry would only repeat it — there, it
 * distinguishes a maintenance row *from the pipeline rows beside it*, and here there
 * are none. The status badge is the shared {@link RunStatusBadge}, deliberately: an
 * update's outcome reads identically here, in the runs list and on the run's page,
 * and an in-flight request reads as its pulsing blue `Running` rather than an
 * "Updating" word invented for this one surface.
 *
 * **Read-only, as the whole screen's update surface is.** A failed request is
 * re-asked with `swarm workers update`, never retried from here — the run page
 * refuses the pipeline recovery actions for the same reason (`requirePipelineRun`).
 */

/** One entry's sub-panel — the stacked-list shape `ai/DESIGN_SYSTEM.md` §4 describes. */
const ENTRY_CLASS = 'border border-zinc-800 rounded-lg bg-panel/20 p-4 shadow-sm space-y-2';

/**
 * The run's status as the shared badge takes it. Cast at the boundary exactly as the
 * runs list does: the read model mirrors the column as plain text, and a
 * worker-update run only ever holds these three.
 */
function badgeStatus(status: string) {
	return status as 'running' | 'completed' | 'failed';
}

/**
 * When the machine was asked and, once it has settled, how long it took. Relative
 * time with the absolute instant on hover, the same treatment Last seen gets above.
 */
function EntryTiming({ entry }: { entry: WorkerUpdateHistoryEntry }) {
	return (
		<p className="text-xs text-zinc-400">
			<span title={new Date(entry.startedAt).toLocaleString()}>
				Asked {formatRelativeTime(entry.startedAt)}
			</span>
			{entry.completedAt ? (
				<span title={new Date(entry.completedAt).toLocaleString()}>
					{' · took '}
					{formatDuration(entry.durationMs)}
				</span>
			) : null}
		</p>
	);
}

function UpdateHistoryEntry({ entry }: { entry: WorkerUpdateHistoryEntry }) {
	return (
		<li className={ENTRY_CLASS}>
			<div className="flex flex-wrap items-center gap-2">
				{/* A plain anchor, like the Active job card's link above: this card is not
				    inside a clickable row, so there is nothing to stop propagating. */}
				<a
					href={`/runs/${entry.runId}`}
					className="font-mono text-sm font-medium text-zinc-100 break-all hover:text-violet-300 hover:underline"
				>
					{entry.target ?? 'View run'}
				</a>
				<RunStatusBadge status={badgeStatus(entry.status)} />
			</div>
			<EntryTiming entry={entry} />
			{/* The machine's own words, for a failure — the same prose the run page shows,
			    kept verbatim because it names the install root and the step that failed. */}
			{entry.status === 'failed' && entry.error ? (
				<p className="whitespace-pre-wrap font-mono text-xs text-red-300 break-words">
					{entry.error}
				</p>
			) : null}
		</li>
	);
}

export function WorkerUpdateHistoryCard({ entries }: { entries: WorkerUpdateHistoryEntry[] }) {
	return (
		<div className="space-y-4">
			{entries.length === 0 ? (
				<p className="text-sm text-zinc-400">This machine has never been asked to update.</p>
			) : (
				<ol className="space-y-3">
					{entries.map((entry) => (
						<UpdateHistoryEntry key={entry.runId} entry={entry} />
					))}
				</ol>
			)}
			<p className="text-xs text-zinc-500">
				Every request this machine was sent, newest first — the durable record, where{' '}
				<span className="font-mono">swarm workers list</span> shows only the latest outcome. A
				request that <em>failed</em> is re-asked with{' '}
				<span className="font-mono">swarm workers update</span> once whatever the machine's own
				reason names is addressed; nothing here retries one. A machine that never answers is settled
				as failed after six hours, and is corrected if it answers later. Open a request to read it
				in full.
			</p>
		</div>
	);
}
