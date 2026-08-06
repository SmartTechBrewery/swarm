import { useMutation } from '@tanstack/react-query';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Badge, type BadgeTone } from '@/components/ui/badge.js';
import { Modal, ModalFooter } from '@/components/ui/modal.js';
import { ToggleSwitch } from '@/components/ui/toggle-switch.js';
import { formatPhase } from '@/lib/format.js';
import { trpcClient } from '@/lib/trpc.js';
import { useDraftSync } from '@/lib/use-draft-sync.js';
import { enrollmentPhaseOptions } from '@/lib/worker-enrollment-phases.js';
import { ENROLLMENT_STATUS_LABELS, routabilityBlockers } from '@/lib/worker-enrollment-view.js';
import type { WorkerDetailEnrollment } from '@/types/workers.js';
import type { AgentCli } from '../../../../src/harness/agent-cli.js';
import type { TriggerPhase } from '../../../../src/triggers/types.js';

/**
 * One project's enrollment on the worker detail view (issue #477): the facts that
 * decide whether this machine takes work for that project, each editable value
 * offered to the audience the server already enforces it for.
 *
 * The two editing audiences are **independent and both required** for
 * routability, which is why they are separated rather than merged into one
 * "enabled" control:
 *
 * - the worker's **owner** grants sharing consent and sets the execution
 *   constraints — allowed agent CLIs, allowed pipeline phases (issue #509), and
 *   concurrency allocation (`workers.setConsent` / `workers.updateConstraints`,
 *   which re-check ownership);
 * - a **project administrator** approves the enrollment and suspends/reactivates
 *   it (`workers.approveEnrollment` / `workers.setStatus`, which re-check the
 *   project role).
 *
 * A viewer who may not change a value still sees its state, as a disabled control
 * whose `title` says whose it is — the pattern issue #473 established for the
 * table's Available switch — rather than a control that would come back
 * `FORBIDDEN`. Every mutation reports its own outcome beside the control it
 * belongs to: pending, saved, or the server's message verbatim (allowed CLIs
 * exceeding the machine's capabilities is a `BAD_REQUEST` worth reading as
 * written). Nothing here terminates a running agent — revoking consent or
 * suspending blocks *future* dispatch only.
 */

const SUBPANEL_CLASS = 'border border-zinc-800 rounded-lg bg-panel/20 p-4 shadow-sm';
const LABEL_CLASS = 'block text-xs font-medium text-zinc-400';
const FIELD_CLASS =
	'block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 disabled:opacity-50 disabled:bg-zinc-950 disabled:border-zinc-800 disabled:text-zinc-500';
const SECONDARY_BUTTON_CLASS =
	'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

/** The approval axis in the shared badge's status hues: approved / awaiting / revoked. */
const STATUS_TONES: Record<WorkerDetailEnrollment['status'], BadgeTone> = {
	pending: 'caution',
	active: 'positive',
	suspended: 'negative',
};

/** One control's own outcome, rendered next to it: pending, saved, or the rejection verbatim. */
function ControlFeedback({
	pending,
	saved,
	error,
}: {
	pending: boolean;
	saved: boolean;
	error: string | null;
}) {
	if (pending) {
		return (
			<span className="inline-flex items-center gap-1.5 text-xs text-zinc-400">
				<Loader2 aria-label="Saving" className="h-3.5 w-3.5 shrink-0 animate-spin" />
				Saving…
			</span>
		);
	}
	if (error) {
		return (
			<p className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
				{error}
			</p>
		);
	}
	if (saved) {
		return (
			<span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
				<CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
				Saved
			</span>
		);
	}
	return null;
}

/** A field's heading plus its explanatory line — the shape every control here uses. */
function ControlHeading({ title, children }: { title: string; children: string }) {
	return (
		<div>
			<span className={LABEL_CLASS}>{title}</span>
			<p className="text-xs text-zinc-500 mt-1">{children}</p>
		</div>
	);
}

/**
 * `null` when the text is a valid allocation, else the reason. An empty field is a
 * validation error rather than "no per-worker limit" — an enrollment always states
 * its share of the project (issue #480), so emptying the input can't clear it.
 */
function concurrencyDraftError(draft: string): string | null {
	const trimmed = draft.trim();
	if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1) {
		return 'Enter a whole number of 1 or more.';
	}
	return null;
}

/** The allocation an (already validated) draft stands for. */
function parseConcurrencyDraft(draft: string): number {
	return Number(draft.trim());
}

