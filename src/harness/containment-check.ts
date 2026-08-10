/**
 * Re-runnable proof that `worktree` containment actually contains
 * (`npm run check:containment` — issue #614).
 *
 * The claim "writes outside the task worktree fail" is worth nothing asserted
 * once in a PR description: sandbox behavior is a property of the *installed*
 * CLI and the host OS, both of which move. This script re-checks it on demand,
 * against the same permission profile `./containment.ts` builds for a real run,
 * so a drift between the two cannot hide.
 *
 * It drives `codex sandbox -P <profile> -C <dir> -- <cmd>`, which applies the
 * profile's Seatbelt/Landlock policy to an ordinary command with **no model in
 * the loop** — deterministic, instant, and free. That is codex-specific by
 * necessity: codex is the only one of the three CLIs that exposes its sandbox
 * without a model turn. The claude side of the same policy is verified by a
 * cheap headless run instead; `docs/agent-containment.md` records that
 * transcript and why agy has no contained mode at all.
 *
 * Usage: `npm run check:containment [-- <dir>]`, where `<dir>` defaults to the
 * current working directory and should be a task worktree (or any checkout) to
 * exercise the real layout. Exits 0 only when every assertion holds; anything
 * else — a failed assertion, a missing `codex` binary — exits non-zero, because
 * a containment check that cannot run has not proven anything.
 */

import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { CODEX_PERMISSION_PROFILE, codexPermissionProfileArgs } from './containment.js';

/** One thing the contained command is expected to be able (or unable) to do. */
interface Probe {
	name: string;
	/** Shell run inside the sandbox; it must exit 0 exactly when `expect` is `allowed`. */
	script: string;
	expect: 'allowed' | 'denied';
	/** Why this probe exists, printed when it fails. */
	why: string;
}

function buildProbes(dir: string): Probe[] {
	// Unique per run so a leftover file from an earlier check can never make a
	// "write succeeded" look like a fresh success, and so two checks can overlap.
	const marker = `.swarm-containment-check-${process.pid}`;
	const outsideRepo = join(dirname(dir), marker);
	const inHome = join(homedir(), marker);
	return [
		{
			name: 'write inside the worktree',
			script: `printf x > ${JSON.stringify(join(dir, marker))} && rm -f ${JSON.stringify(join(dir, marker))}`,
			expect: 'allowed',
			why: 'a contained agent must still be able to edit the task it was given',
		},
		{
			name: 'write outside the worktree',
			script: `printf x > ${JSON.stringify(outsideRepo)}`,
			expect: 'denied',
			why: 'the parent directory holds the main checkout and every sibling worktree',
		},
		{
			name: 'write $HOME',
			script: `printf x > ${JSON.stringify(inHome)}`,
			expect: 'denied',
			why: '$HOME holds ~/.ssh, ~/.aws and every credential the worker user owns',
		},
		{
			name: 'network to api.github.com',
			script: 'curl -sS -o /dev/null -m 20 https://api.github.com',
			expect: 'allowed',
			why: 'every phase prompt runs `gh` reads and `git pull`; containment must not break them',
		},
	];
}

/** Run one probe under the sandbox and report whether it behaved as expected. */
function runProbe(dir: string, probe: Probe): { ok: boolean; detail: string } {
	const result = spawnSync(
		'codex',
		[
			'sandbox',
			...codexPermissionProfileArgs(),
			'-P',
			CODEX_PERMISSION_PROFILE,
			'-C',
			dir,
			'--',
			'/bin/sh',
			'-c',
			probe.script,
		],
		{ encoding: 'utf8' },
	);
	if (result.error) return { ok: false, detail: `could not run codex: ${result.error.message}` };
	const allowed = result.status === 0;
	const detail = (result.stderr || result.stdout || '').trim().split('\n').at(-1) ?? '';
	return { ok: allowed === (probe.expect === 'allowed'), detail };
}

function main(): void {
	const dir = resolve(process.argv[2] ?? process.cwd());
	const version = spawnSync('codex', ['--version'], { encoding: 'utf8' });
	if (version.error || version.status !== 0) {
		console.error(
			'codex is not installed or not on PATH — the containment check cannot run.\n' +
				'Install the codex CLI (see docs/agent-containment.md) and re-run `npm run check:containment`.',
		);
		process.exit(1);
	}

	console.log(`codex ${(version.stdout || '').trim()}`);
	console.log(`profile "${CODEX_PERMISSION_PROFILE}" applied to ${dir}\n`);

	let failed = 0;
	for (const probe of buildProbes(dir)) {
		const { ok, detail } = runProbe(dir, probe);
		console.log(`${ok ? 'PASS' : 'FAIL'}  ${probe.name} — expected ${probe.expect}`);
		if (!ok) {
			failed += 1;
			console.log(`      ${probe.why}`);
			if (detail) console.log(`      last output: ${detail}`);
		}
	}

	if (failed > 0) {
		console.error(
			`\n${failed} containment check(s) failed — do not enable SWARM_AGENT_CONTAINMENT=worktree.`,
		);
		process.exit(1);
	}
	console.log('\nAll containment checks passed.');
}

main();
