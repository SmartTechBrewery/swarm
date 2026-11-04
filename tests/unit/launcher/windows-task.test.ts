/**
 * A profile worker under Windows Task Scheduler (issue #1323): real profiles and
 * checkout locks under a temporary home, with every `schtasks` / `taskkill` call
 * faked and recorded — nothing here runs a real one.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	createWindowsTaskManager,
	type ExecResult,
	encodeTaskXml,
	findWorkerTask,
	isRecordedServiceRun,
	isServiceRunCommandLine,
	processProbeScript,
	taskStatusLines,
	type WindowsTaskDeps,
	windowsTaskName,
	windowsTaskXml,
} from '@/launcher/windows-task.js';
import { workerProfileDir, writeWorkerProfile } from '@/launcher/worker-profile.js';
import { checkoutStateDir } from '@/worktree/checkout-key.js';

const URL = 'https://swarm.example.com:8443';
const WORKER_ID = 'w-1';
const SYSTEM32 = 'C:\\Windows\\System32';
const SCHTASKS = `${SYSTEM32}\\schtasks.exe`;
const TASKKILL = `${SYSTEM32}\\taskkill.exe`;
const POWERSHELL = `${SYSTEM32}\\WindowsPowerShell\\v1.0\\powershell.exe`;
const NOW = Date.parse('2026-11-04T12:00:00.000Z');
/** When the recorded loop started, and when Windows says it created the loop's process. */
const LOOP_STARTED_AT = new Date(NOW - 3_600_000).toISOString();
const LOOP_CREATED_AT = new Date(NOW - 3_600_000 - 400).toISOString();
const LOOP_COMMAND_LINE =
	'"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\ada\\.swarm\\launcher\\bin\\swarm-worker.js" service-run w-1';

let home: string;
let checkout: string;

beforeEach(() => {
	home = realpathSync(mkdtempSync(join(tmpdir(), 'swarm-windows-task-')));
	checkout = join(home, 'work', 'api');
	mkdirSync(checkout, { recursive: true });
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

function profile(): void {
	writeWorkerProfile({
		workerId: WORKER_ID,
		controlPlaneUrl: URL,
		credential: 'raw-credential',
		repoRoots: [checkout],
		homeDir: home,
	});
}

const taskName = () => windowsTaskName(URL, WORKER_ID);

/** A recording `exec` answering each call with `answer(args)` (exit 0 by default). */
function fakeExec(answer: (file: string, args: string[]) => Partial<ExecResult> = () => ({})) {
	const calls: Array<{ file: string; args: string[]; xml?: string }> = [];
	const exec = vi.fn(async (file: string, args: string[]) => {
		const xmlAt = args.indexOf('/XML');
		calls.push({
			file,
			args,
			xml: xmlAt >= 0 ? readFileSync(args[xmlAt + 1]).toString('utf16le') : undefined,
		});
		return { code: 0, output: '', ...answer(file, args) };
	});
	return { exec, calls };
}

function manager(overrides: Partial<WindowsTaskDeps> = {}) {
	const out: string[] = [];
	const err: string[] = [];
	const deps: WindowsTaskDeps = {
		homeDir: home,
		env: { SystemRoot: 'C:\\Windows' },
		execPath: 'C:\\Program Files\\nodejs\\node.exe',
		launcherRoot: 'C:\\Users\\ada\\.swarm\\launcher',
		userId: 'ADA-PC\\ada',
		isPidLive: () => false,
		now: () => NOW,
		tempDir: home,
		stdout: (line) => out.push(line),
		stderr: (line) => err.push(line),
		...overrides,
	};
	return { manager: createWindowsTaskManager(deps), out, err };
}

function writeServicePid(pid: number): void {
	mkdirSync(workerProfileDir(WORKER_ID, home), { recursive: true });
	writeFileSync(
		join(workerProfileDir(WORKER_ID, home), 'service.pid'),
		`${JSON.stringify({ pid, workerId: WORKER_ID, startedAt: LOOP_STARTED_AT })}\n`,
	);
}

const servicePidPath = () => join(workerProfileDir(WORKER_ID, home), 'service.pid');

/** An `exec` answer for the process probe: what Windows says the recorded pid is. */
function probeAnswer(commandLine: string | null, createdAt: string | null = LOOP_CREATED_AT) {
	return (file: string): Partial<ExecResult> =>
		file === POWERSHELL ? { output: JSON.stringify({ commandLine, createdAt }) } : {};
}

/** The probe a manager makes before trusting `pid` as the loop. */
const probeCall = (pid: number) => [
	POWERSHELL,
	'-NoProfile',
	'-NonInteractive',
	'-Command',
	processProbeScript(pid),
];

function writeLock(pid: number, refreshedAt: string, workerId: string | null = 'w-other'): void {
	const dir = checkoutStateDir('checkout-locks', checkout, home);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, 'owner.json'),
		JSON.stringify({
			repoRoot: checkout,
			pid,
			hostname: 'ada-pc',
			workerId,
			createdAt: refreshedAt,
			refreshedAt,
		}),
	);
}

