/**
 * Worker-side HTTP client for the control-plane **metadata delivery API**
 * (ADR-004 §2, `../router/worker-delivery.ts`). One place owns the wire details
 * every `POST /worker/delivery/*` call shares: the base-URL join, the
 * `Authorization: Bearer <credential>` header, the protocol-version stamp, and
 * the error contract (a non-2xx or unparseable body **throws**, so a caller
 * behaves exactly as it would on a failed in-process write).
 *
 * Three callers use it: the SCM metadata delegate (`../scm/transport-delivery.ts`),
 * the PM metadata delegate (`../pm/transport-delivery.ts`), and the DB-free
 * executor that builds both for a pushed assignment (`./assignment-execution.ts`).
 * They differ only in the route they POST to and the response they parse, so the
 * transport itself lives here rather than being copied per delegate.
 *
 * Imports no database, queue, or GitHub client — a DB-free remote worker
 * (`./connect-entry.ts`) loads this module and nothing else to deliver metadata.
 * The raw worker credential appears only in the request header: never in a URL,
 * never logged, never in an error message.
 */

import { TRANSPORT_PROTOCOL_VERSION } from './protocol.js';

/** The `fetch` surface this module uses — injectable so tests drive it without a network. */
export type FetchLike = (
	input: string,
	init: {
		method: string;
		headers: Record<string, string>;
		body: string;
	},
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** What every delivery call needs to reach the control plane and authenticate. */
export interface DeliveryClientOptions {
	/** Base URL of the control-plane delivery API, e.g. `https://swarm.example`. */
	controlPlaneUrl: string;
	/** Raw registered-worker credential (sent as `Authorization: Bearer`). */
	workerCredential: string;
	/** Override `fetch` in tests; defaults to the global. */
	fetchImpl?: FetchLike;
}

/** Join the control-plane base URL with a delivery path, tolerating a trailing slash. */
export function deliveryUrl(base: string, path: string): string {
	return `${base.replace(/\/+$/, '')}${path}`;
}

/**
 * The message for a non-2xx delivery response, carrying the server's own `reason`
 * when it sent one.
 *
 * Every refusal this API returns names its cause in that field — an unresolvable
 * persona credential, an unenrolled worker, an unknown project — and without it a
 * worker's log and the run's failure comment show only a bare status code, leaving
 * the actionable cause visible solely in the router's logs. The body is read
 * defensively: a refusal with no body, or one this client cannot parse, still
 * throws the plain status message rather than masking the failure.
 */
async function failureMessage(
	path: string,
	response: { status: number; json: () => Promise<unknown> },
): Promise<string> {
	const base = `Control-plane delivery ${path} failed with status ${response.status}`;
	// A 404 on a delivery route is the one failure whose cause is a *deployment*
	// rather than a request: the route does not exist on that control plane, so this
	// daemon is running a newer build than the server it is enrolled with. Nothing
	// upstream catches it — `TRANSPORT_PROTOCOL_VERSION` is bumped only when a frame
	// changes shape (`./protocol.ts`), deliberately, since bumping it would reject
	// every already-deployed worker at the handshake. So a route added in a later
	// release reaches an older control plane as a bare 404, and without naming the
	// cause an operator sees only a status code for what is a one-line fix.
	if (response.status === 404) {
		return (
			`${base}. This control plane does not serve that route, which means it is ` +
			'running an older build than this worker — update the control plane, or run a ' +
			'daemon matching it.'
		);
	}
	try {
		const body = await response.json();
		const reason =
			typeof body === 'object' && body !== null ? (body as { reason?: unknown }).reason : undefined;
		return typeof reason === 'string' && reason.length > 0 ? `${base}: ${reason}` : base;
	} catch {
		return base;
	}
}

/**
 * POST a delivery request to the control plane and return its parsed response
 * body. `parse` validates the payload (a Zod schema's `parse`), so a malformed
 * body is a throw rather than a silently-wrong value.
 *
 * Throws on a non-2xx status, an unreadable body, or a parse failure — the
 * caller's existing failed-write handling (a best-effort skip, or the
 * `DeliveryDeferredError` retry that preserves the worktree) then applies
 * unchanged. A refusal's thrown message carries the server's `reason`
 * ({@link failureMessage}) so the cause reaches the worker's log and the run's
 * failure comment. The server-side writes are marker-idempotent, so a retried call
 * cannot double-post.
 */
export async function postDelivery<T>(
	options: DeliveryClientOptions,
	path: string,
	body: Record<string, unknown>,
	parse: (value: unknown) => T,
): Promise<T> {
	const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
	const response = await fetchImpl(deliveryUrl(options.controlPlaneUrl, path), {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization: `Bearer ${options.workerCredential}`,
		},
		body: JSON.stringify({ ...body, protocolVersion: TRANSPORT_PROTOCOL_VERSION }),
	});
	if (!response.ok) throw new Error(await failureMessage(path, response));
	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new Error(
			`Control-plane delivery ${path} returned an unparseable response: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
	return parse(payload);
}
