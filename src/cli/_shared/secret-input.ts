/**
 * Reading a secret from an operator without leaving it behind — the shared half of
 * `swarm users set-password` and `swarm workers set-scm-credential`.
 *
 * Both take a value that must never reach the shell history or `ps` output, so
 * neither accepts one as an argv: on a TTY it is typed without echo, and otherwise
 * read from stdin so a script can pipe it. Extracted from `../commands/users.ts`
 * with issue #765, when the second caller arrived; `users set-password` behaves
 * exactly as before.
 */

// Control characters handled while reading a hidden line, by char code.
const ENTER = ['\n'.charCodeAt(0), '\r'.charCodeAt(0)];
const CTRL_D = 4;
const CTRL_C = 3;
const BACKSPACE = [127, 8];

/** Classify a raw-mode keystroke while reading a hidden line. */
function classifyKey(ch: string): 'submit' | 'abort' | 'erase' | 'append' {
	const code = ch.charCodeAt(0);
	if (ENTER.includes(code) || code === CTRL_D) return 'submit';
	if (code === CTRL_C) return 'abort';
	if (BACKSPACE.includes(code)) return 'erase';
	return 'append';
}

/**
 * Read a line from a TTY without echoing it, so a typed secret never appears on
 * screen or in the terminal scrollback. Handles Enter (submit), Backspace, and
 * Ctrl-C/Ctrl-D. Dependency-free (raw mode over `process.stdin`).
 */
export function promptHidden(prompt: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const stdin = process.stdin;
		process.stdout.write(prompt);
		stdin.resume();
		stdin.setRawMode?.(true);
		stdin.setEncoding('utf8');
		let input = '';
		const finish = (aborted: boolean) => {
			stdin.setRawMode?.(false);
			stdin.pause();
			stdin.removeListener('data', onData);
			process.stdout.write('\n');
			if (aborted) reject(new Error('aborted'));
			else resolve(input);
		};
		const onData = (chunk: string) => {
			for (const ch of chunk) {
				const action = classifyKey(ch);
				if (action === 'append') input += ch;
				else if (action === 'erase') input = input.slice(0, -1);
				else return finish(action === 'abort');
			}
		};
		stdin.on('data', onData);
	});
}

/** Read all of stdin (a piped/redirected secret), stripping one trailing newline. */
export async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks)
		.toString('utf8')
		.replace(/\r?\n$/, '');
}
