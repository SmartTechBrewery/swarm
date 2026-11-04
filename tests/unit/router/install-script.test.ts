/**
 * `GET /install.sh` (issue #1312) and `GET /install.ps1` (issue #1324): the rendered
 * scripts, and each script run for real against a local HTTP server serving a
 * launcher package built by `bin/build-worker-launcher.js` — with `HOME` in a temp
 * directory and no terminal. The PowerShell runs need `pwsh` on `PATH` and are
 * skipped without it.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type ServerType, serve } from '@hono/node-server';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { swarmInstallRoot } from '@/lib/build-identity.js';
import {
	powershellQuote,
	registerInstallScript,
	renderInstallPowerShell,
	renderInstallScript,
	resolveInstallationBaseUrl,
	shellQuote,
} from '@/router/install-script.js';
import { registerWorkerLauncher } from '@/router/worker-launcher.js';

const REPO_ROOT = swarmInstallRoot();
const { version: VERSION } = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
const FILE = `swarm-worker-launcher-${VERSION}.tar.gz`;
const NODE_DIR = dirname(process.execPath);
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
/** `pwsh` on this host's `PATH`, which the PowerShell runs need. */
const PWSH = (process.env.PATH ?? '')
	.split(':')
	.filter((dir) => dir !== '')
	.map((dir) => join(dir, 'pwsh'))
	.find((path) => existsSync(path));
/** What the script names the launcher's entry point, for a fake `node` to record. */
const ENTRY = '.swarm/launcher/bin/swarm-worker.js';

const dirs: string[] = [];
function tempDir(label: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), `swarm-install-${label}-`)));
	dirs.push(dir);
	return dir;
}

/** `sh -c` on `script` with its trailing `main "$@"` replaced by `tail`. */
function runPrefix(script: string, tail: string): string {
	const body = script.replace(/main "\$@"\n$/, `${tail}\n`);
	const result = spawnSync('/bin/sh', ['-c', body], { encoding: 'utf8' });
	expect(result.status, result.stderr).toBe(0);
	return result.stdout;
}

describe('renderInstallScript', () => {
	it('renders a syntactically valid POSIX script with set -eu', () => {
		const script = renderInstallScript('https://swarm.example.com');
		expect(script.startsWith('#!/bin/sh\n')).toBe(true);
		expect(script).toContain('\nset -eu\n');
		expect(script).toContain("SWARM_URL='https://swarm.example.com'");
		const check = spawnSync('/bin/sh', ['-n'], { input: script, encoding: 'utf8' });
		expect(check.status, check.stderr).toBe(0);
	});

	it('quotes a URL containing quotes and shell syntax as one literal word', () => {
		const hostile = `https://ex'ample.com/$(touch pwned)\`id\`"; echo x`;
		const script = renderInstallScript(hostile);
		expect(spawnSync('/bin/sh', ['-n'], { input: script }).status).toBe(0);
		expect(runPrefix(script, 'printf %s "$SWARM_URL"')).toBe(hostile);
		expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
	});

	it('renders the script issue #1312 shipped, byte for byte', () => {
		// install.ps1 (issue #1324) was added beside it without touching it.
		expect(
			createHash('sha256').update(renderInstallScript('https://swarm.example.com')).digest('hex'),
		).toBe('4d80d06c0e04cd1154c2f1f8fc3eedd09866fb50d58892ccafa988e4d05e29ef');
	});
});

