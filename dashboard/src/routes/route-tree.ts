import { rootRoute } from './__root.js';
import { indexRoute } from './index.js';
import { loginRoute } from './login.js';
import { profileRoute } from './profile.js';
import { projectDetailRoute } from './projects/$projectId.js';
import { projectsIndexRoute } from './projects/index.js';
import { quotaRoute } from './quota.js';
import { runDetailRoute } from './runs/$runId.js';
import { runsIndexRoute } from './runs/index.js';
import { settingsRoute } from './settings/index.js';
import { workerDetailRoute } from './workers/$workerId.js';
import { workersRoute } from './workers/index.js';

export const routeTree = rootRoute.addChildren([
	indexRoute,
	loginRoute,
	projectsIndexRoute,
	projectDetailRoute,
	runsIndexRoute,
	runDetailRoute,
	workersRoute,
	workerDetailRoute,
	settingsRoute,
	quotaRoute,
	profileRoute,
]);
