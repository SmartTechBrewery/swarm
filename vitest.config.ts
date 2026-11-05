import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Mirror Cascade's `@/*` → `src/*` alias so imports resolve the same way tsc does.
const resolve = {
	alias: [{ find: '@', replacement: path.resolve(__dirname, './src') }],
};

// Shared settings inherited by every project. Kept flat and small for the MVP —
// Cascade splits its unit suite into four domain projects, but SWARM has one
// tree so far; revisit the split once the suite is large enough to need it.
const sharedTest = {
	globals: true,
	environment: 'node' as const,
	clearMocks: true,
	unstubEnvs: true,
	setupFiles: ['./tests/setup.ts'],
};

export default defineConfig({
	test: {
		// The integration project may legitimately run zero tests (suites skip
		// themselves when no test database is reachable — tests/integration/setup.ts).
		passWithNoTests: true,

		coverage: {
			provider: 'v8',
			reporter: ['text', 'lcov', 'html'],
			include: ['src/**/*.ts'],
			exclude: ['src/**/*.test.ts', 'src/index.ts'],
			// Mirror Cascade's thresholds so coverage can't silently regress.
			thresholds: {
				lines: 80,
				functions: 80,
				branches: 75,
				statements: 80,
			},
		},

		projects: [
			{
				test: {
					name: 'unit',
					include: ['tests/unit/**/*.test.ts'],
					pool: 'threads',
					// The launcher and installer cases spawn sh, node and tar. Alone they
					// take well under a second, but the full parallel run (the pre-push
					// hook) pushed some past the 5 s default and blocked a release push.
					testTimeout: 20_000,
					...sharedTest,
				},
				resolve,
			},
			// Integration tests run serially against real, ephemeral Postgres/Redis
			// (see ai/TESTING.md). Single-fork to avoid state collisions.
			{
				test: {
					name: 'integration',
					include: ['tests/integration/**/*.test.ts'],
					...sharedTest,
					setupFiles: [...sharedTest.setupFiles, './tests/integration/setup.ts'],
					testTimeout: 30_000,
					hookTimeout: 30_000,
					pool: 'forks',
					poolOptions: { forks: { singleFork: true } },
				},
				resolve,
			},
		],
	},
	resolve,
});
