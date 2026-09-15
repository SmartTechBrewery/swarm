import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
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
 * `swarm-worker-agent update` — the by-hand twin of the update a worker is asked to
 * apply over the control plane (ADR-006).
 *
 * Two things about it are behavior rather than shape, so they are exercised rather
 * than read. Which agents it restarts: the code a daemon runs belongs to the *SWARM
 * installation*, not to the worker checkout the plist names, so the selector follows
 * each plist's launcher through its npm-link symlink chain — and a second clone's
 * agents must survive an update of this one untouched. And when it restarts them:
 * never before the pull, install and build have all succeeded, because restarting
 * onto a half-written tree is the exact state ADR-006 has the asked-for route refuse.
 *
 * The harness sources the real script with `git`, `npm`, `launchctl` and `plutil`
 * stubbed, which is the only way to run the whole chain without pulling a repository
 * and taking down this machine's own daemons.
 */
const SCRIPT = fileURLToPath(new URL('../../../bin/swarm-worker-agent', import.meta.url));

interface AgentFixture {
	/** The plist's label, minus the `.plist` the file itself carries. */
	label: string;
	/** `WorkingDirectory` — the worker checkout, which is a project repo, not SWARM. */
	checkout: string;
	/** Which installation's `bin/swarm.js` this agent's launcher symlink lands on. */
	installation: 'this' | 'other';
}

interface UpdateOptions {
	agents: AgentFixture[];
	/** A `<checkout>` argument, i.e. restart that one agent rather than all of them. */
	only?: string;
	pullFails?: boolean;
	buildFails?: boolean;
	/** HEAD after the pull; equal to `abc1234` means the installation was current. */
	head?: string;
}

