/**
 * Install-root resolution for the `swarm` operator CLI and the `swarm-worker`
 * launcher package.
 *
 * The CLI shells out to `docker compose`, reads/writes `.env` and runs the
 * `bin/swarm-worker-agent` installer — all of which must be anchored to the
 * install root, not the caller's cwd. Resolving it from this module's own location
 * (rather than `process.cwd()`) means `swarm status` works from any directory,
 * including a task worktree.
 *
 * The root is the **nearest directory above this module holding a `package.json`**
 * (issue #1311), not a fixed number of levels up. A fixed `../../..` was right for
 * `src/cli/_shared/` and its compiled twin `dist/cli/_shared/`, but the launcher
 * package bundles this module into `dist/launcher/swarm-worker.js`
 * (`bin/build-worker-launcher.js`), where `import.meta.url` is the bundle's and
 * three levels up is *above* the package. Walking up gives the same answer in all
 * three: the checkout in `src/` and `dist/`, the package's own root in the bundle.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The nearest directory at or above `fromDir` that holds a `package.json`. With
 * none at all — not a layout SWARM ships — the old fixed walk's answer is kept, so
 * a path built on it is still a path rather than a throw at import time.
 */
export function findInstallRoot(fromDir: string): string {
	for (let dir = resolve(fromDir); ; dir = dirname(dir)) {
		if (existsSync(join(dir, 'package.json'))) return dir;
		if (dirname(dir) === dir) return resolve(fromDir, '../../..');
	}
}

export const REPO_ROOT = findInstallRoot(dirname(fileURLToPath(import.meta.url)));
