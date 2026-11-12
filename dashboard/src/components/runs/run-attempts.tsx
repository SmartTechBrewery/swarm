import { RotateCcw } from 'lucide-react';
import { Badge, type BadgeTone } from '@/components/ui/badge.js';

/**
 * One execution attempt of a run, as `runs.getAttempts` reports it (issue #1400).
 * Declared structurally so the viewer and its tests need no router types; dates
 * arrive as ISO strings over the wire.
 */
export interface RunAttempt {
	id: string;
	seq: number;
	trigger: 'automatic' | 'reset' | 'retry';
	requestedAt: string | Date | null;
	workerId: string | null;
	workerName: string | null;
	engine: string | null;
	model: string | null;
	startedAt: string | Date;
	endedAt: string | Date | null;
	outcome: 'completed' | 'failed' | 'deferred' | 'checkpointed' | 'superseded' | null;
	error: string | null;
	nextRetryAt: string | Date | null;
	outputEventCount: number;
	outputTruncated: boolean;
}

const OUTCOMES: Record<NonNullable<RunAttempt['outcome']>, { label: string; tone: BadgeTone }> = {
	completed: { label: 'Completed', tone: 'positive' },
	failed: { label: 'Failed', tone: 'negative' },
	deferred: { label: 'Deferred', tone: 'caution' },
	checkpointed: { label: 'Checkpointed', tone: 'caution' },
	superseded: { label: 'No outcome recorded', tone: 'neutral' },
};

export function attemptOutcome(attempt: RunAttempt): { label: string; tone: BadgeTone } {
	return attempt.outcome ? OUTCOMES[attempt.outcome] : { label: 'Running', tone: 'neutral' };
}

/** The worker and CLI an attempt ran on, as one line. */
export function attemptPlacement(attempt: RunAttempt): string {
	const worker = attempt.workerName ?? attempt.workerId ?? 'unknown worker';
	const cli = [attempt.engine, attempt.model].filter(Boolean).join(' / ');
	return cli ? `${worker} · ${cli}` : worker;
}

const OPERATOR_TRIGGERS = {
	reset: 'Reset & restart requested by an operator',
	retry: 'Retry now requested by an operator',
} as const;

function formatTime(value: string | Date | null): string | null {
	return value ? new Date(value).toLocaleString() : null;
}

/** What an attempt left for its output: the empty states the viewer and timeline share. */
export function attemptOutputNote(attempt: RunAttempt): string {
	if (attempt.outputEventCount === 0) {
		return attempt.outcome === null
			? 'No output yet.'
			: 'No agent output was captured for this attempt.';
	}
	const lines = `${attempt.outputEventCount} output ${attempt.outputEventCount === 1 ? 'line' : 'lines'}`;
	return attempt.outputTruncated
		? `${lines} (retention limit reached; later output dropped)`
		: lines;
}

function AttemptEntry({ attempt, latest }: { attempt: RunAttempt; latest: boolean }) {
	const outcome = attemptOutcome(attempt);
	const started = formatTime(attempt.startedAt);
	const ended = formatTime(attempt.endedAt);
	const retryAt = attempt.outcome === 'deferred' ? formatTime(attempt.nextRetryAt) : null;
	return (
		<li className="space-y-2" data-testid={`run-attempt-${attempt.seq}`}>
			{attempt.trigger !== 'automatic' && (
				<p className="flex items-center gap-1.5 text-xs text-violet-300">
					<RotateCcw className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
					{OPERATOR_TRIGGERS[attempt.trigger]}
					{attempt.requestedAt ? ` · ${formatTime(attempt.requestedAt)}` : ''}
				</p>
			)}
			<div className="border border-zinc-800 rounded-md bg-panel/20 p-3 space-y-2">
				<div className="flex flex-wrap items-center gap-2">
					<span className="text-sm font-semibold text-zinc-200">Attempt {attempt.seq}</span>
					<Badge tone={outcome.tone}>{outcome.label}</Badge>
					{latest && <Badge>Latest</Badge>}
					<span className="text-xs font-mono text-zinc-400">{attemptPlacement(attempt)}</span>
				</div>
				<p className="text-xs text-zinc-500">
					Started {started}
					{ended ? ` · ended ${ended}` : ''}
					{retryAt ? ` · retry was scheduled for ${retryAt}` : ''}
				</p>
				{attempt.error && (
					// A completed attempt's note is not a failure — a Resolve problem run that
					// found nothing left to resolve records one (issue #1441) — so it reads
					// neutral; every other outcome's error keeps the red box.
					<pre
						className={`max-h-32 overflow-auto whitespace-pre-wrap break-words p-2.5 border text-xs rounded font-mono ${
							attempt.outcome === 'completed'
								? 'bg-zinc-900/40 border-zinc-800 text-zinc-300'
								: 'bg-red-950/30 border-red-900/30 text-red-400'
						}`}
					>
						{attempt.error}
					</pre>
				)}
				<p className="text-xs text-zinc-400">{attemptOutputNote(attempt)}</p>
			</div>
		</li>
	);
}

/**
 * The run's attempt history (issue #1400): every dispatch or retry that ran, with
 * its worker, CLI, times, outcome and error, and the operator action that started
 * it. The run's own status and error describe only the latest of these.
 */
export function RunAttemptsTimeline({ attempts }: { attempts: RunAttempt[] }) {
	if (attempts.length === 0) return null;
	return (
		<section className="border border-zinc-800 rounded-lg bg-panel/40 p-6 shadow-sm space-y-4">
			<div className="border-b border-zinc-800 pb-2">
				<h2 className="text-sm font-semibold text-zinc-200">Attempts</h2>
				<p className="text-xs text-zinc-400">
					Each time this run was dispatched to a worker. The run status above is the latest
					attempt's; earlier attempts keep their own outcome and error.
				</p>
			</div>
			<ol className="space-y-3">
				{attempts.map((attempt, index) => (
					<AttemptEntry
						key={attempt.id}
						attempt={attempt}
						latest={attempts.length > 1 && index === attempts.length - 1}
					/>
				))}
			</ol>
		</section>
	);
}
