/**
 * DB-free discovery of the agent CLIs a remote daemon can actually run, used by
 * the worker transport client (`./worker-client.ts`) to declare its capabilities
 * at handshake. It probes the developer's PATH for each `AgentCli`'s binary — the
 * same set the harness knows how to launch (`../harness/agent-cli.ts`) — and
 * nothing more.
 *
 * The in-process host worker declares capabilities via `discoverCliQuotas`
 * (`../harness/quota-discovery.ts`), but that path reads the `runs` table for a
 * fallback rate-limit signal and so pulls in the DB client. A remote daemon holds
 * **only** its credential and the control-plane URL — no `DATABASE_URL` — so this
 * module deliberately reuses none of that: it depends on nothing under `../db/*`
 * or the queue, matching the transport client's no-datastore contract (ADR-003
 * §1). Availability here is the cheap "does the binary run" check alone; quota
 * telemetry rides the optional heartbeat health, not the capability set.
 *
 * **Discovery never narrows the set on a guess** (issue #559). The declared set
 * is what the control plane checks the worker's enrollments against, and a set
 * missing a required CLI is a fatal handshake rejection — so a CLI is dropped
 * only on proof it is absent (`ENOENT`), never on a probe that merely failed to
 * settle. An unsettled probe is retried once, serially and with a wider budget,
 * and if it still has no answer the CLI is declared anyway: over-declaring costs
 * one failed assignment, under-declaring costs the whole daemon.
 */

import { type AgentCli, AgentCliSchema } from '../harness/agent-cli.js';
import { type BinaryProbeOutcome, probeBinary } from '../harness/binary-probe.js';
import { logger } from '../lib/logger.js';

/**
 * Binary name per agent CLI. Antigravity's CLI binary is `agy`, not
 * `antigravity` (the enum value is SWARM's internal identifier, not the binary) —
 * the same mapping the harness and `discoverCliQuotas` use.
 */
const CLI_BINARY: Record<AgentCli, string> = {
	claude: 'claude',
	antigravity: 'agy',
	codex: 'codex',
};

/**
 * Budget for the re-probe of a CLI the first round could not settle. Wider than
 * the default, and spent one CLI at a time: the first round runs all three
 * concurrently, which is precisely the contention a loaded machine starves, so
 * the retry removes both variables at once.
 */
const RETRY_PROBE_TIMEOUT_MS = 15_000;

/** What the PATH probe established about each agent CLI on this host. */
export interface CliProbeReport {
	/** The set to declare at handshake: proven present, plus anything unsettled. */
	declared: AgentCli[];
	/** Proven absent (`ENOENT`) — the only outcome that drops a CLI. */
	absent: AgentCli[];
	/** Declared without a confirmed probe, after the retry also failed to settle. */
	unconfirmed: AgentCli[];
}

/**
 * Probe every agent CLI on PATH and report what was established, including the
 * ones the probe could not settle. {@link discoverAvailableClis} is the plain
 * "what do I declare" caller; this is for anything that also needs to say how
 * confident that answer is.
 */
export async function probeAvailableClis(): Promise<CliProbeReport> {
	const clis = AgentCliSchema.options;
	const outcomes = new Map<AgentCli, BinaryProbeOutcome>(
		await Promise.all(
			clis.map(
				async (cli) => [cli, await probeBinary(CLI_BINARY[cli])] as [AgentCli, BinaryProbeOutcome],
			),
		),
	);

	for (const [cli, outcome] of [...outcomes]) {
		if (outcome !== 'indeterminate') continue;
		logger.warn('agent CLI probe did not settle; re-probing before declaring capabilities', {
			cli,
			binary: CLI_BINARY[cli],
			timeoutMs: RETRY_PROBE_TIMEOUT_MS,
		});
		outcomes.set(cli, await probeBinary(CLI_BINARY[cli], { timeoutMs: RETRY_PROBE_TIMEOUT_MS }));
	}

	const report: CliProbeReport = { declared: [], absent: [], unconfirmed: [] };
	for (const cli of clis) {
		const outcome = outcomes.get(cli);
		if (outcome === 'absent') {
			report.absent.push(cli);
			continue;
		}
		report.declared.push(cli);
		if (outcome === 'indeterminate') {
			report.unconfirmed.push(cli);
			logger.warn('declaring an agent CLI its probe never confirmed', {
				cli,
				binary: CLI_BINARY[cli],
				reason: 'the probe timed out twice, which is no evidence the binary is missing',
			});
		}
	}
	return report;
}

/**
 * The agent CLIs runnable on this host, probed by binary availability on PATH.
 * The set the daemon declares at handshake; empty only when every CLI answered
 * `ENOENT` (the entrypoint treats that as a clear startup error, since the
 * handshake requires a non-empty capability set).
 */
export async function discoverAvailableClis(): Promise<AgentCli[]> {
	return (await probeAvailableClis()).declared;
}

/**
 * Parse an explicit `SWARM_WORKER_TRANSPORT_CLIS` override — a comma-separated
 * list of `AgentCli` values — into a validated, de-duplicated set. Returns
 * `undefined` when the raw value is empty (fall back to PATH discovery); throws on
 * any token that is not a known CLI, so a typo is a loud startup failure rather
 * than a silently narrowed capability set.
 */
export function parseDeclaredClisOverride(raw: string | undefined): AgentCli[] | undefined {
	if (!raw) return undefined;
	const tokens = raw
		.split(',')
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
	if (tokens.length === 0) return undefined;
	const parsed = tokens.map((token) => {
		const result = AgentCliSchema.safeParse(token);
		if (!result.success) {
			throw new Error(
				`SWARM_WORKER_TRANSPORT_CLIS contains an unknown CLI '${token}'; valid values are ${AgentCliSchema.options.join(', ')}`,
			);
		}
		return result.data;
	});
	return [...new Set(parsed)];
}
