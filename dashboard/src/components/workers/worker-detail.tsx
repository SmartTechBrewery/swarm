import { useMutation } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { resolveRunTitle, WorkItemCell } from '@/components/runs/work-item-cell.js';
import { Badge } from '@/components/ui/badge.js';
import { buttonClass } from '@/components/ui/button.js';
import {
	formatWorkerBuild,
	WorkerBuildBadge,
	WorkerUpdatingBadge,
} from '@/components/workers/worker-build.js';
import { WorkerDeleteCard } from '@/components/workers/worker-delete-card.js';
import { WorkerDrainCard } from '@/components/workers/worker-drain-card.js';
import { WorkerEnrollDialog } from '@/components/workers/worker-enroll-dialog.js';
import { WorkerEnrollmentCard } from '@/components/workers/worker-enrollment-card.js';
import { WorkerOperatorCredentialsCard } from '@/components/workers/worker-operator-credentials-card.js';
import { WorkerRateLimitCard } from '@/components/workers/worker-rate-limit-card.js';
import { formatPhase, formatRelativeTime } from '@/lib/format.js';
import { sortPipelinePhases } from '@/lib/pipeline-phases.js';
import { trpcClient } from '@/lib/trpc.js';
import { useDraftSync } from '@/lib/use-draft-sync.js';
import type { WorkerDetail } from '@/types/workers.js';
import type { AgentCli } from '../../../../src/harness/agent-cli.js';

/**
 * One machine in full (issue #477) — where the Workers table is the scannable
 * index, this is where an operator understands and administers a single worker.
 * It is grouped into sections rather than a field dump: identity and owner,
 * connectivity — including asking this machine to update — what the daemon
 * declares, the active job, and one block per project the machine is enrolled in
 * ({@link WorkerEnrollmentCard}, which owns the editable values and their
 * authorization).
 *
 * **The daemon's `supportedPhases`, `repository` and `build` are read-only; its CLI
 * set is not.** A daemon declares them all at handshake and re-declares them on every
 * reconnect, so a phase repertoire, a checkout repository and a SWARM build are
 * reported here and never offered as an edit — editing any of them would only make
 * the dashboard disagree with the machine until its next heartbeat. The checkout
 * repository is here because it is the fact an enrollment for a *different*
 * repository is refused or suspended against (issue #690), which the enrollment
 * blocks below then name in full. The **SWARM build** is here (issue #925) because
 * it is the only thing that answers "is this machine running the fix?": it is marked
 * when it is not the control plane's own build, and this screen is the one surface
 * that also *names* that build, so "differs from what" is readable rather than
 * remembered. Nothing acts on the mark — a machine on a different build is dispatched
 * to exactly as before. Since issue #978 that field carries a second mark beside it,
 * `Updating`, for a request the machine has not answered yet; the two are shown
 * together, because "behind and nobody has noticed" and "behind and already being
 * fixed" are different answers to the same glance.
 *
 * The CLI set is the exception, because since issue #783 it is two facts rather than
 * one: the daemon's probe, and the owner's **durable declaration** over it, which no
 * reconnect overwrites. So the owner may state it here ({@link DeclaredClisControl},
 * issue #787) — a narrowing of what the machine reported, never a widening, and
 * clearable back to plain auto-detection. Gated by `viewerIsOwner` exactly like the
 * rename field, and by the same strict-ownership check server-side
 * (`workers.setDeclaredCapabilities`, no `instanceAdmin` override); a non-owner sees
 * the effective set as badges.
 *
 * **The machine's own name is the one Identity-card fact that *is* editable** —
 * unlike the self-declared facts above, `displayName` is the owner's own label,
 * not something the daemon states, so there is nothing for an edit to disagree
 * with ({@link WorkerNameField}). Gated by `viewerIsOwner` exactly like the
 * enrollment card's owner-controlled values, and by the same strict-ownership
 * check server-side (`workers.rename`, no `instanceAdmin` override).
 *
 * **Nothing secret is *read back* on this surface**, by construction rather than by
 * filtering: `workers.getById` names each safe field explicitly, so no machine path,
 * worker credential, credential hash, or project PAT exists to leak. Since issue #766
 * it does host one **write-only** secret field — the operator source-control
 * credential ({@link WorkerOperatorCredentialsCard}) — whose own read reports presence
 * and a last-updated time and never a value or a masked echo of one, so there is still
 * nothing here to reveal.
 *
 * **Offering the machine to a *new* project is here too** (issue #764), as the
 * owner's own action ({@link WorkerEnrollDialog}) over the same `workers.enroll`
 * the CLI calls — no new procedure and no new authorization. It is still a
 * different act from administering an existing enrollment, and it produces one:
 * the new enrollment starts pending with sharing consent off — so a project
 * administrator's approval and the owner's consent remain exactly where they were
 * — unless the owner also administers the chosen project, in which case both
 * approvals were already theirs and the server grants them at once (issue #784).
 * It is offered **only before the machine's first enrollment** (issue #789): the
 * checkout binds the machine to one repository for its whole connected life, so
 * an already-enrolled machine has no second project the server would accept.
 *
 * **Retiring the machine is therefore a deletion, not a re-enrollment**
 * ({@link WorkerDeleteCard}, issue #789). Since the pairing is permanent, freeing
 * the operator up for a new machine/repository pairing means removing this
 * registration — owner-only behind a confirmation that names everything the
 * removal cascades to.
 *
 * **Taking the machine out of the dispatch pool lives here too**
 * ({@link WorkerDrainCard}, issue #926 over issue #919's state), because draining is
 * machine-scoped exactly like the two cards above: it is one operator's statement
 * about one machine of theirs — usually so they can restart it — not a decision
 * about any project that happens to be enrolled on it, which is why the project
 * Workers tab has no such control. It sits right after **Active job** since it reads
 * that same fact: draining alone means no *new* work, and what the machine is still
 * running is what says whether restarting is safe yet. It is deliberately the one
 * owner action here with **no confirmation** — reversible, effective only from the
 * next dispatch, and undone by the button that replaces it — and a drained machine
 * that is online still reads as Online, here and in the table's Status column: this
 * is an operator state, never an error or an outage.
 */

