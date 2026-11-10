import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `swarm-worker-agent install` — which SWARM CLI the plist it writes starts (issue
 * #1213).
 *
 * The daemon `run:worker` starts reads `SWARM_CONTROL_PLANE_URL` from the `.env` of
 * the installation whose CLI it is, so an agent that runs a second clone's `swarm`
 * dials an installation its worker was never registered with. The installer must
 * therefore write its *own* installation's `bin/swarm.js`, whatever `swarm` comes
 * first on `PATH` — which is the case each test below sets up.
 *
 * The harness copies the real script into a fake installation, so `install_root`
 * genuinely resolves from where the script lives, and sources it through its own
 * dispatcher with `uname`, `launchctl` and `plutil` stubbed: nothing here needs real
 * launchd, and nothing touches this machine's own agents.
 */
const SCRIPT = fileURLToPath(new URL('../../../bin/swarm-worker-agent', import.meta.url));

describe('swarm-worker-agent install', () => {
	let home: string;
	let root: string;
	let other: string;
	let checkout: string;

	beforeEach(() => {
		// The physical path: the script resolves its installation with `pwd -P`, and on
		// macOS a temp directory reached through `/var` answers as `/private/var`.
		home = realpathSync(mkdtempSync(join(tmpdir(), 'swarm-worker-install-')));
		root = installation('this');
		other = installation('other');
		writeFileSync(join(root, 'bin', 'swarm-worker-agent'), readFileSync(SCRIPT));
		// The by-hand route: this installation's installer reached through its PATH link.
		symlinkSync(
			'../lib/node_modules/swarm/bin/swarm-worker-agent',
			join(home, 'prefix', 'this', 'bin', 'swarm-worker-agent'),
		);

		checkout = join(home, 'work', 'api');
		mkdirSync(join(checkout, '.git'), { recursive: true });
		const cache = join(home, '.swarm', 'worker-credentials', hashOf(checkout));
		mkdirSync(cache, { recursive: true });
		writeFileSync(join(cache, 'credential.json'), '{}', 'utf8');
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	/** A checkout plus the `<prefix>/bin/swarm` symlink chain that reaches its build. */
	function installation(name: string): string {
		const dir = join(home, 'checkouts', name);
		const prefix = join(home, 'prefix', name);
		mkdirSync(join(dir, '.git'), { recursive: true });
		mkdirSync(join(dir, 'bin'), { recursive: true });
		writeFileSync(join(dir, 'bin', 'swarm.js'), '', 'utf8');
		mkdirSync(join(prefix, 'lib', 'node_modules'), { recursive: true });
		mkdirSync(join(prefix, 'bin'), { recursive: true });
		symlinkSync(dir, join(prefix, 'lib', 'node_modules', 'swarm'));
		symlinkSync('../lib/node_modules/swarm/bin/swarm.js', join(prefix, 'bin', 'swarm'));
		return dir;
	}

	function hashOf(path: string): string {
		return createHash('sha256').update(path).digest('hex');
	}

	/** The plist `resolve()` derives for the worker checkout. */
	function plistPath(): string {
		const label = `pl.smarttechbrewery.swarm.worker.${basename(checkout)}.${hashOf(checkout).slice(0, 8)}`;
		return join(home, 'Library', 'LaunchAgents', `${label}.plist`);
	}

	function runInstall(installer: string): {
		status: number;
		stderr: string;
		launchctl: string[];
	} {
		const calls = join(home, 'launchctl-calls');
		rmSync(calls, { force: true });
		const harness = join(home, 'harness.sh');
		writeFileSync(
			harness,
			[
				"uname() { printf 'Darwin\\n'; }",
				// `print` finds no job, as on a host with nothing loaded under this label.
				`launchctl() { printf '%s\\n' "$*" >> ${JSON.stringify(calls)}; [ "$1" != print ]; }`,
				'plutil() { return 0; }',
				`source ${JSON.stringify(installer)} install ${JSON.stringify(checkout)}`,
			].join('\n'),
			'utf8',
		);
		const result = spawnSync('bash', [harness], {
			encoding: 'utf8',
			env: {
				...process.env,
				HOME: home,
				// The *other* clone's `swarm` comes first, as on the machine the issue was
				// found on; `node` still resolves from the rest of the test's PATH.
				PATH: `${join(home, 'prefix', 'other', 'bin')}:${process.env.PATH ?? ''}`,
			},
		});
		return {
			status: result.status ?? -1,
			stderr: result.stderr,
			launchctl: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [],
		};
	}

	it('writes this installation’s CLI even with another clone’s swarm first on PATH', () => {
		// The absolute path is how `swarm workers setup` runs it (worker-autostart.ts).
		const result = runInstall(join(root, 'bin', 'swarm-worker-agent'));

		expect(result.status, result.stderr).toBe(0);
		const plist = readFileSync(plistPath(), 'utf8');
		expect(plist).toContain(`<string>${join(root, 'bin', 'swarm.js')}</string>`);
		expect(plist).not.toContain(join(home, 'prefix', 'other'));
		expect(plist).not.toContain(other);
		expect(result.launchctl.join('\n')).toContain('bootstrap');
	});

	it('names the same CLI when the installer is reached through its PATH symlink', () => {
		const result = runInstall(join(home, 'prefix', 'this', 'bin', 'swarm-worker-agent'));

		expect(result.status, result.stderr).toBe(0);
		expect(readFileSync(plistPath(), 'utf8')).toContain(
			`<string>${join(root, 'bin', 'swarm.js')}</string>`,
		);
	});

	it('keeps the agent on the same installation when install is re-run', () => {
		const installer = join(root, 'bin', 'swarm-worker-agent');
		expect(runInstall(installer).status).toBe(0);
		const first = readFileSync(plistPath(), 'utf8');
		expect(runInstall(installer).status).toBe(0);
		const second = readFileSync(plistPath(), 'utf8');

		expect(second).toBe(first);
		expect(second).toContain(`<string>${join(root, 'bin', 'swarm.js')}</string>`);
	});

	it('refuses an installation with no bin/swarm.js, writing and starting nothing', () => {
		rmSync(join(root, 'bin', 'swarm.js'));

		const result = runInstall(join(root, 'bin', 'swarm-worker-agent'));

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('no swarm CLI at');
		expect(existsSync(plistPath())).toBe(false);
		expect(result.launchctl.join('\n')).not.toContain('bootstrap');
	});

	describe('--profile <worker-id> (issue #1297)', () => {
		const CREDENTIAL = 'raw-credential-SECRET';

		function profile(
			workerId: string,
			controlPlaneUrl: string,
			repoRoots: string[] = [checkout],
		): string {
			const dir = join(home, '.swarm', 'workers', workerId);
			mkdirSync(dir, { recursive: true });
			writeFileSync(
				join(dir, 'profile.json'),
				JSON.stringify({
					workerId,
					controlPlaneUrl,
					credential: CREDENTIAL,
					repoRoots,
					createdAt: new Date().toISOString(),
				}),
				'utf8',
			);
			return dir;
		}

		function labelOf(workerId: string, controlPlaneUrl: string, hostSlug: string): string {
			const hash = createHash('sha256').update(`${controlPlaneUrl}\n${workerId}`).digest('hex');
			return `pl.smarttechbrewery.swarm.worker.${hostSlug}.${workerId}.${hash.slice(0, 8)}`;
		}

		function agentPlist(label: string): string {
			return join(home, 'Library', 'LaunchAgents', `${label}.plist`);
		}

		/**
		 * Run any action through the dispatcher. `plutil -extract WorkingDirectory` reads
		 * the generated XML, and `ps` reports `PS_COMMAND` for any pid, so a planted lock
		 * can have a live daemon behind it.
		 */
		function runAgent(
			args: string[],
			options: { psCommand?: string } = {},
		): { status: number; stdout: string; stderr: string; launchctl: string[] } {
			const calls = join(home, 'launchctl-calls');
			rmSync(calls, { force: true });
			const harness = join(home, 'harness.sh');
			writeFileSync(
				harness,
				[
					"uname() { printf 'Darwin\\n'; }",
					// `print` finds no job, as on a host with nothing loaded under this label.
					`launchctl() { printf '%s\\n' "$*" >> ${JSON.stringify(calls)}; [ "$1" != print ]; }`,
					`plutil() {
						[ "$1" = '-extract' ] || return 0
						sed -n "/<key>$2<\\/key>/{n;s/.*<string>\\(.*\\)<\\/string>.*/\\1/p;}" "$4" | grep .
					}`,
					`ps() { [ -n "\${PS_COMMAND:-}" ] && printf '%s\\n' "$PS_COMMAND"; }`,
					`source ${JSON.stringify(join(root, 'bin', 'swarm-worker-agent'))} ${args.map((a) => JSON.stringify(a)).join(' ')}`,
				].join('\n'),
				'utf8',
			);
			const result = spawnSync('bash', [harness], {
				encoding: 'utf8',
				env: { ...process.env, HOME: home, PS_COMMAND: options.psCommand ?? '' },
			});
			return {
				status: result.status ?? -1,
				stdout: result.stdout,
				stderr: result.stderr,
				launchctl: existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [],
			};
		}

		beforeEach(() => {
			writeFileSync(join(root, 'bin', 'swarm-worker.js'), '', 'utf8');
		});

		it('writes an agent that runs this installation’s launcher from the profile directory', () => {
			const url = 'https://swarm.example.com';
			const dir = profile('w-1', url);
			const label = labelOf('w-1', url, 'swarm-example-com');

			const result = runAgent(['install', '--profile', 'w-1']);

			expect(result.status, result.stderr).toBe(0);
			const plist = readFileSync(agentPlist(label), 'utf8');
			expect(plist).toContain(`<string>${label}</string>`);
			expect(plist).toMatch(
				new RegExp(
					`<array>\\n\\t\\t<string>[^<]*node</string>\\n\\t\\t<string>${join(root, 'bin', 'swarm-worker.js')}</string>\\n\\t\\t<string>run</string>\\n\\t\\t<string>w-1</string>\\n\\t</array>`,
				),
			);
			expect(plist).toContain(`<key>WorkingDirectory</key>\n\t<string>${dir}</string>`);
			expect(plist).toContain('<key>LANG</key>\n\t\t<string>en_US.UTF-8</string>');
			expect(plist).toContain('<key>KeepAlive</key>\n\t<true/>');
			expect(plist).toContain('<key>ThrottleInterval</key>\n\t<integer>30</integer>');
			expect(plist).toContain(`<string>${join(home, 'Library', 'Logs', `${label}.log`)}</string>`);
			expect(plist).not.toContain('run:worker');
			expect(result.launchctl.join('\n')).toContain(`bootstrap gui/`);
			expect(result.stdout).toContain(`installed ${label}`);
		});

		it('gives two installations’ workers distinct labels naming their hosts', () => {
			profile('w-1', 'https://swarm.example.com');
			profile('w-2', 'http://swarm-two.example.com:8443');

			expect(runAgent(['install', '--profile', 'w-1']).status).toBe(0);
			expect(runAgent(['install', '--profile=w-2']).status).toBe(0);

			const first = labelOf('w-1', 'https://swarm.example.com', 'swarm-example-com');
			const second = labelOf(
				'w-2',
				'http://swarm-two.example.com:8443',
				'swarm-two-example-com-8443',
			);
			expect(first).not.toBe(second);
			expect(existsSync(agentPlist(first))).toBe(true);
			expect(existsSync(agentPlist(second))).toBe(true);
		});

		it('never writes or prints the credential', () => {
			const url = 'https://swarm.example.com';
			profile('w-1', url);

			const install = runAgent(['install', '--profile', 'w-1']);
			const status = runAgent(['status', '--profile', 'w-1']);

			expect(install.status).toBe(0);
			expect(status.status).toBe(0);
			expect(status.stdout).toContain('worker:   w-1');
			const plist = readFileSync(agentPlist(labelOf('w-1', url, 'swarm-example-com')), 'utf8');
			for (const text of [plist, install.stdout, install.stderr, status.stdout, status.stderr])
				expect(text).not.toContain(CREDENTIAL);
		});

		it('refuses an installation with no bin/swarm-worker.js, writing and starting nothing', () => {
			const url = 'https://swarm.example.com';
			profile('w-1', url);
			rmSync(join(root, 'bin', 'swarm-worker.js'));

			const result = runAgent(['install', '--profile', 'w-1']);

			expect(result.status).toBe(1);
			expect(result.stderr).toContain('no swarm-worker at');
			expect(existsSync(agentPlist(labelOf('w-1', url, 'swarm-example-com')))).toBe(false);
			expect(result.launchctl).toEqual([]);
		});

		it('refuses a missing profile, writing and starting nothing', () => {
			const result = runAgent(['install', '--profile', 'w-1']);

			expect(result.status).toBe(1);
			expect(result.stderr).toContain('no worker profile for w-1');
			expect(result.launchctl).toEqual([]);
		});

		it('refuses an unreadable profile', () => {
			const dir = join(home, '.swarm', 'workers', 'w-1');
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, 'profile.json'), '{not json', 'utf8');

			const result = runAgent(['install', '--profile', 'w-1']);

			expect(result.status).toBe(1);
			expect(result.stderr).toContain('could not be read');
			expect(result.launchctl).toEqual([]);
		});

		it('refuses a worker id that is not path-safe', () => {
			const result = runAgent(['install', '--profile', '../w-1']);

			expect(result.status).toBe(1);
			expect(result.stderr).toContain('not a valid worker id');
		});

		it('refuses while a running daemon holds any of the profile’s checkout locks', () => {
			const second = join(home, 'work', 'web');
			mkdirSync(second, { recursive: true });
			profile('w-1', 'https://swarm.example.com', [checkout, second]);
			const lock = join(home, '.swarm', 'checkout-locks', hashOf(second));
			mkdirSync(lock, { recursive: true });
			writeFileSync(
				join(lock, 'owner.json'),
				JSON.stringify({
					repoRoot: second,
					pid: 4242,
					hostname: 'ada-laptop',
					workerId: 'w-9',
					createdAt: new Date().toISOString(),
					refreshedAt: new Date().toISOString(),
				}),
				'utf8',
			);

			const result = runAgent(['install', '--profile', 'w-1'], {
				psCommand: 'node /Users/ada/.swarm/runtimes/1.2.3/dist/transport/connect-entry.mjs',
			});

			expect(result.status).toBe(1);
			expect(result.stderr).toContain(`worker w-9 (pid 4242) is already running for ${second}`);
			expect(result.launchctl.join('\n')).not.toContain('bootstrap');
		});

		it('uninstalls by worker id, even once the profile is gone', () => {
			const url = 'https://swarm.example.com';
			const dir = profile('w-1', url);
			const plist = agentPlist(labelOf('w-1', url, 'swarm-example-com'));
			expect(runAgent(['install', '--profile', 'w-1']).status).toBe(0);
			rmSync(dir, { recursive: true, force: true });

			const result = runAgent(['uninstall', '--profile', 'w-1']);

			expect(result.status, result.stderr).toBe(0);
			expect(existsSync(plist)).toBe(false);
			expect(result.launchctl.join('\n')).toContain('bootout');
		});

		describe('a host launchd wrapper (issue #1376)', () => {
			function wrapperFile(contents: string): void {
				mkdirSync(join(home, '.swarm'), { recursive: true });
				writeFileSync(join(home, '.swarm', 'launchd-wrapper'), contents, 'utf8');
			}

			function executable(name: string): string {
				const path = join(home, name);
				writeFileSync(path, '#!/bin/sh\nexec "$@"\n', { encoding: 'utf8', mode: 0o755 });
				return path;
			}

			function programArguments(plist: string): string[] {
				const array = plist.match(
					/<key>ProgramArguments<\/key>\n\t<array>\n([\s\S]*?)\t<\/array>/,
				)?.[1];
				return [...(array ?? '').matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1] ?? '');
			}

			it('runs a profile agent under the wrapper the host names', () => {
				const url = 'https://swarm.example.com';
				profile('w-1', url);
				const wrapper = executable('wrapper');
				wrapperFile(`  ${wrapper}  \n`);

				const result = runAgent(['install', '--profile', 'w-1']);

				expect(result.status, result.stderr).toBe(0);
				expect(result.stderr).not.toContain('warning');
				const args = programArguments(
					readFileSync(agentPlist(labelOf('w-1', url, 'swarm-example-com')), 'utf8'),
				);
				expect(args).toHaveLength(5);
				expect(args[0]).toBe(wrapper);
				expect(args[1]).toMatch(/node$/);
				expect(args.slice(2)).toEqual([join(root, 'bin', 'swarm-worker.js'), 'run', 'w-1']);
			});

			it('runs a clone agent under it too', () => {
				const wrapper = executable('wrapper');
				wrapperFile(wrapper);

				expect(runInstall(join(root, 'bin', 'swarm-worker-agent')).status).toBe(0);

				const args = programArguments(readFileSync(plistPath(), 'utf8'));
				expect(args[0]).toBe(wrapper);
				expect(args.slice(2)).toEqual([join(root, 'bin', 'swarm.js'), 'run:worker']);
			});

			it.each([
				['a missing file', () => join(home, 'nowhere'), 'is not an executable file'],
				[
					'a file that is not executable',
					() => {
						const path = join(home, 'plain');
						writeFileSync(path, '', { encoding: 'utf8', mode: 0o644 });
						return path;
					},
					'is not an executable file',
				],
				['a directory', () => home, 'is not an executable file'],
				['a relative path', () => 'bin/wrapper', 'is not an absolute path'],
			])('warns about and ignores %s', (_case, target, warning) => {
				const url = 'https://swarm.example.com';
				profile('w-1', url);
				wrapperFile(`${target()}\n`);

				const result = runAgent(['install', '--profile', 'w-1']);

				expect(result.status, result.stderr).toBe(0);
				expect(result.stderr).toContain(warning);
				const args = programArguments(
					readFileSync(agentPlist(labelOf('w-1', url, 'swarm-example-com')), 'utf8'),
				);
				expect(args).toHaveLength(4);
				expect(args[0]).toMatch(/node$/);
			});

			it('ignores an empty file without a warning', () => {
				const url = 'https://swarm.example.com';
				profile('w-1', url);
				wrapperFile('\n');

				const result = runAgent(['install', '--profile', 'w-1']);

				expect(result.status, result.stderr).toBe(0);
				expect(result.stderr).toBe('');
				const args = programArguments(
					readFileSync(agentPlist(labelOf('w-1', url, 'swarm-example-com')), 'utf8'),
				);
				expect(args).toHaveLength(4);
			});
		});

		it('leaves the clone-mode plist exactly as it was', () => {
			// The clone agent's plist, as `install [<checkout>]` wrote it before profiles.
			expect(runInstall(join(root, 'bin', 'swarm-worker-agent')).status).toBe(0);
			const plist = readFileSync(plistPath(), 'utf8');
			const label = basename(plistPath(), '.plist');
			const log = join(home, 'Library', 'Logs', `${label}.log`);
			const node = plist.match(/<array>\n\t\t<string>([^<]*)<\/string>/)?.[1];
			const path = plist.match(/<key>PATH<\/key>\n\t\t<string>([^<]*)<\/string>/)?.[1];

			expect(plist).toBe(
				[
					'<?xml version="1.0" encoding="UTF-8"?>',
					'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
					'<plist version="1.0">',
					'<dict>',
					'\t<key>Label</key>',
					`\t<string>${label}</string>`,
					'',
					'\t<key>ProgramArguments</key>',
					'\t<array>',
					`\t\t<string>${node}</string>`,
					`\t\t<string>${join(root, 'bin', 'swarm.js')}</string>`,
					'\t\t<string>run:worker</string>',
					'\t</array>',
					'',
					'\t<key>WorkingDirectory</key>',
					`\t<string>${checkout}</string>`,
					'',
					'\t<key>EnvironmentVariables</key>',
					'\t<dict>',
					'\t\t<key>PATH</key>',
					`\t\t<string>${path}</string>`,
					'\t\t<key>LANG</key>',
					'\t\t<string>en_US.UTF-8</string>',
					'\t</dict>',
					'',
					'\t<key>RunAtLoad</key>',
					'\t<true/>',
					'',
					'\t<key>KeepAlive</key>',
					'\t<true/>',
					'',
					'\t<key>ThrottleInterval</key>',
					'\t<integer>30</integer>',
					'',
					'\t<key>StandardOutPath</key>',
					`\t<string>${log}</string>`,
					'\t<key>StandardErrorPath</key>',
					`\t<string>${log.replace(/\.log$/, '.error.log')}</string>`,
					'</dict>',
					'</plist>',
					'',
				].join('\n'),
			);
		});
	});
});
