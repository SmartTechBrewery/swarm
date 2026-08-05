import type { ProjectPm } from '../../../src/config/schema.js';
import { PM_STATUS_KEYS, type PmStatusKey } from '../../../src/pm/pipeline.js';

/**
 * The Board Mapping screen's editable state — provider-neutral now that the
 * screen discovers boards and states through the `pm` API instead of asking the
 * operator to type GitHub node IDs (issue #201). It holds the selected provider
 * and container (board), one discovered-state ID per canonical pipeline status,
 * and an opaque `providerContext` the provider threads through save time
 * (GitHub Projects stores the discovered Status *field* ID there). It is
 * projected to/from the project's persisted {@link ProjectPm} member by the
 * adapter helpers below rather than the component reaching into config internals.
 */
export interface BoardMappingForm {
	/** Selected PM provider id — the project's `pm.type` (only `github-projects` today). */
	providerId: string;
	/** Selected board/container opaque id (a Projects v2 node ID for GitHub). Blank = unselected. */
	containerId: string;
	/** Discovered state id per canonical status; blank = unmapped. */
	statusOptions: Record<PmStatusKey, string>;
	/**
	 * Opaque provider scope carried from state discovery to save time — for GitHub
	 * Projects `{ statusFieldId }`. Cleared when the selected board changes so a
	 * different board's field id can't be saved against it.
	 */
	providerContext: Record<string, string>;
}

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
 * A PM provider the Board Mapping selector can offer, with the human-readable
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
	/** Noun for a workflow state (e.g. "status", "column"), used in picker copy. */
	stateNoun: string;
	/** One-line explanation of what the mapping does and which credential discovery uses. */
	intro: string;
}

export const PM_MAPPING_PROVIDERS: readonly PmMappingProvider[] = [
	{
		id: 'github-projects',
		label: 'GitHub Projects',
		containerNoun: 'board',
		stateNoun: 'status',
		intro:
			"Pick this project's GitHub Projects (v2) board, then map each SWARM pipeline status to one of the board's Status options. Boards and options are discovered with the implementer token configured on the Source Control tab — no node IDs to copy by hand.",
	},
];

export const DEFAULT_PM_PROVIDER_ID = PM_MAPPING_PROVIDERS[0].id;

/** The catalogue entry for a provider id, or the default provider's entry when unknown. */
export function getPmMappingProvider(providerId: string): PmMappingProvider {
	return PM_MAPPING_PROVIDERS.find((p) => p.id === providerId) ?? PM_MAPPING_PROVIDERS[0];
}

/** An empty option map with every canonical key present, for seeding blank state. */
export function blankStatusOptions(): Record<PmStatusKey, string> {
	return Object.fromEntries(STATUS_KEYS.map((key) => [key, ''])) as Record<PmStatusKey, string>;
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
 * Reading the GitHub-Projects fields directly is sound while `ProjectPm` has one
 * member: a second provider maps its own container/state ids to this same neutral
 * form here, alongside its dashboard mapping.
 */
export function toBoardMappingForm(pm: ProjectPm | undefined): BoardMappingForm {
	const statusOptions = blankStatusOptions();
	for (const key of STATUS_KEYS) {
		const value = pm?.statusOptions?.[key];
		if (value) statusOptions[key] = value;
	}
	return {
		providerId: pm?.type ?? DEFAULT_PM_PROVIDER_ID,
		containerId: pm?.projectId ?? '',
		statusOptions,
		providerContext: pm?.statusFieldId ? { statusFieldId: pm.statusFieldId } : {},
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
 * only meaningful under the provider it maps (issue #495). The member built here
 * is GitHub Projects' — the same one-member note on {@link toBoardMappingForm}
 * applies, and a second provider builds its own from the neutral form.
 */
export function buildPmUpdate(form: BoardMappingForm, existing: ProjectPm | undefined): ProjectPm {
	return {
		type: 'github-projects',
		projectId: form.containerId.trim(),
		statusFieldId: (form.providerContext.statusFieldId ?? '').trim(),
		statusOptions: cleanStatusOptions(form.statusOptions),
		...(existing?.phaseLabels ? { phaseLabels: existing.phaseLabels } : {}),
	};
}

/**
 * Whether the form differs from the stored config, compared semantically after
 * normalization (selected board, discovered Status field context, and each
 * mapped status). The provider selector is excluded — GitHub Projects is the
 * only selectable provider and it isn't persisted independently of the mapping.
 */
export function isBoardMappingDirty(form: BoardMappingForm, pm: ProjectPm | undefined): boolean {
	const stored = toBoardMappingForm(pm);
	if (form.containerId.trim() !== stored.containerId) return true;
	if (
		(form.providerContext.statusFieldId ?? '').trim() !==
		(stored.providerContext.statusFieldId ?? '')
	)
		return true;
	return STATUS_KEYS.some(
		(key) => (form.statusOptions[key]?.trim() ?? '') !== stored.statusOptions[key],
	);
}

/**
 * Whether the form can be saved: a board is selected, its Status-field context
 * is known, and at least one canonical status is mapped — matching the persisted
 * schema's "at least one option" minimum (`githubProjectsConfigSchema`) rather
 * than requiring every status be mapped. The route additionally gates Save on
 * the form being dirty and no other config write being in flight.
 */
export function canSaveBoardMapping(form: BoardMappingForm): boolean {
	if (!form.containerId.trim()) return false;
	if (!(form.providerContext.statusFieldId ?? '').trim()) return false;
	return STATUS_KEYS.some((key) => !!form.statusOptions[key]?.trim());
}
