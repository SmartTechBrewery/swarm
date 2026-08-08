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
 *
 * **That is the whole of its meaning** (issue #552). It briefly also bypassed the
 * federated dispatch gate (issue #373), which made one flag govern two unrelated
 * decisions and made the mode incompatible with `transport` dispatch — the
 * control plane has no local executor to fall back to, so the bypass left every
 * dispatch durably pending. Worker selection now has one rule for every
 * deployment: a single-user install registers and enrolls its one local worker
 * like anyone else (`docs/onboarding-worker.md`). The only reader is
 * `../api/server.ts`; nothing on the dispatch path may branch on it.
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
