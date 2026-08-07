import type { ProjectPm } from '../../../src/config/schema.js';
import { PM_STATUS_KEYS, type PmStatusKey } from '../../../src/pm/pipeline.js';

/**
 * The board/status mapping form's editable state (the Project Management tab's
 * second half) — provider-neutral now that the
 * screen discovers boards and states through the `pm` API instead of asking the
 * operator to type GitHub node IDs (issue #201). It holds the selected provider
 * and container (board), one discovered-state ID per canonical pipeline status,
 * and an opaque `providerContext` the provider threads through save time
 * (GitHub Projects stores the discovered Status *field* ID there). It is
 * projected to/from the project's persisted {@link ProjectPm} member by the
 * adapter helpers below rather than the component reaching into config internals.
 */
export interface BoardMappingForm {
	/** Selected PM provider id — the project's `pm.type`. */
	providerId: string;
	/**
	 * Selected board/container opaque id — a Projects v2 node ID for GitHub, a team
	 * UUID for Linear. Blank = unselected.
	 */
	containerId: string;
	/** Discovered state id per canonical status; blank = unmapped. */
	statusOptions: Record<PmStatusKey, string>;
	/**
	 * Opaque provider scope carried from state discovery to save time — for GitHub
	 * Projects `{ statusFieldId }`; empty for a provider whose state ids are the whole
	 * mapping, such as Linear. Cleared when the selected container or provider
	 * changes so one board's field id can't be saved against another.
	 */
	providerContext: Record<string, string>;
}

type GitHubProjectsPm = Extract<ProjectPm, { type: 'github-projects' }>;
type LinearPm = Extract<ProjectPm, { type: 'linear' }>;

/**
 * The six canonical pipeline status keys (`PM_STATUS_KEYS` — the single source
 * of truth in `src/pm/pipeline.ts`) paired with the display labels the board
 * uses for them (ai/RULES.md §5). `todo` surfaces as "Ready" to match the live
 * board's option name; the key itself stays canonical.
 */
export const STATUS_KEY_LABELS: Readonly<Record<PmStatusKey, string>> = {
	backlog: 'Backlog',
	planning: 'Planning',
	todo: 'Ready',
	inProgress: 'In progress',
	inReview: 'In review',
	done: 'Done',
};

/** Ordered status keys for stable field rendering (pipeline order, not object order). */
export const STATUS_KEYS = PM_STATUS_KEYS;

/**
 * A PM provider the mapping form's selector can offer, with the human-readable
 * nouns its pickers use. UI-only catalogue, analogous to `SCM_PROVIDERS` in
 * `credentials.ts`: it makes the selector and its copy data-driven off the
 * selected provider rather than embedding GitHub vocabulary throughout the
 * shared panel. Register a provider here the day its dashboard mapping lands;
 * whether it is actually selectable is confirmed against the registry
 * (`pm.listProviders`), so a catalogue entry alone never offers a provider the
 * backend can't discover.
 */
export interface PmMappingProvider {
	id: string;
	/** Provider display name for the selector and headings. */
	label: string;
	/** Noun for a board/container (e.g. "board", "project"), used in picker copy. */
	containerNoun: string;
	/** Plural of {@link containerNoun}, used in picker copy. */
	containerNounPlural: string;
	/** Noun for a workflow state (e.g. "status", "column"), used in picker copy. */
	stateNoun: string;
	/**
	 * Plural of {@link stateNoun}. Carried as data rather than suffixed at the call
	 * site because English plurals aren't a suffix: "status" → "statuses" but
	 * "workflow state" → "workflow states".
	 */
	stateNounPlural: string;
	/**
	 * One-line explanation of what the mapping does. It names *where* the credential
	 * discovery uses is configured, never which one — since issue #537 that is the
	 * provider's own declared role, rendered by the Credentials section above.
	 */
	intro: string;
}