/** `pwsh -File` on `source`, written to a temp file. */
function runPwsh(source: string): { status: number | null; stdout: string; stderr: string } {
	const file = join(tempDir('ps1'), 'script.ps1');
	writeFileSync(file, source);
	const result = spawnSync(PWSH as string, ['-NoProfile', '-NonInteractive', '-File', file], {
		encoding: 'utf8',
	});
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** The parse errors PowerShell reports for `script`, as `line: message`. */
function powershellParseErrors(script: string): string[] {
	const file = join(tempDir('ps1'), 'install.ps1');
	writeFileSync(file, script);
	const result = runPwsh(
		`$errors = $null; $tokens = $null
[void][System.Management.Automation.Language.Parser]::ParseFile(${powershellQuote(file)}, [ref]$tokens, [ref]$errors)
foreach ($e in $errors) { [Console]::Out.WriteLine("$($e.Extent.StartLineNumber): $($e.Message)") }`,
	);
	expect(result.status, result.stderr).toBe(0);
	return result.stdout.split('\n').filter((line) => line !== '');
}

const HOSTILE_URL = `https://ex'ample.com/$(touch pwned)\`id\`"; echo x ’) ; whoami #`;

describe('renderInstallPowerShell', () => {
	const script = renderInstallPowerShell('https://swarm.example.com');

	it('bakes in the URL, the manifest and package routes and the SHA-256 check', () => {
		expect(script).toContain("$SwarmUrl = 'https://swarm.example.com'");
		expect(script).toContain('"$SwarmUrl/worker/launcher/manifest"');
		expect(script).toContain('"$SwarmUrl/worker/launcher/artifacts/$file"');
		expect(script).toContain('Get-FileHash -Algorithm SHA256');
		expect(script).toContain('Invoke-WebRequest -UseBasicParsing');
	});

	it('is one function called on the last line, and never exits the session', () => {
		expect(script.endsWith('\n}\n\nInstall-SwarmWorker -Arguments $args\n')).toBe(true);
		expect(script).toMatch(/^function Install-SwarmWorker \{$/m);
		expect(script).not.toMatch(/(^|[;{])\s*exit\b/im);
		expect(script).not.toMatch(/ValueFromRemainingArguments/);
	});

	it('is plain ASCII, so no code page can garble it', () => {
		expect(/^[\t\n\x20-\x7e]*$/.test(script)).toBe(true);
	});

	it('roots the install at USERPROFILE on Windows, the home the .cmd, the PATH entry and Node name', () => {
		expect(script).toContain(
			'$userHome = if ($onWindows -and $env:USERPROFILE) { $env:USERPROFILE } else { $HOME }',
		);
		expect(script).toContain("$swarmDir = Join-Path $userHome '.swarm'");
		expect(script).not.toMatch(/Join-Path \$HOME\b/);
		expect(script).toContain('"%USERPROFILE%\\.swarm\\launcher\\bin\\swarm-worker.js"');
		expect(script).toContain("'%USERPROFILE%\\.swarm\\bin'");
	});

	it.skipIf(!PWSH)('resolves that root to USERPROFILE on Windows and to $HOME elsewhere', () => {
		const line = script.split('\n').find((l) => l.trim().startsWith('$userHome = '));
		expect(line).toBeDefined();
		const resolveHome = (onWindows: boolean, userProfile: string): string => {
			const result = runPwsh(
				`$onWindows = $${onWindows}; $env:USERPROFILE = ${powershellQuote(userProfile)}\n${line}\n[Console]::Out.Write($userHome)`,
			);
			expect(result.status, result.stderr).toBe(0);
			return result.stdout;
		};
		const home = runPwsh('[Console]::Out.Write($HOME)').stdout;
		expect(resolveHome(true, 'C:\\Users\\ada')).toBe('C:\\Users\\ada');
		expect(resolveHome(true, '')).toBe(home);
		expect(resolveHome(false, 'C:\\Users\\ada')).toBe(home);
	});

	it('quotes PowerShell strings with every quote PowerShell reads doubled', () => {
		expect(powershellQuote("a'b")).toBe("'a''b'");
		expect(powershellQuote('a’b‘c')).toBe("'a’’b‘‘c'");
		expect(powershellQuote('$(x) `y`')).toBe("'$(x) `y`'");
	});

	it.skipIf(!PWSH)('parses, and keeps a hostile URL one literal', () => {
		expect(powershellParseErrors(script)).toEqual([]);
		expect(powershellParseErrors(renderInstallPowerShell(HOSTILE_URL))).toEqual([]);
		const result = runPwsh(`[Console]::Out.Write(${powershellQuote(HOSTILE_URL)})`);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toBe(HOSTILE_URL);
	});
});

describe('resolveInstallationBaseUrl', () => {
	const headers =
		(values: Record<string, string>) =>
		(name: string): string | undefined =>
			values[name];

	it('prefers the configured public base URL', () => {
		expect(
			resolveInstallationBaseUrl(
				headers({ host: 'evil.example' }),
				'http://evil.example/install.sh',
				'https://swarm.example.com',
			),
		).toBe('https://swarm.example.com');
	});

	it('otherwise uses Host and X-Forwarded-Proto', () => {
		expect(
			resolveInstallationBaseUrl(
				headers({ host: 'swarm.example.com', 'x-forwarded-proto': 'https, http' }),
				'http://swarm.example.com/install.sh',
				undefined,
			),
		).toBe('https://swarm.example.com');
	});

	it("falls back to the request's own scheme", () => {
		expect(
			resolveInstallationBaseUrl(
				headers({ host: 'localhost:3000' }),
				'http://localhost:3000/install.sh',
				undefined,
			),
		).toBe('http://localhost:3000');
	});

	it('refuses a missing Host or one carrying a path', () => {
		expect(resolveInstallationBaseUrl(headers({}), 'http://x/install.sh', undefined)).toBe(
			undefined,
		);
		expect(
			resolveInstallationBaseUrl(
				headers({ host: 'swarm.example.com/evil' }),
				'http://x/install.sh',
				undefined,
			),
		).toBe(undefined);
	});
});

describe('GET /install.sh', () => {
	it('serves the script for the requesting host, never cached', async () => {
		const app = new Hono();
		registerInstallScript(app, { configuredBaseUrl: () => undefined });
		const res = await app.request('http://swarm.example.com/install.sh', {
			headers: { host: 'swarm.example.com', 'x-forwarded-proto': 'https' },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/x-shellscript; charset=utf-8');
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(await res.text()).toBe(renderInstallScript('https://swarm.example.com'));
	});

	it('bakes in the configured base URL when set', async () => {
		const app = new Hono();
		registerInstallScript(app, { configuredBaseUrl: () => 'https://public.example.com' });
		const res = await app.request('http://internal:3000/install.sh');
		expect(await res.text()).toContain("SWARM_URL='https://public.example.com'");
	});
});

describe('GET /install.ps1', () => {
	it('serves the PowerShell installer for the requesting host, never cached', async () => {
		const app = new Hono();
		registerInstallScript(app, { configuredBaseUrl: () => undefined });
		const res = await app.request('http://swarm.example.com/install.ps1', {
			headers: { host: 'swarm.example.com', 'x-forwarded-proto': 'https' },
		});
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(await res.text()).toBe(renderInstallPowerShell('https://swarm.example.com'));
	});

	it('bakes in the configured base URL when set', async () => {
		const app = new Hono();
		registerInstallScript(app, { configuredBaseUrl: () => 'https://public.example.com' });
		const res = await app.request('http://internal:3000/install.ps1');
		expect(await res.text()).toContain("$SwarmUrl = 'https://public.example.com'");
	});
});

describe('either installer with no usable base URL', () => {
	it.each(['/install.sh', '/install.ps1'])('%s answers 400, naming the fix', async (path) => {
		const app = new Hono();
		registerInstallScript(app, { configuredBaseUrl: () => undefined });
		const res = await app.request(`http://x${path}`, { headers: { host: '' } });
		expect(res.status).toBe(400);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(await res.text()).toContain('WEBHOOK_CALLBACK_BASE_URL is not set');
	});
});

/** A local installation serving `launcherDir`'s package and the script. */
async function startInstallation(
	launcherDir: string,
): Promise<{ url: string; server: ServerType }> {
	const app = new Hono();
	registerWorkerLauncher(app, {
		launcherDir,
		resolveOwnBuild: async () => ({ commit: 'c'.repeat(40), dirty: false, version: VERSION }),
	});
	registerInstallScript(app, { configuredBaseUrl: () => undefined });
	const server = await new Promise<ServerType>((resolve) => {
		const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
	});
	const { port } = server.address() as AddressInfo;
	return { url: `http://127.0.0.1:${port}`, server };
}

describe('the installers end to end', () => {
	let launcherDir: string;
	let tarball: Buffer;
	let installation: { url: string; server: ServerType };
	let script: string;

	beforeAll(async () => {
		launcherDir = tempDir('artifacts');
		const build = spawnSync(
			process.execPath,
			[join(REPO_ROOT, 'bin/build-worker-launcher.js'), launcherDir],
			{ cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 },
		);
		expect(build.status, `${build.stdout}${build.stderr}`).toBe(0);
		tarball = readFileSync(join(launcherDir, FILE));
		writeFileSync(
			join(launcherDir, `${FILE}.sha256`),
			`${createHash('sha256').update(tarball).digest('hex')}  ${FILE}\n`,
		);
		installation = await startInstallation(launcherDir);
		const res = await fetch(`${installation.url}/install.sh`);
		expect(res.status).toBe(200);
		script = await res.text();
	}, 180_000);

	afterAll(async () => {
		await new Promise((resolve) => installation?.server.close(resolve));
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	});

	/** `curl … | sh -s -- <args>`: the script on stdin, detached so there is no terminal. */
	function install(
		home: string,
		args: string[],
		opts: { path?: string; script?: string } = {},
	): Promise<{ status: number | null; stdout: string; stderr: string }> {
		return new Promise((resolve, reject) => {
			const child = spawn('/bin/sh', ['-s', '--', ...args], {
				cwd: home,
				detached: true,
				env: { HOME: home, PATH: opts.path ?? `${NODE_DIR}:${SYSTEM_PATH}` },
				stdio: ['pipe', 'pipe', 'pipe'],
			});
			let stdout = '';
			let stderr = '';
			child.stdout.on('data', (chunk) => {
				stdout += chunk;
			});
			child.stderr.on('data', (chunk) => {
				stderr += chunk;
			});
			child.on('error', reject);
			child.on('close', (status) => resolve({ status, stdout, stderr }));
			child.stdin.end(opts.script ?? script);
		});
	}

	it('installs the launcher, links swarm-worker and hands over to the subcommand', async () => {
		const home = tempDir('home');
		const result = await install(home, ['version']);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe(VERSION);
		expect(result.stderr).toContain(`installed swarm-worker ${VERSION}`);
		expect(result.stderr).toContain('export PATH="$HOME/.swarm/bin:$PATH"');

		const launcher = join(home, '.swarm/launcher');
		for (const path of ['package.json', 'bin/swarm-worker.js', 'dist/launcher/swarm-worker.js'])
			expect(existsSync(join(launcher, path)), path).toBe(true);
		const link = join(home, '.swarm/bin/swarm-worker');
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(readlinkSync(link)).toBe(join(launcher, 'bin/swarm-worker.js'));
		expect(readdirSync(join(home, '.swarm')).sort()).toEqual(['bin', 'launcher']);

		const viaLink = spawnSync(link, ['--version'], {
			encoding: 'utf8',
			env: { PATH: `${NODE_DIR}:${SYSTEM_PATH}` },
		});
		expect(viaLink.status, viaLink.stderr).toBe(0);
		expect(viaLink.stdout.trim()).toBe(VERSION);
	});

	it('passes the subcommand, the installation URL and the flags through', async () => {
		const home = tempDir('home');
		const result = await install(home, ['no-such-command', '--flag', 'a value']);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain(
			`unknown command: no-such-command --control-plane-url ${installation.url} --flag a value`,
		);
	});

	it('runs setup by default, with the flags after -- passed to it', async () => {
		const home = tempDir('home');
		const result = await install(home, ['--help']);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout).toContain("swarm-worker setup — register this checkout's host");
	});

	it('upgrades in place on a re-run, and links into ~/.local/bin when it is on PATH', async () => {
		const home = tempDir('home');
		expect((await install(home, ['version'])).status).toBe(0);
		writeFileSync(join(home, '.swarm/launcher/stale-marker'), 'old');
		mkdirSync(join(home, '.local/bin'), { recursive: true });

		const result = await install(home, ['version'], {
			path: `${join(home, '.local/bin')}:${NODE_DIR}:${SYSTEM_PATH}`,
		});
		expect(result.status, result.stderr).toBe(0);
		expect(existsSync(join(home, '.swarm/launcher/stale-marker'))).toBe(false);
		expect(existsSync(join(home, '.swarm/launcher/bin/swarm-worker.js'))).toBe(true);
		expect(readlinkSync(join(home, '.local/bin/swarm-worker'))).toBe(
			join(home, '.swarm/launcher/bin/swarm-worker.js'),
		);
		expect(result.stderr).not.toContain('export PATH=');
		expect(readdirSync(join(home, '.swarm')).sort()).toEqual(['bin', 'launcher']);
	});

	it('refuses a package that does not match its SHA-256 and installs nothing', async () => {
		const corruptDir = tempDir('corrupt');
		writeFileSync(join(corruptDir, FILE), tarball);
		writeFileSync(
			join(corruptDir, `${FILE}.sha256`),
			`${createHash('sha256').update(tarball).digest('hex')}  ${FILE}\n`,
		);
		const corrupt = await startInstallation(corruptDir);
		try {
			// The manifest is resolved once, so corrupting the file afterwards is served as is.
			await (await fetch(`${corrupt.url}/worker/launcher/manifest`)).json();
			const bad = Buffer.from(tarball);
			bad[bad.length - 1] ^= 0xff;
			writeFileSync(join(corruptDir, FILE), bad);

			const home = tempDir('home');
			const rendered = await (await fetch(`${corrupt.url}/install.sh`)).text();
			const result = await install(home, ['version'], { script: rendered });
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(`${FILE} does not match the installation's SHA-256`);
			expect(existsSync(join(home, '.swarm/launcher'))).toBe(false);
			expect(readdirSync(join(home, '.swarm'))).toEqual([]);
		} finally {
			await new Promise((resolve) => corrupt.server.close(resolve));
		}
	});

	it('refuses Node older than 22, naming it', async () => {
		const home = tempDir('home');
		const fakeBin = join(home, 'fake-bin');
		mkdirSync(fakeBin);
		writeFileSync(
			join(fakeBin, 'node'),
			'#!/bin/sh\n[ "$1" = --version ] && echo v20.11.0 && exit 0\nexit 1\n',
			{ mode: 0o755 },
		);
		const result = await install(home, [], { path: `${fakeBin}:${SYSTEM_PATH}` });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('Node.js >= 22 is required, and node is v20.11.0');
		expect(existsSync(join(home, '.swarm'))).toBe(false);
	});

	it('refuses when git is missing, naming it', async () => {
		const home = tempDir('home');
		const nodeOnly = join(home, 'node-only');
		mkdirSync(nodeOnly);
		symlinkSync(process.execPath, join(nodeOnly, 'node'));
		const result = await install(home, [], { path: nodeOnly });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('git is required, and git is not on PATH');
		expect(existsSync(join(home, '.swarm'))).toBe(false);
	});

	describe.skipIf(!PWSH)('install.ps1, under pwsh', () => {
		/** A bare PowerShell argument where it is one, as typed; quoted otherwise. */
		const psArg = (arg: string): string => (/^[-\w.@=]+$/.test(arg) ? arg : powershellQuote(arg));

		/**
		 * The documented one-liners, run by `pwsh -Command`: `irm … | iex` (`args`
		 * unused), or the scriptblock form with `args` after it.
		 */
		function installPs(
			home: string,
			args: string[],
			opts: { path?: string; url?: string; iex?: boolean; userProfile?: string } = {},
		): Promise<{ status: number | null; stdout: string; stderr: string }> {
			const scriptUrl = powershellQuote(`${opts.url ?? installation.url}/install.ps1`);
			const command = opts.iex
				? `irm ${scriptUrl} | iex`
				: `& ([scriptblock]::Create((irm ${scriptUrl}))) ${args.map(psArg).join(' ')}`;
			return new Promise((resolve, reject) => {
				const child = spawn(
					PWSH as string,
					['-NoProfile', '-NonInteractive', '-Command', command],
					{
						cwd: home,
						env: {
							HOME: home,
							...(opts.userProfile === undefined ? {} : { USERPROFILE: opts.userProfile }),
							PATH: opts.path ?? `${NODE_DIR}:${SYSTEM_PATH}`,
							POWERSHELL_TELEMETRY_OPTOUT: '1',
							POWERSHELL_UPDATECHECK: 'Off',
							NO_COLOR: '1',
						},
						stdio: ['ignore', 'pipe', 'pipe'],
					},
				);
				let stdout = '';
				let stderr = '';
				child.stdout.on('data', (chunk) => {
					stdout += chunk;
				});
				child.stderr.on('data', (chunk) => {
					stderr += chunk;
				});
				child.on('error', reject);
				child.on('close', (status) => resolve({ status, stdout, stderr }));
			});
		}

		/** A `node` that is v22 and records the argv it was handed over, one per line. */
		function fakeNode(home: string, version = 'v22.11.0'): string {
			const bin = join(home, 'fake-bin');
			mkdirSync(bin);
			writeFileSync(
				join(bin, 'node'),
				`#!/bin/sh\n[ "$1" = --version ] && echo ${version} && exit 0\nprintf '%s\\n' "$@" >"$HOME/node-argv"\n`,
				{ mode: 0o755 },
			);
			return `${bin}:${SYSTEM_PATH}`;
		}

		const handedOver = (home: string): string[] =>
			readFileSync(join(home, 'node-argv'), 'utf8').split('\n').slice(0, -1);

		it('installs the launcher and the .cmd, and hands over to the subcommand', async () => {
			const home = tempDir('home');
			const result = await installPs(home, ['version']);
			expect(result.status, result.stderr).toBe(0);
			expect(result.stdout.trim()).toBe(VERSION);
			expect(result.stderr).toContain(`swarm install: installed swarm-worker ${VERSION}`);

			const launcher = join(home, '.swarm/launcher');
			for (const path of ['package.json', 'bin/swarm-worker.js', 'dist/launcher/swarm-worker.js'])
				expect(existsSync(join(launcher, path)), path).toBe(true);
			expect(readFileSync(join(home, '.swarm/bin/swarm-worker.cmd'), 'utf8').trimEnd()).toBe(
				'@node "%USERPROFILE%\\.swarm\\launcher\\bin\\swarm-worker.js" %*',
			);
			expect(readdirSync(join(home, '.swarm')).sort()).toEqual(['bin', 'launcher']);
		}, 60_000);

		it('keeps the install under $HOME off Windows, whatever USERPROFILE says', async () => {
			const home = tempDir('home');
			const profile = tempDir('profile');
			const result = await installPs(home, ['version'], { userProfile: profile });
			expect(result.status, result.stderr).toBe(0);
			expect(existsSync(join(home, '.swarm/launcher/bin/swarm-worker.js'))).toBe(true);
			expect(readdirSync(profile)).toEqual([]);
		}, 60_000);

		it('runs setup with the installation URL under irm | iex', async () => {
			const home = tempDir('home');
			const result = await installPs(home, [], { iex: true, path: fakeNode(home) });
			expect(result.status, result.stderr).toBe(0);
			expect(handedOver(home)).toEqual([
				join(home, ENTRY),
				'setup',
				'--control-plane-url',
				installation.url,
			]);
		}, 60_000);

		it('passes the subcommand and every flag through, -p included', async () => {
			const home = tempDir('home');
			const path = fakeNode(home);
			const result = await installPs(
				home,
				['login', '--email', 'me@example.com', '-p', 'x', 'a value', '--yes'],
				{ path },
			);
			expect(result.status, result.stderr).toBe(0);
			expect(handedOver(home)).toEqual([
				join(home, ENTRY),
				'login',
				'--control-plane-url',
				installation.url,
				'--email',
				'me@example.com',
				'-p',
				'x',
				'a value',
				'--yes',
			]);

			// A first argument that is a flag goes to setup.
			expect((await installPs(home, ['--yes'], { path })).status).toBe(0);
			expect(handedOver(home).slice(1)).toEqual([
				'setup',
				'--control-plane-url',
				installation.url,
				'--yes',
			]);
		}, 60_000);

		it("reports the subcommand's failure", async () => {
			const home = tempDir('home');
			const result = await installPs(home, ['no-such-command', '--flag', 'a value']);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain(
				`unknown command: no-such-command --control-plane-url ${installation.url} --flag a value`,
			);
			expect(result.stderr).toContain('swarm-worker no-such-command exited with code 1.');
		}, 60_000);

		it('upgrades in place on a re-run', async () => {
			const home = tempDir('home');
			expect((await installPs(home, ['version'])).status).toBe(0);
			writeFileSync(join(home, '.swarm/launcher/stale-marker'), 'old');

			const result = await installPs(home, ['version']);
			expect(result.status, result.stderr).toBe(0);
			expect(existsSync(join(home, '.swarm/launcher/stale-marker'))).toBe(false);
			expect(existsSync(join(home, '.swarm/launcher/bin/swarm-worker.js'))).toBe(true);
			expect(readdirSync(join(home, '.swarm')).sort()).toEqual(['bin', 'launcher']);
		}, 60_000);

		it('refuses a package that does not match its SHA-256 and installs nothing', async () => {
			const corruptDir = tempDir('corrupt');
			writeFileSync(join(corruptDir, FILE), tarball);
			writeFileSync(
				join(corruptDir, `${FILE}.sha256`),
				`${createHash('sha256').update(tarball).digest('hex')}  ${FILE}\n`,
			);
			const corrupt = await startInstallation(corruptDir);
			try {
				await (await fetch(`${corrupt.url}/worker/launcher/manifest`)).json();
				const bad = Buffer.from(tarball);
				bad[bad.length - 1] ^= 0xff;
				writeFileSync(join(corruptDir, FILE), bad);

				const home = tempDir('home');
				const result = await installPs(home, ['version'], { url: corrupt.url });
				expect(result.status).toBe(1);
				expect(result.stderr).toContain(`${FILE} does not match the installation's SHA-256`);
				expect(existsSync(join(home, '.swarm/launcher'))).toBe(false);
				expect(readdirSync(join(home, '.swarm'))).toEqual([]);
			} finally {
				await new Promise((resolve) => corrupt.server.close(resolve));
			}
		}, 60_000);

		it('refuses Node older than 22, naming it', async () => {
			const home = tempDir('home');
			const result = await installPs(home, [], { path: fakeNode(home, 'v20.11.0') });
			expect(result.status).toBe(1);
			expect(result.stderr).toContain('Node.js >= 22 is required, and node is v20.11.0');
			expect(existsSync(join(home, '.swarm'))).toBe(false);
		}, 60_000);
	});
});
