import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the subprocess boundary — unit tests never spawn a real CLI
// (ai/TESTING.md "mock … LLM CLI subprocess calls"). The fake child lets each
// test drive stdout/stderr, close, and error events deterministically.
const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({
	spawn: (...args: unknown[]) => spawnMock(...args),
}));

// The `agy --help` capability probe (issue #465) is mocked at the module rather
// than the process boundary: the real module calls `promisify(execFile)` at load
// time, which the `node:child_process` mock above doesn't provide. Its own
// behavior is covered in antigravity-capabilities.test.ts.
const supportsOutputFormatMock = vi.fn<() => Promise<boolean>>();
vi.mock('@/harness/antigravity-capabilities.js', () => ({
	supportsOutputFormat: () => supportsOutputFormatMock(),
}));

import { type AgentCliResult, describeAgent, runAgentCli } from '@/harness/agent-cli.js';
import { classifyAgentFailure } from '@/harness/agent-failure.js';
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

let children: FakeChild[] = [];
const lastChild = (): FakeChild => {
	const child = children.at(-1);
	if (!child) throw new Error('spawn was not called');
	return child;
};

/**
 * The child of the `index`-th spawn (0-based, matching `spawnMock.mock.calls`),
 * awaited — antigravity resolves its capability probe before spawning, so its
 * child exists a microtask later rather than synchronously. Only the agy path is
 * asynchronous; claude/codex tests keep calling `lastChild()` directly, which is
 * the assertion that the probe's `await` didn't leak onto their path.
 */
const spawnedChild = async (index: number): Promise<FakeChild> => {
	await vi.waitFor(() => expect(children.length).toBeGreaterThan(index));
	const child = children[index];
	if (!child) throw new Error(`spawn #${index} did not happen`);
	return child;
};

/** One chunk of `agy --output-format stream-json` NDJSON. */
const agyStream = (...events: unknown[]): string =>
	`${events.map((event) => JSON.stringify(event)).join('\n')}\n`;

const agyInit = (conversationId: string) => ({
	event: 'init',
	conversation_id: conversationId,
	init: { cwd: '/scratch', tools: ['view_file'], permission_mode: 'request-review' },
});
const agyTextDelta = (stepIndex: number, textDelta: string, state = 'ACTIVE') => ({
	event: 'step_update',
	step_update: { step_index: stepIndex, state, step_type: 'agent_response', text_delta: textDelta },
});
const agyResult = (fields: Record<string, unknown>) => ({
	event: 'result',
	result: { status: 'SUCCESS', ...fields },
});

/** One chunk of `claude -p --output-format stream-json` NDJSON. */
const claudeStream = (...events: unknown[]): string =>
	`${events.map((event) => JSON.stringify(event)).join('\n')}\n`;

const claudeText = (text: string) => ({
	type: 'assistant',
	message: { role: 'assistant', content: [{ type: 'text', text }] },
});
const claudeToolUse = (id: string, name: string, input: Record<string, unknown>) => ({
	type: 'assistant',
	message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
});
const claudeToolResult = (id: string, content: string, isError = false) => ({
	type: 'user',
	message: {
		role: 'user',
		content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }],
	},
});
const claudeResult = (fields: Record<string, unknown>) => ({
	type: 'result',
	subtype: 'success',
	is_error: false,
	...fields,
});

/** Whether a run promise has settled yet — "did this happen before the process exited?". */
function track(promise: Promise<unknown>): { settled: boolean } {
	const state = { settled: false };
	const mark = (): void => {
		state.settled = true;
	};
	promise.then(mark, mark);
	return state;
}

beforeEach(() => {
	children = [];
	// Default to an `agy` that supports --output-format; the older-binary path is
	// exercised explicitly by the tests that override this.
	supportsOutputFormatMock.mockReset();
	supportsOutputFormatMock.mockResolvedValue(true);
	spawnMock.mockReset();
	spawnMock.mockImplementation(() => {
		const child = new FakeChild();
		children.push(child);
		return child;
	});
});

