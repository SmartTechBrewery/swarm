/**
 * Child-process helper for the operator CLI. Deliberately thinner than the
 * agent harness (`src/harness/agent-cli.ts`): that one captures and streams
 * output for the pipeline; here we just hand the child our own stdio so
 * `docker compose` prints straight to the developer's terminal, and resolve
 * with its exit code.
 */

import { spawn } from 'node:child_process';

/**
 * Run `command args` with inherited stdio and resolve with its exit code (a
 * non-zero code is a normal outcome the caller decides how to treat, mirroring
 * `runAgentCli`). Only a spawn failure rejects — most usefully `ENOENT`, which
 * means the binary (typically `docker`) isn't installed or on PATH.
 *
 * `options.env` is merged *over* this process's own environment rather than
 * replacing it, and the merge happens here rather than at the call site: a caller
 * that passed a bare `{ FOO: 'bar' }` would otherwise silently strip `PATH` (and
 * `HOME`, and everything else) from the child.
 */
export function runCommand(
	command: string,
	args: string[],
	options?: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			stdio: 'inherit',
			cwd: options?.cwd,
			env: options?.env ? { ...process.env, ...options.env } : undefined,
		});
		child.on('error', (err) => {
			const code = (err as NodeJS.ErrnoException).code;
			reject(
				new Error(
					code === 'ENOENT'
						? `\`${command}\` not found on PATH — is it installed?`
						: `failed to run \`${command}\`: ${err.message}`,
				),
			);
		});
		child.on('close', (code) => resolve(code ?? 0));
	});
}
