/**
 * CLI-side HTTP client for the control-plane **operator API** (issue #800) — the
 * `/operator/trpc/*` mount `../../router/operator-api.ts` serves and the bearer
 * `swarm login` caches (`./operator-session-cache.ts`, issue #798) authenticates.
 *
 * One place owns the wire details every operator call shares, the same role
 * `../../transport/delivery-client.ts` plays for the worker daemon: the base-URL
 * join, the `Authorization: Bearer` header, an injectable `fetch`, and an error
 * contract where a non-2xx or unparseable body **throws** carrying the server's own
 * message.
 *
 * **It speaks tRPC's HTTP protocol directly**, rather than depending on
 * `@trpc/client`: the CLI is "a small, dependency-free dispatcher"
 * (`../index.ts`), and `../../api/trpc.ts` configures **no data transformer**, so
 * the wire format is plain JSON with nothing to deserialize:
 *
 * - query → `GET <base>/operator/trpc/<path>?input=<encodeURIComponent(JSON)>`,
 *   with `input` omitted when there is none
 * - mutation → `POST <base>/operator/trpc/<path>` with the raw input as the JSON
 *   body and an explicit `content-type: application/json` — `@hono/trpc-server`'s
 *   non-batch POST path answers `UNSUPPORTED_MEDIA_TYPE` without it (its GET path
 *   falls back to JSON regardless of headers; POST does not)
 * - success → `{ result: { data } }`; failure → `{ error: { message, data: { code } } }`
 *
 * Every response is validated with a Zod schema (`ai/CODING_STANDARDS.md`) — the
 * envelope here, the payload by the caller's own `parse` — so a control plane
 * answering something else is a throw rather than a silently-wrong value. The
 * schemas are declared here and deliberately not imported from the router: pulling
 * `../../api/operator-router.ts` in would drag `../../db/*` into a CLI whose whole
 * point is holding no `DATABASE_URL`.
 *
 * The session token appears only in the request header — never in a URL, never
 * printed, never in an error message.
 */

import { z } from 'zod';
import {
	type OperatorSessionCache,
	operatorSessionCachePath,
	readOperatorSessionCache,
} from './operator-session-cache.js';

const CONTROL_PLANE_ENV = 'SWARM_CONTROL_PLANE_URL';

/**
 * The path the operator API is mounted under, stated here rather than imported
 * from `../../router/operator-api.ts` — that module pulls the whole tRPC router,
 * and with it the database, into this process. `OPERATOR_TRPC_ENDPOINT` there is
 * the other half of the same constant; they must agree.
 */
const OPERATOR_TRPC_PATH = '/operator/trpc';

/** Long enough for a loaded control plane, short enough to fail rather than hang — as `commands/login.ts`. */
const REQUEST_TIMEOUT_MS = 30_000;

/** The `fetch` surface this module uses — injectable so tests drive it without a network. */
export type FetchLike = (
	input: string,
	init: {
		method: string;
		headers: Record<string, string>;
		body?: string;
		signal?: AbortSignal;
	},
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/** What every operator call needs to reach the control plane and authenticate. */
export interface OperatorClientOptions {
	/** Base URL of the control plane, e.g. `https://swarm.example.com` (a trailing slash is fine). */
	controlPlaneUrl: string;
	/** The opaque session token `swarm login` cached (sent as `Authorization: Bearer`). */
	token: string;
	/** Override `fetch` in tests; defaults to the global. */
	fetchImpl?: FetchLike;
}

/** The two call shapes the operator API offers, sharing everything but the HTTP verb. */
export interface OperatorClient {
	query<T>(path: string, input: unknown, parse: (value: unknown) => T): Promise<T>;
	mutate<T>(path: string, input: unknown, parse: (value: unknown) => T): Promise<T>;
}

/**
 * The success envelope. `data` is `z.unknown()` because only the caller knows the
 * procedure's own shape; it validates the payload with its own schema.
 */
const TrpcSuccessSchema = z.object({ result: z.object({ data: z.unknown() }) });

/**
 * The failure envelope. `data` is optional and non-strict: a control plane with its
 * own error formatter may carry more (or less) than `code`, and a missing one only
 * means the message is all this client can say.
 */
const TrpcErrorSchema = z.object({
	error: z.object({
		message: z.string(),
		data: z.object({ code: z.string().optional() }).optional(),
	}),
});

/** Join the control-plane base URL with an operator-API procedure path, tolerating a trailing slash. */
export function operatorUrl(base: string, procedurePath: string): string {
	return `${base.replace(/\/+$/, '')}${OPERATOR_TRPC_PATH}/${procedurePath}`;
}

/**
 * A call the control plane refused, could not be reached for, or answered
 * unintelligibly — always carrying a message written for the operator rather than
 * for a stack trace.
 *
 * A distinct type so a subcommand can print it and exit 1 while a genuine
 * programming error still crashes: the CLI's existing shape, where the typed
 * service rejections were caught by name and everything else rethrown.
 */
export class OperatorApiError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'OperatorApiError';
	}
}

/**
 * The message a failed call throws, preferring the **server's own** wording so an
 * operator reads the refusal the control plane actually made rather than a status
 * code. Three cases get help the server cannot give:
 *
 * - `UNAUTHORIZED` is the one refusal with a fixed remedy, and the token is opaque
 *   here, so this client cannot tell an expired session from a revoked one — the
 *   answer is the same command either way.
 * - A tRPC "no procedure found" is a *deployment* mismatch, not a request error:
 *   the CLI called something this control plane does not serve.
 * - A 404 with no tRPC envelope at all means `/operator/trpc` is not mounted —
 *   the same skew, one release earlier.
 */
