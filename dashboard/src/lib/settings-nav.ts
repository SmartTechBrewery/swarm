import { z } from 'zod';

/**
 * The tabs on the General screen (`/settings`, the sidebar's **Settings** link), in
 * display order (issue #250 added `appearance`, issue #769 `credentials`, issue #1151
 * `users`, issue #1284 `fleet`, issue #1390 `issues`). The administrator-only tabs stay
 * together, then the tabs every viewer sees: `issues` (SWARM's own bug reports) and
 * `appearance` — the fallback — which stays last.
 */
export const SETTINGS_TABS = [
	'agents',
	'credentials',
	'users',
	'fleet',
	'issues',
	'appearance',
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

/**
 * The slice of the signed-in user this module reads — `CurrentUser.instanceAdmin`
 * (`./auth.ts`), taken structurally rather than by importing that type, mirroring
 * `isInstanceAdmin(user: Pick<SwarmUser, 'instanceAdmin'>)` server-side
 * (`src/identity/schema.ts`). `undefined` is a viewer who hasn't resolved yet and
 * is treated as a non-administrator, so an admin-only section can never flash
 * before `auth.me` answers.
 */
export interface SettingsViewer {
	instanceAdmin: boolean;
}

/**
 * Tabs only an instance administrator may see — each is installation-wide, so none
 * is presented to a user without instance-administration authority.
 *
 * They differ in what this list *is*, and the difference matters:
 *
 * - `agents` (issue #666) is a **visibility** boundary on the screen alone. The
 *   `settings.get`/`update` procedures are the enforcement point and their
 *   authorization is unchanged — they remain open to any authenticated caller.
 * - `credentials` (issue #769) is visibility on top of real enforcement: every
 *   `settings.credentials` procedure, reads included, throws `FORBIDDEN` for a
 *   non-administrator (`src/api/routers/instanceCredentials.ts`). Hiding the tab is a
 *   courtesy; the router is what stops a secret being written or its
 *   configured-state read.
 * - `users` (issue #1151) is likewise visibility on top of real enforcement: every
 *   `users` procedure, `list` included, throws `FORBIDDEN` for a non-administrator
 *   (`src/api/routers/users.ts`).
 * - `fleet` (issue #1284) is visibility on top of enforcement of the one key it edits:
 *   `settings.update` refuses a non-administrator's change to
 *   `workers.followInstallationVersion` with `FORBIDDEN` (`src/api/routers/settings.ts`).
 *
 * `issues` (issue #1390) is deliberately **not** here: every signed-in user sees it,
 * and `bugReports.list` scopes what it shows — the viewer's own projects' reports,
 * plus installation-wide ones for an instance administrator only
 * (`src/api/routers/bugReports.ts`).
 */
const INSTANCE_ADMIN_ONLY_TABS: readonly SettingsTab[] = [
	'agents',
	'credentials',
	'users',
	'fleet',
];

/** The tab a bare `/settings` link opens, for a viewer who may see it. */
const DEFAULT_SETTINGS_TAB: SettingsTab = 'agents';

/** The tab every signed-in user may see — where a hidden or unknown tab lands. */
const FALLBACK_SETTINGS_TAB: SettingsTab = 'appearance';

/**
 * Search-param schema for `/settings`. The active tab lives in the URL — not
 * component state — so switching tabs is a real browser-history entry and a
 * direct/reload link lands on the right panel (mirrors `project-nav.ts`'s
 * `projectDetailSearchSchema`). `.catch(undefined)` degrades a stale or
 * hand-edited unknown tab to the default rather than throwing.
 */
export const settingsSearchSchema = z.object({
	tab: z.enum(SETTINGS_TABS).optional().catch(undefined),
	/**
	 * The bug report the Issues tab shows in detail (issue #1390), so a report is
	 * linkable as `?tab=issues&report=<id>`. A malformed id degrades to none.
	 */
	report: z.string().uuid().optional().catch(undefined),
});

export type SettingsSearch = z.infer<typeof settingsSearchSchema>;

/** The tabs a viewer may see, in display order (see {@link INSTANCE_ADMIN_ONLY_TABS}). */
export function visibleSettingsTabs(viewer: SettingsViewer | undefined): readonly SettingsTab[] {
	if (viewer?.instanceAdmin) return SETTINGS_TABS;
	return SETTINGS_TABS.filter((tab) => !INSTANCE_ADMIN_ONLY_TABS.includes(tab));
}

/**
 * The tab to render for a given search state and viewer — Agent Defaults is the
 * default for an instance administrator. A tab the viewer may not see degrades to
 * {@link FALLBACK_SETTINGS_TAB} exactly as an unknown `?tab=` does, so a direct
 * link, a bookmark, or a reload can't render an admin-only section for anyone else.
 */
export function resolveActiveSettingsTab(
	search: SettingsSearch,
	viewer?: SettingsViewer,
): SettingsTab {
	const requested = search.tab ?? DEFAULT_SETTINGS_TAB;
	return visibleSettingsTabs(viewer).includes(requested) ? requested : FALLBACK_SETTINGS_TAB;
}

/**
 * Whether a tab renders from the `settings.get` blob, so the screen waits on that
 * query (and shows its error) before rendering it. Agent Defaults reads `agents`, Fleet
 * reads `workers`, and both it and Appearance merge their update onto the whole blob;
 * Credentials, Users and Issues each own their query and stay usable when `settings.get`
 * fails.
 */
export function settingsTabNeedsAppSettings(tab: SettingsTab): boolean {
	return tab === 'agents' || tab === 'fleet' || tab === 'appearance';
}

/** Search state for switching to a tab — which drops any open bug report. */
export function settingsTabSearch(tab: SettingsTab): SettingsSearch {
	return { tab };
}

/** Search state for the Issues tab showing `reportId` in detail, or the list alone. */
export function bugReportSearch(reportId: string | undefined): SettingsSearch {
	return reportId === undefined ? { tab: 'issues' } : { tab: 'issues', report: reportId };
}
