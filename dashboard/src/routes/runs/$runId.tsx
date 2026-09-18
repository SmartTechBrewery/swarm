import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute, Link } from '@tanstack/react-router';
import {
	AlertTriangle,
	CheckCircle2,
	ChevronDown,
	ExternalLink,
	Info,
	LifeBuoy,
	ListChecks,
	Loader2,
	OctagonX,
	PauseCircle,
	Play,
	RefreshCw,
	RotateCcw,
	Server,
	Terminal,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { type LiveOutputEvent, LiveOutputViewer } from '@/components/runs/live-output-viewer.js';
import { LogViewer } from '@/components/runs/log-viewer.js';
import { RunStatusBadge } from '@/components/runs/run-status-badge.js';
import { buttonClass } from '@/components/ui/button.js';
import { Modal, ModalFooter } from '@/components/ui/modal.js';
import {
	canForceReReview,
	canForceReviewOfSupersededHead,
	describeForceReReviewResult,
	forceReReviewButtonLabel,
	forceReReviewConfirmMessage,
	forceReviewOfSupersededHeadConfirmMessage,
	isForcedReviewPending,
	showsCapSpentApprovalCallout,
} from '@/lib/force-re-review.js';
import { formatDuration, formatPhase, formatTimeUntil, formatTokenCount } from '@/lib/format.js';
import { describePreservedWorker, preservedWorkerLabel } from '@/lib/preserved-worker.js';
import { describeCancellationOrigin, normalizeRunError } from '@/lib/run-cancellation.js';
import { resolveRunDurationMs, useNow } from '@/lib/run-duration.js';
import { isMaintenanceRun } from '@/lib/run-kind.js';
import {
	canRecoverRun,
	defaultOverrideModel,
	type OverrideSelection,
	overrideSelectionChanged,
	type RecoveryChoices,
	type RecoveryPending,
	recoverButtonLabel,
	recoveryChoices,
	recoveryRetryChoiceLabel,
	seedOverrideSelection,
} from '@/lib/run-recovery.js';
import {
	canResetRun,
	describeResetResult,
	describeRestartWait,
	type ResetRunReport,
	resetButtonLabel,
	resetConfirmMessage,
} from '@/lib/run-reset.js';
import {
	canRetryRun,
	type RetryActionKind,
	retryActionKind,
	retryButtonLabel,
} from '@/lib/run-retry.js';
import {
	canTerminateRun,
	describeTerminateWait,
	formatPendingRequestWaitUntil,
	terminateButtonLabel,
	terminateConfirmMessage,
} from '@/lib/run-terminate.js';
import { trpc, trpcClient } from '@/lib/trpc.js';
import { parseWorkItemRef, workItemLabel } from '@/lib/work-item.js';
import type { AgentUsage, FailureDiagnosis, PendingRunRequest, RunRow } from '@/types/runs.js';
// Shared model catalog — the single source of truth (`src/harness/models.ts`), so
// the retry override dropdowns stay in lockstep with the config UI (issue #180).
import type { AgentCli } from '../../../../src/harness/agent-cli.js';
import {
	capabilityFor,
	MODEL_CAPABILITIES,
	type ReasoningLevel,
	reasoningChoicesFor,
} from '../../../../src/harness/models.js';
import { rootRoute } from '../__root.js';

type RunStatus = 'running' | 'completed' | 'failed' | 'deferred' | 'checkpointed';

/**
 * The two statuses that are waiting on a dispatch rather than on an agent —
 * mirrors the server's `RETRY_PENDING_RUN_STATUSES` (`isRetryPendingStatus`,
 * `src/db/repositories/runsRepository.ts`). Both can still change on their own, so
 * both keep the detail page polling.
 */
function isRetryPending(status: string | undefined): boolean {
	return status === 'deferred' || status === 'checkpointed';
}

const RUN_AGENTS = ['claude', 'antigravity', 'codex'] as const;
type RunAgent = AgentCli;

const RESTART_CLAIM_POLL_WINDOW_MS = 30_000;

/** Capitalize a normalized reasoning level for display ("high" → "High"). */
function capitalizeLevel(value: string): string {
	return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Whether the action adopts the run's preserved checkout instead of starting the
 * phase over — a session "Resume" (issue #227) or a Tier 2 checkpoint "Continue
 * now" (issue #503). The two differ in *what* they carry over (a live session vs a
 * written hand-off), but both pick work up rather than discard it, which is what
 * the control's colour and glyph communicate.
 */
function continuesPriorWork(kind: RetryActionKind): boolean {
	return kind === 'resume' || kind === 'continue';
}

/**
 * The same question for the Recover popup's single button, which also has to
 * account for the override fields below it (issue #989): an edited selection makes
 * the server start a fresh session, so a "Resume" stops carrying prior work the
 * moment one is changed — while a checkpoint continuation does not, because it
 * runs a fresh session seeded from the recorded remainder either way and is
 * CLI-agnostic by construction.
 *
 * That `'continue'` arm is unreachable from today's only caller — the Recover
 * control is scoped to the error states, and only a `checkpointed` run resolves
 * `'continue'` — but it is stated rather than omitted so the function is total
 * over `RetryActionKind`, which is what `recoveryChoices` can return.
 */
function carriesPriorWorkWith(kind: RetryActionKind, selectionChanged: boolean): boolean {
	return kind === 'continue' || (continuesPriorWork(kind) && !selectionChanged);
}

/**
 * The split button's color treatment (issue #227): emerald for an action that
 * carries prior work forward ("Resume" / "Continue now"), violet for a fresh
 * "Retry now". Shared by the wrapper (shadow), the main button, and the chevron so
 * the whole control reads as one green/violet piece.
 */
function retrySplitPalette(kind: RetryActionKind): {
	wrapper: string;
	main: string;
	chevron: string;
} {
	return continuesPriorWork(kind)
		? {
				wrapper: 'shadow-emerald-950/10',
				main: 'bg-emerald-600 hover:bg-emerald-500 focus:ring-emerald-500 border-emerald-700/50',
				chevron: 'bg-emerald-600 hover:bg-emerald-500 focus:ring-emerald-500',
			}
		: {
				wrapper: 'shadow-violet-950/10',
				main: 'bg-violet-600 hover:bg-violet-500 focus:ring-violet-500 border-violet-700/50',
				chevron: 'bg-violet-600 hover:bg-violet-500 focus:ring-violet-500',
			};
}

/**
 * The chevron's tooltip, which has to be honest about what an override does to
 * *this* run's semantics: it turns a session resume into a fresh start, but it
 * composes with a checkpoint continuation unchanged — the server keeps
 * `recoveryMode: 'checkpoint'` regardless, because a continuation runs a fresh
 * session anyway and is CLI-agnostic by construction.
 */
function retryOverrideTitle(kind: RetryActionKind): string {
	if (kind === 'resume') return 'Retry with a different model/agent (starts fresh, not a resume)';
	if (kind === 'continue')
		return 'Continue with a different model/agent (still continues from the checkpoint)';
	return 'Retry with different model/agent';
}

/**
 * The main-action + chevron pair of the retry control. A resumable run shows a
 * green "Resume" and a checkpointed one a green "Continue now" (both the Play
 * glyph — they pick work up); a blocked run shows the violet "Recheck and
 * retry" and every other retryable run the violet "Retry now" (both RefreshCw).
 * The chevron opens the override popup the parent owns.
 */
function RetrySplitButton({
	kind,
	palette,
	isPending,
	onPrimary,
	onToggle,
}: {
	kind: RetryActionKind;
	palette: { main: string; chevron: string };
	isPending: boolean;
	onPrimary: () => void;
	onToggle: () => void;
}) {
	return (
		<>
			{/* Main Button — resume, continue, or fresh retry, per the run's server semantics. */}
			<button
				type="button"
				onClick={onPrimary}
				disabled={isPending}
				className={`inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white rounded-l-md focus:outline-none focus:ring-1 focus:ring-offset-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed border-r cursor-pointer ${palette.main}`}
			>
				{continuesPriorWork(kind) ? (
					<Play className={`h-4 w-4 ${isPending ? 'animate-pulse' : ''}`} />
				) : (
					<RefreshCw className={`h-4 w-4 ${isPending ? 'animate-spin' : ''}`} />
				)}
				{retryButtonLabel(kind, isPending)}
			</button>

			{/* Chevron button (the separate right part) */}
			<button
				type="button"
				onClick={onToggle}
				disabled={isPending}
				className={`inline-flex items-center px-2 py-2 text-sm font-semibold text-white rounded-r-md focus:outline-none focus:ring-1 focus:ring-offset-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer ${palette.chevron}`}
				title={retryOverrideTitle(kind)}
			>
				<ChevronDown className="h-4 w-4" />
			</button>
		</>
	);
}

/**
 * The override popup's heading and the one caveat that varies by action kind: an
 * override abandons a session resume, but a checkpoint continuation carries on
 * regardless (a continuation always runs a fresh session, so it is CLI-agnostic).
 * Every other kind is already a fresh retry and needs no caveat.
 */
function RetryOverrideHeading({ kind }: { kind: RetryActionKind }) {
	const caveat =
		kind === 'resume'
			? "Choosing a different CLI or model starts a fresh retry instead of resuming this run's session."
			: kind === 'continue'
				? "A continuation always runs a fresh session seeded from the checkpoint, so choosing a different CLI or model still continues this run's recorded work."
				: null;

	return (
		<div className="mb-3">
			<h4 className="text-xs font-semibold text-zinc-300 tracking-wide uppercase">
				{kind === 'continue' ? 'Continuation Options' : 'Retry Options'}
			</h4>
			{caveat && (
				<p className="mt-1.5 text-[11px] font-normal normal-case tracking-normal leading-snug text-zinc-500">
					{caveat}
				</p>
			)}
		</div>
	);
}

/** The override popup's confirm label — the only kind it doesn't turn into a plain retry. */
function retryOverrideActionLabel(kind: RetryActionKind): string {
	return kind === 'continue' ? 'Continue Now' : 'Retry Now';
}

/** The overrides a retry can carry — the `runs.retryNow` input minus the run id. */
interface RetryOverrides {
	cli?: RunAgent;
	model?: string;
	reasoning?: ReasoningLevel;
}

/** The override selects' own state, plus how it compares to the run's settings. */
interface OverrideSelectionState {
	/** What the fields currently hold. */
	selection: OverrideSelection;
	/** Whether the operator moved any field off the run's own settings. */
	changed: boolean;
	selectCli: (cli: RunAgent) => void;
	selectModel: (model: string) => void;
	selectReasoning: (reasoning: ReasoningLevel | '') => void;
}

/**
 * The override selects' state, seeded from the run's own engine/model
 * (`seedOverrideSelection`, which owns the seeding rules) and resynced when the
 * run row changes underneath it, so a background refetch never leaves a stale
 * selection armed.
 *
 * Held in a hook rather than inside the fields (issue #989) because the Recover
 * popup's *action button* has to read it: it submits the selection only when the
 * operator actually edited one, and names itself accordingly.
 */
function useOverrideSelection(run: RunRow): OverrideSelectionState {
	const seeded = seedOverrideSelection(run);
	// Destructured because the resync effect depends on the three values, not on
	// the fresh object literal each render produces.
	const { cli: currentCli, model: currentModel, reasoning: currentReasoning } = seeded;

	const [selectedCli, setSelectedCli] = useState<RunAgent>(currentCli);
	const [selectedModel, setSelectedModel] = useState<string>(currentModel);
	const [selectedReasoning, setSelectedReasoning] = useState<ReasoningLevel | ''>(currentReasoning);

	useEffect(() => {
		setSelectedCli(currentCli);
		setSelectedModel(currentModel);
		setSelectedReasoning(currentReasoning);
	}, [currentCli, currentModel, currentReasoning]);

	const selection: OverrideSelection = {
		cli: selectedCli,
		model: selectedModel,
		reasoning: selectedReasoning,
	};

	return {
		selection,
		changed: overrideSelectionChanged(seeded, selection),
		selectCli: (cli) => {
			setSelectedCli(cli);
			setSelectedModel(defaultOverrideModel(cli));
			// Reasoning is model-specific — clear it on any CLI change.
			setSelectedReasoning('');
		},
		selectModel: (model) => {
			setSelectedModel(model);
			// Drop the reasoning if the new model doesn't support it.
			const stillValid =
				selectedReasoning &&
				(reasoningChoicesFor(selectedCli, model) as readonly string[]).includes(selectedReasoning);
			if (!stillValid) setSelectedReasoning('');
		},
		selectReasoning: setSelectedReasoning,
	};
}

/** The `runs.retryNow` overrides a selection stands for. */
function overridesFrom(selection: OverrideSelection): RetryOverrides {
	return {
		cli: selection.cli,
		model: selection.model,
		reasoning: selection.reasoning || undefined,
	};
}

/**
 * The agent-CLI / model / reasoning selects a manual retry can override. The
 * caller owns the state ({@link useOverrideSelection}) and whatever submits it, so
 * the same three fields serve the split button's popup — which submits them from
 * its own footer — and the Recover popup, whose single action button does.
 */
function RetryOverrideFields({
	selection,
	selectCli,
	selectModel,
	selectReasoning,
}: Pick<OverrideSelectionState, 'selection' | 'selectCli' | 'selectModel' | 'selectReasoning'>) {
	const { cli: selectedCli, model: selectedModel, reasoning: selectedReasoning } = selection;
	const reasoningOptions = reasoningChoicesFor(selectedCli, selectedModel);

	return (
		<div className="space-y-3 text-left">
			<div>
				<label
					htmlFor="agent-cli-select"
					className="block text-xs font-medium text-zinc-400 mb-1 select-none"
				>
					Agent CLI
				</label>
				<select
					id="agent-cli-select"
					value={selectedCli}
					onChange={(e) => selectCli(e.target.value as RunAgent)}
					className="w-full bg-zinc-950 border border-zinc-850 rounded px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-violet-500"
				>
					{RUN_AGENTS.map((cli) => (
						<option key={cli} value={cli}>
							{cli}
						</option>
					))}
				</select>
			</div>

			<div>
				<label
					htmlFor="model-select"
					className="block text-xs font-medium text-zinc-400 mb-1 select-none"
				>
					Model
				</label>
				<select
					id="model-select"
					value={selectedModel}
					onChange={(e) => selectModel(e.target.value)}
					className="w-full bg-zinc-950 border border-zinc-850 rounded px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-violet-500"
				>
					{MODEL_CAPABILITIES[selectedCli].map((m) => (
						<option key={m.id} value={m.id}>
							{m.label}
						</option>
					))}
				</select>
			</div>

			<div>
				<label
					htmlFor="reasoning-select"
					className="block text-xs font-medium text-zinc-400 mb-1 select-none"
				>
					Reasoning
				</label>
				<select
					id="reasoning-select"
					value={selectedReasoning}
					onChange={(e) => selectReasoning(e.target.value as ReasoningLevel | '')}
					disabled={reasoningOptions.length === 0}
					className="w-full bg-zinc-950 border border-zinc-850 rounded px-2.5 py-1.5 text-xs text-zinc-200 focus:outline-none focus:ring-1 focus:ring-violet-500 disabled:opacity-50 disabled:text-zinc-500"
				>
					<option value="">
						{reasoningOptions.length === 0
							? capabilityFor(selectedCli, selectedModel)?.fixedVariant
								? 'Fixed'
								: 'N/A'
							: (() => {
									const def = capabilityFor(selectedCli, selectedModel)?.defaultReasoning;
									return def ? `Default (${capitalizeLevel(def)})` : 'Default';
								})()}
					</option>
					{reasoningOptions.map((level) => (
						<option key={level} value={level}>
							{capitalizeLevel(level)}
						</option>
					))}
				</select>
			</div>
		</div>
	);
}

/**
 * The override fields plus the footer that submits them — the split retry
 * button's popup, which offers the plain action as its own separate main button
 * outside this popup.
 *
 * The Recover popup deliberately does *not* use this: there the plain action lives
 * inside the same popup, so a second submit button would be the trap issue #989
 * removed (see {@link recoveryRetryChoiceLabel}).
 */
function RetryOverridePanel({
	run,
	submitLabel,
	onSubmit,
	onCancel,
}: {
	run: RunRow;
	submitLabel: string;
	onSubmit: (overrides: RetryOverrides) => void;
	onCancel?: () => void;
}) {
	const { selection, selectCli, selectModel, selectReasoning } = useOverrideSelection(run);

	return (
		<div className="space-y-3 text-left">
			<RetryOverrideFields
				selection={selection}
				selectCli={selectCli}
				selectModel={selectModel}
				selectReasoning={selectReasoning}
			/>

			<div className="pt-2 flex justify-end gap-2">
				{onCancel && (
					<button
						type="button"
						onClick={onCancel}
						className="px-2.5 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
					>
						Cancel
					</button>
				)}
				<button
					type="button"
					onClick={() => onSubmit(overridesFrom(selection))}
					className={buttonClass('primary', 'sm')}
				>
					{submitLabel}
				</button>
			</div>
		</div>
	);
}

/**
 * Split retry button (issue #153): clicking the main left button retries the run
 * with its existing/preselected settings; clicking the chevron right button opens
 * a popup allowing overrides for the agent CLI and model.
 *
 * The main button's identity tracks the server's retry semantics (issue #227): a
 * `deferred` run that still holds a captured agent session resumes it — a green
 * "Resume" firing the retry path with no overrides (which promotes the pending
 * session-resume job) — while a non-resumable deferred run and a terminally
 * failed run relaunch from scratch as the original violet "Retry now". The
 * override popup is always a fresh retry, so choosing a different CLI/model never
 * masquerades as a resume — except for a `checkpointed` run (issue #503), where the
 * server keeps `recoveryMode: 'checkpoint'` regardless, so an override composes
 * with the continuation instead of replacing it.
 */
function RetryNowButton({ run }: { run: RunRow }) {
	const queryClient = useQueryClient();
	const mutation = useMutation({
		mutationFn: (overrides: RetryOverrides) =>
			trpcClient.runs.retryNow.mutate({
				runId: run.id,
				cli: overrides.cli,
				model: overrides.model,
				reasoning: overrides.reasoning,
			}),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: trpc.runs.getById.queryKey({ id: run.id }) });
			queryClient.invalidateQueries({ queryKey: trpc.runs.list.queryKey() });
		},
	});

	const [isOpen, setIsOpen] = useState(false);

	// A resumable run continues its captured CLI session (green "Resume"); a
	// checkpointed one continues from its written hand-off (green "Continue now"); a
	// blocked run rechecks its protected worktree first ("Recheck and retry");
	// everything else relaunches from scratch (violet "Retry now"). All four
	// fire the same unchanged mutation — the label only reflects server intent.
	const kind = retryActionKind(run.status, run.agentSessionId, run.recovery);
	const palette = retrySplitPalette(kind);

	return (
		<div className="mt-3">
			<div className={`relative inline-flex items-stretch rounded-md shadow-lg ${palette.wrapper}`}>
				<RetrySplitButton
					kind={kind}
					palette={palette}
					isPending={mutation.isPending}
					onPrimary={() => mutation.mutate({})}
					onToggle={() => setIsOpen(!isOpen)}
				/>

				{/* Popup */}
				{isOpen && (
					<>
						{/* Click-outside backdrop */}
						<button
							type="button"
							className="fixed inset-0 z-40 cursor-default focus:outline-none"
							onClick={() => setIsOpen(false)}
							aria-label="Close options"
						/>

						{/* The actual popover */}
						<div className="absolute left-0 top-full mt-2 z-50 w-72 bg-zinc-900 border border-zinc-850 rounded-lg shadow-2xl p-4 animate-in fade-in slide-in-from-top-2 duration-150">
							<RetryOverrideHeading kind={kind} />

							<RetryOverridePanel
								run={run}
								submitLabel={retryOverrideActionLabel(kind)}
								onCancel={() => setIsOpen(false)}
								onSubmit={(overrides) => {
									mutation.mutate(overrides);
									setIsOpen(false);
								}}
							/>
						</div>
					</>
				)}
			</div>
			{mutation.isError && (
				<div className="mt-2 p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
					{mutation.error.message}
				</div>
			)}
		</div>
	);
}

