import { useMutation, useQuery } from '@tanstack/react-query';
import type React from 'react';
import { useState } from 'react';
import { Modal, ModalFooter } from '@/components/ui/modal.js';
import { projectRepo } from '@/lib/project-repository.js';
import { trpc, trpcClient } from '@/lib/trpc.js';
import type { AgentCli } from '../../../../src/harness/agent-cli.js';

/**
 * Offering one of the caller's own machines to a project (issue #764) — the
 * **create** half of enrollment, which until now existed only as
 * `swarm workers enroll` and left a worker owner without CLI access waiting on
 * someone who had it. It calls the already-built `workers.enroll` mutation and
 * introduces no authorization of its own: the server resolves the caller's
 * ownership of the worker and requires `contributor` on the target project, and
 * re-validates the allowed CLIs against the machine's capabilities regardless of
 * what this form offers.
 *
 * **The result is a pending, unconsented enrollment** — exactly what the CLI
 * creates without `--active --consent`. A project administrator still approves it
 * and the owner still grants sharing consent, on the enrollment block this dialog
 * makes appear. Nothing here shortcuts the two human decisions ADR-001 makes of
 * them; the form only removes the need for a shell.
 *
 * **Except when the caller is both parties** (issue #784): an owner who also holds
 * `projectAdmin` on the chosen project gets an `active`, consenting enrollment
 * straight away. That is not a shortcut around ADR-001 either — both decisions are
 * still made by the humans it names, it is just that here they are one human, and
 * they made both in the act of enrolling. The server decides this; the form sends
 * no flag and the copy below covers both outcomes, because `projects.list` carries
 * no viewer role for it to predict which one it will get.
 *
 * **Its entry point is gated on the strict `viewerIsOwner`**, narrower than the
 * mutation, which permits an `instanceAdmin` acting on someone else's worker.
 * That is deliberate: administering a machine that is not yours stays on the CLI,
 * and the form then never offers a control that would come back `NOT_FOUND`.
 *
 * `allowedPhases` is deliberately never sent. An omitted value defaults to every
 * phase, which is the right starting point — a new enrollment constrains nothing
 * its machine's daemon and the project don't already constrain — and narrowing it
 * is the enrollment card's job once the block exists.
 */

const LABEL_CLASS = 'block text-xs font-medium text-zinc-400 mb-1';
const FIELD_CLASS =
	'block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 disabled:opacity-50 disabled:bg-zinc-950 disabled:border-zinc-800 disabled:text-zinc-500';
const SECONDARY_BUTTON_CLASS =
	'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-zinc-100 focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const PRIMARY_BUTTON_CLASS =
	'inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-violet-600 rounded-md hover:bg-violet-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-violet-500 transition-colors shadow-lg shadow-violet-650/10 disabled:opacity-50 disabled:cursor-not-allowed';

/**
 * `null` when the text stands for a valid allocation, else the reason. Unlike the
 * enrollment card's version, **blank is valid here**: an existing enrollment always
 * states a share of the project, but a new one may omit the key entirely and take
 * the server's default of 1 (issue #480).
 */
function newEnrollmentConcurrencyError(draft: string): string | null {
	const trimmed = draft.trim();
	if (trimmed === '') return null;
	if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1) {
		return 'Enter a whole number of 1 or more, or leave it blank for the default of 1.';
	}
	return null;
}

/** One accessible project as the picker needs it: a label, and the repository it names. */
interface EnrollableProject {
	id: string;
	name: string;
	repositories?: Array<{ repo: string }>;
}

/**
 * The target project, or the reason there is nothing to pick. Never an empty
 * dropdown: "your projects haven't loaded", "you belong to none", and "this machine
 * is already in all of them" are three different answers, and reading any of them as
 * the others is what sends an owner looking for a bug.
 */
function ProjectPicker({
	options,
	value,
	loading,
	loadError,
	hasAccessibleProjects,
	disabled,
	onChange,
}: {
	options: EnrollableProject[];
	value: string;
	loading: boolean;
	loadError: string | null;
	hasAccessibleProjects: boolean;
	disabled: boolean;
	onChange: (projectId: string) => void;
}) {
	if (loadError !== null) {
		return <p className="text-xs text-red-400">Could not load your projects: {loadError}</p>;
	}
	if (!loading && options.length === 0) {
		return (
			<p className="text-xs text-zinc-400">
				{hasAccessibleProjects
					? 'This machine is already enrolled in every project you can see.'
					: 'You are not a member of any project yet, so there is nothing to offer this machine to.'}
			</p>
		);
	}
	return (
		<select
			id="enroll-project"
			value={value}
			onChange={(event) => onChange(event.target.value)}
			disabled={disabled || loading}
			className={FIELD_CLASS}
		>
			<option value="" disabled>
				{loading ? 'Loading your projects…' : 'Select a project…'}
			</option>
			{options.map((project) => (
				<option key={project.id} value={project.id}>
					{project.name} — {projectRepo(project)}
				</option>
			))}
		</select>
	);
}

