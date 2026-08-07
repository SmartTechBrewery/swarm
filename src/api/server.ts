/**
 * API server entry point — a self-hosted single-process Hono app
 * (ai/ARCHITECTURE.md). Exposes /health, the /auth/login + /auth/logout session
 * endpoints, mounts tRPC at /trpc, and (in a same-origin deploy) serves the
 * built dashboard SPA from `dashboard/dist`. Unlike Cascade's split cloud
 * deployment (separate API + Cloudflare Pages frontend), SWARM runs one process
 * for its local-first scope.
 *
 * Access control is per-user session auth (#281 task 2), not the old shared
 * `DASHBOARD_TOKEN` bearer secret: a user logs in with their password, gets an
 * opaque session delivered as an HTTP-only cookie, and every `/trpc/*` procedure
 * except `ping` runs as `authedProcedure` — the tRPC context resolves the caller
 * from that cookie. The raw token is never returned in a body or logged; only its
 * hash is stored (`src/identity/auth.ts`).
 *
 * A credentialed CORS layer (`src/lib/cors.ts`) fronts every route so the
 * documented separate-origin dev workflow (SPA on Vite, API on `API_PORT`)
 * can send the session cookie; a same-origin deploy never pre-flights, so it is
 * inert there. See `CORS_ORIGIN` in `docs/configuration.md`.
 */
