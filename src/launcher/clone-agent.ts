/**
 * The **clone agents** on this Mac: the LaunchAgents `swarm-worker-agent install
 * <checkout>` wrote for clone-based workers — the ones whose ProgramArguments run
 * `<clone>/bin/swarm.js run:worker` with the worker's checkout as their working
 * directory (issue #1313). `swarm-worker migrate` reads them to find which clone a
 * worker runs from and which installation it connects to.
 *
 * This is `bin/swarm-worker-agent`'s own reading — `clone_launcher` and
 * `agents_of_install_root` — in TypeScript: the same label glob, the same
 * `run:worker` test, and the launcher (the argument right before `run:worker`)
 * resolved through every symlink to the installation it belongs to, since an older
 * plist names it by its PATH symlink. The launcher is found by that neighbour rather
 * than by position because a host's launchd wrapper (`~/.swarm/launchd-wrapper`,
 * issue #1376) is prepended to every agent's ProgramArguments, which shifts
 * `ProgramArguments.1` onto `node`. A profile agent (`swarm-worker run <id>`) is
 * never one of them.
 *
 * Plists are read with `plutil -convert json`, macOS's own parser, so a hand-edited
 * binary plist reads too. A plist that cannot be read or is not an agent's shape is
 * skipped, exactly as the shell script skips one `plutil` cannot extract from.
 *
 * Bundle-safe like the rest of `src/launcher/`: nothing from the daemon graph.
 */

import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';
import { WORKER_LAUNCH_AGENT_LABEL_PREFIX } from '../lib/worker-supervision.js';
import { canonicalCheckoutPath } from '../worktree/checkout-key.js';

/** The variable a clone's daemon reads its installation from. */
const CONTROL_PLANE_ENV = 'SWARM_CONTROL_PLANE_URL';

const AgentPlistSchema = z.object({
	ProgramArguments: z.array(z.string()),
	WorkingDirectory: z.string().min(1),
	EnvironmentVariables: z.record(z.string(), z.unknown()).optional(),
});

/** One clone agent, as its plist describes it. */
export interface CloneAgent {
	label: string;
	plistPath: string;
	/** The canonical checkout the agent's daemon serves (its WorkingDirectory). */
	checkout: string;
	/** The SWARM clone whose `bin/swarm.js` it runs, with every symlink resolved. */
	cloneRoot: string;
	/** What the plist sets in the daemon's environment, string values only. */
	environment: Record<string, string>;
}

/** Reads a plist into plain JSON; rejects when it cannot. */
export type PlistReader = (path: string) => Promise<unknown>;

/** `plutil -convert json -o - <path>`, parsed. */
export const readPlistWithPlutil: PlistReader = (path) =>
	new Promise((resolvePlist, reject) => {
		execFile(
			'plutil',
			['-convert', 'json', '-o', '-', path],
			{ timeout: 15_000 },
			(error, stdout) => {
				if (error) {
					reject(error);
					return;
				}
				try {
					resolvePlist(JSON.parse(stdout));
				} catch (err) {
					reject(err);
				}
			},
		);
	});

export interface ListCloneAgentsOptions {
	homeDir?: string;
	readPlist?: PlistReader;
}

/** `<homeDir>/Library/LaunchAgents`. */
export function launchAgentsDir(homeDir?: string): string {
	return resolve(homeDir ?? homedir(), 'Library', 'LaunchAgents');
}

/** Every clone agent installed for this user, sorted by label. */
export async function listCloneAgents(options: ListCloneAgentsOptions = {}): Promise<CloneAgent[]> {
	const dir = launchAgentsDir(options.homeDir);
	const readPlist = options.readPlist ?? readPlistWithPlutil;
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	const agents: CloneAgent[] = [];
	for (const name of names.sort()) {
		if (!name.startsWith(WORKER_LAUNCH_AGENT_LABEL_PREFIX) || !name.endsWith('.plist')) continue;
		const plistPath = join(dir, name);
		let raw: unknown;
		try {
			raw = await readPlist(plistPath);
		} catch {
			continue;
		}
		const parsed = AgentPlistSchema.safeParse(raw);
		if (!parsed.success) continue;
		const { ProgramArguments: args, WorkingDirectory, EnvironmentVariables } = parsed.data;
		const launcher = args[args.indexOf('run:worker') - 1];
		if (!launcher) continue;
		agents.push({
			label: name.slice(0, -'.plist'.length),
			plistPath,
			checkout: canonicalCheckoutPath(WorkingDirectory),
			cloneRoot: installRootOf(launcher),
			environment: Object.fromEntries(
				Object.entries(EnvironmentVariables ?? {}).filter(
					(entry): entry is [string, string] => typeof entry[1] === 'string',
				),
			),
		});
	}
	return agents;
}

/** `<clone>` for a launcher at `<clone>/bin/swarm.js`, through every symlink. */
function installRootOf(launcher: string): string {
	let real = resolve(launcher);
	try {
		real = realpathSync(real);
	} catch {
		// A launcher that is gone still names the clone it was written for.
	}
	return dirname(dirname(real));
}

/**
 * The installation a clone agent's daemon connects to: `SWARM_CONTROL_PLANE_URL`
 * as the plist sets it, else as `<clone>/.env` assigns it — the daemon's own
 * precedence, since `run:worker` loads that `.env` with `--env-file-if-exists`,
 * which never overrides a variable already set. `undefined` when neither does.
 */
export function cloneAgentControlPlaneUrl(agent: CloneAgent): string | undefined {
	const fromPlist = agent.environment[CONTROL_PLANE_ENV]?.trim();
	if (fromPlist) return fromPlist;
	let contents: string;
	try {
		contents = readFileSync(join(agent.cloneRoot, '.env'), 'utf8');
	} catch {
		return undefined;
	}
	return parseEnv(contents)[CONTROL_PLANE_ENV]?.trim() || undefined;
}
