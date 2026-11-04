#!/usr/bin/env node
// Build the self-contained worker runtime (issue #1279): the worker daemon
// (`src/transport/connect-entry.ts`) bundled by esbuild into one ESM file, packed
// with a minimal `package.json` and the `build-info.json` stamp (issue #1285) into
// a tarball that runs with nothing but Node >= 22 — no checkout, no
// `node_modules`, no `tsx`, no `.env`. The env contract is the daemon's own.
//
//   node bin/build-worker-runtime.js [out-dir]     (default: <repo>/worker-runtime)
//
// Writes `<out-dir>/swarm-worker-runtime-<version>.tar.gz` and leaves the staged
// tree beside it for a quick local run. The stamp is written by
// `bin/write-build-info.js` from SWARM_BUILD_COMMIT, with its rules: no commit, no
// stamp (the runtime then declares no identity); a commit that is not hex fails.
// This script adds `launcherProtocol` to it (issue #1303) — `RUNTIME_LAUNCHER_PROTOCOL`
// in `src/launcher/runtime-store.ts`, which a test keeps this copy equal to: it tells
// a daemon moving its worker to this runtime that the runtime's own daemon promotes
// a version awaiting verification, so the launcher will not abandon it after a few
// healthy starts. A runtime without it is never a move's target.
//
// **The layout is load-bearing.** Every module in a bundle shares the bundle's
// `import.meta.url`, and two of them anchor on it: `swarmInstallRoot()`
// (`src/lib/build-identity.ts`, three levels up from the file) and
// `resolveDaemonVersion()` (`src/transport/worker-main.ts`, `../../package.json`).
// Both land on the runtime root only because the bundle sits at
// `dist/transport/connect-entry.mjs`, where the compiled daemon sits in a clone.
// Move it up or down a level and the version and the identity silently vanish.
//
// **The tarball is byte-deterministic** for one source tree and commit — phase 2
// signs and checksums it — so it is packed by `./lib/deterministic-tarball.js`
// (shared with `bin/build-worker-launcher.js`) rather than by `tar`.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { packDeterministicTarball } from './lib/deterministic-tarball.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(process.argv[2] ?? join(repoRoot, 'worker-runtime'));

const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const name = `swarm-worker-runtime-${version}`;
const stage = join(outDir, name);
const BUNDLE = 'dist/transport/connect-entry.mjs';

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

await build({
	absWorkingDir: repoRoot,
	entryPoints: ['src/transport/connect-entry.ts'],
	outfile: join(stage, BUNDLE),
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node22',
	// Bundled CommonJS dependencies (pg, ioredis, bullmq, ws) `require` node
	// builtins, which an ESM file has no `require` for.
	banner: {
		js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
	},
	// Optional native accelerators. Both are loaded inside a try (msgpackr) or only
	// on request (`pg.native`), so leaving them out keeps the pure-JS paths.
	external: ['msgpackr-extract', 'pg-native'],
	legalComments: 'none',
	// Each bundled module is headed by a comment naming its path. A SWARM worktree
	// links `node_modules` in from the main checkout, and following that link would
	// name `../../node_modules/…` there and `node_modules/…` in a clone — two
	// different artifacts from one commit.
	preserveSymlinks: true,
	logLevel: 'warning',
});

const runtimePackage = {
	name: 'swarm-worker-runtime',
	version,
	private: true,
	type: 'module',
	engines: { node: '>=22.0.0' },
};
writeFileSync(join(stage, 'package.json'), `${JSON.stringify(runtimePackage, null, 2)}\n`);

const stamp = spawnSync(process.execPath, [join(repoRoot, 'bin/write-build-info.js'), stage], {
	stdio: 'inherit',
});
if (stamp.status !== 0) process.exit(stamp.status ?? 1);

/** `RUNTIME_LAUNCHER_PROTOCOL` (`src/launcher/runtime-store.ts`). */
const LAUNCHER_PROTOCOL = 1;
const buildInfoPath = join(stage, 'build-info.json');
if (existsSync(buildInfoPath)) {
	const info = JSON.parse(readFileSync(buildInfoPath, 'utf8'));
	writeFileSync(
		buildInfoPath,
		`${JSON.stringify({ ...info, launcherProtocol: LAUNCHER_PROTOCOL }, null, 2)}\n`,
	);
}

// Directories before their contents, then a fixed order — never `readdir`'s. The
// stamp is the one optional file: no SWARM_BUILD_COMMIT, no stamp.
const artifact = join(outDir, `${name}.tar.gz`);
writeFileSync(
	artifact,
	packDeterministicTarball(stage, name, [
		'',
		'dist/',
		'dist/transport/',
		'package.json',
		{ path: 'build-info.json', optional: true },
		BUNDLE,
	]),
);
console.log(`[build-worker-runtime] ${artifact}`);