import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { trpcServer } from '@hono/trpc-server';
import { type Context, Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { CookieOptions } from 'hono/utils/cookie';
import { z } from 'zod';
import {
	createSession,
	resolveSession,
	resolveSingleUser,
	revokeSession,
	verifyCredentials,
} from '../identity/auth.js';
import type { SwarmUser } from '../identity/schema.js';
import { buildCorsMiddleware } from '../lib/cors.js';
import { isSingleUserMode } from '../lib/env.js';
import { configureLogger, logger } from '../lib/logger.js';
import { startHostMaintenance } from './maintenance.js';
import { appRouter } from './router.js';
import type { TrpcContext } from './trpc.js';

/** Name of the HTTP-only cookie carrying the opaque session token. */
export const SESSION_COOKIE_NAME = 'swarm_session';

const LoginInputSchema = z.object({
	identifier: z.string().min(1),
	password: z.string().min(1),
});

/**
 * Whether the request targets a loopback host. The session cookie is marked
 * `Secure` for everything else (a Secure cookie is dropped by browsers over
 * plain HTTP, which is exactly the localhost dev case we must not break). The
 * host comes from the request URL, which `@hono/node-server` builds from the
 * incoming `Host` header.
 */
function isLocalhostRequest(c: Context): boolean {
	let hostname: string;
	try {
		hostname = new URL(c.req.url).hostname.toLowerCase();
	} catch {
		return false;
	}
	return (
		hostname === 'localhost' ||
		hostname === '127.0.0.1' ||
		hostname === '::1' ||
		hostname === '[::1]'
	);
}

/** Shared cookie attributes for the session cookie — HTTP-only, SameSite=Strict. */
function sessionCookieOptions(c: Context): CookieOptions {
	return {
		httpOnly: true,
		sameSite: 'Strict',
		secure: !isLocalhostRequest(c),
		path: '/',
	};
}

export function createApiApp(
	options: { staticRoot?: string; corsOrigin?: string; singleUserMode?: boolean } = {},
): Hono {
	const app = new Hono();

	// Resolve the single-user policy once per app instance (test override follows
	// the `corsOrigin` pattern). When enabled, tRPC requests resolve the
	// bootstrapped local admin instead of a session cookie (issue #298).
	const singleUserMode = options.singleUserMode ?? isSingleUserMode();
	// The bootstrapped admin, ensured lazily on the first tRPC request and cached
	// for the app's lifetime so single-user requests don't hit the DB every call.
	let singleUser: SwarmUser | undefined;

	// Credentialed CORS for the documented separate-origin dev setup; inert for a
	// same-origin deploy (which never pre-flights). Must run before every route so
	// pre-flight OPTIONS on /auth/* and /trpc/* are answered (`src/lib/cors.ts`).
	app.use(
		'*',
		buildCorsMiddleware({ corsOriginEnv: options.corsOrigin ?? process.env.CORS_ORIGIN }),
	);

	app.get('/health', (c) =>
		c.json({
			status: 'ok',
			service: 'swarm-api',
			timestamp: new Date().toISOString(),
		}),
	);

	// Log in: verify credentials, mint a session, and deliver the opaque token as
	// an HTTP-only cookie. The body carries only the public SwarmUser (no token,
	// no hash) so the SPA can prime its "who am I" state.
	app.post('/auth/login', async (c) => {
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: 'Bad Request', reason: 'Expected a JSON body' }, 400);
		}
		const parsed = LoginInputSchema.safeParse(body);
		if (!parsed.success) {
			return c.json({ error: 'Bad Request', reason: 'identifier and password are required' }, 400);
		}

		const user = await verifyCredentials(parsed.data.identifier, parsed.data.password);
		if (!user) {
			return c.json({ error: 'Unauthorized', reason: 'Invalid credentials' }, 401);
		}

		const session = await createSession(user.id);
		setCookie(c, SESSION_COOKIE_NAME, session.token, {
			...sessionCookieOptions(c),
			expires: session.expiresAt,
		});
		return c.json({ user });
	});

	// Log out: revoke the session server-side and clear the cookie. Idempotent —
	// a request with no (or an unknown) session still clears the cookie and 200s.
	app.post('/auth/logout', async (c) => {
		const token = getCookie(c, SESSION_COOKIE_NAME);
		if (token) {
			await revokeSession(token);
		}
		deleteCookie(c, SESSION_COOKIE_NAME, sessionCookieOptions(c));
		return c.json({ ok: true });
	});

	app.use(
		'/trpc/*',
		trpcServer({
			endpoint: '/trpc',
			router: appRouter,
			createContext: async (_opts, c): Promise<TrpcContext> => {
				// Single-user mode: supply the bootstrapped local admin as the caller
				// even with no session cookie. The cookie flow below is never consulted,
				// so a local install needs no /login, password, or swarm_session cookie.
				if (singleUserMode) {
					singleUser ??= await resolveSingleUser();
					return { user: singleUser };
				}
				const token = getCookie(c, SESSION_COOKIE_NAME);
				const user = token ? await resolveSession(token) : undefined;
				return { user: user ?? null };
			},
		}),
	);

	const staticRoot = options.staticRoot ?? './dashboard/dist';
	if (existsSync(`${staticRoot}/index.html`)) {
		app.use('/assets/*', serveStatic({ root: staticRoot }));
		app.get('*', serveStatic({ root: staticRoot, rewriteRequestPath: () => '/index.html' }));
	}

	return app;
}

// Entrypoint bootstrap — only when executed directly, so tests can import the
// factory without binding a port (or starting the maintenance timers below —
// they belong to the process, not to the app). Mirrors src/router/index.ts.
if (import.meta.url === `file://${process.argv[1]}`) {
	configureLogger({ component: 'api' });
	const port = Number(process.env.API_PORT ?? 3101);
	const app = createApiApp();
	// Control-plane host maintenance (issue #550): the orphaned-run reap, CLI quota
	// discovery, and the worktree retention sweep. This process is the one on the
	// control-plane host that has all three of `DATABASE_URL`, the operator's PATH,
	// and the repository checkout. A no-op in `in-process` dispatch mode, where the
	// host worker still reaches its own copies (`src/api/maintenance.ts`).
	const maintenance = startHostMaintenance();
	const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' }, () => {
		logger.debug('swarm-api: listening', { port, hostname: '127.0.0.1' });
	});
	for (const signal of ['SIGTERM', 'SIGINT'] as const) {
		process.on(signal, () =>
			server.close(() => {
				void Promise.resolve(maintenance?.close()).finally(() => process.exit(0));
			}),
		);
	}
}
