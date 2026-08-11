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
	 * UUID for Linear, a project key for Jira, a board id for Trello. Blank =
	 * unselected.
	 */
	containerId: string;
	/** Discovered state id per canonical status; blank = unmapped. */
	statusOptions: Record<PmStatusKey, string>;
	/**
	 * Opaque provider scope carried through to save time — for GitHub Projects the
	 * `{ statusFieldId }` state discovery returns, for Jira the `{ baseUrl }` the
	 * stored mapping was read with; empty for a provider whose state ids are the
	 * whole mapping, such as Linear. Cleared on a provider switch so one provider's
	 * scope can't be saved as another's, and its *container-scoped* half (GitHub's
	 * field id) is cleared on a container switch too — a site URL is not a property
	 * of the selected container, so it survives that (see
	 * {@link withSelectedContainer}).
	 */
	providerContext: Record<string, string>;
}

/**
 * A PM provider id — the `pm` union's own discriminator, so every provider-scoped
 * call the tab makes (discovery, credentials) is typed against the same closed
 * vocabulary the API validates against (`PmProviderIdSchema`, `src/pm/events.ts`).
 */
export type PmProviderId = ProjectPm['type'];

type GitHubProjectsPm = Extract<ProjectPm, { type: 'github-projects' }>;
type LinearPm = Extract<ProjectPm, { type: 'linear' }>;
type JiraPm = Extract<ProjectPm, { type: 'jira' }>;
type TrelloPm = Extract<ProjectPm, { type: 'trello' }>;

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
	/**
	 * The provider id, typed to the `pm` union's own discriminator rather than a bare
	 * string, so a catalogue id can be handed straight to a provider-scoped API call
	 * (`pm.discoverContainers`, `projects.credentials.listPm`) without a cast — the
	 * catalogue is hand-kept, and this is what keeps a typo in it a compile error.
	 */
	id: PmProviderId;
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
	{
		id: 'jira',
		label: 'Jira',
		containerNoun: 'project',
		containerNounPlural: 'projects',
		stateNoun: 'status',
		stateNounPlural: 'statuses',
		intro:
			"Pick this project's Jira project, then map each SWARM pipeline status to one of its workflow statuses. Projects and statuses are discovered server-side with this project's own board credential, configured under Credentials above. The Jira site URL is board identity, set in swarm.config.json and preserved by this screen.",
	},
	{
		id: 'trello',
		label: 'Trello',
		containerNoun: 'board',
		containerNounPlural: 'boards',
		// A Trello card has no status field: its status *is* the list it sits in, so
		// the state noun is the provider's own "list" (issue #588).
		stateNoun: 'list',
		stateNounPlural: 'lists',
		intro:
			"Pick this project's Trello board, then map each SWARM pipeline status to one of the board's lists — a card's status is the list it sits in. Boards and lists are discovered server-side with this project's own board credential, configured under Credentials above.",
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
function selectedProviderId(form: BoardMappingForm): PmProviderId {
	return getPmMappingProvider(form.providerId).id;
}

/**
 * The provider every provider-scoped call on the tab addresses — the form's selection,
 * normalized through the catalogue. It is the *draft* provider while a switch is open
 * and the persisted one otherwise, which is exactly the ordering the switch flow needs:
 * credentials are entered, and boards discovered, for the provider the operator is
 * moving to before anything is written (issue #642).
 */
export function selectedPmProviderId(form: BoardMappingForm): PmProviderId {
	return selectedProviderId(form);
}

/**
 * The provider a pending switch selects, or `undefined` when the form is on the one the
 * project is persisted on.
 *
 * Derived rather than held as a second piece of state: an open draft *is* "the form
 * selects a provider the project isn't on", so there is nothing to keep in sync — a
 * successful save closes the draft by making the two agree, and Reset closes it by
 * reprojecting the form from `pm`.
 */
export function switchedPmProviderId(
	form: BoardMappingForm,
	pm: ProjectPm | undefined,
): PmProviderId | undefined {
	const selected = selectedProviderId(form);
	return selected === (pm?.type ?? DEFAULT_PM_PROVIDER_ID) ? undefined : selected;
}

/**
 * Whether the selected provider threads an opaque Status *field* id through
 * `providerContext`. GitHub Projects' option ids are scoped to one single-select
 * field, so its mapping is incomplete without that id; a Linear workflow-state UUID
 * and a Trello list id are each the whole mapping and neither provider's state
 * discovery returns any context, so their mappings must not be gated on one.
 */
function usesStatusFieldContext(form: BoardMappingForm): boolean {
	return selectedProviderId(form) === 'github-projects';
}

/**
 * Whether the selected provider's member carries a site base URL the mapping is
 * incomplete without. Jira's `baseUrl` names the Cloud site its project key and
 * status ids belong to; it is board identity set in `swarm.config.json` rather than
 * edited here (issue #490 phase 1/6), so this screen only has to carry it through a
 * save — and refuse to write a member without one instead of letting
 * `jiraConfigSchema` reject it after the fact.
 */
function requiresBaseUrl(form: BoardMappingForm): boolean {
	return selectedProviderId(form) === 'jira';
}

/** The carried base URL, normalized; blank when the provider has none or none is set. */
function baseUrlOf(form: BoardMappingForm): string {
	return requiresBaseUrl(form) ? (form.providerContext.baseUrl ?? '').trim() : '';
}

/**
 * Whether the selected provider needs a base URL and the form carries none — the
 * one save gate the operator can't clear from this screen, so the panel explains
 * where to set it rather than leaving Save inexplicably disabled.
 */
export function isBaseUrlMissing(form: BoardMappingForm): boolean {
	return requiresBaseUrl(form) && !baseUrlOf(form);
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
 * Reset container-scoped selections before moving the form to another container, so
 * one board's state ids and field id can't be saved against another.
 *
 * What survives is the part of `providerContext` that is *not* a property of the
 * selected container: Jira's `baseUrl` is the site every one of the discovered
 * projects came from, and nothing re-seeds it (this screen doesn't edit it and Jira's
 * state discovery deliberately returns no context), so clearing it on a container
 * switch would leave a Jira mapping permanently unsaveable.
 */
export function withSelectedContainer(
	form: BoardMappingForm,
	containerId: string,
): BoardMappingForm {
	if (form.containerId === containerId) return form;
	const baseUrl = baseUrlOf(form);
	return {
		...form,
		containerId,
		statusOptions: blankStatusOptions(),
		providerContext: baseUrl ? { baseUrl } : {},
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
 * `containerId` is GitHub's board node id, Linear's team UUID, Jira's project key,
 * or Trello's board id depending on the member, and `providerContext` carries
 * whichever second value that member has — GitHub's Status field id (issue #531)
 * or Jira's site base URL (issue #581), never both, and neither for Linear or
 * Trello, whose state ids are the whole mapping.
 */
export function toBoardMappingForm(pm: ProjectPm | undefined): BoardMappingForm {
	const githubProjects = pm?.type === 'github-projects' ? pm : undefined;
	const linear = pm?.type === 'linear' ? pm : undefined;
	const jira = pm?.type === 'jira' ? pm : undefined;
	const trello = pm?.type === 'trello' ? pm : undefined;
	const statusOptions = blankStatusOptions();
	for (const key of STATUS_KEYS) {
		const value = pm?.statusOptions?.[key];
		if (value) statusOptions[key] = value;
	}
	return {
		providerId: pm?.type ?? DEFAULT_PM_PROVIDER_ID,
		containerId:
			githubProjects?.projectId ?? linear?.teamId ?? jira?.projectKey ?? trello?.boardId ?? '',
		statusOptions,
		providerContext: githubProjects?.statusFieldId
			? { statusFieldId: githubProjects.statusFieldId }
			: jira?.baseUrl
				? { baseUrl: jira.baseUrl }
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
	if (selectedProviderId(form) === 'trello') {
		// The board id and the list ids are the whole mapping — a Trello card has no
		// status field, so there is no field scope to carry and nothing from
		// `providerContext` belongs on this member.
		const trello: TrelloPm = { type: 'trello', boardId: containerId, statusOptions };
		return trello;
	}
	if (selectedProviderId(form) === 'jira') {
		// The site URL isn't edited here: it comes from the form's carried context,
		// which `toBoardMappingForm` seeded from the stored Jira member and which is
		// blank when the stored member is another provider's — the case
		// `canSaveBoardMapping` refuses rather than writing a member Jira's schema
		// would then reject.
		const jira: JiraPm = {
			type: 'jira',
			baseUrl: baseUrlOf(form),
			projectKey: containerId,
			statusOptions,
		};
		return jira;
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
 * Each provider's own `providerContext` entry is compared only for that provider —
 * the Status field id for GitHub Projects, the site base URL for Jira — so a
 * provider that carries neither doesn't read as permanently clean or permanently
 * dirty against a stored mapping that does.
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
	if (requiresBaseUrl(form) && baseUrlOf(form) !== (stored.providerContext.baseUrl ?? ''))
		return true;
	return STATUS_KEYS.some(
		(key) => (form.statusOptions[key]?.trim() ?? '') !== stored.statusOptions[key],
	);
}

/**
 * Whether the form can be saved: a container is selected and at least one
 * canonical status is mapped — matching every provider schema's "at least one
 * option" minimum (`githubProjectsConfigSchema`, `linearConfigSchema`,
 * `jiraConfigSchema`, `trelloConfigSchema`) rather than requiring every status be
 * mapped — plus each
 * provider's own required context: a known Status-field context for GitHub Projects,
 * a carried site base URL for Jira. The route additionally gates Save on the form
 * being dirty and no other config write being in flight.
 */
export function canSaveBoardMapping(form: BoardMappingForm): boolean {
	if (!form.containerId.trim()) return false;
	if (usesStatusFieldContext(form) && !(form.providerContext.statusFieldId ?? '').trim())
		return false;
	if (isBaseUrlMissing(form)) return false;
	return STATUS_KEYS.some((key) => !!form.statusOptions[key]?.trim());
}