describe('runAgentCli', () => {
	it('spawns the CLI in the worktree and captures stdout, stderr, and exit code', async () => {
		const promise = runAgentCli(createMockRunAgentCliOptions());
		const child = lastChild();
		child.stdout.emit('data', 'hello\nworld\n');
		child.stderr.emit('data', 'a warning\n');
		child.emit('close', 0, null);

		const result = await promise;
		expect(result).toMatchObject<Partial<AgentCliResult>>({
			cli: 'claude',
			exitCode: 0,
			signal: null,
			// Not protocol records, so the lines are kept verbatim.
			stdout: 'hello\nworld\n',
			stderr: 'a warning\n',
			timedOut: false,
			aborted: false,
			outputTruncated: false,
			usage: undefined,
		});

		expect(spawnMock).toHaveBeenCalledWith(
			'claude',
			['--dangerously-skip-permissions', '--output-format', 'stream-json', '--verbose', '-p'],
			{
				cwd: '/wt',
				env: process.env,
				stdio: ['ignore', 'pipe', 'pipe'],
			},
		);
	});

	it('puts -p immediately before the caller-supplied prompt for claude', async () => {
		const promise = runAgentCli(createMockRunAgentCliOptions({ args: ['implement the thing'] }));
		lastChild().emit('close', 0, null);
		await promise;

		expect(spawnMock).toHaveBeenCalledWith(
			'claude',
			[
				'--dangerously-skip-permissions',
				'--output-format',
				'stream-json',
				'--verbose',
				'-p',
				'implement the thing',
			],
			expect.anything(),
		);
	});

	it('inserts provider arguments before output/session/print arguments', async () => {
		const promise = runAgentCli(
			createMockRunAgentCliOptions({
				providerArgs: ['--provider-flag', 'value'],
				args: ['implement the thing'],
			}),
		);
		lastChild().emit('close', 0, null);
		await promise;

		expect(spawnMock.mock.calls[0][1]).toEqual([
			'--dangerously-skip-permissions',
			'--provider-flag',
			'value',
			'--output-format',
			'stream-json',
			'--verbose',
			'-p',
			'implement the thing',
		]);
	});

	it('assigns and resumes Claude sessions before -p without affecting other CLIs', async () => {
		const fresh = runAgentCli(
			createMockRunAgentCliOptions({
				sessionId: '11111111-1111-4111-8111-111111111111',
				args: ['go'],
			}),
		);
		lastChild().emit('close', 0, null);
		await fresh;
		expect(spawnMock.mock.calls[0][1]).toEqual([
			'--dangerously-skip-permissions',
			'--output-format',
			'stream-json',
			'--verbose',
			'--session-id',
			'11111111-1111-4111-8111-111111111111',
			'-p',
			'go',
		]);

		const resumed = runAgentCli(
			createMockRunAgentCliOptions({
				resumeSessionId: '11111111-1111-4111-8111-111111111111',
				args: ['continue'],
			}),
		);
		lastChild().emit('close', 0, null);
		await resumed;
		expect(spawnMock.mock.calls[1][1]).toContain('--resume');
		expect(spawnMock.mock.calls[1][1].slice(-2)).toEqual(['-p', 'continue']);
	});

	it('resumes codex via the `exec resume <id>` subcommand, not a flag', async () => {
		const resumed = runAgentCli(
			createMockRunAgentCliOptions({
				cli: 'codex',
				resumeSessionId: '019f57a7-cf1b-72d3-b887-63758a10f3a8',
				args: ['continue'],
			}),
		);
		lastChild().emit('close', 0, null);
		await resumed;
		expect(spawnMock.mock.calls[0][1]).toEqual([
			'exec',
			'resume',
			'019f57a7-cf1b-72d3-b887-63758a10f3a8',
			'--dangerously-bypass-approvals-and-sandbox',
			'--json',
			'continue',
		]);
	});

	describe('containment (issue #614)', () => {
		// The per-CLI arguments themselves are covered in containment.test.ts; these
		// assert the harness *wiring* — that a resolved plan lands in the position
		// the hard-coded bypass flag used to occupy, on the resume path too.
		it('takes the deployment mode from SWARM_AGENT_CONTAINMENT when the caller names none', async () => {
			vi.stubEnv('SWARM_AGENT_CONTAINMENT', 'worktree');
			vi.stubEnv('SWARM_AGENT_CONTAINMENT_DOMAINS', 'api.github.com');

			const promise = runAgentCli(createMockRunAgentCliOptions({ args: ['do the thing'] }));
			lastChild().emit('close', 0, null);
			await promise;

			const args = spawnMock.mock.calls[0][1] as string[];
			expect(args).not.toContain('--dangerously-skip-permissions');
			expect(args.slice(0, 4)).toEqual([
				'--settings',
				JSON.stringify({
					sandbox: {
						enabled: true,
						failIfUnavailable: true,
						allowUnsandboxedCommands: false,
						autoAllowBashIfSandboxed: true,
						network: { allowedDomains: ['api.github.com'] },
					},
				}),
				'--permission-mode',
				'acceptEdits',
			]);
			// The one position that is load-bearing for agy is untouched: whatever
			// containment inserts, the prompt still follows -p directly.
			expect(args.slice(-2)).toEqual(['-p', 'do the thing']);
		});

		it("lets a caller's own mode override the deployment default", async () => {
			vi.stubEnv('SWARM_AGENT_CONTAINMENT', 'worktree');

			const promise = runAgentCli(
				createMockRunAgentCliOptions({ containment: 'bypass', args: ['do the thing'] }),
			);
			lastChild().emit('close', 0, null);
			await promise;

			expect(spawnMock.mock.calls[0][1]).toContain('--dangerously-skip-permissions');
		});

		it('contains the codex resume path, not just a fresh run', async () => {
			// The resume path used to carry its own copy of the bypass flag, so it
			// could not be tightened at all.
			const resumed = runAgentCli(
				createMockRunAgentCliOptions({
					cli: 'codex',
					containment: 'worktree',
					resumeSessionId: '019f57a7-cf1b-72d3-b887-63758a10f3a8',
					args: ['continue'],
				}),
			);
			lastChild().emit('close', 0, null);
			await resumed;

			expect(spawnMock.mock.calls[0][1]).toEqual([
				'exec',
				'resume',
				'019f57a7-cf1b-72d3-b887-63758a10f3a8',
				'-c',
				'permissions.swarm-worktree.extends=":workspace"',
				'-c',
				'permissions.swarm-worktree.network.enabled=true',
				'-c',
				'default_permissions="swarm-worktree"',
				'--json',
				'continue',
			]);
		});

		it('warns and stays on the bypass for antigravity, which cannot be contained', async () => {
			const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
			const promise = runAgentCli(
				createMockRunAgentCliOptions({
					cli: 'antigravity',
					containment: 'worktree',
					args: ['do the thing'],
				}),
			);
			(await spawnedChild(0)).emit('close', 0, null);
			await promise;

			expect(spawnMock.mock.calls[0][1]).toContain('--dangerously-skip-permissions');
			expect(warn).toHaveBeenCalledWith(
				'agent run is not contained',
				expect.objectContaining({ cli: 'antigravity', requested: 'worktree', applied: 'bypass' }),
			);
		});
	});

	it('resumes antigravity via --conversation, keeping -p immediately before the prompt', async () => {
		const resumed = runAgentCli(
			createMockRunAgentCliOptions({
				cli: 'antigravity',
				resumeSessionId: '08bbd753-411b-4797-a252-9b49087b26e5',
				args: ['continue'],
			}),
		);
		(await spawnedChild(0)).emit('close', 0, null);
		await resumed;
		expect(spawnMock.mock.calls[0][1]).toEqual([
			'--dangerously-skip-permissions',
			'--add-dir',
			'/wt',
			'--output-format',
			'stream-json',
			'--conversation',
			'08bbd753-411b-4797-a252-9b49087b26e5',
			'-p',
			'continue',
		]);
	});

	it('requests each CLI its own structured output format', async () => {
		const claude = runAgentCli(createMockRunAgentCliOptions());
		lastChild().emit('close', 0, null);
		await claude;
		expect(spawnMock.mock.calls[0][1]).toEqual(
			expect.arrayContaining(['--output-format', 'stream-json', '--verbose']),
		);

		const agy = runAgentCli(createMockRunAgentCliOptions({ cli: 'antigravity' }));
		(await spawnedChild(1)).emit('close', 0, null);
		await agy;
		expect(spawnMock.mock.calls[1][1]).toEqual(
			expect.arrayContaining(['--output-format', 'stream-json']),
		);
		// --verbose is claude's requirement alone; agy takes no such flag.
		expect(spawnMock.mock.calls[1][1]).not.toContain('--verbose');
		expect(spawnMock.mock.calls[1][1]).not.toContain('--json');

		const codex = runAgentCli(createMockRunAgentCliOptions({ cli: 'codex' }));
		lastChild().emit('close', 0, null);
		await codex;
		expect(spawnMock.mock.calls[2][1]).toContain('--json');
		expect(spawnMock.mock.calls[2][1]?.[0]).toBe('exec');
	});

	it('omits --output-format entirely for an agy that does not advertise it', async () => {
		// agy 1.1.3 has no such flag, so passing it unconditionally would hand an
		// unknown flag to that binary (issue #465). The args must be byte-for-byte
		// what SWARM sent before the flag existed.
		supportsOutputFormatMock.mockResolvedValue(false);
		const agy = runAgentCli(
			createMockRunAgentCliOptions({ cli: 'antigravity', args: ['do the thing'] }),
		);
		const child = await spawnedChild(0);
		child.stdout.emit('data', 'plain text answer\n');
		child.emit('close', 0, null);

		const result = await agy;
		expect(spawnMock.mock.calls[0][1]).toEqual([
			'--dangerously-skip-permissions',
			'--add-dir',
			'/wt',
			'-p',
			'do the thing',
		]);
		// And the pre-#465 behavior all the way through: raw stdout as the log, no
		// usage, no structural verdict.
		expect(result).toMatchObject<Partial<AgentCliResult>>({
			stdout: 'plain text answer\n',
			usage: undefined,
		});
		expect(result.antigravityFailure).toBeUndefined();
	});

	it('spawns the agy binary for antigravity, with -p immediately before the prompt too', async () => {
		// Load-bearing order: agy's -p/--print is a *value* flag whose value is the
		// prompt itself (unlike claude's boolean -p), confirmed live — see the
		// SUBCOMMAND_ARGS/PRINT_FLAG comment in agent-cli.ts. Any flag landing between
		// -p and the prompt gets swallowed as the prompt instead of the real task.
		const promise = runAgentCli(
			createMockRunAgentCliOptions({ cli: 'antigravity', args: ['do the thing'] }),
		);
		(await spawnedChild(0)).emit('close', 0, null);
		await promise;

		expect(spawnMock).toHaveBeenCalledWith(
			'agy',
			[
				'--dangerously-skip-permissions',
				'--add-dir',
				'/wt',
				'--output-format',
				'stream-json',
				'-p',
				'do the thing',
			],
			expect.anything(),
		);
	});

	it('grants antigravity access to the worktree via --add-dir, and never for claude or codex', async () => {
		// agy --print runs from its own scratch dir, not the `cwd` we spawn it with
		// (issue #226), so it needs the worktree opened explicitly. --add-dir sits
		// among the leading flags, never between -p and the prompt (load-bearing for
		// agy). claude/codex inherit `cwd`, so they get no such flag.
		const agy = runAgentCli(
			createMockRunAgentCliOptions({
				cli: 'antigravity',
				cwd: '/tmp/wt/task-226',
				args: ['do the thing'],
			}),
		);
		(await spawnedChild(0)).emit('close', 0, null);
		await agy;
		const agyArgs = spawnMock.mock.calls[0][1] as string[];
		expect(agyArgs).toContain('--add-dir');
		expect(agyArgs[agyArgs.indexOf('--add-dir') + 1]).toBe('/tmp/wt/task-226');
		// Never adjacent to the prompt — -p must stay immediately before it.
		expect(agyArgs.slice(-2)).toEqual(['-p', 'do the thing']);

		const claude = runAgentCli(
			createMockRunAgentCliOptions({ cli: 'claude', cwd: '/tmp/wt/task-226' }),
		);
		lastChild().emit('close', 0, null);
		await claude;
		expect(spawnMock.mock.calls[1][1]).not.toContain('--add-dir');

		const codex = runAgentCli(
			createMockRunAgentCliOptions({ cli: 'codex', cwd: '/tmp/wt/task-226' }),
		);
		lastChild().emit('close', 0, null);
		await codex;
		expect(spawnMock.mock.calls[2][1]).not.toContain('--add-dir');
	});

	it('spawns codex with exec subcommand, --dangerously-bypass-approvals-and-sandbox, and no -p flag', async () => {
		// Codex's non-interactive mode is `codex exec <prompt>` (a subcommand, not
		// a -p flag — codex's -p is --profile, completely unrelated). Its permissions
		// bypass is --dangerously-bypass-approvals-and-sandbox (not
		// --dangerously-skip-permissions). Confirmed via `codex exec --help`.
		const promise = runAgentCli(
			createMockRunAgentCliOptions({ cli: 'codex', args: ['do the thing'] }),
		);
		lastChild().emit('close', 0, null);
		await promise;

		expect(spawnMock).toHaveBeenCalledWith(
			'codex',
			['exec', '--dangerously-bypass-approvals-and-sandbox', '--json', 'do the thing'],
			expect.anything(),
		);
	});

	it('inserts --model between the default flags and -p for claude, never between -p and the prompt', async () => {
		const promise = runAgentCli(
			createMockRunAgentCliOptions({ model: 'sonnet', args: ['implement the thing'] }),
		);
		lastChild().emit('close', 0, null);
		await promise;

		expect(spawnMock).toHaveBeenCalledWith(
			'claude',
			[
				'--dangerously-skip-permissions',
				'--model',
				'sonnet',
				'--output-format',
				'stream-json',
				'--verbose',
				'-p',
				'implement the thing',
			],
			expect.anything(),
		);
	});

	it('inserts --model before the prompt for codex without a -p flag', async () => {
		const promise = runAgentCli(
			createMockRunAgentCliOptions({
				cli: 'codex',
				model: 'gpt-5.6-sol',
				args: ['implement the thing'],
			}),
		);
		lastChild().emit('close', 0, null);
		await promise;

		expect(spawnMock).toHaveBeenCalledWith(
			'codex',
			[
				'exec',
				'--dangerously-bypass-approvals-and-sandbox',
				'--model',
				'gpt-5.6-sol',
				'--json',
				'implement the thing',
			],
			expect.anything(),
		);
	});

	it('omits --model entirely when no model is specified', async () => {
		const promise = runAgentCli(createMockRunAgentCliOptions({ args: ['implement the thing'] }));
		lastChild().emit('close', 0, null);
		await promise;

		const args = spawnMock.mock.calls[0][1] as string[];
		expect(args).not.toContain('--model');
	});

	it('maps claude reasoning to a --effort flag beside --model (issue #180)', async () => {
		const promise = runAgentCli(
			createMockRunAgentCliOptions({
				model: 'sonnet',
				reasoning: 'high',
				args: ['implement the thing'],
			}),
		);
		lastChild().emit('close', 0, null);
		await promise;

		expect(spawnMock.mock.calls[0][1]).toEqual([
			'--dangerously-skip-permissions',
			'--model',
			'sonnet',
			'--effort',
			'high',
			'--output-format',
			'stream-json',
			'--verbose',
			'-p',
			'implement the thing',
		]);
	});

	it('maps codex reasoning to a -c model_reasoning_effort config override (issue #180)', async () => {
		const promise = runAgentCli(
			createMockRunAgentCliOptions({
				cli: 'codex',
				model: 'gpt-5.6-terra',
				reasoning: 'xhigh',
				args: ['implement the thing'],
			}),
		);
		lastChild().emit('close', 0, null);
		await promise;

		expect(spawnMock.mock.calls[0][1]).toEqual([
			'exec',
			'--dangerously-bypass-approvals-and-sandbox',
			'--model',
			'gpt-5.6-terra',
			'-c',
			'model_reasoning_effort="xhigh"',
			'--json',
			'implement the thing',
		]);
	});

	it('folds antigravity reasoning into the combined --model slug with no reasoning flag', async () => {
		const promise = runAgentCli(
			createMockRunAgentCliOptions({
				cli: 'antigravity',
				model: 'gemini-3.5-flash',
				reasoning: 'high',
				args: ['implement the thing'],
			}),
		);
		(await spawnedChild(0)).emit('close', 0, null);
		await promise;

		const args = spawnMock.mock.calls[0][1] as string[];
		expect(args).toContain('--model');
		expect(args[args.indexOf('--model') + 1]).toBe('gemini-3.5-flash-high');
		expect(args).not.toContain('--effort');
		expect(args.some((a) => a.startsWith('model_reasoning_effort'))).toBe(false);
	});

	it('forwards output line-by-line, including partial and CRLF lines', async () => {
		const stdoutLines: string[] = [];
		const stderrLines: string[] = [];
		const promise = runAgentCli(
			createMockRunAgentCliOptions({
				cli: 'antigravity',
				onStdout: (line) => stdoutLines.push(line),
				onStderr: (line) => stderrLines.push(line),
			}),
		);
		const child = await spawnedChild(0);
		// Split mid-line across chunks; the buffer should stitch it back together.
		child.stdout.emit('data', 'first\r\nseco');
		child.stdout.emit('data', 'nd\nno-newline-yet');
		child.stderr.emit('data', 'err-line\n');
		child.emit('close', 0, null);

		await promise;
		// CRLF stripped, the split "second" reassembled, trailing partial flushed on close.
		expect(stdoutLines).toEqual(['first', 'second', 'no-newline-yet']);
		expect(stderrLines).toEqual(['err-line']);
	});

	it('returns a non-zero exit code rather than throwing', async () => {
		const promise = runAgentCli(createMockRunAgentCliOptions());
		const child = lastChild();
		child.stderr.emit('data', 'boom\n');
		child.emit('close', 2, null);

		const result = await promise;
		expect(result.exitCode).toBe(2);
		expect(result.stderr).toBe('boom\n');
	});

	it('rejects when the CLI fails to spawn (e.g. not installed)', async () => {
		const promise = runAgentCli(createMockRunAgentCliOptions());
		lastChild().emit('error', new Error('spawn claude ENOENT'));

		await expect(promise).rejects.toThrow(
			/Failed to launch claude \("claude"\): spawn claude ENOENT/,
		);
	});

	it('passes through args, a custom command, and merges env over process.env', async () => {
		const promise = runAgentCli(
			createMockRunAgentCliOptions({
				command: '/usr/bin/fake-claude',
				args: ['--print', 'do the thing'],
				env: { SWARM_TASK: '42' },
			}),
		);
		lastChild().emit('close', 0, null);
		await promise;

		expect(spawnMock).toHaveBeenCalledTimes(1);
		const [command, args, opts] = spawnMock.mock.calls[0] as [
			string,
			string[],
			{ env: Record<string, string> },
		];
		expect(command).toBe('/usr/bin/fake-claude');
		expect(args).toEqual([
			'--dangerously-skip-permissions',
			'--output-format',
			'stream-json',
			'--verbose',
			'-p',
			'--print',
			'do the thing',
		]);
		expect(opts.env.SWARM_TASK).toBe('42');
		expect(opts.env.PATH).toBe(process.env.PATH);
	});

	it('rejects on an unknown CLI', async () => {
		// @ts-expect-error — exercising runtime validation with an invalid value
		await expect(runAgentCli({ cli: 'aider', cwd: '/wt' })).rejects.toThrow();
	});

	it('caps captured output at maxOutputBytes while still streaming every line', async () => {
		const lines: string[] = [];
		const promise = runAgentCli(
			createMockRunAgentCliOptions({ maxOutputBytes: 5, onStdout: (line) => lines.push(line) }),
		);
		const child = lastChild();
		child.stdout.emit('data', 'aaa\n'); // 4 bytes — under the cap
		child.stdout.emit('data', 'bbbbbb\n'); // crosses the cap; retained, then latches
		child.stdout.emit('data', 'ccc\n'); // dropped from the captured buffer
		child.emit('close', 0, null);

		const result = await promise;
		expect(result.stdout).toBe('aaa\nbbbbbb\n');
		expect(result.outputTruncated).toBe(true);
		// The line callbacks are unaffected by the cap — they saw the full stream.
		expect(lines).toEqual(['aaa', 'bbbbbb', 'ccc']);
	});

	// Claude prints NDJSON protocol records (`--output-format stream-json`), which
	// the harness decodes into readable lines *as they arrive* — the whole point of
	// issue #356: with `--output-format json` nothing reached the run page until
	// the process exited.
	describe('claude stream decoding', () => {
		it('forwards readable progress while the process is still running', async () => {
			const lines: string[] = [];
			const promise = runAgentCli(
				createMockRunAgentCliOptions({ onStdout: (line) => lines.push(line) }),
			);
			const state = track(promise);
			const child = lastChild();

			child.stdout.emit(
				'data',
				claudeStream({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
			);
			child.stdout.emit('data', claudeStream(claudeText('Reading the failing test.')));
			child.stdout.emit('data', claudeStream(claudeToolUse('t1', 'Bash', { command: 'npm test' })));
			await Promise.resolve();

			// Live output, long before the process exits.
			expect(lines).toEqual(['Reading the failing test.', 'Tool started: Bash']);
			expect(state.settled).toBe(false);

			child.stdout.emit('data', claudeStream(claudeToolResult('t1', '12 tests passed')));
			child.stdout.emit(
				'data',
				claudeStream(
					claudeResult({ result: 'Done.', usage: { input_tokens: 1, output_tokens: 2 } }),
				),
			);
			child.emit('close', 0, null);
			await promise;

			expect(lines).toEqual([
				'Reading the failing test.',
				'Tool started: Bash',
				'Tool completed: Bash',
				'Done.',
			]);
		});

		it('reports a failed tool as failed, and never leaks tool payloads or raw protocol', async () => {
			const lines: string[] = [];
			const promise = runAgentCli(
				createMockRunAgentCliOptions({ onStdout: (line) => lines.push(line) }),
			);
			const child = lastChild();
			child.stdout.emit(
				'data',
				claudeStream(
					claudeToolUse('t1', 'Bash', { command: 'curl -H "Authorization: Bearer s3cret"' }),
					claudeToolResult('t1', 'token=s3cret leaked to stdout', true),
					{ type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'private' }] } },
					claudeResult({ result: 'Recovered.', usage: { input_tokens: 1, output_tokens: 1 } }),
				),
			);
			child.emit('close', 0, null);
			await promise;

			expect(lines).toEqual(['Tool started: Bash', 'Tool failed: Bash', 'Recovered.']);
			expect(lines.join('\n')).not.toContain('s3cret');
			expect(lines.join('\n')).not.toContain('private');
			expect(lines.some((line) => line.includes('"type"'))).toBe(false);
		});

		it('does not repeat the final assistant text when the terminal record echoes it', async () => {
			const lines: string[] = [];
			const promise = runAgentCli(
				createMockRunAgentCliOptions({ onStdout: (line) => lines.push(line) }),
			);
			const child = lastChild();
			child.stdout.emit(
				'data',
				claudeStream(
					claudeText('Implemented the feature.'),
					claudeResult({
						result: 'Implemented the feature.',
						usage: { input_tokens: 1, output_tokens: 1 },
					}),
				),
			);
			child.emit('close', 0, null);
			const result = await promise;

			expect(lines).toEqual(['Implemented the feature.']);
			expect(result.stdout).toBe('Implemented the feature.');
		});

		it('skips malformed and unknown records without dropping the valid ones around them', async () => {
			const lines: string[] = [];
			const promise = runAgentCli(
				createMockRunAgentCliOptions({ onStdout: (line) => lines.push(line) }),
			);
			const child = lastChild();
			child.stdout.emit('data', '{"type":"assistant","message":{"content":[{"type":"tex\n');
			child.stdout.emit('data', claudeStream({ type: 'stream_event', event: { type: 'ping' } }));
			child.stdout.emit('data', claudeStream(claudeText('Still here.')));
			child.emit('close', 0, null);
			await promise;

			expect(lines).toEqual(['Still here.']);
		});

		it('flushes a trailing partial record once, when the process is killed mid-stream', async () => {
			const lines: string[] = [];
			const controller = new AbortController();
			const promise = runAgentCli(
				createMockRunAgentCliOptions({
					signal: controller.signal,
					onStdout: (line) => lines.push(line),
				}),
			);
			const child = lastChild();
			// The record is split across chunks and the last one never gets its newline.
			child.stdout.emit('data', `${JSON.stringify(claudeText('Half a thought')).slice(0, 40)}`);
			controller.abort();
			child.stdout.emit('data', `${JSON.stringify(claudeText('Half a thought')).slice(40)}`);
			child.emit('close', null, 'SIGKILL');
			const result = await promise;

			expect(lines).toEqual(['Half a thought']);
			expect(result.aborted).toBe(true);
			expect(result.stdout).toBe('Half a thought\n');
		});

		it('drops a single record that grows past the forwarding cap, then resumes', async () => {
			const lines: string[] = [];
			const promise = runAgentCli(
				createMockRunAgentCliOptions({ onStdout: (line) => lines.push(line) }),
			);
			const child = lastChild();
			// One chunk larger than the cap on its own, with no newline to end it.
			child.stdout.emit('data', 'x'.repeat(1_100_000));
			child.stdout.emit('data', `tail of the giant record\n${claudeStream(claudeText('Back.'))}`);
			child.emit('close', 0, null);
			await promise;

			expect(lines).toEqual(['Back.']);
		});

		it('classifies a streamed HTTP 429 as a resumable rate limit', async () => {
			const lines: string[] = [];
			const promise = runAgentCli(
				createMockRunAgentCliOptions({
					sessionId: '11111111-1111-4111-8111-111111111111',
					onStdout: (line) => lines.push(line),
				}),
			);
			const child = lastChild();
			child.stdout.emit('data', claudeStream(claudeText('Starting work.')));
			child.stdout.emit(
				'data',
				claudeStream({
					type: 'result',
					subtype: 'error_during_execution',
					is_error: true,
					result: 'API Error: 429 you have hit your session limit, resets 1:40pm (Europe/Warsaw)',
					session_id: '11111111-1111-4111-8111-111111111111',
					usage: { input_tokens: 10, output_tokens: 3 },
				}),
			);
			child.emit('close', 1, null);
			const result = await promise;

			// The failure reaches the live log as it happens, not only in the result.
			expect(lines.at(-1)).toContain('Claude run failed (error_during_execution)');
			expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 3 });
			// …and the run stays resumable, with the reset time the CLI reported.
			expect(result.sessionId).toBe('11111111-1111-4111-8111-111111111111');
			const failure = classifyAgentFailure(result, new Date('2026-01-01T09:00:00Z'));
			expect(failure.kind).toBe('rate-limit');
			expect(failure.resetHint).toBe('1:40pm (Europe/Warsaw)');
			expect(failure.retryAfter?.toISOString()).toBe('2026-01-01T12:40:00.000Z');
		});

		it('defers a rate-limited run to the reset instant Claude reported', async () => {
			// The shape confirmed against a live `claude --output-format stream-json`
			// run: an exact epoch, where the human banner only offers a wall clock.
			const promise = runAgentCli(createMockRunAgentCliOptions());
			const child = lastChild();
			child.stdout.emit(
				'data',
				claudeStream(
					{
						type: 'rate_limit_event',
						rate_limit_info: {
							status: 'allowed',
							resetsAt: 1_784_755_200,
							rateLimitType: 'five_hour',
						},
					},
					{
						type: 'result',
						subtype: 'error_during_execution',
						is_error: true,
						result: 'API Error: 429 rate_limit_error',
					},
				),
			);
			child.emit('close', 1, null);
			const result = await promise;

			expect(result.rateLimitResetAt?.toISOString()).toBe('2026-07-22T21:20:00.000Z');
			expect(classifyAgentFailure(result).retryAfter?.toISOString()).toBe(
				'2026-07-22T21:20:00.000Z',
			);
		});

		it('keeps a failed terminal record in the log even when the stream around it was truncated', async () => {
			const promise = runAgentCli(createMockRunAgentCliOptions({ maxOutputBytes: 200 }));
			const child = lastChild();
			child.stdout.emit('data', claudeStream(claudeText('y'.repeat(400))));
			child.stdout.emit(
				'data',
				claudeStream({
					type: 'result',
					subtype: 'error_during_execution',
					is_error: true,
					error: { message: 'API Error: 429 rate_limit_error' },
				}),
			);
			child.emit('close', 1, null);
			const result = await promise;

			expect(result.stdout).toBe(
				'Claude run failed (error_during_execution): API Error: 429 rate_limit_error',
			);
			expect(classifyAgentFailure(result).kind).toBe('rate-limit');
		});
	});

	describe('antigravity stream decoding (issue #465)', () => {
		/** Start an agy run and hand back its promise plus the spawned child. */
		const startAgyRun = async (
			options: Partial<Parameters<typeof createMockRunAgentCliOptions>[0]> = {},
		) => {
			const lines: string[] = [];
			const promise = runAgentCli(
				createMockRunAgentCliOptions({
					cli: 'antigravity',
					onStdout: (line) => lines.push(line),
					...options,
				}),
			);
			return { promise, child: await spawnedChild(0), lines };
		};

		it('populates the live log while the run is still in flight (the #356 guard)', async () => {
			// The regression this protects against is "log empty until the process
			// exits" — the reason claude moved off `--output-format json`. agy's
			// `json` format has the same problem, so the harness must decode
			// stream-json progress as it arrives, not at close.
			const { promise, child, lines } = await startAgyRun();
			const settledState = track(promise);

			child.stdout.emit(
				'data',
				agyStream(
					agyInit('d42f7419-1111-2222-3333-444455556666'),
					agyTextDelta(2, 'Reading the '),
					agyTextDelta(2, 'source files.\n'),
				),
			);

			// The decoded line is already out, and the run has NOT finished.
			expect(lines).toEqual(['Reading the source files.']);
			expect(settledState.settled).toBe(false);

			child.emit('close', 0, null);
			await promise;
		});

		it('coalesces deltas into whole lines instead of one event per fragment', async () => {
			const { promise, child, lines } = await startAgyRun();
			// Six deltas that together make two lines — a per-delta forward would
			// write six `run_output_events` rows for what a reader sees as two.
			child.stdout.emit(
				'data',
				agyStream(
					agyTextDelta(2, 'The '),
					agyTextDelta(2, 'first'),
					agyTextDelta(2, ' line.\nThe '),
					agyTextDelta(2, 'second'),
					agyTextDelta(2, ' line.'),
					agyTextDelta(2, '', 'DONE'),
				),
			);
			child.emit('close', 0, null);
			await promise;

			// The unterminated remainder still lands, flushed by the DONE step.
			expect(lines).toEqual(['The first line.', 'The second line.']);
		});

		it('reports tool activity by name only, never its parameters or output', async () => {
			// `tool_info` was observed live carrying file paths and command output —
			// the payload class that must not reach the run page.
			const { promise, child, lines } = await startAgyRun();
			child.stdout.emit(
				'data',
				agyStream(
					{
						event: 'step_update',
						step_update: {
							step_index: 3,
							state: 'ACTIVE',
							step_type: 'tool',
							tool_name: 'view_file',
							tool_info: { parameters: { AbsolutePath: '/secret/path.env' } },
						},
					},
					{
						event: 'step_update',
						step_update: {
							step_index: 3,
							state: 'DONE',
							step_type: 'tool',
							tool_name: 'view_file',
							tool_info: { output: 'API_KEY=hunter2' },
						},
					},
				),
			);
			child.emit('close', 0, null);
			await promise;

			expect(lines).toEqual(['Tool started: view_file', 'Tool completed: view_file']);
			expect(lines.join('\n')).not.toContain('hunter2');
			expect(lines.join('\n')).not.toContain('/secret/path.env');
		});

		it('extracts usage, the conversation id, and the final text from the terminal result', async () => {
			const { promise, child, lines } = await startAgyRun();
			child.stdout.emit(
				'data',
				agyStream(
					agyInit('d42f7419-1111-2222-3333-444455556666'),
					agyTextDelta(2, 'STREAM_OK\n', 'DONE'),
					agyResult({
						conversation_id: 'd42f7419-1111-2222-3333-444455556666',
						response: 'STREAM_OK\n',
						usage: {
							input_tokens: 18267,
							output_tokens: 28,
							thinking_tokens: 22,
							cache_read_tokens: 0,
							total_tokens: 18295,
						},
					}),
				),
			);
			child.emit('close', 0, null);
			const result = await promise;

			expect(result.usage).toEqual({
				inputTokens: 18267,
				outputTokens: 28,
				reasoningTokens: 22,
				cacheReadTokens: 0,
				totalTokens: 18295,
			});
			expect(result.sessionId).toBe('d42f7419-1111-2222-3333-444455556666');
			// The stored log is the readable answer, never the NDJSON protocol.
			expect(result.stdout).toBe('STREAM_OK\n');
			// …and the terminal response isn't echoed a second time after its deltas.
			expect(lines).toEqual(['STREAM_OK']);
		});

		it('surfaces a non-SUCCESS status as a structural failure, not just an exit code', async () => {
			// Verified live against agy 1.1.10 with a bogus --model: status ERROR,
			// detail in `error`, empty `response`, empty `conversation_id`, exit 1.
			const { promise, child, lines } = await startAgyRun();
			child.stdout.emit(
				'data',
				agyStream(agyInit('ef894758-aaaa-bbbb-cccc-ddddeeeeffff'), {
					event: 'result',
					result: {
						conversation_id: '',
						status: 'ERROR',
						response: '',
						error: 'invalid model selection (--model "nope"): model nope is not recognized',
						usage: { input_tokens: 0, output_tokens: 0 },
					},
				}),
			);
			child.emit('close', 1, null);
			const result = await promise;

			expect(result.antigravityFailure).toEqual({
				status: 'ERROR',
				message: 'invalid model selection (--model "nope"): model nope is not recognized',
			});
			// The reason reaches the live log as it happens, not only the result.
			expect(lines.at(-1)).toContain('Antigravity run failed (ERROR)');
			expect(result.stdout).toContain('invalid model selection');
			// The empty conversation_id in the result must not become the session
			// handle — the init event's real id does.
			expect(result.sessionId).toBe('ef894758-aaaa-bbbb-cccc-ddddeeeeffff');
		});

		it('classifies a structural quota failure as a rate limit with no reset hint', async () => {
			const { promise, child } = await startAgyRun();
			child.stdout.emit(
				'data',
				agyStream({
					event: 'result',
					result: { status: 'ERROR', error: 'RESOURCE_EXHAUSTED: quota exceeded for model' },
				}),
			);
			child.emit('close', 1, null);
			const result = await promise;

			expect(classifyAgentFailure(result).kind).toBe('rate-limit');
		});

		it('falls back to the conversation store when the stream carried no id', async () => {
			// A run killed before its `init` event reached us — precisely the
			// rate-limited/timed-out runs resume exists for.
			const dir = mkdtempSync(path.join(tmpdir(), 'agy-conversations-'));
			const previous = process.env.SWARM_ANTIGRAVITY_CONVERSATIONS_DIR;
			process.env.SWARM_ANTIGRAVITY_CONVERSATIONS_DIR = dir;
			try {
				const { promise, child } = await startAgyRun();
				writeFileSync(path.join(dir, 'aaaaaaaa-1111-2222-3333-444444444444.db'), '');
				child.emit('close', 143, null);
				const result = await promise;

				expect(result.sessionId).toBe('aaaaaaaa-1111-2222-3333-444444444444');
			} finally {
				if (previous === undefined) delete process.env.SWARM_ANTIGRAVITY_CONVERSATIONS_DIR;
				else process.env.SWARM_ANTIGRAVITY_CONVERSATIONS_DIR = previous;
				rmSync(dir, { recursive: true, force: true });
			}
		});

		it('keeps the id it resumed with rather than re-reading the stream', async () => {
			const { promise, child } = await startAgyRun({
				resumeSessionId: '08bbd753-411b-4797-a252-9b49087b26e5',
				args: ['continue'],
			});
			child.stdout.emit(
				'data',
				agyStream(agyResult({ conversation_id: '08bbd753-411b-4797-a252-9b49087b26e5' })),
			);
			child.emit('close', 0, null);
			const result = await promise;

			expect(result.sessionId).toBe('08bbd753-411b-4797-a252-9b49087b26e5');
			// --conversation stays before -p, which stays immediately before the prompt.
			expect((spawnMock.mock.calls[0][1] as string[]).slice(-4)).toEqual([
				'--conversation',
				'08bbd753-411b-4797-a252-9b49087b26e5',
				'-p',
				'continue',
			]);
		});

		it('passes out-of-protocol plain text through, keeping the stall signal readable', async () => {
			// `timeout waiting for response` is load-bearing: failure classification
			// keys its `stalled` verdict off that exact trailing line.
			const { promise, child, lines } = await startAgyRun();
			child.stdout.emit('data', 'timeout waiting for response\n');
			child.emit('close', 1, null);
			const result = await promise;

			expect(lines).toEqual(['timeout waiting for response']);
			expect(classifyAgentFailure(result).kind).toBe('stalled');
		});
	});

	describe('usage extraction', () => {
		it('parses the Claude stream into usage, and swaps stdout for the readable result text', async () => {
			const promise = runAgentCli(createMockRunAgentCliOptions());
			const child = lastChild();
			child.stdout.emit(
				'data',
				claudeStream(
					claudeText('All done, implemented the feature.'),
					claudeResult({
						result: 'All done, implemented the feature.',
						session_id: 'sess-7',
						usage: { input_tokens: 100, output_tokens: 50 },
					}),
				),
			);
			child.emit('close', 0, null);

			const result = await promise;
			expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
			expect(result.stdout).toBe('All done, implemented the feature.');
			expect(result.sessionId).toBe('sess-7');
		});

		it('parses Codex JSONL usage and swaps stdout for the agent message', async () => {
			const promise = runAgentCli(createMockRunAgentCliOptions({ cli: 'codex' }));
			const child = lastChild();
			child.stdout.emit(
				'data',
				[
					'{"type":"item.completed","item":{"type":"agent_message","text":"pong"}}',
					'{"type":"turn.completed","usage":{"input_tokens":12201,"cached_input_tokens":9984,"output_tokens":5,"reasoning_output_tokens":0}}',
				].join('\n'),
			);
			child.emit('close', 0, null);

			const result = await promise;
			expect(result.usage).toEqual({
				inputTokens: 12201,
				outputTokens: 5,
				cacheReadTokens: 9984,
				reasoningTokens: 0,
			});
			expect(result.stdout).toBe('pong');
		});

		it('preserves a Codex capacity event after an earlier agent message for failure classification', async () => {
			const promise = runAgentCli(createMockRunAgentCliOptions({ cli: 'codex' }));
			const child = lastChild();
			child.stdout.emit(
				'data',
				[
					'{"type":"item.completed","item":{"type":"agent_message","text":"I completed useful analysis."}}',
					'{"type":"turn.failed","error":{"message":"Selected model is at capacity. Please try a different model."}}',
				].join('\n'),
			);
			child.emit('close', 1, null);

			const result = await promise;
			expect(result.stdout).toBe('I completed useful analysis.');
			expect(result.rawStdout).toContain('"type":"turn.failed"');
			expect(classifyAgentFailure(result)).toEqual({ kind: 'capacity' });
		});

		it('leaves usage undefined and keeps plain, non-protocol stdout for Claude', async () => {
			// A CLI message printed outside the stream protocol (a startup/auth
			// failure) is the one thing worth keeping verbatim — it is not protocol.
			const promise = runAgentCli(createMockRunAgentCliOptions());
			const child = lastChild();
			child.stdout.emit('data', 'plain text, not JSON\n');
			child.emit('close', 0, null);

			const result = await promise;
			expect(result.usage).toBeUndefined();
			expect(result.stdout).toBe('plain text, not JSON\n');
		});

		it('leaves Claude usage undefined when its terminal record was cut off by truncation', async () => {
			const promise = runAgentCli(createMockRunAgentCliOptions({ maxOutputBytes: 5 }));
			const child = lastChild();
			// The terminal record arrives across chunks larger than the tail budget, so
			// the tail retains only its final fragment — unparseable, so usage stays
			// absent. The decoded line still reaches the log once the record completes.
			child.stdout.emit('data', '{"type":"result","subtype":"success","result":"x",');
			child.stdout.emit('data', '"usage":{"input_tokens":1,"output_tokens":2}}\n');
			child.emit('close', 0, null);

			const result = await promise;
			expect(result.usage).toBeUndefined();
			expect(result.stdout).toBe('x\n');
		});

		it('recovers Claude usage from the tail when earlier output floods the cap', async () => {
			const promise = runAgentCli(createMockRunAgentCliOptions({ maxOutputBytes: 200 }));
			const child = lastChild();
			child.stdout.emit('data', claudeStream(claudeText('x'.repeat(400)))); // floods the head cap
			child.stdout.emit(
				'data',
				claudeStream(
					claudeResult({ result: 'done', usage: { input_tokens: 1, output_tokens: 2 } }),
				),
			);
			child.emit('close', 0, null);

			const result = await promise;
			expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
			expect(result.stdout).toBe('done');
		});

		it('leaves Codex usage undefined when its trailing event was cut off by truncation', async () => {
			const promise = runAgentCli(
				createMockRunAgentCliOptions({ cli: 'codex', maxOutputBytes: 10 }),
			);
			const child = lastChild();
			// Same for a Codex event split across chunks past the tail budget: the tail
			// holds a bare fragment with no `turn.completed` line, so nothing parses.
			child.stdout.emit('data', '{"type":"turn.completed","usage":');
			child.stdout.emit('data', '{"input_tokens":1,"output_tokens":2}}');
			child.emit('close', 0, null);

			const result = await promise;
			expect(result.outputTruncated).toBe(true);
			expect(result.usage).toBeUndefined();
		});

		it('recovers Codex usage from the tail when earlier output floods the cap', async () => {
			// Simulates the real failure: a large test suite floods the head buffer
			// (latching truncation), but the small trailing `turn.completed` event —
			// emitted last — still fits within the retained tail and yields usage.
			const promise = runAgentCli(
				createMockRunAgentCliOptions({ cli: 'codex', maxOutputBytes: 100 }),
			);
			const child = lastChild();
			child.stdout.emit('data', `${'x'.repeat(200)}\n`); // floods the head cap
			child.stdout.emit(
				'data',
				'{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":2}}\n',
			);
			child.emit('close', 0, null);

			const result = await promise;
			expect(result.outputTruncated).toBe(true);
			expect(result.usage).toEqual({ inputTokens: 1, outputTokens: 2 });
			// The stored log stays the truncated head — only usage comes from the tail.
			expect(result.stdout).toBe(`${'x'.repeat(200)}\n`);
		});
	});

	it('does not echo output lines to the logger by default, but does when logLines is set', async () => {
		const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
		try {
			const quiet = runAgentCli(createMockRunAgentCliOptions());
			const quietChild = lastChild();
			quietChild.stdout.emit('data', 'quiet line\n');
			quietChild.emit('close', 0, null);
			await quiet;
			// The per-line echo must be silent by default. (The run-summary debug line,
			// "agent run finished", is a separate concern and may fire either way.)
			expect(debugSpy).not.toHaveBeenCalledWith('agent stdout', expect.anything());
			expect(debugSpy).not.toHaveBeenCalledWith('agent stderr', expect.anything());

			const loud = runAgentCli(createMockRunAgentCliOptions({ logLines: true }));
			const loudChild = lastChild();
			loudChild.stdout.emit('data', 'loud line\n');
			loudChild.emit('close', 0, null);
			await loud;
			expect(debugSpy).toHaveBeenCalledWith('agent stdout', { cli: 'claude', line: 'loud line' });
		} finally {
			debugSpy.mockRestore();
		}
	});

	it('merges logContext into the "agent run finished" line so concurrent runs are attributable', async () => {
		const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
		try {
			const promise = runAgentCli(
				createMockRunAgentCliOptions({
					logContext: { taskId: '42', phase: 'review', prNumber: '42' },
				}),
			);
			lastChild().emit('close', 0, null);
			await promise;

			expect(debugSpy).toHaveBeenCalledWith(
				'agent run finished',
				expect.objectContaining({ taskId: '42', phase: 'review', prNumber: '42', cli: 'claude' }),
			);
		} finally {
			debugSpy.mockRestore();
		}
	});

	describe('termination', () => {
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => vi.useRealTimers());

		it('kills on timeout and reports timedOut, escalating to SIGKILL after the grace period', async () => {
			const promise = runAgentCli(createMockRunAgentCliOptions({ timeoutMs: 1_000 }));
			const child = lastChild();

			vi.advanceTimersByTime(1_000);
			expect(child.kill).toHaveBeenCalledWith('SIGTERM');

			// CLI ignores SIGTERM past the grace period → SIGKILL.
			vi.advanceTimersByTime(5_000);
			expect(child.kill).toHaveBeenCalledWith('SIGKILL');

			child.emit('close', null, 'SIGKILL');
			const result = await promise;
			expect(result.timedOut).toBe(true);
			expect(result.aborted).toBe(false);
			expect(result.exitCode).toBeNull();
			expect(result.signal).toBe('SIGKILL');
		});

		it('kills when the abort signal fires, reporting aborted without marking it as a timeout', async () => {
			const controller = new AbortController();
			const promise = runAgentCli(createMockRunAgentCliOptions({ signal: controller.signal }));
			const child = lastChild();

			controller.abort();
			expect(child.kill).toHaveBeenCalledWith('SIGTERM');

			child.emit('close', null, 'SIGTERM');
			const result = await promise;
			expect(result.timedOut).toBe(false);
			expect(result.aborted).toBe(true);
			expect(result.signal).toBe('SIGTERM');
		});

		it('reports aborted even when the CLI traps SIGTERM and exits cleanly with no signal', async () => {
			// Confirmed live (issue: worker --watch restart mid-review): claude
			// exited 143 with signal=null instead of being torn down by the OS —
			// classification must not depend on `signal` being non-null.
			const controller = new AbortController();
			const promise = runAgentCli(createMockRunAgentCliOptions({ signal: controller.signal }));
			const child = lastChild();

			controller.abort();
			child.emit('close', 143, null);
			const result = await promise;
			expect(result.aborted).toBe(true);
			expect(result.signal).toBeNull();
			expect(result.exitCode).toBe(143);
		});

		it('kills immediately when given an already-aborted signal', async () => {
			const promise = runAgentCli(createMockRunAgentCliOptions({ signal: AbortSignal.abort() }));
			const child = lastChild();
			expect(child.kill).toHaveBeenCalledWith('SIGTERM');

			child.emit('close', null, 'SIGTERM');
			const result = await promise;
			expect(result.aborted).toBe(true);
		});
	});
});

describe('describeAgent', () => {
	it('names just the CLI when no model override is set', () => {
		expect(describeAgent('claude')).toBe('claude');
	});

	it('appends the model in parens when one is set', () => {
		expect(describeAgent('claude', 'sonnet')).toBe('claude (sonnet)');
		expect(describeAgent('antigravity', 'Gemini 3.5 Flash (High)')).toBe(
			'antigravity (Gemini 3.5 Flash (High))',
		);
		expect(describeAgent('codex', 'gpt-5.6-sol')).toBe('codex (gpt-5.6-sol)');
	});
});
