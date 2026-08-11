import { AppSettingsSchema } from '../../config/app-settings.js';
import { getAppSettings, updateAppSettings } from '../../db/repositories/appSettingsRepository.js';
import { authedProcedure, router } from '../trpc.js';

/**
 * Global (app-wide) settings API — the read/write surface the dashboard's
 * settings screen sits on (issue #117). `get` returns the current settings
 * (coded defaults when nothing is stored yet); `update` validates the input
 * against `AppSettingsSchema` (rejecting an unknown CLI or a model not in that
 * CLI's known list, via `AgentDefaultsSchema`'s refine) before the idempotent
 * upsert. Shaped after `projectsRouter` (`./projects.ts`).
 */
export const settingsRouter = router({
	get: authedProcedure.query(async () => {
		return await getAppSettings();
	}),

	update: authedProcedure.input(AppSettingsSchema).mutation(async ({ input }) => {
		return await updateAppSettings(input);
	}),
});