/**
 * One checkbox per *declared capability*, all checked to start with: the server
 * rejects a set exceeding the machine's capabilities, so offering anything else
 * would be offering a control that fails — the same rule the enrollment card's
 * allowed-CLIs control follows, so an owner learns one model rather than two.
 * Unlike that control nothing is pinned here; an empty set disables submit instead,
 * since there is no enrollment yet to be left without a CLI.
 */
function AllowedClisPicker({
	capabilities,
	selected,
	disabled,
	onChange,
}: {
	capabilities: string[];
	selected: string[];
	disabled: boolean;
	onChange: (next: string[]) => void;
}) {
	if (capabilities.length === 0) {
		return (
			<p className="text-xs text-zinc-400">
				This machine has not declared any agent CLI, so there is nothing an enrollment could allow.
				Its daemon declares them at handshake — connect it, then enroll it.
			</p>
		);
	}
	return (
		<div className="flex flex-wrap gap-x-4 gap-y-2">
			{capabilities.map((cli) => {
				const checked = selected.includes(cli);
				return (
					<label key={cli} className="inline-flex items-center gap-2 text-sm text-zinc-300">
						<input
							type="checkbox"
							checked={checked}
							disabled={disabled}
							onChange={() =>
								onChange(checked ? selected.filter((one) => one !== cli) : [...selected, cli])
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

interface WorkerEnrollDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	workerId: string;
	workerName: string;
	/** The machine's declared CLIs — the only ones an enrollment may allow. */
	capabilities: string[];
	/** Projects this worker is already enrolled in, so the picker can't offer a duplicate. */
	enrolledProjectIds: string[];
	/** Called after the enrollment lands, so the caller refetches the authoritative view. */
	onChanged: () => void;
}

export function WorkerEnrollDialog({
	open,
	onOpenChange,
	workerId,
	workerName,
	capabilities,
	enrolledProjectIds,
	onChanged,
}: WorkerEnrollDialogProps) {
	const [projectId, setProjectId] = useState('');
	// `null` means "untouched, so every declared CLI" — a derived default rather than
	// state seeded at mount, so a machine that re-declares its capabilities while the
	// screen polls is reflected without an effect that could clobber a real selection.
	const [clisDraft, setClisDraft] = useState<string[] | null>(null);
	const [concurrencyDraft, setConcurrencyDraft] = useState('');

	// The same accessible-project list the detail route already resolves for the
	// enrollment blocks' names, so opening this costs no extra round trip in practice.
	// `filterAccessibleProjects` keeps a project only where the viewer holds a
	// membership, and `contributor` is the lowest of the three project roles, so every
	// row it returns already clears the threshold `workers.enroll` enforces.
	const projectsQuery = useQuery({ ...trpc.projects.list.queryOptions(), enabled: open });

	const selectedClis = clisDraft ?? capabilities;
	const concurrencyError = newEnrollmentConcurrencyError(concurrencyDraft);

	const resetDraft = () => {
		setProjectId('');
		setClisDraft(null);
		setConcurrencyDraft('');
	};

	const mutation = useMutation({
		mutationFn: () => {
			const concurrency = concurrencyDraft.trim();
			return trpcClient.workers.enroll.mutate({
				workerId,
				projectId,
				// `types/workers.ts` mirrors the CLI union as `string[]`; every value here is
				// one of the machine's own declared capabilities, and the server re-validates
				// the set against them regardless.
				allowedClis: selectedClis as AgentCli[],
				...(concurrency === '' ? {} : { concurrencyAllocation: Number(concurrency) }),
			});
		},
		onSuccess: () => {
			resetDraft();
			onOpenChange(false);
			onChanged();
		},
	});

	const handleClose = () => {
		// Drop a stale rejection so it doesn't greet the next open.
		mutation.reset();
		resetDraft();
		onOpenChange(false);
	};

	const handleSubmit = (event: React.FormEvent) => {
		event.preventDefault();
		mutation.mutate();
	};

	// Projects are filtered on the enrollments the viewer can see, which is exact
	// rather than optimistic: `workers.getById`'s enrollments and `projects.list` run
	// under the same accessibility rule, so an enrollment hidden from the viewer is in
	// a project this picker cannot offer either. The CONFLICT branch below stays the
	// backstop for a concurrent CLI enroll and for the 5s poll's window.
	const enrolled = new Set(enrolledProjectIds);
	// Not filtered on repository: the server is the authority on a mismatch, it is a
	// fact about a live daemon declaration, and hiding a project would be worse than
	// showing the server's own explanation of why it was refused.
	const options = (projectsQuery.data ?? []).filter((project) => !enrolled.has(project.id));
	// A project that vanished from the list between selection and submit (a concurrent
	// CLI enroll) reads as no selection at all rather than as a submit the server must
	// refuse.
	const selectedProject = options.find((project) => project.id === projectId);

	const canSubmit =
		!mutation.isPending &&
		selectedProject !== undefined &&
		selectedClis.length > 0 &&
		concurrencyError === null;

	return (
		<Modal open={open} onClose={handleClose} title={`Enroll ${workerName} in a project`}>
			<form onSubmit={handleSubmit} className="space-y-4">
				<p className="text-xs text-zinc-500 leading-relaxed">
					Offers this machine to a project you belong to. If you administer that project it is
					enrolled <span className="text-zinc-300">active</span> with{' '}
					<span className="text-zinc-300">sharing on</span> and can take work straight away — both
					approvals would be yours. Otherwise it is created{' '}
					<span className="text-zinc-300">awaiting approval</span> with{' '}
					<span className="text-zinc-300">sharing off</span> — a project administrator approves it
					and you grant sharing consent below before any work is routed here. Which pipeline phases
					it may take is left at every phase, and is narrowed on the enrollment afterwards.
				</p>

				<div>
					<label htmlFor="enroll-project" className={LABEL_CLASS}>
						Project <span className="text-red-500">*</span>
					</label>
					<ProjectPicker
						options={options}
						value={selectedProject ? projectId : ''}
						loading={!projectsQuery.isSuccess && !projectsQuery.isError}
						loadError={projectsQuery.error?.message ?? null}
						hasAccessibleProjects={(projectsQuery.data ?? []).length > 0}
						disabled={mutation.isPending}
						onChange={setProjectId}
					/>
					<p className="text-xs text-zinc-500 mt-1">
						Only projects you belong to, and only ones this machine is not already enrolled in. The
						repository beside each name is the one work for it is checked out from — this machine
						can only run projects on its own checkout.
					</p>
				</div>

				<div>
					<span className={LABEL_CLASS}>
						Allowed agent CLIs <span className="text-red-500">*</span>
					</span>
					<AllowedClisPicker
						capabilities={capabilities}
						selected={selectedClis}
						disabled={mutation.isPending}
						onChange={setClisDraft}
					/>
					<p className="text-xs text-zinc-500 mt-1">
						Which of the machine's declared CLIs this project may run on it. At least one — a phase
						whose target CLI is not allowed here waits for another worker.
					</p>
				</div>

				<div>
					<label htmlFor="enroll-concurrency" className={LABEL_CLASS}>
						Concurrency allocation
					</label>
					<input
						id="enroll-concurrency"
						type="number"
						min="1"
						step="1"
						inputMode="numeric"
						value={concurrencyDraft}
						onChange={(event) => setConcurrencyDraft(event.target.value)}
						disabled={mutation.isPending}
						placeholder="1"
						aria-invalid={concurrencyError ? true : undefined}
						className={`${FIELD_CLASS} font-mono max-w-[10rem]`}
					/>
					{concurrencyError ? (
						<p className="text-xs text-red-400 mt-1">{concurrencyError}</p>
					) : (
						<p className="text-xs text-zinc-500 mt-1">
							How many of this project's jobs may run here at once. Leave it blank for 1; the
							machine's own concurrency and the project cap still apply on top.
						</p>
					)}
				</div>

				{/* The server's message verbatim — the same convention the enrollment card's
				    controls follow. Both typed rejections already name the offending values
				    (the CLIs beyond the machine's capabilities; both repositories of a
				    mismatch), and a duplicate says so in as many words, so re-wording any of
				    them here would only give the two copies somewhere to drift apart. */}
				{mutation.isError ? (
					<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
						{mutation.error.message}
					</div>
				) : null}

				<ModalFooter
					primary={
						<button type="submit" disabled={!canSubmit} className={PRIMARY_BUTTON_CLASS}>
							{mutation.isPending ? 'Enrolling…' : 'Enroll worker'}
						</button>
					}
					secondary={
						<button
							type="button"
							onClick={handleClose}
							disabled={mutation.isPending}
							className={SECONDARY_BUTTON_CLASS}
						>
							Cancel
						</button>
					}
				/>
			</form>
		</Modal>
	);
}