function failureMessage(procedurePath: string, status: number, body: unknown): string {
	const failure = TrpcErrorSchema.safeParse(body);
	if (failure.success) {
		const { message, data } = failure.data.error;
		if (data?.code === 'UNAUTHORIZED') {
			return 'your control-plane session has expired — run `swarm login`';
		}
		if (/^No procedure found on path/i.test(message)) {
			return `${message} — this control plane is running an older build than your CLI; update it, or run a CLI matching it`;
		}
		return message;
	}
	if (status === 404) {
		return (
			`the control plane does not serve ${OPERATOR_TRPC_PATH}, which means it is running an ` +
			'older build than your CLI — update the control plane, or run a CLI matching it'
		);
	}
	return `the control plane refused ${procedurePath} (HTTP ${status})`;
}

/**
 * One operator-API call. Throws on an unreachable control plane, a non-2xx status,
 * an unreadable body, or a payload the caller's `parse` rejects — the calling
 * subcommand prints the message and exits 1, so every refusal reaches the operator
 * as one line rather than a stack trace.
 */
async function call<T>(
	options: OperatorClientOptions,
	method: 'GET' | 'POST',
	procedurePath: string,
	input: unknown,
	parse: (value: unknown) => T,
): Promise<T> {
	const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
	const url = operatorUrl(options.controlPlaneUrl, procedurePath);
	// A query carries its input in the query string, a mutation in the body — the
	// only difference between the two verbs on the wire.
	const isQuery = method === 'GET';
	const encoded = input === undefined ? undefined : JSON.stringify(input);
	const headers: Record<string, string> = { authorization: `Bearer ${options.token}` };
	if (!isQuery) headers['content-type'] = 'application/json';

	let response: { ok: boolean; status: number; json: () => Promise<unknown> };
	try {
		response = await fetchImpl(
			isQuery && encoded !== undefined ? `${url}?input=${encodeURIComponent(encoded)}` : url,
			{
				method,
				headers,
				body: isQuery ? undefined : (encoded ?? '{}'),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			},
		);
	} catch {
		// Every transport failure collapses into one actionable line, exactly as
		// `commands/login.ts` does — a stack trace names nothing an operator can fix.
		throw new OperatorApiError(
			`could not reach the control plane at ${options.controlPlaneUrl} (is it running, and is ${CONTROL_PLANE_ENV} right?)`,
		);
	}

	// The body is read before the status is judged: a tRPC refusal carries its own
	// message there, and that message is the whole point of surfacing the failure.
	const body = await response.json().catch(() => undefined);
	if (!response.ok) {
		throw new OperatorApiError(failureMessage(procedurePath, response.status, body));
	}

	const envelope = TrpcSuccessSchema.safeParse(body);
	if (!envelope.success) {
		throw new OperatorApiError(
			`the control plane answered ${procedurePath} with an unexpected response (is it running a different version?)`,
		);
	}
	try {
		return parse(envelope.data.result.data);
	} catch (error) {
		// A payload this CLI cannot read is the same class of problem as an
		// unintelligible envelope — a control plane answering a shape it does not
		// share — so it reaches the operator as one line, not a Zod dump.
		throw new OperatorApiError(
			`the control plane answered ${procedurePath} with an unexpected payload (is it running a different version?): ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

/** Build a client bound to one control plane and one session token. */
export function createOperatorClient(options: OperatorClientOptions): OperatorClient {
	return {
		query: (procedurePath, input, parse) => call(options, 'GET', procedurePath, input, parse),
		mutate: (procedurePath, input, parse) => call(options, 'POST', procedurePath, input, parse),
	};
}

/** A resolved operator session — the control plane to call and the token to call it with. */
export interface OperatorSession {
	controlPlaneUrl: string;
	token: string;
	/** The login handle the token resolved to when it was minted, for messages that name the caller. */
	identifier: string;
}

/**
 * `SWARM_CONTROL_PLANE_URL` plus the cached `swarm login` session, or the single
 * actionable line explaining which of the two is missing. The token is not
 * re-validated here — it is opaque to this process, and the first call spends it,
 * which is what turns an expired one into {@link failureMessage}'s "run
 * `swarm login`".
 */
export function requireOperatorSession(): { session: OperatorSession } | { error: string } {
	const raw = process.env[CONTROL_PLANE_ENV]?.trim();
	if (!raw) {
		return {
			error: `${CONTROL_PLANE_ENV} is unset — point it at this installation's router (e.g. https://swarm.example.com)`,
		};
	}
	let base: URL;
	try {
		base = new URL(raw);
	} catch {
		return { error: `${CONTROL_PLANE_ENV} is not a valid URL: '${raw}'` };
	}
	if (base.protocol !== 'http:' && base.protocol !== 'https:') {
		return { error: `${CONTROL_PLANE_ENV} must be an http(s) URL, got '${raw}'` };
	}

	// `null` (nothing cached) and `undefined` (unreadable) are different problems,
	// reported as such — the same split `commands/login.ts` makes.
	const cached: OperatorSessionCache | null | undefined = readOperatorSessionCache(raw);
	if (cached === null) return { error: 'not signed in — run `swarm login`' };
	if (cached === undefined) {
		return {
			error: `the cached session at ${operatorSessionCachePath(raw)} could not be read — run \`swarm login\` to replace it`,
		};
	}
	return {
		session: { controlPlaneUrl: raw, token: cached.token, identifier: cached.identifier },
	};
}
