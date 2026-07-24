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
 * mode (ADR-002 §2): the metadata-only `submitReview`/`postComment` calls travel
 * to the router's server-side delivery API instead of running in-process. Unset
 * (the default, and every local host worker) keeps the in-process delivery path.
 */
export function getControlPlaneUrl(): string | undefined {
	const value = process.env.SWARM_CONTROL_PLANE_URL;
	return value === undefined || value.trim() === '' ? undefined : value.trim();
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
 * the selected connected worker (`../router/dispatcher.ts`), while the host worker
 * runs the transport-dispatch client (`../worker/transport-client.ts`) that
 * executes the pushed phase locally and reports results back. Any other value
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
