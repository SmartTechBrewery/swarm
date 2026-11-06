import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { claudeCodeMcpCommand, mcpServerUrl, OPERATOR_MCP_PATH } from './agent-access.js';

describe('mcpServerUrl', () => {
	it("is the installation origin plus the router's MCP endpoint", () => {
		expect(mcpServerUrl('https://swarm.example.com')).toBe(
			'https://swarm.example.com/operator/mcp',
		);
		expect(mcpServerUrl('https://swarm.example.com/')).toBe(
			'https://swarm.example.com/operator/mcp',
		);
	});

	it('names the path the router mounts (`OPERATOR_MCP_ENDPOINT`)', () => {
		const mount = readFileSync(
			new URL('../../../src/router/operator-mcp.ts', import.meta.url),
			'utf8',
		);

		expect(mount).toContain(`export const OPERATOR_MCP_ENDPOINT = '${OPERATOR_MCP_PATH}';`);
	});
});

describe('claudeCodeMcpCommand', () => {
	const command = claudeCodeMcpCommand('https://swarm.example.com/operator/mcp', 'tok_123');

	it('registers the server as `swarm` over http with the token as a bearer header', () => {
		expect(command).toBe(
			'claude mcp add --transport http swarm https://swarm.example.com/operator/mcp \\\n' +
				'  --header "Authorization: Bearer tok_123"',
		);
	});

	it('is the same command shape docs/mcp.md documents', () => {
		const docs = readFileSync(new URL('../../../docs/mcp.md', import.meta.url), 'utf8');

		expect(docs).toContain(
			claudeCodeMcpCommand('https://swarm.example.com/operator/mcp', '<token>'),
		);
	});
});