describe('swarm-worker-agent update', () => {
	let home: string;
	let root: string;

	beforeEach(() => {
		// The physical path: the script resolves a launcher with `pwd -P`, and on macOS a
		// temp directory reached through `/var` answers as `/private/var`.
		home = realpathSync(mkdtempSync(join(tmpdir(), 'swarm-worker-update-')));
		// Two installations on one machine, each npm-linked the way Homebrew's prefix
		// links one: `<prefix>/bin/swarm` -> `../lib/node_modules/swarm/bin/swarm.js`,
		// where `node_modules/swarm` is itself a symlink to the checkout.
		root = installation('this');
		installation('other');
		mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	/** A checkout plus the `<prefix>/bin/swarm` symlink chain that reaches its build. */
	function installation(name: string): string {
		const checkout = join(home, 'checkouts', name);
		const prefix = join(home, 'prefix', name);
		mkdirSync(join(checkout, '.git'), { recursive: true });
		mkdirSync(join(checkout, 'bin'), { recursive: true });
		writeFileSync(join(checkout, 'bin', 'swarm.js'), '', 'utf8');
		mkdirSync(join(prefix, 'lib', 'node_modules'), { recursive: true });
		mkdirSync(join(prefix, 'bin'), { recursive: true });
		symlinkSync(checkout, join(prefix, 'lib', 'node_modules', 'swarm'));
		symlinkSync('../lib/node_modules/swarm/bin/swarm.js', join(prefix, 'bin', 'swarm'));
		return checkout;
	}

	/**
	 * Plant a LaunchAgent. The stubbed `plutil` reads these `key=value` files, so the
	 * fixtures stay plain text and the suite runs off a Mac.
	 */
	function plant(agent: AgentFixture): void {
		const prefix = join(home, 'prefix', agent.installation === 'this' ? 'this' : 'other');
		writeFileSync(
			join(home, 'Library', 'LaunchAgents', `${agent.label}.plist`),
			[
				`ProgramArguments.1=${join(prefix, 'bin', 'swarm')}`,
				`WorkingDirectory=${agent.checkout}`,
			].join('\n'),
			'utf8',
		);
	}

	/** The label `resolve()` derives for a checkout, so a fixture can carry that name. */
	function labelFor(checkout: string): string {
		const hash = createHash('sha256').update(checkout).digest('hex');
		return `pl.smarttechbrewery.swarm.worker.${basename(checkout)}.${hash.slice(0, 8)}`;
	}

	function runUpdate(options: UpdateOptions): {
		status: number;
		stdout: string;
		stderr: string;
		kickstarted: string[];
	} {
		for (const agent of options.agents) plant(agent);
		const calls = join(home, 'launchctl-calls');
		const harness = join(home, 'harness.sh');
		writeFileSync(
			harness,
			[
				"uname() { printf 'Darwin\\n'; }",
				// `git -C <root> rev-parse --short HEAD` before and after the pull; the second
				// answer is what the run reports, so the two differ unless HEAD did not move.
				`git() {
					case "$*" in
						*"rev-parse"*) if [ -f "${join(home, 'pulled')}" ]; then printf '%s\\n' "\${HEAD_AFTER}"; else printf 'abc1234\\n'; fi ;;
						*pull*) [ -z "\${PULL_FAILS:-}" ] || return 1; : > "${join(home, 'pulled')}" ;;
					esac
				}`,
				`npm() {
					case "$1" in
						ci) : ;;
						run) [ -z "\${BUILD_FAILS:-}" ] || return 1 ;;
					esac
				}`,
				`launchctl() { printf '%s\\n' "$*" >> ${JSON.stringify(calls)}; }`,
				// `plutil -extract <key> raw <file>` against the plain-text fixtures above.
				`plutil() { sed -n "s/^$2=//p" "$4" | grep . ; }`,
				`source ${JSON.stringify(SCRIPT)} --help >/dev/null`,
				`ROOT=${JSON.stringify(root)}`,
				options.only
					? `ONE_CHECKOUT=${JSON.stringify(options.only)}\nresolve ${JSON.stringify(options.only)}`
					: "ONE_CHECKOUT=''",
				'cmd_update',
			].join('\n'),
			'utf8',
		);
		const result = spawnSync('bash', [harness], {
			encoding: 'utf8',
			env: {
				...process.env,
				HOME: home,
				HEAD_AFTER: options.head ?? 'def5678',
				PULL_FAILS: options.pullFails ? '1' : '',
				BUILD_FAILS: options.buildFails ? '1' : '',
			},
		});
		let kickstarted: string[] = [];
		try {
			kickstarted = readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean);
		} catch {
			kickstarted = [];
		}
		return {
			status: result.status ?? -1,
			stdout: result.stdout,
			stderr: result.stderr,
			kickstarted,
		};
	}

	it('restarts every agent that runs this installation, and no other clone’s', () => {
		const result = runUpdate({
			agents: [
				{
					label: 'pl.smarttechbrewery.swarm.worker.api.aaaaaaaa',
					checkout: '/checkouts/api',
					installation: 'this',
				},
				{
					label: 'pl.smarttechbrewery.swarm.worker.web.bbbbbbbb',
					checkout: '/checkouts/web',
					installation: 'this',
				},
				{
					label: 'pl.smarttechbrewery.swarm.worker.spare.cccccccc',
					checkout: '/checkouts/spare',
					installation: 'other',
				},
			],
		});

		expect(result.status).toBe(0);
		expect(result.kickstarted).toHaveLength(2);
		expect(result.kickstarted.join('\n')).toContain('kickstart -k gui/');
		expect(result.kickstarted.join('\n')).toContain('worker.api.aaaaaaaa');
		expect(result.kickstarted.join('\n')).toContain('worker.web.bbbbbbbb');
		expect(result.kickstarted.join('\n')).not.toContain('spare');
		expect(result.stdout).toContain('abc1234 -> def5678');
		expect(result.stdout).toContain('2 agent(s) restarted on def5678');
	});

	it('restarts nothing when the build fails, leaving every daemon on the old build', () => {
		const result = runUpdate({
			agents: [
				{
					label: 'pl.smarttechbrewery.swarm.worker.api.aaaaaaaa',
					checkout: '/checkouts/api',
					installation: 'this',
				},
			],
			buildFails: true,
		});

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('npm run build failed');
		expect(result.kickstarted).toEqual([]);
	});

	it('restarts nothing when the pull fails, and names the build they were left on', () => {
		const result = runUpdate({
			agents: [
				{
					label: 'pl.smarttechbrewery.swarm.worker.api.aaaaaaaa',
					checkout: '/checkouts/api',
					installation: 'this',
				},
			],
			pullFails: true,
		});

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('left on abc1234');
		expect(result.kickstarted).toEqual([]);
	});

	it('rebuilds and restarts even when the pull moved nothing', () => {
		// The recovery case: an installation whose `node_modules` or `dist` never
		// finished being written is on the right commit and still unrunnable.
		const result = runUpdate({
			agents: [
				{
					label: 'pl.smarttechbrewery.swarm.worker.api.aaaaaaaa',
					checkout: '/checkouts/api',
					installation: 'this',
				},
			],
			head: 'abc1234',
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain('already at abc1234, rebuilt anyway');
		expect(result.kickstarted).toHaveLength(1);
	});

	it('refuses when no agent on this machine runs this installation', () => {
		const result = runUpdate({
			agents: [
				{
					label: 'pl.smarttechbrewery.swarm.worker.spare.cccccccc',
					checkout: '/checkouts/spare',
					installation: 'other',
				},
			],
		});

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('no worker agent on this machine runs the SWARM installation');
		expect(result.kickstarted).toEqual([]);
	});

	it('pulls nothing when the installation is not a git checkout', () => {
		rmSync(join(root, '.git'), { recursive: true, force: true });

		const result = runUpdate({
			agents: [
				{
					label: 'pl.smarttechbrewery.swarm.worker.api.aaaaaaaa',
					checkout: '/checkouts/api',
					installation: 'this',
				},
			],
		});

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('is not a git checkout');
		expect(result.kickstarted).toEqual([]);
	});
	it('restarts only the agent named by a <checkout> argument', () => {
		// The narrow case: one daemon is wedged, and the machine's other workers are
		// mid-phase. The installation is still pulled and rebuilt — there is one build.
		const checkout = join(home, 'checkouts', 'api');
		mkdirSync(checkout, { recursive: true });

		const result = runUpdate({
			agents: [
				{ label: labelFor(checkout), checkout, installation: 'this' },
				{
					label: labelFor(join(home, 'checkouts', 'web')),
					checkout: '/checkouts/web',
					installation: 'this',
				},
			],
			only: checkout,
		});

		expect(result.status).toBe(0);
		expect(result.kickstarted).toHaveLength(1);
		expect(result.kickstarted[0]).toContain(labelFor(checkout));
	});

	it('refuses a <checkout> whose agent runs another installation', () => {
		// Restarting it would put that clone's daemon on a build this update never
		// touched, which is the failure the installation filter exists to prevent.
		const checkout = join(home, 'checkouts', 'spare');
		mkdirSync(checkout, { recursive: true });

		const result = runUpdate({
			agents: [{ label: labelFor(checkout), checkout, installation: 'other' }],
			only: checkout,
		});

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('does not run the SWARM installation at');
		expect(result.kickstarted).toEqual([]);
	});
});
