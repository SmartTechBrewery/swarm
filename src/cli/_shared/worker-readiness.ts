/**
 * The worker-readiness hint printed by `swarm start` and `swarm status`
 * (issue #552).
 *
 * Since single-user mode stopped bypassing the dispatch gate, **every**
 * deployment routes its phases to a registered, enrolled worker — so a host with
 * no `SWARM_WORKER_CREDENTIAL` has nothing to run them on and its dispatches wait
 * durably instead of failing. That is a silent state: the stack is healthy, the
 * board moves, and nothing happens. The worker entry point already refuses to
 * start without it (`src/transport/connect-entry.ts`),
 * but an operator upgrading a single-user install reads the stack commands
 * first, so the same actionable pointer belongs here — naming the two commands
 * that fix it rather than leaving them to diagnose a pile of pending dispatches.
 *
 * The registered-worker lookup is **best effort**: a credential that resolves to
 * no worker (rotated, or its row removed) is worth saying, but a database this
 * command cannot reach is not an answer either way, so an unreachable/unconfigured
 * database stays silent rather than crying wolf. Neither outcome changes the
 * command's exit code — this is advice about the *worker*, not a verdict on the
 * stack the command reports on.
 */

import { closeDb } from '../../db/client.js';
import { resolveWorkerByCredential } from '../../identity/worker-service.js';
import * as out from './output.js';

/** The runbook a host with no usable worker credential needs, as printed lines. */
function printSetupHint(): void {
	out.info(
		'  npm run swarm -- workers register <owner-email> --name "<this machine>" --cli <clis>',
	);
	out.info(
		'  npm run swarm -- workers enroll <worker-id> <project-id> --cli <clis> --active --consent',
	);
	out.info(
		'  then put the credential `workers register` printed once into .env as SWARM_WORKER_CREDENTIAL (see docs/onboarding-worker.md)',
	);
}

/**
 * Whether the credential names a registered worker: `true`/`false` when the
 * database answered, `undefined` when it could not be asked (no `DATABASE_URL`,
 * stack down, or any other read failure) — an unknown, not a "no".
 */
async function isCredentialRegistered(credential: string): Promise<boolean | undefined> {
	try {
		return (await resolveWorkerByCredential(credential)) !== undefined;
	} catch {
		return undefined;
	} finally {
		// Opened lazily by the lookup above; closing it is what lets the CLI exit.
		await closeDb().catch(() => {});
	}
}

/**
 * Report whether this host can execute dispatched phases, and how to make it so
 * when it cannot. Never throws and never changes a command's exit code.
 */
export async function reportWorkerReadiness(): Promise<void> {
	const credential = (process.env.SWARM_WORKER_CREDENTIAL ?? '').trim();
	if (!credential) {
		out.warn(
			'SWARM_WORKER_CREDENTIAL is unset — this host has no registered worker, so dispatched phases will wait instead of running. Every deployment registers and enrolls one worker, a single-user install included:',
		);
		printSetupHint();
		return;
	}

	const registered = await isCredentialRegistered(credential);
	if (registered === false) {
		out.warn(
			'SWARM_WORKER_CREDENTIAL matches no registered worker — it was rotated, or its worker row was removed. Register this machine again (the credential is printed once and cannot be recovered):',
		);
		printSetupHint();
	}
}
