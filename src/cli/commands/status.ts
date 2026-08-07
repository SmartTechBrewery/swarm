/**
 * `swarm status` — a quick health snapshot: the stack's container states
 * (`docker compose ps`) plus a probe of the router's `/health` endpoint on the
 * published host port (`ROUTER_PORT`, default 3100 — see `.env.docker.example`).
 * The worker's own process isn't shown: it runs on the host outside Compose. Its
 * *readiness to be dispatched to* is, since a host with no registered worker is
 * the one failure a healthy-looking stack hides (issue #552).
 */

import { runCommand } from '../_shared/exec.js';
import * as out from '../_shared/output.js';
import { REPO_ROOT } from '../_shared/paths.js';
import { reportWorkerReadiness } from '../_shared/worker-readiness.js';

const HEALTH_TIMEOUT_MS = 2000;

async function probeRouterHealth(port: string): Promise<void> {
	const url = `http://localhost:${port}/health`;
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
		if (res.ok) {
			out.info(`router: healthy (${url})`);
		} else {
			out.warn(`router: unhealthy — ${url} returned HTTP ${res.status}`);
		}
	} catch {
		// A connection error just means the router container isn't up yet — that's
		// a normal state to report, not a CLI failure.
		out.warn(`router: unreachable at ${url} (is the stack running?)`);
	}
}

export async function run(_argv: string[]): Promise<number> {
	out.step('stack containers:');
	const psCode = await runCommand('docker', ['compose', 'ps'], { cwd: REPO_ROOT });

	const port = process.env.ROUTER_PORT ?? '3100';
	await probeRouterHealth(port);
	await reportWorkerReadiness();

	return psCode;
}
