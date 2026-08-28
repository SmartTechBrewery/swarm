import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createRoute, Link, useNavigate } from '@tanstack/react-router';
import {
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronUp,
	Cpu,
	GitBranch,
	GitMerge,
	Loader2,
	type LucideIcon,
	Play,
	Plus,
	Server,
	Settings,
	SquareKanban,
	Trash2,
	Users,
} from 'lucide-react';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BoardMappingPanel } from '@/components/projects/board-mapping-panel.js';
import { CredentialsPanel } from '@/components/projects/credentials-panel.js';
import { MembersPanel } from '@/components/projects/members-panel.js';
import { PmCredentialsPanel } from '@/components/projects/pm-credentials-panel.js';
import { PmProviderPanel } from '@/components/projects/pm-provider-panel.js';
import { PmProviderSwitchDialog } from '@/components/projects/pm-provider-switch-dialog.js';
import { ProjectAdminOnly } from '@/components/projects/project-admin-only.js';
import { RepositoriesPanel } from '@/components/projects/repositories-panel.js';
import { ProjectRunsPanel } from '@/components/runs/project-runs-panel.js';
import { ToggleSwitch } from '@/components/ui/toggle-switch.js';
import { WorkersRoster } from '@/components/workers/workers-roster.js';
import {
	addTarget,
	areTargetsDirty,
	availableClisFor,
	CLI_LABELS,
	canAddTarget,
	capitalize,
	cleanTargets,
	hasDuplicateCli,
	modelLabel,
	moveTarget,
	patchTarget,
	removeTarget,
	targetKey,
	toTargetList,
} from '@/lib/agent-targets.js';
import {
	type BoardMappingForm,
	buildPmUpdate,
	isBoardMappingDirty,
	selectedPmProviderId,
	switchedPmProviderId,
	toBoardMappingForm,
	withProviderContext,
	withSelectedContainer,
	withSelectedProvider,
} from '@/lib/board-mapping.js';
import {
	anyCustomPromptError,
	CUSTOM_PROMPT_MAX_LENGTH,
	customPromptError,
	isCustomPromptDirty,
	normalizeCustomPrompt,
} from '@/lib/phase-prompt.js';
import {
	autoAdvanceConfigPhase,
	isRespondToReviewLocked,
	isReviewChecksPolicyDirty,
	PIPELINE_TOGGLE_PHASES,
	type PipelineAutoAdvanceForm,
	type PipelineAutoAdvancePhase,
	type PipelineEnabledForm,
	type PipelineTogglePhase,
	setAutoAdvanceEnabled,
	setPhaseEnabled,
	toPipelineAutoAdvanceForm,
	toPipelineEnabledForm,
	toReviewChecksPolicyForm,
} from '@/lib/pipeline-enabled.js';
import {
	agentConfigSearch,
	isProjectAdminTab,
	PROJECT_PHASES as PHASES,
	type ProjectTab,
	phaseDetailSearch,
	projectDetailSearchSchema,
	resolveActiveTab,
	tabSearch,
	viewerAdministersProject,
} from '@/lib/project-nav.js';
import {
	addRepository,
	areRepositoriesDirty,
	duplicateRepositories,
	moveRepository,
	patchRepository,
	type RepositoryEntry,
	type RepositoryForm,
	removeRepository,
	toRepositoryEntries,
	toRepositoryForms,
} from '@/lib/project-repository.js';
import { trpc, trpcClient } from '@/lib/trpc.js';
import type {
	AgentConfig,
	AgentsConfig,
	AgentTarget,
	PipelineConfig,
	ProjectPm,
	ProjectRecord,
	ReviewChecksPolicy,
} from '../../../../src/config/schema.js';
import type { AgentCli } from '../../../../src/harness/agent-cli.js';
import {
	capabilityFor,
	MODEL_CAPABILITIES,
	type ReasoningLevel,
	reasoningChoicesFor,
} from '../../../../src/harness/models.js';
import type { PmStatusKey } from '../../../../src/pm/pipeline.js';
import { rootRoute } from '../__root.js';

const DEFAULT_TIMEOUT_MINUTES = 30;

/** Phases that expose an enable/disable toggle (the optional, SCM-driven ones). */
const TOGGLEABLE_PHASES = new Set<string>(PIPELINE_TOGGLE_PHASES);

const PHASE_LABELS: Record<
	(typeof PHASES)[number],
	{ label: string; code: string; description: string }
> = {
	implementationUnplanned: {
		label: 'Implementation (unplanned)',
		code: 'implementationUnplanned',
		description: 'Implements an issue with no prior plan',
	},
	planning: {
		label: 'Planning',
		code: 'planning',
		description: 'Drafts an implementation plan',
	},
	implementation: {
		label: 'Implementation',
		code: 'implementation',
		description: 'Implements the approved plan',
	},
	review: {
		label: 'Review',
		code: 'review',
		description: 'Reviews the pull request',
	},
	respondToReview: {
		label: 'Respond to Review',
		code: 'respondToReview',
		description: 'Addresses reviewer suggestions',
	},
	respondToCi: {
		label: 'Respond to CI',
		code: 'respondToCi',
		description: 'Fixes failing CI checks',
	},
	resolveConflicts: {
		label: 'Resolve Conflicts',
		code: 'resolveConflicts',
		description: 'Resolves merge conflicts',
	},
};

/**
 * Optional one-line explanation shown under a phase's detail heading. Most phases
 * need none; `implementationUnplanned` is a dispatch-time variant, so it clarifies
 * when its config actually applies.
 */
const PHASE_DESCRIPTIONS: Partial<Record<(typeof PHASES)[number], string>> = {
	implementationUnplanned:
		'Used only when Implementation was not preceded by a Planning run for this item; otherwise the Implementation configuration applies.',
};

const CODED_DEFAULT_MODEL: Record<string, string> = {
	claude: 'sonnet',
	codex: 'gpt-5.6-terra',
	antigravity: 'gemini-3.5-flash',
};

function getModelDefaultLabel(
	cli: AgentCli,
	projectDefaults?: Record<string, string | undefined>,
): string {
	const defaultModel = projectDefaults?.[cli] || CODED_DEFAULT_MODEL[cli] || 'Unset';
	return `Default (${modelLabel(cli, defaultModel)})`;
}

/**
 * The "Default" reasoning option label for a (cli, model) — surfaces the model's
 * known default so an omitted reasoning reads as e.g. "Default (Medium)" rather
 * than implying no reasoning happens (issue #180). `Default (unknown)` when the
 * CLI controls its own default (claude) or none is known.
 */
function getReasoningDefaultLabel(cli: AgentCli, model?: string): string {
	const def = model ? capabilityFor(cli, model)?.defaultReasoning : null;
	return def ? `Default (${capitalize(def)})` : 'Default (unknown)';
}

/**
 * The placeholder shown in a phase's Reasoning selector: "—" with no model, the
 * model's default level when it exposes a choice, else "Fixed" (a single-variant
 * model) or "N/A" (no reasoning knob at all). Extracted so the detail component's
 * cognitive complexity stays within budget.
 */
function reasoningPlaceholderLabel(
	cli: AgentCli | undefined,
	model: string | undefined,
	optionCount: number,
): string {
	if (!cli || !model) return '—';
	if (optionCount > 0) return getReasoningDefaultLabel(cli, model);
	return capabilityFor(cli, model)?.fixedVariant ? 'Fixed' : 'N/A';
}

/**
 * Derive the dependent Model/Reasoning selector state for one target row — the
 * Model list depends on the row's CLI, the Reasoning list on its `(cli, model)`.
 * Pulled out of {@link TargetRow} to keep its cognitive complexity within budget.
 */
function targetFieldState(target: AgentTarget, isPending: boolean) {
	const reasoningOptions =
		target.cli && target.model ? reasoningChoicesFor(target.cli, target.model) : [];
	return {
		modelOptions: target.cli ? MODEL_CAPABILITIES[target.cli] : [],
		reasoningOptions,
		reasoningDisabled: isPending || !target.model || reasoningOptions.length === 0,
		reasoningPlaceholder: reasoningPlaceholderLabel(
			target.cli,
			target.model,
			reasoningOptions.length,
		),
	};
}

/** The phase timeout in whole minutes — the unit the field edits (config stores ms). */
function timeoutMinutesOf(config: AgentConfig): number {
	return config.timeoutMs != null ? config.timeoutMs / (60 * 1000) : DEFAULT_TIMEOUT_MINUTES;
}

/**
 * Normalize the stored per-phase configs for editing: every phase's selection
 * becomes its ordered `targets` list (folding in a pre-`targets` config's single
 * `cli`/`model`/`reasoning` mirror and any legacy combined antigravity model
 * string), and that list is the form's single source of truth — the derived
 * mirror is dropped so no stale copy of it can be edited or saved.
 */
function normalizeAgentsForDisplay(agents: AgentsConfig): AgentsConfig {
	const next: AgentsConfig = { ...agents };
	for (const phase of PHASES) {
		const config = agents[phase];
		if (!config) continue;
		next[phase] = {
			targets: toTargetList(config),
			timeoutMs: config.timeoutMs,
			prompt: config.prompt,
		};
	}
	return next;
}

function isPhaseConfigDirty(local: AgentConfig = {}, db: AgentConfig = {}): boolean {
	return (
		areTargetsDirty(toTargetList(local), db) ||
		(local.timeoutMs ?? '') !== (db.timeoutMs ?? '') ||
		isCustomPromptDirty(local.prompt, db.prompt)
	);
}

function cleanAgentsConfig(agents: AgentsConfig): AgentsConfig | undefined {
	const cleanAgents: AgentsConfig = {};
	if (agents.defaults) {
		cleanAgents.defaults = agents.defaults;
	}
	for (const phase of PHASES) {
		const phaseConfig = agents[phase];
		if (!phaseConfig) continue;
		const cleaned = cleanAgentConfig(phaseConfig);
		if (cleaned) cleanAgents[phase] = cleaned;
	}
	return Object.keys(cleanAgents).length > 0 ? cleanAgents : undefined;
}

function cleanAgentConfig(config: AgentConfig): AgentConfig | undefined {
	const { timeoutMs, prompt } = config;
	// Whitespace-only prompt is not a meaningful override (issue #135) — drop it so
	// it's neither persisted nor counted as a set value here.
	const normalizedPrompt = normalizeCustomPrompt(prompt);
	const cleanedTargets = cleanTargets(toTargetList(config));
	if (cleanedTargets.length === 0 && !timeoutMs && !normalizedPrompt) return undefined;
	// Only `targets` is sent: the schema re-derives the top-level `cli`/`model`/
	// `reasoning` mirror from the highest-priority target, so writing it here could
	// only introduce a stale second copy (issue #345).
	return {
		targets: cleanedTargets.length > 0 ? cleanedTargets : undefined,
		timeoutMs,
		prompt: normalizedPrompt,
	};
}

/**
 * The Settings tab's form: project identity and host layout, and nothing else.
 *
 * The repository list rendered here between issues #700 and #729 and now lives on the
 * Source Control tab, under the provider those repositories are hosted on
 * ({@link RepositoriesPanel}). What is left is coherent on its own — a display `name`,
 * plus the two local paths and the concurrency cap that describe the *host* running the
 * work rather than any repository. It keeps its own `projects.update` write, sending
 * exactly these four fields; the repository list sends its own.
 */
interface GeneralSettingsFormProps {
	name: string;
	repoRoot: string;
	worktreeRoot: string;
	maxConcurrentJobs: string;
	maxConcurrentJobsError?: string;
	setName: (val: string) => void;
	setRepoRoot: (val: string) => void;
	setWorktreeRoot: (val: string) => void;
	setMaxConcurrentJobs: (val: string) => void;
	handleInputChange: (
		setter: (val: string) => void,
	) => (e: React.ChangeEvent<HTMLInputElement>) => void;
	handleSubmit: (e: React.FormEvent) => void;
	handleReset: () => void;
	isDirty: boolean;
	isPending: boolean;
	isSuccess: boolean;
	isError: boolean;
	errorMessage?: string;
}

