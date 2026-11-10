/**
 * Preflight for an MCP server a run is about to attach (issue #1394): is it
 * reachable, does it accept this credential, and does it expose the tools the
 * caller needs? Answered *before* the agent CLI starts, because a CLI that
 * cannot reach an attached server does not fail — it runs without the tools and
 * the operator learns why only from a confused transcript.
 *
 * Built on the same `@modelcontextprotocol/sdk` the operator MCP server
 * (`../mcp/server.ts`) is, over the Streamable HTTP transport: `initialize`, then
 * `tools/list` — exactly the two calls an agent CLI makes on start-up, so a probe
 * that passes means the CLI's own handshake will too.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
	StreamableHTTPClientTransport,
	StreamableHTTPError,
} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** What `probeMcpServer` checks. */
export interface ProbeMcpServerOptions {
	/** The server's Streamable HTTP endpoint. */
	url: string;
	/** Sent as `Authorization: Bearer <token>`; never part of a returned reason. */
	bearerToken: string;
	/** Tool names the server must list; any absent one fails the probe by name. */
	requiredTools: string[];
	/** Upper bound on the whole probe — handshake and every `tools/list` page. */
	timeoutMs: number;
}

/** The probe's verdict; `reason` names the cause in operator terms. */
export type ProbeMcpServerResult = { ok: true } | { ok: false; reason: string };

/** The client identity the probe announces in `initialize`. */
const PROBE_CLIENT = { name: 'swarm-mcp-probe', version: '1.0.0' } as const;

/**
 * Upper bound on `tools/list` pages, so a server whose cursor never ends cannot
 * hold the probe until its deadline and then report a misleading timeout.
 */
const MAX_TOOL_PAGES = 50;

class ProbeTimeout extends Error {}

/** Undici reports a refused/unresolvable host as `fetch failed` with the code on `cause`. */
function causeCode(err: unknown): string | undefined {
	const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
	return typeof cause?.code === 'string' ? cause.code : undefined;
}

/** Map a probe failure to the operator-facing cause it stands for. */
function reasonFor(err: unknown, url: string, timeoutMs: number): string {
	if (err instanceof ProbeTimeout) {
		return `timeout: the MCP server at ${url} did not answer within ${timeoutMs} ms`;
	}
	if (err instanceof StreamableHTTPError) {
		if (err.code === 401 || err.code === 403) {
			return `HTTP ${err.code}: the MCP server at ${url} rejected the credential (bad or expired)`;
		}
		return `HTTP ${err.code}: the MCP server at ${url} refused the request: ${err.message}`;
	}
	const message = err instanceof Error ? err.message : String(err);
	const code = causeCode(err);
	return `unreachable: could not connect to the MCP server at ${url}: ${message}${code ? ` (${code})` : ''}`;
}

/** Every tool name the server lists, following `tools/list` pagination. */
async function listToolNames(client: Client): Promise<Set<string>> {
	const names = new Set<string>();
	let cursor: string | undefined;
	for (let page = 0; page < MAX_TOOL_PAGES; page++) {
		const result = await client.listTools(cursor ? { cursor } : undefined);
		for (const tool of result.tools) names.add(tool.name);
		cursor = result.nextCursor;
		if (!cursor) break;
	}
	return names;
}

/**
 * Connect to the MCP server at `url` with `bearerToken`, run `initialize` and
 * `tools/list`, and report whether every one of `requiredTools` is exposed.
 * Never throws: every failure — HTTP 401/403, an unreachable host, the deadline,
 * a missing tool — comes back as `{ ok: false, reason }`. The token is scrubbed
 * from any reason, in case a server echoes the request back in its error body.
 */
export async function probeMcpServer(
	options: ProbeMcpServerOptions,
): Promise<ProbeMcpServerResult> {
	const { url, bearerToken, requiredTools, timeoutMs } = options;
	const scrub = (reason: string): string =>
		bearerToken ? reason.replaceAll(bearerToken, '[redacted]') : reason;

	let endpoint: URL;
	try {
		endpoint = new URL(url);
	} catch {
		return { ok: false, reason: scrub(`unreachable: "${url}" is not a valid URL`) };
	}

	const client = new Client(PROBE_CLIENT);
	const transport = new StreamableHTTPClientTransport(endpoint, {
		requestInit: { headers: { Authorization: `Bearer ${bearerToken}` } },
	});
	let timer: NodeJS.Timeout | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new ProbeTimeout()), timeoutMs);
	});

	try {
		const tools = await Promise.race([
			(async () => {
				await client.connect(transport);
				return listToolNames(client);
			})(),
			deadline,
		]);
		const missing = requiredTools.filter((name) => !tools.has(name));
		if (missing.length > 0) {
			return {
				ok: false,
				reason: scrub(`missing required tools on the MCP server at ${url}: ${missing.join(', ')}`),
			};
		}
		return { ok: true };
	} catch (err) {
		return { ok: false, reason: scrub(reasonFor(err, url, timeoutMs)) };
	} finally {
		clearTimeout(timer);
		// Closing aborts any request still in flight after a timeout, so the probe
		// leaves no socket behind; a close failure changes nothing about the verdict.
		await client.close().catch(() => {});
	}
}
