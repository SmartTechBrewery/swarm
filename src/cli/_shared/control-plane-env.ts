/**
 * Which installation a `swarm` command talks to, and leaving a worker checkout's
 * `.env` pointed at one — the piece of onboarding that used to be an `echo` in a
 * runbook.
 *
 * **One precedence, for every command** (issue #1214): `--control-plane-url` on the
 * commands that take it, then `SWARM_CONTROL_PLANE_URL` in the environment, then
 * the same assignment in this checkout's `.env` — read with Node's own parser, so
 * it means exactly what the worker daemon's `--env-file-if-exists` makes of it. The
 * daemon has no flag and Node lets the environment win over `.env`, so it already
 * follows the same rule. {@link resolveControlPlaneUrl} is that rule for the
 * operator-API commands; {@link ensureControlPlaneUrl} applies it too, and then
 * also bootstraps `.env`. Before this, `login` let `.env` win over the environment
 * and `workers list` / `run *` never read `.env` at all, so the two could ask
 * different installations from the same shell.
 *
 * A worker holds two values and is *given* one of them: `SWARM_WORKER_CREDENTIAL`
 * arrives from `workers register` / `register-and-enroll` and is cached per
 * checkout (`./worker-credential-cache.ts`). The other, `SWARM_CONTROL_PLANE_URL`,
 * the daemon reads out of this checkout's `.env` — and nothing wrote it there.
 * `swarm init` was the wrong thing to point an operator at: it copies
 * `.env.docker.example` wholesale, leaving a `DATABASE_URL` on a machine that must
 * never have one (ADR-003 §2). So the step lived in prose, which is exactly where
 * it cannot be made safe: a runbook cannot know whether the file exists, already
 * carries the key, or points at a different installation.
 *
 * `login`, `workers setup` and `register-and-enroll` call
 * {@link ensureControlPlaneUrl} before anything else, because every step they take
 * needs the URL. Two rules keep it safe to run on a machine that is already
 * onboarded — which is the normal case for a second worker:
 *
 * - **Never clobber.** An existing assignment is reported and left exactly as it
 *   is, so a re-run is a check rather than an edit (`./commands/init.ts`'s own
 *   semantics).
 * - **Append only.** Editing a line in place would mean parsing and rewriting an
 *   operator's `.env`, and the one thing this must not do is lose a value it does
 *   not understand. The two states it cannot resolve by appending — a different
 *   URL, an empty assignment — are reported for a human to settle.
 *
 * It writes a file and talks to nothing. The first thing that actually reaches the
 * installation is the session behind the caller's next request, so a URL accepted
 * here is not yet a URL that answers.
 */

import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseEnv } from 'node:util';
import * as out from './output.js';
import { REPO_ROOT } from './paths.js';

const ENV_FILE = '.env';
export const CONTROL_PLANE_ENV = 'SWARM_CONTROL_PLANE_URL';
const DEFAULT_FLAG = '--control-plane-url';

/** Where a resolved URL came from — for the messages that must say which installation was asked. */
export type ControlPlaneUrlSource = 'flag' | 'environment' | 'env-file';

/** What the checkout's `.env` says about {@link CONTROL_PLANE_ENV}. */
type EnvState =
	| { kind: 'absent'; contents: string }
	| { kind: 'set'; value: string }
	| { kind: 'empty' };

function envFilePath(): string {
	return resolve(REPO_ROOT, ENV_FILE);
}

/**
 * Read the checkout's `.env` and classify it. A missing file reads as `absent`
 * with empty contents — the same state as a file that simply has no assignment,
 * since both are resolved by appending one.
 *
 * Synchronous because the operator-API commands resolve their session
 * synchronously. Parsed with `util.parseEnv`, the parser behind the daemon's own
 * `--env-file-if-exists`, so quotes, an `export` prefix, comments and a repeated
 * assignment (the last one wins) read here exactly as they do there.
 */