export function GeneralSettingsForm({
	name,
	repoRoot,
	worktreeRoot,
	maxConcurrentJobs,
	maxConcurrentJobsError,
	setName,
	setRepoRoot,
	setWorktreeRoot,
	setMaxConcurrentJobs,
	handleInputChange,
	handleSubmit,
	handleReset,
	isDirty,
	isPending,
	isSuccess,
	isError,
	errorMessage,
}: GeneralSettingsFormProps) {
	return (
		<div className="border border-zinc-800 rounded-lg bg-panel/40 p-6 shadow-sm">
			<form onSubmit={handleSubmit} className="space-y-6">
				<div>
					<h2 className="text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4">
						General Configuration
					</h2>
					<div className="grid grid-cols-1 md:grid-cols-2 gap-4">
						{/* Name */}
						<div>
							<label htmlFor="name" className="block text-xs font-medium text-zinc-400 mb-1">
								Name <span className="text-red-500">*</span>
							</label>
							<input
								type="text"
								id="name"
								value={name}
								onChange={handleInputChange(setName)}
								disabled={isPending}
								required
								placeholder="Project Name"
								className="block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 transition-shadow disabled:opacity-50 disabled:cursor-not-allowed"
							/>
							<p className="text-xs text-zinc-500 mt-1">
								Display name for this project shown in the dashboard.
							</p>
						</div>

						{/* Repo Root */}
						<div>
							<label htmlFor="repoRoot" className="block text-xs font-medium text-zinc-400 mb-1">
								Local Repository Root <span className="text-red-500">*</span>
							</label>
							<input
								type="text"
								id="repoRoot"
								value={repoRoot}
								onChange={handleInputChange(setRepoRoot)}
								disabled={isPending}
								required
								placeholder="/Users/username/Projects/my-project"
								className="block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 font-mono transition-shadow disabled:opacity-50 disabled:cursor-not-allowed"
							/>
							<p className="text-xs text-zinc-500 mt-1">
								Absolute path to the main repository checkout on the developer's machine.
							</p>
						</div>

						{/* Worktree Root */}
						<div>
							<label
								htmlFor="worktreeRoot"
								className="block text-xs font-medium text-zinc-400 mb-1"
							>
								Worktree Directory <span className="text-red-500">*</span>
							</label>
							<input
								type="text"
								id="worktreeRoot"
								value={worktreeRoot}
								onChange={handleInputChange(setWorktreeRoot)}
								disabled={isPending}
								required
								placeholder=".swarm-workspaces"
								className="block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 font-mono transition-shadow disabled:opacity-50 disabled:cursor-not-allowed"
							/>
							<p className="text-xs text-zinc-500 mt-1">
								Directory under the repository root where task-specific git worktrees live.
							</p>
						</div>

						<div>
							<label
								htmlFor="maxConcurrentJobs"
								className="block text-xs font-medium text-zinc-400 mb-1"
							>
								Maximum Concurrent Jobs <span className="text-red-500">*</span>
							</label>
							<input
								type="number"
								id="maxConcurrentJobs"
								value={maxConcurrentJobs}
								onChange={handleInputChange(setMaxConcurrentJobs)}
								disabled={isPending}
								className="block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 transition-shadow disabled:opacity-50 disabled:cursor-not-allowed"
							/>
							{maxConcurrentJobsError ? (
								<p className="text-xs text-red-400 mt-1">{maxConcurrentJobsError}</p>
							) : (
								<p className="text-xs text-zinc-500 mt-1">
									Maximum jobs this project may run at once, across all enrolled workers. Each
									enrolled worker also has its own share of this project (its concurrency
									allocation), so the effective number running is the smaller of the two. Must be a
									positive whole number.
								</p>
							)}
						</div>
					</div>
				</div>

				{/* Feedback Banners */}
				{isSuccess && (
					<div className="p-3 bg-emerald-950/20 border border-emerald-900/30 text-sm text-emerald-400 rounded">
						Project settings saved successfully.
					</div>
				)}

				{isError && (
					<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
						Failed to save settings: {errorMessage}
					</div>
				)}

				{/* Action Buttons */}
				<div className="flex items-center gap-2 border-t border-zinc-800 pt-4">
					<button
						type="submit"
						disabled={isPending || !isDirty}
						className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-violet-600 rounded-md hover:bg-violet-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-violet-500 transition-colors shadow-lg shadow-violet-650/10 disabled:opacity-55 disabled:cursor-not-allowed"
					>
						{isPending ? 'Saving…' : 'Save Changes'}
					</button>
					<button
						type="button"
						onClick={handleReset}
						disabled={isPending || !isDirty}
						className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-white focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors disabled:opacity-55 disabled:cursor-not-allowed"
					>
						Reset
					</button>
				</div>
			</form>
		</div>
	);
}

/** Shared select/input recipe (ai/DESIGN_SYSTEM.md §4), factored to a const. */
const FIELD_CLASS =
	'block w-full px-3 py-2 text-sm bg-zinc-900 border border-zinc-700 rounded text-zinc-100 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500 disabled:opacity-50 disabled:bg-zinc-950 disabled:border-zinc-800 disabled:text-zinc-500 transition-shadow';

/** Shared field label recipe (ai/DESIGN_SYSTEM.md §4). */
const LABEL_CLASS = 'block text-xs font-medium text-zinc-400 mb-1.5';

/** Card wrapper recipe shared by the phase-detail sections. */
const CARD_CLASS = 'border border-zinc-800 rounded-lg bg-panel/40 p-6 shadow-sm';

/**
 * The preferred target's "{CLI} • {Model}" line for the phase summary — the
 * highest-priority target's CLI and model (its configured default when no model
 * override is set). "Coded default" when the phase configures no CLI at all.
 */
function preferredModelSummary(
	config: AgentConfig,
	projectDefaults?: AgentsConfig['defaults'],
): string {
	const preferredTarget = toTargetList(config)[0];
	if (!preferredTarget?.cli) return 'Coded default';
	const model = preferredTarget.model
		? modelLabel(preferredTarget.cli, preferredTarget.model)
		: getModelDefaultLabel(preferredTarget.cli, projectDefaults);
	return `${CLI_LABELS[preferredTarget.cli]} • ${model}`;
}

/**
 * The preferred target's reasoning level for the phase summary's second line —
 * the explicit level when set, else the model's default (e.g. "Default (Medium)",
 * "Fixed", or "N/A"). Empty when the phase configures no CLI, so the row shows
 * only its "Coded default" first line with nothing beneath it.
 */
function preferredReasoningSummary(config: AgentConfig): string {
	const preferredTarget = toTargetList(config)[0];
	if (!preferredTarget?.cli) return '';
	if (preferredTarget.reasoning) return capitalize(preferredTarget.reasoning);
	const reasoningOptions = preferredTarget.model
		? reasoningChoicesFor(preferredTarget.cli, preferredTarget.model)
		: [];
	return reasoningPlaceholderLabel(
		preferredTarget.cli,
		preferredTarget.model,
		reasoningOptions.length,
	);
}

interface PhaseConfigRowProps {
	phase: (typeof PHASES)[number];
	config: AgentConfig;
	projectDefaults?: AgentsConfig['defaults'];
	isPending: boolean;
	/** Enabled state for the optional phases; `undefined` for mandatory rows. */
	enabled?: boolean;
	/** Whether the enable toggle is locked off by a dependency (Review → Respond). */
	enabledDisabled?: boolean;
	/** Key of the toggle whose immediate save is in flight, or undefined when idle. */
	savingToggleKey?: string;
	handleEnabledChange?: (phase: PipelineTogglePhase, enabled: boolean) => void;
	autoAdvance?: boolean;
	handleAutoAdvanceChange?: (phase: PipelineAutoAdvancePhase, enabled: boolean) => void;
	/** Open the phase-detail screen for this row. */
	onSelect: (phase: (typeof PHASES)[number]) => void;
}

/**
 * The Enabled-column cell for one phase: a toggle switch for the optional,
 * SCM-driven phases, or a static "Always on" label for the mandatory ones
 * (Planning, Implementation, Resolve Conflicts, signalled by
 * `enabled === undefined`). Split out of {@link PhaseConfigRow} so that row's
 * dependent-selector logic stays the dominant thing it reads as.
 */
export function PhaseEnabledCell({
	phase,
	label,
	enabled,
	enabledDisabled,
	isPending,
	savingToggleKey,
	handleEnabledChange,
}: {
	phase: (typeof PHASES)[number];
	label: string;
	enabled?: boolean;
	enabledDisabled?: boolean;
	isPending: boolean;
	/** Key of the toggle whose immediate save is in flight, or undefined when idle. */
	savingToggleKey?: string;
	handleEnabledChange?: (phase: PipelineTogglePhase, enabled: boolean) => void;
}) {
	if (enabled === undefined) {
		return <span className="text-xs text-zinc-500">Always on</span>;
	}
	const key = toggleSaveKey(phase, 'enabled');
	// Any toggle save disables every toggle until it settles, so the auto-save
	// path stays serialized and the optimistic rollback has a single prior state.
	const togglesBusy = savingToggleKey !== undefined;
	return (
		<span className="inline-flex items-center gap-2">
			<ToggleSwitch
				checked={enabled === true}
				label={`${label} enabled`}
				disabled={Boolean(isPending || enabledDisabled || togglesBusy)}
				onChange={() => handleEnabledChange?.(phase as PipelineTogglePhase, !enabled)}
			/>
			<ToggleSaveIndicator saving={savingToggleKey === key} />
		</span>
	);
}

/**
 * Which interactive toggle on the Agents tab a save-in-flight refers to — a phase
 * paired with the flag it flips. Each such toggle auto-saves on its own (issue
 * #369), so the row shows its own spinner rather than the tab-wide Save button.
 */
type ToggleKind = 'enabled' | 'autoAdvance';

/** Stable key for one phase's interactive toggle, used to target its spinner. */
export function toggleSaveKey(phase: string, kind: ToggleKind): string {
	return `${phase}:${kind}`;
}

/**
 * The trailing spinner shown beside a phase toggle while its immediate save is in
 * flight — the toggle's own pending feedback now that flipping it persists right
 * away instead of waiting for a Save Changes click (issue #369). Renders nothing
 * when idle.
 */
export function ToggleSaveIndicator({ saving }: { saving?: boolean }) {
	if (!saving) return null;
	return (
		<Loader2 aria-label="Saving" className="h-3.5 w-3.5 shrink-0 animate-spin text-zinc-400" />
	);
}

/**
 * One phase's navigation row in the Agent Configuration summary: phase identity,
 * its Enabled toggle (optional phases only), a one-line summary of the current
 * override, a "Custom prompt" badge when one is set, and a trailing chevron. The
 * whole row is clickable and keyboard-focusable and opens the phase-detail screen
 * (ai/DESIGN_SYSTEM.md blesses whole-row-click navigation as long as the trailing
 * per-row action — here the Enabled switch — stops propagation).
 */
