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
				`launchctl() { printf '%s\\n' "$*" >> ${JSON.stringify(calls)}; }`,
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
});
