/**
 * Resolve SWARM's own public callback URL for an inbound webhook route — the
 * value a provider that signs `HMAC(rawBody + callbackUrl)` must be handed to
 * verify a delivery at all (Trello; see `PmWebhookVerification.callbackUrl`,
 * `src/integrations/pm/manifest.ts`).
 *
 * A separate module, like Cascade's `src/router/webhookVerification.ts`
 * (`buildTrelloCallbackUrl`, the precedent this ports), so it can be imported and
 * tested without pulling in the receiver's collaborators.
 *
 * Order of preference, and why:
 *
 * 1. `WEBHOOK_CALLBACK_BASE_URL` (`src/lib/env.ts`). Authoritative: it is the same
 *    base URL the provider's webhook subscription was registered with, so the
 *    signed string matches by construction.
 * 2. The request's own `Host` + `X-Forwarded-Proto`. A convenience for the common
 *    tunnel setup where those headers already carry the public hostname — but they
 *    are caller-controlled and a proxy that rewrites `Host` makes them silently
 *    wrong, which is why they are the fallback rather than the source.
 *
 * With neither available the derived URL would be `https://undefined<route>` and
 * every verification against it would fail as a bare 401, so this warns naming the
 * setting (Cascade's diagnostic) and continues rather than throwing: the providers
 * whose schemes ignore the callback URL — GitHub Projects' shared HMAC among them —
 * must keep verifying normally.
 */

import { resolveWebhookCallbackBaseUrl } from '../lib/env.js';
import { logger } from '../lib/logger.js';

/**
 * Build the absolute public URL `route` is served on.
 *
 * @param route The mounted webhook path, e.g. `/github/webhook`.
 * @param header Case-insensitive reader over the inbound request's headers
 *   (Hono's `c.req.header`), the same shape a provider's own header reading takes.
 */
export function resolveWebhookCallbackUrl(
	route: string,
	header: (name: string) => string | undefined,
): string {
	const base = resolveWebhookCallbackBaseUrl();
	if (base) return `${base}${route}`;

	const host = header('host');
	if (!host) {
		logger.warn(
			"Host header is missing and WEBHOOK_CALLBACK_BASE_URL is not set; a provider that signs its own callback URL cannot verify this delivery. Set WEBHOOK_CALLBACK_BASE_URL to SWARM's public base URL.",
			{ route },
		);
	}

	return `${header('x-forwarded-proto') ?? 'https'}://${host}${route}`;
}
