import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const { readOperatorSessionCache, operatorSessionCachePath } = vi.hoisted(() => ({
	readOperatorSessionCache: vi.fn(),
	operatorSessionCachePath: vi.fn(() => '/home/ada/.swarm/operator-sessions/abc123/session.json'),
}));

vi.mock('@/cli/_shared/operator-session-cache.js', () => ({
	readOperatorSessionCache,
	operatorSessionCachePath,
}));

import {
	createOperatorClient,
	type FetchLike,
	OperatorApiError,
	operatorUrl,
	requireOperatorSession,
} from '@/cli/_shared/operator-client.js';

const CONTROL_PLANE = 'https://swarm.example.com';
const TOKEN = 'opaque-session-token';

type FakeResponse = { status: number; body?: unknown; unparseable?: boolean };

/** Record every request and answer it with one canned response — no network, no tRPC client. */
function stubFetch(answer: FakeResponse) {
	const calls: { url: string; init: Parameters<FetchLike>[1] }[] = [];
	const fetchImpl: FetchLike = async (url, init) => {
		calls.push({ url, init });
		return {
			ok: answer.status >= 200 && answer.status < 300,
			status: answer.status,
			json: async () => {
				if (answer.unparseable) throw new SyntaxError('Unexpected token < in JSON');
				return answer.body;
			},
		};
	};
	return { fetchImpl, calls };
}

function client(answer: FakeResponse, controlPlaneUrl = CONTROL_PLANE) {
	const { fetchImpl, calls } = stubFetch(answer);
	return { client: createOperatorClient({ controlPlaneUrl, token: TOKEN, fetchImpl }), calls };
}

const passthrough = (value: unknown) => value;
const ok = (data: unknown): FakeResponse => ({ status: 200, body: { result: { data } } });
const trpcError = (status: number, message: string, code?: string): FakeResponse => ({
	status,
	body: { error: { message, ...(code ? { data: { code } } : {}) } },
});

describe('operatorUrl', () => {
	it('joins onto the operator tRPC mount and tolerates a trailing slash', () => {
		expect(operatorUrl(CONTROL_PLANE, 'workers.list')).toBe(
			'https://swarm.example.com/operator/trpc/workers.list',
		);
		expect(operatorUrl(`${CONTROL_PLANE}//`, 'workers.list')).toBe(
			'https://swarm.example.com/operator/trpc/workers.list',
		);
	});

	// A router mounted under a sub-path keeps it, exactly as `swarm login` does.
	it('preserves a base path', () => {
		expect(operatorUrl('https://example.com/swarm', 'workers.register')).toBe(
			'https://example.com/swarm/operator/trpc/workers.register',
		);
	});
});

