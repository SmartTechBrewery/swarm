import { z } from 'zod';

/**
 * The per-phase config screens the Agent Configuration tab can drill into. The
 * single source of truth for the phase names — the project-detail route imports
 * this as its `PHASES`, and the route's `?phase=` search param is validated
 * against it (issue #210).
 */
export const PROJECT_PHASES = [
	'planning',
	'implementationUnplanned',
	'implementation',
	'review',
	'respondToReview',
	'respondToCi',
	'resolveConflicts',
] as const;

export type ProjectPhase = (typeof PROJECT_PHASES)[number];

/**
 * The tabs on the project-detail screen, in display order. `projectManagement` was
 * `boardMapping` until issue #537 widened that tab from a board mapping into the
 * whole PM setup (provider, credentials, board, status mapping);
 * {@link LEGACY_TAB_ALIASES} keeps old links working.
 */
export const PROJECT_TABS = [
	'runs',
	'general',
	'agents',
	'pipeline',
	'projectManagement',
	'credentials',
] as const;

export type ProjectTab = (typeof PROJECT_TABS)[number];

/**
 * Renamed tab values a bookmarked or pasted `?tab=` link may still carry, mapped to
 * the tab that replaced them. Without this a stale link would `.catch(undefined)`
 * into the Runs tab, silently dropping the operator somewhere they didn't ask for.
 */
const LEGACY_TAB_ALIASES: Readonly<Record<string, ProjectTab>> = {
	boardMapping: 'projectManagement',
};

/**
 * Search-param schema for `/projects/$projectId`. The active tab and the open
 * Agent Configuration phase live in the URL — not component state — so each
 * transition is a real browser-history entry: opening a phase detail nests it
 * under the Agent Configuration summary, and browser Back returns there rather
 * than escaping to the previous page (issue #210).
 *
 * Both fields `.catch(undefined)` so a stale or hand-edited link with an unknown
 * tab/phase degrades to the summary instead of throwing — direct/deep links stay
 * usable with a sensible fallback.
 */
export const projectDetailSearchSchema = z.object({
	tab: z.preprocess(
		(value) => (typeof value === 'string' ? (LEGACY_TAB_ALIASES[value] ?? value) : value),
		z.enum(PROJECT_TABS).optional().catch(undefined),
	),
	phase: z.enum(PROJECT_PHASES).optional().catch(undefined),
});

export type ProjectDetailSearch = z.infer<typeof projectDetailSearchSchema>;

/**
 * The tab to render for a given search state. An explicit `tab` always wins; a
 * phase-details deep link that omits `tab` resolves to the Agent Configuration
 * tab so the detail view renders on a direct link or reload.
 */
export function resolveActiveTab(search: ProjectDetailSearch): ProjectTab {
	if (search.tab) return search.tab;
	return search.phase ? 'agents' : 'runs';
}

/**
 * Search state for switching to a tab. Switching tabs drops any open phase
 * detail — the phase view belongs to the Agent Configuration tab alone.
 */
export function tabSearch(tab: ProjectTab): ProjectDetailSearch {
	return { tab };
}

/** Search state for the Agent Configuration summary (the phase-detail parent). */
export function agentConfigSearch(): ProjectDetailSearch {
	return { tab: 'agents' };
}

/**
 * Search state for a phase-detail view: nested under the Agent Configuration
 * summary so browser Back — and the in-app "Back to Agent Configuration" control,
 * which navigates to {@link agentConfigSearch} — both return there.
 */
export function phaseDetailSearch(phase: ProjectPhase): ProjectDetailSearch {
	return { tab: 'agents', phase };
}
