import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';

import { probeMcpServer } from '@/harness/mcp-probe.js';

// A real in-process MCP server built with the same SDK, over real HTTP on
// loopback: the probe's whole job is the wire handshake, so a mocked client
// would test nothing.

const TOKEN = 'swarm_tok_probe_0123456789';

const servers: Server[] = [];

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.closeAllConnections();
					server.close(() => resolve());
				}),
		),
	);
});

async function listen(
	handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<string> {
	const server = createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
}

/** A stateless MCP server exposing `tools`, answering 401 to any other bearer. */
function mcpServer(tools: string[]): Promise<string> {
	return listen((req, res) => {
		if (req.headers.authorization !== `Bearer ${TOKEN}`) {
			res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"Unauthorized"}');
			return;
		}
		const server = new McpServer({ name: 'test', version: '1.0.0' });
		for (const name of tools) {
			server.registerTool(name, { description: name }, async () => ({ content: [] }));
		}
		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: undefined,
			enableJsonResponse: true,
		});
		res.on('close', () => {
			void transport.close();
			void server.close();
		});
		void server.connect(transport).then(() => transport.handleRequest(req, res));
	});
}

describe('probeMcpServer (issue #1394)', () => {
	it('passes when the server accepts the credential and lists every required tool', async () => {
		const url = await mcpServer(['runs_list', 'run_get']);
		await expect(
			probeMcpServer({ url, bearerToken: TOKEN, requiredTools: ['runs_list'], timeoutMs: 5_000 }),
		).resolves.toEqual({ ok: true });
	});

	it('names a rejected credential as HTTP 401', async () => {
		const url = await mcpServer(['runs_list']);
		const result = await probeMcpServer({
			url,
			bearerToken: 'wrong',
			requiredTools: ['runs_list'],
			timeoutMs: 5_000,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toMatch(/^HTTP 401: .*rejected the credential/);
	});

	it('names every missing required tool', async () => {
		const url = await mcpServer(['runs_list']);
		const result = await probeMcpServer({
			url,
			bearerToken: TOKEN,
			requiredTools: ['runs_list', 'run_get', 'run_reset'],
			timeoutMs: 5_000,
		});
		expect(result).toEqual({
			ok: false,
			reason: `missing required tools on the MCP server at ${url}: run_get, run_reset`,
		});
	});

	it('reports a refused connection as unreachable', async () => {
		const url = await listen(() => {});
		// Free the port again so nothing is listening on it.
		await new Promise<void>((resolve) => servers.splice(0)[0]?.close(() => resolve()));
		const result = await probeMcpServer({
			url,
			bearerToken: TOKEN,
			requiredTools: [],
			timeoutMs: 5_000,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toMatch(/^unreachable: .*ECONNREFUSED/);
	});

	it('reports a server that never answers as a timeout', async () => {
		const url = await listen(() => {
			// Accept the request and never respond.
		});
		const result = await probeMcpServer({
			url,
			bearerToken: TOKEN,
			requiredTools: [],
			timeoutMs: 200,
		});
		expect(result).toEqual({
			ok: false,
			reason: `timeout: the MCP server at ${url} did not answer within 200 ms`,
		});
	});

	it('never returns the token in a reason', async () => {
		// A server echoing the request's Authorization header back in its error body.
		const url = await listen((req, res) => {
			res.writeHead(500).end(`bad request with ${req.headers.authorization}`);
		});
		const result = await probeMcpServer({
			url,
			bearerToken: TOKEN,
			requiredTools: [],
			timeoutMs: 5_000,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toMatch(/^HTTP 500: /);
		expect(result.reason).not.toContain(TOKEN);
		expect(result.reason).toContain('[redacted]');
	});

	it('reports a malformed URL without throwing', async () => {
		await expect(
			probeMcpServer({ url: 'not a url', bearerToken: TOKEN, requiredTools: [], timeoutMs: 100 }),
		).resolves.toEqual({ ok: false, reason: 'unreachable: "not a url" is not a valid URL' });
	});
});