export function PhaseConfigRow({
	phase,
	config,
	projectDefaults,
	isPending,
	enabled,
	enabledDisabled,
	savingToggleKey,
	handleEnabledChange,
	autoAdvance,
	handleAutoAdvanceChange,
	onSelect,
}: PhaseConfigRowProps) {
	const phaseLabel = PHASE_LABELS[phase];
	const autoAdvancePhase = autoAdvanceConfigPhase(phase);
	const autoAdvanceKey = autoAdvancePhase && toggleSaveKey(autoAdvancePhase, 'autoAdvance');
	const hasCustomPrompt = normalizeCustomPrompt(config.prompt) !== undefined;
	return (
		// Mouse users can click anywhere on the row; keyboard/AT users reach the
		// explicit button in the trailing cell (which is what actually carries the
		// accessible name and focus — a role="button" <tr> trips Biome a11y and is
		// worse for AT than a real control).
		<tr
			onClick={() => onSelect(phase)}
			className="hover:bg-zinc-800/40 focus-within:bg-zinc-800/40 cursor-pointer transition-colors"
		>
			<td className="px-4 py-3.5">
				<div className="text-sm font-medium text-zinc-200">{phaseLabel.label}</div>
				<div className="text-xs text-zinc-500">{phaseLabel.description}</div>
			</td>
			<td className="px-4 py-3.5">
				<PhaseEnabledCell
					phase={phase}
					label={phaseLabel.label}
					enabled={enabled}
					enabledDisabled={enabledDisabled}
					isPending={isPending}
					savingToggleKey={savingToggleKey}
					handleEnabledChange={handleEnabledChange}
				/>
			</td>
			<td className="px-4 py-3.5">
				{autoAdvance === undefined ? (
					<span className="text-xs text-zinc-500">N/A</span>
				) : (
					<span className="inline-flex items-center gap-2">
						<ToggleSwitch
							checked={autoAdvance}
							label={`${phaseLabel.label} auto-advance`}
							disabled={isPending || savingToggleKey !== undefined}
							onChange={() =>
								autoAdvancePhase && handleAutoAdvanceChange?.(autoAdvancePhase, !autoAdvance)
							}
						/>
						<ToggleSaveIndicator
							saving={Boolean(autoAdvanceKey) && savingToggleKey === autoAdvanceKey}
						/>
					</span>
				)}
			</td>
			<td className="px-4 py-3.5">
				<div className="flex flex-wrap items-center gap-2">
					<div>
						<div className="text-sm text-zinc-300">
							{preferredModelSummary(config, projectDefaults)}
						</div>
						{preferredReasoningSummary(config) && (
							<div className="text-xs text-zinc-500">{preferredReasoningSummary(config)}</div>
						)}
					</div>
					{hasCustomPrompt && (
						<span className="px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-violet-300 bg-violet-950/40 border border-violet-900/40 rounded">
							Custom prompt
						</span>
					)}
				</div>
			</td>
			<td className="px-4 py-3.5 text-right">
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
						onSelect(phase);
					}}
					aria-label={`Configure ${phaseLabel.label} phase`}
					className="inline-flex items-center justify-center rounded p-1 text-zinc-500 hover:text-zinc-200 focus:outline-none focus:ring-1 focus:ring-violet-500 transition-colors"
				>
					<ChevronRight className="h-4 w-4" aria-hidden="true" />
				</button>
			</td>
		</tr>
	);
}

/** Handlers that mutate one phase's ordered target list, shared by the row and list. */
interface TargetHandlers {
	handleTargetChange: (
		phase: keyof AgentsConfig,
		index: number,
		patch: Partial<AgentTarget>,
	) => void;
	handleAddTarget: (phase: keyof AgentsConfig) => void;
	handleRemoveTarget: (phase: keyof AgentsConfig, index: number) => void;
	handleMoveTarget: (phase: keyof AgentsConfig, index: number, direction: 'up' | 'down') => void;
}

interface PhaseSettingsDetailProps extends TargetHandlers {
	phase: (typeof PHASES)[number];
	config: AgentConfig;
	projectDefaults?: AgentsConfig['defaults'];
	isPending: boolean;
	enabled?: boolean;
	enabledDisabled?: boolean;
	/** Key of the toggle whose immediate save is in flight, or undefined when idle. */
	savingToggleKey?: string;
	handleEnabledChange?: (phase: PipelineTogglePhase, enabled: boolean) => void;
	autoAdvance?: boolean;
	handleAutoAdvanceChange?: (phase: PipelineAutoAdvancePhase, enabled: boolean) => void;
	handleTimeoutChange: (phase: keyof AgentsConfig, value: string) => void;
	handlePromptChange: (phase: keyof AgentsConfig, value: string) => void;
	onBack: () => void;
}

/**
 * Renders a phase's optional explanatory note (from {@link PHASE_DESCRIPTIONS}),
 * or nothing when the phase has none. Kept out of {@link PhaseSettingsDetail} so
 * that component's cognitive complexity stays within budget.
 */
function PhaseDetailNote({ phase }: { phase: (typeof PHASES)[number] }) {
	const description = PHASE_DESCRIPTIONS[phase];
	if (!description) return null;
	return <p className="text-xs text-zinc-400">{description}</p>;
}

/** Icon-button recipe for a target row's reorder/remove actions (ai/DESIGN_SYSTEM.md §4). */
const ROW_ACTION_CLASS =
	'p-1.5 rounded text-zinc-500 hover:bg-zinc-800/60 focus:outline-none focus:ring-1 focus:ring-violet-500 transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

interface TargetRowProps extends Omit<TargetHandlers, 'handleAddTarget'> {
	phase: (typeof PHASES)[number];
	target: AgentTarget;
	index: number;
	/** Total number of targets — the last row can't move down. */
	total: number;
	/** CLIs this row may select: every one no other row already claims. */
	cliOptions: AgentCli[];
	projectDefaults?: AgentsConfig['defaults'];
	isPending: boolean;
}

/**
 * One target in a phase's priority list: its rank, the reorder/remove actions,
 * and the dependent CLI → Model → Reasoning selectors. Each selector's accessible
 * name carries the rank, since a phase can hold several identical-looking rows.
 */
function TargetRow({
	phase,
	target,
	index,
	total,
	cliOptions,
	projectDefaults,
	isPending,
	handleTargetChange,
	handleRemoveTarget,
	handleMoveTarget,
}: TargetRowProps) {
	const { modelOptions, reasoningOptions, reasoningDisabled, reasoningPlaceholder } =
		targetFieldState(target, isPending);
	const rank = index + 1;
	const idBase = `${phase}-target-${index}`;

	return (
		<li className="p-4 border border-zinc-800 rounded-md bg-panel/20 space-y-3">
			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-2">
					<span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
						Priority {rank}
					</span>
					{index === 0 && (
						<span className="px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-violet-300 bg-violet-950/40 border border-violet-900/40 rounded">
							Preferred
						</span>
					)}
				</div>
				<div className="flex items-center gap-1">
					<button
						type="button"
						onClick={() => handleMoveTarget(phase, index, 'up')}
						disabled={isPending || index === 0}
						aria-label={`Move target ${rank} up`}
						className={`${ROW_ACTION_CLASS} hover:text-zinc-200`}
					>
						<ChevronUp className="h-4 w-4" aria-hidden="true" />
					</button>
					<button
						type="button"
						onClick={() => handleMoveTarget(phase, index, 'down')}
						disabled={isPending || index === total - 1}
						aria-label={`Move target ${rank} down`}
						className={`${ROW_ACTION_CLASS} hover:text-zinc-200`}
					>
						<ChevronDown className="h-4 w-4" aria-hidden="true" />
					</button>
					<button
						type="button"
						onClick={() => handleRemoveTarget(phase, index)}
						disabled={isPending}
						aria-label={`Remove target ${rank}`}
						className={`${ROW_ACTION_CLASS} hover:text-red-400`}
					>
						<Trash2 className="h-4 w-4" aria-hidden="true" />
					</button>
				</div>
			</div>

			<div className="grid gap-4 sm:grid-cols-3">
				<div>
					<label htmlFor={`${idBase}-cli`} className={LABEL_CLASS}>
						Agent CLI
					</label>
					<select
						id={`${idBase}-cli`}
						aria-label={`Agent CLI, target ${rank}`}
						value={target.cli ?? ''}
						onChange={(e) =>
							handleTargetChange(phase, index, { cli: (e.target.value || undefined) as AgentCli })
						}
						disabled={isPending}
						className={FIELD_CLASS}
					>
						{/* Only reachable for a hand-written config that set a model without a
						    CLI — a row added here always names one. */}
						{!target.cli && <option value="">Unset</option>}
						{cliOptions.map((cli) => (
							<option key={cli} value={cli}>
								{CLI_LABELS[cli]}
							</option>
						))}
					</select>
				</div>
				<div>
					<label htmlFor={`${idBase}-model`} className={LABEL_CLASS}>
						Model
					</label>
					<select
						id={`${idBase}-model`}
						aria-label={`Model, target ${rank}`}
						value={target.model ?? ''}
						onChange={(e) =>
							handleTargetChange(phase, index, { model: e.target.value || undefined })
						}
						disabled={isPending || !target.cli}
						className={`${FIELD_CLASS} font-mono`}
					>
						<option value="">
							{target.cli ? getModelDefaultLabel(target.cli, projectDefaults) : 'Default (Unset)'}
						</option>
						{modelOptions.map((model) => (
							<option key={model.id} value={model.id}>
								{model.label}
							</option>
						))}
					</select>
				</div>
				<div>
					<label htmlFor={`${idBase}-reasoning`} className={LABEL_CLASS}>
						Reasoning
					</label>
					<select
						id={`${idBase}-reasoning`}
						aria-label={`Reasoning, target ${rank}`}
						value={target.reasoning ?? ''}
						onChange={(e) =>
							handleTargetChange(phase, index, {
								reasoning: (e.target.value || undefined) as ReasoningLevel,
							})
						}
						disabled={reasoningDisabled}
						className={FIELD_CLASS}
					>
						<option value="">{reasoningPlaceholder}</option>
						{reasoningOptions.map((level) => (
							<option key={level} value={level}>
								{capitalize(level)}
							</option>
						))}
					</select>
				</div>
			</div>
		</li>
	);
}

interface PhaseTargetListProps extends TargetHandlers {
	phase: (typeof PHASES)[number];
	targets: AgentTarget[];
	projectDefaults?: AgentsConfig['defaults'];
	isPending: boolean;
}

/**
 * A phase's model targets in priority order, with add/remove/reorder. Order is
 * the whole point of the list: the worker runs the highest-priority target whose
 * CLI it can actually run and falls back down the list (issue #346) — the helper
 * text and the "Preferred" badge say so rather than implying all of them run, or
 * that the top one always does. Each CLI may appear at most once, so a row's CLI
 * selector offers only the CLIs no other row claims (mirroring the schema's
 * `targets` refine).
 */
function PhaseTargetList({
	phase,
	targets,
	projectDefaults,
	isPending,
	handleTargetChange,
	handleAddTarget,
	handleRemoveTarget,
	handleMoveTarget,
}: PhaseTargetListProps) {
	const canAdd = canAddTarget(targets);
	return (
		<div className="space-y-3">
			<div>
				<h3 className="text-sm font-semibold text-zinc-200">Model targets</h3>
				<p className="text-xs text-zinc-400 mt-1">
					Listed in priority order. SWARM runs the top target whose CLI is available on the worker,
					falling back down the list; each CLI can be used at most once, and an empty list leaves
					the phase on the pipeline's coded defaults.
				</p>
			</div>

			{targets.length === 0 ? (
				<p className="p-4 border border-dashed border-zinc-800 rounded-md bg-panel/20 text-xs text-zinc-500">
					No targets — this phase runs on the pipeline's coded defaults.
				</p>
			) : (
				<ol className="space-y-3">
					{targets.map((target, index) => (
						<TargetRow
							key={targetKey(targets, index)}
							phase={phase}
							target={target}
							index={index}
							total={targets.length}
							cliOptions={availableClisFor(targets, index)}
							projectDefaults={projectDefaults}
							isPending={isPending}
							handleTargetChange={handleTargetChange}
							handleRemoveTarget={handleRemoveTarget}
							handleMoveTarget={handleMoveTarget}
						/>
					))}
				</ol>
			)}

			{canAdd && (
				<button
					type="button"
					onClick={() => handleAddTarget(phase)}
					disabled={isPending}
					aria-label="Add target"
					className="flex w-full items-center gap-3 border border-dashed border-zinc-800 rounded-md bg-panel/20 p-4 text-left transition-colors hover:bg-zinc-800/20 focus:outline-none focus:ring-2 focus:ring-violet-500 disabled:cursor-not-allowed disabled:opacity-55"
				>
					<Plus className="h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />
					<span>
						<span className="block text-sm font-medium text-zinc-200">Add target</span>
						<span className="block text-xs text-zinc-400 mt-1">
							Add an unused CLI as the next fallback target.
						</span>
					</span>
				</button>
			)}
			{hasDuplicateCli(targets) && (
				<p className="text-xs text-red-400">
					Each agent CLI can appear at most once — remove the duplicate target before saving.
				</p>
			)}
		</div>
	);
}

/**
 * The per-phase detail screen: the phase's ordered list of model targets, its
 * timeout, and the editable, optional Custom prompt (issue #135). It shares the
 * route's `agents` state and the single Save/Reset model (rendered by
 * {@link AgentConfigurationForm}) — nothing here saves on its own.
 */