describe('windowsTaskName', () => {
	it('mirrors the LaunchAgent profile label: host and id slugs, then the url/id hash', () => {
		const hash = createHash('sha256').update(`${URL}\n${WORKER_ID}`).digest('hex').slice(0, 8);
		expect(windowsTaskName(URL, WORKER_ID)).toBe(`swarm.worker.swarm-example-com-8443.w-1.${hash}`);
	});

	it('refuses a worker id that is not path-safe', () => {
		expect(() => windowsTaskName(URL, '../evil')).toThrow(/not a valid worker id/);
	});
});

describe('recognising the keep-alive loop', () => {
	const record = { pid: 4242, workerId: WORKER_ID, startedAt: LOOP_STARTED_AT };

	it('reads service-run <id> as the last two arguments, quoted or not', () => {
		expect(isServiceRunCommandLine(LOOP_COMMAND_LINE, WORKER_ID)).toBe(true);
		expect(isServiceRunCommandLine('node swarm-worker.js "service-run" "w-1" ', WORKER_ID)).toBe(
			true,
		);
		expect(isServiceRunCommandLine('node swarm-worker.js service-run w-10', WORKER_ID)).toBe(false);
		expect(isServiceRunCommandLine('node swarm-worker.js run w-1', WORKER_ID)).toBe(false);
		expect(isServiceRunCommandLine('C:\\Windows\\explorer.exe', WORKER_ID)).toBe(false);
	});

	it('trusts a pid only while its command line and creation time match the record', () => {
		const loop = { commandLine: LOOP_COMMAND_LINE, createdAt: LOOP_CREATED_AT };
		expect(isRecordedServiceRun(record, loop, WORKER_ID)).toBe(true);
		// Another process now holds the pid.
		expect(
			isRecordedServiceRun(
				record,
				{ ...loop, commandLine: 'C:\\Windows\\explorer.exe' },
				WORKER_ID,
			),
		).toBe(false);
		// Windows hides another account's command line.
		expect(isRecordedServiceRun(record, { ...loop, commandLine: null }, WORKER_ID)).toBe(false);
		// The same command line, but a process created after the loop wrote its record.
		expect(
			isRecordedServiceRun(
				record,
				{ ...loop, createdAt: new Date(NOW - 60_000).toISOString() },
				WORKER_ID,
			),
		).toBe(false);
		expect(isRecordedServiceRun(record, { ...loop, createdAt: null }, WORKER_ID)).toBe(false);
		expect(isRecordedServiceRun({ ...record, workerId: 'w-2' }, loop, WORKER_ID)).toBe(false);
	});

	it('builds a probe only for a real pid', () => {
		expect(processProbeScript(4242)).toContain("-Filter 'ProcessId=4242'");
		expect(() => processProbeScript(Number.NaN)).toThrow(/not a pid/);
	});
});

describe('findWorkerTask', () => {
	it('finds the task by its .<id>.<hash> suffix in schtasks CSV output', () => {
		const csv = [
			'"\\Microsoft\\Windows\\Defrag","N/A","Ready"',
			'"\\swarm.worker.other-host.w-10.abcdef12","N/A","Ready"',
			`"\\${taskName()}","N/A","Running"`,
		].join('\r\n');
		expect(findWorkerTask(csv, WORKER_ID)).toBe(taskName());
		expect(findWorkerTask(csv, 'w-2')).toBeUndefined();
	});
});

