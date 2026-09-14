/**
 * Global (app-wide) settings persistence — mirrors the plain-function shape of
 * `projectsRepository.ts` (one `getDb()` per call, no class), trimmed to SWARM's
 * single-user scope (ai/ARCHITECTURE.md "Single-user scope"). The settings live
 * in the single-row `app_settings` table pinned to the `'global'` sentinel id
 * (`src/db/schema/appSettings.ts`).
 *
 * The `settings` jsonb column is typed with the config's inferred type
 * (`AppSettings`, `src/config/app-settings.ts`), but a row written before a
 * schema change (e.g. before `appearance` existed, issue #250) can still hold
 * an older shape at runtime despite the compile-time type — so a read
 * re-validates through `AppSettingsSchema` rather than trusting the column
 * type verbatim, materializing any since-added defaulted keys. Writes go
 * through the `settings` tRPC router, which validates the input against
 * `AppSettingsSchema` before it ever reaches here.
 */

import { eq } from 'drizzle-orm';

import {
	APP_SETTINGS_DEFAULTS,
	type AppSettings,
	validateAppSettings,
} from '../../config/app-settings.js';
import { getDb } from '../client.js';
import { appSettings } from '../schema/appSettings.js';

/** The single-row sentinel id — there is exactly one global-settings record. */
const GLOBAL_ID = 'global';

/**
 * Resolve the global settings — the singleton `global` row merged over the coded
 * defaults. Returns {@link APP_SETTINGS_DEFAULTS} when the row is absent (nothing
 * has been configured yet), so callers always get a valid `AppSettings` without
 * a null check; the coded per-CLI defaults still apply downstream.
 */
export async function getAppSettings(): Promise<AppSettings> {
	const rows = await getDb()
		.select()
		.from(appSettings)
		.where(eq(appSettings.id, GLOBAL_ID))
		.limit(1);
	const row = rows[0];
	return row ? validateAppSettings(row.settings) : APP_SETTINGS_DEFAULTS;
}

/**
 * Persist the global settings — an idempotent upsert on the `global` id
 * (`insert … onConflictDoUpdate`), so the first write inserts the singleton row
 * and every later write replaces it in place rather than inserting a duplicate.
 * Returns the stored settings.
 */
export async function updateAppSettings(settings: AppSettings): Promise<AppSettings> {
	await getDb()
		.insert(appSettings)
		.values({ id: GLOBAL_ID, settings })
		.onConflictDoUpdate({
			target: appSettings.id,
			set: { settings, updatedAt: new Date() },
		});
	return settings;
}

/**
 * When the installation last had an abandoned-worktree sweep fanned out across
 * it, or `null` when none ever has (issue #956) — the durable marker the API
 * server's weekly fleet sweep decides due-ness against, so a restart cannot
 * re-trigger one.
 *
 * `null` for an unparseable instant as well as an absent one, which makes a
 * corrupted marker read as "never swept" — due now — rather than as a date
 * arithmetic on `NaN` would silently make never due again.
 */
export async function getLastFleetWorktreeSweepAt(): Promise<Date | null> {
	const marker = (await getAppSettings()).maintenance?.lastFleetWorktreeSweepAt;
	if (!marker) return null;
	const at = new Date(marker);
	return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * Record that the installation was swept at `at`, leaving every other key in the
 * blob alone.
 *
 * Read-modify-write rather than a column update, because the marker shares one
 * jsonb value with the operator's own settings. The lost-update window that opens
 * is the same one `settings.update` already has with itself, and costs at most one
 * extra fan-out a week later — never a lost setting, since both dashboard writers
 * merge onto the settings they loaded.
 */
export async function recordFleetWorktreeSweepAt(at: Date): Promise<void> {
	const settings = await getAppSettings();
	await updateAppSettings({
		...settings,
		maintenance: { ...settings.maintenance, lastFleetWorktreeSweepAt: at.toISOString() },
	});
}
