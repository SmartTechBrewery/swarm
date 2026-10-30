import { afterEach, describe, expect, it, vi } from 'vitest';

// `src/serve/index.ts` is a pure process boundary: importing it *is* starting the
// process. Every collaborator that would bind a port or reach Postgres/Redis is
// mocked so the import runs the startup sequence and nothing else.
vi.mock('@hono/node-server', () => ({ serve: vi.fn(() => ({ close: vi.fn() })) }));
vi.mock('@/api/maintenance.js', () => ({
	startHostMaintenance: vi.fn(() => ({ close: vi.fn() })),
}));
vi.mock('@/db/migrate.js', () => ({ runMigrations: vi.fn(async () => undefined) }));
vi.mock('@/identity/first-run-setup.js', () => ({
	announceFirstRunSetup: vi.fn(async () => undefined),
}));
vi.mock('@/queue/producer.js', () => ({ closeQueue: vi.fn() }));
vi.mock('@/config/retired-operator-tokens.js', () => ({ noticeRetiredOperatorTokens: vi.fn() }));
vi.mock('@/router/dispatcher.js', () => ({
	startControlPlaneDispatch: vi.fn(async () => ({ close: vi.fn() })),
}));
vi.mock('@/router/worker-rollout-advance.js', () => ({
	startRolloutAdvanceTicker: vi.fn(() => ({ close: vi.fn() })),
}));
vi.mock('@/router/worktree-sweep-dispatch.js', () => ({
	subscribeWorktreeSweepDispatch: vi.fn(() => ({ close: vi.fn() })),
}));
vi.mock('@/serve/app.js', () => ({
	createAllInOneApp: vi.fn(() => ({ app: { fetch: vi.fn() }, injectWebSocket: vi.fn() })),
}));
vi.mock('@/serve/settings.js', () => ({
	SERVE_ALLOW_INSECURE_ENV: 'SWARM_SERVE_ALLOW_INSECURE',
	assertServeStartupSafety: vi.fn(() => ({ waived: [] })),
	isServeWorktreeSweepEnabled: vi.fn(() => false),
	resolveServeListen: vi.fn(() => ({ port: 3000 })),
}));

import { announceFirstRunSetup } from '@/identity/first-run-setup.js';

describe('all-in-one control plane entry point', () => {
	const listeners = {
		SIGTERM: process.listeners('SIGTERM'),
		SIGINT: process.listeners('SIGINT'),
	};

	afterEach(() => {
		// The entry point installs its own shutdown handlers; leave the runner's alone.
		for (const signal of ['SIGTERM', 'SIGINT'] as const) {
			for (const listener of process.listeners(signal)) {
				if (!listeners[signal].includes(listener)) process.off(signal, listener);
			}
		}
	});

	it('issues the first-run setup link with the public base URL (issue #1150)', async () => {
		vi.stubEnv('WEBHOOK_CALLBACK_BASE_URL', 'https://swarm.example.com/');

		await import('@/serve/index.js');

		expect(announceFirstRunSetup).toHaveBeenCalledTimes(1);
		expect(announceFirstRunSetup).toHaveBeenCalledWith({ baseUrl: 'https://swarm.example.com' });
	});
});