describe('windowsTaskXml', () => {
	const input = {
		name: 'swarm.worker.h.w-1.12345678',
		workerId: WORKER_ID,
		controlPlaneUrl: URL,
		userId: 'ADA-PC\\ada',
		conhost: `${SYSTEM32}\\conhost.exe`,
		execPath: 'C:\\Program Files\\nodejs\\node.exe',
		launcherEntry: 'C:\\Users\\ada\\.swarm\\launcher\\bin\\swarm-worker.js',
		profileDir: 'C:\\Users\\ada\\.swarm\\workers\\w-1',
	};

	it('starts the keep-alive loop at log on, as the user, with no limit or second instance', () => {
		const xml = windowsTaskXml(input);
		expect(xml).toContain('<LogonTrigger>');
		expect(xml).toContain('<UserId>ADA-PC\\ada</UserId>');
		expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
		expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
		expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
		expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
		expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
		expect(xml).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
		expect(xml).toContain(`<Command>${SYSTEM32}\\conhost.exe</Command>`);
		expect(xml).toContain(
			'<Arguments>--headless &quot;C:\\Program Files\\nodejs\\node.exe&quot; &quot;C:\\Users\\ada\\.swarm\\launcher\\bin\\swarm-worker.js&quot; service-run w-1</Arguments>',
		);
		expect(xml).toContain(
			'<WorkingDirectory>C:\\Users\\ada\\.swarm\\workers\\w-1</WorkingDirectory>',
		);
		expect(xml).not.toContain('raw-credential');
	});

	it('escapes every interpolated value', () => {
		const xml = windowsTaskXml({ ...input, profileDir: 'C:\\a&b<c>"d' });
		expect(xml).toContain('<WorkingDirectory>C:\\a&amp;b&lt;c&gt;&quot;d</WorkingDirectory>');
	});

	it('is encoded as UTF-16 LE with a byte-order mark', () => {
		const encoded = encodeTaskXml('<Task/>');
		expect([...encoded.subarray(0, 2)]).toEqual([0xff, 0xfe]);
		expect(encoded.subarray(2).toString('utf16le')).toBe('<Task/>');
	});
});

