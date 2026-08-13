import { execFile, spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { promisify } from 'node:util';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { RETRY_PENDING_RUN_STATUSES } from '../db/repositories/runsRepository.js';
import { runs } from '../db/schema/runs.js';
import { logger } from '../lib/logger.js';
import type { AgentCli } from './agent-cli.js';
import {
	answersPrintModeCommands,
	recordPrintModeCommandAnswer,
	supportsOutputFormat,
} from './antigravity-capabilities.js';
import {
	findAntigravityCommandData,
	findAntigravityPrintError,
	readAntigravityCredits,
	readAntigravityQuota,
} from './antigravity-quota.js';
import { probeBinary } from './binary-probe.js';
import { findClaudeResultEvent, isClaudeErrorResult } from './claude-stream.js';
import { bindingUsageWindow, parseClaudeUsageReport } from './claude-usage.js';
import { type CliQuotaSnapshot, nameQuotaWindow } from './quota.js';

const execFileAsync = promisify(execFile);

/**
 * Cheap availability check to verify if the binary exists and runs.
 *
 * Fails **open**: only a probe that proved absence (`ENOENT`) reports `false`,
 * while one that never settled reports `true` (issue #559). The two are separate
 * outcomes in `probeBinary`, and collapsing them the other way is what let a
 * momentarily loaded machine report an installed CLI as missing. A wrong `true`
 * costs one failed quota read that reports its own error; a wrong `false` labels
 * the CLI "not found on PATH" and points the operator at the wrong thing.
 */
export async function isBinaryRunnable(
	command: string,
	args: string[] = ['--version'],
): Promise<boolean> {
	return (await probeBinary(command, { args })) !== 'absent';
}

/**
 * Retrieve the last seen rate limit details from the runs table as a fallback signal.
 */
export async function getFallbackRateLimitInfo(cli: AgentCli) {
	try {
		const db = getDb();
		const rows = await db
			.select({
				error: runs.error,
				nextRetryAt: runs.nextRetryAt,
				completedAt: runs.completedAt,
			})
			.from(runs)
			// Both retry-pending statuses count (issue #503): a `checkpointed` settle is a
			// deferral whose continuation happens to run from a checkpoint rather than a
			// resumed session, and it records the same `next_retry_at` reset hint.
			.where(
				and(
					eq(runs.engine, cli),
					inArray(runs.status, [...RETRY_PENDING_RUN_STATUSES]),
					isNotNull(runs.nextRetryAt),
				),
			)
			.orderBy(desc(runs.completedAt))
			.limit(1);

		const row = rows[0];
		if (!row) return null;

		return {
			error: row.error || undefined,
			resetTime: row.nextRetryAt ? new Date(row.nextRetryAt).toISOString() : undefined,
			lastExhausted: row.completedAt ? new Date(row.completedAt).toISOString() : undefined,
		};
	} catch (err) {
		logger.error(`Failed to fetch fallback rate limit info for ${cli}`, { error: String(err) });
		return null;
	}
}

/**
 * Interacts with the Codex app-server over stdio JSON-RPC protocol to fetch live rate limits.
 */
export function queryCodexQuota(command = 'codex'): Promise<Partial<CliQuotaSnapshot>> {
	return new Promise((resolve) => {
		const child = spawn(command, ['app-server'], {
			stdio: ['pipe', 'pipe', 'ignore'],
		});

		let buffer = '';
		let resolved = false;

		const cleanup = (result: Partial<CliQuotaSnapshot>) => {
			if (resolved) return;
			resolved = true;
			clearTimeout(timeoutId);
			child.kill();
			resolve(result);
		};

		const timeoutId = setTimeout(() => {
			cleanup({
				status: 'error',
				error: 'Codex app-server response timed out',
			});
		}, 8000);

		child.on('error', (err) => {
			cleanup({
				status: 'error',
				error: `Failed to spawn codex app-server: ${err.message}`,
			});
		});

		child.on('exit', (code) => {
			if (!resolved) {
				cleanup({
					status: 'error',
					error: `Codex app-server exited prematurely with code ${code}`,
				});
			}
		});

		const sendJson = (obj: any) => {
			child.stdin.write(`${JSON.stringify(obj)}\n`);
		};

		child.stdout.on('data', (chunk) => {
			buffer += chunk.toString();
			let newlineIndex = buffer.indexOf('\n');
			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);
				if (line) {
					try {
						const response = JSON.parse(line);
						if (response.id === 1) {
							if (response.error) {
								cleanup({
									status: 'error',
									error: `Initialize error: ${response.error.message}`,
								});
								return;
							}
							// Initialization succeeded, query rate limits
							sendJson({
								jsonrpc: '2.0',
								method: 'account/rateLimits/read',
								id: 2,
								params: {},
							});
						} else if (response.id === 2) {
							if (response.error) {
								// If it's a "Not logged in" or auth-related error, treat as unavailable/unauthenticated
								const isAuthError =
									response.error.message?.toLowerCase().includes('log') ||
									response.error.message?.toLowerCase().includes('auth') ||
									response.error.code === -32600; // Not initialized or similar
								cleanup({
									status: isAuthError ? 'unavailable' : 'error',
									error: response.error.message,
								});
								return;
							}

							const result = response.result;
							const rateLimits = result?.rateLimits;
							const creditsObj = rateLimits?.credits;
							const planType = rateLimits?.planType;

							// Both slots go through the same rule: a window is named after the
							// duration Codex reported, and a slot Codex left null contributes
							// nothing at all (issue #669).
							const windows = [
								['primary', rateLimits?.primary],
								['secondary', rateLimits?.secondary],
							].flatMap(([sourceSlot, slot]) => {
								if (slot == null) return [];
								return [
									{
										name: nameQuotaWindow(slot.windowDurationMins),
										sourceSlot,
										durationMins: slot.windowDurationMins,
										usedPercent: slot.usedPercent,
										resetsAt: slot.resetsAt
											? new Date(slot.resetsAt * 1000).toISOString()
											: undefined,
									},
								];
							});

							// The headline figures track the window closest to exhausting rather
							// than whichever slot happened to arrive first, so they stay meaningful
							// whether Codex reports one window or two.
							const limiting = windows.reduce<(typeof windows)[number] | undefined>(
								(worst, w) =>
									worst && (worst.usedPercent ?? -1) >= (w.usedPercent ?? -1) ? worst : w,
								undefined,
							);
							const mainRemaining =
								limiting?.usedPercent === undefined
									? undefined
									: Math.max(0, 100 - limiting.usedPercent);
							const mainReset = limiting?.resetsAt;

							let credits: string | undefined;
							if (creditsObj) {
								const resetCredits = result?.rateLimitResetCredits;
								const count = resetCredits?.availableCount ?? 0;
								credits = `balance: ${creditsObj.balance ?? '0'}, resets: ${count}`;
							}

							cleanup({
								status: 'available',
								remainingPercentage: mainRemaining,
								resetTime: mainReset,
								plan: planType || undefined,
								credits,
								windows,
							});
						}
					} catch (_e) {
						// Ignore parse errors from non-JSON notifications or incomplete chunks
					}
				}
				newlineIndex = buffer.indexOf('\n');
			}
		});

		// Send initialize request
		sendJson({
			jsonrpc: '2.0',
			method: 'initialize',
			id: 1,
			params: {
				clientInfo: {
					name: 'swarm',
					version: '1.0.0',
					title: 'Swarm',
				},
				capabilities: null,
			},
		});
	});
}

