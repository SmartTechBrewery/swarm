/**
 * `swarm-worker status [<workerId>]` — what this host's profile-based workers are
 * doing (issue #1311), with no SWARM clone and no dashboard session.
 *
 * For each profile under `~/.swarm/workers/` it reports three views, each from the
 * place that actually knows:
 *
 *   - **the LaunchAgent**, from `swarm-worker-agent status --profile <id>` — the
 *     installer the package ships, so launchd's own answer (loaded, pid, last exit)
 *     is printed rather than re-derived. launchd is macOS-only; elsewhere it says
 *     so and names the foreground command.
 *   - **the runtime**, from the worker's `state.json`: the version it is selected to
 *     run, whether that is installed, and the one it last started on.
 *   - **the control plane**, from `workers.listMine` when this host holds a live
 *     session for the profile's installation: connected or not, last seen, drained,
 *     and each enrollment's state. With no live session it shows the local view and
 *     says to run `swarm-worker login`, rather than reporting the worker offline.
 *
 * It exits 0 only when every worker it reports is connected, so a script can gate
 * on it. No `.env` is read: each profile names its own installation.
 */

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { launcherCommand } from '../cli/_shared/installation-command.js';
import {
	type FetchLike,
	OperatorApiError,
	type OperatorClient,
	type OperatorSession,
} from '../cli/_shared/operator-client.js';
import * as out from '../cli/_shared/output.js';
import { REPO_ROOT } from '../cli/_shared/paths.js';
import { cachedSession, loginCommandFor, operatorClientFor } from './operator-session.js';
import { installedRuntime } from './runtime-store.js';
import {
	isValidWorkerId,
	type ListedWorkerProfile,
	listWorkerProfiles,
	readWorkerState,
} from './worker-profile.js';

export const STATUS_USAGE = `swarm-worker status — report this host's profile workers

Usage:
  swarm-worker status [<workerId>]

For each worker profile on this host (or just <workerId>): its LaunchAgent
(swarm-worker-agent status --profile <id>), the runtime it is selected to run
(~/.swarm/workers/<id>/state.json), and — when you are signed in to its
installation — whether the control plane sees it connected, when it was last
seen, whether it is drained, and its enrollments. Without a session it shows the
local view and says to run swarm-worker login.

Exits 0 when every worker reported is connected, non-zero otherwise.`;

/**
 * One of the caller's own workers as `workers.listMine` answers it — only the fields
 * read here. Everything past the id and name is optional, on `swarm workers`' own
 * rule: a control plane answering with fewer fields (an older one, with no
 * `connection`) is reported as "unknown", not as a parse failure.
 */
const OwnWorkerSchema = z.object({
	workerId: z.string().min(1),
	displayName: z.string().min(1),
	connection: z.string().optional(),
	lastSeenAt: z.string().nullable().optional(),
	drainingSince: z.string().nullable().optional(),
	enrollments: z
		.array(
			z.object({
				projectId: z.string().min(1),
				status: z.string().min(1),
				sharingConsent: z.boolean().optional(),
			}),
		)
		.optional(),
});
export type OwnWorker = z.infer<typeof OwnWorkerSchema>;

/** `workers.listMine`, parsed. A refusal propagates as the `OperatorApiError` it is. */
export async function listOwnWorkers(client: OperatorClient): Promise<OwnWorker[]> {
	return client.query('workers.listMine', undefined, (value) =>
		z.array(OwnWorkerSchema).parse(value),
	);
}

/** The LaunchAgent's own report, or `null` where there is no launchd. */
export type AgentStatusReader = (workerId: string) => Promise<{ output: string } | null>;

export interface StatusDeps {
	fetch?: FetchLike;
	createClient?: (session: OperatorSession) => OperatorClient;
	agentStatus?: AgentStatusReader;
	homeDir?: string;
	now?: () => number;
}

/** `swarm-worker-agent status --profile <id>`, captured; `null` off macOS. */
export function defaultAgentStatus(
	platform: NodeJS.Platform = process.platform,
): AgentStatusReader {
	return (workerId) => {
		if (platform !== 'darwin') return Promise.resolve(null);
		const installer = join(REPO_ROOT, 'bin', 'swarm-worker-agent');
		return new Promise((resolve) => {
			execFile(
				installer,
				['status', '--profile', workerId],
				{ timeout: 15_000 },
				(error, stdout, stderr) => {
					const text = `${stdout}${stderr}`.trim();
					resolve({ output: text || (error ? error.message : '') });
				},
			);
		});
	};
}

/** What the control plane said about one installation's workers. */
type RemoteView =
	| { kind: 'rows'; rows: OwnWorker[] }
	| { kind: 'signed-out' }
	| { kind: 'failed'; error: string };

async function remoteView(controlPlaneUrl: string, deps: StatusDeps): Promise<RemoteView> {
	const session = cachedSession(controlPlaneUrl, { homeDir: deps.homeDir, now: deps.now });
	if (!session) return { kind: 'signed-out' };
	const client = (deps.createClient ?? ((s) => operatorClientFor(s, deps.fetch)))(session);
	try {
		return { kind: 'rows', rows: await listOwnWorkers(client) };
	} catch (err) {
		if (!(err instanceof OperatorApiError)) throw err;
		return { kind: 'failed', error: err.message };
	}
}

