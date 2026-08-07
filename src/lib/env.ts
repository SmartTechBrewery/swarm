import { resolve } from 'node:path';

/**
 * Read a required environment variable, throwing if it is unset or empty.
 *
 * Missing required config is a programmer/deployment error, not a "not found"
 * lookup — so this throws rather than returning null (see ai/CODING_STANDARDS.md
 * "Error handling").
 */
export function requireEnv(name: string): string {
	const value = process.env[name];
	if (value === undefined || value === '') {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

/**
 * Read an optional environment variable, falling back to `fallback` when unset
 * or empty.
 */
export function optionalEnv(name: string, fallback: string): string {
	const value = process.env[name];
	return value === undefined || value === '' ? fallback : value;
}

/**
 * The control-plane base URL a federated worker POSTs SCM metadata delivery to
 * (`SWARM_CONTROL_PLANE_URL`), or `undefined` when unset/empty. Set together
 * with `SWARM_WORKER_CREDENTIAL` it opts a worker into control-plane delivery
 * mode (ADR-004 §2): the metadata-only `submitReview`/`postComment` calls travel
 * to the router's server-side delivery API instead of running in-process. Unset
 * (the default, and every local host worker) keeps the in-process delivery path.
 */
export function getControlPlaneUrl(): string | undefined {
	const value = process.env.SWARM_CONTROL_PLANE_URL;
	return value === undefined || value.trim() === '' ? undefined : value.trim();
}

/**
 * SWARM's own public base URL (`WEBHOOK_CALLBACK_BASE_URL`), or `undefined` when
 * unset/empty — the ingress half of the same value GitHub's webhook (and the
 * Cloudflare Tunnel serving it) is configured with, e.g.
 * `https://swarm.example.com`.
 *
 * Needed because a PM provider's signature scheme can cover SWARM's *own*
 * callback URL rather than the body alone: Trello signs
 * `HMAC(rawBody + callbackUrl)` (Cascade's `buildTrelloCallbackUrl`), so a
 * verifier that cannot name the URL the delivery arrived at cannot verify at all.
 * Deriving that URL from the request's own `Host` header works behind a
 * well-behaved proxy but is attacker-controlled and silently wrong behind one
 * that rewrites it, so this setting is the authoritative override
 * (`src/router/webhook-callback-url.ts` resolves the effective URL, warning when
 * neither is available).
 *
 * A trailing slash is trimmed so callers can concatenate a route path without
 * producing a double slash — the signed string must match the provider's byte for
 * byte.
 */
export function resolveWebhookCallbackBaseUrl(
	raw = process.env.WEBHOOK_CALLBACK_BASE_URL,
): string | undefined {
	const value = (raw ?? '').trim().replace(/\/+$/, '');
	return value === '' ? undefined : value;
}

/**
 * Whether SWARM's local single-user mode is enabled (`SWARM_SINGLE_USER_MODE`).
 *
 * A disabled-by-default API authentication policy for a local, single-operator
 * install (issue #298): when enabled the API resolves the bootstrapped
 * `localhost-admin` instead of requiring a dashboard session cookie. Only the
 * literal string `true` enables it — an unset, empty, or any other value keeps
 * the coded default (the existing multi-user, session-cookie behavior), so the
 * safe multi-user policy is what you get unless you opt in explicitly.
 */
export function isSingleUserMode(): boolean {
	return process.env.SWARM_SINGLE_USER_MODE === 'true';
}

/**
 * Resolve the worker operator's own GitHub token (`SWARM_OPERATOR_GH_TOKEN`).
 *
 * The DB-free remote worker (`../transport/connect-entry.ts`) has no persona
 * credentials — the assignment carries only the non-secret project slice, never
 * a token reference resolvable against a secret store. Instead, the
 * source-carrying operations (`commit`/`push`/`createPR`/`findPR`/`postComment`)
 * run as the **worker operator's own GitHub account** (ADR-003 §2: "the
 * implementer identity is the worker operator's own GitHub account … one token,
 * held only on their machine"). This reads that token from the operator's local
 * environment and never leaves the machine.
 *
 * Trimmed like the other worker env parsers; throws a clear config error when
 * unset or empty, so the remote worker fails fast at startup rather than
 * discovering the missing token mid-assignment.
 */
export function resolveOperatorGitHubToken(raw = process.env.SWARM_OPERATOR_GH_TOKEN): string {
	const value = (raw ?? '').trim();
	if (value === '') {
		throw new Error(
			"Missing required environment variable: SWARM_OPERATOR_GH_TOKEN (the remote worker operator's own GitHub token, used for source-carrying delivery)",
		);
	}
	return value;
}

/** Resolve the assigned repository checkout on the remote worker's own host. */
export function resolveWorkerRepoRoot(
	raw = process.env.SWARM_WORKER_REPO_ROOT,
	cwd = process.cwd(),
): string {
	const value = (raw ?? '').trim();
	return resolve(value === '' ? cwd : value);
}

/** How the host worker receives its work (`SWARM_DISPATCH_MODE`). */
export type DispatchMode = 'in-process' | 'transport';

/**
 * Resolve the dispatch mode (`SWARM_DISPATCH_MODE`, ADR-003 §2) — read by both the
 * router (`../router/index.ts`) and the host worker (`../worker/index.ts`).
 *
 * `in-process` (the default, and what an unset/empty value keeps) runs the BullMQ
 * consumer + `processJob` on the host worker; the router serves only webhooks +
 * the worker-session transport. `transport` relocates the consumer + eligibility
 * gate to the control plane: the router dequeues and pushes a `TaskAssignment` to
 * the selected connected worker (`../router/dispatcher.ts`), while every worker —
 * this host's included, over loopback — runs the DB-free transport entrypoint
 * (`../transport/connect-entry.ts`, issue #551) that executes the pushed phase
 * locally and reports results back. In that mode `../worker/index.ts` refuses to
 * start, so the queue has exactly one consumer. Any other value
 * fails startup loudly rather than silently falling back, mirroring the other env
 * parsers. Set it the same on both processes; default-off for backward
 * compatibility (an operator opts into the federated transport cutover).
 */
export function resolveDispatchMode(raw = process.env.SWARM_DISPATCH_MODE): DispatchMode {
	const value = (raw ?? '').trim();
	if (value === '' || value === 'in-process') return 'in-process';
	if (value === 'transport') return 'transport';
	throw new Error(`SWARM_DISPATCH_MODE must be 'in-process' or 'transport', got '${raw}'`);
}

/**
 * Refuse to continue unless the dispatch mode is `transport` — the mirror image
 * of `../worker/index.ts`'s own guard against the opposite mode. Called at the
 * top of `../transport/connect-entry.ts`'s `main()` (issue #551) so that entry
 * point is loud about the mode it does not serve too: without it, starting the
 * transport worker in the default `in-process` mode connects and heartbeats
 * successfully while no process consumes `swarm-jobs`, leaving every job
 * `waiting` with nothing to diagnose from.
 */
export function assertTransportDispatchMode(raw = process.env.SWARM_DISPATCH_MODE): void {
	if (resolveDispatchMode(raw) === 'transport') return;
	throw new Error(
		"SWARM_DISPATCH_MODE is 'in-process' (the default), which this transport entry point does not serve — refusing to start. Run this host's worker with `npm run dev:worker:legacy` (src/worker/index.ts) instead, or set SWARM_DISPATCH_MODE=transport on both the router and this host to use `npm run dev:worker` (src/transport/connect-entry.ts).",
	);
}
