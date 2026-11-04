/**
 * A profile worker under **Windows Task Scheduler** (issue #1323): the Windows
 * manager behind `./service-manager.ts`, doing for a profile worker what
 * `bin/swarm-worker-agent --profile` does with a LaunchAgent on macOS.
 *
 * The worker is one per-user task in the root task folder (no subfolder, so no
 * folder-creation rights are needed), triggered **at log on** and run in the user's
 * own interactive session with least privilege — no stored password and no admin,
 * so git's Credential Manager and the agent CLIs' per-user sign-ins work exactly as
 * they do for a LaunchAgent in the user's GUI session. The task runs
 * `conhost.exe --headless "<node>" "<launcher>\bin\swarm-worker.js" service-run <id>`:
 * `--headless` keeps a console window from opening at every login, and `service-run`
 * (`./service-run.ts`) is the keep-alive loop. It is needed because Task Scheduler,
 * unlike launchd's `KeepAlive`, does not start a task again when it exits 0 — which
 * is exactly how a daemon exits for its supervisor after an ADR-006/007 update.
 * `RestartOnFailure` is set too, but only as a backstop for the loop itself.
 *
 * `<launcher>` is this installation's own launcher root (`LAUNCHER_INSTALL_ROOT`),
 * the same rule the plist follows, so re-running the installer over
 * `~/.swarm/launcher` in place is picked up at the next start.
 *
 * Load-bearing rules:
 *
 *   - **The task name mirrors the LaunchAgent label**: `swarm.worker.<host-slug>.
 *     <id-slug>.<sha256(url "\n" workerId)[0:8]>`, built from the profile exactly as
 *     `label_slug` / `resolve_profile` build it in `bin/swarm-worker-agent`, so two
 *     installations' workers on one host never share a task.
 *   - **The credential is never read out of the profile** for anything here — only
 *     its URL and checkouts — and never reaches the task's XML or command line.
 *   - **A task whose profile is gone can still be removed**: `uninstall`, `status`
 *     and `logs` fall back to finding the installed task by its `.<id>.<hash>`
 *     suffix, as the script falls back to the plist's `WorkingDirectory`.
 *   - **Every `schtasks` / `taskkill` / `powershell` call is an argument array to an
 *     absolute `%SystemRoot%\System32` path**, with no shell in between.
 *   - **A recorded pid is never killed on its liveness alone.** Windows reuses pids,
 *     and a loop ended without its `finally` (Task Manager, a crash, logoff) leaves
 *     `service.pid` behind, so `taskkill /T /F` on that pid could take down an
 *     unrelated process tree. The pid counts as the loop only while its command line
 *     still ends `service-run <id>` and it started no later than the record says —
 *     the command-line check `bin/swarm-worker-agent` makes with `ps`.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	closeSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readSync,
	rmSync,
	unwatchFile,
	watchFile,
	writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, win32 } from 'node:path';
import { z } from 'zod';
import type { WorkerAutostartResult } from '../cli/_shared/worker-autostart.js';
import { checkoutStateDir } from '../worktree/checkout-key.js';
import { CHECKOUT_LOCK_TTL_MS } from '../worktree/checkout-lock.js';
import { isExpired, pidIsLive, readJson } from '../worktree/local-lock.js';
import { LAUNCHER_INSTALL_ROOT } from './main.js';
import {
	isValidWorkerId,
	readWorkerProfile,
	type WorkerProfile,
	workerProfileDir,
	workerProfilePath,
} from './worker-profile.js';

export const TASK_SCHEDULER = 'Task Scheduler';
/** How the operator manages the task — `swarm-worker agent <action> --profile <id>`. */
export const WINDOWS_SERVICE_COMMAND = 'swarm-worker agent';
/** The keep-alive loop's own record, beside the profile: what `stop` kills the tree from. */
export const SERVICE_PID_FILE = 'service.pid';
/** How far a process's creation time may trail the loop's own `startedAt` and still be it. */
const START_TIME_SLACK_MS = 1000;
/** The keep-alive loop's log, beside the daemon's `worker.log`. */
export const SERVICE_LOG_FILE = 'service.log';
const LOG_TAIL_LINES = 50;