export const PM_MAPPING_PROVIDERS: readonly PmMappingProvider[] = [
	{
		id: 'github-projects',
		label: 'GitHub Projects',
		containerNoun: 'board',
		containerNounPlural: 'boards',
		stateNoun: 'status',
		stateNounPlural: 'statuses',
		intro:
			"Pick this project's GitHub Projects (v2) board, then map each SWARM pipeline status to one of the board's Status options. Boards and options are discovered server-side with this project's own board credential, configured under Credentials above — no node IDs to copy by hand.",
	},
	{
		id: 'linear',
		label: 'Linear',
		containerNoun: 'team',
		containerNounPlural: 'teams',
		stateNoun: 'workflow state',
		stateNounPlural: 'workflow states',
		intro:
			"Pick this project's Linear team, then map each SWARM pipeline status to one of the team's workflow states. Teams and states are discovered server-side with this project's own board credential, configured under Credentials above.",
	},
];

export const DEFAULT_PM_PROVIDER_ID = PM_MAPPING_PROVIDERS[0].id;

/** The catalogue entry for a provider id, or the default provider's entry when unknown. */
export function getPmMappingProvider(providerId: string): PmMappingProvider {
	return PM_MAPPING_PROVIDERS.find((p) => p.id === providerId) ?? PM_MAPPING_PROVIDERS[0];
}

/**
 * The catalogue id the form's selection actually resolves to — an unknown id falls
 * back to the default provider, exactly as the panel's copy does. Every helper
 * below branches on this rather than on `form.providerId` directly, so the member
 * that gets built and the rules that gate saving it can never disagree about which
 * provider is being edited.
 */
function selectedProviderId(form: BoardMappingForm): string {
	return getPmMappingProvider(form.providerId).id;
}

/**
 * Whether the selected provider threads an opaque Status *field* id through
 * `providerContext`. GitHub Projects' option ids are scoped to one single-select
 * field, so its mapping is incomplete without that id; Linear's workflow-state
 * UUID is the whole mapping and its state discovery deliberately returns no
 * context, so a Linear mapping must not be gated on one.
 */
function usesStatusFieldContext(form: BoardMappingForm): boolean {
	return selectedProviderId(form) === 'github-projects';
}

/** An empty option map with every canonical key present, for seeding blank state. */
export function blankStatusOptions(): Record<PmStatusKey, string> {
	return Object.fromEntries(STATUS_KEYS.map((key) => [key, ''])) as Record<PmStatusKey, string>;
}

/** Reset provider-scoped selections before moving the form to another provider. */
export function withSelectedProvider(form: BoardMappingForm, providerId: string): BoardMappingForm {
	if (form.providerId === providerId) return form;
	return {
		...form,
		providerId,
		containerId: '',
		statusOptions: blankStatusOptions(),
		providerContext: {},
	};
}

/**
 * Project the project's stored `pm` member onto the provider-neutral form,
 * filling a blank for any status key the board hasn't mapped so every selector
 * is controlled. The selected provider comes from the member's own `type`
 * discriminator (issue #495) — the mapping and the provider it belongs to are one
 * value now, so the form no longer takes them as two arguments.
 *
 * `statusOptions` is an open record on the config (a board may carry
 * non-canonical keys); only the canonical keys are surfaced here. The stored
 * Status field id is carried in `providerContext` so a saved mapping survives a
 * round-trip even when discovery can't currently reach the board.
 *
 * Provider-specific fields are read only after narrowing: the neutral
 * `containerId` is GitHub's board node id or Linear's team UUID depending on the
 * member, and `providerContext` stays GitHub-only because only GitHub Projects
 * has a second id to carry (issue #531).
 */
export function toBoardMappingForm(pm: ProjectPm | undefined): BoardMappingForm {
	const githubProjects = pm?.type === 'github-projects' ? pm : undefined;
	const linear = pm?.type === 'linear' ? pm : undefined;
	const statusOptions = blankStatusOptions();
	for (const key of STATUS_KEYS) {
		const value = pm?.statusOptions?.[key];
		if (value) statusOptions[key] = value;
	}
	return {
		providerId: pm?.type ?? DEFAULT_PM_PROVIDER_ID,
		containerId: githubProjects?.projectId ?? linear?.teamId ?? '',
		statusOptions,
		providerContext: githubProjects?.statusFieldId
			? { statusFieldId: githubProjects.statusFieldId }
			: {},
	};
}

