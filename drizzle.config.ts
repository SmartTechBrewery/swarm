import { defineConfig } from 'drizzle-kit';

export default defineConfig({
	schema: [
		'./src/db/schema/projects.ts',
		'./src/db/schema/projectCredentials.ts',
		'./src/db/schema/runs.ts',
		'./src/db/schema/appSettings.ts',
		'./src/db/schema/cliQuotas.ts',
		'./src/db/schema/reviewVerdicts.ts',
		'./src/db/schema/dispatches.ts',
		'./src/db/schema/instanceScmCredentials.ts',
		'./src/db/schema/users.ts',
		'./src/db/schema/userSessions.ts',
		'./src/db/schema/userIdentities.ts',
		'./src/db/schema/projectMembers.ts',
		'./src/db/schema/projectMembershipRequests.ts',
		'./src/db/schema/workers.ts',
		'./src/db/schema/workerSessions.ts',
		'./src/db/schema/workerProjectEnrollments.ts',
		'./src/db/schema/workerScmCredentials.ts',
	],
	out: './src/db/migrations',
	dialect: 'postgresql',
	dbCredentials: {
		url: process.env.DATABASE_URL ?? '',
	},
});