/**
 * Budget for one `agy` print-mode command probe. Measured live at ~3.6 s against
 * agy 1.1.12, so the budget is deliberately wide enough for a cold start rather
 * than trimmed to the measurement.
 */
const ANTIGRAVITY_COMMAND_TIMEOUT_MS = 20_000;

/**
 * Cap on the reported detail of a failed probe. A spawn error's message carries
 * the child's stderr, and this string is persisted on the snapshot and rendered
 * on the dashboard.
 */
const MAX_PROBE_ERROR_CHARS = 500;

/**
 * What one `agy` slash-command probe established. The three outcomes are kept
 * apart on purpose: `unanswered` is a *capability* answer (this build predates
 * print-mode slash commands) and must reach the operator as today's silent
 * run-derived fallback, while `failed` is a probe that never got to answer and
 * is surfaced the way a failed Codex probe is.
 */
type AntigravityCommandProbe =
	| { outcome: 'answered'; data: unknown }
	| { outcome: 'unanswered' }
	| { outcome: 'failed'; error: string };

/**
 * Ask `agy` one read-only slash command in print mode and return the structured
 * `command` block it printed.
 *
 * Flag order is load-bearing (ai/RULES.md §6): agy's `-p` is a *value* flag
 * whose value is the prompt, so `--output-format` goes **before** it and the
 * slash command immediately after — a flag landing in between is swallowed as
 * the prompt and the CLI exits 0 having done nothing.
 *
 * `json` rather than `stream-json` here (the harness's own choice for a run):
 * a probe has no live log to keep fed, and the buffered single document is the
 * shape the payload was verified in.
 */
