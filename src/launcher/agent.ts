/**
 * `swarm-worker agent <install|uninstall|status|logs|update> --profile <id>` — manage
 * a profile worker's login service on this host (issue #1323), whichever service
 * manager that is (`./service-manager.ts`).
 *
 * On macOS every action, `update` included, is handed verbatim to the
 * `bin/swarm-worker-agent` the package ships, so the behaviour there is the
 * script's own, byte for byte. On Windows the Task Scheduler manager answers it
 * (`./windows-task.ts`), and `update` is refused exactly as the script refuses
 * `update --profile`: a profile worker runs the runtime its control plane names. It
 * is updated when its installation asks (`swarm workers update`, or the dashboard),
 * and the launcher itself is upgraded by re-running its installer. Elsewhere there is
 * no service manager, and the foreground command is named instead.
 */

import { parseArgs } from 'node:util';
import { runCommand } from '../cli/_shared/exec.js';
import { describeError } from '../lib/errors.js';
import {
	launchdInstallerPath,
	resolveServiceManager,
	type WorkerServiceManager,
} from './service-manager.js';
import { isValidWorkerId } from './worker-profile.js';

export const AGENT_USAGE = `swarm-worker agent — the login service that runs a worker on this host

Usage:
  swarm-worker agent install   --profile <workerId>   install its service and start it
  swarm-worker agent uninstall --profile <workerId>   stop it and remove its service
  swarm-worker agent status    --profile <workerId>   show whether it is installed and running
  swarm-worker agent logs      --profile <workerId>   follow its logs
  swarm-worker agent update                           (macOS clone installs only)

On macOS the service is a launchd LaunchAgent (swarm-worker-agent). On Windows it
is a per-user Task Scheduler task that starts at log on and runs
swarm-worker service-run <workerId>, which starts the worker again whenever it
exits. A profile worker is updated by its installation (swarm workers update, or
the dashboard), never by update.`;

const ACTIONS = ['install', 'uninstall', 'status', 'logs', 'update'] as const;
type Action = (typeof ACTIONS)[number];

export interface AgentDeps {
	platform?: NodeJS.Platform;
	/** The manager for `platform`; resolved from it by default. */
	manager?: WorkerServiceManager | null;
	/** Runs `bin/swarm-worker-agent` with inherited stdio, on macOS. */
	runCommand?: typeof runCommand;
	stdout?: (line: string) => void;
	stderr?: (line: string) => void;
}

/** The update refusal on a platform whose profile workers the script does not manage. */
const UPDATE_REFUSAL =
	"update restarts clone agents only — a profile-based worker runs the runtime its control plane names, not this installation's build; it updates when its installation asks (swarm workers update, or the dashboard), and the launcher by re-running its installer";

export async function runAgent(argv: string[], deps: AgentDeps = {}): Promise<number> {
	const stdout = deps.stdout ?? ((line: string) => console.log(line));
	const stderr = deps.stderr ?? ((line: string) => console.error(line));
	const fail = (message: string) => {
		stderr(`swarm-worker agent: ${message}`);
		return 1;
	};

	const request = parseRequest(argv);
	if ('usage' in request) {
		stdout(AGENT_USAGE);
		return request.error === undefined ? request.usage : fail(request.error);
	}
	const { action, extra, workerId } = request;
	const platform = deps.platform ?? process.platform;
	const manager = deps.manager === undefined ? resolveServiceManager(platform) : deps.manager;
	if (!manager)
		return fail(
			`${platform} has no supported service manager — run the worker with: swarm-worker run ${workerId ?? '<workerId>'}`,
		);

	// The script's own parsing, refusals and wording on macOS — nothing re-derived here.
	const forward = async () => {
		try {
			return await (deps.runCommand ?? runCommand)(launchdInstallerPath(), argv);
		} catch (err) {
			return fail(describeError(err));
		}
	};
	if (action === 'update') return platform === 'darwin' ? forward() : fail(UPDATE_REFUSAL);
	const target = refuseTarget(action, extra, workerId);
	if ('error' in target) return fail(target.error);
	if (platform === 'darwin') return forward();
	return runManaged(action, target.workerId, manager, { stdout, fail });
}

/** The action and its worker, or the usage to print with its exit code (and refusal). */
function parseRequest(
	argv: string[],
):
	| { action: Action; extra: string[]; workerId: string | undefined }
	| { usage: number; error?: string } {
	let parsed: ReturnType<typeof parseAgentArgs>;
	try {
		parsed = parseAgentArgs(argv);
	} catch (err) {
		return { usage: 1, error: describeError(err) };
	}
	const [action, ...extra] = parsed.positionals;
	if (parsed.values.help) return { usage: 0 };
	if (action === undefined) return { usage: 1 };
	if (!ACTIONS.includes(action as Action)) return { usage: 1, error: `unknown action: ${action}` };
	return { action: action as Action, extra, workerId: parsed.values.profile };
}

type ManagedAction = Exclude<Action, 'update'>;

/** The worker `<action> …` names, or why it names none. */
function refuseTarget(
	action: string,
	extra: string[],
	workerId: string | undefined,
): { workerId: string } | { error: string } {
	if (extra.length > 0) return { error: `unexpected argument: ${extra.join(' ')}` };
	if (workerId === undefined) return { error: `${action} needs --profile <workerId>` };
	if (!isValidWorkerId(workerId))
		return { error: `not a valid worker id: ${workerId} (letters, digits, '-' and '_' only)` };
	return { workerId };
}

/** One action, answered by a manager this module drives itself (Task Scheduler). */
async function runManaged(
	action: ManagedAction,
	workerId: string,
	manager: WorkerServiceManager,
	io: { stdout: (line: string) => void; fail: (message: string) => number },
): Promise<number> {
	switch (action) {
		case 'install': {
			const result = await manager.install(workerId);
			if (result.kind === 'installed') return 0;
			return io.fail(result.kind === 'failed' ? result.reason : 'not supported here');
		}
		case 'uninstall':
			return manager.uninstall(workerId);
		case 'status': {
			const { output, installed } = await manager.status(workerId);
			if (!installed) return io.fail(output);
			io.stdout(output);
			return 0;
		}
		case 'logs':
			return manager.logs(workerId);
	}
}

function parseAgentArgs(argv: string[]) {
	return parseArgs({
		args: argv,
		options: { profile: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
		allowPositionals: true,
	});
}
