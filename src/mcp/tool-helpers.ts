/**
 * Shared plumbing for the operator MCP server's tools (issue #1338).
 *
 * **A tool calls the dashboard's own tRPC procedure, never a repository.**
 * {@link callerFor} builds a server-side caller over `appRouter` for the user the
 * request's bearer resolved to, so a tool reaches exactly the procedure object the
 * dashboard calls — with its `assertProjectAccess`, its `accessibleProjectScope`
 * bound and its existence-hiding `NOT_FOUND` — and project roles cannot diverge
 * between the two surfaces. A tool that re-implemented a read against the
 * repository would have to re-implement that authorization too, and the first
 * time the two disagreed an MCP client would read what the dashboard hides.
 *
 * The caller spans `appRouter`, but only the procedures a *registered tool*
 * actually calls are reachable: an MCP client names a tool, never a procedure.
 * Registering a tool is therefore the deliberate act that publishes a procedure on
 * this internet-exposed surface, exactly as adding a namespace to
 * `../api/operator-router.ts` is for `/operator/trpc`.
 *
 * {@link runTool} turns a tool body's outcome into the MCP result shape: the value
 * as pretty-printed JSON text (what every client renders) plus the same value as
 * `structuredContent` when it is an object, and a refusal or failure as an
 * `isError` result rather than a JSON-RPC error, so the calling model sees the
 * reason and can act on it.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { TRPCError } from '@trpc/server';

import { appRouter } from '../api/router.js';
import { createCallerFactory } from '../api/trpc.js';
import type { SwarmUser } from '../identity/schema.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const createCaller = createCallerFactory(appRouter);

/** The server-side tRPC caller a tool reads through. */
export type SwarmCaller = ReturnType<typeof createCaller>;

/**
 * A caller bound to `user` — the same `{ user }` context the dashboard's and the
 * operator API's `createContext` build — so every procedure authorizes the MCP
 * request exactly as it authorizes that user in the browser.
 */
export function callerFor(user: SwarmUser): SwarmCaller {
	return createCaller({ user });
}

/**
 * Render a tool's return value as an MCP result. Round-tripping through JSON makes
 * `structuredContent` exactly what the text says (a `Date` becomes its ISO string in
 * both), and `structuredContent` is set only for a plain object because the MCP
 * schema requires one there.
 */
export function jsonResult(value: unknown): CallToolResult {
	const text = JSON.stringify(value ?? null, null, 2);
	const structured: unknown = JSON.parse(text);
	const isObject =
		typeof structured === 'object' && structured !== null && !Array.isArray(structured);
	return {
		content: [{ type: 'text', text }],
		...(isObject ? { structuredContent: structured as Record<string, unknown> } : {}),
	};
}

/** An `isError` result carrying `message` as its only content. */
export function errorResult(message: string): CallToolResult {
	return { isError: true, content: [{ type: 'text', text: message }] };
}

/**
 * Run a tool body and map its outcome to an MCP result. A `TRPCError` is the
 * procedure's own refusal (`NOT_FOUND`, `FORBIDDEN`, `PRECONDITION_FAILED`, …) and is
 * reported verbatim as `<code>: <message>`, which is the same wording the dashboard
 * shows. Anything else is unexpected: it is logged with the tool's name — never the
 * request's bearer, which nothing here holds — and reported as its described error.
 */
export async function runTool(tool: string, body: () => Promise<unknown>): Promise<CallToolResult> {
	try {
		return jsonResult(await body());
	} catch (error) {
		if (error instanceof TRPCError) {
			return errorResult(`${error.code}: ${error.message}`);
		}
		const message = describeError(error);
		logger.warn('operator MCP tool failed', { tool, error: message });
		return errorResult(`Tool "${tool}" failed: ${message}`);
	}
}
