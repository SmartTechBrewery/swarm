import { spawn } from 'node:child_process';
import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { RETRY_PENDING_RUN_STATUSES } from '../db/repositories/runsRepository.js';
import { runs } from '../db/schema/runs.js';
import { logger } from '../lib/logger.js';
import type { AgentCli } from './agent-cli.js';
import { probeBinary } from './binary-probe.js';
import { type CliQuotaSnapshot, nameQuotaWindow } from './quota.js';

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
							const windows = [rateLimits?.primary, rateLimits?.secondary]
								.filter((slot) => slot != null)
								.map((slot) => ({
									name: nameQuotaWindow(slot.windowDurationMins),
									durationMins: slot.windowDurationMins,
									usedPercent: slot.usedPercent,
									resetsAt: slot.resetsAt
										? new Date(slot.resetsAt * 1000).toISOString()
										: undefined,
								}));

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

		if (cli === 'codex' && !cheap) {
			try {
				const liveQuota = await queryCodexQuota(binaryName);
				if (liveQuota.status === 'available') {
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
				} else {
					// If live query failed but binary exists, fall back
					snapshots.push({
						cli,
						status: liveQuota.status || 'error',
						source: 'fallback',
						error: liveQuota.error || 'Live quota query failed',
						resetTime: fallbackInfo?.resetTime,
						lastUpdated: now,
					});
				}
			} catch (err: unknown) {
				const errMsg = err instanceof Error ? err.message : String(err);
				snapshots.push({
					cli,
					status: 'error',
					source: 'fallback',
					error: errMsg || 'Error querying live Codex quota',
					resetTime: fallbackInfo?.resetTime,
					lastUpdated: now,
				});
			}
		} else {
			// For claude and antigravity, when configured and runnable, we use run-derived fallback only.
			// Also for codex when cheap = true is requested.
			snapshots.push({
				cli,
				status: 'available',
				source: 'fallback',
				resetTime: fallbackInfo?.resetTime,
				error: fallbackInfo?.error ? `Last failure: ${fallbackInfo.error}` : undefined,
				lastUpdated: now,
			});
		}
	}

	return snapshots;
}
