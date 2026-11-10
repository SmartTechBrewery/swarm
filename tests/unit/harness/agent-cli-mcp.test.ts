import { EventEmitter } from 'node:events';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the subprocess boundary — unit tests never spawn a real CLI
// (ai/TESTING.md). The attachment's file I/O is real, against a temp worktree,
// because the 0600 mode and the removal are exactly what is under test.
const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
	spawn: (...args: unknown[]) => spawnMock(...args),
}));
const capabilitiesMock = vi.fn(async () => ({ outputFormat: true, printTimeout: true }));
vi.mock('@/harness/antigravity-capabilities.js', () => ({
	antigravityCapabilities: () => capabilitiesMock(),
}));

import {
	type AgentMcpServer,
	cliSupportsMcpServer,
	MCP_BEARER_TOKEN_ENV_VAR,
	runAgentCli,
} from '@/harness/agent-cli.js';
import { logger } from '@/lib/logger.js';
import { createMockRunAgentCliOptions } from '../../helpers/factories.js';

class FakeStream extends EventEmitter {
	setEncoding(): void {}
}

class FakeChild extends EventEmitter {
	stdout = new FakeStream();
	stderr = new FakeStream();
	kill = vi.fn();
}

const TOKEN = 'swarm_tok_0123456789abcdef';

const server = (overrides: Partial<AgentMcpServer> = {}): AgentMcpServer => ({
	name: 'swarm',
	url: 'https://swarm.example.test/operator/mcp',
	bearerToken: TOKEN,
	requiredTools: ['runs_list'],
	...overrides,
});

interface SpawnCall {
	command: string;
	args: string[];
	env: NodeJS.ProcessEnv;
	/** The `--mcp-config` file as it stood when the CLI was spawned. */
	configFile?: { path: string; mode: number; content: unknown };
}

let worktree: string;
let calls: SpawnCall[];
let children: FakeChild[];

/** The `index`-th spawned child — an attached run reaches `spawn` a few ticks later. */
const spawnedChild = async (index = 0): Promise<FakeChild> => {
	await vi.waitFor(() => expect(children.length).toBeGreaterThan(index));
	return children[index] as FakeChild;
};

/** Files the attachment may have left in the worktree. */
const leftoverConfigFiles = (): string[] =>
	readdirSync(worktree).filter((name) => name.startsWith('.swarm-mcp-'));

beforeEach(() => {
	worktree = mkdtempSync(path.join(tmpdir(), 'swarm-mcp-wt-'));
	calls = [];
	children = [];
	spawnMock.mockReset();
	spawnMock.mockImplementation(
		(command: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
			const call: SpawnCall = { command, args, env: opts.env };
			const flag = args.indexOf('--mcp-config');
			if (flag !== -1) {
				const file = args[flag + 1] as string;
				call.configFile = {
					path: file,
					mode: statSync(file).mode & 0o777,
					content: JSON.parse(readFileSync(file, 'utf8')),
				};
			}
			calls.push(call);
			const child = new FakeChild();
			children.push(child);
			return child;
		},
	);
});