async function probeAntigravityCommand(
	command: string,
	slashCommand: string,
	commandName: string,
): Promise<AntigravityCommandProbe> {
	let stdout = '';
	try {
		stdout = (
			await execFileAsync(command, ['--output-format', 'json', '-p', slashCommand], {
				timeout: ANTIGRAVITY_COMMAND_TIMEOUT_MS,
			})
		).stdout;
	} catch (err) {
		const failure = err as (NodeJS.ErrnoException & { killed?: boolean; stdout?: string }) | null;
		// A CLI that answered and *then* exited non-zero still answered, so its
		// captured output is read below. Only a probe that never ran or ran out of
		// budget is a failure with nothing to inspect.
		if (failure?.code === 'ENOENT' || failure?.code === 'ETIMEDOUT' || failure?.killed === true) {
			// The budget is named rather than asserted as the cause: `killed` also
			// covers an output overflow, and the operator reads this string.
			const detail = failure.message?.trim() || String(failure.code ?? 'killed');
			const budget = failure.killed === true ? ` (budget ${ANTIGRAVITY_COMMAND_TIMEOUT_MS}ms)` : '';
			return {
				outcome: 'failed',
				error: `agy ${slashCommand} probe failed: ${detail.slice(0, MAX_PROBE_ERROR_CHARS)}${budget}`,
			};
		}
		stdout = typeof failure?.stdout === 'string' ? failure.stdout : '';
	}

	const data = findAntigravityCommandData(stdout, commandName);
	if (data !== undefined) return { outcome: 'answered', data };
	const error = findAntigravityPrintError(stdout);
	return error === undefined
		? { outcome: 'unanswered' }
		: {
				outcome: 'failed',
				error: `agy ${slashCommand} probe failed: ${error.slice(0, MAX_PROBE_ERROR_CHARS)}`,
			};
}

/**
 * Read Antigravity's live allowance from `agy`'s print-mode `/quota` command.
 *
 * Returns `undefined` when the installed binary does not answer the command —
 * the run-derived fallback stays in charge and no error reaches the operator.
 * That decision is made from **observed capability**, never a version compare
 * (ai/RULES.md §6). `--output-format` is a necessary, but not sufficient, gate:
 * a binary that lacks it is never spawned at all, while a newer build that treats
 * `/quota` as an ordinary prompt costs one observed probe before this process
 * remembers it cannot answer print-mode commands.
 *
 * `/credits` is a second probe rather than part of the first, because agy
 * reports the balance under its own command — and it is only asked once `/quota`
 * has confirmed the capability, so an older binary is probed exactly once.
 */
export async function queryAntigravityQuota(
	command = 'agy',
): Promise<Partial<CliQuotaSnapshot> | undefined> {
	if (answersPrintModeCommands(command) === false) return undefined;
	if (!(await supportsOutputFormat(command))) return undefined;

	const usage = await probeAntigravityCommand(command, '/quota', 'usage');
	if (usage.outcome === 'failed') return { status: 'error', error: usage.error };
	if (usage.outcome === 'unanswered') {
		recordPrintModeCommandAnswer(command, false);
		logger.debug('agy answered /quota without a command block; keeping the quota fallback', {
			command,
		});
		return undefined;
	}
	recordPrintModeCommandAnswer(command, true);

	const reading = readAntigravityQuota(usage.data);
	if (!reading) return undefined;

	const credits = await probeAntigravityCommand(command, '/credits', 'credits');

	return {
		status: 'available',
		remainingPercentage: reading.remainingPercentage,
		resetTime: reading.resetTime,
		// Best-effort: a balance SWARM couldn't read must not cost the operator the
		// window data that did arrive.
		credits: credits.outcome === 'answered' ? readAntigravityCredits(credits.data) : undefined,
		windows: reading.windows,
	};
}