export function PhaseSettingsDetail({
	phase,
	config,
	projectDefaults,
	isPending,
	enabled,
	enabledDisabled,
	savingToggleKey,
	handleEnabledChange,
	autoAdvance,
	handleAutoAdvanceChange,
	handleTargetChange,
	handleAddTarget,
	handleRemoveTarget,
	handleMoveTarget,
	handleTimeoutChange,
	handlePromptChange,
	onBack,
}: PhaseSettingsDetailProps) {
	const phaseLabel = PHASE_LABELS[phase];
	const autoAdvancePhase = autoAdvanceConfigPhase(phase);
	const autoAdvanceKey = autoAdvancePhase && toggleSaveKey(autoAdvancePhase, 'autoAdvance');
	// Projected rather than read straight off `config.targets` so a phase still
	// carrying only the pre-`targets` single selection renders as its one target.
	const targets = toTargetList(config);
	const timeoutMinutes = timeoutMinutesOf(config);

	const promptValue = config.prompt ?? '';
	const promptErr = customPromptError(promptValue);
	const promptLength = (normalizeCustomPrompt(promptValue) ?? '').length;

	return (
		<div className="space-y-6">
			<button
				type="button"
				onClick={onBack}
				className="inline-flex items-center gap-1 text-xs font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
			>
				<ChevronLeft className="h-4 w-4" aria-hidden="true" />
				Back to Agent Configuration
			</button>

			<div className={`${CARD_CLASS} space-y-5`}>
				<div>
					<h2 className="text-sm font-semibold text-zinc-200">{phaseLabel.label}</h2>
					<div className="text-xs text-zinc-500 font-mono select-all">{phaseLabel.code}</div>
				</div>

				<PhaseDetailNote phase={phase} />

				<div className="space-y-4 p-4 border border-zinc-800 rounded-md bg-panel/20">
					<div className="flex items-start gap-3">
						{enabled === undefined ? (
							<ToggleSwitch
								checked={true}
								label={`${phaseLabel.label} enabled (always on)`}
								disabled={true}
							/>
						) : (
							<PhaseEnabledCell
								phase={phase}
								label={phaseLabel.label}
								enabled={enabled}
								enabledDisabled={enabledDisabled}
								isPending={isPending}
								savingToggleKey={savingToggleKey}
								handleEnabledChange={handleEnabledChange}
							/>
						)}
						<span>
							<span className="block text-sm font-medium text-zinc-200">Enabled</span>
							{enabled === undefined ? (
								<span className="block text-xs text-zinc-400 mt-1">Always on</span>
							) : enabledDisabled ? (
								<span className="block text-xs text-zinc-400 mt-1">
									Locked off while Review is disabled.
								</span>
							) : null}
						</span>
					</div>

					{autoAdvance !== undefined && (
						<div className="flex items-start gap-3">
							<span className="inline-flex items-center gap-2">
								<ToggleSwitch
									checked={autoAdvance}
									label={`${phaseLabel.label} auto-advance`}
									disabled={isPending || savingToggleKey !== undefined}
									onChange={() =>
										autoAdvancePhase && handleAutoAdvanceChange?.(autoAdvancePhase, !autoAdvance)
									}
								/>
								<ToggleSaveIndicator
									saving={Boolean(autoAdvanceKey) && savingToggleKey === autoAdvanceKey}
								/>
							</span>
							<span>
								<span className="block text-sm font-medium text-zinc-200">Auto-advance</span>
								<span className="block text-xs text-zinc-400 mt-1">
									{phase === 'planning'
										? 'Move to ToDo after SWARM posts the plan.'
										: 'Move to In review after SWARM opens the pull request.'}
								</span>
							</span>
						</div>
					)}
				</div>

				<PhaseTargetList
					phase={phase}
					targets={targets}
					projectDefaults={projectDefaults}
					isPending={isPending}
					handleTargetChange={handleTargetChange}
					handleAddTarget={handleAddTarget}
					handleRemoveTarget={handleRemoveTarget}
					handleMoveTarget={handleMoveTarget}
				/>

				<div className="grid gap-5 sm:grid-cols-2">
					<div>
						<label htmlFor={`${phase}-timeout`} className={LABEL_CLASS}>
							Timeout (minutes)
						</label>
						<input
							id={`${phase}-timeout`}
							type="number"
							min="5"
							max="45"
							value={timeoutMinutes}
							onChange={(e) => handleTimeoutChange(phase, e.target.value)}
							disabled={isPending}
							className={`${FIELD_CLASS} font-mono`}
						/>
					</div>
				</div>
			</div>

			<div className={`${CARD_CLASS} space-y-2`}>
				<label htmlFor={`${phase}-prompt`} className="block text-sm font-semibold text-zinc-200">
					Custom prompt (optional)
				</label>
				<p className="text-xs text-zinc-400">
					Appended to SWARM's built-in phase instructions as an additional "Project instructions"
					section. It supplements — never overrides — them, and is empty by default; leave it blank
					to keep the default behavior.
				</p>
				<textarea
					id={`${phase}-prompt`}
					value={promptValue}
					onChange={(e) => handlePromptChange(phase, e.target.value)}
					disabled={isPending}
					rows={8}
					placeholder="e.g. Prefer our internal utility modules over adding new dependencies."
					aria-invalid={promptErr ? true : undefined}
					className={`${FIELD_CLASS} font-mono resize-y`}
				/>
				{promptErr ? (
					<p className="text-xs text-red-400">{promptErr}</p>
				) : (
					<p className="text-xs text-zinc-500">
						{promptLength.toLocaleString()} / {CUSTOM_PROMPT_MAX_LENGTH.toLocaleString()} characters
					</p>
				)}
			</div>
		</div>
	);
}

interface AgentConfigurationFormProps extends TargetHandlers {
	agents: AgentsConfig;
	pipelineEnabled: PipelineEnabledForm;
	pipelineAutoAdvance: PipelineAutoAdvanceForm;
	/** The phase whose detail screen is open, or `undefined` for the summary table. */
	selectedPhase: (typeof PHASES)[number] | undefined;
	onSelectPhase: (phase: (typeof PHASES)[number]) => void;
	onBack: () => void;
	handleEnabledChange: (phase: PipelineTogglePhase, enabled: boolean) => void;
	handleAutoAdvanceChange: (phase: PipelineAutoAdvancePhase, enabled: boolean) => void;
	handleTimeoutChange: (phase: keyof AgentsConfig, value: string) => void;
	handlePromptChange: (phase: keyof AgentsConfig, value: string) => void;
	handleSubmit: (e: React.FormEvent) => void;
	handleReset: () => void;
	isDirty: boolean;
	/**
	 * True when a phase's custom prompt is over the bound, or two of its targets
	 * name the same CLI — either would fail server-side validation, so Save is
	 * blocked and the offending field carries the message.
	 */
	hasValidationError: boolean;
	isPending: boolean;
	isSuccess: boolean;
	isError: boolean;
	errorMessage?: string;
	/** Key of the phase toggle whose immediate save is in flight, or undefined. */
	savingToggleKey?: string;
	/** Message shown when the last immediate toggle save failed and was rolled back. */
	toggleErrorMessage?: string;
}

/**
 * Agent Configuration tab. Shows the per-phase summary table (each row navigates
 * to its detail screen), or — when a phase is
 * selected — that phase's detail screen. The Enabled/Auto-advance toggles save
 * immediately on their own scoped mutation with inline pending/error feedback
 * (issue #369); the Save Changes / Reset controls and the route's `agents` state
 * govern only the non-toggle edits (target lists, timeouts, custom prompts), so
 * the two save paths never persist each other's in-progress edits (issue #135, #119).
 */
function AgentConfigurationForm({
	agents,
	pipelineEnabled,
	pipelineAutoAdvance,
	selectedPhase,
	onSelectPhase,
	onBack,
	handleEnabledChange,
	handleAutoAdvanceChange,
	handleTargetChange,
	handleAddTarget,
	handleRemoveTarget,
	handleMoveTarget,
	handleTimeoutChange,
	handlePromptChange,
	handleSubmit,
	handleReset,
	isDirty,
	hasValidationError,
	isPending,
	isSuccess,
	isError,
	errorMessage,
	savingToggleKey,
	toggleErrorMessage,
}: AgentConfigurationFormProps) {
	const selectedAutoAdvancePhase = selectedPhase
		? autoAdvanceConfigPhase(selectedPhase)
		: undefined;

	return (
		<form onSubmit={handleSubmit} className="space-y-6">
			{/* Toggle auto-save failed: the flip was rolled back, so say so here rather
			    than letting it fail silently (issue #369). Distinct from the Save
			    Changes banners below, which cover the non-toggle edits. */}
			{toggleErrorMessage && (
				<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
					Couldn't save the toggle: {toggleErrorMessage}. Reverted to the last saved value.
				</div>
			)}

			{selectedPhase ? (
				<PhaseSettingsDetail
					phase={selectedPhase}
					config={agents[selectedPhase] ?? {}}
					projectDefaults={agents.defaults}
					isPending={isPending}
					enabled={
						TOGGLEABLE_PHASES.has(selectedPhase)
							? pipelineEnabled[selectedPhase as PipelineTogglePhase]
							: undefined
					}
					enabledDisabled={
						selectedPhase === 'respondToReview' && isRespondToReviewLocked(pipelineEnabled)
					}
					savingToggleKey={savingToggleKey}
					autoAdvance={
						selectedAutoAdvancePhase ? pipelineAutoAdvance[selectedAutoAdvancePhase] : undefined
					}
					handleEnabledChange={handleEnabledChange}
					handleAutoAdvanceChange={handleAutoAdvanceChange}
					handleTargetChange={handleTargetChange}
					handleAddTarget={handleAddTarget}
					handleRemoveTarget={handleRemoveTarget}
					handleMoveTarget={handleMoveTarget}
					handleTimeoutChange={handleTimeoutChange}
					handlePromptChange={handlePromptChange}
					onBack={onBack}
				/>
			) : (
				<div className="border border-zinc-800 rounded-lg bg-panel/40 p-6 shadow-sm">
					<div>
						<h2 className="text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4">
							Phases Configuration
						</h2>
						<p className="text-xs text-zinc-400 mb-4">
							Select a phase to configure its model targets in priority order and an optional custom
							prompt. Unset values fall back to the pipeline's coded defaults.
						</p>

						<div className="border border-zinc-800 rounded-md overflow-hidden bg-panel/20 shadow-sm">
							<table className="w-full text-left border-collapse">
								<thead>
									<tr className="bg-zinc-800/30 border-b border-zinc-800 text-xs uppercase tracking-wider text-zinc-400 font-semibold">
										<th className="px-4 py-3">Phase</th>
										<th className="px-4 py-3">Enabled</th>
										<th className="px-4 py-3">Auto-advance</th>
										<th className="px-4 py-3">Preferred model</th>
										<th className="px-4 py-3">
											<span className="sr-only">Open</span>
										</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-zinc-800/60">
									{PHASES.map((phase) => {
										const autoAdvancePhase = autoAdvanceConfigPhase(phase);
										return (
											<PhaseConfigRow
												key={phase}
												phase={phase}
												config={agents[phase] ?? {}}
												projectDefaults={agents.defaults}
												isPending={isPending}
												enabled={
													TOGGLEABLE_PHASES.has(phase)
														? pipelineEnabled[phase as PipelineTogglePhase]
														: undefined
												}
												enabledDisabled={
													phase === 'respondToReview' && isRespondToReviewLocked(pipelineEnabled)
												}
												savingToggleKey={savingToggleKey}
												autoAdvance={
													autoAdvancePhase ? pipelineAutoAdvance[autoAdvancePhase] : undefined
												}
												handleEnabledChange={handleEnabledChange}
												handleAutoAdvanceChange={handleAutoAdvanceChange}
												onSelect={onSelectPhase}
											/>
										);
									})}
								</tbody>
							</table>
						</div>
					</div>
				</div>
			)}

			{/* Feedback Banners */}
			{isSuccess && (
				<div className="p-3 bg-emerald-950/20 border border-emerald-900/30 text-sm text-emerald-400 rounded">
					Agent configuration saved successfully.
				</div>
			)}

			{isError && (
				<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
					Failed to save configuration: {errorMessage}
				</div>
			)}

			{/* Action Buttons */}
			<div className="flex items-center gap-2 border-t border-zinc-800 pt-4">
				<button
					type="submit"
					disabled={isPending || !isDirty || hasValidationError}
					className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-violet-600 rounded-md hover:bg-violet-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-violet-500 transition-colors shadow-lg shadow-violet-650/10 disabled:opacity-55 disabled:cursor-not-allowed"
				>
					{isPending ? 'Saving…' : 'Save Changes'}
				</button>
				<button
					type="button"
					onClick={handleReset}
					disabled={isPending || !isDirty}
					className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-white focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors disabled:opacity-55 disabled:cursor-not-allowed"
				>
					Reset
				</button>
			</div>
		</form>
	);
}

