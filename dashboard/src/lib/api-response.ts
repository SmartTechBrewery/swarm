/**
 * The dashboard's guard against a `/trpc` answer that did not come from the API
 * (issue #1051). While the API process restarts, whatever sits in front of it —
 * the Vite dev proxy, the Cloudflare tunnel — answers with its own error page, and
 * tRPC's client parsed that HTML as JSON, so a control reported
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON` instead of anything an
 * operator could act on.
 *
 * The API's tRPC handler answers every request as JSON, errors included, so a body
 * of any other type is not the API talking and is reported as the API being
 * unavailable.
 */

/** The operator-facing message for a response that did not come from the API. */
export function apiUnavailableMessage(status: number): string {
	return `API unavailable (HTTP ${status}) — it may be restarting. Try again in a moment.`;
}

/** Whether a response carries JSON, the only body the API's tRPC handler sends. */
export function isJsonResponse(response: Response): boolean {
	return (response.headers.get('content-type') ?? '').toLowerCase().includes('json');
}

/**
 * Pass an API response through, or throw {@link apiUnavailableMessage} in its
 * place. tRPC's client turns an error thrown by its `fetch` into the
 * `TRPCClientError` every query and mutation reports, keeping the message
 * verbatim, so this one seam covers every control rather than each call site
 * translating a JSON `SyntaxError`.
 */
export function assertApiResponse(response: Response): Response {
	if (isJsonResponse(response)) return response;
	throw new Error(apiUnavailableMessage(response.status));
}
