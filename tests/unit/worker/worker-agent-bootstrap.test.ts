import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * `swarm-worker-agent install`'s reload of the LaunchAgent (issue #1410).
 *
 * `launchctl bootout` returns before launchd has finished tearing a running job
 * down, so a `bootstrap` issued straight after it intermittently failed with
 * `5: Input/output error` and left the worker unloaded. The harness sources the
 * real script and drives `bootstrap_agent` against a scripted `launchctl` (and a
 * `sleep` that only records), so launchd's timing is the test's to choose.
 */
const SCRIPT = fileURLToPath(new URL('../../../bin/swarm-worker-agent', import.meta.url));
const LABEL = 'pl.smarttechbrewery.swarm.worker.api.deadbeef';
const PLIST = `/Users/ada/Library/LaunchAgents/${LABEL}.plist`;

interface LaunchdScript {
	/** How many `launchctl print` calls still find the job before it is gone. */
	printsLoaded: number;
	/** How many `launchctl bootstrap` calls fail before one succeeds. */
	bootstrapFailures: number;
}

describe('swarm-worker-agent bootstrap_agent', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'swarm-worker-agent-bootstrap-'));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function run(launchd: LaunchdScript): { status: number; stderr: string; calls: string[] } {
		const calls = join(dir, 'calls.log');
		const prints = join(dir, 'prints');
		const failures = join(dir, 'failures');
		writeFileSync(calls, '', 'utf8');
		writeFileSync(prints, String(launchd.printsLoaded), 'utf8');
		writeFileSync(failures, String(launchd.bootstrapFailures), 'utf8');
		const harness = join(dir, 'harness.sh');
		writeFileSync(
			harness,
			[
				"uname() { printf 'Darwin\\n'; }",
				`CALLS=${JSON.stringify(calls)}`,
				`PRINTS=${JSON.stringify(prints)}`,
				`FAILURES=${JSON.stringify(failures)}`,
				// Counters live in files: the script may call these from a subshell.
				'launchctl() {',
				'	printf "launchctl %s\\n" "$*" >>"$CALLS"',
				'	case "$1" in',
				'		print)',
				'			local n; n=$(cat "$PRINTS")',
				'			[ "$n" -gt 0 ] || return 113',
				'			echo $((n - 1)) >"$PRINTS"',
				'			;;',
				'		bootstrap)',
				'			local f; f=$(cat "$FAILURES")',
				'			[ "$f" -gt 0 ] || return 0',
				'			echo $((f - 1)) >"$FAILURES"',
				"			echo 'Bootstrap failed: 5: Input/output error' >&2",
				'			return 5',
				'			;;',
				'	esac',
				'}',
				'sleep() { printf "sleep %s\\n" "$*" >>"$CALLS"; }',
				`source ${JSON.stringify(SCRIPT)} --help >/dev/null`,
				`LABEL=${LABEL}`,
				`PLIST=${JSON.stringify(PLIST)}`,
				`TARGET="gui/$(id -u)/${LABEL}"`,
				'bootstrap_agent',
			].join('\n'),
			'utf8',
		);
		const result = spawnSync('bash', [harness], { encoding: 'utf8' });
		return {
			status: result.status ?? -1,
			stderr: result.stderr,
			calls: readFileSync(calls, 'utf8').split('\n').filter(Boolean),
		};
	}

	const uid = String(process.getuid?.() ?? '');
	const target = `gui/${uid}/${LABEL}`;
	const bootstrap = `launchctl bootstrap gui/${uid} ${PLIST}`;

	it('bootstraps at once on a first install, with nothing to wait for', () => {
		const result = run({ printsLoaded: 0, bootstrapFailures: 0 });

		expect(result.status).toBe(0);
		expect(result.calls).toEqual([
			`launchctl bootout ${target}`,
			`launchctl print ${target}`,
			bootstrap,
		]);
	});

	it('waits for a running job to leave launchd before bootstrapping', () => {
		const result = run({ printsLoaded: 2, bootstrapFailures: 0 });

		expect(result.status).toBe(0);
		expect(result.calls).toEqual([
			`launchctl bootout ${target}`,
			`launchctl print ${target}`,
			'sleep 0.5',
			`launchctl print ${target}`,
			'sleep 0.5',
			`launchctl print ${target}`,
			bootstrap,
		]);
	});

	it('bootstraps anyway once the bounded wait runs out', () => {
		const result = run({ printsLoaded: 1000, bootstrapFailures: 0 });

		expect(result.status).toBe(0);
		expect(result.calls.filter((call) => call === 'sleep 0.5')).toHaveLength(30);
		expect(result.calls.at(-1)).toBe(bootstrap);
		expect(result.stderr).toContain('still loaded after bootout; bootstrapping anyway');
	});

	it('retries a failed bootstrap and succeeds', () => {
		const result = run({ printsLoaded: 0, bootstrapFailures: 2 });

		expect(result.status).toBe(0);
		expect(result.calls.filter((call) => call === bootstrap)).toHaveLength(3);
		expect(result.calls.filter((call) => call === 'sleep 2')).toHaveLength(2);
		expect(result.stderr).toContain('attempt 1 of 3');
	});

	it('says the agent is not loaded, and how to load it, once every attempt fails', () => {
		const result = run({ printsLoaded: 0, bootstrapFailures: 1000 });

		expect(result.status).toBe(1);
		expect(result.calls.filter((call) => call === bootstrap)).toHaveLength(3);
		expect(result.stderr).toContain(`the agent ${LABEL} is now NOT loaded`);
		expect(result.stderr).toContain(`launchctl bootstrap gui/${uid} "${PLIST}"`);
	});
});
