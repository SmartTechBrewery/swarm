import '../integrations/entrypoint.js';
import { authRouter } from './routers/auth.js';
import { membersRouter } from './routers/members.js';
import { pingRouter } from './routers/ping.js';
import { pmRouter } from './routers/pm.js';
import { projectsRouter } from './routers/projects.js';
import { quotaRouter } from './routers/quota.js';
import { runsRouter } from './routers/runs.js';
import { scmRouter } from './routers/scm.js';
import { settingsRouter } from './routers/settings.js';
import { workersRouter } from './routers/workers.js';
import { router } from './trpc.js';

export const appRouter = router({
	auth: authRouter,
	members: membersRouter,
	ping: pingRouter,
	pm: pmRouter,
	projects: projectsRouter,
	runs: runsRouter,
	scm: scmRouter,
	settings: settingsRouter,
	quota: quotaRouter,
	workers: workersRouter,
});

export type AppRouter = typeof appRouter;
