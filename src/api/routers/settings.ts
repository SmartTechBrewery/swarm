import { AppSettingsSchema } from '../../config/app-settings.js';
import { getAppSettings, updateAppSettings } from '../../db/repositories/appSettingsRepository.js';
import { authedProcedure, router } from '../trpc.js';
import { instanceCredentialsRouter } from './instanceCredentials.js';

/**
 * Global (app-wide) settings API — the read/write surface the dashboard's
 * settings screen sits on (issue #117). `get` returns the current settings
 * (coded defaults when nothing is stored yet); `update` validates the input
 * against `AppSettingsSchema` (rejecting an unknown CLI or a model not in that
 * CLI's known list, via `AgentDefaultsSchema`'s refine) before the idempotent
 * upsert. Shaped after `projectsRouter` (`./projects.ts`).
 *
 * `credentials` is nested here the way `credentialsRouter` nests under
 * `projectsRouter` (issue #769) — the instance-level default SCM credentials, which are
 * installation-wide configuration like everything else on this screen but live in their
 * own table rather than in the `app_settings` blob `get` returns, because that blob is
 * readable by any authenticated caller. Unlike `get`/`update`, every procedure there is
 * instance-administrator only (see `./instanceCredentials.ts`).
 */
export const settingsRouter = router({
	credentials: instanceCredentialsRouter,

	get: authedProcedure.query(async () => {
		return await getAppSettings();
	}),

	update: authedProcedure.input(AppSettingsSchema).mutation(async ({ input }) => {
		return await updateAppSettings(input);
	}),
});
