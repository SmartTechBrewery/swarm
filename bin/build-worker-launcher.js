#!/usr/bin/env node
// Build the clone-free worker launcher package (issue #1283): the `swarm-worker`
// command (`src/launcher/swarm-worker.ts`, which hands `run`/`runtimes` to
// `src/launcher/main.ts`) bundled by esbuild into one ESM file, packed with the
// LaunchAgent installer `bin/swarm-worker-agent`, a minimal `package.json`, the
// `build-info.json` stamp and — when the checkout has it — the publisher's trusted
// runtime key. It runs with nothing but Node >= 22: no checkout, no `node_modules`.
//
//   node bin/build-worker-launcher.js [out-dir]    (default: <repo>/worker-runtime)
//
// Writes `<out-dir>/swarm-worker-launcher-<version>.tar.gz` and leaves the staged
// tree beside it for a quick local run. The stamp is written by
// `bin/write-build-info.js` from SWARM_BUILD_COMMIT, with its rules: no commit, no
// stamp; a commit that is not hex fails. Without `deploy/worker-runtime/minisign.pub`
// the package is still built, with a warning: such a launcher installs no new
// runtime and only starts versions already installed.
//
// **The layout is load-bearing.**
//
//   swarm-worker-launcher-<version>/
//     package.json                        "type": "module", so the `.js` bundle is ESM
//     build-info.json                     only when SWARM_BUILD_COMMIT is set
//     bin/swarm-worker.js                 the repo's own shim, verbatim (0755)
//     bin/swarm-worker-agent              the repo's own installer, verbatim (0755)
//     dist/launcher/swarm-worker.js       the bundle
//     deploy/worker-runtime/minisign.pub  only when the checkout has it
//
// The bundle sits at `dist/launcher/`, where the compiled launcher sits in a clone,
// because `LAUNCHER_INSTALL_ROOT` (`src/launcher/main.ts`) is two levels up from it:
// that is where the trusted key and the version are read from. And the shim imports
// `../dist/launcher/swarm-worker.js`, the same path in a clone and here, which is
// what lets `swarm-worker-agent install --profile` write a plist naming
// `<root>/bin/swarm-worker.js` that is right for both.
//
// **The tarball is byte-deterministic** for one source tree and commit — the
// installation serves its SHA-256 — so it is packed by `./lib/deterministic-tarball.js`,
// the runtime build's own packer.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { packDeterministicTarball } from './lib/deterministic-tarball.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(process.argv[2] ?? join(repoRoot, 'worker-runtime'));

const { version } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
const name = `swarm-worker-launcher-${version}`;
const stage = join(outDir, name);
const BUNDLE = 'dist/launcher/swarm-worker.js';
const SHIM = 'bin/swarm-worker.js';
const AGENT = 'bin/swarm-worker-agent';
const TRUSTED_KEY = 'deploy/worker-runtime/minisign.pub';

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'bin'), { recursive: true });

await build({
	absWorkingDir: repoRoot,
	entryPoints: ['src/launcher/swarm-worker.ts'],
	outfile: join(stage, BUNDLE),
	bundle: true,
	platform: 'node',
	format: 'esm',
	target: 'node22',
	// A bundled CommonJS dependency would `require` node builtins, which an ESM file
	// has no `require` for.
	banner: {
		js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
	},
	legalComments: 'none',
	// As in the runtime build: following a worktree's `node_modules` link would name
	// a different path in each module's header comment than a clone does.
	preserveSymlinks: true,
	logLevel: 'warning',
});

const launcherPackage = {
	name: 'swarm-worker-launcher',
	version,
	private: true,
	type: 'module',
	engines: { node: '>=22.0.0' },
};
writeFileSync(join(stage, 'package.json'), `${JSON.stringify(launcherPackage, null, 2)}\n`);

const stamp = spawnSync(process.execPath, [join(repoRoot, 'bin/write-build-info.js'), stage], {
	stdio: 'inherit',
});
if (stamp.status !== 0) process.exit(stamp.status ?? 1);

copyFileSync(join(repoRoot, SHIM), join(stage, SHIM));
copyFileSync(join(repoRoot, AGENT), join(stage, AGENT));
const hasKey = existsSync(join(repoRoot, TRUSTED_KEY));
if (hasKey) {
	mkdirSync(join(stage, dirname(TRUSTED_KEY)), { recursive: true });
	copyFileSync(join(repoRoot, TRUSTED_KEY), join(stage, TRUSTED_KEY));
} else {
	console.warn(
		`[build-worker-launcher] ${TRUSTED_KEY} is missing; this launcher can only start runtimes already installed`,
	);
}

// Directories before their contents, then a fixed order — never `readdir`'s. The
// stamp is optional (no SWARM_BUILD_COMMIT, no stamp), and the key's directories
// are packed only with the key.
const artifact = join(outDir, `${name}.tar.gz`);
writeFileSync(
	artifact,
	packDeterministicTarball(stage, name, [
		'',
		'bin/',
		...(hasKey ? ['deploy/', 'deploy/worker-runtime/'] : []),
		'dist/',
		'dist/launcher/',
		'package.json',
		{ path: 'build-info.json', optional: true },
		{ path: SHIM, mode: 0o755 },
		{ path: AGENT, mode: 0o755 },
		...(hasKey ? [TRUSTED_KEY] : []),
		BUNDLE,
	]),
);
console.log(`[build-worker-launcher] ${artifact}`);
