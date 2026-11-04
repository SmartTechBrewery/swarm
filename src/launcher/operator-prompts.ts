/**
 * How `swarm-worker setup` and `swarm-worker login` (issue #1311) get their
 * answers: from a flag, from a terminal, or not at all.
 *
 * Every question has a flag, so both commands run unattended. With no terminal
 * there is nobody to ask, so a missing answer is a failure **naming the flag** that
 * would have supplied it — never a prompt into a hang. Secrets (the installation
 * password, the operator's SCM token) are never taken from argv, where they would
 * reach the shell history and `ps`: they are typed without echo, or read from a file
 * or from stdin (`--password-file -`). Only one of the two may be `-`, because stdin
 * holds one stream.
 *
 * Nothing here prints, logs or keeps a secret it reads; the caller hands it to the
 * one request that needs it.
 */

import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { promptHidden, readStdin } from '../cli/_shared/secret-input.js';

/** The terminal and the secret sources a command reads from — injectable for tests. */
export interface PromptIo {
	/** Whether there is a terminal to ask on. */
	isTTY: boolean;
	/** Ask with echo — for answers that are not secrets. */
	ask(question: string): Promise<string>;
	/** Ask without echo — for a secret. */
	askHidden(question: string): Promise<string>;
	readStdin(): Promise<string>;
	readFile(path: string): string;
}

export function defaultPromptIo(): PromptIo {
	return {
		isTTY: process.stdin.isTTY === true,
		async ask(question) {
			const rl = createInterface({ input: process.stdin, output: process.stdout });
			try {
				return await rl.question(question);
			} finally {
				rl.close();
			}
		},
		askHidden: promptHidden,
		readStdin,
		readFile: (path) => readFileSync(path, 'utf8'),
	};
}

/** The refusal for an answer nobody can give: no flag, and no terminal to ask on. */
export function missingAnswer(command: string, what: string, flag: string): string {
	return `swarm-worker ${command}: ${what} is required — pass ${flag} (stdin is not a terminal, so there is nobody to ask)`;
}

/**
 * Refuse `-` for more than one secret source — stdin is one stream. Answers the
 * refusal, or `undefined` when the sources are fine.
 */
export function refuseTwoStdinSources(
	command: string,
	sources: Record<string, string | undefined>,
): string | undefined {
	const fromStdin = Object.entries(sources)
		.filter(([, value]) => value === '-')
		.map(([flag]) => flag);
	if (fromStdin.length < 2) return undefined;
	return `swarm-worker ${command}: only one of ${fromStdin.join(' and ')} may be - (stdin carries one secret)`;
}

/**
 * Read a secret from `source` — a file path, or `-` for stdin — stripping the
 * trailing newline a file or a pipe ends with. Answers `{ error }` naming the flag
 * for an unreadable file or an empty secret; the error never carries the value.
 */
export async function readSecretSource(
	io: PromptIo,
	source: string,
	flag: string,
): Promise<{ value: string } | { error: string }> {
	let raw: string;
	if (source === '-') {
		raw = await io.readStdin();
	} else {
		try {
			raw = io.readFile(source);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException)?.code;
			return { error: `${flag} ${source} could not be read${code ? ` (${code})` : ''}` };
		}
	}
	const value = raw.replace(/\r?\n$/, '');
	if (value.trim().length === 0) return { error: `${flag} ${source} holds an empty secret` };
	return { value };
}

/**
 * A secret from its flag's source when given, else typed without echo, else the
 * refusal naming the flag. `undefined` from a hidden prompt the operator aborted
 * (Ctrl-C) is reported as such.
 */
export async function resolveSecret(
	io: PromptIo,
	options: { command: string; what: string; flag: string; source?: string; prompt: string },
): Promise<{ value: string } | { error: string }> {
	if (options.source !== undefined) return readSecretSource(io, options.source, options.flag);
	if (!io.isTTY) return { error: missingAnswer(options.command, options.what, options.flag) };
	let typed: string;
	try {
		typed = await io.askHidden(options.prompt);
	} catch {
		return { error: `swarm-worker ${options.command}: aborted` };
	}
	if (typed.trim().length === 0)
		return { error: `swarm-worker ${options.command}: ${options.what} must not be empty` };
	return { value: typed };
}

/**
 * A non-secret answer: its flag when given, else asked on a terminal offering
 * `fallback` as the answer to Enter, else `fallback` itself when `acceptDefault`
 * (`--yes`) or there is no terminal and a default exists, else the refusal naming
 * the flag.
 */
export async function resolveAnswer(
	io: PromptIo,
	options: {
		command: string;
		what: string;
		flag: string;
		value?: string;
		question: string;
		fallback?: string;
		acceptDefault?: boolean;
	},
): Promise<{ value: string } | { error: string }> {
	const given = options.value?.trim();
	if (given) return { value: given };
	const fallback = options.fallback?.trim() || undefined;
	if (fallback && (options.acceptDefault || !io.isTTY)) return { value: fallback };
	if (!io.isTTY) return { error: missingAnswer(options.command, options.what, options.flag) };
	const hint = fallback ? ` [${fallback}]` : '';
	const answer = (await io.ask(`${options.question}${hint}: `)).trim() || fallback;
	if (!answer) return { error: `swarm-worker ${options.command}: ${options.what} is required` };
	return { value: answer };
}
