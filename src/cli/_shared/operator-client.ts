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
	isValidWorkerId,
	readWorkerProfile,
	workerProfilePath,
} from '../../launcher/worker-profile.js';
import { CONTROL_PLANE_ENV, resolveControlPlaneUrl } from './control-plane-env.js';
import {
	normalizeControlPlaneUrl,
	type OperatorSessionCache,
	operatorSessionCachePath,
	readOperatorSessionCache,
} from './operator-session-cache.js';

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
 *   answer is the same command either way. It names the control plane, since a
 *   session that "expired" on the wrong installation was never valid there.
 * - A tRPC "no procedure found" is a *deployment* mismatch, not a request error:
 *   the CLI called something this control plane does not serve.
 * - A 404 with no tRPC envelope at all means `/operator/trpc` is not mounted —
 *   the same skew, one release earlier.
 */
function failureMessage(
	controlPlaneUrl: string,
	procedurePath: string,
	status: number,
	body: unknown,
): string {
	const failure = TrpcErrorSchema.safeParse(body);
	if (failure.success) {
		const { message, data } = failure.data.error;
		if (data?.code === 'UNAUTHORIZED') {
			return `your control-plane session at ${controlPlaneUrl} has expired — run \`swarm login\``;
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
		throw new OperatorApiError(
			failureMessage(options.controlPlaneUrl, procedurePath, response.status, body),
		);
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

/** What {@link requireOperatorSession} is told about the command asking. */
export interface RequireOperatorSessionOptions {
	/**
	 * The worker the command acts on (issue #1296). When this machine holds a
	 * profile for it (`../../launcher/worker-profile.ts`), the profile names the
	 * installation — not this checkout's `.env`.
	 */
	workerId?: string;
	/** The command's own `--control-plane-url`, for the commands that take one. */
	controlPlaneUrl?: string;
}

/**
 * The control-plane URL — resolved by the precedence every `swarm` command shares
 * (`./control-plane-env.ts`: a `--control-plane-url` the caller passes, the
 * environment, then this checkout's `.env`) — plus the cached `swarm login`
 * session, or the single actionable line explaining which of the two is missing.
 * The token is not re-validated here — it is opaque to this process, and the
 * first call spends it, which is what turns an expired one into
 * {@link failureMessage}'s "run `swarm login`".
 *
 * **A profile worker answers for itself** (issue #1296). Given a `workerId` this
 * machine holds a profile for, the profile's URL is used ahead of everything
 * above: a profile worker serves the installation it was registered on, whichever
 * clone the operator happens to be standing in. An explicit flag or exported
 * `SWARM_CONTROL_PLANE_URL` naming a *different* installation is refused with both
 * URLs named, rather than either one quietly winning — `.env` is not an explicit
 * choice and is simply not consulted. With no profile for the worker, nothing
 * here changes.
 */
export function requireOperatorSession(
	options: RequireOperatorSessionOptions = {},
): { session: OperatorSession } | { error: string } {
	const resolved = resolveSessionUrl(options);
	if ('error' in resolved) return resolved;
	const { url: raw, login } = resolved;

	// `null` (nothing cached) and `undefined` (unreadable) are different problems,
	// reported as such — the same split `commands/login.ts` makes.
	const cached: OperatorSessionCache | null | undefined = readOperatorSessionCache(raw);
	if (cached === null) return { error: `not signed in to ${raw} — run \`${login}\`` };
	if (cached === undefined) {
		return {
			error: `the cached session at ${operatorSessionCachePath(raw)} could not be read — run \`${login}\` to replace it`,
		};
	}
	return {
		session: { controlPlaneUrl: raw, token: cached.token, identifier: cached.identifier },
	};
}

/**
 * The URL a session is read for, and the `swarm login` that would create one
 * there. The bare `swarm login` is named only when the shared precedence chose
 * the URL without a flag, since that is the URL a bare login resolves too.
 */
function resolveSessionUrl(
	options: RequireOperatorSessionOptions,
): { url: string; login: string } | { error: string } {
	const profiled = profileControlPlaneUrl(options);
	if (profiled !== null) return profiled;

	const resolved = resolveControlPlaneUrl(options.controlPlaneUrl);
	if ('error' in resolved) return { error: resolved.error };
	return {
		url: resolved.url,
		login:
			resolved.source === 'flag'
				? `swarm login --control-plane-url ${resolved.url}`
				: 'swarm login',
	};
}

/**
 * The installation a worker's local profile names, `null` when this machine holds
 * no profile for it, or the refusal: an unreadable profile, or an explicit
 * override that names another installation.
 */
function profileControlPlaneUrl(
	options: RequireOperatorSessionOptions,
): { url: string; login: string } | { error: string } | null {
	const { workerId } = options;
	// A worker id no profile could be stored under has no profile.
	if (workerId === undefined || !isValidWorkerId(workerId)) return null;
	const profile = readWorkerProfile(workerId);
	if (profile === null) return null;
	const path = workerProfilePath(workerId);
	if (profile === undefined) {
		return {
			error: `worker ${workerId}'s profile at ${path} could not be read, so which installation it serves is unknown — repair or remove it`,
		};
	}

	const url = profile.controlPlaneUrl;
	const overrides = [
		{ value: options.controlPlaneUrl, origin: '--control-plane-url', remedy: 'drop it' },
		{
			value: process.env[CONTROL_PLANE_ENV],
			origin: CONTROL_PLANE_ENV,
			remedy: `unset ${CONTROL_PLANE_ENV}`,
		},
	];
	for (const { value, origin, remedy } of overrides) {
		const requested = value?.trim();
		if (requested && normalizeControlPlaneUrl(requested) !== url) {
			return {
				error: `worker ${workerId} serves ${url} (its profile, ${path}), but ${origin} names ${requested} — ${remedy} to act on this worker`,
			};
		}
	}
	return { url, login: `swarm login --control-plane-url ${url}` };
}