/** Drop blank option entries so a cleared selector isn't persisted as an empty string. */
export function cleanStatusOptions(
	statusOptions: Record<PmStatusKey, string>,
): Record<string, string> {
	const clean: Record<string, string> = {};
	for (const key of STATUS_KEYS) {
		const value = statusOptions[key]?.trim();
		if (value) clean[key] = value;
	}
	return clean;
}

/**
 * Build the `pm` payload for `projects.update` from the form state, preserving any
 * `phaseLabels` already on the stored config — the mapping screen doesn't edit
 * those, so they must survive a save unchanged.
 *
 * The payload is a whole `pm` union member, discriminator included: the mapping is
 * only meaningful under the provider it maps (issue #495). Which member gets built
 * follows the *form's* selected provider, and each branch reads only the neutral
 * fields plus what its own schema declares — nothing from `existing` crosses a
 * provider switch, so a Linear team id can never land in a `github-projects`
 * member or a board node id in a Linear one.
 */
export function buildPmUpdate(form: BoardMappingForm, existing: ProjectPm | undefined): ProjectPm {
	const containerId = form.containerId.trim();
	const statusOptions = cleanStatusOptions(form.statusOptions);
	if (selectedProviderId(form) === 'linear') {
		const linear: LinearPm = { type: 'linear', teamId: containerId, statusOptions };
		return linear;
	}
	// `phaseLabels` is GitHub Projects' own field and this screen doesn't edit it, so
	// it survives a save — but only when the stored member is that same provider's.
	const githubProjects = existing?.type === 'github-projects' ? existing : undefined;
	const update: GitHubProjectsPm = {
		type: 'github-projects',
		projectId: containerId,
		statusFieldId: (form.providerContext.statusFieldId ?? '').trim(),
		statusOptions,
		...(githubProjects?.phaseLabels ? { phaseLabels: githubProjects.phaseLabels } : {}),
	};
	return update;
}

/**
 * Whether the form differs from the stored config, compared semantically after
 * normalization (selected provider, selected container, and each mapped status).
 * The Status field context is compared only for GitHub Projects — it is that
 * provider's own field, so a provider that returns none would otherwise read as
 * permanently clean or permanently dirty against a stored GitHub mapping.
 */
export function isBoardMappingDirty(form: BoardMappingForm, pm: ProjectPm | undefined): boolean {
	const stored = toBoardMappingForm(pm);
	if (selectedProviderId(form) !== stored.providerId) return true;
	if (form.containerId.trim() !== stored.containerId) return true;
	if (
		usesStatusFieldContext(form) &&
		(form.providerContext.statusFieldId ?? '').trim() !==
			(stored.providerContext.statusFieldId ?? '')
	)
		return true;
	return STATUS_KEYS.some(
		(key) => (form.statusOptions[key]?.trim() ?? '') !== stored.statusOptions[key],
	);
}

/**
 * Whether the form can be saved: a container is selected and at least one
 * canonical status is mapped — matching every provider schema's "at least one
 * option" minimum (`githubProjectsConfigSchema`, `linearConfigSchema`) rather than
 * requiring every status be mapped — plus, for GitHub Projects alone, a known
 * Status-field context. The route additionally gates Save on the form being dirty
 * and no other config write being in flight.
 */
export function canSaveBoardMapping(form: BoardMappingForm): boolean {
	if (!form.containerId.trim()) return false;
	if (usesStatusFieldContext(form) && !(form.providerContext.statusFieldId ?? '').trim())
		return false;
	return STATUS_KEYS.some((key) => !!form.statusOptions[key]?.trim());
}
