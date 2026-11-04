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
// signs and checksums it — so it is packed here rather than by `tar`, whose BSD
// and GNU flavours disagree on the flags that pin order, owners and times: a
// fixed entry order, mtime 0, uid/gid 0, and a gzip header with no time or name.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';

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

// Directories before their contents, then a fixed order — never `readdir`'s.
const entries = ['', 'dist/', 'dist/transport/', 'package.json', 'build-info.json', BUNDLE];
const blocks = [];
for (const entry of entries) {
	const isDir = entry === '' || entry.endsWith('/');
	if (isDir) {
		blocks.push(tarHeader(`${name}/${entry}`, 0, true));
		continue;
	}
	let data;
	try {
		data = readFileSync(join(stage, entry));
	} catch (err) {
		// The one optional file: no SWARM_BUILD_COMMIT, no stamp.
		if (entry === 'build-info.json' && err.code === 'ENOENT') continue;
		throw err;
	}
	blocks.push(tarHeader(`${name}/${entry}`, data.length, false), data, padding(data.length));
}
blocks.push(Buffer.alloc(1024));

const gz = gzipSync(Buffer.concat(blocks), { level: 9 });
// The header's OS byte is whatever platform zlib was built for; pin it to Unix
// so a macOS and a Linux build of the same tree agree.
gz[9] = 3;
const artifact = join(outDir, `${name}.tar.gz`);
writeFileSync(artifact, gz);
console.log(`[build-worker-runtime] ${artifact}`);

/** A POSIX ustar header for one entry, with every variable field pinned. */
function tarHeader(path, size, isDir) {
	if (Buffer.byteLength(path) > 100) throw new Error(`tar entry name too long: ${path}`);
	const header = Buffer.alloc(512);
	const field = (offset, length, value) => header.write(value, offset, length, 'ascii');
	const octal = (offset, length, value) =>
		field(offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
	field(0, 100, path);
	octal(100, 8, isDir ? 0o755 : 0o644);
	octal(108, 8, 0); // uid
	octal(116, 8, 0); // gid
	octal(124, 12, size);
	octal(136, 12, 0); // mtime
	field(148, 8, ' '.repeat(8)); // checksum placeholder, summed as spaces
	field(156, 1, isDir ? '5' : '0');
	field(257, 6, 'ustar\0');
	field(263, 2, '00');
	let sum = 0;
	for (const byte of header) sum += byte;
	field(148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
	return header;
}

function padding(size) {
	return Buffer.alloc((512 - (size % 512)) % 512);
}