/** How the server's value reads in the input. */
function concurrencyToDraft(value: number): string {
	return String(value);
}

interface WorkerEnrollmentCardProps {
	enrollment: WorkerDetailEnrollment;
	workerName: string;
	/** The machine's declared CLIs — the only ones an enrollment may allow. */
	capabilities: string[];
	/** The machine's declared phase repertoire — a phase it doesn't declare can't be added. */
	supportedPhases: string[];
	/** Phases this project has turned off for every worker (`pipeline.<phase>.enabled: false`). */
	projectDisabledPhases: string[];
	/** Whether `planning` may ever be allowed here — only an instance admin's own worker. */
	ownerIsInstanceAdmin: boolean;
	projectName: string;
	/** Whether the viewer may change the owner-controlled values (consent, constraints). */
	viewerIsOwner: boolean;
	/** Named in the read-only controls' tooltips, so a viewer knows who to ask. */
	ownerName: string;
	/** Called after any mutation lands, so the caller can refetch the authoritative view. */
	onChanged: () => void;
}

/** Which reduce-availability action a confirmation is open for. */
type ConfirmKind = 'stop-sharing' | 'suspend';

/** What a control reports as its error: the first failed mutation's message, verbatim. */
function firstErrorMessage(...errors: (Error | null)[]): string | null {
	return errors.find((error) => error !== null)?.message ?? null;
}

/** The accessible name and tooltip of a consent switch the viewer may or may not operate. */
function consentSwitchText(
	viewerIsOwner: boolean,
	workerName: string,
	projectName: string,
	ownerName: string,
): { label: string; title: string } {
	if (viewerIsOwner) {
		const label = `Share ${workerName} with ${projectName}`;
		return { label, title: label };
	}
	return {
		label: `Sharing of ${workerName} with ${projectName}`,
		title: `Only ${ownerName} can change sharing for ${projectName}`,
	};
}

/** The project, its approval state, and the routing verdict the two combine into. */
function EnrollmentHeader({
	enrollment,
	projectName,
}: {
	enrollment: WorkerDetailEnrollment;
	projectName: string;
}) {
	return (
		<div className="flex flex-wrap items-center gap-2">
			<a
				href={`/projects/${enrollment.projectId}`}
				className="text-sm font-semibold text-zinc-100 hover:text-violet-300 hover:underline break-words"
			>
				{projectName}
			</a>
			<Badge tone={STATUS_TONES[enrollment.status]}>
				{ENROLLMENT_STATUS_LABELS[enrollment.status]}
			</Badge>
			<Badge
				tone={enrollment.isRoutable ? 'positive' : 'neutral'}
				title="Routable = the enrollment is approved and its owner shares the machine — the only thing the dispatch gate reads"
			>
				{enrollment.isRoutable ? 'Routable' : 'Not routable'}
			</Badge>
		</div>
	);
}

/**
 * The confirmation both reduce-availability actions share. Revoking consent and
 * suspending have the identical consequence — future dispatch stops now, the run
 * in flight is untouched — and the table already confirms the first (issue #282),
 * so neither happens on a single unconfirmed click here either.
 */