function readEnvState(path: string): EnvState {
	let contents = '';
	try {
		contents = readFileSync(path, 'utf8');
	} catch (err) {
		// Anything but "no such file" is a real failure (a directory in the way, no
		// permission) and must not be mistaken for an un-bootstrapped checkout.
		if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
		return { kind: 'absent', contents: '' };
	}

	const value = parseEnv(contents)[CONTROL_PLANE_ENV];
	if (value === undefined) return { kind: 'absent', contents };
	const trimmed = value.trim();
	return trimmed ? { kind: 'set', value: trimmed } : { kind: 'empty' };
}

/** The precedence itself, written once: the first non-empty of flag, environment, `.env`. */
function pickControlPlaneUrl(
	requested: string | undefined,
	state: EnvState,
): { value: string; source: ControlPlaneUrlSource } | undefined {
	const flag = requested?.trim();
	if (flag) return { value: flag, source: 'flag' };
	const ambient = process.env[CONTROL_PLANE_ENV]?.trim();
	if (ambient) return { value: ambient, source: 'environment' };
	if (state.kind === 'set') return { value: state.value, source: 'env-file' };
	return undefined;
}

/** Name a source the way an operator would look for it. */
function describeSource(source: ControlPlaneUrlSource, flagName = DEFAULT_FLAG): string {
	if (source === 'flag') return flagName;
	if (source === 'environment') return 'the environment';
	return envFilePath();
}

/**
 * Validate a control-plane URL the way the worker client and `swarm login` do
 * (`../../transport/worker-client.ts`'s `deriveTransportUrls`,
 * `../commands/login.ts`'s `resolveSessionEndpoint`), so a value written here is
 * one those two can derive their endpoints from. The base URL only — no endpoint
 * is built and nothing is requested. `origin`, when known, names where the value
 * came from, since a bad value in a forgotten `.env` is otherwise hard to find.
 */
function validateUrl(raw: string, origin?: string): { url: string } | { error: string } {
	const value = raw.trim();
	const subject = origin ? `${CONTROL_PLANE_ENV} from ${origin}` : CONTROL_PLANE_ENV;
	if (!value) return { error: `${subject} cannot be empty` };

	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return { error: `${subject} is not a valid URL: '${value}'` };
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
		return { error: `${subject} must be an http(s) URL, got '${value}'` };
	return { url: value };
}

/**
 * The control-plane URL a command should use, by the one precedence every command
 * shares — flag, then environment, then this checkout's `.env` — and where it came
 * from; or the single line explaining why there is none. Reads, never writes:
 * this is what the operator-API commands use, so `swarm workers list` right after
 * `swarm login` finds the URL `login` left in `.env` without anything exported.
 */
export function resolveControlPlaneUrl(
	requested?: string,
): { url: string; source: ControlPlaneUrlSource } | { error: string } {
	const path = envFilePath();
	const picked = pickControlPlaneUrl(requested, readEnvState(path));
	if (!picked) {
		return {
			error: `${CONTROL_PLANE_ENV} is unset — export it, or set it in ${path} (e.g. https://swarm.example.com)`,
		};
	}
	const validated = validateUrl(picked.value, describeSource(picked.source));
	if ('error' in validated) return validated;
	return { url: validated.url, source: picked.source };
}

/** Ask for the URL on a TTY, with echo — it is configuration, not a secret. */
async function promptUrl(): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return (await rl.question(`${CONTROL_PLANE_ENV} (e.g. https://swarm.example.com): `)).trim();
	} finally {
		rl.close();
	}
}

/** How {@link ensureControlPlaneUrl} treats a resolved URL that differs from `.env`'s. */
export interface EnsureControlPlaneUrlOptions {
	/**
	 * `'refuse'` (the default) for a command that registers a worker: the daemon a
	 * launchd plist starts reads only `.env`, so a worker registered on one
	 * installation while `.env` names another would never connect. `'warn'` for
	 * `swarm login`, which leaves nothing behind that depends on `.env`.
	 */
	onEnvFileConflict?: 'refuse' | 'warn';
	/** The flag to name when there is nothing to resolve and nobody to prompt. */
	flagName?: string;
}

