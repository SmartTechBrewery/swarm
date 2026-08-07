/**
 * Tri-state PATH probe for an agent CLI binary, shared by the DB-free transport
 * capability discovery (`../transport/cli-discovery.ts`) and the host worker's
 * quota discovery (`./quota-discovery.ts`).
 *
 * The distinction this module exists to make (issue #559): a probe that *times
 * out* proves nothing about the binary, while `ENOENT` proves it is not on PATH.
 * Both used to collapse into one `false`, which is how a two-second hiccup on a
 * loaded machine declared an installed `claude` absent — and for a remote daemon
 * a narrowed capability set is a fatal handshake rejection, so the machine
 * dropped out of the pool until a human restarted it. Only `'absent'` is a claim
 * of proof; `'indeterminate'` hands the decision back to the caller, which knows
 * what a wrong answer costs it.
 *
 * Deliberately dependency-free beyond `node:child_process`, so the DB-free daemon
 * can use it without pulling in the datastore (ADR-003 §1).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * What a single probe established. `'present'` and `'absent'` are answers;
 * `'indeterminate'` is the explicit absence of one — the spawn happened but the
 * process never settled within the budget.
 */
export type BinaryProbeOutcome = 'present' | 'absent' | 'indeterminate';

/**
 * Default budget for one probe. Deliberately wider than the 2 s it replaces: a
 * cold start of an agent CLI on a machine that is also compiling is routinely
 * slower than that. Raising it is not the fix on its own — any finite budget can
 * be missed, which is what {@link BinaryProbeOutcome}'s third state is for — it
 * just makes the question come up less often.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export interface BinaryProbeOptions {
	/** Probe arguments; defaults to `--version`. */
	args?: string[];
	/** Budget for each invocation; defaults to {@link DEFAULT_PROBE_TIMEOUT_MS}. */
	timeoutMs?: number;
}

/** `ENOENT` from a spawn is the only proof that a binary is not on PATH. */
function isMissingBinaryError(err: unknown): boolean {
	return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

/**
 * Whether the probe ran out of budget rather than answering. `execFile`'s own
 * timeout kills the child and reports `killed: true`; `ETIMEDOUT` covers a spawn
 * that timed out before the process was reaped.
 */
function isProbeTimeout(err: unknown): boolean {
	const e = err as (NodeJS.ErrnoException & { killed?: boolean }) | undefined;
	return e?.killed === true || e?.code === 'ETIMEDOUT';
}

/**
 * Probe whether `command` exists and runs on PATH.
 *
 * A binary that exists but exits non-zero or has no `--version` is still present,
 * so a bare invocation confirms it. A *timeout* short-circuits that fallback
 * deliberately: the process was spawned, so the binary is there, and re-running a
 * CLI that just stalled (several open their TUI when given no arguments) only
 * doubles the stall for an answer we already have.
 */
export async function probeBinary(
	command: string,
	options: BinaryProbeOptions = {},
): Promise<BinaryProbeOutcome> {
	const args = options.args ?? ['--version'];
	const timeout = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
	try {
		await execFileAsync(command, args, { timeout });
		return 'present';
	} catch (err) {
		if (isMissingBinaryError(err)) return 'absent';
		if (isProbeTimeout(err)) return 'indeterminate';
		try {
			await execFileAsync(command, [], { timeout });
			return 'present';
		} catch (fallbackErr) {
			if (isProbeTimeout(fallbackErr)) return 'indeterminate';
			return 'absent';
		}
	}
}