const REVIEW_CHECKS_POLICY_OPTIONS: Array<{
	value: ReviewChecksPolicy;
	label: string;
	description: string;
}> = [
	{
		value: 'required',
		label: 'Require CI checks',
		description:
			'A pull request whose head commit reports zero checks stays pending and is rechecked. Use this when the repository runs CI.',
	},
	{
		value: 'if-present',
		label: 'Review when no checks exist',
		description:
			'Dispatches Review immediately when GitHub reports zero checks at all. Only for repositories with no CI — a pull request with real pending, passing, or failing checks keeps the same behavior either way; this is not a way to bypass CI that exists.',
	},
];

interface PipelineSettingsFormProps {
	autoMerge: boolean;
	setAutoMerge: (value: boolean) => void;
	skipRespondToReviewOnMinors: boolean;
	setSkipRespondToReviewOnMinors: (value: boolean) => void;
	reviewChecksPolicy: ReviewChecksPolicy;
	setReviewChecksPolicy: (value: ReviewChecksPolicy) => void;
	handleSubmit: (e: React.FormEvent) => void;
	handleReset: () => void;
	isDirty: boolean;
	isPending: boolean;
	isSuccess: boolean;
	isError: boolean;
	errorMessage?: string;
}

export function PipelineSettingsForm({
	autoMerge,
	setAutoMerge,
	skipRespondToReviewOnMinors,
	setSkipRespondToReviewOnMinors,
	reviewChecksPolicy,
	setReviewChecksPolicy,
	handleSubmit,
	handleReset,
	isDirty,
	isPending,
	isSuccess,
	isError,
	errorMessage,
}: PipelineSettingsFormProps) {
	return (
		<div className="border border-zinc-800 rounded-lg bg-panel/40 p-6 shadow-sm">
			<form onSubmit={handleSubmit} className="space-y-6">
				<div>
					<h2 className="text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4">
						Pipeline Automation
					</h2>
					<label className="flex items-start gap-3 p-4 border border-zinc-800 rounded-md bg-panel/20 cursor-pointer hover:bg-zinc-800/20 transition-colors">
						<input
							type="checkbox"
							checked={autoMerge}
							onChange={(event) => setAutoMerge(event.target.checked)}
							disabled={isPending}
							className="mt-0.5 h-4 w-4 accent-violet-600 disabled:opacity-50"
						/>
						<span>
							<span className="block text-sm font-medium text-zinc-200">Merge automation</span>
							<span className="block text-xs text-zinc-400 mt-1">
								After a SWARM review approves a pull request, merge it directly using the
								implementer credential, retrying briefly while checks settle. Repository rules still
								apply; SWARM never uses the provider's native auto-merge.
							</span>
						</span>
					</label>
					<label className="flex items-start gap-3 p-4 border border-zinc-800 rounded-md bg-panel/20 cursor-pointer hover:bg-zinc-800/20 transition-colors">
						<input
							type="checkbox"
							checked={skipRespondToReviewOnMinors}
							onChange={(event) => setSkipRespondToReviewOnMinors(event.target.checked)}
							disabled={isPending}
							className="mt-0.5 h-4 w-4 accent-violet-600 disabled:opacity-50"
						/>
						<span>
							<span className="block text-sm font-medium text-zinc-200">
								Skip respond to review on minors
							</span>
							<span className="block text-xs text-zinc-400 mt-1">
								Only start Respond to Review for a reviewer request-changes verdict. Approvals and
								comment-only reviews do not consume a separate agent run.
							</span>
						</span>
					</label>
				</div>

				<div>
					<h2 className="text-sm font-semibold text-zinc-200 border-b border-zinc-800 pb-2 mb-4">
						Review
					</h2>
					<p className="text-xs text-zinc-400 mb-4">
						Controls how the Review phase treats a pull request whose head commit has zero
						registered CI checks.
					</p>
					<fieldset className="space-y-2">
						<legend className="sr-only">Review check policy</legend>
						{REVIEW_CHECKS_POLICY_OPTIONS.map(({ value, label, description }) => {
							const checked = reviewChecksPolicy === value;
							return (
								<label
									key={value}
									className={`flex items-start gap-3 p-4 border rounded-md cursor-pointer transition-colors ${
										checked
											? 'border-violet-500 bg-zinc-800/20'
											: 'border-zinc-800 bg-panel/20 hover:bg-zinc-800/20'
									}`}
								>
									<input
										type="radio"
										name="review-checks-policy"
										value={value}
										checked={checked}
										disabled={isPending}
										onChange={() => setReviewChecksPolicy(value)}
										className="mt-0.5 h-4 w-4 accent-violet-600 disabled:opacity-50"
									/>
									<span>
										<span className="block text-sm font-medium text-zinc-200">{label}</span>
										<span className="block text-xs text-zinc-400 mt-1">{description}</span>
									</span>
								</label>
							);
						})}
					</fieldset>
				</div>

				{isSuccess && (
					<div className="p-3 bg-emerald-950/20 border border-emerald-900/30 text-sm text-emerald-400 rounded">
						Pipeline settings saved successfully.
					</div>
				)}
				{isError && (
					<div className="p-2.5 bg-red-950/30 border border-red-900/30 text-xs text-red-400 rounded">
						Failed to save pipeline settings: {errorMessage}
					</div>
				)}

				<div className="flex items-center gap-2 border-t border-zinc-800 pt-4">
					<button
						type="submit"
						disabled={isPending || !isDirty}
						className="inline-flex items-center gap-2 px-4 py-2 text-sm font-semibold text-white bg-violet-600 rounded-md hover:bg-violet-500 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-violet-500 transition-colors shadow-lg shadow-violet-650/10 disabled:opacity-55 disabled:cursor-not-allowed"
					>
						{isPending ? 'Saving…' : 'Save Changes'}
					</button>
					<button
						type="button"
						onClick={handleReset}
						disabled={isPending || !isDirty}
						className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-zinc-300 bg-zinc-900 border border-zinc-800 rounded-md hover:bg-zinc-800 hover:text-white focus:outline-none focus:ring-2 focus:ring-violet-500 transition-colors disabled:opacity-55 disabled:cursor-not-allowed"
					>
						Reset
					</button>
				</div>
			</form>
		</div>
	);
}

interface UseToggleAutoSaveArgs {
	projectId: string;
	pipelineEnabled: PipelineEnabledForm;
	setPipelineEnabled: React.Dispatch<React.SetStateAction<PipelineEnabledForm>>;
	pipelineAutoAdvance: PipelineAutoAdvanceForm;
	setPipelineAutoAdvance: React.Dispatch<React.SetStateAction<PipelineAutoAdvanceForm>>;
	/**
	 * True while a *different* config write (a tab's Save Changes) is in flight.
	 * A toggle flip is refused while it's set so the toggle's read-merge-upsert
	 * can never overlap another write's — the two paths stay serialized (#369).
	 */
	blocked: boolean;
}

/**
 * Wires the Agents-tab Enabled/Auto-advance toggles to immediate, scoped saves
 * (issue #369). A flip updates the pipeline form optimistically and fires a
 * `pipeline`-only mutation — never `agents`, so the tab's unsaved target/timeout/
 * prompt edits are left untouched (the issue's caveat: the two save paths stay
 * independent). While a save is in flight `savingToggleKey` names the toggle so it
 * shows a spinner and all toggles disable, serializing writes; on failure the form
 * rolls back to the pre-flip state and `toggleErrorMessage` surfaces the reason
 * rather than the toggle reverting silently. Extracted from the route component so
 * that component keeps its cognitive-complexity budget and this contract lives in
 * one place.
 *
 * Serialization is two-way: a toggle refuses to fire while `blocked` (a tab's Save
 * Changes mutation is running) or while another toggle is still saving, and the
 * route in turn disables every tab's Save while `savingToggleKey` is set. Both the
 * toggle path and the Save-Changes path read-merge-upsert the pipeline config
 * server-side, so letting two overlap would let the later upsert clobber the
 * earlier one's change (the re-review's lost-update race, #369). Keeping only one
 * config write in flight at a time removes that race at the source.
 *
 * Keeps the query cache in sync directly using setQueryData on success, ensuring
 * that concurrent saves have the latest persisted state.
 */
export function useToggleAutoSave({
	projectId,
	pipelineEnabled,
	setPipelineEnabled,
	pipelineAutoAdvance,
	setPipelineAutoAdvance,
	blocked,
}: UseToggleAutoSaveArgs) {
	const [savingToggleKey, setSavingToggleKey] = useState<string>();
	const queryClient = useQueryClient();
	const mutation = useMutation({
		mutationFn: (variables: { id: string; pipeline: PipelineConfig }) =>
			trpcClient.projects.update.mutate(variables),
		onSuccess: (data) => {
			queryClient.setQueryData(
				trpc.projects.getById.queryOptions({ id: projectId }).queryKey,
				data,
			);
		},
		onSettled: () => setSavingToggleKey(undefined),
	});

	const persist = (key: string, pipelinePatch: PipelineConfig, rollback: () => void) => {
		setSavingToggleKey(key);
		mutation.mutate(
			{
				id: projectId,
				pipeline: pipelinePatch,
			},
			{ onError: rollback },
		);
	};

	const handleEnabledChange = (phase: PipelineTogglePhase, enabled: boolean) => {
		// Refuse to start a write while another config write is in flight — the
		// toggle stays disabled in the UI too, this guards Enter/programmatic paths.
		if (blocked || savingToggleKey !== undefined) return;
		const prev = pipelineEnabled;
		const next = setPhaseEnabled(prev, phase, enabled);
		setPipelineEnabled(next);

		const patch: PipelineConfig = {};
		if (phase === 'review') {
			patch.review = { enabled };
			if (!enabled) {
				patch.respondToReview = { enabled: false };
			}
		} else if (phase === 'respondToReview') {
			patch.respondToReview = { enabled };
		} else if (phase === 'respondToCi') {
			patch.respondToCi = { enabled };
		}

		persist(toggleSaveKey(phase, 'enabled'), patch, () => setPipelineEnabled(prev));
	};

	const handleAutoAdvanceChange = (phase: PipelineAutoAdvancePhase, enabled: boolean) => {
		if (blocked || savingToggleKey !== undefined) return;
		const prev = pipelineAutoAdvance;
		const next = setAutoAdvanceEnabled(prev, phase, enabled);
		setPipelineAutoAdvance(next);

		const patch: PipelineConfig = {
			planning: { autoAdvance: enabled },
		};

		persist(toggleSaveKey(phase, 'autoAdvance'), patch, () => setPipelineAutoAdvance(prev));
	};

	return {
		savingToggleKey,
		toggleErrorMessage: mutation.isError ? (mutation.error?.message ?? 'Unknown error') : undefined,
		handleEnabledChange,
		handleAutoAdvanceChange,
	};
}

export interface ProjectSyncFlags {
	general: boolean;
	repositories: boolean;
	agents: boolean;
	pipeline: boolean;
	boardMapping: boolean;
}

