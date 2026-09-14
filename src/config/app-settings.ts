/**
 * SWARM app-wide (global) settings — the single source of truth for the shape
 * of SWARM's *global* configuration layer (ai/CODING_STANDARDS.md "Zod is the
 * source of truth"), the sibling of `SwarmConfigSchema` (`./schema.ts`, the
 * per-*project* shape).
 *
 * Unlike project config (file-sourced via `swarm.config.json` → the `projects`
 * table) and general settings (raw environment variables), global settings are
 * **DB-first**: persisted as one jsonb blob in the single-row `app_settings`
 * table and edited through the dashboard API (`settings` tRPC router), never
 * from a config file. When the row is absent, {@link APP_SETTINGS_DEFAULTS}
 * applies and the coded per-CLI defaults (`DEFAULT_MODEL_PER_CLI`,
 * `src/harness/models.ts`) still take effect downstream, so no seeding is
 * needed for correct default behaviour.
 *
 * Scope (issue #117): `agents.defaults`, the *global* per-CLI default model,
 * resolved by the worker as the tier between a project's own `agents.defaults`
 * and the coded default (`src/worker/consumer.ts` `resolveModel`). Issue #250
 * added `appearance.theme`, the dashboard's persisted theme choice — unlike
 * `agents`, it defaults *within the schema* (`.default('dark')`) rather than
 * downstream, since there's no coded fallback layer for it to fall through to.
 * Issue #956 added `maintenance`, which is the first key here that is **not** a
 * setting at all but machine-written state (see its own comment).
 * The top-level object shape is deliberate so future global settings (host
 * URL, worker concurrency, …) drop in as sibling keys without a migration (the
 * blob is extensible).
 */

import { z } from 'zod';
import { AgentDefaultsSchema } from './schema.js';

/**
 * Global agent settings. `defaults` is the *global* per-CLI default model —
 * reusing `AgentDefaultsSchema` (`./schema.ts`), which already validates each
 * value against `AGENT_MODELS[cli]` (`src/harness/models.ts`) — the fallback
 * used when neither a phase nor the project sets a model for that CLI.
 */
export const AppAgentsSettingsSchema = z
	.object({
		defaults: AgentDefaultsSchema.optional(),
	})
	.describe('Global agent settings — the per-CLI default model applied across all projects');

/** The dashboard's theme choice — `system` follows the OS/browser preference. */
export const AppearanceThemeSchema = z.enum(['dark', 'light', 'system']);

export type AppearanceTheme = z.infer<typeof AppearanceThemeSchema>;

/**
 * Global appearance settings. `theme` defaults to `dark` so existing and new
 * installations render the dashboard's original dark-only look until a user
 * explicitly picks Light or System default (issue #250).
 */
export const AppAppearanceSettingsSchema = z
	.object({
		theme: AppearanceThemeSchema.default('dark'),
	})
	.describe('Global appearance settings — the dashboard theme choice');

export type AppAppearanceSettings = z.infer<typeof AppAppearanceSettingsSchema>;

/**
 * Installation-wide **maintenance markers** — machine-written state rather than
 * an operator setting, and the one key here that nobody is meant to edit
 * (issue #956).
 *
 * `lastFleetWorktreeSweepAt` (ISO-8601) is when the API server last asked the
 * whole installation to sweep its abandoned worktrees. It is durable precisely
 * because the cadence has to survive a restart: an API server restarted daily
 * must not fan out daily, so `SWARM_WORKTREE_ABANDONED_SWEEP_INTERVAL_MS` is
 * compared against this marker (`src/api/maintenance.ts`) rather than being a
 * timer period. Absent until the first fan-out, which is what makes a fresh
 * installation due immediately.
 *
 * It lives in this blob rather than in a table of its own for the reason the
 * header already states — the blob is extensible, and this is one instant — and
 * it is deliberately **not** surfaced on the settings tRPC router's vocabulary or
 * on the dashboard: editing it would only move a sweep. It rides `settings.update`
 * untouched because both dashboard writers merge onto the settings they loaded.
 */
export const AppMaintenanceSettingsSchema = z
	.object({
		lastFleetWorktreeSweepAt: z.string().datetime().optional(),
	})
	.describe('Machine-written maintenance markers — never edited by an operator');

export type AppMaintenanceSettings = z.infer<typeof AppMaintenanceSettingsSchema>;

/**
 * The whole global-settings blob. `agents` is optional so an empty `{}` is a
 * valid (all-defaults) settings object; `appearance` always materializes (with
 * its own defaulted `theme`) so every parse — including of `{}` — yields an
 * effective theme rather than requiring every caller to fall back manually.
 * `maintenance` is optional and never defaulted: an absent marker is the honest
 * "this has not happened yet", and materializing an empty object would say the
 * same thing in more bytes.
 * New global settings can be added as sibling keys later without reshaping
 * what's stored.
 */
export const AppSettingsSchema = z
	.object({
		agents: AppAgentsSettingsSchema.optional(),
		appearance: AppAppearanceSettingsSchema.default({ theme: 'dark' }),
		maintenance: AppMaintenanceSettingsSchema.optional(),
	})
	.describe('SWARM global (app-wide) settings, persisted as one jsonb blob');

export type AppAgentsSettings = z.infer<typeof AppAgentsSettingsSchema>;
export type AppSettings = z.infer<typeof AppSettingsSchema>;

/**
 * The baseline returned when no `app_settings` row exists — the schema's
 * defaults applied to an empty object (`{ appearance: { theme: 'dark' } }`).
 * With no global overrides, the coded per-CLI defaults still apply downstream
 * via `DEFAULT_MODEL_PER_CLI`, so `agents` staying absent here is correct.
 */
export const APP_SETTINGS_DEFAULTS: AppSettings = AppSettingsSchema.parse({});

/**
 * Parse and validate an untrusted global-settings value. Throws `ZodError` on
 * invalid input (e.g. an unknown CLI or a model not in that CLI's known list) —
 * a malformed settings write is a caller error, not a "not found" lookup, so it
 * throws rather than returning null (ai/CODING_STANDARDS.md "Error handling").
 * Mirrors `validateConfig` (`./schema.ts`).
 */
export function validateAppSettings(input: unknown): AppSettings {
	return AppSettingsSchema.parse(input);
}
