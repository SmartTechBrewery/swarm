import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute, Link } from '@tanstack/react-router';
import {
	AlertTriangle,
	CheckCircle2,
	ChevronDown,
	ExternalLink,
	Info,
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
import { Modal, ModalFooter } from '@/components/ui/modal.js';
import {
	canForceReReview,
	describeForceReReviewResult,
	forceReReviewButtonLabel,
	forceReReviewConfirmMessage,
} from '@/lib/force-re-review.js';
import { formatDuration, formatPhase, formatTimeUntil, formatTokenCount } from '@/lib/format.js';
import { describePreservedWorker, preservedWorkerLabel } from '@/lib/preserved-worker.js';
import { describeCancellationOrigin, normalizeRunError } from '@/lib/run-cancellation.js';
import { resolveRunDurationMs, useNow } from '@/lib/run-duration.js';
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
	normalizeModelSelection,
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
		mutationFn: (overrides: { cli?: RunAgent; model?: string; reasoning?: ReasoningLevel }) =>
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

	const currentCli = (
		run.engine && (RUN_AGENTS as readonly string[]).includes(run.engine)
			? (run.engine as RunAgent)
			: 'claude'
	) as RunAgent;

	// A prior run's model may be a legacy combined antigravity string; decompose it
	// into the logical id (+ reasoning) the dropdowns now speak (issue #180).
	const normalizedCurrent = run.model ? normalizeModelSelection(currentCli, run.model) : undefined;
	const modelIds = MODEL_CAPABILITIES[currentCli].map((m) => m.id);
	const currentModel =
		normalizedCurrent?.model && modelIds.includes(normalizedCurrent.model)
			? normalizedCurrent.model
			: modelIds[0];
	const currentReasoning = (run.reasoning ?? normalizedCurrent?.reasoning) as
		| ReasoningLevel
		| undefined;

	const [isOpen, setIsOpen] = useState(false);
	const [selectedCli, setSelectedCli] = useState<RunAgent>(currentCli);
	const [selectedModel, setSelectedModel] = useState<string>(currentModel);
	const [selectedReasoning, setSelectedReasoning] = useState<ReasoningLevel | ''>(
		currentReasoning ?? '',
	);

	useEffect(() => {
		setSelectedCli(currentCli);
		setSelectedModel(currentModel);
		setSelectedReasoning(currentReasoning ?? '');
	}, [currentCli, currentModel, currentReasoning]);

	const reasoningOptions = reasoningChoicesFor(selectedCli, selectedModel);

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
										onChange={(e) => {
											const newCli = e.target.value as RunAgent;
											setSelectedCli(newCli);
											setSelectedModel(MODEL_CAPABILITIES[newCli][0].id);
											// Reasoning is model-specific — clear it on any CLI change.
											setSelectedReasoning('');
										}}
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
										onChange={(e) => {
											const newModel = e.target.value;
											setSelectedModel(newModel);
											// Drop the reasoning if the new model doesn't support it.
											const stillValid =
												selectedReasoning &&
												(reasoningChoicesFor(selectedCli, newModel) as readonly string[]).includes(
													selectedReasoning,
												);
											if (!stillValid) setSelectedReasoning('');
										}}
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
										onChange={(e) => setSelectedReasoning(e.target.value as ReasoningLevel | '')}
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

								<div className="pt-2 flex justify-end gap-2">
									<button
										type="button"
										onClick={() => setIsOpen(false)}
										className="px-2.5 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors cursor-pointer"
									>
										Cancel
									</button>
									<button
										type="button"
										onClick={() => {
											mutation.mutate({
												cli: selectedCli,
												model: selectedModel,
												reasoning: selectedReasoning || undefined,
											});
											setIsOpen(false);
										}}
										className="px-3 py-1.5 text-xs font-semibold text-white bg-violet-600 rounded hover:bg-violet-500 transition-colors cursor-pointer"
									>
										{retryOverrideActionLabel(kind)}
									</button>
								</div>
							</div>
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
				className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-red-200 bg-red-950/40 border border-red-900/50 rounded-md hover:bg-red-900/40 focus:outline-none focus:ring-1 focus:ring-red-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
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
							className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold text-white bg-red-600 rounded hover:bg-red-500 focus:outline-none focus:ring-1 focus:ring-red-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
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
 * "Reset & restart" action (issue #428) for a wedged `failed`/`deferred` run —
 * the last resort when neither "Retry now" nor "Terminate" can move it because
 * its dispatch, cancellation flag, worktree lease, and recovery record disagree.
 * The modal names every step `runs.reset` performs and carries the explicit,
 * default-off opt-in for the destructive `force` variant (discard uncommitted /
 * unpushed work); success renders the per-step report the mutation returns, so
 * an operator can tell a reset that freed the checkout from one that restarted
 * the run but kept protected work. Pending state disables both the trigger and
 * the confirm button so a double-click can't fire two resets.
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
	const [discardWork, setDiscardWork] = useState(false);

	/** Close the modal and drop the force opt-in, so reopening never starts armed. */
	const closeConfirm = () => {
		setConfirmOpen(false);
		setDiscardWork(false);
	};

	const mutation = useMutation({
		mutationFn: (force: boolean) => trpcClient.runs.reset.mutate({ runId: run.id, force }),
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
				className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-red-200 bg-red-950/40 border border-red-900/50 rounded-md hover:bg-red-900/40 focus:outline-none focus:ring-1 focus:ring-red-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
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

			<Modal
				open={confirmOpen}
				onClose={() => {
					if (!mutation.isPending) closeConfirm();
				}}
				title="Reset & restart run?"
			>
				<p className="text-sm text-zinc-300">
					{resetConfirmMessage(
						run.status,
						discardWork,
						// Named only while the work is still there to lose: an already
						// abandoned record must not read as a second warning.
						run.preservedWorker?.state === 'preserved'
							? preservedWorkerLabel(run.preservedWorker)
							: null,
					)}
				</p>

				<label className="flex items-start gap-3 mt-4 p-3 border border-red-900/50 rounded-md bg-red-950/20 cursor-pointer hover:bg-red-950/30 transition-colors">
					<input
						type="checkbox"
						checked={discardWork}
						onChange={(event) => setDiscardWork(event.target.checked)}
						disabled={mutation.isPending}
						className="mt-0.5 h-4 w-4 accent-red-600 disabled:opacity-50"
					/>
					<span>
						<span className="block text-sm font-medium text-red-200">
							Also discard uncommitted / unpushed work in the checkout
						</span>
						<span className="block text-xs text-red-400/80 mt-1">
							Without this, a checkout holding uncommitted changes or unpushed commits is kept and
							the restarted run may block on it again. With it, that work is deleted and cannot be
							recovered.
						</span>
					</span>
				</label>

				{mutation.isError && (
					<div className="mt-3 p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
						{mutation.error.message}
					</div>
				)}
				<ModalFooter
					primary={
						// Guarded on the accepted restart too, so a modal left open across a
						// refetch can't queue a second one.
						<button
							type="button"
							onClick={() => mutation.mutate(discardWork)}
							disabled={blocked}
							className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold text-white bg-red-600 rounded hover:bg-red-500 focus:outline-none focus:ring-1 focus:ring-red-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
						>
							{blocked && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
							{resetButtonLabel(mutation.isPending, outstanding !== null)}
						</button>
					}
					secondary={
						<button
							type="button"
							onClick={closeConfirm}
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
 */
export function ForceReReviewButton({ run }: { run: RunRow }) {
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
				className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-red-200 bg-red-950/40 border border-red-900/50 rounded-md hover:bg-red-900/40 focus:outline-none focus:ring-1 focus:ring-red-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
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
				<p className="text-sm text-zinc-300">{forceReReviewConfirmMessage(run.prNumber)}</p>
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
							className="inline-flex items-center gap-2 px-3 py-1.5 text-xs font-semibold text-white bg-red-600 rounded hover:bg-red-500 focus:outline-none focus:ring-1 focus:ring-red-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
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
	const described = describePreservedWorker(run.preservedWorker, run.status);
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

interface ReviewCapCalloutProps {
	run: RunRow;
	project?: {
		name: string;
		repo: string;
		pipeline?: { respondToReview?: { enabled?: boolean } };
	} | null;
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
				{project?.repo && run.prNumber && (
					<a
						href={`https://github.com/${project.repo}/pull/${run.prNumber}`}
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-1 mt-2 text-red-300 hover:text-red-200 font-mono hover:underline"
					>
						View PR #{run.prNumber}
						<ExternalLink className="h-3 w-3" />
					</a>
				)}
				{canForceReReview(run, project?.pipeline) && <ForceReReviewButton run={run} />}
			</div>
		</div>
	);
}

/** Human-readable heading for each terminal (non-merged, non-waiting) merge-automation outcome. */
const MERGE_TERMINAL_LABELS: Record<string, string> = {
	'not-eligible': 'No longer eligible for automatic merge',
	'policy-blocked': 'Blocked by repository policy',
	unsupported: 'Merge automation unsupported',
	'provider-error': 'Merge automation hit a provider error',
	'retry-exhausted': 'Automatic merge retry budget exhausted',
};

interface ReviewMergeCalloutProps {
	run: RunRow;
	project?: { name: string; repo: string } | null;
}

/**
 * Run-detail callout surfacing the Review phase's provider-neutral merge
 * automation state (issue #278): merged automatically, waiting on a durable
 * retry, a terminal refusal, or retry exhaustion. A no-op when the run never
 * attempted a merge (automation disabled, or the verdict wasn't an approval).
 */
export function ReviewMergeCallout({ run, project }: ReviewMergeCalloutProps) {
	if (run.phase !== 'review' || !run.reviewMergeOutcome) return null;

	const prLink = project?.repo && run.prNumber && (
		<a
			href={`https://github.com/${project.repo}/pull/${run.prNumber}`}
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

	if (run.reviewMergeOutcome === 'not-ready') {
		return (
			<div className="p-4 bg-amber-950/20 border border-amber-900/30 rounded flex items-start gap-3">
				<AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
				<div>
					<h3 className="text-xs font-semibold text-amber-200">
						Merge automation waiting — retrying automatically
					</h3>
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

interface RunDetailHeaderProps {
	run: RunRow;
	project?: { name: string; repo: string } | null;
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
				<RunStatusBadge
					status={run.status as RunStatus}
					timedOut={run.timedOut}
					phase={run.phase}
					reviewVerdict={run.reviewVerdict}
					reviewAutomationOutcome={run.reviewAutomationOutcome}
					className="text-sm px-3 py-1"
				/>
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

			{run.status === 'running' && (
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
			)}

			{run.status === 'deferred' && run.nextRetryAt && (
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
							{new Date(run.nextRetryAt).toLocaleString()} ({formatTimeUntil(run.nextRetryAt)})
						</p>
						<p className="text-xs text-amber-200/70 mt-1 font-mono">
							UTC: {new Date(run.nextRetryAt).toISOString()}
						</p>
						<div className="flex flex-wrap items-start gap-3">
							{canRetryRun(run.status) && <RetryNowButton run={run} />}
							{canTerminateRun(run.status) && <TerminateRunButton run={run} />}
							{canResetRun(run.status) && (
								<ResetRunButton run={run} onResetSuccess={setResetReport} />
							)}
						</div>
					</div>
				</div>
			)}

			{run.status === 'checkpointed' && (
				<CheckpointedCallout run={run} onResetSuccess={setResetReport} />
			)}

			{run.status === 'failed' && <FailureDiagnosisCallout diagnosis={run.failureDiagnosis} />}

			{run.status === 'failed' && run.error && (
				<div className="p-4 bg-red-950/20 border border-red-900/30 rounded flex items-start gap-3">
					<AlertTriangle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
					<div>
						<h3 className="text-xs font-semibold text-red-200">
							{run.cancellation
								? 'Run Cancelled'
								: run.timedOut
									? 'Run Timed Out'
									: 'Run Failure Error'}
						</h3>
						<p className="text-xs text-red-400/80 mt-1 font-mono whitespace-pre-wrap">
							{normalizeRunError(run.error)}
						</p>
						{run.cancellation && (
							<p className="text-xs text-red-400/60 mt-1 font-mono">
								{describeCancellationOrigin(run.cancellation)}
							</p>
						)}
						<div className="flex flex-wrap items-start gap-3">
							{canRetryRun(run.status) && <RetryNowButton run={run} />}
							{canResetRun(run.status) && (
								<ResetRunButton run={run} onResetSuccess={setResetReport} />
							)}
						</div>
					</div>
				</div>
			)}

			<PreservedWorkerCallout run={run} />
			<CheckpointPanel run={run} />
			<RecoveryCallout run={run} />
			<ReviewCapCallout run={run} project={project} />
			<ReviewMergeCallout run={run} project={project} />
		</div>
	);
}

interface GitHubReferencesProps {
	run: RunRow;
	project?: { name: string; repo: string } | null;
}

export function GitHubReferences({ run, project }: GitHubReferencesProps) {
	const hasWorkItem = !!run.workItemId;
	const hasPR = !!run.prNumber;
	const workItemRef = parseWorkItemRef(run.workItemUrl);

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
				(project?.repo ? (
					<a
						href={`https://github.com/${project.repo}/pull/${run.prNumber}`}
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
	project?: { name: string; repo: string } | null;
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

					<div>
						<span className="block text-xs font-medium text-zinc-400">Task ID</span>
						<span className="text-sm text-zinc-200 mt-1 block font-mono">{run.taskId}</span>
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
							<GitHubReferences run={run} project={project} />
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