/**
 * Which slices of a freshly-loaded project differ from the last one synced into
 * form state. The route re-syncs *only* the changed slices, so a write that
 * touches one slice never resets a sibling slice's unsaved edits: an Agents-tab
 * toggle auto-save changes only `pipeline`, so a `setQueryData`/refetch it triggers
 * leaves `agents` unchanged here and the user's open target/timeout/prompt edits
 * survive — the two save paths stay independent (#369). A first sync (`prev`
 * undefined) reports every slice changed so the form seeds from the initial load.
 *
 * `repositories` is its own slice since issue #729, when the list moved to the Source
 * Control tab and got its own Save: it and the Settings form are now two independent
 * writes, so folding the list back into `general` would let each one's success refetch
 * reset the other's unsaved edits — the same protection, one tab boundary further out.
 *
 * `boardMappingDraftProviderId` extends that protection one step further for the one
 * slice whose edits span several steps: while a PM provider switch is open (issue #642),
 * the `boardMapping` slice never reports changed, so a background refetch — or another
 * tab's write landing on `pm` — cannot discard a half-built mapping for the incoming
 * provider. It deliberately does not gate the first sync: a draft presupposes a loaded
 * project, so there is none to protect before the form has seeded at all.
 */
export function diffProjectForSync(
	prev: ProjectRecord | undefined,
	next: ProjectRecord,
	boardMappingDraftProviderId?: string,
): ProjectSyncFlags {
	if (!prev) {
		return { general: true, repositories: true, agents: true, pipeline: true, boardMapping: true };
	}
	return {
		general:
			next.name !== prev.name ||
			next.repoRoot !== prev.repoRoot ||
			next.worktreeRoot !== prev.worktreeRoot ||
			next.maxConcurrentJobs !== prev.maxConcurrentJobs,
		repositories: JSON.stringify(next.repositories) !== JSON.stringify(prev.repositories),
		agents: JSON.stringify(next.agents) !== JSON.stringify(prev.agents),
		pipeline: JSON.stringify(next.pipeline) !== JSON.stringify(prev.pipeline),
		boardMapping:
			!boardMappingDraftProviderId && JSON.stringify(next.pm) !== JSON.stringify(prev.pm),
	};
}

/**
 * The route's single serialization gate (`configWriteInFlight`), pulled out to a pure
 * function so its inputs can be pinned in isolation rather than only through a full
 * render. `providerWriteInFlight` is the Source Control tab's SCM provider select
 * (`CredentialsPanel`'s own `providerMutation`, reported up via `onProviderWriteChange`)
 * — it shares `projects.update` with the other two inputs, so it has to hold the gate
 * exactly like they do (issue #369's lost-update shape, re-found across two cards on
 * one tab by #734).
 */
export function isConfigWriteInFlight(flags: {
	updateMutationPending: boolean;
	savingToggleKey: string | undefined;
	providerWriteInFlight: boolean;
}): boolean {
	return (
		flags.updateMutationPending ||
		flags.savingToggleKey !== undefined ||
		flags.providerWriteInFlight
	);
}

/**
 * The Settings tab's own save payload: project identity and host layout alone, never
 * `repositories` — that field is the Source Control tab's own slice, sent by
 * {@link toRepositoriesUpdate} instead (issue #729). Pulled out so this is the one
 * place either payload can be asserted against, rather than only inside the inline
 * `handleSubmit` closure (issue #734's F3).
 */
export function toGeneralSettingsUpdate(
	projectId: string,
	fields: { name: string; repoRoot: string; worktreeRoot: string; maxConcurrentJobs: number },
): { id: string; name: string; repoRoot: string; worktreeRoot: string; maxConcurrentJobs: number } {
	return { id: projectId, ...fields };
}

/**
 * The Source Control tab's repository-list save payload: `repositories` alone, replaced
 * wholesale every time (`projects.update` is a partial patch). `null` when `duplicates`
 * is non-empty — the one list rule with no server-side twin — so the caller's early
 * return is this function's own decision rather than a duplicate check re-stated at
 * the call site.
 */
export function toRepositoriesUpdate(
	projectId: string,
	rows: RepositoryForm[],
	duplicates: string[],
): { id: string; repositories: RepositoryEntry[] } | null {
	if (duplicates.length > 0) return null;
	return { id: projectId, repositories: toRepositoryEntries(rows) };
}

/**
 * The project-detail tabs in display order, each with the icon and label it
 * renders. Ordered to match `PROJECT_TABS` (`lib/project-nav.ts`), which is the
 * URL vocabulary — a test asserts the two agree, so the rendered order and the
 * `?tab=` values can't drift apart.
 */
const PROJECT_TAB_ITEMS: ReadonlyArray<{ tab: ProjectTab; label: string; icon: LucideIcon }> = [
	{ tab: 'runs', label: 'Runs', icon: Play },
	{ tab: 'workers', label: 'Workers', icon: Server },
	{ tab: 'general', label: 'Settings', icon: Settings },
	{ tab: 'agents', label: 'Agent Configuration', icon: Cpu },
	{ tab: 'pipeline', label: 'Pipeline', icon: GitMerge },
	{ tab: 'projectManagement', label: 'Project Management', icon: SquareKanban },
	{ tab: 'credentials', label: 'Source Control', icon: GitBranch },
	{ tab: 'members', label: 'Members', icon: Users },
];

/**
 * The horizontal tab bar, rendered from {@link PROJECT_TAB_ITEMS}. A viewer who does
 * not administer the project is offered only the operational tabs (issue #655): the
 * configuration ones are omitted rather than shown disabled, since there is nothing
 * on them for a non-administrator to read. `ProjectAdminOnly` is the boundary either
 * way — this only avoids drawing a link to a screen it would deny.
 */
export function ProjectTabBar({
	activeTab,
	canAdminister,
	onSelect,
}: {
	activeTab: ProjectTab;
	canAdminister: boolean;
	onSelect: (tab: ProjectTab) => void;
}) {
	const items = canAdminister
		? PROJECT_TAB_ITEMS
		: PROJECT_TAB_ITEMS.filter(({ tab }) => !isProjectAdminTab(tab));
	return (
		<div className="flex border-b border-zinc-800">
			{items.map(({ tab, label, icon: Icon }) => (
				<button
					key={tab}
					type="button"
					onClick={() => onSelect(tab)}
					className={`flex items-center gap-2 px-5 py-3 text-sm font-semibold transition-all border-b-2 ${
						activeTab === tab
							? 'border-violet-500 text-white bg-zinc-800/20'
							: 'border-transparent text-zinc-500 hover:text-zinc-300 hover:border-zinc-800'
					}`}
				>
					<Icon className="h-4 w-4 text-violet-400" />
					{label}
				</button>
			))}
		</div>
	);
}

