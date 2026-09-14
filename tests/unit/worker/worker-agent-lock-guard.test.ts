import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHECKOUT_LOCK_TTL_MS } from '@/worktree/checkout-lock.js';

/**
 * `swarm-worker-agent install`'s duplicate-worker guard (issue #969, #970).
 *
 * The guard reads the daemon's own checkout lock, so it has to answer "is this
 * checkout taken?" the way `acquireCheckoutLock` does — a lock the daemon would
 * reclaim must not make the installer refuse the install of the very daemon that
 * would reclaim it. That agreement is behavior, not shape, so it is exercised
 * rather than read: the harness below sources the script and calls the guard with
 * `ps`/`launchctl`/`uname` stubbed, which is the only way to put a *live* pid
 * behind a lapsed record without starting a second worker.
 */
const SCRIPT = fileURLToPath(new URL('../../../bin/swarm-worker-agent', import.meta.url));

const WORKER_COMMAND = 'node --import tsx/esm /opt/swarm/src/transport/connect-entry.ts';

interface GuardOptions {
	/** The lock record to leave behind, or `null` for no lock file at all. */
	owner: Record<string, unknown> | null;
	/** What `ps` reports for the recorded pid — absent means the pid is gone. */
	psCommand?: string;
	/** A pid for `launchctl print` to report, i.e. this checkout's own agent is up. */
	agentPid?: number;
	/** Write the record indented, the shape an operator inspecting a lock leaves behind. */
	pretty?: boolean;
}

describe('swarm-worker-agent duplicate-worker guard', () => {
	let home: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), 'swarm-worker-agent-'));
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	/** An ISO stamp `minutes` in the past, in `refreshedAt`'s own `toISOString` shape. */
	function minutesAgo(minutes: number): string {
		return new Date(Date.now() - minutes * 60_000).toISOString();
	}

	function owner(refreshedAt: string, workerId: string | null = null) {
		return {
			repoRoot: '/Users/ada/checkouts/api',
			pid: 4242,
			hostname: 'ada-laptop',
			workerId,
			createdAt: minutesAgo(600),
			refreshedAt,
		};
	}

	/**
	 * Source the real script and run `refuse_if_worker_running` against a lock we
	 * planted. Shell functions shadow the commands the guard shells out to, so the
	 * host's own processes — and its OS — never decide the outcome.
	 */
	function runGuard(options: GuardOptions): { status: number; stderr: string } {
		const lock = resolve(home, 'checkout-locks', 'deadbeef', 'owner.json');
		if (options.owner) {
			mkdirSync(resolve(lock, '..'), { recursive: true });
			const serialized = options.pretty
				? JSON.stringify(options.owner, null, 2)
				: JSON.stringify(options.owner);
			writeFileSync(lock, `${serialized}\n`, 'utf8');
		}
		const harness = resolve(home, 'harness.sh');
		writeFileSync(
			harness,
			[
				// The script is macOS-only and refuses to run anywhere else; the guard it
				// guards is not, so the platform check is stubbed rather than skipped.
				"uname() { printf 'Darwin\\n'; }",
				`ps() { [ -n "\${PS_COMMAND:-}" ] && printf '%s\\n' "$PS_COMMAND"; }`,
				`launchctl() { [ -n "\${AGENT_PID:-}" ] && printf '    pid = %s\\n' "$AGENT_PID"; }`,
				`source ${JSON.stringify(SCRIPT)} --help >/dev/null`,
				`CHECKOUT=/Users/ada/checkouts/api`,
				`LOCK=${JSON.stringify(lock)}`,
				`TARGET=gui/501/pl.smarttechbrewery.swarm.worker.api.deadbeef`,
				'refuse_if_worker_running',
			].join('\n'),
			'utf8',
		);
		const result = spawnSync('bash', [harness], {
			encoding: 'utf8',
			env: {
				...process.env,
				PS_COMMAND: options.psCommand ?? '',
				AGENT_PID: options.agentPid ? String(options.agentPid) : '',
			},
		});
		return { status: result.status ?? -1, stderr: result.stderr };
	}

	it('refuses while a freshly refreshed lock has a live worker behind it', () => {
		const result = runGuard({ owner: owner(minutesAgo(2)), psCommand: WORKER_COMMAND });

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('a worker (pid 4242) is already running');
	});

	it('names the holder by worker id once the lock records one', () => {
		const result = runGuard({
			owner: owner(minutesAgo(2), 'ada-laptop-api'),
			psCommand: WORKER_COMMAND,
		});

		expect(result.status).toBe(1);
		expect(result.stderr).toContain('worker ada-laptop-api (pid 4242) is already running');
	});

	it('installs over a lapsed lock whose pid has been recycled to another worker', () => {
		// The case liveness alone gets wrong: the daemon that wrote this record is gone,
		// but its pid now belongs to a *different* checkout's worker. `acquireCheckoutLock`
		// reclaims the record on its lapsed `refreshedAt`, so the installer must not refuse.
		const lapsed = minutesAgo(CHECKOUT_LOCK_TTL_MS / 60_000 + 1);

		const result = runGuard({ owner: owner(lapsed), psCommand: WORKER_COMMAND });

		expect(result.stderr).toBe('');
		expect(result.status).toBe(0);
	});

	it('installs when the recorded pid is gone, without waiting for the lock to lapse', () => {
		const result = runGuard({ owner: owner(minutesAgo(2)) });

		expect(result.status).toBe(0);
	});

	it('installs when the recorded pid was recycled to something that is not a worker', () => {
		const result = runGuard({ owner: owner(minutesAgo(2)), psCommand: '/usr/bin/vim notes.md' });

		expect(result.status).toBe(0);
	});

	it('still refuses when the record was re-indented by hand', () => {
		// An unreadable stamp counts as lapsed, so a pattern that only matched the
		// daemon's own compact JSON would wave a live worker through on a lock an
		// operator had merely pretty-printed while looking at it.
		const result = runGuard({
			owner: owner(minutesAgo(2)),
			psCommand: WORKER_COMMAND,
			pretty: true,
		});

		expect(result.status).toBe(1);
	});

	it('installs when there is no lock at all', () => {
		expect(runGuard({ owner: null }).status).toBe(0);
	});

	it("reinstalls over this checkout's own running agent", () => {
		// `install` boots that job out before bootstrapping the new one, so its daemon is
		// never the second worker — this is how `install --self-update` on a live agent works.
		const result = runGuard({
			owner: owner(minutesAgo(2)),
			psCommand: WORKER_COMMAND,
			agentPid: 4242,
		});

		expect(result.status).toBe(0);
	});

	it('states the same TTL the daemon reclaims on', () => {
		// The installer cannot import CHECKOUT_LOCK_TTL_MS, so the two definitions are
		// held together here: change the constant and this fails until the script agrees.
		const minutes = CHECKOUT_LOCK_TTL_MS / 60_000;
		const script = readFileSync(SCRIPT, 'utf8');

		expect(script).toContain(`-v-${minutes}M`);
		expect(script).toContain(`-d '${minutes} minutes ago'`);
	});
});
