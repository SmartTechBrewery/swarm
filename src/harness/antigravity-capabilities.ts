/**
 * Which optional flags does the installed `agy` understand?
 *
 * Two flags are asked about here, both for the same reason: they are recent
 * enough that a worker may be on a build without them, and handing an unknown
 * flag to a Go `flag`-parsed binary aborts the run before it starts.
 *
 *  - `--output-format`: `agy` 1.1.3 — the version SWARM's harness comments were
 *    originally written against — has no such flag, while 1.1.10 lists it in
 *    `--help` as `Output format for print mode (text, json, stream-json)`.
 *  - `--print-timeout`: `Timeout for print mode wait (default 5m0s)`, observed
 *    on 1.1.5. Without it every Antigravity run is capped at agy's own 5
 *    minutes regardless of the phase's configured budget (issue #999).
 *
 * We probe `--help` rather than gate on a `--version` floor: help states the
 * capability directly, whereas the release that first added each flag is
 * unknown (1.1.10 and 1.1.5 are merely where they were observed). That is also
 * what ai/RULES.md §6 requires — verify a CLI's behavior against its own
 * `--help`, never infer it from another CLI's shape. One `--help` run answers
 * both questions, so adding the second flag costs no extra probe.
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
 * Help lines *declaring* each flag — anchored to the start of a line so another
 * flag's prose merely mentioning one (as `--json-schema`'s description mentions
 * `--output-format`: "for stream-json, only applicable to the final result")
 * can't be mistaken for the flag itself being supported.
 */
const OUTPUT_FORMAT_LINE_RE = /^\s*--output-format\b/m;
const PRINT_TIMEOUT_LINE_RE = /^\s*--print-timeout\b/m;

/** The optional `agy` flags one `--help` probe answers for. */
export interface AntigravityCapabilities {
	/** `--output-format text|json|stream-json` (issue #465). */
	outputFormat: boolean;
	/** `--print-timeout <duration>` (issue #999). */
	printTimeout: boolean;
}

/**
 * One in-flight/settled probe per command name. Concurrent runs share a single
 * `agy --help`, and a worker pays for it once. Consequence: an in-place `agy`
 * upgrade isn't noticed until the worker restarts — acceptable, since the
 * operator owns that restart and the stale answer only costs the older
 * behavior for the rest of the process's life.
 */
const probes = new Map<string, Promise<AntigravityCapabilities>>();

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

function readCapabilities(help: string): AntigravityCapabilities {
	return {
		outputFormat: OUTPUT_FORMAT_LINE_RE.test(help),
		printTimeout: PRINT_TIMEOUT_LINE_RE.test(help),
	};
}

async function probeCapabilities(command: string): Promise<AntigravityCapabilities> {
	try {
		return readCapabilities(
			probeOutput(await execFileAsync(command, ['--help'], { timeout: PROBE_TIMEOUT_MS })),
		);
	} catch (err) {
		// A CLI that prints its usage and then exits non-zero still answered the
		// question, so the rejection's own captured output is inspected before
		// giving up. Anything else — ENOENT, a timeout, a binary that prints
		// nothing — falls through to no capabilities, i.e. today's behavior.
		return readCapabilities(probeOutput(err));
	}
}

/**
 * What the `agy` binary at `command` advertises in its own `--help`. Never
 * throws and never rejects: an unknown answer is "flag absent", which keeps the
 * run on the pre-flag path rather than failing it.
 */
export function antigravityCapabilities(command: string): Promise<AntigravityCapabilities> {
	const cached = probes.get(command);
	if (cached) return cached;
	const probe = probeCapabilities(command);
	probes.set(command, probe);
	return probe;
}

/** Whether the `agy` binary at `command` supports `--output-format`. */
export function supportsOutputFormat(command: string): Promise<boolean> {
	return antigravityCapabilities(command).then((caps) => caps.outputFormat);
}

/** Whether the `agy` binary at `command` supports `--print-timeout`. */
export function supportsPrintTimeout(command: string): Promise<boolean> {
	return antigravityCapabilities(command).then((caps) => caps.printTimeout);
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
export function resetAntigravityCapabilityCache(): void {
	probes.clear();
	printModeCommandAnswers.clear();
}

/** Exported for tests that need the real timeout value. */
export const ANTIGRAVITY_PROBE_TIMEOUT_MS = PROBE_TIMEOUT_MS;
