import { Badge } from '@/components/ui/badge.js';
import { formatRelativeTime, formatTimeUntil } from '@/lib/format.js';
import type { WorkerRateLimit } from '@/types/workers.js';

/**
 * **Usage limits** (issue #988, the dashboard half of issue #981's cool-down
 * record) — which of this machine's CLIs are waiting on a spent allowance, and when
 * each is expected back.
 *
 * It sits beside {@link WorkerDrainCard} because the two are the opposite ends of
 * one question — "why is this machine not taking work?" — and answering it needs
 * both. A drain is **operator-declared**: machine-wide, sticky, and cleared only by
 * the human who set it. A cool-down is **observed**: the machine's own CLI said its
 * allowance was spent on a real run, it is per CLI, and it clears itself at the
 * instant recorded. Mistaking one for the other sends an operator looking for a
 * switch that does not exist.
 *
 * **The copy must never read as a fault or as an action item.** There is no control
 * here and no control anywhere else either: nothing an operator does to this machine
 * shortens a usage window, and the work waiting on it starts by itself when the
 * allowance returns. So this reports and does not advise — no "check", no "fix", no
 * button.
 *
 * **Per CLI, never collapsed to a machine-wide state.** A machine cooling on
 * `claude` keeps taking `codex` work, which is the single most misreadable thing
 * about this state, so each entry names its own CLI and the paragraph below says
 * outright that the others are unaffected. `null` is not a case: a machine cooling
 * on nothing renders nothing at all, because the record releases itself and "was
 * rate-limited an hour ago" is not a fact this screen keeps.
 */

const COOLDOWN_PANEL_CLASS =
	'p-3 bg-zinc-900/50 border border-zinc-800 text-sm text-zinc-300 rounded';

interface WorkerRateLimitCardProps {
	/** The machine's live cool-downs, ordered by CLI; `[]` renders nothing. */
	rateLimits: WorkerRateLimit[];
}

export function WorkerRateLimitCard({ rateLimits }: WorkerRateLimitCardProps) {
	if (rateLimits.length === 0) return null;
	return (
		<div className="space-y-4">
			<ul className="space-y-2">
				{rateLimits.map((limit) => (
					<li key={limit.cli} className={COOLDOWN_PANEL_CLASS}>
						<div className="flex items-center gap-2 flex-wrap">
							<Badge>{limit.cli}</Badge>
							<span className="font-semibold" title={new Date(limit.expiresAt).toLocaleString()}>
								Expected back {formatTimeUntil(limit.expiresAt)}
							</span>
						</div>
						{/* The machine's own words, when its CLI gave any — shown verbatim beside
						    the derived instant above rather than instead of it, so a reset text
						    SWARM read differently than the operator does is visible rather than
						    silently authoritative. */}
						{limit.resetHint ? (
							<p className="text-xs text-zinc-400 mt-1.5">
								Reported by the CLI: <span className="font-mono">{limit.resetHint}</span>
							</p>
						) : null}
						<p className="text-xs text-zinc-500 mt-1.5">
							Observed{' '}
							<span title={new Date(limit.observedAt).toLocaleString()}>
								{formatRelativeTime(limit.observedAt)}
							</span>
						</p>
					</li>
				))}
			</ul>
			<p className="text-sm text-zinc-400 leading-relaxed">
				{rateLimits.length === 1 ? 'This CLI' : 'These CLIs'} reported a spent usage allowance on a
				real run, so SWARM is routing no further work here on{' '}
				{rateLimits.length === 1 ? 'it' : 'them'} until the allowance returns. Every other CLI this
				machine declares is unaffected and keeps taking work. Nothing needs doing and nothing can be
				cleared by hand — the wait ends by itself, and work held back for it starts then.
			</p>
		</div>
	);
}