/**
 * The explanation a disabled Terminate / Reset & restart button carries while its
 * request is outstanding (issue #561). The button label names the wait; this says
 * what has to happen before it takes effect — which is the difference between a
 * slow action reading as "waiting" and reading as "broken".
 *
 * The amber caution hue is the same one the deferred callout uses
 * (`ai/DESIGN_SYSTEM.md`): the run is fine, it just isn't there yet. Timestamps
 * are formatted here rather than in the pure helpers, exactly as the
 * deferred/checkpointed callouts already format `nextRetryAt`.
 */
function PendingRequestNotice({
	request,
	explanation,
}: {
	request: PendingRunRequest;
	explanation: string;
}) {
	return (
		<div className="mt-2 p-2.5 bg-amber-950/20 border border-amber-900/30 rounded">
			<p className="text-xs text-amber-200/80">{explanation}</p>
			{request.requestedAt && (
				<p className="text-xs text-amber-200/60 mt-1 font-mono">
					Requested {new Date(request.requestedAt).toLocaleString()}
				</p>
			)}
			{request.waitUntil && (
				<p className="text-xs text-amber-200/60 mt-1 font-mono">
					Agent timeout {new Date(request.waitUntil).toLocaleString()} (
					{formatPendingRequestWaitUntil(request.waitUntil)})
				</p>
			)}
		</div>
	);
}

/**
 * "Terminate" action (issue #166) for a running or deferred run: a click opens a
 * confirmation modal (an intentional stop that can't be undone), and confirming
 * fires the `runs.terminate` mutation. The button carries its own pending state
 * so a double-click can't fire twice; the mutation is idempotent server-side.
 *
 * Once a request is *accepted* the button stays disabled and relabelled until the
 * run settles (issue #561), driven by the run-scoped `pendingRequest` the server
 * resolves rather than by this mutation's own lifetime — the two differ by the
 * whole period the worker takes to notice the cancellation and unwind, which is
 * where the button used to snap back to `Terminate` having visibly done nothing.
 */