describe('createOperatorClient', () => {
	it('sends a query as a GET with the input JSON-encoded in the query string', async () => {
		const { client: api, calls } = client(ok({ providerId: 'github' }));
		await api.query('workers.projectScmProvider', { projectId: 'proj a' }, passthrough);

		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call?.url).toBe(
			`https://swarm.example.com/operator/trpc/workers.projectScmProvider?input=${encodeURIComponent(
				'{"projectId":"proj a"}',
			)}`,
		);
		expect(call?.init.method).toBe('GET');
		expect(call?.init.body).toBeUndefined();
	});

	it('omits `input` entirely for a query that takes none', async () => {
		const { client: api, calls } = client(ok([]));
		await api.query('workers.list', undefined, passthrough);
		expect(calls[0]?.url).toBe('https://swarm.example.com/operator/trpc/workers.list');
	});

	// `@hono/trpc-server`'s non-batch POST path answers UNSUPPORTED_MEDIA_TYPE
	// without an explicit content type; its GET path does not need one.
	it('sends a mutation as a POST with a JSON body and an explicit content type', async () => {
		const { client: api, calls } = client(ok({ workerId: 'w-1' }));
		await api.mutate('workers.remove', { workerId: 'w-1' }, passthrough);

		const [call] = calls;
		expect(call?.url).toBe('https://swarm.example.com/operator/trpc/workers.remove');
		expect(call?.init.method).toBe('POST');
		expect(call?.init.body).toBe('{"workerId":"w-1"}');
		expect(call?.init.headers['content-type']).toBe('application/json');
	});

	it('authenticates every call with the session token as a bearer, and never in the URL', async () => {
		const { client: api, calls } = client(ok([]));
		await api.query('workers.list', undefined, passthrough);
		expect(calls[0]?.init.headers.authorization).toBe(`Bearer ${TOKEN}`);
		expect(calls[0]?.url).not.toContain(TOKEN);
	});

	it('unwraps `{result:{data}}` and hands the payload to the caller schema', async () => {
		const { client: api } = client(ok({ providerId: 'bitbucket' }));
		const parsed = await api.query('workers.projectScmProvider', { projectId: 'p' }, (value) =>
			z.object({ providerId: z.string() }).parse(value),
		);
		expect(parsed).toEqual({ providerId: 'bitbucket' });
	});

	it("throws a tRPC refusal with the server's own message", async () => {
		const { client: api } = client(
			trpcError(409, 'This worker is running a job right now.', 'CONFLICT'),
		);
		await expect(api.mutate('workers.remove', { workerId: 'w-1' }, passthrough)).rejects.toThrow(
			new OperatorApiError('This worker is running a job right now.'),
		);
	});

	// The token is opaque here, so expired and revoked are the same answer — and it
	// is the same command either way.
	it('turns UNAUTHORIZED into the `swarm login` hint', async () => {
		const { client: api } = client(trpcError(401, 'UNAUTHORIZED', 'UNAUTHORIZED'));
		await expect(api.query('workers.list', undefined, passthrough)).rejects.toThrow(
			'your control-plane session has expired — run `swarm login`',
		);
	});

	it('names version skew when the control plane serves no such procedure', async () => {
		const { client: api } = client(
			trpcError(404, 'No procedure found on path "workers.register"', 'NOT_FOUND'),
		);
		await expect(
			api.mutate('workers.register', { ownerIdentifier: 'ada' }, passthrough),
		).rejects.toThrow(/older build than your CLI/);
	});

	// A per-procedure NOT_FOUND is also HTTP 404; it must keep its own message.
	it('leaves a procedure NOT_FOUND as the message the procedure wrote', async () => {
		const { client: api } = client(trpcError(404, 'Worker with ID "w-1" not found', 'NOT_FOUND'));
		await expect(api.query('workers.getById', { workerId: 'w-1' }, passthrough)).rejects.toThrow(
			new OperatorApiError('Worker with ID "w-1" not found'),
		);
	});

	it('names version skew when /operator/trpc is not mounted at all', async () => {
		const { client: api } = client({ status: 404, unparseable: true });
		await expect(api.query('workers.list', undefined, passthrough)).rejects.toThrow(
			/does not serve \/operator\/trpc/,
		);
	});

	it('reports a refusal it cannot read as a bare status', async () => {
		const { client: api } = client({ status: 502, unparseable: true });
		await expect(api.query('workers.list', undefined, passthrough)).rejects.toThrow(
			'the control plane refused workers.list (HTTP 502)',
		);
	});

	it('throws on a success body that is not a tRPC envelope', async () => {
		const { client: api } = client({ status: 200, body: { workers: [] } });
		await expect(api.query('workers.list', undefined, passthrough)).rejects.toThrow(
			/unexpected response/,
		);
	});

	it('throws on a payload the caller schema rejects', async () => {
		const { client: api } = client(ok({ providerId: 42 }));
		await expect(
			api.query('workers.projectScmProvider', { projectId: 'p' }, (value) =>
				z.object({ providerId: z.string() }).parse(value),
			),
		).rejects.toThrow(/unexpected payload/);
	});

	it('collapses an unreachable control plane into one actionable line', async () => {
		const fetchImpl: FetchLike = async () => {
			throw new Error('connect ECONNREFUSED 127.0.0.1:3000');
		};
		const api = createOperatorClient({ controlPlaneUrl: CONTROL_PLANE, token: TOKEN, fetchImpl });
		await expect(api.query('workers.list', undefined, passthrough)).rejects.toThrow(
			/could not reach the control plane at https:\/\/swarm\.example\.com/,
		);
	});
});

describe('requireOperatorSession', () => {
	const ORIGINAL = process.env.SWARM_CONTROL_PLANE_URL;

	afterEach(() => {
		if (ORIGINAL === undefined) delete process.env.SWARM_CONTROL_PLANE_URL;
		else process.env.SWARM_CONTROL_PLANE_URL = ORIGINAL;
		readOperatorSessionCache.mockReset();
	});

	it('resolves the control plane and the cached token', () => {
		process.env.SWARM_CONTROL_PLANE_URL = CONTROL_PLANE;
		readOperatorSessionCache.mockReturnValue({
			controlPlaneUrl: CONTROL_PLANE,
			token: TOKEN,
			userId: 'user-1',
			identifier: 'ada@example.com',
			expiresAt: '2026-09-04T00:00:00.000Z',
			createdAt: '2026-08-28T00:00:00.000Z',
		});
		expect(requireOperatorSession()).toEqual({
			session: { controlPlaneUrl: CONTROL_PLANE, token: TOKEN, identifier: 'ada@example.com' },
		});
	});

	it('fails with one line when SWARM_CONTROL_PLANE_URL is unset', () => {
		delete process.env.SWARM_CONTROL_PLANE_URL;
		expect(requireOperatorSession()).toEqual({
			error: expect.stringContaining('SWARM_CONTROL_PLANE_URL is unset'),
		});
		expect(readOperatorSessionCache).not.toHaveBeenCalled();
	});

	it('rejects a control-plane URL that is not http(s)', () => {
		process.env.SWARM_CONTROL_PLANE_URL = 'ftp://swarm.example.com';
		expect(requireOperatorSession()).toEqual({
			error: expect.stringContaining('must be an http(s) URL'),
		});
		process.env.SWARM_CONTROL_PLANE_URL = 'not a url';
		expect(requireOperatorSession()).toEqual({
			error: expect.stringContaining('is not a valid URL'),
		});
	});

	it('points an operator with no cached session at `swarm login`', () => {
		process.env.SWARM_CONTROL_PLANE_URL = CONTROL_PLANE;
		readOperatorSessionCache.mockReturnValue(null);
		expect(requireOperatorSession()).toEqual({ error: 'not signed in — run `swarm login`' });
	});

	// An unreadable entry is a different problem from an absent one, and says so.
	it('names the unreadable cache file rather than claiming no session', () => {
		process.env.SWARM_CONTROL_PLANE_URL = CONTROL_PLANE;
		readOperatorSessionCache.mockReturnValue(undefined);
		expect(requireOperatorSession()).toEqual({
			error: expect.stringContaining('could not be read'),
		});
	});
});
