import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The mount is what is under test, not the procedures behind it: `workers.listMine`
// stands in for "a workers procedure was reached", and `projects.list` for "a
// namespace this router deliberately does not carry". Both would otherwise need a
// database.
const { listOwnerWorkers } = vi.hoisted(() => ({ listOwnerWorkers: vi.fn() }));
vi.mock('@/identity/worker-enrollment-service.js', async () => ({
	...(await vi.importActual<typeof import('@/identity/worker-enrollment-service.js')>(
		'@/identity/worker-enrollment-service.js',
	)),
	listOwnerWorkers,
}));

import type { SwarmUser } from '@/identity/schema.js';
import { type OperatorApiDeps, registerOperatorApi } from '@/router/operator-api.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'opaque-operator-session-token';

const USER: SwarmUser = {
	id: USER_ID,
	identifier: 'ada@example.com',
	displayName: 'Ada Lovelace',
	instanceAdmin: true,
	createdAt: new Date('2026-01-01T00:00:00Z'),
	updatedAt: new Date('2026-01-01T00:00:00Z'),
};

/** The one live token; everything else — unknown, expired, revoked — resolves to nothing. */
function makeDeps(overrides: Partial<OperatorApiDeps> = {}): OperatorApiDeps {
	return {
		resolveSession: vi.fn(async (token: string) => (token === TOKEN ? USER : undefined)),
		...overrides,
	};
}

function appWith(deps: OperatorApiDeps): Hono {
	const app = new Hono();
	registerOperatorApi(app, deps);
	return app;
}

/** A tRPC query over HTTP GET, the shape phase 4's hand-rolled client will send. */
function get(app: Hono, path: string, token?: string) {
	return app.request(path, {
		headers: token ? { authorization: `Bearer ${token}` } : {},
	});
}

beforeEach(() => {
	listOwnerWorkers.mockReset();
	listOwnerWorkers.mockResolvedValue([]);
});

describe('registerOperatorApi — bearer authentication', () => {
	it('refuses a request carrying no Authorization header', async () => {
		const deps = makeDeps();

		const response = await get(appWith(deps), '/operator/trpc/workers.listMine');

		expect(response.status).toBe(401);
		// No token to look up, so the session store is never consulted.
		expect(deps.resolveSession).not.toHaveBeenCalled();
		expect(listOwnerWorkers).not.toHaveBeenCalled();
	});

	it('refuses a bearer the session store rejects', async () => {
		const deps = makeDeps();

		const response = await get(appWith(deps), '/operator/trpc/workers.listMine', 'stale-token');

		expect(response.status).toBe(401);
		expect(deps.resolveSession).toHaveBeenCalledWith('stale-token');
		expect(listOwnerWorkers).not.toHaveBeenCalled();
	});

	it('reaches a workers procedure as the resolved user for a valid bearer', async () => {
		listOwnerWorkers.mockResolvedValue([{ workerId: 'w1' }]);

		const response = await get(appWith(makeDeps()), '/operator/trpc/workers.listMine', TOKEN);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ result: { data: [{ workerId: 'w1' }] } });
		// The caller is the token's own user, not a privileged service identity.
		expect(listOwnerWorkers).toHaveBeenCalledWith(USER_ID);
	});

	// Same reasoning as `./operator-session.ts` (issue #798): the branch that is safe
	// on a loopback-bound API server would make anyone who found the tunnel URL an
	// installation admin here.
	it('does not honour SWARM_SINGLE_USER_MODE', async () => {
		vi.stubEnv('SWARM_SINGLE_USER_MODE', 'true');
		const deps = makeDeps();

		const response = await get(appWith(deps), '/operator/trpc/workers.listMine');

		expect(response.status).toBe(401);
		expect(listOwnerWorkers).not.toHaveBeenCalled();
	});
});

describe('registerOperatorApi — the exposed surface', () => {
	// The router is the internet-exposed process, so it carries the `workers`
	// namespace alone: projects, credentials, settings, users and runs stay on the
	// loopback-bound API server's `appRouter`.
	it('does not serve a non-workers namespace, even to a valid bearer', async () => {
		const response = await get(appWith(makeDeps()), '/operator/trpc/projects.list', TOKEN);

		expect(response.status).toBe(404);
		const body = (await response.json()) as { error?: { message?: string } };
		expect(body.error?.message).toContain('projects.list');
	});

	it('serves nothing outside its own /operator/trpc prefix', async () => {
		const response = await get(appWith(makeDeps()), '/trpc/workers.listMine', TOKEN);

		expect(response.status).toBe(404);
	});
});