function ReduceAvailabilityConfirm({
	kind,
	workerName,
	projectName,
	pending,
	errorMessage,
	onCancel,
	onConfirm,
}: {
	kind: ConfirmKind | null;
	workerName: string;
	projectName: string;
	pending: boolean;
	errorMessage: string | null;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	const suspending = kind === 'suspend';
	return (
		<Modal
			open={kind !== null}
			onClose={() => {
				if (!pending) onCancel();
			}}
			title={suspending ? 'Suspend this enrollment?' : 'Stop sharing this worker?'}
		>
			<div className="space-y-4">
				<p className="text-sm text-zinc-400 leading-relaxed">
					{suspending ? 'Suspending ' : 'Disabling sharing for '}
					<span className="font-semibold text-zinc-200">{workerName}</span> on{' '}
					<span className="font-mono text-zinc-300">{projectName}</span> blocks{' '}
					<span className="text-zinc-200">future automatic dispatch</span> immediately. It{' '}
					<span className="text-zinc-200">does not stop a run already in progress</span> — the
					current run finishes normally.
				</p>

				{errorMessage ? (
					<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
						{errorMessage}
					</div>
				) : null}

				<ModalFooter
					primary={
						<button
							type="button"
							onClick={onConfirm}
							disabled={pending}
							className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-red-600 rounded-md hover:bg-red-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-red-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
						>
							{suspending ? 'Suspend enrollment' : 'Stop sharing'}
						</button>
					}
					secondary={
						<button
							type="button"
							onClick={onCancel}
							disabled={pending}
							className={SECONDARY_BUTTON_CLASS}
						>
							Cancel
						</button>
					}
				/>
			</div>
		</Modal>
	);
}

export function WorkerEnrollmentCard({
	enrollment,
	workerName,
	capabilities,
	supportedPhases,
	projectDisabledPhases,
	ownerIsInstanceAdmin,
	projectName,
	viewerIsOwner,
	ownerName,
	onChanged,
}: WorkerEnrollmentCardProps) {
	const [confirm, setConfirm] = useState<ConfirmKind | null>(null);

	const consentMutation = useMutation({
		mutationFn: (sharingConsent: boolean) =>
			trpcClient.workers.setConsent.mutate({
				enrollmentId: enrollment.enrollmentId,
				sharingConsent,
			}),
		onSuccess: () => {
			setConfirm(null);
			onChanged();
		},
	});
	// Allowed CLIs and concurrency both call `updateConstraints`, on two mutations
	// rather than one, so each control reports only its own outcome.
	const clisMutation = useMutation({
		mutationFn: (allowedClis: AgentCli[]) =>
			trpcClient.workers.updateConstraints.mutate({
				enrollmentId: enrollment.enrollmentId,
				allowedClis,
			}),
		onSuccess: onChanged,
	});
	const phasesMutation = useMutation({
		mutationFn: (allowedPhases: TriggerPhase[]) =>
			trpcClient.workers.updateConstraints.mutate({
				enrollmentId: enrollment.enrollmentId,
				allowedPhases,
			}),
		onSuccess: onChanged,
	});
	const concurrencyMutation = useMutation({
		mutationFn: (concurrencyAllocation: number) =>
			trpcClient.workers.updateConstraints.mutate({
				enrollmentId: enrollment.enrollmentId,
				concurrencyAllocation,
			}),
		onSuccess: onChanged,
	});
	const approveMutation = useMutation({
		mutationFn: () =>
			trpcClient.workers.approveEnrollment.mutate({ enrollmentId: enrollment.enrollmentId }),
		onSuccess: onChanged,
	});
	const statusMutation = useMutation({
		mutationFn: (status: 'active' | 'suspended') =>
			trpcClient.workers.setStatus.mutate({ enrollmentId: enrollment.enrollmentId, status }),
		onSuccess: () => {
			setConfirm(null);
			onChanged();
		},
	});

	const blockers = routabilityBlockers(enrollment);
	// A confirmation dialog shows its own action's error; the inline feedback for
	// that control stays quiet meanwhile so the message isn't stated twice.
	const confirmOpen = confirm !== null;
	const consentText = consentSwitchText(viewerIsOwner, workerName, projectName, ownerName);
	const approvalPending = approveMutation.isPending || statusMutation.isPending;

	return (
		<li className={`${SUBPANEL_CLASS} space-y-4`}>
			<EnrollmentHeader enrollment={enrollment} projectName={projectName} />

			<p className="text-xs text-zinc-500 font-mono break-all select-all">{enrollment.projectId}</p>

			{blockers.length > 0 ? (
				<ul className="space-y-1 text-xs text-zinc-400">
					{blockers.map((blocker) => (
						<li key={blocker}>· {blocker}</li>
					))}
				</ul>
			) : null}

			<div className="grid gap-5 md:grid-cols-2">
				<div className="space-y-2">
					<ControlHeading title="Sharing consent">
						The owner's opt-in. Revoking it blocks future automatic dispatch immediately and never
						stops a run already in progress.
					</ControlHeading>
					<ToggleSwitch
						checked={enrollment.sharingConsent}
						disabled={!viewerIsOwner || consentMutation.isPending}
						label={consentText.label}
						title={consentText.title}
						onChange={() => {
							// Enabling has no destructive consequence — apply it directly;
							// revoking goes through the confirmation.
							if (enrollment.sharingConsent) setConfirm('stop-sharing');
							else consentMutation.mutate(true);
						}}
					/>
					<ControlFeedback
						pending={consentMutation.isPending}
						saved={consentMutation.isSuccess}
						error={confirmOpen ? null : firstErrorMessage(consentMutation.error)}
					/>
				</div>

				<div className="space-y-2">
					<ControlHeading title="Approval">
						A project administrator's decision, independent of sharing consent — both are required
						before work is routed here.
					</ControlHeading>
					<ApprovalControls
						enrollment={enrollment}
						projectName={projectName}
						pending={approvalPending}
						onApprove={() => approveMutation.mutate()}
						onSuspend={() => setConfirm('suspend')}
						onReactivate={() => statusMutation.mutate('active')}
					/>
					<ControlFeedback
						pending={approvalPending}
						saved={approveMutation.isSuccess || statusMutation.isSuccess}
						error={
							confirmOpen ? null : firstErrorMessage(approveMutation.error, statusMutation.error)
						}
					/>
				</div>

				<div className="space-y-2">
					<ControlHeading title="Allowed agent CLIs">
						Which of the machine's declared CLIs this project may run on it. A phase whose target
						CLI is not allowed here waits for another worker.
					</ControlHeading>
					<AllowedClisControl
						allowedClis={enrollment.allowedClis}
						capabilities={capabilities}
						editable={viewerIsOwner}
						pending={clisMutation.isPending}
						ownerName={ownerName}
						onChange={(next) =>
							// `types/workers.ts` mirrors the CLI union as `string[]`; every value
							// here is one of the machine's own declared capabilities, and the
							// server re-validates the set against them regardless.
							clisMutation.mutate(next as AgentCli[])
						}
					/>
					<ControlFeedback
						pending={clisMutation.isPending}
						saved={clisMutation.isSuccess}
						error={clisMutation.error?.message ?? null}
					/>
				</div>

				<div className="space-y-2">
					<ControlHeading title="Allowed pipeline phases">
						Which phases this project may give this machine. A phase left out here is routed to
						another worker; changing the selection affects future dispatches only.
					</ControlHeading>
					<AllowedPhasesControl
						allowedPhases={enrollment.allowedPhases}
						supportedPhases={supportedPhases}
						projectDisabledPhases={projectDisabledPhases}
						ownerIsInstanceAdmin={ownerIsInstanceAdmin}
						editable={viewerIsOwner}
						pending={phasesMutation.isPending}
						ownerName={ownerName}
						onChange={(next) => phasesMutation.mutate(next)}
					/>
					<ControlFeedback
						pending={phasesMutation.isPending}
						saved={phasesMutation.isSuccess}
						error={phasesMutation.error?.message ?? null}
					/>
				</div>

				<div className="space-y-2">
					<ControlHeading title="Concurrency allocation">
						How many of this project's jobs run on this machine at once — 1 unless it was raised.
						The machine's own concurrency and the project cap still apply on top.
					</ControlHeading>
					<ConcurrencyControl
						enrollmentId={enrollment.enrollmentId}
						value={enrollment.concurrencyAllocation}
						editable={viewerIsOwner}
						pending={concurrencyMutation.isPending}
						ownerName={ownerName}
						onApply={(next) => concurrencyMutation.mutate(next)}
					/>
					<ControlFeedback
						pending={concurrencyMutation.isPending}
						saved={concurrencyMutation.isSuccess}
						error={concurrencyMutation.error?.message ?? null}
					/>
				</div>
			</div>

			<ReduceAvailabilityConfirm
				kind={confirm}
				workerName={workerName}
				projectName={projectName}
				pending={consentMutation.isPending || statusMutation.isPending}
				errorMessage={
					confirm === 'suspend'
						? firstErrorMessage(statusMutation.error)
						: firstErrorMessage(consentMutation.error)
				}
				onCancel={() => setConfirm(null)}
				onConfirm={() => {
					if (confirm === 'suspend') statusMutation.mutate('suspended');
					else consentMutation.mutate(false);
				}}
			/>
		</li>
	);
}

/**
 * The project administrator's two acts: approving a `pending` enrollment, and
 * suspending/reactivating an existing one. A viewer who doesn't administer the
 * project sees the state (the approval badge in the header) and no button at all —
 * there is nothing here whose *value* would be hidden by omitting the control.
 * Suspending stays offered for a still-pending enrollment too: that is how the
 * server models denying one, and `setStatus` accepts it from any status.
 */
function ApprovalControls({
	enrollment,
	projectName,
	pending,
	onApprove,
	onSuspend,
	onReactivate,
}: {
	enrollment: WorkerDetailEnrollment;
	projectName: string;
	pending: boolean;
	onApprove: () => void;
	onSuspend: () => void;
	onReactivate: () => void;
}) {
	if (!enrollment.viewerCanAdminister) {
		return (
			<p className="text-xs text-zinc-500">
				Only an administrator of {projectName} can approve or suspend this enrollment.
			</p>
		);
	}
	return (
		<div className="flex flex-wrap gap-2">
			{enrollment.status === 'pending' ? (
				<button
					type="button"
					onClick={onApprove}
					disabled={pending}
					className={SECONDARY_BUTTON_CLASS}
				>
					Approve enrollment
				</button>
			) : null}
			{enrollment.status === 'suspended' ? (
				<button
					type="button"
					onClick={onReactivate}
					disabled={pending}
					className={SECONDARY_BUTTON_CLASS}
				>
					Reactivate enrollment
				</button>
			) : (
				<button
					type="button"
					onClick={onSuspend}
					disabled={pending}
					className={SECONDARY_BUTTON_CLASS}
				>
					Suspend enrollment
				</button>
			)}
		</div>
	);
}

/**
 * The effective allowed CLIs, as one checkbox per *declared capability*: the
 * server rejects a set exceeding the machine's capabilities, so offering anything
 * else would be offering a control that fails. The last checked CLI can't be
 * unchecked either — an empty set is rejected too, and the constraint reads better
 * as a disabled checkbox than as a round trip that comes back invalid.
 */
function AllowedClisControl({
	allowedClis,
	capabilities,
	editable,
	pending,
	ownerName,
	onChange,
}: {
	allowedClis: string[];
	capabilities: string[];
	editable: boolean;
	pending: boolean;
	ownerName: string;
	onChange: (next: string[]) => void;
}) {
	if (!editable) {
		return (
			<div
				className="flex flex-wrap gap-1"
				title={`Only ${ownerName} can change the allowed CLIs for this project`}
			>
				{allowedClis.length === 0 ? (
					<span className="text-sm text-zinc-500">—</span>
				) : (
					allowedClis.map((cli) => <Badge key={cli}>{cli}</Badge>)
				)}
			</div>
		);
	}
	const isLastAllowed = (cli: string) => allowedClis.length === 1 && allowedClis[0] === cli;
	return (
		<div className="flex flex-wrap gap-x-4 gap-y-2">
			{capabilities.map((cli) => {
				const checked = allowedClis.includes(cli);
				return (
					<label key={cli} className="inline-flex items-center gap-2 text-sm text-zinc-300">
						<input
							type="checkbox"
							checked={checked}
							disabled={pending || isLastAllowed(cli)}
							title={
								isLastAllowed(cli)
									? 'At least one CLI must stay allowed for this project'
									: undefined
							}
							onChange={() =>
								onChange(checked ? allowedClis.filter((one) => one !== cli) : [...allowedClis, cli])
							}
							className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-violet-600 focus:ring-1 focus:ring-violet-500 disabled:opacity-50 disabled:cursor-not-allowed"
						/>
						<span className="font-mono">{cli}</span>
					</label>
				);
			})}
		</div>
	);
}

/**
 * The phases this project may route here (issue #509), as one checkbox per
 * pipeline phase — the same treatment {@link AllowedClisControl} gives the CLIs, so
 * an owner learns one control model rather than two.
 *
 * Where that control offers only the machine's declared CLIs, this offers **every**
 * phase and explains the ones that can't take work: a phase the daemon does not
 * declare, or one the project has turned off, is stated as such instead of quietly
 * missing — the difference between "not offered here" and "does not exist" is the
 * whole question an operator is asking.
 *
 * Selecting is blocked for such a phase; **unselecting is never blocked**. The two
 * conditions are outside this enrollment's control and change without it — a daemon
 * re-declares its repertoire on every reconnect, a project administrator flips a
 * phase off — so a stored selection can name a phase that is currently
 * unavailable, and an owner must always be able to give that phase up. Only the
 * last remaining phase is pinned, exactly as the last allowed CLI is: the server
 * rejects an empty set, and a disabled checkbox reads better than a round trip that
 * comes back invalid.
 */
function AllowedPhasesControl({
	allowedPhases,
	supportedPhases,
	projectDisabledPhases,
	ownerIsInstanceAdmin,
	editable,
	pending,
	ownerName,
	onChange,
}: {
	allowedPhases: string[];
	supportedPhases: string[];
	projectDisabledPhases: string[];
	ownerIsInstanceAdmin: boolean;
	editable: boolean;
	pending: boolean;
	ownerName: string;
	onChange: (next: TriggerPhase[]) => void;
}) {
	const options = enrollmentPhaseOptions({
		allowedPhases,
		supportedPhases,
		projectDisabledPhases,
		ownerIsInstanceAdmin,
	});
	if (!editable) {
		return (
			<div
				className="flex flex-wrap gap-1"
				title={`Only ${ownerName} can change the allowed pipeline phases for this project`}
			>
				{allowedPhases.length === 0 ? (
					<span className="text-sm text-zinc-500">—</span>
				) : (
					options
						.filter((option) => option.allowed)
						.map((option) => (
							<Badge
								key={option.phase}
								tone={option.unavailable || option.phase === 'planning' ? 'caution' : 'neutral'}
							>
								{formatPhase(option.phase)}
							</Badge>
						))
				)}
			</div>
		);
	}
	const isLastAllowed = (phase: string) =>
		allowedPhases.length === 1 && allowedPhases.includes(phase);
	return (
		<div className="space-y-2">
			<div className="flex flex-wrap gap-x-4 gap-y-2">
				{options.map(({ phase, allowed, unavailable }) => {
					// A phase that can't take work may still be given up — only adding one is
					// blocked, and only the last remaining phase is pinned.
					const blocked = unavailable !== null && !allowed;
					const pinned = isLastAllowed(phase);
					return (
						<label key={phase} className="inline-flex items-center gap-2 text-sm text-zinc-300">
							<input
								type="checkbox"
								checked={allowed}
								disabled={pending || blocked || pinned}
								title={
									pinned
										? 'At least one pipeline phase must stay allowed for this project'
										: (unavailable ?? undefined)
								}
								// Derived from the options rather than by patching the read model's
								// `string[]`, so the payload is typed as the phase vocabulary and stays
								// in the pipeline's own order.
								onChange={() =>
									onChange(
										options
											.filter((option) => (option.phase === phase ? !allowed : option.allowed))
											.map((option) => option.phase),
									)
								}
								className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-violet-600 focus:ring-1 focus:ring-violet-500 disabled:opacity-50 disabled:cursor-not-allowed"
							/>
							<span className="font-mono">{formatPhase(phase)}</span>
						</label>
					);
				})}
			</div>
			{options.some((option) => option.unavailable !== null) ? (
				<ul className="space-y-1 text-xs text-zinc-500">
					{options
						.filter((option) => option.unavailable !== null)
						.map((option) => (
							<li key={option.phase}>
								· <span className="font-mono">{formatPhase(option.phase)}</span>:{' '}
								{option.unavailable}
							</li>
						))}
				</ul>
			) : null}
		</div>
	);
}

/**
 * This worker's share of the project. Unlike the switches and checkboxes, a free
 * text field can't save on every keystroke, so it keeps a draft and applies on
 * demand; the draft re-syncs whenever the server's value actually changes, so the
 * screen's polling can't overwrite what is being typed. An empty or out-of-range
 * draft disables **Apply** rather than sending anything — no allocation means
 * "unlimited" (issue #480).
 */
function ConcurrencyControl({
	enrollmentId,
	value,
	editable,
	pending,
	ownerName,
	onApply,
}: {
	enrollmentId: string;
	value: number;
	editable: boolean;
	pending: boolean;
	ownerName: string;
	onApply: (next: number) => void;
}) {
	const [draft, setDraft] = useDraftSync(value, concurrencyToDraft);

	if (!editable) {
		return (
			<p
				className="text-sm text-zinc-300 font-mono"
				title={`Only ${ownerName} can change the concurrency allocation for this project`}
			>
				{value}
			</p>
		);
	}

	const draftError = concurrencyDraftError(draft);
	const unchanged = draft.trim() === concurrencyToDraft(value);
	return (
		<div className="space-y-2">
			<div className="flex items-start gap-2">
				<input
					id={`concurrency-${enrollmentId}`}
					aria-label="Concurrency allocation"
					type="number"
					min="1"
					step="1"
					inputMode="numeric"
					value={draft}
					onChange={(event) => setDraft(event.target.value)}
					disabled={pending}
					aria-invalid={draftError ? true : undefined}
					className={`${FIELD_CLASS} font-mono max-w-[10rem]`}
				/>
				<button
					type="button"
					onClick={() => onApply(parseConcurrencyDraft(draft))}
					disabled={pending || unchanged || draftError !== null}
					className={SECONDARY_BUTTON_CLASS}
				>
					Apply
				</button>
			</div>
			{draftError ? <p className="text-xs text-red-400">{draftError}</p> : null}
		</div>
	);
}
