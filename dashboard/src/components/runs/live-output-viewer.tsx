import { AlertTriangle, Pause, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
	attemptOutcome,
	attemptOutputNote,
	attemptPlacement,
	type RunAttempt,
} from './run-attempts.js';

export interface LiveOutputEvent {
	id: number;
	/** The attempt that produced this line; `null` for output recorded before attempts were. */
	attemptId?: string | null;
	stream: 'stdout' | 'stderr';
	content: string;
	emittedAt: string | Date;
}

interface OutputGroup {
	key: string;
	attempt?: RunAttempt;
	title: string;
	events: LiveOutputEvent[];
}

/**
 * Split the output by the attempt that produced it (issue #1400), in attempt order,
 * so no attempt's lines read as another's. Every attempt gets a group even with no
 * lines loaded — that is where its empty state is said. Lines recorded before
 * attempts were come first; lines of an attempt the page has not fetched yet last.
 */
export function groupOutputByAttempt(
	events: LiveOutputEvent[],
	attempts: RunAttempt[],
): OutputGroup[] {
	const known = new Set(attempts.map((attempt) => attempt.id));
	const byAttempt = new Map<string, LiveOutputEvent[]>();
	const unattributed: LiveOutputEvent[] = [];
	const unknown: LiveOutputEvent[] = [];
	for (const event of events) {
		if (!event.attemptId) unattributed.push(event);
		else if (!known.has(event.attemptId)) unknown.push(event);
		else byAttempt.set(event.attemptId, [...(byAttempt.get(event.attemptId) ?? []), event]);
	}
	const groups: OutputGroup[] = [];
	if (unattributed.length > 0) {
		groups.push({
			key: 'unattributed',
			title: 'Output recorded before attempts were tracked',
			events: unattributed,
		});
	}
	for (const attempt of attempts) {
		groups.push({
			key: attempt.id,
			attempt,
			title: `Attempt ${attempt.seq} · ${attemptPlacement(attempt)} · ${attemptOutcome(attempt).label}`,
			events: byAttempt.get(attempt.id) ?? [],
		});
	}
	if (unknown.length > 0) groups.push({ key: 'unknown', title: 'Newer attempt', events: unknown });
	return groups;
}

function OutputLine({ event }: { event: LiveOutputEvent }) {
	return (
		<div className="grid grid-cols-[7.5rem_3.5rem_1fr] gap-2 whitespace-pre-wrap">
			<time className="select-none text-zinc-600">
				{new Date(event.emittedAt).toLocaleTimeString()}
			</time>
			<span className={event.stream === 'stderr' ? 'text-red-400' : 'text-sky-400'}>
				{event.stream}
			</span>
			<span className={event.stream === 'stderr' ? 'text-red-300' : 'text-zinc-300'}>
				{event.content}
			</span>
		</div>
	);
}

function OutputGroupSection({ group }: { group: OutputGroup }) {
	const { attempt } = group;
	return (
		<section data-testid={`output-group-${group.key}`} className="space-y-1">
			<h3 className="sticky top-0 -mx-4 border-y border-zinc-850 bg-zinc-900/90 px-4 py-1.5 font-sans text-xs font-semibold text-zinc-300">
				{group.title}
			</h3>
			{group.events.map((event) => (
				<OutputLine key={event.id} event={event} />
			))}
			{attempt && group.events.length === 0 && (
				<p className="py-2 font-sans italic text-zinc-500">
					{attempt.outputEventCount === 0
						? attemptOutputNote(attempt)
						: `${attempt.outputEventCount} output lines are not loaded in this browser. Reload to inspect from the beginning.`}
				</p>
			)}
		</section>
	);
}

interface LiveOutputViewerProps {
	events: LiveOutputEvent[];
	isRunning: boolean;
	isLoading: boolean;
	retentionBytes: number;
	serverTruncated: boolean;
	uiTruncated: boolean;
	/** The run's attempts; when given, the output is shown grouped under them. */
	attempts?: RunAttempt[];
}

export function LiveOutputViewer({
	events,
	isRunning,
	isLoading,
	retentionBytes,
	serverTruncated,
	uiTruncated,
	attempts = [],
}: LiveOutputViewerProps) {
	const outputRef = useRef<HTMLDivElement>(null);
	const [autoScroll, setAutoScroll] = useState(true);
	const latestEventId = events[events.length - 1]?.id;

	useEffect(() => {
		if (!autoScroll || latestEventId === undefined) return;
		const output = outputRef.current;
		if (output) output.scrollTop = output.scrollHeight;
	}, [autoScroll, latestEventId]);

	return (
		<div className="border border-zinc-800 rounded-lg bg-zinc-950 overflow-hidden shadow-sm">
			<div className="flex items-center justify-between border-b border-zinc-850 bg-zinc-900/40 px-4 py-3 text-xs">
				<span className="text-zinc-400">
					Agent activity and CLI output · retained up to {(retentionBytes / 1_000_000).toFixed(0)}{' '}
					MB
				</span>
				<span className={isRunning ? 'text-emerald-400' : 'text-zinc-500'}>
					{isRunning ? '● Live' : 'Run ended'}
				</span>
			</div>
			{(serverTruncated || uiTruncated) && (
				<div className="flex items-center gap-2 border-b border-amber-900/30 bg-amber-950/20 px-4 py-2 text-xs text-amber-200/80">
					<AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
					{serverTruncated
						? attempts.length > 0
							? 'An attempt reached the output retention limit; its later CLI output was not stored.'
							: 'Output retention limit reached; later CLI output was not stored.'
						: 'Older entries are hidden in this browser to keep rendering responsive. Reload to inspect from the beginning.'}
				</div>
			)}
			<div className="relative h-[600px]">
				<div
					ref={outputRef}
					data-testid="live-output-scrollbox"
					className="h-full overflow-auto p-4 pb-14 font-mono text-xs leading-relaxed"
				>
					{attempts.length > 0 ? (
						<div className="space-y-4">
							{groupOutputByAttempt(events, attempts).map((group) => (
								<OutputGroupSection key={group.key} group={group} />
							))}
						</div>
					) : events.length === 0 ? (
						<div className="flex h-full items-center justify-center italic text-zinc-500">
							{isLoading ? 'Loading live output…' : 'No CLI output captured yet.'}
						</div>
					) : (
						events.map((event) => <OutputLine key={event.id} event={event} />)
					)}
				</div>
				<button
					type="button"
					onClick={() => setAutoScroll((enabled) => !enabled)}
					aria-label={autoScroll ? 'Disable auto-scroll' : 'Enable auto-scroll'}
					title={autoScroll ? 'Disable auto-scroll' : 'Enable auto-scroll'}
					className={`absolute right-3 bottom-3 rounded p-1.5 shadow-sm transition-colors focus:outline-none focus:ring-2 focus:ring-violet-500 focus:ring-offset-1 focus:ring-offset-zinc-950 ${
						autoScroll
							? 'bg-violet-600 text-white hover:bg-violet-500'
							: 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
					}`}
				>
					{autoScroll ? (
						<Play className="h-4 w-4" aria-hidden="true" />
					) : (
						<Pause className="h-4 w-4" aria-hidden="true" />
					)}
				</button>
			</div>
		</div>
	);
}