describe('the Task Scheduler manager', () => {
	describe('install', () => {
		it('stops the running loop, creates the task from its XML, starts it, and removes the XML', async () => {
			profile();
			writeServicePid(4242);
			const { exec, calls } = fakeExec(probeAnswer(LOOP_COMMAND_LINE));
			const { manager: windows, out } = manager({ exec, isPidLive: (pid) => pid === 4242 });

			expect(await windows.install(WORKER_ID)).toEqual({
				kind: 'installed',
				supervisor: 'Task Scheduler',
				serviceCommand: 'swarm-worker agent',
			});

			expect(
				calls.map(({ file, args }) => [file, ...args.filter((a) => !a.endsWith('.xml'))]),
			).toEqual([
				// Once for the checkout guard's exemption, once before the kill.
				probeCall(4242),
				probeCall(4242),
				[TASKKILL, '/PID', '4242', '/T', '/F'],
				[SCHTASKS, '/End', '/TN', taskName()],
				[SCHTASKS, '/Create', '/XML', '/TN', taskName(), '/F'],
				[SCHTASKS, '/Run', '/TN', taskName()],
			]);
			const created = calls[4];
			expect(created.xml).toContain('service-run w-1');
			expect(created.xml).toContain(
				`<WorkingDirectory>${workerProfileDir(WORKER_ID, home)}</WorkingDirectory>`,
			);
			// The scratch XML is gone, and the old loop's pid with it.
			expect(() => readFileSync(created.args[2])).toThrow();
			expect(() => readFileSync(servicePidPath())).toThrow();
			expect(out.join('\n')).toContain(`installed ${taskName()}`);
		});

		it.each([
			['another program now holds the pid', probeAnswer('C:\\Windows\\explorer.exe')],
			[
				'a process created after the loop started holds it',
				probeAnswer(LOOP_COMMAND_LINE, new Date(NOW - 60_000).toISOString()),
			],
			[
				'the process cannot be probed',
				(file: string) => (file === POWERSHELL ? { code: 1, output: 'powershell failed' } : {}),
			],
		])('does not taskkill a recycled service.pid when %s', async (_case, answer) => {
			profile();
			writeServicePid(4242);
			const { exec, calls } = fakeExec(answer);
			const { manager: windows, err } = manager({ exec, isPidLive: (pid) => pid === 4242 });

			expect((await windows.install(WORKER_ID)).kind).toBe('installed');

			expect(calls.some(({ file }) => file === TASKKILL)).toBe(false);
			expect(calls.map(({ args }) => args[0])).toContain('/End');
			expect(() => readFileSync(servicePidPath())).toThrow();
			expect(err).toEqual([
				"swarm-worker agent: service.pid names pid 4242, which is no longer worker w-1's service-run loop — leaving it alone",
			]);
		});

		it('does not let a recycled service.pid exempt the checkout-lock guard', async () => {
			profile();
			writeLock(777, new Date(NOW - 60_000).toISOString());
			writeServicePid(4242);
			const { exec, calls } = fakeExec(probeAnswer('C:\\Windows\\explorer.exe'));
			const result = await manager({
				exec,
				isPidLive: (pid) => pid === 777 || pid === 4242,
			}).manager.install(WORKER_ID);

			expect(result).toMatchObject({
				kind: 'failed',
				reason: `worker w-other (pid 777) is already running for ${checkout} — stop it first, then re-run install`,
			});
			expect(calls.map(({ file }) => file)).toEqual([POWERSHELL]);
		});

		it('refuses a profile that does not exist, naming setup', async () => {
			const { exec } = fakeExec();
			const result = await manager({ exec }).manager.install(WORKER_ID);
			expect(result).toMatchObject({
				kind: 'failed',
				reason: expect.stringMatching(/no worker profile for w-1 .* swarm-worker setup/),
			});
			expect(exec).not.toHaveBeenCalled();
		});

		it('refuses while another live daemon holds a checkout with a fresh lock', async () => {
			profile();
			writeLock(777, new Date(NOW - 60_000).toISOString());
			const { exec } = fakeExec();
			const result = await manager({ exec, isPidLive: (pid) => pid === 777 }).manager.install(
				WORKER_ID,
			);
			expect(result).toMatchObject({
				kind: 'failed',
				reason: `worker w-other (pid 777) is already running for ${checkout} — stop it first, then re-run install`,
			});
			expect(exec).not.toHaveBeenCalled();
		});

		it.each([
			['its pid is gone', () => false, 60_000, undefined],
			['its lock has lapsed', () => true, 16 * 60_000, undefined],
			['this task’s own loop is running', () => true, 60_000, 4242],
		])('allows the install when %s', async (_case, live, age, ownPid) => {
			profile();
			writeLock(777, new Date(NOW - age).toISOString());
			if (ownPid !== undefined) writeServicePid(ownPid);
			const { exec } = fakeExec(probeAnswer(LOOP_COMMAND_LINE));
			const result = await manager({ exec, isPidLive: live }).manager.install(WORKER_ID);
			expect(result.kind).toBe('installed');
		});

		it('reports a failed create as a failure, naming schtasks’ answer', async () => {
			profile();
			const { exec } = fakeExec((_file, args) =>
				args[0] === '/Create' ? { code: 1, output: 'ERROR: Access is denied.' } : {},
			);
			expect(await manager({ exec }).manager.install(WORKER_ID)).toMatchObject({
				kind: 'failed',
				reason: `schtasks could not create ${taskName()}: ERROR: Access is denied.`,
			});
		});
	});

	describe('status', () => {
		const LIST = [
			'Folder: \\',
			`TaskName:                             \\${taskName()}`,
			'Next Run Time:                        N/A',
			'Status:                               Running',
			'Last Run Time:                        11/4/2026 12:00:00 PM',
			'Last Result:                          267009',
			'Author:                               ADA-PC\\ada',
			`TaskName:                             \\${taskName()}`,
			'Status:                               Running',
		].join('\r\n');

		it('keeps the task’s name, state and last run, plus the loop’s pid', async () => {
			profile();
			writeServicePid(4242);
			const { exec } = fakeExec((file, args) =>
				args.includes('/V') ? { output: LIST } : probeAnswer(LOOP_COMMAND_LINE)(file),
			);
			const { output, installed } = await manager({
				exec,
				isPidLive: (pid) => pid === 4242,
			}).manager.status(WORKER_ID);

			expect(installed).toBe(true);
			expect(output.split('\n')).toEqual([
				`task:    ${taskName()}`,
				`worker:  ${WORKER_ID}`,
				`profile: ${workerProfileDir(WORKER_ID, home)}`,
				`TaskName: \\${taskName()}`,
				'Status: Running',
				'Last Run Time: 11/4/2026 12:00:00 PM',
				'Last Result: 267009',
				'pid = 4242',
			]);
		});

		it('reports no pid when the recorded one is no longer the loop', async () => {
			profile();
			writeServicePid(4242);
			const { exec } = fakeExec((file, args) =>
				args.includes('/V') ? { output: LIST } : probeAnswer('C:\\Windows\\explorer.exe')(file),
			);
			const { output } = await manager({ exec, isPidLive: (pid) => pid === 4242 }).manager.status(
				WORKER_ID,
			);
			expect(output.split('\n').at(-1)).toBe('pid = none (not running)');
		});

		it('says no agent is installed when schtasks knows no such task', async () => {
			profile();
			const { exec } = fakeExec(() => ({
				code: 1,
				output: 'ERROR: The system cannot find the file specified.',
			}));
			expect(await manager({ exec }).manager.status(WORKER_ID)).toEqual({
				output: 'no agent installed for worker w-1',
				installed: false,
			});
		});

		it('shows a non-English listing whole rather than nothing', () => {
			expect(taskStatusLines('Aufgabenname: x\r\nStatus2: Wird ausgeführt')).toEqual([
				'Aufgabenname: x',
				'Status2: Wird ausgeführt',
			]);
		});
	});

	describe('uninstall', () => {
		it('finds the task by its name suffix when the profile is unreadable, stops and deletes it', async () => {
			mkdirSync(workerProfileDir(WORKER_ID, home), { recursive: true });
			writeFileSync(join(workerProfileDir(WORKER_ID, home), 'profile.json'), 'not json');
			const { exec, calls } = fakeExec((_file, args) =>
				args.includes('CSV') ? { output: `"\\${taskName()}","N/A","Ready"` } : {},
			);
			const { manager: windows, out } = manager({ exec });

			expect(await windows.uninstall(WORKER_ID)).toBe(0);

			expect(calls.map(({ args }) => args)).toEqual([
				['/Query', '/FO', 'CSV', '/NH'],
				['/End', '/TN', taskName()],
				['/Delete', '/TN', taskName(), '/F'],
			]);
			expect(out.join('\n')).toContain(`removed ${taskName()} (logs kept at`);
		});

		it('does not taskkill a recycled service.pid', async () => {
			profile();
			writeServicePid(4242);
			const { exec, calls } = fakeExec(probeAnswer('C:\\Windows\\explorer.exe'));
			const { manager: windows } = manager({ exec, isPidLive: (pid) => pid === 4242 });

			expect(await windows.uninstall(WORKER_ID)).toBe(0);

			expect(calls.map(({ file, args }) => [file, ...args])).toEqual([
				[SCHTASKS, '/Query', '/TN', taskName()],
				probeCall(4242),
				[SCHTASKS, '/End', '/TN', taskName()],
				[SCHTASKS, '/Delete', '/TN', taskName(), '/F'],
			]);
			expect(() => readFileSync(servicePidPath())).toThrow();
		});

		it('exits 1 when no task serves the worker', async () => {
			const { exec } = fakeExec(() => ({ output: '' }));
			const { manager: windows, err } = manager({ exec });
			expect(await windows.uninstall(WORKER_ID)).toBe(1);
			expect(err).toEqual(['swarm-worker agent: no agent installed for worker w-1']);
		});
	});

	describe('logs', () => {
		it('says there is no log yet when neither log exists', async () => {
			const { manager: windows, err } = manager();
			expect(await windows.logs(WORKER_ID)).toBe(1);
			expect(err[0]).toMatch(/no log yet at .*service\.log$/);
		});

		it('prints the last lines of each log, then follows until interrupted', async () => {
			const logDir = join(workerProfileDir(WORKER_ID, home), 'logs');
			mkdirSync(logDir, { recursive: true });
			const lines = Array.from({ length: 60 }, (_, i) => `line ${i}`);
			writeFileSync(join(logDir, 'worker.log'), `${lines.join('\n')}\n`);
			const { manager: windows, out } = manager({ waitForInterrupt: async () => {} });

			expect(await windows.logs(WORKER_ID)).toBe(0);

			expect(out[0]).toBe(`==> ${join(logDir, 'worker.log')} <==`);
			expect(out.slice(1)).toEqual(lines.slice(10));
		});
	});
});