/**
 * Report a resolved URL that differs from `.env`'s: refused (answers `false`) or
 * warned about (answers `true`, go on with the resolved one), per `mode`.
 */
function settleEnvFileConflict(
	conflict: {
		envValue: string;
		url: string;
		source: ControlPlaneUrlSource;
		flagName: string;
		path: string;
	},
	mode: 'refuse' | 'warn',
): boolean {
	const { envValue, url, source, flagName, path } = conflict;
	const origin = describeSource(source, flagName);
	if (mode === 'refuse') {
		const remedy = source === 'flag' ? `drop ${flagName}` : `unset ${CONTROL_PLANE_ENV}`;
		out.error(
			`${ENV_FILE} already points at ${envValue}, not ${url} from ${origin} — a worker registered on ${url} would still connect to ${envValue}. Edit it by hand if this machine is moving installation, or ${remedy} (${path})`,
		);
		return false;
	}
	out.warn(
		`using ${url} from ${origin}, although this checkout's ${ENV_FILE} points at ${envValue} — anything run here without that override (the worker included) talks to ${envValue} (${path})`,
	);
	return true;
}

/**
 * Append the assignment — append-only, and never onto a final line missing its
 * newline, which would otherwise absorb it.
 */
async function appendAssignment(path: string, contents: string, url: string): Promise<void> {
	const separator = contents && !contents.endsWith('\n') ? '\n' : '';
	await writeFile(path, `${contents}${separator}${CONTROL_PLANE_ENV}=${url}\n`);
	out.info(
		contents
			? `added ${CONTROL_PLANE_ENV}=${url} to ${ENV_FILE}`
			: `created ${ENV_FILE} with ${CONTROL_PLANE_ENV}=${url}`,
	);
}

/**
 * Resolve the control-plane URL by the shared precedence ({@link
 * resolveControlPlaneUrl}), leave this checkout's `.env` carrying one, and answer
 * which URL to use — also exporting it into this process, so a caller that started
 * without it (or with a different value in the environment than the flag) goes on
 * to use the resolved one. Prints its own failures and answers `undefined` for
 * them, since each is a state a human has to settle.
 *
 * With nothing to resolve the operator is prompted on a TTY; a machine being
 * onboarded non-interactively is told which flag to pass rather than prompted into
 * a hang. `.env` is written only when it carries no assignment; a different one
 * already there is refused or warned about per `onEnvFileConflict`.
 */
export async function ensureControlPlaneUrl(
	requested: string | undefined,
	options: EnsureControlPlaneUrlOptions = {},
): Promise<string | undefined> {
	const { onEnvFileConflict = 'refuse', flagName = DEFAULT_FLAG } = options;
	const path = envFilePath();
	const state = readEnvState(path);

	if (state.kind === 'empty') {
		out.error(
			`${ENV_FILE} assigns ${CONTROL_PLANE_ENV} no value — fill it in, or delete the line and re-run (${path})`,
		);
		return undefined;
	}

	const picked = pickControlPlaneUrl(requested, state);
	const answered = picked?.value || (process.stdin.isTTY ? await promptUrl() : undefined);
	if (!answered) {
		out.error(
			`${CONTROL_PLANE_ENV} is unset in the environment and in ${path} — pass ${flagName} <url> (stdin is not a terminal, so there is nobody to prompt)`,
		);
		return undefined;
	}

	const origin = picked ? describeSource(picked.source, flagName) : undefined;
	const validated = validateUrl(answered, origin);
	if ('error' in validated) {
		out.error(validated.error);
		return undefined;
	}
	const url = validated.url;

	// `picked` is always defined when `.env` is `set` (it is itself a candidate);
	// checking it only narrows the type.
	if (picked && state.kind === 'set' && state.value !== url) {
		const conflict = { envValue: state.value, url, source: picked.source, flagName, path };
		if (!settleEnvFileConflict(conflict, onEnvFileConflict)) return undefined;
	}

	if (state.kind === 'absent') await appendAssignment(path, state.contents, url);

	process.env[CONTROL_PLANE_ENV] = url;
	return url;
}