afterEach(() => {
	rmSync(worktree, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe('cliSupportsMcpServer', () => {
	it('declares claude and codex capable and antigravity not', () => {
		expect(cliSupportsMcpServer('claude')).toBe(true);
		expect(cliSupportsMcpServer('codex')).toBe(true);
		expect(cliSupportsMcpServer('antigravity')).toBe(false);
	});
});

describe('runAgentCli with an attached MCP server (issue #1394)', () => {
	describe('claude', () => {
		it('passes a 0600 --mcp-config file in the cwd, without --strict-mcp-config', async () => {
			const promise = runAgentCli(
				createMockRunAgentCliOptions({
					cwd: worktree,
					mcpServer: server(),
					args: ['do the task'],
				}),
			);
			(await spawnedChild()).emit('close', 0, null);
			await promise;

			const [call] = calls;
			expect(call?.configFile).toBeDefined();
			expect(path.dirname(call?.configFile?.path as string)).toBe(worktree);
			expect(call?.configFile?.mode).toBe(0o600);
			expect(call?.configFile?.content).toEqual({
				mcpServers: {
					swarm: {
						type: 'http',
						url: 'https://swarm.example.test/operator/mcp',
						headers: { Authorization: `Bearer ${TOKEN}` },
					},
				},
			});
			expect(call?.args).not.toContain('--strict-mcp-config');
			// The variadic flag is followed by another flag, and `-p` still sits
			// immediately before the prompt.
			const flag = call?.args.indexOf('--mcp-config') as number;
			expect(call?.args[flag + 2]).toBe('--output-format');
			expect(call?.args.slice(-2)).toEqual(['-p', 'do the task']);
		});

		it('keeps the token out of argv and the env', async () => {
			const promise = runAgentCli(
				createMockRunAgentCliOptions({ cwd: worktree, mcpServer: server() }),
			);
			(await spawnedChild()).emit('close', 0, null);
			await promise;

			const [call] = calls;
			expect(call?.args.join(' ')).not.toContain(TOKEN);
			expect(Object.values(call?.env ?? {})).not.toContain(TOKEN);
		});

		it('removes the file after a successful run', async () => {
			const promise = runAgentCli(
				createMockRunAgentCliOptions({ cwd: worktree, mcpServer: server() }),
			);
			const child = await spawnedChild();
			expect(leftoverConfigFiles()).toHaveLength(1);
			child.emit('close', 0, null);
			await promise;
			expect(leftoverConfigFiles()).toEqual([]);
		});

		it('removes the file after a failed run', async () => {
			const promise = runAgentCli(
				createMockRunAgentCliOptions({ cwd: worktree, mcpServer: server() }),
			);
			(await spawnedChild()).emit('close', 1, null);
			await expect(promise).resolves.toMatchObject({ exitCode: 1 });
			expect(leftoverConfigFiles()).toEqual([]);
		});

		it('removes the file when the CLI fails to launch', async () => {
			const promise = runAgentCli(
				createMockRunAgentCliOptions({ cwd: worktree, mcpServer: server() }),
			);
			(await spawnedChild()).emit('error', new Error('spawn claude ENOENT'));
			await expect(promise).rejects.toThrow(/Failed to launch claude/);
			expect(leftoverConfigFiles()).toEqual([]);
		});

		it('never logs the token', async () => {
			const spies = (['debug', 'info', 'warn', 'error'] as const).map((level) =>
				vi.spyOn(logger, level),
			);
			const promise = runAgentCli(
				createMockRunAgentCliOptions({ cwd: worktree, mcpServer: server(), logLines: true }),
			);
			const child = await spawnedChild();
			child.stdout.emit('data', 'working\n');
			child.emit('close', 0, null);
			const result = await promise;

			for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
			expect(result.stdout).not.toContain(TOKEN);
			expect(result.stderr).not.toContain(TOKEN);
		});
	});

	describe('codex', () => {
		it('passes the server by -c overrides and the token by a child-only env var', async () => {
			const promise = runAgentCli(
				createMockRunAgentCliOptions({
					cli: 'codex',
					cwd: worktree,
					mcpServer: server(),
					args: ['do the task'],
				}),
			);
			(await spawnedChild()).emit('close', 0, null);
			await promise;

			const [call] = calls;
			expect(call?.args).toEqual(
				expect.arrayContaining([
					'-c',
					'mcp_servers.swarm.url="https://swarm.example.test/operator/mcp"',
					'-c',
					`mcp_servers.swarm.bearer_token_env_var="${MCP_BEARER_TOKEN_ENV_VAR}"`,
				]),
			);
			expect(call?.args[0]).toBe('exec');
			expect(call?.args.at(-1)).toBe('do the task');
			expect(call?.args.join(' ')).not.toContain(TOKEN);
			expect(call?.env[MCP_BEARER_TOKEN_ENV_VAR]).toBe(TOKEN);
			// Set on the child alone, never on SWARM's own process.
			expect(process.env[MCP_BEARER_TOKEN_ENV_VAR]).toBeUndefined();
			expect(leftoverConfigFiles()).toEqual([]);
		});

		it('keeps caller env alongside the token', async () => {
			const promise = runAgentCli(
				createMockRunAgentCliOptions({
					cli: 'codex',
					cwd: worktree,
					mcpServer: server(),
					env: { GH_TOKEN: 'gh' },
				}),
			);
			(await spawnedChild()).emit('close', 0, null);
			await promise;
			expect(calls[0]?.env).toMatchObject({ GH_TOKEN: 'gh', [MCP_BEARER_TOKEN_ENV_VAR]: TOKEN });
		});
	});

	describe('antigravity', () => {
		it('refuses at once and never launches agy without the server', async () => {
			await expect(
				runAgentCli(
					createMockRunAgentCliOptions({ cli: 'antigravity', cwd: worktree, mcpServer: server() }),
				),
			).rejects.toThrow('antigravity cannot attach an MCP server');
			expect(spawnMock).not.toHaveBeenCalled();
			expect(capabilitiesMock).not.toHaveBeenCalled();
		});
	});

	it('refuses a server name that is not a safe config key', async () => {
		await expect(
			runAgentCli(
				createMockRunAgentCliOptions({
					cli: 'codex',
					cwd: worktree,
					mcpServer: server({ name: 'swarm.evil' }),
				}),
			),
		).rejects.toThrow(/MCP server name "swarm.evil"/);
		expect(spawnMock).not.toHaveBeenCalled();
	});
});
