/**
 * `swarm run` — per-run operator recovery from the terminal (issue #429), the
 * CLI companion to the dashboard's "Reset & restart" button (issue #428). Both
 * are thin surfaces over the same service (`src/dispatch/run-reset.ts`), so the
 * guards, ordering, and reported outcomes are identical; this one exists because
 * a wedged run often needs freeing while the worker — and sometimes the API — is
 * stopped, and like `swarm queue clear` / `swarm worktrees prune` it talks
 * straight to Postgres + Redis.
 *
 * A thin CLI shell over `resetRun` (`node:util` `parseArgs` +
 * `_shared/output.ts`, like `commands/worktrees.ts`): it validates its
 * arguments, prints one line per step the service performed, and maps a
 * `RunResetError` refusal to exit 1 with the service's own operator-facing
 * message. Connections are closed in a `finally` (`closeQueue()` + `closeDb()`,
 * the pair `queue clear` closes).
 *
 * Subcommands:
 *   swarm run reset <runId> [--force]
 */

import { parseArgs } from 'node:util';
import { z } from 'zod';
import { closeDb } from '../../db/client.js';
import { type ResetRunResult, RunResetError, resetRun } from '../../dispatch/run-reset.js';
import { closeRunCancellationRedis } from '../../queue/cancellation.js';
import { closeQueue } from '../../queue/producer.js';
import type {
	TerminationBlockedReason,
	TerminationCleanupResult,
} from '../../worktree/termination-cleanup.js';
import * as out from '../_shared/output.js';

const USAGE = `swarm run — operator recovery for a single run

Usage: swarm run reset <runId> [--force]

  reset    Reset one *wedged* run and restart its phase from scratch: cancel its
           active dispatch, clear its Redis cancellation flag, settle its
           checkout and worktree lease (releasing a stale lease no live run
           owns), clear its recovery record, and re-dispatch the phase with a
           fresh agent session. This is the last resort — try "Retry now" or
           "Terminate" from the dashboard first.

  --force  Also reset a run still marked running, cancel a dispatch a worker has
           already claimed, and DISCARD uncommitted changes and unpushed commits
           in the checkout instead of retaining it — on whichever worker holds
           that checkout, not only this host. It cannot stop an already-spawned
           agent process — only Terminate can.

Without --force a checkout holding uncommitted changes or unpushed commits is
retained (reported with its reason) rather than removed, and a healthy running
run is refused.

Requires DATABASE_URL and REDIS_URL in the environment — run via
\`npm run swarm -- run reset <runId>\` (loads .env) or export them yourself
first. Works with the worker and the API stopped: it goes straight to Postgres
and Redis. It settles a checkout on *this* host's disk directly; one on another
worker is settled by that worker when it provisions the restart, following the
intent the restart carries (--force discards it, a plain reset reclaims it only
if it is safe to), so this can be run from anywhere.`;

/** `runs.id` is a uuid column (`src/db/schema/runs.ts`). */
const RunIdSchema = z.string().uuid();

/**
 * Operator-facing wording for a protected-checkout reason (dirty/unpushed/leased).
 * Typed against the service's union rather than `string` so a new blocked reason
 * is a compile error here instead of leaking its raw key into the report.
 *
 * Keep the wording in this formatter and {@link describeWorktreeOutcome} in sync
 * with the dashboard's copy of the same report (`dashboard/src/lib/run-reset.ts`),
 * which cannot import this module: the dashboard package deliberately depends on
 * no server code, so the two surfaces over `resetRun` duplicate these strings.
 */
function describeWorktreeReason(reason: TerminationBlockedReason): string {
	switch (reason) {
		case 'dirty':
			return 'uncommitted changes';
		case 'unpushed':
			return 'unpushed commits';
		case 'live-leased':
			return 'a lease held by another live run';
	}
}

/**
 * One line describing what the reset did to the run's checkout and lease **on the
 * control-plane host** — the only filesystem `resetRun` can settle itself. A
 * checkout on another worker is described by {@link describeWorktreeIntent}
 * instead (issue #592).
 */
