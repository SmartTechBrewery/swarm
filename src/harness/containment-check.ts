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
 * without a model turn. The claude side is not covered by this check; agy's
 * unavailable contained mode is recorded in `docs/agent-containment.md`.
 *
 * Usage: `npm run check:containment -- <worktree>`. `<worktree>` must be a
 * linked task worktree: it is the layout a contained phase actually runs in.
 * Exits 0 only when every assertion holds; anything else — a failed assertion,
 * an invalid target, a missing `codex` binary — exits non-zero, because a
 * containment check that cannot run has not proven anything.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

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

function buildProbes(dir: string, gitCommonDir: string): Probe[] {
	// Unique per run so a leftover file from an earlier check can never make a
	// "write succeeded" look like a fresh success, and so two checks can overlap.
	const marker = `.swarm-containment-check-${process.pid}`;
	const repoRoot = dirname(gitCommonDir);
	const outsideRepo = join(repoRoot, marker);
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
			why: 'the main checkout and every sibling worktree must stay outside the task boundary',
		},
		{
			name: 'git fetch in the linked worktree',
			script: `git -C ${JSON.stringify(dir)} fetch origin HEAD`,
			expect: 'allowed',
			why: 'Respond-to-CI and Respond-to-review begin with git pull, which writes linked-worktree metadata',
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

function resolveLinkedWorktree(dir: string): { gitCommonDir: string } {
	const dotGit = join(dir, '.git');
	if (!statSync(dotGit).isFile()) {
		throw new Error('target is not a linked worktree: its .git must be a gitdir pointer file');
	}

	const gitDirMatch = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, 'utf8'));
	if (!gitDirMatch) throw new Error('target .git is not a valid gitdir pointer');
	const gitDir = isAbsolute(gitDirMatch[1]) ? gitDirMatch[1] : resolve(dir, gitDirMatch[1]);
	const commonDir = readFileSync(join(gitDir, 'commondir'), 'utf8').trim();
	if (!commonDir) throw new Error('linked worktree gitdir has no common directory');
	return { gitCommonDir: isAbsolute(commonDir) ? commonDir : resolve(gitDir, commonDir) };
}

/** Run one probe under the sandbox and report whether it behaved as expected. */
function runProbe(dir: string, probe: Probe): { ok: boolean; detail: string } {
	const result = spawnSync(
		'codex',
		[
			'sandbox',
			...codexPermissionProfileArgs(dir),
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
	const target = process.argv[2];
	if (!target) {
		console.error('Usage: npm run check:containment -- /path/to/.swarm-workspaces/task-123');
		process.exit(1);
	}
	const dir = resolve(target);
	let gitCommonDir: string;
	try {
		({ gitCommonDir } = resolveLinkedWorktree(dir));
	} catch (error) {
		console.error(`Containment check requires a linked task worktree: ${(error as Error).message}`);
		process.exit(1);
	}
	const version = spawnSync('codex', ['--version'], { encoding: 'utf8' });
	if (version.error || version.status !== 0) {
		console.error(
			'codex is not installed or not on PATH — the containment check cannot run.\n' +
				'Install the codex CLI (see docs/agent-containment.md) and re-run `npm run check:containment`.',
		);
		process.exit(1);
	}

	console.log(`codex ${(version.stdout || '').trim()}`);
	console.log(`profile "${CODEX_PERMISSION_PROFILE}" applied to linked worktree ${dir}\n`);

	let failed = 0;
	for (const probe of buildProbes(dir, gitCommonDir)) {
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
