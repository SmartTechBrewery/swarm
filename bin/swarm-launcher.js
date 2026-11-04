#!/usr/bin/env node
// Thin launcher for the `swarm-launcher` worker launcher (see `package.json` "bin").
// Runs the compiled build, so `npm run build` must have run first.
import { run } from '../dist/launcher/main.js';

process.exit(await run(process.argv.slice(2)));
