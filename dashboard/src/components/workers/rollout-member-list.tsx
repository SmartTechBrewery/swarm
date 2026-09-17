import { Badge } from '@/components/ui/badge.js';
import {
	describeRolloutMemberState,
	tallyRolloutMemberStates,
} from '@/lib/worker-rollout-states.js';
import type { WorkerRolloutMember } from '@/types/workers.js';

/**
 * Where every machine in a staged fleet update stands (issue #1025) — one line per
 * member with its name, its owner, its state and whatever the machine itself said,
 * then a tally so the fleet reads without counting rows.
 *
 * Shared by the two surfaces that show a rollout — the `/workers` readout
 * ({@link InstallationRolloutPanel}) and the success state of the dialog that starts
 * one ({@link FleetRolloutDialog}) — so what an operator reads the instant they press
 * the button and what they read on every later visit cannot drift into two different
 * descriptions of the same rollout.
 *
 * **Every member the server named is listed**, including one whose state this build
 * has never heard of: `@/lib/worker-rollout-states.js` falls back to the server's own
 * word rather than dropping the row, because a machine missing from the readout reads
 * as a machine the rollout never named.
 *
 * Rendered in the rollout's **own** order (`position`) rather than the order the
 * array arrived in — that is the order it reaches the machines in, and it is the one
 * thing here that is a fact rather than a presentation choice.
 */
export function RolloutMemberList({ members }: { members: WorkerRolloutMember[] }) {
	const ordered = [...members].sort((a, b) => a.position - b.position);
	const tally = tallyRolloutMemberStates(ordered);

	if (ordered.length === 0) {
		return (
			<p className="text-sm text-zinc-400 leading-relaxed">
				No machines — nothing was registered for this rollout to move.
			</p>
		);
	}

	return (
		<div className="space-y-2">
			<ul className="max-h-64 overflow-y-auto border border-zinc-800 rounded-lg bg-panel/20 divide-y divide-zinc-800/60">
				{ordered.map((member) => (
					<RolloutMemberRow key={member.workerId} member={member} />
				))}
			</ul>
			<p className="text-xs text-zinc-500">
				{ordered.length} {ordered.length === 1 ? 'machine' : 'machines'}:{' '}
				{tally
					.map(({ state, count }) => `${count} ${describeRolloutMemberState(state).label}`)
					.join(', ')}
			</p>
		</div>
	);
}

/**
 * One machine's line: what it is, whose it is, where it stands, and what it said.
 *
 * The message is cut to its **first line**, for the reason `memberDetail`
 * (`src/cli/commands/workers.ts`) already cuts it: a failed build's message carries a
 * bounded command tail, which belongs in the halt reason under the list rather than
 * in the middle of it. The machine's reported `outcome` leads it where there is one,
 * since that is the machine's own verdict rather than the rollout's.
 */
function RolloutMemberRow({ member }: { member: WorkerRolloutMember }) {
	const state = describeRolloutMemberState(member.state);
	const detail = memberDetail(member);

	return (
		<li className="flex items-start justify-between gap-3 px-3 py-2">
			<div className="min-w-0">
				<p className="text-sm text-zinc-200 font-mono truncate">{member.displayName}</p>
				{/* An owner the server could not resolve is named as unknown rather than
				    silently attributed to nobody — the same reading the roster and the
				    fan-out report both give it. */}
				<p className="text-xs text-zinc-500 truncate">
					{member.owner?.identifier ?? 'owner unknown'}
				</p>
				{detail ? <p className="text-xs text-zinc-400 mt-0.5 break-words">{detail}</p> : null}
			</div>
			<Badge tone={state.tone} title={state.description}>
				{state.label}
			</Badge>
		</li>
	);
}

/** What the machine reported, and the first line of its own message. */
function memberDetail(member: WorkerRolloutMember): string | null {
	const firstLine = member.message?.split('\n')[0]?.trim();
	if (member.outcome && firstLine) return `${member.outcome}: ${firstLine}`;
	if (member.outcome) return member.outcome;
	return firstLine || null;
}