const CARD_CLASS = 'border border-zinc-800 rounded-lg bg-panel/40 p-6 shadow-sm';
const SECTION_HEADING_CLASS =
	'text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4';
const LABEL_CLASS = 'block text-xs font-medium text-zinc-400';
const FIELD_CLASS =
	'block w-full max-w-xs px-3 py-1.5 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 disabled:opacity-50 disabled:bg-zinc-950 disabled:border-zinc-800 disabled:text-zinc-500';

/** One labelled read-only field of the identity/connectivity grids. */
function Field({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
	return (
		<div>
			<span className={LABEL_CLASS}>{label}</span>
			<div
				className={`mt-1 text-sm text-zinc-200 break-words ${mono ? 'font-mono select-all' : ''}`}
			>
				{children}
			</div>
		</div>
	);
}

const EM_DASH = <span className="text-zinc-500">—</span>;

/**
 * The machine's own label, editable only by its owner (`workers.rename`, strict
 * ownership, no `instanceAdmin` override — mirrors the enrollment card's
 * {@link WorkerEnrollmentCard} controls). A non-owner sees the plain name, same
 * as every other Identity field. Draft-and-save rather than save-per-keystroke,
 * the same shape as the enrollment card's concurrency control: a free-text field
 * can't safely fire a mutation on every keystroke, and a draft re-syncs from the
 * server's value whenever it actually changes so the screen's polling can't
 * clobber a half-typed edit.
 */
function WorkerNameField({
	workerId,
	displayName,
	editable,
	onChanged,
}: {
	workerId: string;
	displayName: string;
	editable: boolean;
	onChanged: () => void;
}) {
	const [draft, setDraft] = useDraftSync(displayName, (name) => name);

	const renameMutation = useMutation({
		mutationFn: (nextDisplayName: string) =>
			trpcClient.workers.rename.mutate({ workerId, displayName: nextDisplayName }),
		onSuccess: onChanged,
	});

	if (!editable) return <>{displayName}</>;

	const trimmed = draft.trim();
	const unchanged = trimmed === displayName;
	const invalid = trimmed.length === 0;

	return (
		<div className="space-y-1.5">
			<div className="flex items-center gap-2">
				<input
					aria-label="Machine name"
					type="text"
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					disabled={renameMutation.isPending}
					maxLength={80}
					className={FIELD_CLASS}
				/>
				<button
					type="button"
					onClick={() => renameMutation.mutate(trimmed)}
					disabled={renameMutation.isPending || unchanged || invalid}
					className={buttonClass('secondary', 'sm')}
				>
					Save
				</button>
			</div>
			{renameMutation.isError ? (
				<p className="text-xs text-red-400">{renameMutation.error.message}</p>
			) : null}
		</div>
	);
}

/** Order-insensitive comparison of two CLI selections. */
function sameClis(a: string[], b: string[]): boolean {
	return a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');
}

/**
 * The machine's agent CLIs, as the owner's **durable declaration** over the
 * daemon's probe (issue #787 over issue #783's seam). One checkbox per CLI the
 * machine actually reported (`probedCapabilities`) — never per *effective* CLI —
 * because the server refuses a declaration naming anything else
 * (`WorkerCapabilityNotProbedError`), so offering it would be offering a control
 * that fails. The last checked CLI can't be unchecked for the same reason the
 * enrollment card pins its last allowed one: an empty declaration is rejected, and
 * a disabled checkbox reads better than a round trip that comes back invalid.
 *
 * Draft-and-save rather than save-per-click, unlike the enrollment card's CLI
 * control: a declaration is one whole set, and the page polls, so a half-made
 * selection must not be clobbered mid-edit — {@link useDraftSync} keyed on the set
 * currently in force resyncs only when the server's own answer changes.
 *
 * Both server guards are surfaced verbatim rather than pre-empted here: dropping a
 * CLI an active enrollment still requires is a `CONFLICT` whose message names the
 * offending CLIs, and neither this control nor its "Use auto-detected CLIs" reset
 * decides anything about routability on its own.
 */
function DeclaredClisControl({
	workerId,
	declaredCapabilities,
	probedCapabilities,
	effectiveCapabilities,
	editable,
	ownerName,
	onChanged,
}: {
	workerId: string;
	declaredCapabilities: string[] | null;
	probedCapabilities: string[];
	/** The set actually in force — the declaration intersected with the probe. */
	effectiveCapabilities: string[];
	editable: boolean;
	ownerName: string;
	onChanged: () => void;
}) {
	// Keyed on a joined string rather than the array: a poll hands back a fresh
	// array, and the draft must only resync when the *value* changed.
	const [draft, setDraft] = useDraftSync(effectiveCapabilities.join(','), (joined) =>
		joined.length === 0 ? [] : joined.split(','),
	);

	const declareMutation = useMutation({
		mutationFn: (capabilities: AgentCli[] | null) =>
			trpcClient.workers.setDeclaredCapabilities.mutate({ workerId, capabilities }),
		onSuccess: onChanged,
	});

	// A declared CLI the machine's latest probe no longer reports: the gate has
	// already intersected it out of the effective set, so say so rather than letting
	// the screen look like the declaration simply changed on its own.
	const drifted = (declaredCapabilities ?? []).filter((cli) => !probedCapabilities.includes(cli));

	if (!editable) {
		return (
			<div className="space-y-1.5">
				<div
					className="flex flex-wrap gap-1"
					title={`Only ${ownerName} can declare which CLIs this machine runs`}
				>
					{effectiveCapabilities.length === 0
						? EM_DASH
						: effectiveCapabilities.map((cli) => <Badge key={cli}>{cli}</Badge>)}
				</div>
				<DriftedClisNote drifted={drifted} />
			</div>
		);
	}

	const isLastSelected = (cli: string) => draft.length === 1 && draft[0] === cli;
	// The edit starts at the currently usable intersection, but a durable declaration
	// can be wider after a later probe drifts. Compare a declared draft to its stored
	// declaration so the owner can persist that visible, valid intersection; with no
	// declaration, the probe remains the auto-detection baseline.
	const unchanged = sameClis(draft, declaredCapabilities ?? effectiveCapabilities);

	return (
		<div className="space-y-2">
			{probedCapabilities.length === 0 ? (
				<p className="text-xs text-zinc-500">
					This machine has reported no agent CLI, so there is nothing to declare yet.
				</p>
			) : (
				<div className="flex flex-wrap gap-x-4 gap-y-2">
					{probedCapabilities.map((cli) => {
						const checked = draft.includes(cli);
						return (
							<label key={cli} className="inline-flex items-center gap-2 text-sm text-zinc-300">
								<input
									type="checkbox"
									// An explicit name, so this control and the enrollment blocks' own
									// per-CLI checkboxes below stay tellable apart — they answer two
									// different questions about the same CLI.
									aria-label={`Declare ${cli}`}
									checked={checked}
									disabled={declareMutation.isPending || isLastSelected(cli)}
									title={
										isLastSelected(cli)
											? 'At least one CLI must stay selected — to stop declaring a set at all, use Use auto-detected CLIs'
											: undefined
									}
									onChange={() =>
										setDraft(
											checked
												? draft.filter((one) => one !== cli)
												: probedCapabilities.filter((one) => draft.includes(one) || one === cli),
										)
									}
									className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-violet-600 focus:ring-1 focus:ring-violet-500 disabled:opacity-50 disabled:cursor-not-allowed"
								/>
								<span className="font-mono">{cli}</span>
							</label>
						);
					})}
				</div>
			)}
			<div className="flex flex-wrap items-center gap-2">
				<button
					type="button"
					// Cast at the boundary, as the enrollment card's own CLI control does: the
					// read model mirrors CLIs as plain strings, and the procedure's input
					// re-validates them against `AgentCliSchema` server-side regardless.
					onClick={() => declareMutation.mutate(draft as AgentCli[])}
					disabled={declareMutation.isPending || unchanged || draft.length === 0}
					className={buttonClass('secondary', 'sm')}
				>
					{declareMutation.isPending ? 'Saving…' : 'Save CLIs'}
				</button>
				{/* Only when there is a declaration to clear — with none, auto-detection is
				    already what is in force. */}
				{declaredCapabilities !== null ? (
					<button
						type="button"
						onClick={() => declareMutation.mutate(null)}
						disabled={declareMutation.isPending}
						className={buttonClass('secondary', 'sm')}
					>
						Use auto-detected CLIs
					</button>
				) : null}
			</div>
			<DriftedClisNote drifted={drifted} />
			{declareMutation.isError ? (
				<p className="text-xs text-red-400">{declareMutation.error.message}</p>
			) : null}
		</div>
	);
}

/**
 * The one thing the effective set cannot say for itself: a declaration naming a CLI
 * the machine's latest probe no longer reports. The control plane logs that drift
 * server-side (issue #783) and routes on the intersection; this is the same fact on
 * the screen, so nobody has to explain a machine that declares `codex` and never
 * gets `codex` work.
 */
function DriftedClisNote({ drifted }: { drifted: string[] }) {
	if (drifted.length === 0) return null;
	return (
		<p className="text-xs text-amber-200">
			Declared but no longer reported by this machine: {drifted.join(', ')} — work for{' '}
			{drifted.length === 1 ? 'it' : 'them'} is not routed here until the machine reports{' '}
			{drifted.length === 1 ? 'it' : 'them'} again.
		</p>
	);
}

/**
 * Ask **this one machine** to move to the build the control plane is running — the
 * third and narrowest of the update actions, after the roster toolbars' fleet-wide
 * and project-wide ones.
 *
 * Offered to the machine's **owner** alone, on the strict `viewerIsOwner` every
 * other machine-scoped control on this screen uses (drain, delete, the operator
 * credential, the declared CLI set). An update ends in the daemon restarting, which
 * is the machine operator's call rather than an administrative one; an
 * administrator reaching someone else's machine keeps the CLI, exactly as those
 * controls say. The wider actions remain where they belong: an instance
 * administrator asks the whole installation from `/workers`, a project
 * administrator asks their project's machines from its Workers tab.
 *
 * `secondary`, because Connectivity is a card of facts and this is not the reason
 * the screen exists — and inert for now, rendered `disabled` with a title saying
 * so rather than as a live control that swallows a click.
 */
function UpdateWorkerAction({ worker }: { worker: WorkerDetail }) {
	// The gate lives here rather than at the call site: `viewerIsOwner` is this
	// action's own precondition, and asking it there would put a seventh branch in a
	// view that is already one long list of sections.
	if (!worker.viewerIsOwner) return null;

	return (
		<div className="mt-4 border-t border-zinc-800 pt-4">
			<button
				type="button"
				disabled
				title="Not wired up yet — this will ask this machine to update to the control plane's build and restart its daemon."
				className={buttonClass('secondary')}
			>
				<RefreshCw className="h-4 w-4" aria-hidden="true" />
				Update worker
			</button>
			<p className="text-xs text-zinc-500 mt-2">
				Moves this machine's SWARM installation to the control plane's build and restarts its
				daemon. Drain it first if it may be running a job.
			</p>
		</div>
	);
}

function ConnectionState({ worker }: { worker: WorkerDetail }) {
	const online = worker.connection === 'online';
	return (
		<span className="inline-flex items-center gap-2 text-sm text-zinc-200">
			<span
				className={`h-2 w-2 rounded-full ${
					online
						? 'bg-emerald-500 ring-4 ring-emerald-500/10'
						: 'bg-zinc-600 ring-4 ring-zinc-600/10'
				}`}
			/>
			{online ? 'Online' : 'Offline'}
		</span>
	);
}

/**
 * The declared phase repertoire in full — the only screen that shows it, and every
 * phase on the same terms (issue #542). What it answers is version skew: a daemon
 * built before issue #536 declares five phases rather than six, and the dispatch
 * gate routes around the missing one instead of failing (issue #467).
 *
 * Rendered in the pipeline's own order ({@link sortPipelinePhases}, issue #548) —
 * never the order the daemon happened to declare, which differs between a same-host
 * worker and a remote DB-free daemon. That makes this list read the same way as the
 * enrollment's Allowed pipeline phases below it, so "what the machine declares" and
 * "what this project allows" can be compared line for line.
 */
function SupportedPhases({ phases }: { phases: string[] }) {
	if (phases.length === 0) {
		return (
			<p className="text-xs text-zinc-500">
				No phases declared — the dispatcher treats an undeclared repertoire as every phase.
			</p>
		);
	}
	return (
		<div className="flex flex-wrap gap-1">
			{sortPipelinePhases(phases).map((phase) => (
				<Badge key={phase}>{formatPhase(phase)}</Badge>
			))}
		</div>
	);
}

/**
 * The build the daemon declared (issue #925), with both marks the Workers screens
 * put beside a machine: the short commit, a `+dirty` suffix when the running code is
 * not exactly that commit, and `—` when the machine declared nothing.
 *
 * `Updating` leads (issue #978) — the more recent fact, and the one that explains a
 * differing build beside it — and the two render together rather than one instead of
 * the other. It is deliberately outside the undeclared-build case: a machine that
 * declared no build can still have been asked to move to one, and that request is
 * exactly what an operator is watching for.
 */
function DeclaredBuild({ worker }: { worker: WorkerDetail }) {
	return (
		<span className="inline-flex flex-wrap items-center gap-2">
			{worker.build ? formatWorkerBuild(worker.build) : EM_DASH}
			<WorkerUpdatingBadge update={worker.update} />
			<WorkerBuildBadge
				buildIsCurrent={worker.buildIsCurrent}
				controlPlaneBuild={worker.controlPlaneBuild}
			/>
		</span>
	);
}

/**
 * What the build above is being compared against — the whole reason this screen
 * carries the comparand (issue #925): a mark that names no other build leaves
 * "outdated relative to what?" in the operator's head. A control plane that cannot
 * read its own build says so, rather than letting an absent mark read as "all
 * current".
 */
function BuildComparisonNote({
	controlPlaneBuild,
}: {
	controlPlaneBuild: WorkerDetail['controlPlaneBuild'];
}) {
	if (!controlPlaneBuild) {
		return (
			<>
				This control plane cannot read its own build, so nothing here is compared against it and no
				machine is marked <em>Outdated</em> either way. An <em>Updating</em> mark is unaffected: it
				reports a request this machine has not answered, which needs no comparison.
			</>
		);
	}
	return (
		<>
			This control plane is on{' '}
			<span className="font-mono text-zinc-400">{formatWorkerBuild(controlPlaneBuild)}</span>, and a
			machine whose build is not that one is marked <em>Outdated</em> — the two builds differ, which
			is all an equality check can say. A worker keeps running whatever its checkout held when its
			process last started, so the remedy is updating that checkout and restarting the daemon. A
			machine marked <em>Updating</em> has been asked to move to a named build and has not answered
			yet, so it is still running the build above: the two marks are different facts, and a machine
			waiting on a request it has not answered carries both.
		</>
	);
}

/**
 * **Pool membership** (issue #926) — the drain control, directly after Active job,
 * which is the other half of "is it safe to restart this machine yet?". Owner-only
 * behind the same strict flag as the other owner cards, and the server re-checks it
 * on `workers.setDraining`.
 *
 * A section of its own rather than another conditional inline in `WorkerDetailView`,
 * which keeps that component within the repository's cognitive-complexity limit and
 * puts the run-reading below beside the card it feeds.
 *
 * **The card is told the run's presence, not just its title.** `currentRun` is the
 * authoritative "this machine is executing something" fact — the server derives it
 * from run lifecycle — while a title is optional prose a PR-driven phase never
 * carries, so only the former may decide whether restarting is safe. The title is
 * resolved exactly as Active job above resolves it ({@link resolveRunTitle}), so the
 * two sections name the same job in the same words.
 */
function PoolMembershipSection({
	worker,
	onChanged,
}: {
	worker: WorkerDetail;
	onChanged: () => void;
}) {
	if (!worker.viewerIsOwner) return null;
	return (
		<div className={CARD_CLASS}>
			<h2 className={SECTION_HEADING_CLASS}>Pool membership</h2>
			<WorkerDrainCard
				workerId={worker.workerId}
				drainingSince={worker.drainingSince}
				isRunning={worker.currentRun !== null}
				currentRunTitle={worker.currentRun ? resolveRunTitle(worker.currentRun) : null}
				onChanged={onChanged}
			/>
		</div>
	);
}

/**
 * **Usage limits** (issue #988) — the machine's live CLI cool-downs, directly
 * before Pool membership so the observed half of "why is this machine not taking
 * work?" reads beside the operator-declared half ({@link WorkerDrainCard}).
 *
 * **Visible to every viewer of this screen, unlike the two owner-only sections
 * below it.** Those gate on `viewerIsOwner` because they carry *controls*; this one
 * carries none — there is no way to clear a cool-down — and it is a fact anyone
 * looking at why their project's work is queued needs. Gating it would hide the
 * answer from exactly the person asking the question.
 *
 * A section of its own rather than a field in the daemon card above: that card is
 * what the machine *declares* and is stable between reconnects, while this is what a
 * run *observed* and lapses on a timer. The whole section disappears for a machine
 * cooling on nothing — the record self-releases, so an empty state would be
 * reporting a non-event.
 */
function UsageLimitsSection({ worker }: { worker: WorkerDetail }) {
	if (worker.rateLimits.length === 0) return null;
	return (
		<div className={CARD_CLASS}>
			<h2 className={SECTION_HEADING_CLASS}>Usage limits</h2>
			<WorkerRateLimitCard rateLimits={worker.rateLimits} />
		</div>
	);
}

/**
 * **Operator source-control credential** (issue #766) — worker-scoped state, so it
 * sits above the per-project blocks, which are also what decide which providers it
 * lists. Owner-only, the same strict flag that gates the rename field and the enroll
 * entry point, and the server re-checks the same rule on every procedure including
 * the read. Extracted alongside {@link PoolMembershipSection} for the same reason:
 * one owner-only section per component keeps `WorkerDetailView` within the
 * repository's cognitive-complexity limit.
 */
function OperatorCredentialSection({ worker }: { worker: WorkerDetail }) {
	if (!worker.viewerIsOwner) return null;
	return (
		<div className={CARD_CLASS}>
			<h2 className={SECTION_HEADING_CLASS}>Operator source-control credential</h2>
			<WorkerOperatorCredentialsCard workerId={worker.workerId} />
		</div>
	);
}

interface WorkerDetailViewProps {
	worker: WorkerDetail;
	/** Project id → display name, so an enrollment block names its project. */
	projectNames: Map<string, string>;
	/**
	 * Project id → the phases that project has turned off for every worker
	 * (`pipeline.<phase>.enabled: false`), so the Allowed-pipeline-phases control can
	 * say that a phase is off project-wide rather than offering a selection that
	 * could never take work (issue #509).
	 */
	projectDisabledPhases: Map<string, string[]>;
	/** Called after a mutation lands, so the caller refetches the authoritative view. */
	onChanged: () => void;
	/** Called once the worker is deleted, so the caller drops the query and navigates away. */
	onDeleted: () => void;
}

export function WorkerDetailView({
	worker,
	projectNames,
	projectDisabledPhases,
	onChanged,
	onDeleted,
}: WorkerDetailViewProps) {
	const ownerName = worker.owner?.displayName ?? 'the owner';
	const [enrollOpen, setEnrollOpen] = useState(false);

	// A worker's SWARM_WORKER_REPO_ROOT checkout binds it to one repository for its
	// whole connected life, and `enrollWorker` refuses a project for any other one, so
	// a machine that already holds an enrollment — pending, active, or suspended alike
	// — has no second project it could realistically be offered to (issue #789).
	// Offering the action anyway only ever produced a repository-mismatch rejection.
	// Retiring the machine to free the pairing is the Delete worker card below, not a
	// second enrollment.
	const canEnroll = worker.viewerIsOwner && worker.enrollments.length === 0;

	return (
		<div className="space-y-6">
			<div className={CARD_CLASS}>
				<h2 className={SECTION_HEADING_CLASS}>Identity</h2>
				<div className="grid gap-4 grid-cols-1 md:grid-cols-2">
					<Field label="Machine">
						<WorkerNameField
							workerId={worker.workerId}
							displayName={worker.displayName}
							editable={worker.viewerIsOwner}
							onChanged={onChanged}
						/>
					</Field>
					<Field label="Worker ID" mono>
						{worker.workerId}
					</Field>
					<Field label="Owner">{worker.owner?.displayName ?? EM_DASH}</Field>
					<Field label="Owner identifier" mono>
						{worker.owner?.identifier ?? EM_DASH}
					</Field>
				</div>
			</div>

			<div className={CARD_CLASS}>
				<h2 className={SECTION_HEADING_CLASS}>Connectivity</h2>
				<div className="grid gap-4 grid-cols-1 md:grid-cols-2">
					<Field label="Connection">
						<ConnectionState worker={worker} />
					</Field>
					<Field label="Last seen">
						{worker.lastSeenAt ? (
							<span title={new Date(worker.lastSeenAt).toLocaleString()}>
								{formatRelativeTime(worker.lastSeenAt)}
							</span>
						) : (
							<span className="text-zinc-500">Never connected</span>
						)}
					</Field>
				</div>
				<p className="text-xs text-zinc-500 mt-4">
					Derived from the machine's heartbeat lease — the one liveness rule the dispatch gate
					reads. This screen polls, so the state stays current while it is open.
				</p>
				{/* The machine-scoped twin of the roster toolbars' update actions, in
				    Connectivity because that is the card about this machine's relationship
				    with the control plane — and because an update ends in a restart, which
				    is the one thing on this screen that interrupts that relationship. */}
				<UpdateWorkerAction worker={worker} />
			</div>

			<div className={CARD_CLASS}>
				<h2 className={SECTION_HEADING_CLASS}>Declared by the daemon</h2>
				<div className="grid gap-4 grid-cols-1 md:grid-cols-2">
					<Field label="Agent CLIs">
						<DeclaredClisControl
							workerId={worker.workerId}
							declaredCapabilities={worker.declaredCapabilities}
							probedCapabilities={worker.probedCapabilities}
							effectiveCapabilities={worker.capabilities}
							editable={worker.viewerIsOwner}
							ownerName={ownerName}
							onChanged={onChanged}
						/>
					</Field>
					<Field label="Pipeline phases">
						<SupportedPhases phases={worker.supportedPhases} />
					</Field>
					<Field label="Checkout repository" mono>
						{worker.repository ?? EM_DASH}
					</Field>
					<Field label="SWARM build" mono>
						<DeclaredBuild worker={worker} />
					</Field>
				</div>
				<p className="text-xs text-zinc-500 mt-4">
					Declared by the machine's own daemon at handshake, and re-declared on every reconnect. The
					pipeline phases, the checkout repository and the SWARM build are reported here and never
					editable — editing any of them would make this screen disagree with the machine. A daemon
					on an older build can declare fewer phases than this one runs; which of them a project may
					actually give this machine is the enrollment's Allowed pipeline phases, below. The
					checkout repository is the single repository this machine works in: a project for any
					other one cannot run here, and an unidentifiable checkout declares nothing.
				</p>
				<p className="text-xs text-zinc-500 mt-2">
					The <strong>SWARM build is the commit this machine's daemon is actually running</strong> —
					its own SWARM install root, which is not the checkout repository above: one installation
					can serve several project repositories. A <span className="font-mono">+dirty</span> marker
					means the running code is not exactly that commit (uncommitted changes, or a build older
					than the commit it names).{' '}
					<BuildComparisonNote controlPlaneBuild={worker.controlPlaneBuild} />
				</p>
				<p className="text-xs text-zinc-500 mt-2">
					The <strong>agent CLIs are the one fact the machine's owner may pin.</strong> Left alone,
					the list is whatever the daemon last found on the machine's own PATH. Declaring a narrower
					set is durable — it survives every reconnect and is what dispatch routes on — and can only
					narrow that list: to add a CLI, install it on the machine. <em>Use auto-detected CLIs</em>{' '}
					clears the declaration and hands the list back to auto-detection.
				</p>
			</div>

			<div className={CARD_CLASS}>
				<h2 className={SECTION_HEADING_CLASS}>Active job</h2>
				{worker.currentRun ? (
					<div className="space-y-2">
						<WorkItemCell
							run={worker.currentRun}
							titleHref={`/runs/${worker.currentRun.runId}`}
							phaseLabel={formatPhase(worker.currentRun.phase)}
							variant="card"
						/>
						<p className="text-xs text-zinc-500">
							Running for{' '}
							{projectNames.get(worker.currentRun.projectId) ?? worker.currentRun.projectId}
						</p>
					</div>
				) : (
					<p className="text-sm text-zinc-400">Idle — no run assigned right now.</p>
				)}
			</div>

			<UsageLimitsSection worker={worker} />

			<PoolMembershipSection worker={worker} onChanged={onChanged} />

			<OperatorCredentialSection worker={worker} />

			<div className={CARD_CLASS}>
				<h2 className={SECTION_HEADING_CLASS}>Project enrollments</h2>
				{/* Kept a sibling of the heading rather than wrapped around it: the heading
				    stays the section's own accessible name, and the action reads as one of
				    the section's contents. */}
				{canEnroll ? (
					<div className="mb-4">
						<button
							type="button"
							onClick={() => setEnrollOpen(true)}
							className={buttonClass('secondary', 'sm')}
						>
							Enroll in a project
						</button>
					</div>
				) : null}
				{worker.enrollments.length === 0 ? (
					<p className="text-sm text-zinc-400">
						{canEnroll
							? 'This machine is not enrolled in any project yet. Offer it to one with Enroll in a project — it then waits for that project’s administrator to approve it.'
							: 'This machine is not enrolled in any project you can see. Offering it to a project is its owner’s action.'}
					</p>
				) : (
					<ul className="space-y-4">
						{worker.enrollments.map((enrollment) => (
							<WorkerEnrollmentCard
								key={enrollment.enrollmentId}
								enrollment={enrollment}
								workerName={worker.displayName}
								capabilities={worker.capabilities}
								supportedPhases={worker.supportedPhases}
								declaredRepository={worker.repository}
								projectDisabledPhases={projectDisabledPhases.get(enrollment.projectId) ?? []}
								projectName={projectNames.get(enrollment.projectId) ?? enrollment.projectId}
								viewerIsOwner={worker.viewerIsOwner}
								ownerName={ownerName}
								onChanged={onChanged}
							/>
						))}
					</ul>
				)}
			</div>

			{/* The machine's own retirement, so it sits last — after everything the
			    confirmation says will go with it. Owner-only, and the server applies the
			    same strict-ownership rule to `workers.remove`. */}
			{worker.viewerIsOwner ? (
				<div className={CARD_CLASS}>
					<h2 className={SECTION_HEADING_CLASS}>Delete worker</h2>
					<WorkerDeleteCard
						workerId={worker.workerId}
						workerName={worker.displayName}
						enrollmentCount={worker.enrollments.length}
						currentRunTitle={worker.currentRun?.workItemTitle ?? null}
						onDeleted={onDeleted}
					/>
				</div>
			) : null}

			{/* Last child of the page rather than inside the enrollments card, so an open
			    modal's DOM doesn't land inside that section's subtree. */}
			{canEnroll ? (
				<WorkerEnrollDialog
					open={enrollOpen}
					onOpenChange={setEnrollOpen}
					workerId={worker.workerId}
					workerName={worker.displayName}
					capabilities={worker.capabilities}
					enrolledProjectIds={worker.enrollments.map((enrollment) => enrollment.projectId)}
					onChanged={onChanged}
				/>
			) : null}
		</div>
	);
}