function ProjectDetailRouteComponent() {
	const { projectId } = projectDetailRoute.useParams();
	// The active tab and the open Agent Configuration phase live in the URL so each
	// transition is a real browser-history entry: opening a phase detail nests it
	// under the Agent Configuration summary, and browser Back returns there rather
	// than escaping to the previous page (issue #210).
	const search = projectDetailRoute.useSearch();
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	const activeTab = resolveActiveTab(search);
	const selectedPhase = search.phase;

	// Switching tabs clears any success/error banner and drops the open phase
	// detail (its search is replaced). Opening/closing a phase preserves the banner
	// — it's a move within the Agent Configuration tab, not a context switch.
	const goToTab = (tab: ProjectTab) => {
		updateMutation.reset();
		navigate({ to: '/projects/$projectId', params: { projectId }, search: tabSearch(tab) });
	};
	const openPhase = (phase: (typeof PHASES)[number]) => {
		navigate({
			to: '/projects/$projectId',
			params: { projectId },
			search: phaseDetailSearch(phase),
		});
	};
	const backToAgentConfig = () => {
		navigate({ to: '/projects/$projectId', params: { projectId }, search: agentConfigSearch() });
	};

	const projectQuery = useQuery({
		...trpc.projects.getById.queryOptions({ id: projectId }),
	});

	/**
	 * Whether this viewer administers the project — the one thing that decides which
	 * tabs the screen offers and renders (issue #655). Read from the server rather
	 * than inferred from the installation role, so a `projectAdmin` who is not an
	 * `instanceAdmin` keeps the configuration tabs and an `instanceAdmin` who is not a
	 * member still gets them.
	 *
	 * `viewerAdministersProject` fails closed on an absent read (still loading, or the
	 * query failed); the load is awaited below alongside the project's, so the
	 * configuration tabs never flash in and back out.
	 */
	const accessQuery = useQuery({
		...trpc.projects.viewerAccess.queryOptions({ projectId }),
	});
	const canAdminister = viewerAdministersProject(accessQuery.data);

	const lastSyncedProjectRef = useRef<typeof project>(undefined);

	const [name, setName] = useState('');
	const [repositories, setRepositories] = useState<RepositoryForm[]>(() => toRepositoryForms([]));
	const [repoRoot, setRepoRoot] = useState('');
	const [worktreeRoot, setWorktreeRoot] = useState('');
	const [maxConcurrentJobs, setMaxConcurrentJobs] = useState('');
	const [maxConcurrentJobsError, setMaxConcurrentJobsError] = useState<string>();

	const [agents, setAgents] = useState<AgentsConfig>({});
	const [pipelineEnabled, setPipelineEnabled] = useState<PipelineEnabledForm>(() =>
		toPipelineEnabledForm(undefined),
	);
	const [pipelineAutoAdvance, setPipelineAutoAdvance] = useState<PipelineAutoAdvanceForm>(() =>
		toPipelineAutoAdvanceForm(undefined),
	);
	const [autoMerge, setAutoMerge] = useState(false);
	const [skipRespondToReviewOnMinors, setSkipRespondToReviewOnMinors] = useState(true);
	const [reviewChecksPolicy, setReviewChecksPolicy] = useState<ReviewChecksPolicy>(() =>
		toReviewChecksPolicyForm(undefined),
	);
	const [boardMapping, setBoardMapping] = useState<BoardMappingForm>(() =>
		toBoardMappingForm(undefined),
	);
	// The review step in front of a provider switch's single write (issue #642); an
	// ordinary mapping edit never opens it.
	const [switchConfirmOpen, setSwitchConfirmOpen] = useState(false);

	const project = projectQuery.data;

	/**
	 * The Project Management tab's provider switch, held entirely client-side (issue
	 * #642): nothing is written until Save, so the project never names a provider whose
	 * mapping is absent or still the previous provider's, and abandoning the flow leaves
	 * the stored configuration exactly as it was.
	 *
	 * Both values are *derived* from the mapping form rather than kept as separate state:
	 * an open draft is precisely "the form selects a provider the project isn't on", so a
	 * successful save closes it by making the two agree and Reset closes it by
	 * reprojecting the form from `project.pm` — with no second copy that could disagree
	 * about which provider is being configured.
	 */
	const pmProviderId = selectedPmProviderId(boardMapping);
	const pmDraftProviderId = useMemo(
		() => switchedPmProviderId(boardMapping, project?.pm),
		[boardMapping, project],
	);

	const handleInputChange =
		(setter: (val: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
			setter(e.target.value);
			setMaxConcurrentJobsError(undefined);
			updateMutation.reset();
		};

	useEffect(() => {
		if (!project) return;
		// Re-sync only the slices that actually changed on the server since the
		// last load. This is what keeps a toggle auto-save (which changes only
		// `pipeline`) from resetting unsaved Agents/Settings/Repository/Board edits when
		// its success `setQueryData` — or any concurrent refetch — updates the cache
		// (#369). See {@link diffProjectForSync}.
		// An open provider switch additionally freezes the `boardMapping` slice, so a
		// refetch can't discard a mapping being built for the incoming provider.
		const changed = diffProjectForSync(lastSyncedProjectRef.current, project, pmDraftProviderId);

		if (changed.general) {
			setName(project.name);
			setRepoRoot(project.repoRoot);
			setWorktreeRoot(project.worktreeRoot ?? '');
			setMaxConcurrentJobs(String(project.maxConcurrentJobs));
			setMaxConcurrentJobsError(undefined);
		}

		if (changed.repositories) {
			setRepositories(toRepositoryForms(project.repositories));
		}

		if (changed.agents) {
			setAgents(normalizeAgentsForDisplay(project.agents ?? {}));
		}

		if (changed.pipeline) {
			setPipelineEnabled(toPipelineEnabledForm(project.pipeline));
			setPipelineAutoAdvance(toPipelineAutoAdvanceForm(project.pipeline));
			setAutoMerge(project.pipeline?.respondToReview?.autoMerge ?? false);
			setSkipRespondToReviewOnMinors(project.pipeline?.respondToReview?.skipOnMinors ?? true);
			setReviewChecksPolicy(toReviewChecksPolicyForm(project.pipeline));
		}

		if (changed.boardMapping) {
			setBoardMapping(toBoardMappingForm(project.pm));
		}

		lastSyncedProjectRef.current = project;
	}, [project, pmDraftProviderId]);

	const updateMutation = useMutation({
		mutationFn: (variables: {
			id: string;
			name?: string;
			repositories?: RepositoryEntry[];
			repoRoot?: string;
			worktreeRoot?: string;
			maxConcurrentJobs?: number;
			agents?: AgentsConfig;
			pipeline?: PipelineConfig;
			pm?: ProjectPm;
		}) => trpcClient.projects.update.mutate(variables),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: trpc.projects.getById.queryOptions({ id: projectId }).queryKey,
			});
			queryClient.invalidateQueries({
				queryKey: trpc.projects.list.queryOptions().queryKey,
			});
		},
	});

	// The Agents-tab Enabled/Auto-advance toggles persist immediately on their own
	// scoped `pipeline`-only mutation, independent of the Save Changes flow above
	// (issue #369). See {@link useToggleAutoSave}.
	const { savingToggleKey, toggleErrorMessage, handleEnabledChange, handleAutoAdvanceChange } =
		useToggleAutoSave({
			projectId,
			pipelineEnabled,
			setPipelineEnabled,
			pipelineAutoAdvance,
			setPipelineAutoAdvance,
			blocked: updateMutation.isPending,
		});

	// CredentialsPanel's own `providerMutation` (the Source Control tab's SCM
	// provider select) also writes `projects.update` directly, outside the Save-Changes
	// flow above — reported here so it shares the gate below rather than racing the
	// Repositories card's Save the way it could before issue #734.
	const [providerWriteInFlight, setProviderWriteInFlight] = useState(false);

	// Single serialization gate for every config write on this route. The
	// Save-Changes flow (`updateMutation`), the Agents-tab toggle auto-save
	// (`useToggleAutoSave`), and the Source Control tab's SCM provider select all
	// read-merge-upsert the project config server-side, so two overlapping writes
	// would let the later upsert clobber the earlier one's change (the re-review's
	// lost-update race, #369, re-found across two cards on one tab by #734).
	// Disabling every Save while any write is in flight — and refusing a toggle or a
	// provider switch while another runs — keeps only one config write outstanding
	// at a time, which removes the race at the source.
	const configWriteInFlight = isConfigWriteInFlight({
		updateMutationPending: updateMutation.isPending,
		savingToggleKey,
		providerWriteInFlight,
	});

	// The Settings tab's own dirty check: project identity and host layout alone. The
	// repository list has its own, since issue #729 gave it its own tab and its own Save.
	const isDirty = useMemo(() => {
		if (!project) return false;
		return (
			name !== project.name ||
			repoRoot !== project.repoRoot ||
			worktreeRoot !== (project.worktreeRoot ?? '') ||
			maxConcurrentJobs !== String(project.maxConcurrentJobs)
		);
	}, [project, name, repoRoot, worktreeRoot, maxConcurrentJobs]);

	const isRepositoriesDirty = useMemo(
		() => (project ? areRepositoriesDirty(repositories, project.repositories) : false),
		[project, repositories],
	);

	// The one list rule with no server-side twin: `assertRepositoriesUnclaimed` refuses a
	// repository *another* project owns, so a list repeating one of its own would be
	// accepted. Surfaced inline and used to block Save, exactly like the Agents tab's
	// duplicate-CLI check. A repository another project owns stays a server CONFLICT,
	// rendered by the repository card's own error banner.
	const duplicateRepos = useMemo(() => duplicateRepositories(repositories), [repositories]);

	const isAgentsDirty = useMemo(() => {
		if (!project) return false;
		const projectAgents = project.agents ?? {};
		const localDefaults = agents.defaults ?? {};
		const dbDefaults = projectAgents.defaults ?? {};
		const hasDefaultChange = (['claude', 'antigravity', 'codex'] as const).some(
			(cli) => (localDefaults[cli] ?? '') !== (dbDefaults[cli] ?? ''),
		);
		if (hasDefaultChange) return true;

		// Only the non-toggle edits gate Save Changes now — the Enabled/Auto-advance
		// toggles auto-save on their own scoped mutation (issue #369), so they're
		// deliberately excluded here and from `handleAgentsSubmit`.
		return PHASES.some((phase) => isPhaseConfigDirty(agents[phase], projectAgents[phase]));
	}, [project, agents]);

	// An over-limit custom prompt — or a duplicate target CLI, which the selectors
	// don't offer but the schema also rejects — would only fail server-side; surface
	// both client-side so Save is blocked and the field error is the sole feedback.
	const hasAgentValidationError = useMemo(
		() =>
			anyCustomPromptError(PHASES.map((phase) => agents[phase]?.prompt)) ||
			PHASES.some((phase) => hasDuplicateCli(agents[phase]?.targets ?? [])),
		[agents],
	);

	const isPipelineDirty = useMemo(
		() =>
			autoMerge !== (project?.pipeline?.respondToReview?.autoMerge ?? false) ||
			skipRespondToReviewOnMinors !== (project?.pipeline?.respondToReview?.skipOnMinors ?? true) ||
			isReviewChecksPolicyDirty(reviewChecksPolicy, project?.pipeline),
		[project, autoMerge, skipRespondToReviewOnMinors, reviewChecksPolicy],
	);

	const isBoardMappingFormDirty = useMemo(
		() => isBoardMappingDirty(boardMapping, project?.pm),
		[boardMapping, project],
	);

	/** Every repository-list edit goes through here, so each one also clears the banner. */
	const updateRepositories = (update: (rows: RepositoryForm[]) => RepositoryForm[]) => {
		setRepositories(update);
		updateMutation.reset();
	};

	const handleRepositoryChange = (index: number, patch: Partial<Omit<RepositoryForm, 'id'>>) =>
		updateRepositories((rows) => patchRepository(rows, index, patch));

	const handleAddRepository = () => updateRepositories(addRepository);

	const handleRemoveRepository = (index: number) =>
		updateRepositories((rows) => removeRepository(rows, index));

	const handleMoveRepository = (index: number, direction: 'up' | 'down') =>
		updateRepositories((rows) => moveRepository(rows, index, direction));

	/** Replace one phase's ordered target list, leaving its other fields untouched. */
	const updateTargets = (
		phase: keyof AgentsConfig,
		update: (targets: AgentTarget[]) => AgentTarget[],
	) => {
		setAgents((prev) => {
			const current = (prev[phase] ?? {}) as AgentConfig;
			// `toTargetList` is what the screen renders, so an edit starts from exactly
			// the list the user sees — including one projected from a legacy selection.
			return { ...prev, [phase]: { ...current, targets: update(toTargetList(current)) } };
		});
		updateMutation.reset();
	};

	const handleTargetChange = (
		phase: keyof AgentsConfig,
		index: number,
		patch: Partial<AgentTarget>,
	) => updateTargets(phase, (targets) => patchTarget(targets, index, patch));

	const handleAddTarget = (phase: keyof AgentsConfig) => updateTargets(phase, addTarget);

	const handleRemoveTarget = (phase: keyof AgentsConfig, index: number) =>
		updateTargets(phase, (targets) => removeTarget(targets, index));

	const handleMoveTarget = (phase: keyof AgentsConfig, index: number, direction: 'up' | 'down') =>
		updateTargets(phase, (targets) => moveTarget(targets, index, direction));

	const handleTimeoutChange = (phase: keyof AgentsConfig, value: string) => {
		// The field edits whole minutes; the config stores milliseconds.
		setAgents((prev) => ({
			...prev,
			[phase]: { ...prev[phase], timeoutMs: Number(value) * 60 * 1000 },
		}));
		updateMutation.reset();
	};

	const handlePromptChange = (phase: keyof AgentsConfig, value: string) => {
		// Store the raw textarea value while editing; it's trimmed/dropped-if-blank
		// on save and in the dirty check (issue #135).
		setAgents((prev) => ({
			...prev,
			[phase]: { ...prev[phase], prompt: value },
		}));
		updateMutation.reset();
	};

	const handleAgentsReset = () => {
		if (project) {
			// Resets only the non-toggle edits the Save Changes button owns; the
			// toggles auto-save and already reflect the stored state (issue #369).
			setAgents(normalizeAgentsForDisplay(project.agents ?? {}));
			updateMutation.reset();
		}
	};

	const handleAgentsSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		// Save is disabled while the form holds an invalid value, but guard here too so
		// an Enter-to-submit from a field can't bypass the client-side check (issue #135).
		if (hasAgentValidationError) return;
		// Serialize against an in-flight toggle auto-save (#369); the button is also
		// disabled, this covers Enter-to-submit.
		if (configWriteInFlight) return;
		const finalAgents = cleanAgentsConfig(agents);
		// Only `agents` — the Enabled/Auto-advance toggles persist immediately via
		// `useToggleAutoSave`, so Save Changes must not re-send (or stomp) their state
		// (issue #369).
		updateMutation.mutate({
			id: projectId,
			agents: finalAgents,
		});
	};

	const handlePipelineSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (configWriteInFlight) return;
		updateMutation.mutate({
			id: projectId,
			pipeline: {
				review: { checks: reviewChecksPolicy },
				respondToReview: {
					autoMerge,
					skipOnMinors: skipRespondToReviewOnMinors,
				},
			},
		});
	};

	const handlePipelineReset = () => {
		setAutoMerge(project?.pipeline?.respondToReview?.autoMerge ?? false);
		setSkipRespondToReviewOnMinors(project?.pipeline?.respondToReview?.skipOnMinors ?? true);
		setReviewChecksPolicy(toReviewChecksPolicyForm(project?.pipeline));
		updateMutation.reset();
	};

	const handleBoardMappingProvider = (providerId: string) => {
		// Selecting the provider the project is already on cancels an open switch, so it
		// restores the stored mapping rather than blanking the form the way a *move* to
		// another provider does.
		setBoardMapping((prev) =>
			providerId === project?.pm.type
				? toBoardMappingForm(project.pm)
				: withSelectedProvider(prev, providerId),
		);
		updateMutation.reset();
	};

	const handleBoardMappingSelectContainer = (containerId: string) => {
		// Switching boards clears the previous board's state mappings and its
		// container-scoped provider context, so option/field IDs from one board can't be
		// saved against another; context that describes the *site* rather than the board
		// (Jira's base URL) survives.
		setBoardMapping((prev) => withSelectedContainer(prev, containerId));
		updateMutation.reset();
	};

	const handleBoardMappingStatusOption = (key: PmStatusKey, value: string) => {
		setBoardMapping((prev) => ({
			...prev,
			statusOptions: { ...prev.statusOptions, [key]: value },
		}));
		updateMutation.reset();
	};

	const handleBoardMappingProviderContext = (key: string, value: string) => {
		setBoardMapping((prev) => withProviderContext(prev, key, value));
		updateMutation.reset();
	};

	const handleBoardMappingStatesContext = (context: Record<string, string>) => {
		setBoardMapping((prev) => ({ ...prev, providerContext: context }));
	};

	// Reset already reprojects from the stored member, which is also what drops an open
	// provider switch: the form goes back to the persisted provider and its mapping.
	const handleBoardMappingReset = () => {
		setBoardMapping(toBoardMappingForm(project?.pm));
		setSwitchConfirmOpen(false);
		updateMutation.reset();
	};

	/**
	 * The single `projects.update` write that persists the mapping — the whole new `pm`
	 * union member, discriminator included, so a provider switch is one atomic change
	 * rather than a sequence with an invalid state in the middle. `buildPmUpdate` reads
	 * nothing from the outgoing member across a switch, and `credentials.pm` is untouched
	 * here, so the outgoing provider's credentials are retained.
	 */
	const saveBoardMapping = () => {
		setSwitchConfirmOpen(false);
		updateMutation.mutate({
			id: projectId,
			pm: buildPmUpdate(boardMapping, project?.pm),
		});
	};

	const handleBoardMappingSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (configWriteInFlight) return;
		// A provider switch has consequences the form can't show (retained credentials,
		// in-flight runs left pointing at the outgoing board), so it is reviewed first.
		if (pmDraftProviderId) {
			setSwitchConfirmOpen(true);
			return;
		}
		saveBoardMapping();
	};

	const handleReset = () => {
		if (project) {
			setName(project.name);
			setRepoRoot(project.repoRoot);
			setWorktreeRoot(project.worktreeRoot ?? '');
			setMaxConcurrentJobs(String(project.maxConcurrentJobs));
			setMaxConcurrentJobsError(undefined);
			updateMutation.reset();
		}
	};

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (configWriteInFlight) return;
		const parsedMaxConcurrentJobs = Number(maxConcurrentJobs);
		if (!Number.isInteger(parsedMaxConcurrentJobs) || parsedMaxConcurrentJobs < 1) {
			setMaxConcurrentJobsError('Maximum concurrent jobs must be a positive whole number.');
			return;
		}
		setMaxConcurrentJobsError(undefined);
		// Only this tab's four fields: the repository list saves itself from the Source
		// Control tab (issue #729), so sending it here would carry its unsaved edits.
		updateMutation.mutate(
			toGeneralSettingsUpdate(projectId, {
				name,
				repoRoot,
				worktreeRoot,
				maxConcurrentJobs: parsedMaxConcurrentJobs,
			}),
		);
	};

	const handleRepositoriesReset = () => {
		if (project) {
			setRepositories(toRepositoryForms(project.repositories));
			updateMutation.reset();
		}
	};

	const handleRepositoriesSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (configWriteInFlight) return;
		// `toRepositoriesUpdate` holds the duplicate-repository guard itself (`null` when
		// `duplicateRepos` is non-empty) — belt-and-braces alongside Save's own `disabled`,
		// so an Enter-to-submit from a field can't bypass it (the same pattern the Agents
		// tab's duplicate-CLI check uses).
		const update = toRepositoriesUpdate(projectId, repositories, duplicateRepos);
		if (!update) return;
		updateMutation.mutate(update);
	};

	// Both loads gate the screen: rendering before the viewer's access resolves would
	// show the tab bar and the resolved tab as a non-administrator's for a frame, then
	// swap them (issue #655). The two queries run in parallel, so this costs no round trip.
	if ([projectQuery, accessQuery].some((query) => query.isLoading)) {
		return <div className="text-sm text-zinc-400">Loading project settings…</div>;
	}

	if (projectQuery.isError) {
		return (
			<div className="p-4 bg-red-950/20 border border-red-900/30 rounded flex flex-col gap-2">
				<h3 className="text-sm font-semibold text-red-200">Error Loading Project</h3>
				<p className="text-xs text-red-400/80 font-mono">{projectQuery.error.message}</p>
				<Link
					to="/projects"
					className="text-xs font-semibold text-zinc-300 hover:text-white transition-colors underline mt-2 inline-block"
				>
					Back to Projects
				</Link>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			{/* Breadcrumb */}
			<div className="text-xs font-mono text-zinc-500">
				<Link to="/projects" className="hover:text-zinc-300 transition-colors">
					projects
				</Link>{' '}
				/ <span className="text-zinc-300 font-semibold select-all">{projectId}</span>
			</div>

			{/* Page Title */}
			<div>
				<h1 className="text-2xl font-semibold tracking-tight text-zinc-100">
					{project?.name || 'Project Settings'}
				</h1>
				<p className="text-xs text-zinc-500 mt-1 font-mono">{projectId}</p>
			</div>

			{/* Horizontal Tab Bar */}
			<ProjectTabBar activeTab={activeTab} canAdminister={canAdminister} onSelect={goToTab} />

			{/* Runs and Workers are the project-scoped operational views every enrolled
			    member keeps (issue #655); everything below `ProjectAdminOnly` configures
			    the project or manages its credentials, and is the administrator's alone. */}
			{activeTab === 'runs' && <ProjectRunsPanel projectId={projectId} />}

			{/* This project's worker roster (issue #574) — the same component `/workers`
			    renders, scoped server-side to the machines enrolled here. An
			    administrator additionally reorders the project's dispatch preference
			    here (issue #750 phase 2); `canAdminister` fails closed while
			    `projects.viewerAccess` loads, and the mutation re-checks it server-side. */}
			{activeTab === 'workers' && (
				<WorkersRoster projectId={projectId} canReorder={canAdminister} />
			)}

			<ProjectAdminOnly tab={activeTab} canAdminister={canAdminister}>
				{/* Form Card - General Settings. Project identity and host layout; the
				    repository list is on the Source Control tab (issue #729). */}
				{activeTab === 'general' && (
					<GeneralSettingsForm
						name={name}
						repoRoot={repoRoot}
						worktreeRoot={worktreeRoot}
						maxConcurrentJobs={maxConcurrentJobs}
						maxConcurrentJobsError={maxConcurrentJobsError}
						setName={setName}
						setRepoRoot={setRepoRoot}
						setWorktreeRoot={setWorktreeRoot}
						setMaxConcurrentJobs={setMaxConcurrentJobs}
						handleInputChange={handleInputChange}
						handleSubmit={handleSubmit}
						handleReset={handleReset}
						isDirty={isDirty}
						isPending={configWriteInFlight}
						isSuccess={updateMutation.isSuccess}
						isError={updateMutation.isError}
						errorMessage={updateMutation.error?.message}
					/>
				)}

				{/* Form Card - Agent Configuration */}
				{activeTab === 'agents' && (
					<AgentConfigurationForm
						agents={agents}
						pipelineEnabled={pipelineEnabled}
						pipelineAutoAdvance={pipelineAutoAdvance}
						selectedPhase={selectedPhase}
						onSelectPhase={openPhase}
						onBack={backToAgentConfig}
						handleEnabledChange={handleEnabledChange}
						handleAutoAdvanceChange={handleAutoAdvanceChange}
						handleTargetChange={handleTargetChange}
						handleAddTarget={handleAddTarget}
						handleRemoveTarget={handleRemoveTarget}
						handleMoveTarget={handleMoveTarget}
						handleTimeoutChange={handleTimeoutChange}
						handlePromptChange={handlePromptChange}
						handleSubmit={handleAgentsSubmit}
						handleReset={handleAgentsReset}
						isDirty={isAgentsDirty}
						hasValidationError={hasAgentValidationError}
						isPending={configWriteInFlight}
						isSuccess={updateMutation.isSuccess}
						isError={updateMutation.isError}
						errorMessage={updateMutation.error?.message}
						savingToggleKey={savingToggleKey}
						toggleErrorMessage={toggleErrorMessage}
					/>
				)}

				{activeTab === 'pipeline' && (
					<PipelineSettingsForm
						autoMerge={autoMerge}
						setAutoMerge={(value) => {
							setAutoMerge(value);
							updateMutation.reset();
						}}
						skipRespondToReviewOnMinors={skipRespondToReviewOnMinors}
						setSkipRespondToReviewOnMinors={(value) => {
							setSkipRespondToReviewOnMinors(value);
							updateMutation.reset();
						}}
						reviewChecksPolicy={reviewChecksPolicy}
						setReviewChecksPolicy={(value) => {
							setReviewChecksPolicy(value);
							updateMutation.reset();
						}}
						handleSubmit={handlePipelineSubmit}
						handleReset={handlePipelineReset}
						isDirty={isPipelineDirty}
						isPending={configWriteInFlight}
						isSuccess={updateMutation.isSuccess}
						isError={updateMutation.isError}
						errorMessage={updateMutation.error?.message}
					/>
				)}

				{/*
				 * Project Management (issue #537): one tab, four coherent cards in the order
				 * the settings depend on each other — the provider (issue #630), then its
				 * declared credentials, then the board picker, then the status mapping. The
				 * provider and credential panels own their own queries, so they render above
				 * the mapping form rather than inside it.
				 *
				 * That order *is* the provider switch (issue #642): the same four cards, scoped
				 * to the draft provider and each staged behind its predecessor, are what resolve
				 * the circular dependency between "which provider" and "which board" — no wizard,
				 * and no invalid intermediate write, since the whole new member goes in one save.
				 */}
				{activeTab === 'projectManagement' && (
					<div className="space-y-6">
						<PmProviderPanel
							projectId={projectId}
							providerId={boardMapping.providerId}
							persistedProviderId={project?.pm.type ?? boardMapping.providerId}
							onProviderChange={handleBoardMappingProvider}
							isPending={configWriteInFlight}
						/>
						{/* Scoped to the draft provider while a switch is open, so the incoming
					    provider's own roles are entered — and its boards discovered — before the
					    switch is written (issue #641's provider parameter). */}
						<PmCredentialsPanel projectId={projectId} providerId={pmProviderId} />
						<BoardMappingPanel
							projectId={projectId}
							form={boardMapping}
							onSelectContainer={handleBoardMappingSelectContainer}
							onStatusOptionChange={handleBoardMappingStatusOption}
							onProviderContextChange={handleBoardMappingProviderContext}
							onStatesContext={handleBoardMappingStatesContext}
							handleSubmit={handleBoardMappingSubmit}
							handleReset={handleBoardMappingReset}
							isDirty={isBoardMappingFormDirty}
							isPending={configWriteInFlight}
							isSuccess={updateMutation.isSuccess}
							isError={updateMutation.isError}
							errorMessage={updateMutation.error?.message}
						/>
						<PmProviderSwitchDialog
							open={switchConfirmOpen && !!pmDraftProviderId}
							fromProviderId={project?.pm.type ?? ''}
							toProviderId={pmDraftProviderId ?? ''}
							isPending={configWriteInFlight}
							onConfirm={saveBoardMapping}
							onCancel={() => setSwitchConfirmOpen(false)}
						/>
					</div>
				)}

				{/*
				 * Source Control (issues #200, #632, #729): the provider, the credentials it
				 * authenticates with, then the repositories it operates on — one screen for
				 * "which provider, authenticated how, operating on what", the top-to-bottom
				 * order issue #630 gave Project Management.
				 *
				 * The two cards save independently, as they already did before the list arrived:
				 * the provider selector and each credential field persist on their own scoped
				 * write, and the repository list has its own Save sending `repositories` alone.
				 * `CredentialsPanel` owns its queries and its own loading gate, so it stays a
				 * sibling rather than wrapping the list — a slow credential read must not blank
				 * the editor below it. The provider selector's own write shares `projects.update`
				 * with the list's Save though, so it is not independent of the route's single
				 * serialization gate the way the per-role credential fields are (those write a
				 * separate credentials store): `onProviderWriteChange` reports it into
				 * `configWriteInFlight`, and `externalWriteInFlight` disables the selector back
				 * while the list's own Save (or any other write on this route) is in flight
				 * (issue #734).
				 */}
				{activeTab === 'credentials' && (
					<div className="space-y-6">
						<CredentialsPanel
							projectId={projectId}
							externalWriteInFlight={updateMutation.isPending || savingToggleKey !== undefined}
							onProviderWriteChange={setProviderWriteInFlight}
						/>
						<RepositoriesPanel
							repositories={repositories}
							duplicates={duplicateRepos}
							onChange={handleRepositoryChange}
							onAdd={handleAddRepository}
							onRemove={handleRemoveRepository}
							onMove={handleMoveRepository}
							handleSubmit={handleRepositoriesSubmit}
							handleReset={handleRepositoriesReset}
							isDirty={isRepositoriesDirty}
							isPending={configWriteInFlight}
							isSuccess={updateMutation.isSuccess}
							isError={updateMutation.isError}
							errorMessage={updateMutation.error?.message}
						/>
					</div>
				)}

				{/*
				 * Members (issue #806): the project's own roster, administered here instead of
				 * only from the machine holding `DATABASE_URL`. The panel owns its query and
				 * its three writes, so the route hands it nothing but the project id — and no
				 * `canAdminister`, since this frame is already the boundary and every `members`
				 * procedure re-asserts `projectAdmin` for itself.
				 */}
				{activeTab === 'members' && <MembersPanel projectId={projectId} />}
			</ProjectAdminOnly>
		</div>
	);
}

export const projectDetailRoute = createRoute({
	getParentRoute: () => rootRoute,
	path: '/projects/$projectId',
	validateSearch: (search) => projectDetailSearchSchema.parse(search),
	component: ProjectDetailRouteComponent,
});
