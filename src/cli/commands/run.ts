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
 *   swarm run reset <runId>
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

Usage: swarm run reset <runId>

  reset    Reset one *wedged* run and restart its phase from scratch: cancel its
           active dispatch, clear its Redis cancellation flag, settle its
           checkout and worktree lease (releasing a stale lease no live run
           owns), clear its recovery record, and re-dispatch the phase with a
           fresh agent session. This is the last resort — try "Retry now" or
           "Terminate" from the dashboard first.

A reset ALWAYS DISCARDS and never refuses. It cancels a dispatch a worker has
already claimed, removes the checkout together with any uncommitted changes and
unpushed commits — permanently, and on whichever worker holds it — and resets a
run still marked running without it being terminated first. It cannot stop an
agent process that was already spawned; terminate a genuinely live run first if
you need it stopped. A run that cannot be re-dispatched at all (no stored job
payload, or a project that no longer exists) is settled as failed with the
reason rather than left wedged.

Requires DATABASE_URL and REDIS_URL in the environment — run via
\`npm run swarm -- run reset <runId>\` (loads .env) or export them yourself
first. Works with the worker and the API stopped: it goes straight to Postgres
and Redis. It settles a checkout on *this* host's disk directly; one on another
worker is settled by that worker when it provisions the restart, following the
discard intent the restart carries, so this can be run from anywhere.`;

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
			// Since issue #744 a reset discards, so a retained checkout is one the
			// settlement could not free at all — not one the operator declined to.
			return (
				`checkout: retained — ${describeWorktreeReason(worktree.blockedReason)}; the restarted run re-checks it before provisioning ` +
				'— the worker holding it discards it when it provisions the restart'
			);
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
		case 'cancelled-claimed':
			// The step belongs on stdout with every other report line (so a redirected
			// report is complete); the live-agent caveat is warned separately because
			// the operator must not miss it.
			out.step('dispatch: a dispatch a worker had already claimed was cancelled');
			out.warn(
				'an agent process that dispatch already spawned is not stopped by a reset — terminate it if it is still running',
			);
			break;
	}

	if (result.cancellationCleared) {
		out.step('cancellation flag: cleared, so the fresh attempt is not killed at startup');
	}

	if (result.worktree) {
		out.step(describeWorktreeOutcome(result.worktree));
	}
	// A local teardown throw no longer stops the reset (issue #744) — it is reported
	// so the operator knows this host's checkout still needs a look, while the
	// restart's own discard intent settles the one that was actually in the way.
	if (result.worktreeError) {
		out.warn(
			`checkout: this host's teardown failed — ${result.worktreeError}; the reset continued, and the worker holding the checkout discards it when it provisions the restart`,
		);
	}
	// The other half of the checkout answer (issue #592): what the *restart* does to a
	// checkout this host cannot see. There is no restart to carry it on a terminated
	// reset, so the line is only true for the restarted ending.
	if (result.outcome === 'restarted') {
		out.step(
			'restart intent: the worker holding the checkout discards it — dirty and unpushed work included — before provisioning',
		);
	}

	if (result.recoveryCleared) {
		out.step('recovery record: cleared');
	}

	// The one step that reports work *lost* (issue #567): the run stops waiting for
	// the machine that held its preserved checkout, and that attempt is not carried
	// over. Warned rather than stepped, because nothing else here is irreversible.
	if (result.abandonedPreservedWorkerId) {
		out.warn(
			`preserved work: discarded — this run is no longer pinned to worker ${result.abandonedPreservedWorkerId}, and that attempt's progress is not carried over`,
		);
	}

	// A stated terminal ending is a *reported outcome*, not a failure (issue #744):
	// the run was cleared and settled rather than left wedged, so it exits 0 with the
	// reason on stdout like every other step.
	if (result.outcome === 'terminated') {
		out.step(`not restarted: ${result.reason}`);
		return;
	}
	out.step(`restarted: re-dispatched from scratch as dispatch ${result.dispatchId}`);
}

async function resetOneRun(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		options: { help: { type: 'boolean', short: 'h' } },
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

	// Stated before anything is touched, because there is no opt-in left to decline
	// (issue #744): the operator's only choice is not to run the command.
	out.warn(
		'a reset discards: uncommitted changes and unpushed commits in the checkout are removed permanently, wherever it lives, and an agent already spawned for this run keeps running',
	);

	try {
		out.step(`resetting run '${runId}'…`);
		const result = await resetRun(runId);
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
