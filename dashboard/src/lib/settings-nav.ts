import { z } from 'zod';
import type { BugReportsSearch } from './bug-reports-nav.js';

/**
 * The tabs on the General screen (`/settings`, the sidebar's **Settings** link), in
 * display order (issue #250 added `appearance`, issue #769 `credentials`, issue #1151
 * `users`, issue #1284 `fleet`). The administrator-only tabs stay together, then
 * `appearance` — the tab every viewer sees, and the fallback — which stays last.
 */
export const SETTINGS_TABS = ['agents', 'credentials', 'users', 'fleet', 'appearance'] as const;

/**
 * The tab SWARM's bug reports used to be (issue #1390), before they became their own
 * page (`bug-reports-nav.ts`, issue #1443). Still accepted in a `/settings` URL only so
 * that links already posted — run headlines, docs, `docs/mcp.md` — redirect there
 * ({@link legacyBugReportsRedirect}); it is no longer a tab.
 */
export const LEGACY_BUG_REPORTS_TAB = 'issues';

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
	tab: z
		.enum([...SETTINGS_TABS, LEGACY_BUG_REPORTS_TAB])
		.optional()
		.catch(undefined),
	/**
	 * The bug report a legacy `?tab=issues&report=<id>` link opened (issue #1390),
	 * carried over to the bug reports page. A malformed id degrades to none.
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
	return visibleSettingsTabs(viewer).find((tab) => tab === requested) ?? FALLBACK_SETTINGS_TAB;
}

/**
 * Whether a tab renders from the `settings.get` blob, so the screen waits on that
 * query (and shows its error) before rendering it. Agent Defaults reads `agents`, Fleet
 * reads `workers`, and both it and Appearance merge their update onto the whole blob;
 * Credentials and Users each own their query and stay usable when `settings.get` fails.
 */
export function settingsTabNeedsAppSettings(tab: SettingsTab): boolean {
	return tab === 'agents' || tab === 'fleet' || tab === 'appearance';
}

/** Search state for switching to a tab. */
export function settingsTabSearch(tab: SettingsTab): SettingsSearch {
	return { tab };
}

/**
 * Where a legacy bug-reports link (`/settings?tab=issues`, optionally with
 * `&report=<id>`) now leads — the bug reports page's search state — or `undefined`
 * for any other `/settings` URL.
 */
export function legacyBugReportsRedirect(search: SettingsSearch): BugReportsSearch | undefined {
	if (search.tab !== LEGACY_BUG_REPORTS_TAB) return undefined;
	return search.report === undefined ? {} : { report: search.report };
}
