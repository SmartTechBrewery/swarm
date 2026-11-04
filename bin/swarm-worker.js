#!/usr/bin/env node
// Thin launcher for `swarm-worker` (see `package.json` "bin"; issue #1283). The same
// file is the launcher package's own `bin/swarm-worker.js`: in a clone it runs the
// compiled build, so `npm run build` must have run first; in the package it runs the
// bundle `bin/build-worker-launcher.js` puts at the same path.
import { run } from '../dist/launcher/swarm-worker.js';

process.exit(await run(process.argv.slice(2)));