function describeRuntime(workerId: string, homeDir: string | undefined): string {
	const state = readWorkerState(workerId, homeDir);
	if (state === null) return 'not started by the launcher yet';
	if (state === undefined) return 'its state.json could not be read';
	const installed = (version: string) =>
		installedRuntime(version, homeDir) ? 'installed' : 'not installed';
	const parts: string[] = [];
	if (state.selectedVersion)
		parts.push(`selected v${state.selectedVersion} (${installed(state.selectedVersion)})`);
	parts.push(`last started v${state.lastRuntimeVersion} at ${state.startedAt}`);
	if (state.pendingVerification)
		parts.push(
			`v${state.pendingVerification.version} has not connected yet (${state.pendingVerification.failedStarts} start(s))`,
		);
	return parts.join(', ');
}

/** Print the control plane's view of one worker; answers whether it is connected. */
function reportRemote(workerId: string, controlPlaneUrl: string, view: RemoteView): boolean {
	if (view.kind === 'signed-out') {
		out.info(
			`  control plane: not signed in — run ${loginCommandFor(controlPlaneUrl)} to see whether it is connected`,
		);
		return false;
	}
	if (view.kind === 'failed') {
		out.info(`  control plane: ${view.error}`);
		return false;
	}
	const row = view.rows.find((candidate) => candidate.workerId === workerId);
	if (!row) {
		out.info(
			'  control plane: not among your workers there — it was removed, or registered by another account',
		);
		return false;
	}
	out.info(`  control plane: ${describeConnection(row)}`);
	const enrollments = row.enrollments ?? [];
	for (const enrollment of enrollments) {
		const consent =
			enrollment.sharingConsent === undefined
				? ''
				: `, sharing consent ${enrollment.sharingConsent ? 'on' : 'off'}`;
		out.info(`  enrollment: ${enrollment.projectId} — ${enrollment.status}${consent}`);
	}
	if (enrollments.length === 0) out.info('  enrollment: none');
	return row.connection === 'online';
}

/** `connected, last seen …, drained since …` — whatever the row says. */
function describeConnection(row: OwnWorker): string {
	const connected = row.connection === 'online';
	let connection = connected ? 'connected' : 'not connected';
	if (row.connection === undefined)
		connection = 'connection unknown (the control plane does not report it)';
	let seen = row.lastSeenAt ? `, last seen ${row.lastSeenAt}` : '';
	if (!row.lastSeenAt && !connected) seen = ', never seen';
	const drained = row.drainingSince ? `, drained since ${row.drainingSince}` : '';
	return `${connection}${seen}${drained}`;
}

/** The profiles `status` reports on — every one, or just `wanted` — or the refusal. */
function selectProfiles(
	positionals: string[],
	homeDir: string | undefined,
): ListedWorkerProfile[] | { error: string } {
	const [wanted, ...extra] = positionals;
	if (extra.length > 0) return { error: 'swarm-worker status takes at most one <workerId>' };
	if (wanted !== undefined && !isValidWorkerId(wanted))
		return { error: `swarm-worker status: ${JSON.stringify(wanted)} is not a valid worker id` };
	const profiles = listWorkerProfiles(homeDir).filter(
		(listed) => wanted === undefined || listed.workerId === wanted,
	);
	if (profiles.length > 0) return profiles;
	return {
		error:
			wanted === undefined
				? 'no worker profiles on this host — set one up with: swarm-worker setup'
				: `no profile for worker '${wanted}' on this host`,
	};
}

/** Print the LaunchAgent's own report for one worker. */
async function reportAgent(workerId: string, agentStatus: AgentStatusReader): Promise<void> {
	const agent = await agentStatus(workerId);
	if (agent === null) {
		out.info(
			`  LaunchAgent: none (launchd is macOS-only) — run it with: ${launcherCommand()} run ${workerId}`,
		);
		return;
	}
	out.info('  LaunchAgent:');
	for (const line of agent.output.split('\n')) out.info(`    ${line.trim()}`);
}

export async function runStatus(argv: string[], deps: StatusDeps = {}): Promise<number> {
	let parsed: ReturnType<typeof parseStatusArgs>;
	try {
		parsed = parseStatusArgs(argv);
	} catch (err) {
		out.error(`swarm-worker status: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
	if (parsed.values.help) {
		console.log(STATUS_USAGE);
		return 0;
	}
	const profiles = selectProfiles(parsed.positionals, deps.homeDir);
	if ('error' in profiles) {
		out.error(profiles.error);
		return 1;
	}

	const agentStatus = deps.agentStatus ?? defaultAgentStatus();
	// One `workers.listMine` per installation, however many of its workers are here.
	const views = new Map<string, Promise<RemoteView>>();
	let allConnected = true;
	for (const { workerId, path, profile } of profiles) {
		if (!profile) {
			out.info(`worker ${workerId}: its profile could not be read (${path})`);
			allConnected = false;
			continue;
		}
		const url = profile.controlPlaneUrl;
		out.info(`worker ${workerId} on ${url}`);
		out.info(`  checkouts: ${profile.repoRoots.join(', ')}`);
		await reportAgent(workerId, agentStatus);
		out.info(`  runtime: ${describeRuntime(workerId, deps.homeDir)}`);
		const view = views.get(url) ?? remoteView(url, deps);
		views.set(url, view);
		if (!reportRemote(workerId, url, await view)) allConnected = false;
	}
	return allConnected ? 0 : 1;
}

function parseStatusArgs(argv: string[]) {
	return parseArgs({
		args: argv,
		options: { help: { type: 'boolean', short: 'h' } },
		allowPositionals: true,
	});
}