/** One captured run of a system executable. */
export interface ExecResult {
	code: number;
	output: string;
}

/** Run `file args` (no shell) with a 15 s budget; answer its exit code and combined output. */
export function captureCommand(file: string, args: string[]): Promise<ExecResult> {
	return new Promise((resolve) => {
		execFile(file, args, { timeout: 15_000, windowsHide: true }, (error, stdout, stderr) => {
			const text = `${stdout}${stderr}`.trim();
			const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
			resolve({ output: text || (error ? error.message : ''), code });
		});
	});
}

export interface WindowsTaskDeps {
	/** Injectable so tests never touch the real home directory, `schtasks` or clock. */
	homeDir?: string;
	env?: NodeJS.ProcessEnv;
	/** The `node` the task runs; this process's own by default. */
	execPath?: string;
	/** The launcher install root whose `bin\swarm-worker.js` the task runs. */
	launcherRoot?: string;
	/** `DOMAIN\user` the logon trigger and principal name. */
	userId?: string;
	exec?: (file: string, args: string[]) => Promise<ExecResult>;
	isPidLive?: (pid: number) => boolean;
	now?: () => number;
	/** Where the task XML is written for `schtasks /Create /XML`. */
	tempDir?: string;
	stdout?: (line: string) => void;
	stderr?: (line: string) => void;
	/** Resolves when the operator interrupts `logs`; `SIGINT` by default. */
	waitForInterrupt?: () => Promise<void>;
	/** How often `logs` polls the files it follows. */
	pollMs?: number;
}

/** A task-name segment: anything but letters, digits, `_` and `-` becomes `-`. */
function nameSlug(value: string): string {
	return value.replace(/[^A-Za-z0-9_-]/g, '-');
}

/**
 * The task's name for a profile — `bin/swarm-worker-agent`'s profile label without
 * its reverse-DNS prefix: the installation's host and the worker id, each slugged,
 * and the first 8 hex characters of `sha256(url + "\n" + workerId)`.
 */
export function windowsTaskName(controlPlaneUrl: string, workerId: string): string {
	if (!isValidWorkerId(workerId))
		throw new Error(`${JSON.stringify(workerId)} is not a valid worker id`);
	const host = new URL(controlPlaneUrl).host;
	const hash = createHash('sha256').update(`${controlPlaneUrl}\n${workerId}`).digest('hex');
	return `swarm.worker.${nameSlug(host)}.${nameSlug(workerId)}.${hash.slice(0, 8)}`;
}

/**
 * The installed task serving `workerId`, from `schtasks /Query /FO CSV /NH` output:
 * the first whose name ends in `.<id-slug>.<8 hex>`. A worker id has no dots, so the
 * suffix cannot match a longer id's.
 */
export function findWorkerTask(csv: string, workerId: string): string | undefined {
	const suffix = new RegExp(`^swarm\\.worker\\..+\\.${nameSlug(workerId)}\\.[0-9a-f]{8}$`);
	for (const line of csv.split(/\r?\n/)) {
		const first = /^"([^"]*)"/.exec(line.trim())?.[1];
		const name = first?.replace(/^\\/, '');
		if (name && suffix.test(name)) return name;
	}
	return undefined;
}

function xmlEscape(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');
}

export interface TaskXmlInput {
	name: string;
	workerId: string;
	controlPlaneUrl: string;
	/** `DOMAIN\user`. */
	userId: string;
	conhost: string;
	execPath: string;
	launcherEntry: string;
	profileDir: string;
}

/**
 * The task's definition, in Task Scheduler's 1.2 schema: an at-log-on trigger for
 * the user, the user's own interactive token at least privilege, no time limit, a
 * second instance ignored rather than started, batteries ignored, and the
 * keep-alive loop as its one action.
 */
