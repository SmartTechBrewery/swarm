import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The mount is what is under test, not the procedures behind it: `workers.listMine`
// stands in for "a workers procedure was reached", `workers.getById` for "a query
// that takes an input", and `projects.list` for "a namespace this router
// deliberately does not carry". All would otherwise need a database.
const { listOwnerWorkers, getEnrollment, setSharingConsent, getDashboardWorkerDetail } = vi.hoisted(
	() => ({
		listOwnerWorkers: vi.fn(),
		getEnrollment: vi.fn(),
		setSharingConsent: vi.fn(),
		getDashboardWorkerDetail: vi.fn(),
	}),
);
vi.mock('@/identity/worker-enrollment-service.js', async () => ({
	...(await vi.importActual<typeof import('@/identity/worker-enrollment-service.js')>(
		'@/identity/worker-enrollment-service.js',
	)),
	listOwnerWorkers,
	getEnrollment,
	setSharingConsent,
	getDashboardWorkerDetail,
}));
// `workers.setConsent` is the mutation this suite round-trips the CLI client
// through, and its ownership check reads the worker.
const { getWorker } = vi.hoisted(() => ({ getWorker: vi.fn() }));
vi.mock('@/identity/worker-service.js', async () => ({
	...(await vi.importActual<typeof import('@/identity/worker-service.js')>(
		'@/identity/worker-service.js',
	)),
	getWorker,
}));

import { createOperatorClient, type FetchLike } from '@/cli/_shared/operator-client.js';
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

const ENROLLMENT_ID = '22222222-2222-4222-8222-222222222222';
const WORKER_ID = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
	listOwnerWorkers.mockReset();
	listOwnerWorkers.mockResolvedValue([]);
	getEnrollment.mockReset();
	getEnrollment.mockResolvedValue({ id: ENROLLMENT_ID, workerId: WORKER_ID, projectId: 'proj-a' });
	getDashboardWorkerDetail.mockReset();
	getDashboardWorkerDetail.mockResolvedValue({
		workerId: WORKER_ID,
		displayName: 'ada-laptop',
		ownerUserId: USER_ID,
		lastSeenAt: null,
		enrollments: [],
	});
	getWorker.mockReset();
	getWorker.mockResolvedValue({ id: WORKER_ID, ownerUserId: USER_ID, displayName: 'ada-laptop' });
	setSharingConsent.mockReset();
	setSharingConsent.mockResolvedValue({
		id: ENROLLMENT_ID,
		status: 'active',
		allowedClis: ['claude'],
		concurrencyAllocation: 1,
		sharingConsent: true,
	});
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

/**
 * The CLI's own client (`src/cli/_shared/operator-client.ts`, issue #800) driven
 * against this real mount, rather than against a hand-written fixture of what the
 * mount is *believed* to answer. That is the point: the client hand-rolls tRPC's
 * HTTP protocol to stay dependency-free, so every assumption it makes — where the
 * input goes for a query, that a mutation POST needs an explicit content type,
 * the `{result:{data}}` envelope, the `data.code` on a refusal — is only as good
 * as a round trip through `@hono/trpc-server` itself.
 */
describe('the operator CLI client against this mount', () => {
	/** Route the client's `fetch` into the in-process Hono app; nothing touches a network. */
	function clientFor(app: Hono, token = TOKEN) {
		const fetchImpl: FetchLike = async (url, init) => {
			const response = await app.request(url, {
				method: init.method,
				headers: init.headers,
				body: init.body,
			});
			return {
				ok: response.ok,
				status: response.status,
				json: () => response.json(),
			};
		};
		return createOperatorClient({
			controlPlaneUrl: 'http://control-plane.test',
			token,
			fetchImpl,
		});
	}

	it('round-trips an input-less query and unwraps its result envelope', async () => {
		listOwnerWorkers.mockResolvedValue([{ workerId: WORKER_ID }]);

		const data = await clientFor(appWith(makeDeps())).query(
			'workers.listMine',
			undefined,
			(value) => value,
		);

		expect(data).toEqual([{ workerId: WORKER_ID }]);
	});

	// The other half: `workers.listMine` takes no input, so it says nothing about
	// *where* an input goes. `workers.getById` does take one, and this asserts the
	// client's `?input=<encodeURIComponent(JSON)>` against @trpc/server's own parser
	// rather than against the client's own mock — the argument actually arrives.
	it('puts a query input where @trpc/server reads it', async () => {
		const data = await clientFor(appWith(makeDeps())).query(
			'workers.getById',
			{ workerId: WORKER_ID },
			(value) => value,
		);

		expect(getDashboardWorkerDetail).toHaveBeenCalledWith(WORKER_ID, null, USER_ID);
		expect(data).toMatchObject({ workerId: WORKER_ID, displayName: 'ada-laptop' });
	});

	// The load-bearing one: `@hono/trpc-server`'s non-batch POST path answers
	// UNSUPPORTED_MEDIA_TYPE for a body sent without `content-type: application/json`,
	// so a client that omits it reaches no procedure at all.
	it('round-trips a mutation, so its body actually reaches the procedure', async () => {
		const data = await clientFor(appWith(makeDeps())).mutate(
			'workers.setConsent',
			{ enrollmentId: ENROLLMENT_ID, sharingConsent: true },
			(value) => value,
		);

		expect(setSharingConsent).toHaveBeenCalledWith(ENROLLMENT_ID, true);
		expect(data).toMatchObject({ id: ENROLLMENT_ID, sharingConsent: true });
	});

	it("turns this mount's UNAUTHORIZED into the `swarm login` hint", async () => {
		await expect(
			clientFor(appWith(makeDeps()), 'stale-token').query(
				'workers.listMine',
				undefined,
				(value) => value,
			),
		).rejects.toThrow('your control-plane session has expired — run `swarm login`');
	});

	// A namespace this router deliberately does not carry reads to the CLI as
	// version skew, which is what it is from the operator's side.
	it('reports an unserved procedure as an older control plane', async () => {
		await expect(
			clientFor(appWith(makeDeps())).query('projects.list', undefined, (value) => value),
		).rejects.toThrow(/older build than your CLI/);
	});
});
