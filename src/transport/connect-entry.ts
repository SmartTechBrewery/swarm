/**
 * The worker process entrypoint — and *only* that (issue #934). The daemon itself is
 * `./worker-main.ts`; this module exists to do one thing before that one is loaded.
 *
 * **Why the split.** An applied self-update is not trusted until a daemon running it
 * has handshaked once, and the record that makes a machine able to give up on a bad
 * build is written by {@link verifyStartupBuild} at process start
 * (`./build-verification.ts`). ESM evaluates a module's *static imports before its own
 * body*, so while the daemon and the counter lived in one module the counter ran after
 * the whole worker dependency graph — every integration, the harness, the executor —
 * had already been evaluated. A build whose bad code threw at import time therefore
 * never reached the counter: `failedStarts` stayed where it was, the supervisor
 * restarted the same build, and the machine crash-looped forever on precisely the
 * failure this mechanism exists to recover from, with no socket left to correct it
 * over.
 *
 * So the static graph here is deliberately minimal — the verification and state
 * mechanism, the logger, and nothing else (node builtins and `zod` below that) — and
 * the daemon arrives through a **dynamic** `import()` that cannot run until the count
 * is durable. Keep it that way: a static import of anything the daemon needs but the
 * counter does not re-opens the hole, which is why
 * `tests/unit/transport/build-verification.test.ts` pins this module's import list and
 * launches the real entrypoint with a poisoned `./worker-main.ts` to prove the count
 * survives an import-time death.
 *
 * The logger is configured here rather than there for the same ordering reason: the
 * lines a giving-up machine emits are the ones an operator needs in the log file, and
 * they are emitted before the daemon exists.
 */

import { optionalEnv } from '../lib/env.js';
import { describeError } from '../lib/errors.js';
import { addFileSink, configureLogger, logger } from '../lib/logger.js';
import { verifyStartupBuild } from './build-verification.js';

// Tag every line this process emits so it stays distinguishable from the router
// and the API server in a shared log stream (ai/ARCHITECTURE.md "Observability").
configureLogger({ component: 'worker-transport' });

// Tee the worker's logs to a durable file (in addition to stdout) so an
// unattended run leaves a greppable record behind — a terminal scrollback is easy
// to lose, and the worker's runs are long. Defaults to `logs/worker.log` under the
// repo root; override the path with SWARM_LOG_FILE. The file always receives the
// JSON form (see logger.ts). This moved here with the deleted in-process entry
// point (issue #553): the file sink belongs to whichever process actually runs
// the agents, which is now only this one.
addFileSink(optionalEnv('SWARM_LOG_FILE', 'logs/worker.log'));

async function bootstrap(): Promise<void> {
	// First, before this process reads its environment, locks a checkout, opens a
	// socket — or loads a single line of the daemon: count this start against a SWARM
	// build that was applied here and has never handshaked. Once too many starts in a
	// row have failed, this puts the install root back on the last known good build
	// and ends the process for the supervisor to start it there — the only recovery
	// left once a bad build has taken the socket the control plane would have
	// corrected it over.
	if (await verifyStartupBuild()) return;
	const { runWorkerDaemon } = await import('./worker-main.js');
	await runWorkerDaemon();
}

bootstrap().catch((err) => {
	// Reached by a daemon that failed *and* by a `./worker-main.ts` that could not be
	// loaded at all — the import-time death above, which now lands here having already
	// been counted, instead of killing the process before the counter ran.
	logger.error('worker transport client exited with a fatal error', { error: describeError(err) });
	process.exit(1);
});
