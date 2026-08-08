/**
 * `swarm start` — bring up the local stack (postgres, redis, router) via Docker
 * Compose. The worker is intentionally *not* started: it runs on the host, not
 * in Compose, because it needs the developer's PATH/auth for git and the agent
 * CLIs (ai/ARCHITECTURE.md "Components").
 */

import { parseArgs } from 'node:util';
import { runCommand } from '../_shared/exec.js';
import * as out from '../_shared/output.js';
import { REPO_ROOT } from '../_shared/paths.js';
import { reportWorkerReadiness } from '../_shared/worker-readiness.js';

export async function run(argv: string[]): Promise<number> {
	const { values } = parseArgs({
		args: argv,
		options: { build: { type: 'boolean', default: false } },
		allowPositionals: false,
	});

	const composeArgs = ['compose', 'up', '-d', '--wait'];
	if (values.build) {
		composeArgs.push('--build');
	}

	out.step('starting the local stack (postgres, redis, router)…');
	const code = await runCommand('docker', composeArgs, { cwd: REPO_ROOT });
	if (code !== 0) return code;

	out.step('applying pending database migrations…');
	const migrationCode = await runCommand('npm', ['run', 'db:migrate'], { cwd: REPO_ROOT });
	if (migrationCode !== 0) return migrationCode;

	out.info('stack is up. The worker runs on the host — start it with: npm run dev:worker');
	// Said after the stack is up, where an operator is about to start the worker:
	// without a registered worker every dispatch waits durably (issue #552).
	await reportWorkerReadiness();
	return 0;
}