function TerminateRunButton({ run }: { run: RunRow }) {
	const queryClient = useQueryClient();
	const [confirmOpen, setConfirmOpen] = useState(false);
	const mutation = useMutation({
		mutationFn: () => trpcClient.runs.terminate.mutate({ runId: run.id }),
		// The detail refetch is awaited so the mutation stays pending until the run
		// carries its `pendingRequest` (issue #561): otherwise the label flashes back
		// to "Terminate" for the width of that round-trip, which is the exact
		// "it did nothing" reading this change exists to remove.
		onSuccess: async () => {
			setConfirmOpen(false);
			queryClient.invalidateQueries({ queryKey: trpc.runs.list.queryKey() });
			await queryClient.invalidateQueries({
				queryKey: trpc.runs.getById.queryKey({ id: run.id }),
			});
		},
	});
	const outstanding = run.pendingRequest?.action === 'terminate' ? run.pendingRequest : null;
	const blocked = mutation.isPending || outstanding !== null;

	return (
		<div className="mt-3">
			<button
				type="button"
				onClick={() => setConfirmOpen(true)}
				disabled={blocked}
				className={buttonClass('dangerOutline')}
			>
				{outstanding ? (
					<Loader2 className="h-4 w-4 animate-spin" />
				) : (
					<OctagonX className={`h-4 w-4 ${mutation.isPending ? 'animate-pulse' : ''}`} />
				)}
				{terminateButtonLabel(mutation.isPending, outstanding !== null)}
			</button>

			{outstanding && (
				<PendingRequestNotice
					request={outstanding}
					explanation={describeTerminateWait(outstanding.waitUntil !== null)}
				/>
			)}

			<Modal
				open={confirmOpen}
				onClose={() => {
					if (!mutation.isPending) setConfirmOpen(false);
				}}
				title="Terminate run?"
			>
				<p className="text-sm text-zinc-300">{terminateConfirmMessage(run.status)}</p>
				{mutation.isError && (
					<div className="mt-3 p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
						{mutation.error.message}
					</div>
				)}
				<ModalFooter
					primary={
						// Guarded on the accepted request too, so a modal left open across a
						// refetch can't record the same intent a second time.
						<button
							type="button"
							onClick={() => mutation.mutate()}
							disabled={blocked}
							className={buttonClass('danger', 'sm')}
						>
							{blocked && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
							{terminateButtonLabel(mutation.isPending, outstanding !== null)}
						</button>
					}
					secondary={
						<button
							type="button"
							onClick={() => setConfirmOpen(false)}
							disabled={mutation.isPending}
							className="px-3 py-1.5 text-xs font-medium text-zinc-300 hover:text-zinc-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
						>
							Cancel
						</button>
					}
				/>
			</Modal>
		</div>
	);
}

/**
 * The "Reset & restart" confirmation, extracted from `ResetRunButton` (issue
 * #593) so the unified Recover control confirms exactly the same way rather than
 * re-stating the copy: the step-by-step message the run's own state shapes, and
 * the refusal message the server returns.
 *
 * It confirms but no longer *offers a choice* (issue #744). A reset always
 * discards, so the opt-in checkbox that used to map to the destructive `force`
 * variant is gone and its warning is stated instead: the checkout is destroyed
 * with any uncommitted and unpushed work in it, and a just-claimed dispatch is
 * cancelled.
 *
 * `blocked` guards the confirm separately from `isPending`, so a modal left open
 * across a background refetch that surfaces an accepted restart can't queue a
 * second one.
 */
function ResetConfirmModal({
	run,
	open,
	onClose,
	onConfirm,
	isPending,
	blocked,
	errorMessage,
	confirmLabel,
}: {
	run: RunRow;
	open: boolean;
	onClose: () => void;
	onConfirm: () => void;
	isPending: boolean;
	blocked: boolean;
	errorMessage?: string;
	confirmLabel: string;
}) {
	return (
		<Modal
			open={open}
			onClose={() => {
				if (!isPending) onClose();
			}}
			title="Reset & restart run?"
		>
			<p className="text-sm text-zinc-300">
				{resetConfirmMessage(
					run.status,
					// Named only while the work is still there to lose: an already
					// abandoned record must not read as a second warning.
					run.preservedWorker?.state === 'preserved'
						? preservedWorkerLabel(run.preservedWorker)
						: null,
				)}
			</p>

			{errorMessage && (
				<div className="mt-3 p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
					{errorMessage}
				</div>
			)}
			<ModalFooter
				primary={
					// Guarded on the accepted restart too, so a modal left open across a
					// refetch can't queue a second one.
					<button
						type="button"
						onClick={onConfirm}
						disabled={blocked}
						className={buttonClass('danger', 'sm')}
					>
						{blocked && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
						{confirmLabel}
					</button>
				}
				secondary={
					<button
						type="button"
						onClick={onClose}
						disabled={isPending}
						className="px-3 py-1.5 text-xs font-medium text-zinc-300 hover:text-zinc-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
					>
						Cancel
					</button>
				}
			/>
		</Modal>
	);
}

/**
 * "Reset & restart" action (issue #428) for a wedged `failed`/`deferred` run —
 * the last resort when neither "Retry now" nor "Terminate" can move it because
 * its dispatch, cancellation flag, worktree lease, and recovery record disagree.
 * The modal names every step `runs.reset` performs and states what the reset
 * destroys — since issue #744 there is nothing to opt into; success renders the
 * per-step report the mutation returns, so an operator can tell a reset that
 * freed the checkout from one that restarted the run but left the checkout for
 * the holding worker to clear. Pending state disables both the trigger and the
 * confirm button so a double-click can't fire two resets.
 *
 * That guard extends past the mutation itself (issue #561): `runs.reset` returns
 * as soon as the replacement dispatch exists, while the run row keeps its old
 * `failed`/`deferred`/`checkpointed` status until a worker claims it — so the
 * button stays disabled and relabelled for as long as the server reports the
 * restart outstanding, rather than inviting a second one.
 */
export function ResetRunButton({
	run,
	onResetSuccess,
}: {
	run: RunRow;
	onResetSuccess?: (report: ResetRunReport) => void;
}) {
	const queryClient = useQueryClient();
	const [confirmOpen, setConfirmOpen] = useState(false);

	const closeConfirm = () => setConfirmOpen(false);

	const mutation = useMutation({
		mutationFn: () => trpcClient.runs.reset.mutate({ runId: run.id }),
		// The detail refetch is awaited for the same reason Terminate's is (issue #561):
		// the row's status doesn't change here at all, so without it the button reads
		// "Reset & restart" again before the queued restart becomes visible.
		onSuccess: async (data) => {
			closeConfirm();
			onResetSuccess?.(data);
			queryClient.invalidateQueries({ queryKey: trpc.runs.list.queryKey() });
			await queryClient.invalidateQueries({
				queryKey: trpc.runs.getById.queryKey({ id: run.id }),
			});
		},
	});
	const outstanding = run.pendingRequest?.action === 'restart' ? run.pendingRequest : null;
	const blocked = mutation.isPending || outstanding !== null;

	return (
		<div className="mt-3">
			<button
				type="button"
				onClick={() => {
					// Drop any previous report/error so the modal opens on a clean slate.
					mutation.reset();
					setConfirmOpen(true);
				}}
				disabled={blocked}
				className={buttonClass('dangerOutline')}
			>
				<RotateCcw className={`h-4 w-4 ${blocked ? 'animate-spin' : ''}`} />
				{resetButtonLabel(mutation.isPending, outstanding !== null)}
			</button>

			{outstanding && (
				<PendingRequestNotice request={outstanding} explanation={describeRestartWait()} />
			)}

			{mutation.isSuccess && !onResetSuccess && (
				<div className="mt-2 p-3 bg-zinc-900/50 border border-zinc-800 rounded">
					<h4 className="text-xs font-semibold text-zinc-200">Reset complete</h4>
					<ul className="mt-1.5 space-y-1 text-xs text-zinc-400">
						{describeResetResult(mutation.data).map((line) => (
							<li key={line}>{line}</li>
						))}
					</ul>
				</div>
			)}

			{mutation.isError && !confirmOpen && (
				<div className="mt-2 p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
					{mutation.error.message}
				</div>
			)}

			<ResetConfirmModal
				run={run}
				open={confirmOpen}
				onClose={closeConfirm}
				onConfirm={() => mutation.mutate()}
				isPending={mutation.isPending}
				blocked={blocked}
				errorMessage={mutation.isError ? mutation.error.message : undefined}
				confirmLabel={resetButtonLabel(mutation.isPending, outstanding !== null)}
			/>
		</div>
	);
}

/**
 * The Recover popup's contents (issue #593): one full-width entry per eligible
 * recovery choice — the retry-family action under its own server-derived label
 * and hue, and "Reset & restart", which picks up its existing confirmation
 * instead of submitting here — followed by the override fields a retry can carry.
 *
 * The retry entry *is* the override fields' submit (issue #989). It used to be a
 * plain retry with its own quiet "Retry with these settings" button under the
 * fields, which meant the popup's one prominent button silently discarded a
 * selection the operator had just made: run 9865ce7a-… was re-dispatched on the
 * very model it had just failed on, its rebuilt payload carrying no
 * `modelOverride` at all. So the fields now drive the button — it submits them
 * once one is edited, and names itself so before it is clicked — and there is no
 * second button to miss. Untouched fields still submit *nothing*, which is what
 * keeps "Resume" a resume rather than a fresh start.
 *
 * Every submit is guarded by `blocked`, so a popup left open across a background
 * refetch that surfaces an accepted request cannot fire the alternate action.
 */
function RecoveryOptionsPopup({
	run,
	choices,
	blocked,
	onRetry,
	onReset,
	onClose,
}: {
	run: RunRow;
	choices: RecoveryChoices;
	blocked: boolean;
	onRetry: (overrides: RetryOverrides) => void;
	onReset: () => void;
	onClose: () => void;
}) {
	const kind = choices.retry;
	const { selection, changed, selectCli, selectModel, selectReasoning } = useOverrideSelection(run);

	return (
		<>
			{/* Click-outside backdrop */}
			<button
				type="button"
				className="fixed inset-0 z-40 cursor-default focus:outline-none"
				onClick={onClose}
				aria-label="Close recovery options"
			/>

			{/* The actual popover */}
			<div className="absolute left-0 top-full mt-2 z-50 w-80 bg-zinc-900 border border-zinc-850 rounded-lg shadow-2xl p-4 animate-in fade-in slide-in-from-top-2 duration-150">
				<h4 className="text-xs font-semibold text-zinc-300 tracking-wide uppercase mb-3">
					Recovery actions
				</h4>

				<div className="space-y-2">
					{kind && (
						<button
							type="button"
							// An untouched selection submits no overrides at all: the server reads
							// any of the three as "start fresh", which would quietly turn a
							// resume or a preserved-checkout adoption into a restart.
							onClick={() => onRetry(changed ? overridesFrom(selection) : {})}
							disabled={blocked}
							className={`w-full inline-flex items-center gap-2 px-3 py-2 text-sm font-semibold text-white rounded-md focus:outline-none focus:ring-1 focus:ring-offset-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer ${retrySplitPalette(carriesPriorWorkWith(kind, changed) ? kind : 'retry').main}`}
						>
							{carriesPriorWorkWith(kind, changed) ? (
								<Play className="h-4 w-4" />
							) : (
								<RefreshCw className="h-4 w-4" />
							)}
							{recoveryRetryChoiceLabel(kind, changed)}
						</button>
					)}

					{choices.reset && (
						// Reset keeps its own confirmation: picking it here closes the popup
						// and opens that modal, so the confirm click is what actually submits.
						<button
							type="button"
							onClick={onReset}
							disabled={blocked}
							className={`${buttonClass('dangerOutline')} w-full justify-center`}
						>
							<RotateCcw className="h-4 w-4" />
							{resetButtonLabel(false)}
						</button>
					)}
				</div>

				{kind && (
					<div className="mt-4 pt-4 border-t border-zinc-850">
						<RetryOverrideHeading kind={kind} />
						<RetryOverrideFields
							selection={selection}
							selectCli={selectCli}
							selectModel={selectModel}
							selectReasoning={selectReasoning}
						/>
					</div>
				)}

				<div className="pt-3 flex justify-end">
					<button
						type="button"
						onClick={onClose}
						className="px-2.5 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
					>
						Cancel
					</button>
				</div>
			</div>
		</>
	);
}

/**
 * The single "Recover" control an errored run exposes (issue #593).
 *
 * Retry and "Reset & restart" are two ways to recover the *same* errored run, and
 * as two live buttons both could be submitted while the first was still
 * unresolved — two competing recovery requests against one row, with nothing on
 * the page saying which was in progress. This consolidates them: one trigger
 * opens a popup carrying whichever choices are currently eligible (each with its
 * own label, hue, and confirmation), choosing one closes the popup and submits
 * only that action, and the trigger then becomes a disabled status label naming
 * the choice in flight until it resolves.
 *
 * Mutual exclusion is not this component's local state alone. Both choices record
 * the same durable `manual-retry` dispatch, so `runs.getById` reports either as
 * one outstanding `restart` request (issue #561) — which is what makes the
 * disabled state identical for a second viewer and across a reload, rather than
 * protecting only the browser that clicked. The local mutation state adds only
 * what the durable fact cannot say: *which* of the two choices this operator
 * picked, so the label can name it during the HTTP round-trip.
 *
 * Deliberately scoped to the error-recovery states: `deferred` and `checkpointed`
 * runs have not ended in an error — one waits on a scheduled retry, the other on
 * a scheduled continuation — and keep their side-by-side controls.
 */
export function RecoverRunButton({
	run,
	onResetSuccess,
}: {
	run: RunRow;
	onResetSuccess?: (report: ResetRunReport) => void;
}) {
	const queryClient = useQueryClient();
	const [isOpen, setIsOpen] = useState(false);
	const [confirmOpen, setConfirmOpen] = useState(false);

	const closeConfirm = () => setConfirmOpen(false);

	// The detail refetch is awaited for the reason issue #561 documents on
	// Terminate/Reset: each mutation returns as soon as the replacement dispatch
	// exists, so without it the trigger reads "Recover" again before the queued
	// restart becomes visible — the "it did nothing" reading that invited the
	// second, competing request in the first place.
	const refreshRun = async () => {
		queryClient.invalidateQueries({ queryKey: trpc.runs.list.queryKey() });
		await queryClient.invalidateQueries({
			queryKey: trpc.runs.getById.queryKey({ id: run.id }),
		});
	};

	const retryMutation = useMutation({
		mutationFn: (overrides: RetryOverrides) =>
			trpcClient.runs.retryNow.mutate({
				runId: run.id,
				cli: overrides.cli,
				model: overrides.model,
				reasoning: overrides.reasoning,
			}),
		onSuccess: refreshRun,
	});

	const resetMutation = useMutation({
		mutationFn: () => trpcClient.runs.reset.mutate({ runId: run.id }),
		onSuccess: async (data) => {
			closeConfirm();
			onResetSuccess?.(data);
			await refreshRun();
		},
	});

	const choices = recoveryChoices(run);
	if (!canRecoverRun(choices)) return null;

	const outstanding = run.pendingRequest?.action === 'restart' ? run.pendingRequest : null;
	const pending: RecoveryPending = resetMutation.isPending
		? 'reset'
		: retryMutation.isPending
			? 'retry'
			: null;
	// One flag for both choices: whichever one is in flight (or already accepted)
	// blocks the trigger *and* every submit inside a popup left open across a
	// background refetch, so no alternate recovery action can be submitted.
	const blocked = pending !== null || outstanding !== null;

	return (
		<div className="mt-3">
			<div className="relative inline-flex">
				<button
					type="button"
					onClick={() => {
						// Drop any previous report/error so the popup opens on a clean slate.
						retryMutation.reset();
						resetMutation.reset();
						setIsOpen(!isOpen);
					}}
					disabled={blocked}
					className={buttonClass('primary')}
				>
					{blocked ? (
						<Loader2 className="h-4 w-4 animate-spin" />
					) : (
						<LifeBuoy className="h-4 w-4" />
					)}
					{recoverButtonLabel(choices, pending, outstanding !== null)}
					{!blocked && <ChevronDown className="h-4 w-4" />}
				</button>

				{isOpen && (
					<RecoveryOptionsPopup
						run={run}
						choices={choices}
						blocked={blocked}
						onRetry={(overrides) => {
							setIsOpen(false);
							retryMutation.mutate(overrides);
						}}
						onReset={() => {
							setIsOpen(false);
							setConfirmOpen(true);
						}}
						onClose={() => setIsOpen(false)}
					/>
				)}
			</div>

			{outstanding && (
				<PendingRequestNotice request={outstanding} explanation={describeRestartWait()} />
			)}

			{resetMutation.isSuccess && !onResetSuccess && (
				<div className="mt-2 p-3 bg-zinc-900/50 border border-zinc-800 rounded">
					<h4 className="text-xs font-semibold text-zinc-200">Reset complete</h4>
					<ul className="mt-1.5 space-y-1 text-xs text-zinc-400">
						{describeResetResult(resetMutation.data).map((line) => (
							<li key={line}>{line}</li>
						))}
					</ul>
				</div>
			)}

			{retryMutation.isError && (
				<div className="mt-2 p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
					{retryMutation.error.message}
				</div>
			)}

			{resetMutation.isError && !confirmOpen && (
				<div className="mt-2 p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
					{resetMutation.error.message}
				</div>
			)}

			<ResetConfirmModal
				run={run}
				open={confirmOpen}
				onClose={closeConfirm}
				onConfirm={() => resetMutation.mutate()}
				isPending={resetMutation.isPending}
				blocked={blocked}
				errorMessage={resetMutation.isError ? resetMutation.error.message : undefined}
				confirmLabel={resetButtonLabel(resetMutation.isPending, outstanding !== null)}
			/>
		</div>
	);
}

/**
 * "Force re-review" action (issue #511) for a completed Review run the
 * review-verdict safety cap stopped — the run-level recovery for the one state
 * SWARM deliberately leaves for a human, rendered inside the same "Manual action
 * required" callout that explains it.
 *
 * Deliberately built to the "Reset & restart" pattern above (`ResetRunButton`),
 * because that is the established operator-facing shape for a run-recovery
 * action: the same red-tinted trigger, a confirmation modal naming what the
 * mutation actually does, pending state disabling both the trigger and the
 * confirm button so a double-click can't fire twice, a per-step success report,
 * and the mutation error surfaced verbatim. The server is idempotent regardless
 * (`src/dispatch/force-re-review.ts`), so a concurrent request resolves to the
 * same corrective cycle rather than a second one — and if that cycle's prior
 * attempt turns out to have been dead (never actually started Respond-to-review),
 * the server chains a fresh one rather than reporting the dead one as done.
 *
 * One component serves both cap callouts (issue #1040). The mutation is the same
 * either way — the server decides which continuation the run's shape calls for —
 * so the only thing that varies is the promise the modal makes, which the caller
 * supplies as `confirmMessage`. The result lines then describe whichever
 * continuation actually ran, off the report's own `continuation`.
 */
export function ForceReReviewButton({
	run,
	confirmMessage,
}: {
	run: RunRow;
	confirmMessage: string;
}) {
	const queryClient = useQueryClient();
	const [confirmOpen, setConfirmOpen] = useState(false);

	const mutation = useMutation({
		mutationFn: () => trpcClient.runs.forceReReview.mutate({ runId: run.id }),
		onSuccess: () => {
			setConfirmOpen(false);
			// Refresh to the authoritative state: the run row and the runs list both
			// change once the corrective dispatch exists.
			queryClient.invalidateQueries({ queryKey: trpc.runs.getById.queryKey({ id: run.id }) });
			queryClient.invalidateQueries({ queryKey: trpc.runs.list.queryKey() });
		},
	});

	return (
		<div className="mt-3">
			<button
				type="button"
				onClick={() => {
					// Drop any previous report/error so the modal opens on a clean slate.
					mutation.reset();
					setConfirmOpen(true);
				}}
				disabled={mutation.isPending}
				className={buttonClass('dangerOutline')}
			>
				<RefreshCw className={`h-4 w-4 ${mutation.isPending ? 'animate-spin' : ''}`} />
				{forceReReviewButtonLabel(mutation.isPending)}
			</button>

			{mutation.isSuccess && (
				<div className="mt-2 p-3 bg-zinc-900/50 border border-zinc-800 rounded">
					<h4 className="text-xs font-semibold text-zinc-200">Re-review scheduled</h4>
					<ul className="mt-1.5 space-y-1 text-xs text-zinc-400">
						{describeForceReReviewResult(mutation.data).map((line) => (
							<li key={line}>{line}</li>
						))}
					</ul>
				</div>
			)}

			{mutation.isError && !confirmOpen && (
				<div className="mt-2 p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
					{mutation.error.message}
				</div>
			)}

			<Modal
				open={confirmOpen}
				onClose={() => {
					if (!mutation.isPending) setConfirmOpen(false);
				}}
				title="Force re-review?"
			>
				<p className="text-sm text-zinc-300">{confirmMessage}</p>
				{mutation.isError && (
					<div className="mt-3 p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
						{mutation.error.message}
					</div>
				)}
				<ModalFooter
					primary={
						<button
							type="button"
							onClick={() => mutation.mutate()}
							disabled={mutation.isPending}
							className={buttonClass('danger', 'sm')}
						>
							{mutation.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
							{forceReReviewButtonLabel(mutation.isPending)}
						</button>
					}
					secondary={
						<button
							type="button"
							onClick={() => setConfirmOpen(false)}
							disabled={mutation.isPending}
							className="px-3 py-1.5 text-xs font-medium text-zinc-300 hover:text-zinc-100 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
						>
							Cancel
						</button>
					}
				/>
			</Modal>
		</div>
	);
}

/**
 * Where this run's preserved checkout is, and what that means (issue #567).
 *
 * A run pinned to a machine waits for it **without a timeout**, so this callout is
 * what stops that wait reading as a wedged run: it names the machine, says the wait
 * does not expire, and names the action that ends it. It renders for every viewer
 * off a server-resolved field, not off the local operator's mutation state.
 */
export function PreservedWorkerCallout({ run }: { run: RunRow }) {
	const described = describePreservedWorker(run.preservedWorker);
	if (!described) return null;
	const abandoned = run.preservedWorker?.state === 'abandoned';
	return (
		<div
			className={
				abandoned
					? 'p-4 bg-zinc-900/40 border border-zinc-800 rounded flex items-start gap-3'
					: 'p-4 bg-sky-950/20 border border-sky-900/30 rounded flex items-start gap-3'
			}
		>
			<Server
				className={`h-5 w-5 shrink-0 mt-0.5 ${abandoned ? 'text-zinc-400' : 'text-sky-400'}`}
			/>
			<div>
				<h3 className={`text-xs font-semibold ${abandoned ? 'text-zinc-200' : 'text-sky-200'}`}>
					{described.title}
				</h3>
				<p className={`text-xs mt-1 ${abandoned ? 'text-zinc-400' : 'text-sky-200/70'}`}>
					{described.body}
				</p>
			</div>
		</div>
	);
}

interface RecoveryCalloutProps {
	run: RunRow;
}

export function RecoveryCallout({ run }: RecoveryCalloutProps) {
	if (!run.recovery) return null;

	const { state, blockedReason } = run.recovery;

	if (state === 'preserved') {
		return (
			<div className="p-4 bg-emerald-950/20 border border-emerald-900/30 rounded flex items-start gap-3">
				<CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0 mt-0.5" />
				<div>
					<h3 className="text-xs font-semibold text-emerald-200">Worktree preserved</h3>
					<p className="text-xs text-emerald-400/80 mt-1">
						The workspace files and agent session have been preserved. You can resume this run to
						continue where it left off, or retry it with overrides to start a fresh session.
					</p>
				</div>
			</div>
		);
	}

	if (state === 'blocked') {
		// Reason-specific guidance (issue #368): what condition kept the checkout
		// protected and what the operator must resolve. Once resolved, the retry
		// button below ("Recheck and retry") re-runs the server's provisioning gate,
		// which reclaims the checkout or leaves the refreshed run blocked — the
		// mutation payload is unchanged, so all the safety stays server-side.
		const { condition, resolution } = ((): { condition: string; resolution: string } => {
			switch (blockedReason) {
				case 'dirty':
					return {
						condition:
							"This run's worktree has uncommitted changes, so SWARM kept it instead of reclaiming it.",
						resolution:
							'Commit, stash, or discard those changes in the checkout, then use "Recheck and retry".',
					};
				case 'unpushed':
					return {
						condition:
							"This run's worktree has commits that were never pushed, so SWARM kept it to avoid losing work.",
						resolution: 'Push or discard those commits, then use "Recheck and retry".',
					};
				case 'live-leased':
					return {
						condition:
							"This run's worktree is leased by another active run, so it can't be reclaimed yet.",
						resolution:
							'Wait for that run to finish or terminate it, then use "Recheck and retry".',
					};
				case 'resumable-owner':
					return {
						condition:
							"This run's worktree is pinned by another resumable run, so it can't be reclaimed yet.",
						resolution:
							'Resume, finish, or deliberately terminate/clear that recovery, then use "Recheck and retry".',
					};
				case 'missing-validation':
					return {
						condition:
							"The preserved checkout or its saved agent session is gone, so this run can't be resumed.",
						resolution: 'Use "Recheck and retry" to provision a fresh checkout and start over.',
					};
				case 'checkpoint-divergent':
					// Issue #502's block: the continuation gate compared the checkpoint
					// against the checkout and refused it, so there is nothing safe to
					// continue *from* — unlike the reasons above, waiting or tidying the
					// checkout doesn't restore the hand-off it describes. The run's own
					// error names the specific mismatch (wrong phase, or the paths the
					// working tree no longer changes).
					return {
						condition:
							"This run's checkpoint no longer describes the checkout it was going to continue from, so SWARM refused to continue rather than work against a tree it can't account for.",
						resolution:
							'The error above names the mismatch. Use "Recheck and retry" to start this phase over from a fresh checkout — the recorded remainder can\'t be picked up.',
					};
				default:
					return {
						condition: "This run's worktree failed a safety check, so SWARM kept it protected.",
						resolution: 'Resolve the condition on the checkout, then use "Recheck and retry".',
					};
			}
		})();

		return (
			<div className="p-4 bg-red-950/20 border border-red-900/30 rounded flex items-start gap-3">
				<AlertTriangle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
				<div>
					<h3 className="text-xs font-semibold text-red-200">Recovery Blocked</h3>
					<p className="text-xs text-red-400/80 mt-1">{condition}</p>
					<p className="text-xs text-red-400/80 mt-2">{resolution}</p>
				</div>
			</div>
		);
	}

	if (state === 'recovered') {
		return (
			<div className="p-4 bg-blue-950/20 border border-blue-900/30 rounded flex items-start gap-3">
				<Info className="h-5 w-5 text-blue-400 shrink-0 mt-0.5" />
				<div>
					<h3 className="text-xs font-semibold text-blue-200">Successfully Recovered</h3>
					<p className="text-xs text-blue-400/80 mt-1">
						This run was successfully recovered and resumed from a previous preserved state.
					</p>
				</div>
			</div>
		);
	}

	return null;
}

/**
 * How much of the Tier 2 continuation budget this run has spent (issue #504).
 * `maxContinuations` is resolved server-side (`runs.getById`), so the ceiling is
 * the project's real `pipeline.maxContinuations` rather than a default re-declared
 * here that could drift — and when the server couldn't resolve it, the spent count
 * is reported alone instead of against a fabricated ceiling.
 */
function describeContinuationBudget(count: number, max: number | null | undefined): string {
	return typeof max === 'number' ? `Continuation ${count} of ${max}` : `Continuation ${count}`;
}

/** One labelled group of checkpoint lines; renders nothing when the group is empty. */
function CheckpointList({
	label,
	items,
	ordered = false,
	mono = false,
}: {
	label: string;
	items: string[];
	/** Numbered, for the remainder — its order is the order a continuation works in. */
	ordered?: boolean;
	/** For repository paths, per `ai/DESIGN_SYSTEM.md` §2: machine values are mono. */
	mono?: boolean;
}) {
	if (items.length === 0) return null;

	const itemClass = mono ? 'font-mono break-all' : '';
	const occurrences = new Map<string, number>();
	const keyedItems = items.map((item) => {
		const occurrence = occurrences.get(item) ?? 0;
		occurrences.set(item, occurrence + 1);
		return { item, key: `${item}-${occurrence}` };
	});
	return (
		<div>
			<span className="block text-xs font-medium text-zinc-400">{label}</span>
			{ordered ? (
				<ol className="mt-1.5 space-y-1 list-decimal list-inside text-xs text-zinc-300">
					{keyedItems.map(({ item, key }) => (
						<li key={key} className={itemClass}>
							{item}
						</li>
					))}
				</ol>
			) : (
				<ul className="mt-1.5 space-y-1 list-disc list-inside text-xs text-zinc-400">
					{keyedItems.map(({ item, key }) => (
						<li key={key} className={itemClass}>
							{item}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}

/**
 * The Tier 2 checkpoint hand-off a stopped run recorded (`docs/CHECKPOINTS.md`,
 * issues #503/#504): the remainder a continuation picks up, what is already done
 * and must not be re-derived, the settled decisions, and the working tree the
 * checkpoint claims it left behind — read off the persisted `checkpoint` column,
 * never a worker's filesystem, so it renders for a remote worker's run too.
 *
 * Gated on the checkpoint's *presence* rather than on `status === 'checkpointed'`,
 * because the column survives an ordinary retry as the record of what the current
 * attempt was seeded from: an operator watching a running continuation, or
 * diagnosing one that then failed, needs exactly this. The spent continuation
 * count rides here so the state and its budget are read in one place.
 *
 * Remaining work leads, and is numbered — its order is the order a continuation
 * works in.
 */
export function CheckpointPanel({ run }: { run: RunRow }) {
	const { checkpoint } = run;
	if (!checkpoint) return null;

	const { modified, added, deleted } = checkpoint.workingTree;
	const count = run.continuationCount ?? 0;

	return (
		<div className="p-4 border border-zinc-800 rounded-lg bg-panel/20 shadow-sm">
			<div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-2">
				<h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-200">
					<ListChecks className="h-4 w-4 text-sky-400" />
					Checkpoint hand-off
				</h3>
				{count > 0 && (
					<span className="text-xs font-medium text-zinc-400">
						{describeContinuationBudget(count, run.maxContinuations)}
					</span>
				)}
			</div>

			<div className="mt-4 space-y-4">
				<CheckpointList label="Remaining work" items={checkpoint.remaining} ordered />
				<CheckpointList label="Already completed" items={checkpoint.completed} />
				<CheckpointList label="Decisions carried over" items={checkpoint.decisions} />
				<div>
					<span className="block text-xs font-medium text-zinc-400">Working tree it recorded</span>
					{/* Indented rather than re-labelled: the three change kinds are one
					    group under the heading above, not three peers of it. */}
					<div className="mt-1.5 pl-3 border-l border-zinc-800/60 space-y-2">
						<CheckpointList label="Modified" items={modified} mono />
						<CheckpointList label="Added" items={added} mono />
						<CheckpointList label="Deleted" items={deleted} mono />
					</div>
				</div>
			</div>
		</div>
	);
}

interface CheckpointedCalloutProps {
	run: RunRow;
	onResetSuccess: (report: ResetRunReport) => void;
}

/** Status-specific recovery controls for a run awaiting a checkpoint continuation. */
export function CheckpointedCallout({ run, onResetSuccess }: CheckpointedCalloutProps) {
	return (
		<div className="p-4 bg-sky-950/20 border border-sky-900/30 rounded flex items-start gap-3">
			<PauseCircle className="h-5 w-5 text-sky-400 shrink-0 mt-0.5" />
			<div>
				<h3 className="text-xs font-semibold text-sky-200">
					Checkpointed — continuation scheduled
				</h3>
				<p className="text-xs text-sky-200/70 mt-1">
					This run stopped before finishing and left a checkpoint. Its checkout is preserved, and a
					continuation will start a fresh agent session from the remaining work recorded below. It
					is not waiting on quota.
				</p>
				{run.error && (
					<p className="text-xs text-sky-200/70 mt-2 font-mono whitespace-pre-wrap">
						{normalizeRunError(run.error)}
					</p>
				)}
				{run.nextRetryAt && (
					<>
						<p className="text-xs text-sky-200/70 mt-2 font-mono">
							{new Date(run.nextRetryAt).toLocaleString()} ({formatTimeUntil(run.nextRetryAt)})
						</p>
						<p className="text-xs text-sky-200/70 mt-1 font-mono">
							UTC: {new Date(run.nextRetryAt).toISOString()}
						</p>
					</>
				)}
				<div className="flex flex-wrap items-start gap-3">
					{canRetryRun(run.status) && <RetryNowButton run={run} />}
					{canTerminateRun(run.status) && <TerminateRunButton run={run} />}
					{canResetRun(run.status) && <ResetRunButton run={run} onResetSuccess={onResetSuccess} />}
				</div>
			</div>
		</div>
	);
}

/**
 * The project fields the run header and its callouts still need: the pipeline
 * settings that gate "Force re-review", and nothing else. The repo used to be here
 * too, for the PR links, which now come from `run.repository` (issue #691).
 */
type ReviewCapCalloutProject = {
	pipeline?: {
		respondToReview?: { enabled?: boolean };
		review?: { enabled?: boolean };
	};
} | null;

interface ReviewCapCalloutProps {
	run: RunRow;
	project?: ReviewCapCalloutProject;
}

/**
 * Compact, confidence-labelled recovery guidance for a terminal failure. The
 * technical error remains in the following callout, so operators can act on
 * the diagnosis without losing the provider or harness detail.
 */
export function FailureDiagnosisCallout({ diagnosis }: { diagnosis: FailureDiagnosis | null }) {
	if (!diagnosis) return null;

	return (
		<div className="p-4 bg-amber-950/20 border border-amber-900/30 rounded flex items-start gap-3">
			<AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
			<div>
				<h3 className="text-xs font-semibold text-amber-200">{diagnosis.title}</h3>
				<p className="text-xs text-amber-200/70 mt-1">{diagnosis.message}</p>
				<p className="text-xs text-amber-200/70 mt-2">Recommended recovery: {diagnosis.recovery}</p>
			</div>
		</div>
	);
}

/**
 * Run-detail warning for a completed Review run whose verdict was the last
 * `request-changes` the review-verdict safety cap allows (issue #242): SWARM
 * stopped the automatic Respond-to-review/re-review cycle, so this explains
 * why to the operator and links to the PR that now needs a human decision.
 * A no-op for every other run (wrong status/phase, or no cap outcome).
 *
 * The copy deliberately doesn't name the cap's numeric value — that lives once,
 * in `REVIEW_VERDICT_CAP` (`src/db/repositories/reviewVerdictsRepository.ts`),
 * a DB-bound module the dashboard bundle can't import — so bumping the cap
 * never leaves a stale number here.
 */
export function ReviewCapCallout({ run, project }: ReviewCapCalloutProps) {
	if (!canForceReReview(run)) return null;

	return (
		<div className="p-4 bg-red-950/20 border border-red-900/30 rounded flex items-start gap-3">
			<AlertTriangle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
			<div>
				<h3 className="text-xs font-semibold text-red-200">Manual action required</h3>
				<p className="text-xs text-red-400/80 mt-1">
					This was the last changes-requested verdict SWARM's review safety cap allows
					{run.reviewOrdinal ? ` (review ${run.reviewOrdinal} of this PR)` : ''}. SWARM will not
					automatically enqueue another Respond-to-review or re-review — this PR needs a human
					decision. If that decision is to keep going, "Force re-review" continues the normal
					corrective cycle once.
				</p>
				{run.repository && run.prNumber && (
					<a
						href={`https://github.com/${run.repository}/pull/${run.prNumber}`}
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-1 mt-2 text-red-300 hover:text-red-200 font-mono hover:underline"
					>
						View PR #{run.prNumber}
						<ExternalLink className="h-3 w-3" />
					</a>
				)}
				{canForceReReview(run, project?.pipeline) && (
					<ForceReReviewButton
						run={run}
						confirmMessage={forceReReviewConfirmMessage(run.prNumber)}
					/>
				)}
			</div>
		</div>
	);
}

/**
 * Run-detail warning for the review-cap stop that leaves no run behind (issue
 * #1038): a completed Review run that **approved**, whose approval merge
 * automation then refused, on a pull request whose review allowance is spent.
 * Nothing will dispatch a further review for it on its own — the `pr-review`
 * trigger's cap gate skips with a warn log and creates no run — so without this
 * the operator sees a merge refusal and no sign that nothing will ever fix it.
 *
 * Its sibling {@link ReviewCapCallout} covers the `request-changes` loop (issue
 * #242) and is unchanged; the two never render together, because their verdicts
 * are mutually exclusive.
 *
 * The copy names no cap value, for the reason {@link ReviewCapCallout}'s does
 * not: `REVIEW_VERDICT_CAP` lives once, in a DB-bound module this bundle cannot
 * import. It also names no *cause* for the refusal — `not-eligible` has five,
 * and the merge callout below carries the provider's own message.
 *
 * Since issue #1040 it hosts its own "Force re-review" (the same component and
 * the same mutation as the sibling's, with its own confirmation copy): the
 * continuation this stop needs is one Review of the pull request's *current*
 * head, and the server picks it from the run's shape. The button is gated on
 * Review being enabled for the project; it is still offered when the merge was
 * refused for one of `not-eligible`'s other causes, because only the provider
 * knows whether the head moved and the server answers that with its own
 * `head-unchanged` refusal rather than a read on every render here.
 *
 * It therefore also has a second state. The force's success report is rendered
 * inside this panel, and the ledger fact gating the first state goes false the
 * instant the force records its grant — so the panel would unmount itself one
 * refetch after the click, hiding the dispatch id and reading as "resolved" while
 * the forced review had not started. `reviewCapOverrideOutstanding` carries that
 * window, and the copy says what is actually true in it.
 */
export function CapSpentApprovalCallout({
	run,
	project,
}: {
	run: RunRow;
	project?: ReviewCapCalloutProject;
}) {
	if (!showsCapSpentApprovalCallout(run)) return null;
	// The same panel in its second state: an operator has forced the continuation
	// and the extra slot is granted but unspent, so the review is scheduled and has
	// not started. It stays mounted for that window deliberately — the force's own
	// report is rendered inside it, and unmounting on success would hide the only
	// confirmation the operator gets (and read as "resolved" while nothing has run).
	const forcedReviewPending = isForcedReviewPending(run);

	return (
		<div className="p-4 bg-red-950/20 border border-red-900/30 rounded flex items-start gap-3">
			<AlertTriangle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
			<div>
				<h3 className="text-xs font-semibold text-red-200">
					{forcedReviewPending ? 'Forced review pending' : 'Manual action required'}
				</h3>
				<p className="text-xs text-red-400/80 mt-1">
					{forcedReviewPending ? (
						<>
							This approval was the last review verdict SWARM's review safety cap allows for this
							pull request
							{run.reviewOrdinal ? ` (review ${run.reviewOrdinal} of this PR)` : ''}, and the
							automatic merge did not go through. An operator has already forced the continuation:
							the extra review slot is granted and waiting to be spent, so a review of the pull
							request's current head is scheduled and has not started yet. Forcing again reports
							what is already scheduled rather than starting a second one.
						</>
					) : (
						<>
							This approval was the last review verdict SWARM's review safety cap allows for this
							pull request
							{run.reviewOrdinal ? ` (review ${run.reviewOrdinal} of this PR)` : ''}, and the
							automatic merge did not go through — see the merge result below for the provider's own
							reason. SWARM will not dispatch another review for this pull request on its own, so it
							stays here until a person acts. If that decision is to keep going, "Force re-review"
							reviews the pull request's current head once.
						</>
					)}
				</p>
				{run.repository && run.prNumber && (
					<a
						href={`https://github.com/${run.repository}/pull/${run.prNumber}`}
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-1 mt-2 text-red-300 hover:text-red-200 font-mono hover:underline"
					>
						View PR #{run.prNumber}
						<ExternalLink className="h-3 w-3" />
					</a>
				)}
				{canForceReviewOfSupersededHead(run, project?.pipeline) && (
					<ForceReReviewButton
						run={run}
						confirmMessage={forceReviewOfSupersededHeadConfirmMessage(run.prNumber)}
					/>
				)}
			</div>
		</div>
	);
}

/** Human-readable heading for each terminal (non-merged, non-waiting) merge-automation outcome. */
const MERGE_TERMINAL_LABELS: Record<string, string> = {
	'not-eligible': 'No longer eligible for automatic merge',
	'policy-blocked': 'Blocked by repository policy',
	unsupported: 'Merge automation unsupported',
	'retry-exhausted': 'Automatic merge retry budget exhausted',
	'provider-error-exhausted': 'The source-control provider kept failing the merge',
};

interface ReviewMergeCalloutProps {
	run: RunRow;
}

/**
 * Run-detail callout surfacing the Review phase's provider-neutral merge
 * automation state (issue #278): merged automatically, waiting on a durable
 * retry, a terminal refusal, or retry exhaustion. A no-op when the run never
 * attempted a merge (automation disabled, or the verdict wasn't an approval).
 *
 * It reads the *last recorded* outcome, so `provider-error` — retried on the
 * same bounded budget as `not-ready` since issue #923 — renders as waiting.
 * A pre-#923 row stranded at `provider-error` therefore also reads as retrying;
 * that is the same aliasing `not-ready` has always had, and telling them apart
 * would mean handing this callout the dispatch state it is not given.
 */
export function ReviewMergeCallout({ run }: ReviewMergeCalloutProps) {
	if (run.phase !== 'review' || !run.reviewMergeOutcome) return null;

	const prLink = run.repository && run.prNumber && (
		<a
			href={`https://github.com/${run.repository}/pull/${run.prNumber}`}
			target="_blank"
			rel="noopener noreferrer"
			className="inline-flex items-center gap-1 mt-2 font-mono hover:underline"
		>
			View PR #{run.prNumber}
			<ExternalLink className="h-3 w-3" />
		</a>
	);

	if (run.reviewMergeOutcome === 'merged') {
		return (
			<div className="p-4 bg-emerald-950/20 border border-emerald-900/30 rounded flex items-start gap-3">
				<CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0 mt-0.5" />
				<div>
					<h3 className="text-xs font-semibold text-emerald-200">Merged automatically</h3>
					{run.reviewMergeMessage && (
						<p className="text-xs text-emerald-200/70 mt-1 font-mono whitespace-pre-wrap">
							{run.reviewMergeMessage}
						</p>
					)}
					{prLink && <div className="text-emerald-300 hover:text-emerald-200">{prLink}</div>}
				</div>
			</div>
		);
	}

	if (run.reviewMergeOutcome === 'not-ready' || run.reviewMergeOutcome === 'provider-error') {
		const waitingHeading =
			run.reviewMergeOutcome === 'provider-error'
				? 'Merge automation hit a provider error — retrying automatically'
				: 'Merge automation waiting — retrying automatically';
		return (
			<div className="p-4 bg-amber-950/20 border border-amber-900/30 rounded flex items-start gap-3">
				<AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
				<div>
					<h3 className="text-xs font-semibold text-amber-200">{waitingHeading}</h3>
					{run.reviewMergeMessage && (
						<p className="text-xs text-amber-200/70 mt-1 font-mono whitespace-pre-wrap">
							{run.reviewMergeMessage}
						</p>
					)}
					{prLink && <div className="text-amber-300 hover:text-amber-200">{prLink}</div>}
				</div>
			</div>
		);
	}

	const label =
		MERGE_TERMINAL_LABELS[run.reviewMergeOutcome] ?? 'Merge automation did not complete';
	return (
		<div className="p-4 bg-red-950/20 border border-red-900/30 rounded flex items-start gap-3">
			<AlertTriangle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
			<div>
				<h3 className="text-xs font-semibold text-red-200">{label}</h3>
				{run.reviewMergeMessage && (
					<p className="text-xs text-red-400/80 mt-1 font-mono whitespace-pre-wrap">
						{run.reviewMergeMessage}
					</p>
				)}
				{prLink && <div className="text-red-300 hover:text-red-200">{prLink}</div>}
			</div>
		</div>
	);
}

/**
 * The build a maintenance run is moving its machine to, and the machine's own id —
 * the two halves of the `swarm workers update` command the failure callout offers the
 * operator. Both fall back to a placeholder rather than printing a literal `null`: a
 * half-formed command an operator can paste is worse than one they can see they have
 * to complete.
 */
function maintenanceCommandParts(run: RunRow): { workerId: string; target: string } {
	return {
		workerId: run.attribution?.workerId ?? run.workerId ?? '<worker-id>',
		target: run.maintenanceTarget ?? '<ref>',
	};
}

/**
 * What a `running` maintenance run says in place of the pipeline "Running" callout
 * (issue #974). The pipeline copy is wrong here in every clause — there is no agent
 * to stop and no project slot to free (a maintenance run creates no dispatch) — and
 * its Terminate control offers an action `runs.terminate` refuses outright
 * (`requirePipelineRun`). Same violet "in progress" panel, no buttons: the only way
 * to change an outstanding request is to make another one.
 */
function MaintenanceRunningCallout({ run }: { run: RunRow }) {
	const { target } = maintenanceCommandParts(run);
	const machine = run.attribution?.workerName ?? run.workerName ?? 'This machine';
	return (
		<div className="p-4 bg-violet-950/20 border border-violet-900/30 rounded flex items-start gap-3">
			<Loader2 className="h-5 w-5 text-violet-400 shrink-0 mt-0.5 animate-spin" />
			<div>
				<h3 className="text-xs font-semibold text-violet-200">Update in progress</h3>
				<p className="text-xs text-violet-200/70 mt-1">
					{machine} was asked to move to <span className="font-mono">{target}</span>. It finishes
					any phases already in flight, applies the update, restarts into the new build and reports
					back. Nothing here can stop it; asking again with a different build supersedes this
					request.
				</p>
			</div>
		</div>
	);
}

/**
 * What a `failed` maintenance run says in place of the pipeline failure callout
 * (issue #974). The machine's own prose is the whole diagnosis — it already names
 * the install root, the step that failed, and whether the checkout was returned to
 * the build it was on — so this adds only the one thing the page can't get from it:
 * how to ask again. There is no dashboard control for that today, and the run is a
 * record of one request rather than something retried from here, so the guidance is
 * the CLI command and no `Recover` button.
 *
 * **The guidance is deliberately conditional, and asserts no machine-side cause.**
 * `failed` is not only a machine-reported failure: `supersedeWorkerUpdateRun`
 * (`src/db/repositories/runsRepository.ts`) fails a still-`running` request when the
 * operator re-targets the same machine, which is a routine action this page's own
 * `running` callout advertises. Telling *that* run's reader to fix the machine and
 * re-issue `swarm workers update <id> <this run's target>` would have them supersede
 * their own newer, in-flight request and send the machine back to the build they
 * moved off. Nothing on `RunRow` tells the two apart — the superseded case is carried
 * only in the `error` prose, and the run carries no discriminator column — and
 * matching that prose would key the copy on a server-side message string, so the copy
 * states the condition instead of asserting it and names the supersede consequence
 * beside the command. A durable discriminator is a server-side change, outside this
 * issue's no-server-change boundary; it is noted on #974 rather than taken here.
 */
function MaintenanceFailureCallout({ run, error }: { run: RunRow; error: string }) {
	const { workerId, target } = maintenanceCommandParts(run);
	return (
		<div className="p-4 bg-red-950/20 border border-red-900/30 rounded flex items-start gap-3">
			<AlertTriangle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
			<div>
				<h3 className="text-xs font-semibold text-red-200">Update failed</h3>
				<p className="text-xs text-red-400/80 mt-1 font-mono whitespace-pre-wrap">
					{normalizeRunError(error)}
				</p>
				<p className="text-xs text-red-400/60 mt-2">
					This run is a record of one request and is not retried from here. If this machine still
					needs that build, and the message above is addressed, ask for it again:{' '}
					<span className="font-mono text-red-300">
						swarm workers update {workerId} {target}
					</span>{' '}
					(the machine must be drained first). Asking again supersedes any request for this machine
					still in flight.
				</p>
			</div>
		</div>
	);
}

/** The `running` callout for pipeline work, which is the only kind that has an agent to stop. */
function PipelineRunningCallout({ run }: { run: RunRow }) {
	return (
		<div className="p-4 bg-violet-950/20 border border-violet-900/30 rounded flex items-start gap-3">
			<Loader2 className="h-5 w-5 text-violet-400 shrink-0 mt-0.5 animate-spin" />
			<div>
				<h3 className="text-xs font-semibold text-violet-200">Running</h3>
				<p className="text-xs text-violet-200/70 mt-1">
					This run is in progress. Terminating it stops the agent and frees its project slot.
				</p>
				{canTerminateRun(run.status) && <TerminateRunButton run={run} />}
			</div>
		</div>
	);
}

interface DeferredCalloutProps {
	run: RunRow;
	/** Forwarded to {@link ResetRunButton}, which reports its reset back to the header. */
	onResetSuccess: (report: ResetRunReport) => void;
	/** This run's scheduled retry, already narrowed non-null by the caller. */
	nextRetryAt: string;
}

/** The `deferred` callout: the reason, when the automatic retry lands, and the controls. */
function DeferredCallout({ run, onResetSuccess, nextRetryAt }: DeferredCalloutProps) {
	return (
		<div className="p-4 bg-amber-950/20 border border-amber-900/30 rounded flex items-start gap-3">
			<AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
			<div>
				<h3 className="text-xs font-semibold text-amber-200">
					Deferred — automatic retry scheduled
				</h3>
				{run.error && (
					<p className="text-xs text-amber-200/70 mt-1 font-mono whitespace-pre-wrap">
						{normalizeRunError(run.error)}
					</p>
				)}
				<p className="text-xs text-amber-200/70 mt-2 font-mono">
					{new Date(nextRetryAt).toLocaleString()} ({formatTimeUntil(nextRetryAt)})
				</p>
				<p className="text-xs text-amber-200/70 mt-1 font-mono">
					UTC: {new Date(nextRetryAt).toISOString()}
				</p>
				<div className="flex flex-wrap items-start gap-3">
					{canRetryRun(run.status) && <RetryNowButton run={run} />}
					{canTerminateRun(run.status) && <TerminateRunButton run={run} />}
					{canResetRun(run.status) && <ResetRunButton run={run} onResetSuccess={onResetSuccess} />}
				</div>
			</div>
		</div>
	);
}

/** {@link DeferredCalloutProps} minus the schedule — this callout is the "there isn't one" case. */
type StrandedDeferredCalloutProps = Omit<DeferredCalloutProps, 'nextRetryAt'>;

/**
 * The `deferred` callout for a run nothing is going to retry (issue #1017).
 *
 * `nextRetryAt` is not cleared when the attempt behind it dies, so a run whose
 * dispatch was reaped — an abandoned worker claim settled terminally by the
 * lease-expiry sweep is how this happens — kept rendering
 * {@link DeferredCallout}'s "automatic retry scheduled" against a time in the
 * past, and a run with no `nextRetryAt` at all rendered nothing whatsoever: no
 * heading, and none of the three controls that could move it. Both now say the
 * same true thing, and carry the same buttons.
 */
function StrandedDeferredCallout({ run, onResetSuccess }: StrandedDeferredCalloutProps) {
	return (
		<div className="p-4 bg-amber-950/20 border border-amber-900/30 rounded flex items-start gap-3">
			<AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
			<div>
				<h3 className="text-xs font-semibold text-amber-200">Deferred — no retry is scheduled</h3>
				{run.error && (
					<p className="text-xs text-amber-200/70 mt-1 font-mono whitespace-pre-wrap">
						{normalizeRunError(run.error)}
					</p>
				)}
				<p className="text-xs text-amber-200/70 mt-2">
					The attempt this run was waiting on ended without scheduling another, so nothing will pick
					it up on its own. Retry now starts it immediately.
				</p>
				{run.nextRetryAt && (
					<p className="text-xs text-amber-200/70 mt-2 font-mono">
						Last scheduled for {new Date(run.nextRetryAt).toLocaleString()} (
						{new Date(run.nextRetryAt).toISOString()})
					</p>
				)}
				<div className="flex flex-wrap items-start gap-3">
					{canRetryRun(run.status) && <RetryNowButton run={run} />}
					{canTerminateRun(run.status) && <TerminateRunButton run={run} />}
					{canResetRun(run.status) && <ResetRunButton run={run} onResetSuccess={onResetSuccess} />}
				</div>
			</div>
		</div>
	);
}

interface PipelineFailureCalloutProps {
	run: RunRow;
	error: string;
	/** Forwarded to {@link RecoverRunButton}, which reports its reset back to the header. */
	onResetSuccess: (report: ResetRunReport) => void;
}

/**
 * The `failed` callout for pipeline work — the counterpart of
 * {@link MaintenanceFailureCallout}, which is what a maintenance run reads instead.
 */
function PipelineFailureCallout({ run, error, onResetSuccess }: PipelineFailureCalloutProps) {
	const heading = run.cancellation
		? 'Run Cancelled'
		: run.timedOut
			? 'Run Timed Out'
			: 'Run Failure Error';
	return (
		<div className="p-4 bg-red-950/20 border border-red-900/30 rounded flex items-start gap-3">
			<AlertTriangle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
			<div>
				<h3 className="text-xs font-semibold text-red-200">{heading}</h3>
				<p className="text-xs text-red-400/80 mt-1 font-mono whitespace-pre-wrap">
					{normalizeRunError(error)}
				</p>
				{run.cancellation && (
					<p className="text-xs text-red-400/60 mt-1 font-mono">
						{describeCancellationOrigin(run.cancellation)}
					</p>
				)}
				{/*
				 * One control for every eligible recovery choice (issue #593): the
				 * component computes them itself and renders nothing when none
				 * applies, so the choice rules can't drift from a call-site guard.
				 */}
				<div className="flex flex-wrap items-start gap-3">
					<RecoverRunButton run={run} onResetSuccess={onResetSuccess} />
				</div>
			</div>
		</div>
	);
}

interface RunStatusCalloutProps {
	run: RunRow;
	/** Forwarded to the recovery controls, which report their reset back to the header. */
	onResetSuccess: (report: ResetRunReport) => void;
}

/**
 * The one callout this run's `status` calls for, lifted out of {@link RunDetailHeader}
 * (issue #974). The four status blocks became eight conditions on two axes once the
 * kind axis arrived, which is both what pushed the header past the cognitive-complexity
 * threshold and what made it hard to scan. The header now renders this once, this
 * function is the dispatch alone, and each branch's markup is its own component.
 * Rendered output is unchanged.
 *
 * `deferred` and `checkpointed` stay on the pipeline shape deliberately: a maintenance
 * run creates no dispatch, no session and no checkpoint, so neither status is reachable
 * for one and neither needs a kind guard.
 */
function RunStatusCallout({ run, onResetSuccess }: RunStatusCalloutProps) {
	// Issue #974 — asked once, of the `kind` discriminator, and used to swap the two
	// status callouts a maintenance run reads wrongly through.
	const maintenance = isMaintenanceRun(run);

	switch (run.status) {
		case 'running':
			return maintenance ? (
				<MaintenanceRunningCallout run={run} />
			) : (
				<PipelineRunningCallout run={run} />
			);
		case 'deferred':
			// `retryScheduled === false` is the server saying this run has no active
			// dispatch (issue #1017) — its `nextRetryAt`, if any, is a time nothing is
			// waiting for. `null`/absent keeps the pre-#1017 rendering, which is what an
			// unreadable dispatch and an older server both report.
			if (run.retryScheduled === false) {
				return <StrandedDeferredCallout run={run} onResetSuccess={onResetSuccess} />;
			}
			return run.nextRetryAt ? (
				<DeferredCallout run={run} onResetSuccess={onResetSuccess} nextRetryAt={run.nextRetryAt} />
			) : null;
		case 'checkpointed':
			return <CheckpointedCallout run={run} onResetSuccess={onResetSuccess} />;
		case 'failed':
			return (
				<>
					<FailureDiagnosisCallout diagnosis={run.failureDiagnosis} />
					{run.error && maintenance && <MaintenanceFailureCallout run={run} error={run.error} />}
					{run.error && !maintenance && (
						<PipelineFailureCallout run={run} error={run.error} onResetSuccess={onResetSuccess} />
					)}
				</>
			);
		default:
			return null;
	}
}

interface RunDetailHeaderProps {
	run: RunRow;
	/**
	 * Forwarded to the two review-cap callouts, which are the header's only use for
	 * it: each reads the pipeline switch gating its own continuation.
	 */
	project?: ReviewCapCalloutProject;
}

export function RunDetailHeader({ run, project }: RunDetailHeaderProps) {
	const [resetReport, setResetReport] = useState<ResetRunReport | null>(null);
	const prevRunIdRef = useRef(run.id);

	useEffect(() => {
		if (prevRunIdRef.current !== run.id) {
			setResetReport(null);
			prevRunIdRef.current = run.id;
		}
	}, [run.id]);

	return (
		<div className="space-y-6">
			{/* Breadcrumb */}
			<div className="text-xs font-mono text-zinc-500">
				<Link to="/runs" className="hover:text-zinc-300 transition-colors">
					runs
				</Link>{' '}
				/ <span className="text-zinc-300 font-semibold select-all">{run.id}</span>
			</div>

			{/* Page Title */}
			<div className="flex flex-wrap items-center justify-between gap-4">
				<div>
					<h1 className="text-2xl font-semibold tracking-tight text-zinc-100 capitalize">
						{formatPhase(run.phase)} Run
					</h1>
					<p className="text-xs text-zinc-500 mt-1 font-mono">{run.id}</p>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					{/* The page states the same kind the list did (issue #974), beside — never
					    instead of — the status, which is the other axis. */}
					<RunStatusBadge
						status={run.status as RunStatus}
						timedOut={run.timedOut}
						phase={run.phase}
						reviewVerdict={run.reviewVerdict}
						reviewAutomationOutcome={run.reviewAutomationOutcome}
						className="text-sm px-3 py-1"
					/>
				</div>
			</div>

			{resetReport && (
				<div className="p-4 bg-zinc-900/50 border border-zinc-800 rounded flex items-start gap-3">
					<CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0 mt-0.5" />
					<div>
						<h3 className="text-xs font-semibold text-zinc-200">Reset complete</h3>
						<ul className="mt-1.5 space-y-1 text-xs text-zinc-400">
							{describeResetResult(resetReport).map((line) => (
								<li key={line}>{line}</li>
							))}
						</ul>
					</div>
				</div>
			)}

			<RunStatusCallout run={run} onResetSuccess={setResetReport} />

			<PreservedWorkerCallout run={run} />
			<CheckpointPanel run={run} />
			<RecoveryCallout run={run} />
			<ReviewCapCallout run={run} project={project} />
			{/* Above the merge callout on purpose (issue #1038): the provider's own
			    refusal message reads as the detail behind this one. */}
			<CapSpentApprovalCallout run={run} project={project} />
			<ReviewMergeCallout run={run} />
		</div>
	);
}

interface GitHubReferencesProps {
	run: RunRow;
}

export function GitHubReferences({ run }: GitHubReferencesProps) {
	const hasWorkItem = !!run.workItemId && !!run.taskId;
	const hasPR = !!run.prNumber;
	const workItemRef = parseWorkItemRef(run.workItemUrl);

	// A maintenance run references neither a pull request nor a board card (issue
	// #971) — the build it is moving its machine to is what it has to say, and the
	// machine itself is the Execution Environment cell below. Asked of the `kind`
	// discriminator, like every other reader on this page (issue #974): the null
	// `repository`/`taskId` and the present `maintenanceTarget` are the consequence
	// of the kind, so the target is the value here, never the question.
	if (isMaintenanceRun(run)) {
		return (
			<span className="text-zinc-300 font-mono">
				Moving this machine to <span className="text-zinc-100">{run.maintenanceTarget ?? '—'}</span>
			</span>
		);
	}

	if (!hasWorkItem && !hasPR && !run.producedPrUrl) {
		return <span className="text-zinc-500 font-mono">—</span>;
	}

	return (
		<div className="flex flex-col gap-1.5">
			{/*
			 * The PR this run *opened* (issue #446), labelled apart from the `PR #n`
			 * below — which is the PR a Review / Respond-to-review run acted on.
			 */}
			{run.producedPrUrl && (
				<a
					href={run.producedPrUrl}
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex items-center gap-1 text-violet-400 hover:text-violet-300 font-mono hover:underline w-fit"
				>
					PR opened by this run
					<ExternalLink className="h-3 w-3" />
				</a>
			)}
			{hasPR && run.prTitle && (
				<span className="text-zinc-300" title={run.prTitle}>
					{run.prTitle}
				</span>
			)}
			{hasPR &&
				(run.repository ? (
					<a
						href={`https://github.com/${run.repository}/pull/${run.prNumber}`}
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-1 text-violet-400 hover:text-violet-300 font-mono hover:underline w-fit"
					>
						PR #{run.prNumber}
						<ExternalLink className="h-3 w-3" />
					</a>
				) : (
					<span className="text-zinc-400 font-mono">PR #{run.prNumber}</span>
				))}
			{hasWorkItem && run.workItemTitle && workItemRef ? (
				<>
					<span className="text-zinc-300" title={run.workItemTitle}>
						{run.workItemTitle}
					</span>
					<a
						href={run.workItemUrl ?? undefined}
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-1 text-zinc-400 hover:text-zinc-300 font-mono hover:underline w-fit"
					>
						{workItemLabel(workItemRef)}
						<ExternalLink className="h-3 w-3" />
					</a>
				</>
			) : hasWorkItem ? (
				<span className="text-zinc-400 font-mono">Issue: #{run.taskId}</span>
			) : null}
		</div>
	);
}

/**
 * The two "Execution Environment" cells naming who ran this phase (ADR-004 §4,
 * issue #446): the worker machine and the SWARM user who owns it, resolved
 * server-side into `run.attribution`.
 *
 * A run with no recorded worker — unfederated, and every row
 * predating the columns — renders the same neutral `—` the other optional fields
 * use. A recorded worker whose row no longer resolves falls back to its id in the
 * muted mono style used for the project id, so the record is never silently lost,
 * but a raw id is never shown *instead* of a name that exists.
 */
export function RunAttributionFields({ run }: { run: RunRow }) {
	const attribution = run.attribution ?? null;

	return (
		<>
			<div>
				<span className="block text-xs font-medium text-zinc-400">Worker</span>
				<span className="text-sm text-zinc-200 mt-1 block">
					{attribution?.workerName ? (
						attribution.workerName
					) : attribution?.workerId ? (
						<span className="text-xs text-zinc-500 font-mono">{attribution.workerId}</span>
					) : (
						<span className="font-mono">—</span>
					)}
				</span>
			</div>

			<div>
				<span className="block text-xs font-medium text-zinc-400">Worker owner</span>
				<span className="text-sm text-zinc-200 mt-1 block">
					{attribution?.userDisplayName ? (
						attribution.userDisplayName
					) : attribution?.userId ? (
						<span className="text-xs text-zinc-500 font-mono">{attribution.userId}</span>
					) : (
						<span className="font-mono">—</span>
					)}
				</span>
			</div>
		</>
	);
}

interface TokenUsageFieldProps {
	label: string;
	value: number;
}

function TokenUsageField({ label, value }: TokenUsageFieldProps) {
	return (
		<div>
			<span className="block text-xs font-medium text-zinc-400">{label}</span>
			<span className="text-sm text-zinc-200 mt-1 block font-mono">
				{value.toLocaleString()}{' '}
				<span className="text-xs text-zinc-500">({formatTokenCount(value)})</span>
			</span>
		</div>
	);
}

interface TokenUsageSectionProps {
	usage: AgentUsage | null;
}

function TokenUsageSection({ usage }: TokenUsageSectionProps) {
	return (
		<div>
			<h2 className="text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4">
				Token Usage
			</h2>
			{usage ? (
				<div className="grid grid-cols-1 md:grid-cols-2 gap-y-4 gap-x-8">
					<TokenUsageField label="Input" value={usage.inputTokens} />
					<TokenUsageField label="Output" value={usage.outputTokens} />
					{usage.cacheReadTokens !== undefined && (
						<TokenUsageField label="Cache read" value={usage.cacheReadTokens} />
					)}
					{usage.cacheCreationTokens !== undefined && (
						<TokenUsageField label="Cache creation" value={usage.cacheCreationTokens} />
					)}
					{usage.reasoningTokens !== undefined && (
						<TokenUsageField label="Reasoning" value={usage.reasoningTokens} />
					)}
					{usage.totalTokens !== undefined && (
						<TokenUsageField label="Total" value={usage.totalTokens} />
					)}
				</div>
			) : (
				<p className="text-sm text-zinc-500">Not reported by this run's CLI.</p>
			)}
		</div>
	);
}

interface RunOverviewProps {
	run: RunRow;
	/** Only the display name — the Project field is all this reads it for. */
	project?: { name: string } | null;
}

function RunOverview({ run, project }: RunOverviewProps) {
	const now = useNow(run.status === 'running');

	return (
		<div className="border border-zinc-800 rounded-lg bg-panel/40 p-6 shadow-sm space-y-6">
			<div>
				<h2 className="text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4">
					Run Details
				</h2>
				<div className="grid grid-cols-1 md:grid-cols-2 gap-y-4 gap-x-8">
					<div>
						<span className="block text-xs font-medium text-zinc-400">Project</span>
						<span className="text-sm text-zinc-200 mt-1 block">
							{project?.name || run.projectId}{' '}
							<span className="text-xs text-zinc-500 font-mono">({run.projectId})</span>
						</span>
					</div>

					{/*
					 * A maintenance run names no task (issue #971): it acts on no repository
					 * and provisions no worktree, so the field states the build it is moving
					 * its machine to instead of rendering blank. Keyed on the `kind`
					 * discriminator rather than on the null `taskId` that kind implies
					 * (issue #974), so the label and the value agree on one question.
					 */}
					<div>
						<span className="block text-xs font-medium text-zinc-400">
							{isMaintenanceRun(run) ? 'Target build' : 'Task ID'}
						</span>
						<span className="text-sm text-zinc-200 mt-1 block font-mono">
							{(isMaintenanceRun(run) ? run.maintenanceTarget : run.taskId) ?? '—'}
						</span>
					</div>

					<div>
						<span className="block text-xs font-medium text-zinc-400">Phase</span>
						<span className="text-sm text-zinc-200 mt-1 block font-mono capitalize">
							{formatPhase(run.phase)}
						</span>
					</div>

					<div>
						<span className="block text-xs font-medium text-zinc-400">Status</span>
						<span className="mt-1 block">
							<RunStatusBadge
								status={run.status as RunStatus}
								timedOut={run.timedOut}
								phase={run.phase}
								reviewVerdict={run.reviewVerdict}
								reviewAutomationOutcome={run.reviewAutomationOutcome}
							/>
						</span>
					</div>

					<div>
						<span className="block text-xs font-medium text-zinc-400 font-sans">
							GitHub References
						</span>
						<div className="text-sm text-zinc-200 mt-1 block">
							<GitHubReferences run={run} />
						</div>
					</div>

					<div>
						<span className="block text-xs font-medium text-zinc-400">Duration</span>
						<span className="text-sm text-zinc-200 mt-1 block font-mono">
							{formatDuration(resolveRunDurationMs(run, now))}
						</span>
					</div>
				</div>
			</div>

			<div>
				<h2 className="text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4">
					Execution Environment
				</h2>
				<div className="grid grid-cols-1 md:grid-cols-2 gap-y-4 gap-x-8">
					<div>
						<span className="block text-xs font-medium text-zinc-400">Engine / CLI</span>
						<span className="text-sm text-zinc-200 mt-1 block font-mono">{run.engine || '—'}</span>
					</div>

					<div>
						<span className="block text-xs font-medium text-zinc-400">Model Used</span>
						<span className="text-sm text-zinc-200 mt-1 block font-mono">{run.model || '—'}</span>
					</div>

					<div>
						<span className="block text-xs font-medium text-zinc-400">Reasoning</span>
						<span className="text-sm text-zinc-200 mt-1 block font-mono">
							{run.reasoning ? capitalizeLevel(run.reasoning) : 'Default'}
						</span>
					</div>

					<RunAttributionFields run={run} />

					<div>
						<span className="block text-xs font-medium text-zinc-400">Exit Code</span>
						<span
							className={`text-sm mt-1 block font-mono ${
								run.exitCode !== 0 && run.exitCode !== null
									? 'text-red-400 font-bold'
									: 'text-zinc-200'
							}`}
						>
							{run.exitCode !== null ? run.exitCode : '—'}
						</span>
					</div>

					<div>
						<span className="block text-xs font-medium text-zinc-400">Timed Out</span>
						<span
							className={`text-sm mt-1 block ${
								run.timedOut ? 'text-red-400 font-semibold' : 'text-zinc-400'
							}`}
						>
							{run.timedOut ? 'Yes' : 'No'}
						</span>
					</div>

					<div>
						<span className="block text-xs font-medium text-zinc-400">Started At</span>
						<span className="text-sm text-zinc-200 mt-1 block font-mono text-xs">
							{new Date(run.startedAt).toLocaleString()}
						</span>
					</div>

					<div>
						<span className="block text-xs font-medium text-zinc-400">Completed At</span>
						<span className="text-sm text-zinc-200 mt-1 block font-mono text-xs">
							{run.completedAt ? new Date(run.completedAt).toLocaleString() : '—'}
						</span>
					</div>

					{run.nextRetryAt && (
						<div>
							<span className="block text-xs font-medium text-zinc-400">Next Retry</span>
							<span className="text-sm text-zinc-200 mt-1 block font-mono text-xs">
								{new Date(run.nextRetryAt).toLocaleString()} ({formatTimeUntil(run.nextRetryAt)})
							</span>
							<span className="text-xs text-zinc-500 mt-1 block font-mono">
								{new Date(run.nextRetryAt).toISOString()}
							</span>
						</div>
					)}
				</div>
			</div>

			<TokenUsageSection usage={run.usage} />
		</div>
	);
}

function RunDetailRouteComponent() {
	const { runId } = runDetailRoute.useParams();
	const [activeTab, setActiveTab] = useState<'live' | 'overview' | 'logs'>('live');
	const [outputCursor, setOutputCursor] = useState(0);
	const [outputEvents, setOutputEvents] = useState<LiveOutputEvent[]>([]);
	const [uiOutputTruncated, setUiOutputTruncated] = useState(false);
	const restartPendingObservedRef = useRef(false);
	const [restartClaimedAt, setRestartClaimedAt] = useState<number | null>(null);

	// Query project list to map projectId to project repo/name
	const projectsQuery = useQuery(trpc.projects.list.queryOptions());
	const projectsMap = new Map(projectsQuery.data?.map((p) => [p.id, p]) ?? []);

	// Fetch run details and poll while the run can still change automatically —
	// which includes a `checkpointed` run (issue #503), whose scheduled continuation
	// flips it to `running` with no operator action, and any run with an accepted
	// Terminate/Reset request still outstanding (issue #561): a `failed` run awaiting
	// a queued restart is otherwise static, so without this leg the page would never
	// observe the restart being claimed and the button would stay disabled until a
	// manual reload. Keep polling briefly after that claim too: the dispatch becomes
	// leased before the worker flips the run from failed to running.
	const runQuery = useQuery({
		...trpc.runs.getById.queryOptions({ id: runId }),
		refetchInterval: (query) => {
			const run = query.state.data;
			if (!run) return false;
			if (run.status === 'running' || isRetryPending(run.status) || run.pendingRequest) return 2000;
			return restartClaimedAt !== null &&
				Date.now() - restartClaimedAt < RESTART_CLAIM_POLL_WINDOW_MS
				? 2000
				: false;
		},
	});

	useEffect(() => {
		const run = runQuery.data;
		if (!run) return;
		if (run.pendingRequest?.action === 'restart') {
			restartPendingObservedRef.current = true;
			if (restartClaimedAt !== null) setRestartClaimedAt(null);
			return;
		}
		if (restartPendingObservedRef.current && run.status === 'failed') {
			if (restartClaimedAt === null) setRestartClaimedAt(Date.now());
			return;
		}
		restartPendingObservedRef.current = false;
		if (restartClaimedAt !== null) setRestartClaimedAt(null);
	}, [restartClaimedAt, runQuery.data]);

	// Fetch run logs and poll while the run can still change automatically.
	const logsQuery = useQuery({
		...trpc.runs.getLogs.queryOptions({ runId }),
		refetchInterval: () => {
			return runQuery.data &&
				(runQuery.data.status === 'running' || isRetryPending(runQuery.data.status))
				? 2000
				: false;
		},
	});

	const outputQuery = useQuery({
		...trpc.runs.getOutput.queryOptions({ runId, after: outputCursor }),
		refetchInterval: (query) =>
			query.state.data?.hasMore ? 100 : runQuery.data?.status === 'running' ? 1000 : false,
	});
	useEffect(() => {
		const page = outputQuery.data;
		if (!page || page.nextCursor === outputCursor) return;
		setOutputEvents((current) => {
			const combined = [...current, ...page.events];
			if (combined.length <= 2_000) return combined;
			setUiOutputTruncated(true);
			return combined.slice(-2_000);
		});
		setOutputCursor(page.nextCursor);
	}, [outputCursor, outputQuery.data]);

	// Trigger a final logs refetch when status transitions out of 'running'
	const status = runQuery.data?.status;
	const prevStatusRef = useRef<string | undefined>(status);
	useEffect(() => {
		if (prevStatusRef.current === 'running' && status && status !== 'running') {
			logsQuery.refetch();
		}
		prevStatusRef.current = status;
	}, [status, logsQuery]);

	if (runQuery.isLoading) {
		return <div className="text-sm text-zinc-400">Loading run details…</div>;
	}

	if (runQuery.isError) {
		return (
			<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded flex items-center gap-2">
				<AlertTriangle className="h-4 w-4 shrink-0" />
				<span>{runQuery.error.message}</span>
			</div>
		);
	}

	const run = runQuery.data;
	if (!run) {
		return (
			<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
				Run not found.
			</div>
		);
	}

	const project = projectsMap.get(run.projectId);

	return (
		<div className="space-y-6">
			<RunDetailHeader run={run as unknown as RunRow} project={project} />

			{/* Tab Bar */}
			<div className="flex border-b border-zinc-800">
				<button
					type="button"
					onClick={() => setActiveTab('live')}
					className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold transition-all cursor-pointer ${
						activeTab === 'live'
							? 'border-b-2 border-violet-500 text-zinc-100 bg-zinc-800/20'
							: 'border-b-2 border-transparent text-zinc-500 hover:text-zinc-300 hover:border-zinc-800'
					}`}
				>
					<Terminal className="h-4 w-4" />
					Live Output
				</button>
				<button
					type="button"
					onClick={() => setActiveTab('overview')}
					className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold transition-all cursor-pointer ${
						activeTab === 'overview'
							? 'border-b-2 border-violet-500 text-zinc-100 bg-zinc-800/20'
							: 'border-b-2 border-transparent text-zinc-500 hover:text-zinc-300 hover:border-zinc-800'
					}`}
				>
					<Info className="h-4 w-4" />
					Overview
				</button>
				<button
					type="button"
					onClick={() => setActiveTab('logs')}
					className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold transition-all cursor-pointer ${
						activeTab === 'logs'
							? 'border-b-2 border-violet-500 text-zinc-100 bg-zinc-800/20'
							: 'border-b-2 border-transparent text-zinc-500 hover:text-zinc-300 hover:border-zinc-800'
					}`}
				>
					<Terminal className="h-4 w-4" />
					Logs
				</button>
			</div>

			{/* Active Tab Content */}
			{activeTab === 'live' ? (
				<LiveOutputViewer
					events={outputEvents}
					isRunning={run.status === 'running'}
					isLoading={outputQuery.isLoading}
					retentionBytes={outputQuery.data?.retentionBytes ?? 5_000_000}
					serverTruncated={outputQuery.data?.truncated ?? false}
					uiTruncated={uiOutputTruncated}
				/>
			) : activeTab === 'overview' ? (
				<RunOverview run={run as unknown as RunRow} project={project} />
			) : (
				<LogViewer
					stdout={logsQuery.data?.stdout ?? null}
					stderr={logsQuery.data?.stderr ?? null}
				/>
			)}
		</div>
	);
}

export const runDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/runs/$runId',
	component: RunDetailRouteComponent,
});