/**
 * How the probe asks Claude Code for its own usage summary (issue #671).
 *
 * `/usage` is answered by the CLI itself: the envelope of a live run reports
 * `num_turns: 0` and `total_cost_usd: 0`, so the probe starts no agent turn and
 * consumes no allowance. The two flags around it are what keep it side-effect
 * free and cheap:
 *
 * - `--no-session-persistence` writes no transcript, so a probe leaves no
 *   conversation behind for the operator to find in `/resume` (verified: no
 *   `~/.claude/projects/**` entry is created).
 * - `--safe-mode` runs without hooks, MCP servers, plugins, or CLAUDE.md
 *   discovery — the host worker's own cwd is a real project, and a quota read
 *   must not fire its hooks or spawn its MCP servers. It also cuts the probe
 *   from ~3.6 s to ~1.5 s, while leaving auth alone. `--bare` would be cheaper
 *   still and is deliberately **not** used: it restricts Anthropic auth to
 *   `ANTHROPIC_API_KEY`/`apiKeyHelper` and never reads OAuth or the keychain, so
 *   it cannot answer for the subscription user this probe exists to serve.
 *
 * `-p` stays last, immediately before the prompt — safe for claude, whose `-p`
 * is a bare boolean, and the house convention the harness follows for every CLI
 * (see `./agent-cli.ts`).
 */
const CLAUDE_USAGE_ARGS = [
	'--safe-mode',
	'--no-session-persistence',
	'--output-format',
	'json',
	'-p',
	'/usage',
];

/**
 * Budget for one `/usage` probe. Observed 1.5 s steady-state and 8.3 s on a cold
 * start (plugin sync, first-run caches), so this is roughly double the worst
 * measurement — missing it costs one run-derived fallback, which is the same
 * outcome as an older build that cannot answer at all.
 */
const CLAUDE_USAGE_TIMEOUT_MS = 15_000;

/** Cap on the probe's captured output; the real envelope is ~1.5 KB. */
const CLAUDE_USAGE_MAX_OUTPUT_BYTES = 1024 * 1024;

/** Why a probe didn't answer, in one line — a timeout named as such. */
function describeProbeFailure(err: unknown): string {
	const error = err as (NodeJS.ErrnoException & { killed?: boolean }) | undefined;
	if (error?.killed === true || error?.code === 'ETIMEDOUT') {
		return `timed out after ${CLAUDE_USAGE_TIMEOUT_MS}ms`;
	}
	return error?.message ?? String(err);
}

/**
 * Read Claude Code's live usage windows from its own print-mode `/usage` answer.
 *
 * Mirrors {@link queryCodexQuota}'s contract — resolves, never rejects, and
 * reports `status: 'available'` only with real data — but the failure states are
 * deliberately split in two, because for Claude they mean different things.
 * A probe that couldn't run (`'error'`) is a broken or absent capability, while
 * a probe that ran and returned prose this build doesn't recognize
 * (`'unavailable'`) is simply "no live data": the answer is unstructured, so a
 * reworded release must degrade the card rather than fail it (issue #671).
 */
export async function queryClaudeQuota(command = 'claude'): Promise<Partial<CliQuotaSnapshot>> {
	let stdout: string;
	try {
		const probe = await execFileAsync(command, CLAUDE_USAGE_ARGS, {
			timeout: CLAUDE_USAGE_TIMEOUT_MS,
			maxBuffer: CLAUDE_USAGE_MAX_OUTPUT_BYTES,
		});
		stdout = probe.stdout;
	} catch (err) {
		return { status: 'error', error: `claude /usage probe failed: ${describeProbeFailure(err)}` };
	}

	// `--output-format json` prints exactly the terminal `result` record a stream
	// ends with, so the stream decoder already models this envelope.
	const event = findClaudeResultEvent(stdout);
	if (!event || isClaudeErrorResult(event) || !event.result) {
		return { status: 'unavailable', error: 'claude /usage returned no usage report' };
	}

	const windows = parseClaudeUsageReport(event.result, new Date());
	if (!windows) {
		return {
			status: 'unavailable',
			error: 'claude /usage reported no recognized usage window',
		};
	}

	const binding = bindingUsageWindow(windows);
	return {
		status: 'available',
		remainingPercentage: Math.max(0, 100 - (binding?.usedPercent ?? 0)),
		resetTime: binding?.resetsAt,
		windows,
	};
}

/** What {@link getFallbackRateLimitInfo} recovered for a CLI, if anything. */
type FallbackRateLimitInfo = Awaited<ReturnType<typeof getFallbackRateLimitInfo>>;

/**
 * Today's snapshot for an installed CLI with no live quota read: the only signal
 * is a *past* exhaustion recovered from `runs.next_retry_at`, so it reports no
 * windows and no remaining allowance.
 *
 * `liveReason` records why a live probe didn't answer. It is appended to the
 * run-derived error rather than replacing it, and the status stays `available`
 * on purpose — an operator on a build or auth mode that cannot answer must see
 * today's card, not a red diagnostic row (issue #671).
 */
