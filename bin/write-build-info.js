#!/usr/bin/env node
// Stamp `build-info.json` — the release version and source commit — into a SWARM
// install root that will run without a git checkout of its own (issue #1285): the
// published image (`Dockerfile`), and later a packaged worker. `src/lib/build-identity.ts`
// reads it when the install root is not the top level of a git work tree.
//
//   node bin/write-build-info.js [install-root]
//
// The commit comes from SWARM_BUILD_COMMIT (CI passes `github.sha`); the version
// from the install root's package.json. With no commit nothing is written and the
// build declares no identity, exactly as before — a local `docker build` without
// the build arg is not an error. A commit that is not a hex id is, so a broken CI
// wiring fails the build instead of shipping an image that cannot be compared.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
const commit = (process.env.SWARM_BUILD_COMMIT ?? '').trim().toLowerCase();

if (!commit) {
	console.warn('[write-build-info] SWARM_BUILD_COMMIT is unset; no build-info.json written');
	process.exit(0);
}
if (!/^[0-9a-f]{7,64}$/.test(commit)) {
	console.error(`[write-build-info] SWARM_BUILD_COMMIT is not a hex commit id: ${commit}`);
	process.exit(1);
}

const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const info = typeof version === 'string' && version.trim() ? { version, commit } : { commit };
writeFileSync(join(root, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);
console.log(`[write-build-info] ${JSON.stringify(info)}`);
