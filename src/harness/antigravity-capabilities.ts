/**
 * Does the installed `agy` understand `--output-format`?
 *
 * The flag is recent: `agy` 1.1.3 — the version SWARM's harness comments were
 * originally written against — has no such flag, while 1.1.10 lists it in
 * `--help` as `Output format for print mode (text, json, stream-json)`. Passing
 * it unconditionally would send an unknown flag to an older binary, so the
 * harness asks first and falls back to plain-text output when the answer is no.
 *
 * We probe `--help` rather than gate on a `--version` floor: help states the
 * capability directly, whereas the release that first added the flag is unknown
 * (1.1.10 is merely where it was observed). That is also what ai/RULES.md §6
 * requires — verify a CLI's behavior against its own `--help`, never infer it
 * from another CLI's shape.
 *
 * Deliberately not part of `../transport/cli-discovery.ts`: that module answers
 * "which binaries exist" for a *remote daemon's* handshake, and the in-process
 * host worker never consults it (it goes through `./quota-discovery.ts`), so
 * gating there would leave the harness itself ungated.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** How long a single `--help` probe may run before the answer is assumed "no". */
const PROBE_TIMEOUT_MS = 2_000;

/**
 * A help line *declaring* the flag — anchored to the start of a line so another
 * flag's prose merely mentioning `--output-format` (as `--json-schema`'s
 * description does: "for stream-json, only applicable to the final result")
 * can't be mistaken for the flag itself being supported.
 */
const OUTPUT_FORMAT_LINE_RE = /^\s*--output-format\b/m;

/**
 * One in-flight/settled probe per command name. Concurrent runs share a single
 * `agy --help`, and a worker pays for it once. Consequence: an in-place `agy`
 * upgrade isn't noticed until the worker restarts — acceptable, since the
 * operator owns that restart and the stale answer only costs the older
 * behavior for the rest of the process's life.
 */
const probes = new Map<string, Promise<boolean>>();

/**
 * The outcome of one print-mode slash-command attempt. `undefined` means this
 * process has not observed the capability yet; `false` avoids spending another
 * agent turn on a build that treated the command as an ordinary prompt.
 */
const printModeCommandAnswers = new Map<string, boolean>();

/** The combined output of a finished-or-failed `execFile`, however it ended. */
function probeOutput(value: unknown): string {
	const record = value as { stdout?: unknown; stderr?: unknown } | null | undefined;
	const stdout = typeof record?.stdout === 'string' ? record.stdout : '';
	const stderr = typeof record?.stderr === 'string' ? record.stderr : '';
	return `${stdout}\n${stderr}`;
}

async function probeOutputFormat(command: string): Promise<boolean> {
	try {
		return OUTPUT_FORMAT_LINE_RE.test(
			probeOutput(await execFileAsync(command, ['--help'], { timeout: PROBE_TIMEOUT_MS })),
		);
	} catch (err) {
		// A CLI that prints its usage and then exits non-zero still answered the
		// question, so the rejection's own captured output is inspected before
		// giving up. Anything else — ENOENT, a timeout, a binary that prints
		// nothing — falls through to `false`, i.e. today's plain-text behavior.
		return OUTPUT_FORMAT_LINE_RE.test(probeOutput(err));
	}
}

/**
 * Whether the `agy` binary at `command` supports `--output-format`. Never
 * throws and never rejects: an unknown answer is `false`, which keeps the run
 * on the pre-structured-output path rather than failing it.
 */
export function supportsOutputFormat(command: string): Promise<boolean> {
	const cached = probes.get(command);
	if (cached) return cached;
	const probe = probeOutputFormat(command);
	probes.set(command, probe);
	return probe;
}

/** Whether this process has observed `command` answer a print-mode slash command. */
export function answersPrintModeCommands(command: string): boolean | undefined {
	return printModeCommandAnswers.get(command);
}

/** Record a print-mode slash-command capability observation for this process. */
export function recordPrintModeCommandAnswer(command: string, answers: boolean): void {
	printModeCommandAnswers.set(command, answers);
}

/** Drop the memoized probe results. Test-only seam. */
export function resetOutputFormatProbeCache(): void {
	probes.clear();
	printModeCommandAnswers.clear();
}

/** Exported for tests that need the real timeout value. */
export const ANTIGRAVITY_PROBE_TIMEOUT_MS = PROBE_TIMEOUT_MS;
