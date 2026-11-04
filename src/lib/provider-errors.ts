/**
 * Provider-neutral recognition of an SCM/PM provider's own passing trouble
 * (issue #1274).
 *
 * A provider that answers a call with a server error — an HTTP 5xx, or GitHub's
 * GraphQL "Something went wrong while executing your query" — has an outage, not a
 * quarrel with the run. Every phase failure classifier reads this module's one rule
 * (`handlePhaseFailure` in `../worker/consumer.ts`, `classifyDeferrable` in
 * `../transport/assignment-execution.ts`), so a provider outage anywhere in a phase
 * defers instead of failing terminally, and a 4xx refusal (authentication,
 * permission, a missing resource) stays terminal by construction.
 *
 * Imports nothing but `./errors.js`: the DB-free worker loads it.
 */

import { describeError } from './errors.js';

/**
 * A provider (SCM or PM) answered with a server-side failure that carries no HTTP
 * status of its own: GitHub's GraphQL internal error arrives on an HTTP 200, and a
 * federated worker learns of a provider outage only from the control plane's
 * delivery answer. Raised so the failure classifiers recognise it structurally
 * instead of by its wording.
 */
export class ProviderUnavailableError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'ProviderUnavailableError';
	}
}

/** Whether a numeric `status` on the error is an HTTP server error (5xx). */
function hasServerErrorStatus(err: Error): boolean {
	const status = (err as { status?: unknown }).status;
	return typeof status === 'number' && status >= 500 && status <= 599;
}

/**
 * Whether this failure — or any failure it wraps — is a provider server error: a
 * {@link ProviderUnavailableError}, or an error carrying a numeric HTTP `status` in
 * 500–599 (Octokit's `RequestError`, and every other provider client's `*ApiError`).
 * A 4xx never matches. Walks the `cause` chain as `describeError` does, so wrapping
 * the provider's error on the way out of a call site keeps it recognisable.
 */
export function isProviderServerError(err: unknown): boolean {
	const seen = new Set<unknown>();
	let current: unknown = err;
	while (current instanceof Error && !seen.has(current)) {
		if (current instanceof ProviderUnavailableError || hasServerErrorStatus(current)) return true;
		seen.add(current);
		current = current.cause;
	}
	return false;
}

/** Longest provider text carried into a run's error or a delivery answer. */
const MAX_PROVIDER_TEXT = 300;

const PREFIX = 'Provider unavailable';

/**
 * The operator-facing text for a provider server error: `Provider unavailable: <the
 * provider's own message>`, so a run row reads as a provider outage rather than as
 * SWARM's own fault. Sanitised because an nginx 502 body can be a whole HTML page:
 * tags are stripped, whitespace collapsed, and the text truncated. A text that
 * already says it is a provider outage (one relayed by the control plane) is not
 * prefixed again.
 */
export function describeProviderUnavailable(err: unknown): string {
	const text = describeError(err)
		.replace(/<[^>]*>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	const bounded =
		text.length > MAX_PROVIDER_TEXT ? `${text.slice(0, MAX_PROVIDER_TEXT - 1)}…` : text;
	if (/provider unavailable/i.test(bounded)) return bounded;
	return bounded.length > 0 ? `${PREFIX}: ${bounded}` : PREFIX;
}
