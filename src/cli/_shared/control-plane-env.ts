/**
 * Leaving a worker checkout's `.env` pointed at an installation — the one piece of
 * onboarding that used to be an `echo` in a runbook.
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
 * `register-and-enroll` calls this before anything else, because every step it
 * takes needs the URL. Two rules keep it safe to run on a machine that is already
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

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import * as out from './output.js';
import { REPO_ROOT } from './paths.js';

const ENV_FILE = '.env';
export const CONTROL_PLANE_ENV = 'SWARM_CONTROL_PLANE_URL';

/**
 * An uncommented assignment of {@link CONTROL_PLANE_ENV}, capturing its value.
 * `export` is tolerated because a `.env` carrying one is still a file this must
 * not append a second assignment to, whatever Node's own `--env-file` parser
 * makes of the prefix.
 */
const ASSIGNMENT = /^[ \t]*(?:export[ \t]+)?SWARM_CONTROL_PLANE_URL[ \t]*=(.*)$/;

/** What the checkout's `.env` says about {@link CONTROL_PLANE_ENV}. */
type EnvState =
	| { kind: 'absent'; contents: string }
	| { kind: 'set'; value: string }
	| { kind: 'empty' };

/** Strip one pair of matching quotes, the only `.env` quoting this needs to see through. */
function unquote(raw: string): string {
	const value = raw.trim();
	const quoted =
		value.length >= 2 &&
		(value.startsWith('"') || value.startsWith("'")) &&
		value.at(-1) === value[0];
	return quoted ? value.slice(1, -1).trim() : value;
}

/**
 * Read the checkout's `.env` and classify it. A missing file reads as `absent`
 * with empty contents — the same state as a file that simply has no assignment,
 * since both are resolved by appending one.
 */
async function readEnvState(path: string): Promise<EnvState> {
	let contents = '';
	try {
		contents = await readFile(path, 'utf8');
	} catch (err) {
		// Anything but "no such file" is a real failure (a directory in the way, no
		// permission) and must not be mistaken for an un-bootstrapped checkout.
		if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
		return { kind: 'absent', contents: '' };
	}

	for (const line of contents.split('\n')) {
		const match = ASSIGNMENT.exec(line);
		if (!match) continue;
		const value = unquote(match[1] ?? '');
		return value ? { kind: 'set', value } : { kind: 'empty' };
	}
	return { kind: 'absent', contents };
}

/**
 * Validate a control-plane URL the way the worker client and `swarm login` do
 * (`../../transport/worker-client.ts`'s `deriveTransportUrls`,
 * `../commands/login.ts`'s `resolveSessionEndpoint`), so a value written here is
 * one those two can derive their endpoints from. The base URL only — no endpoint
 * is built and nothing is requested.
 */
function validateUrl(raw: string): { url: string } | { error: string } {
	const value = raw.trim();
	if (!value) return { error: `${CONTROL_PLANE_ENV} cannot be empty` };

	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return { error: `${CONTROL_PLANE_ENV} is not a valid URL: '${value}'` };
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
		return { error: `${CONTROL_PLANE_ENV} must be an http(s) URL, got '${value}'` };
	return { url: value };
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

/**
 * Leave this checkout's `.env` carrying a control-plane URL and answer which one,
 * also exporting it into this process so a caller that already started without it
 * can go on to use it. Prints its own failures and answers `undefined` for them,
 * since each is a state a human has to settle.
 *
 * `requested` wins, then the ambient environment — where an operator who exported
 * the URL for an earlier `swarm login` already has it — then the operator, on a
 * TTY. A machine being onboarded non-interactively with neither is told which flag
 * to pass rather than prompted into a hang.
 */
export async function ensureControlPlaneUrl(
	requested: string | undefined,
	flagName = '--control-plane-url',
): Promise<string | undefined> {
	const path = resolve(REPO_ROOT, ENV_FILE);
	const state = await readEnvState(path);
	const wanted = requested?.trim();

	if (state.kind === 'empty') {
		out.error(
			`${ENV_FILE} assigns ${CONTROL_PLANE_ENV} no value — fill it in, or delete the line and re-run (${path})`,
		);
		return undefined;
	}

	if (state.kind === 'set') {
		if (wanted && wanted !== state.value) {
			out.error(
				`${ENV_FILE} already points at ${state.value}, not the requested ${wanted} — edit it by hand if this machine is moving installation (${path})`,
			);
			return undefined;
		}
		process.env[CONTROL_PLANE_ENV] = state.value;
		return state.value;
	}

	const supplied = wanted || process.env[CONTROL_PLANE_ENV]?.trim();
	const answered = supplied || (process.stdin.isTTY ? await promptUrl() : undefined);
	if (!answered) {
		out.error(
			`${ENV_FILE} carries no ${CONTROL_PLANE_ENV} — pass ${flagName} <url> (stdin is not a terminal, so there is nobody to prompt)`,
		);
		return undefined;
	}

	const validated = validateUrl(answered);
	if ('error' in validated) {
		out.error(validated.error);
		return undefined;
	}

	// Append-only, and never onto a final line missing its newline — that line
	// would otherwise absorb the assignment.
	const separator = state.contents && !state.contents.endsWith('\n') ? '\n' : '';
	await writeFile(path, `${state.contents}${separator}${CONTROL_PLANE_ENV}=${validated.url}\n`);
	out.info(
		state.contents
			? `added ${CONTROL_PLANE_ENV}=${validated.url} to ${ENV_FILE}`
			: `created ${ENV_FILE} with ${CONTROL_PLANE_ENV}=${validated.url}`,
	);
	process.env[CONTROL_PLANE_ENV] = validated.url;
	return validated.url;
}