function runDerivedSnapshot(
	cli: AgentCli,
	fallbackInfo: FallbackRateLimitInfo,
	lastUpdated: string,
	liveReason?: string,
): CliQuotaSnapshot {
	const error = [
		fallbackInfo?.error ? `Last failure: ${fallbackInfo.error}` : undefined,
		liveReason,
	]
		.filter(Boolean)
		.join(' · ');
	return {
		cli,
		status: 'available',
		source: 'fallback',
		resetTime: fallbackInfo?.resetTime,
		error: error || undefined,
		lastUpdated,
	};
}

/**
 * The live quota read for one CLI, or `undefined` when there is none to make —
 * the installed binary doesn't support the live path it has.
 */
function queryLiveQuota(
	cli: AgentCli,
	command: string,
): Promise<Partial<CliQuotaSnapshot> | undefined> {
	if (cli === 'codex') return queryCodexQuota(command);
	if (cli === 'antigravity') return queryAntigravityQuota(command);
	if (cli === 'claude') return queryClaudeQuota(command);
	return Promise.resolve(undefined);
}

/**
 * The machine {@link discoverCliQuotas} is probing — the name a snapshot is
 * stored under (issue #703).
 *
 * Both writers call this rather than resolving the host themselves, so they
 * agree on one string; `os.hostname()` is also how a worker daemon already
 * names its host in the connect handshake (`src/transport/connect-entry.ts`),
 * so a future worker-reported snapshot keys on the same name.
 */
export function discoveryHost(): string {
	return hostname();
}

/**
 * Discover CLI capabilities and build quota snapshots for all known agent CLIs.
 */
export async function discoverCliQuotas(cheap = false): Promise<CliQuotaSnapshot[]> {
	const clis: AgentCli[] = ['claude', 'antigravity', 'codex'];
	const snapshots: CliQuotaSnapshot[] = [];
	const now = new Date().toISOString();

	for (const cli of clis) {
		const binaryName = cli === 'antigravity' ? 'agy' : cli;
		const isInstalled = await isBinaryRunnable(binaryName);

		if (!isInstalled) {
			snapshots.push({
				cli,
				status: 'unavailable',
				source: 'fallback',
				error: `${cli} binary not found on PATH`,
				lastUpdated: now,
			});
			continue;
		}

		// Fallback signal from runs table
		const fallbackInfo = await getFallbackRateLimitInfo(cli);

		// `cheap` keeps every live probe out of a hot path; a binary that doesn't
		// support the live path it has yields `undefined` and drops through to the
		// run-derived branch below.
		let liveQuota: Partial<CliQuotaSnapshot> | undefined;
		if (!cheap) {
			try {
				liveQuota = await queryLiveQuota(cli, binaryName);
			} catch (err: unknown) {
				const errMsg = err instanceof Error ? err.message : String(err);
				liveQuota = {
					status: 'error',
					error: errMsg || `Error querying live ${cli} quota`,
				};
			}
		}

		if (liveQuota?.status === 'available') {
			snapshots.push({
				cli,
				status: 'available',
				remainingPercentage: liveQuota.remainingPercentage,
				resetTime: liveQuota.resetTime,
				plan: liveQuota.plan,
				credits: liveQuota.credits,
				source: 'live',
				lastUpdated: now,
				windows: liveQuota.windows,
			});
			continue;
		}

		if (liveQuota && cli === 'claude') {
			// Claude's own exception (issue #671): an operator on a build or auth mode
			// that cannot answer must see today's card, not a red diagnostic row, so
			// the status stays `available` rather than propagating 'error'/'unavailable'.
			const reason = liveQuota.error || 'Live quota query failed';
			logger.debug('claude live quota unavailable, using run-derived fallback', { reason });
			snapshots.push(runDerivedSnapshot(cli, fallbackInfo, now, reason));
			continue;
		}

		if (liveQuota) {
			// The live query ran and didn't answer: fall back, recording why.
			snapshots.push({
				cli,
				status: liveQuota.status || 'error',
				source: 'fallback',
				error: liveQuota.error || 'Live quota query failed',
				resetTime: fallbackInfo?.resetTime,
				lastUpdated: now,
			});
			continue;
		}

		// No live read was possible (a cheap pass, or no live path/capability for
		// this CLI/binary), so the run-derived signal is all there is.
		snapshots.push(runDerivedSnapshot(cli, fallbackInfo, now));
	}

	return snapshots;
}