function describeWorktreeOutcome(worktree: TerminationCleanupResult): string {
	switch (worktree.outcome) {
		case 'absent':
			// The service still releases the lease on this path, so a leftover marker
			// from the wedged run is gone. What it can no longer claim is that there was
			// nothing to remove: on a federated deployment the checkout is usually alive
			// on another worker, which is the very case being reset.
			return 'checkout: none on this host — one held by another worker is settled by that worker when it provisions the restart; any leftover lease marker here was dropped';
		case 'preserved':
			return 'checkout: kept for its saved agent session; the lease was released';
		case 'removed': {
			const notes = [
				worktree.discarded
					? `${describeWorktreeReason(worktree.discarded)} discarded as requested`
					: undefined,
				worktree.staleLeaseReleased
					? 'a stale worktree lease no live run owned was released'
					: undefined,
			].filter((note): note is string => note !== undefined);
			return notes.length > 0
				? `checkout: removed — ${notes.join('; ')}`
				: 'checkout: removed and its lease released';
		}
		case 'blocked':
			return (
				`checkout: retained — ${describeWorktreeReason(worktree.blockedReason)}; the restarted run re-checks it before provisioning ` +
				'— push or discard that work, or re-run with --force, to actually free it'
			);
	}
}

/**
 * The line naming what the *restart* will do to the checkout (issue #592) — the
 * half of the answer the local settlement above cannot give, because the checkout
 * may be on a worker this process cannot see. Typed against the service's union so
 * a new intent is a compile error here rather than an unreported one.
 */
function describeWorktreeIntent(intent: ResetRunResult['worktreeIntent']): string {
	switch (intent) {
		case 'discard':
			return 'restart intent: the worker holding the checkout discards it — dirty and unpushed work included — before provisioning';
		case 'reclaim':
			return 'restart intent: the worker holding the checkout reclaims it only if it is safe to; dirty or unpushed work is retained';
	}
}

/**
 * Print the per-step report in the order `resetRun` performs them, so an
 * operator can tell a reset that actually freed the checkout from one that
 * restarted the run but left protected work behind.
 */
function reportReset(result: ResetRunResult): void {
	switch (result.dispatch) {
		case 'none':
			out.step('dispatch: none was active');
			break;
		case 'cancelled':
			out.step('dispatch: the active dispatch was cancelled');
			break;
		case 'force-cancelled-claimed':
			// The step belongs on stdout with every other report line (so a redirected
			// report is complete); the live-agent caveat is warned separately because
			// the operator must not miss it.
			out.step('dispatch: a worker-claimed dispatch was force-cancelled');
			out.warn(
				'an agent process that dispatch already spawned is not stopped by a reset — terminate it if it is still running',
			);
			break;
	}

	if (result.cancellationCleared) {
		out.step('cancellation flag: cleared, so the fresh attempt is not killed at startup');
	}

	out.step(describeWorktreeOutcome(result.worktree));
	out.step(describeWorktreeIntent(result.worktreeIntent));

	if (result.recoveryCleared) {
		out.step('recovery record: cleared');
	}

	out.step(`restarted: re-dispatched from scratch as dispatch ${result.dispatchId}`);
}

async function resetOneRun(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		options: { force: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
		allowPositionals: true,
	});
	if (values.help) {
		out.info(USAGE);
		return 0;
	}

	const [runId, ...extra] = positionals;
	if (!runId || extra.length > 0) {
		out.error('run reset: exactly one <runId> is required');
		out.info(USAGE);
		return 1;
	}
	// `runs.id` is a uuid column, so a typo'd id fails inside Postgres with a raw
	// query error instead of the service's clean not-found refusal. Caught here so
	// an operator sees the id they mistyped, not a SQL dump — and before any
	// connection is opened.
	if (!RunIdSchema.safeParse(runId).success) {
		out.error(`run reset: '${runId}' is not a valid run id (expected a uuid)`);
		return 1;
	}

	const force = values.force ?? false;
	if (force) {
		out.warn(
			'--force: uncommitted changes and unpushed commits in the checkout may be discarded permanently, and an agent already spawned for this run keeps running',
		);
	}

	try {
		out.step(`resetting run '${runId}'…`);
		const result = await resetRun(runId, { force });
		reportReset(result);
		return 0;
	} catch (err) {
		// A refusal's message is already operator-facing; anything else is internal.
		if (err instanceof RunResetError) {
			out.error(err.message);
			return 1;
		}
		out.error(`run reset failed: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	} finally {
		// Every client this command opened, including the one `resetRun` creates to
		// clear the cancellation flag. Settled together so one failing closer cannot
		// skip the others — or replace an already-decided exit code with a throw.
		await Promise.allSettled([closeQueue(), closeDb(), closeRunCancellationRedis()]);
	}
}

export async function run(argv: string[]): Promise<number> {
	const [subcommand, ...rest] = argv;

	if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
		out.info(USAGE);
		return subcommand ? 0 : 1;
	}

	if (subcommand !== 'reset') {
		out.error(`unknown run subcommand '${subcommand}'`);
		out.info(USAGE);
		return 1;
	}

	return resetOneRun(rest);
}