export function windowsTaskXml(input: TaskXmlInput): string {
	const x = xmlEscape;
	const args = `--headless "${input.execPath}" "${input.launcherEntry}" service-run ${input.workerId}`;
	return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${x(`SWARM worker ${input.workerId} for ${input.controlPlaneUrl}`)}</Description>
    <URI>${x(`\\${input.name}`)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${x(input.userId)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${x(input.userId)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${x(input.conhost)}</Command>
      <Arguments>${x(args)}</Arguments>
      <WorkingDirectory>${x(input.profileDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** UTF-16 LE with a byte-order mark — the encoding `schtasks /Create /XML` reads. */
export function encodeTaskXml(xml: string): Buffer {
	return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
}

/** Only what the install guard reads of a daemon's checkout lock (`../worktree/checkout-lock.ts`). */
const LockOwnerSchema = z.object({
	pid: z.number().int().positive(),
	refreshedAt: z.string(),
	workerId: z.string().nullable().optional(),
});

/** What `service-run` records about itself in {@link SERVICE_PID_FILE}. */
const ServiceRecordSchema = z.object({
	pid: z.number().int().positive(),
	workerId: z.string(),
	startedAt: z.string(),
});
export type ServiceRecord = z.infer<typeof ServiceRecordSchema>;

/** The record `service-run` wrote, or `undefined` when there is none to read. */
export function readServiceRecord(profileDir: string): ServiceRecord | undefined {
	return readJson(join(profileDir, SERVICE_PID_FILE), ServiceRecordSchema) ?? undefined;
}

/** What `Win32_Process` says about one pid: its command line and its creation time. */
const ProcessProbeSchema = z.object({
	commandLine: z.string().nullable(),
	createdAt: z.string().nullable(),
});
export type ProcessProbe = z.infer<typeof ProcessProbeSchema>;

/** The PowerShell that answers {@link ProcessProbeSchema} for `pid` as one line of JSON. */
export function processProbeScript(pid: number): string {
	if (!Number.isInteger(pid) || pid <= 0) throw new Error(`not a pid: ${pid}`);
	return [
		`$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'`,
		"if ($p) { [pscustomobject]@{ commandLine = $p.CommandLine; createdAt = $(if ($p.CreationDate) { $p.CreationDate.ToUniversalTime().ToString('o') } else { $null }) } | ConvertTo-Json -Compress }",
	].join('; ');
}

/** Whether `commandLine` is `service-run <workerId>`'s: those are its last two arguments. */
export function isServiceRunCommandLine(commandLine: string, workerId: string): boolean {
	const args = commandLine
		.trim()
		.split(/\s+/)
		.map((arg) => arg.replace(/^"|"$/g, ''));
	return args.length >= 2 && args.at(-2) === 'service-run' && args.at(-1) === workerId;
}

/**
 * Whether the live process `probe` describes is the loop `record` was written by:
 * its command line is `service-run <id>`, and it was created no later than the loop
 * recorded starting. A process that reused the pid later fails the second test even
 * when its command line happens to pass the first (another loop for the same worker).
 */
export function isRecordedServiceRun(
	record: ServiceRecord,
	probe: ProcessProbe,
	workerId: string,
): boolean {
	if (record.workerId !== workerId) return false;
	if (!probe.commandLine || !isServiceRunCommandLine(probe.commandLine, workerId)) return false;
	const created = probe.createdAt ? Date.parse(probe.createdAt) : Number.NaN;
	const started = Date.parse(record.startedAt);
	return (
		Number.isFinite(created) && Number.isFinite(started) && created <= started + START_TIME_SLACK_MS
	);
}

/** The Windows manager, as `./service-manager.ts` resolves it on `win32`. */
export function createWindowsTaskManager(deps: WindowsTaskDeps = {}) {
	const env = deps.env ?? process.env;
	const system32 = win32.join(env.SystemRoot ?? env.windir ?? 'C:\\Windows', 'System32');
	const schtasks = win32.join(system32, 'schtasks.exe');
	const taskkill = win32.join(system32, 'taskkill.exe');
	const conhost = win32.join(system32, 'conhost.exe');
	const powershell = win32.join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
	const exec = deps.exec ?? captureCommand;
	const isLive = deps.isPidLive ?? pidIsLive;
	const now = deps.now ?? Date.now;
	const stdout = deps.stdout ?? ((line: string) => console.log(line));
	const stderr = deps.stderr ?? ((line: string) => console.error(line));
	const profileDir = (workerId: string) => workerProfileDir(workerId, deps.homeDir);

	/** What Windows says about `pid`, or `undefined` when it cannot be asked or answers nothing. */
	const probeProcess = async (pid: number): Promise<ProcessProbe | undefined> => {
		const probed = await exec(powershell, [
			'-NoProfile',
			'-NonInteractive',
			'-Command',
			processProbeScript(pid),
		]);
		if (probed.code !== 0 || probed.output === '') return undefined;
		try {
			return ProcessProbeSchema.parse(JSON.parse(probed.output));
		} catch {
			return undefined;
		}
	};

	/**
	 * The keep-alive loop's pid when the recorded one is verifiably still that loop;
	 * otherwise `undefined`, with `stale` naming a live pid that is something else now.
	 */
	const servicePid = async (workerId: string): Promise<{ pid?: number; stale?: number }> => {
		const record = readServiceRecord(profileDir(workerId));
		if (!record || !isLive(record.pid)) return {};
		const probe = await probeProcess(record.pid);
		return probe && isRecordedServiceRun(record, probe, workerId)
			? { pid: record.pid }
			: { stale: record.pid };
	};

	/** The profile when it reads; `undefined` when it is absent or unreadable. */
	const profileOf = (workerId: string): WorkerProfile | undefined =>
		readWorkerProfile(workerId, deps.homeDir) ?? undefined;

	/** The installed task serving `workerId`, by the profile's name or else by suffix. */
	const installedTask = async (workerId: string): Promise<string | undefined> => {
		const profile = profileOf(workerId);
		if (profile) {
			const name = windowsTaskName(profile.controlPlaneUrl, workerId);
			if ((await exec(schtasks, ['/Query', '/TN', name])).code === 0) return name;
		}
		const listed = await exec(schtasks, ['/Query', '/FO', 'CSV', '/NH']);
		return listed.code === 0 ? findWorkerTask(listed.output, workerId) : undefined;
	};

	/**
	 * Kill the keep-alive loop's tree, end the task, and forget the pid. A recorded pid
	 * that is not verifiably the loop is left alone — only `schtasks /End` runs.
	 */
	const stop = async (name: string, workerId: string) => {
		const { pid, stale } = await servicePid(workerId);
		if (pid !== undefined) await exec(taskkill, ['/PID', String(pid), '/T', '/F']);
		else if (stale !== undefined)
			stderr(
				`swarm-worker agent: ${SERVICE_PID_FILE} names pid ${stale}, which is no longer worker ${workerId}'s service-run loop — leaving it alone`,
			);
		// Fails when the task is not running, or not installed yet — both fine.
		await exec(schtasks, ['/End', '/TN', name]);
		rmSync(join(profileDir(workerId), SERVICE_PID_FILE), { force: true });
	};

	/**
	 * Refuse while a daemon this task did not start holds one of the profile's
	 * checkouts: its pid is alive and its lock was refreshed within the TTL — the
	 * daemon's own reclaim rule. A second worker would lose the race and then be
	 * restarted by the loop forever. This task's own running loop is exempt, since
	 * install stops it next (the script exempts a running agent the same way).
	 */
	const checkoutHeld = async (profile: WorkerProfile): Promise<string | undefined> => {
		if ((await servicePid(profile.workerId)).pid !== undefined) return undefined;
		for (const root of profile.repoRoots) {
			const lock = readJson(
				join(checkoutStateDir('checkout-locks', root, deps.homeDir), 'owner.json'),
				LockOwnerSchema,
			);
			if (!lock || !isLive(lock.pid)) continue;
			if (isExpired(lock.refreshedAt, CHECKOUT_LOCK_TTL_MS, now())) continue;
			const who = lock.workerId ? `worker ${lock.workerId}` : 'a worker';
			return `${who} (pid ${lock.pid}) is already running for ${root} — stop it first, then re-run install`;
		}
		return undefined;
	};

	const failed = (reason: string): WorkerAutostartResult => ({
		kind: 'failed',
		reason,
		serviceCommand: WINDOWS_SERVICE_COMMAND,
	});

	/** The profile `install` needs, or why it cannot have it. */
	const installableProfile = async (
		workerId: string,
	): Promise<WorkerProfile | { error: string }> => {
		if (!isValidWorkerId(workerId)) return { error: `not a valid worker id: ${workerId}` };
		const profile = readWorkerProfile(workerId, deps.homeDir);
		const path = workerProfilePath(workerId, deps.homeDir);
		if (profile === null)
			return {
				error: `no worker profile for ${workerId} at ${path} — register one first: swarm-worker setup`,
			};
		if (profile === undefined)
			return { error: `the worker profile at ${path} could not be read (or names another worker)` };
		const held = await checkoutHeld(profile);
		return held ? { error: held } : profile;
	};

	/** `schtasks /Create /XML` from a scratch file that is removed whatever happens. */
	const createTask = async (name: string, xml: string): Promise<ExecResult> => {
		const scratch = mkdtempSync(join(deps.tempDir ?? tmpdir(), 'swarm-worker-task-'));
		const xmlPath = join(scratch, 'task.xml');
		try {
			writeFileSync(xmlPath, encodeTaskXml(xml));
			return await exec(schtasks, ['/Create', '/XML', xmlPath, '/TN', name, '/F']);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	};

	const install = async (workerId: string): Promise<WorkerAutostartResult> => {
		const profile = await installableProfile(workerId);
		if ('error' in profile) return failed(profile.error);

		const name = windowsTaskName(profile.controlPlaneUrl, workerId);
		const dir = profileDir(workerId);
		const logDir = join(dir, 'logs');
		mkdirSync(logDir, { recursive: true });
		await stop(name, workerId);

		const created = await createTask(
			name,
			windowsTaskXml({
				name,
				workerId,
				controlPlaneUrl: profile.controlPlaneUrl,
				userId: deps.userId ?? currentUserId(env),
				conhost,
				execPath: deps.execPath ?? process.execPath,
				launcherEntry: win32.join(
					deps.launcherRoot ?? LAUNCHER_INSTALL_ROOT,
					'bin',
					'swarm-worker.js',
				),
				profileDir: dir,
			}),
		);
		if (created.code !== 0)
			return failed(
				`schtasks could not create ${name}: ${created.output || `exit ${created.code}`}`,
			);
		// Started now, as `RunAtLoad` starts a LaunchAgent the moment it is loaded.
		const started = await exec(schtasks, ['/Run', '/TN', name]);
		if (started.code !== 0)
			return failed(`schtasks created ${name} but could not start it: ${started.output}`);
		stdout(
			`swarm-worker agent: installed ${name}\n  worker:  ${workerId}\n  profile: ${dir}\n  log:     ${join(logDir, SERVICE_LOG_FILE)}`,
		);
		return {
			kind: 'installed',
			supervisor: TASK_SCHEDULER,
			serviceCommand: WINDOWS_SERVICE_COMMAND,
		};
	};

	const uninstall = async (workerId: string): Promise<number> => {
		if (!isValidWorkerId(workerId)) {
			stderr(`swarm-worker agent: not a valid worker id: ${workerId}`);
			return 1;
		}
		const name = await installedTask(workerId);
		if (!name) {
			stderr(`swarm-worker agent: no agent installed for worker ${workerId}`);
			return 1;
		}
		await stop(name, workerId);
		const deleted = await exec(schtasks, ['/Delete', '/TN', name, '/F']);
		if (deleted.code !== 0) {
			stderr(`swarm-worker agent: schtasks could not remove ${name}: ${deleted.output}`);
			return 1;
		}
		stdout(
			`swarm-worker agent: removed ${name} (logs kept at ${join(profileDir(workerId), 'logs')})`,
		);
		return 0;
	};

	const status = async (workerId: string): Promise<{ output: string; installed: boolean }> => {
		if (!isValidWorkerId(workerId))
			return { output: `not a valid worker id: ${workerId}`, installed: false };
		const name = await installedTask(workerId);
		const queried = name
			? await exec(schtasks, ['/Query', '/TN', name, '/V', '/FO', 'LIST'])
			: undefined;
		if (!name || !queried || queried.code !== 0)
			return { output: `no agent installed for worker ${workerId}`, installed: false };
		const lines = [`task:    ${name}`, `worker:  ${workerId}`, `profile: ${profileDir(workerId)}`];
		lines.push(...taskStatusLines(queried.output));
		const { pid } = await servicePid(workerId);
		lines.push(pid === undefined ? 'pid = none (not running)' : `pid = ${pid}`);
		return { output: lines.join('\n'), installed: true };
	};

	const logs = async (workerId: string): Promise<number> => {
		if (!isValidWorkerId(workerId)) {
			stderr(`swarm-worker agent: not a valid worker id: ${workerId}`);
			return 1;
		}
		const logDir = join(profileDir(workerId), 'logs');
		const files = [join(logDir, SERVICE_LOG_FILE), join(logDir, 'worker.log')];
		if (!files.some((file) => existsSync(file))) {
			stderr(`swarm-worker agent: no log yet at ${files[0]}`);
			return 1;
		}
		return followLogs(files, {
			stdout,
			pollMs: deps.pollMs ?? 1000,
			waitForInterrupt: deps.waitForInterrupt ?? waitForSigint,
		});
	};

	return {
		name: TASK_SCHEDULER,
		install,
		uninstall,
		status,
		logs,
	};
}

/** `DOMAIN\user` for the logon trigger, from the logon environment. */
function currentUserId(env: NodeJS.ProcessEnv): string {
	const user = env.USERNAME ?? userInfo().username;
	return env.USERDOMAIN ? `${env.USERDOMAIN}\\${user}` : user;
}

/** The first `TaskName`, `Status`, `Last Run Time` and `Last Result` lines of `/V /FO LIST`. */
export function taskStatusLines(list: string): string[] {
	const wanted = ['TaskName', 'Status', 'Last Run Time', 'Last Result'];
	const seen = new Map<string, string>();
	for (const line of list.split(/\r?\n/)) {
		const match = /^([^:]+):\s*(.*)$/.exec(line.trim());
		if (!match) continue;
		const key = match[1].trim();
		if (wanted.includes(key) && !seen.has(key)) seen.set(key, `${key}: ${match[2].trim()}`);
	}
	// A non-English Windows names these fields in its own language: show it all then.
	if (seen.size === 0) return list.split(/\r?\n/).filter((line) => line.trim() !== '');
	return wanted.flatMap((key) => seen.get(key) ?? []);
}

function waitForSigint(): Promise<void> {
	return new Promise((resolve) => process.once('SIGINT', () => resolve()));
}

/**
 * Print the last lines of each log, then follow every one of them — including one
 * not written yet — until interrupted, as `tail -f` follows the LaunchAgent's.
 */
async function followLogs(
	files: string[],
	options: {
		stdout: (line: string) => void;
		pollMs: number;
		waitForInterrupt: () => Promise<void>;
	},
): Promise<number> {
	const offsets = new Map<string, number>();
	for (const file of files) {
		let size = 0;
		try {
			const text = readFileSync(file, 'utf8');
			size = Buffer.byteLength(text);
			options.stdout(`==> ${file} <==`);
			const lines = text.replace(/\r?\n$/, '').split(/\r?\n/);
			for (const line of lines.slice(-LOG_TAIL_LINES)) options.stdout(line);
		} catch {
			// Not written yet; followed from its first byte once it is.
		}
		offsets.set(file, size);
	}
	for (const file of files)
		watchFile(file, { interval: options.pollMs }, (current) => {
			let from = offsets.get(file) ?? 0;
			if (current.size < from) from = 0; // truncated or replaced
			if (current.size === from) return;
			const chunk = readRange(file, from, current.size);
			offsets.set(file, current.size);
			for (const line of chunk.replace(/\r?\n$/, '').split(/\r?\n/)) options.stdout(line);
		});
	try {
		await options.waitForInterrupt();
	} finally {
		for (const file of files) unwatchFile(file);
	}
	return 0;
}

function readRange(file: string, from: number, to: number): string {
	const fd = openSync(file, 'r');
	try {
		const buffer = Buffer.alloc(to - from);
		readSync(fd, buffer, 0, buffer.length, from);
		return buffer.toString('utf8');
	} finally {
		closeSync(fd);
	}
}
