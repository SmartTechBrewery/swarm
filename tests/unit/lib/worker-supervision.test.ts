/**
 * How a daemon declares it is supervised (issue #997). `detectWorkerSupervision`
 * takes its whole world as arguments — env, ppid, platform — so every branch is
 * reachable without touching `process`, and the matrix below is the whole
 * contract.
 */

import { describe, expect, it } from 'vitest';
import {
	detectWorkerSupervision,
	resolveOwnSupervision,
	WORKER_LAUNCH_AGENT_LABEL_PREFIX,
	WORKER_SUPERVISION_STATES,
	WorkerSupervisionSchema,
} from '@/lib/worker-supervision.js';

/** The value a real launchd job on this fleet reports, verified live on the issue. */
const LAUNCHD_LABEL = 'pl.smarttechbrewery.swarm.worker.tb-rover.e19f1081';

/** A launchd job SWARM's installer did not write. */
const FOREIGN_LABEL = 'com.example.my-own-agent';

describe('detectWorkerSupervision', () => {
	describe('systemd', () => {
		it('reads a non-empty INVOCATION_ID as supervised', () => {
			expect(detectWorkerSupervision({ INVOCATION_ID: 'ab12' }, 4711, 'linux')).toBe('supervised');
		});

		it('does not require pid 1 as the parent — a user unit hangs off the user manager', () => {
			expect(detectWorkerSupervision({ INVOCATION_ID: 'ab12' }, 9182, 'linux')).toBe('supervised');
		});
	});

	describe('launchd', () => {
		it('reads a real XPC_SERVICE_NAME beside ppid 1 as supervised', () => {
			expect(detectWorkerSupervision({ XPC_SERVICE_NAME: LAUNCHD_LABEL }, 1, 'darwin')).toBe(
				'supervised',
			);
		});

		it('refuses a foreign label alone — it is inherited by any child', () => {
			expect(detectWorkerSupervision({ XPC_SERVICE_NAME: FOREIGN_LABEL }, 4711, 'darwin')).toBe(
				'unsupervised',
			);
		});

		// Issue #1376: a host may run its worker agent under a wrapper program that
		// starts the usual command as its child, so the daemon's parent is the wrapper,
		// never pid 1. The SWARM worker label is what says launchd runs this job.
		it('reads a SWARM worker label as supervised whatever the parent', () => {
			expect(detectWorkerSupervision({ XPC_SERVICE_NAME: LAUNCHD_LABEL }, 23110, 'darwin')).toBe(
				'supervised',
			);
			expect(
				detectWorkerSupervision(
					{ XPC_SERVICE_NAME: 'pl.smarttechbrewery.swarm.worker.swarm-example-com.w-1.0a1b2c3d' },
					4711,
					'darwin',
				),
			).toBe('supervised');
		});

		it('still refuses a hand-run daemon under any other job, or the bare prefix', () => {
			expect(
				detectWorkerSupervision(
					{ XPC_SERVICE_NAME: 'application.com.apple.Terminal.1234' },
					23110,
					'darwin',
				),
			).toBe('unsupervised');
			expect(
				detectWorkerSupervision(
					{ XPC_SERVICE_NAME: 'pl.smarttechbrewery.swarm.api.swarm.abcd1234' },
					23110,
					'darwin',
				),
			).toBe('unsupervised');
			expect(
				detectWorkerSupervision(
					{ XPC_SERVICE_NAME: WORKER_LAUNCH_AGENT_LABEL_PREFIX },
					23110,
					'darwin',
				),
			).toBe('unsupervised');
		});

		it('reads a foreign label beside ppid 1 as supervised, as before', () => {
			expect(detectWorkerSupervision({ XPC_SERVICE_NAME: FOREIGN_LABEL }, 1, 'darwin')).toBe(
				'supervised',
			);
		});

		it("refuses launchd's not-an-XPC-service sentinel, which is not a label", () => {
			expect(detectWorkerSupervision({ XPC_SERVICE_NAME: '0' }, 1, 'darwin')).toBe('unsupervised');
		});

		it('refuses ppid 1 alone — that is also what an orphaned hand-run daemon reports', () => {
			expect(detectWorkerSupervision({}, 1, 'darwin')).toBe('unsupervised');
		});
	});

	describe('a platform these reads answer for', () => {
		it('reads neither marker as unsupervised on darwin and on linux', () => {
			expect(detectWorkerSupervision({}, 4711, 'darwin')).toBe('unsupervised');
			expect(detectWorkerSupervision({}, 4711, 'linux')).toBe('unsupervised');
		});

		it('treats an empty or whitespace-only marker as absent', () => {
			expect(detectWorkerSupervision({ INVOCATION_ID: '' }, 4711, 'linux')).toBe('unsupervised');
			expect(detectWorkerSupervision({ INVOCATION_ID: '  ' }, 4711, 'linux')).toBe('unsupervised');
			expect(detectWorkerSupervision({ XPC_SERVICE_NAME: '' }, 1, 'darwin')).toBe('unsupervised');
			expect(detectWorkerSupervision({ XPC_SERVICE_NAME: ' \t' }, 1, 'darwin')).toBe(
				'unsupervised',
			);
		});
	});

	describe('anywhere else', () => {
		it('declares unknown rather than claiming either answer', () => {
			expect(detectWorkerSupervision({}, 4711, 'win32')).toBe('unknown');
			expect(detectWorkerSupervision({}, 1, 'win32')).toBe('unknown');
		});

		it('still reads a supervisor marker it does recognise', () => {
			expect(detectWorkerSupervision({ INVOCATION_ID: 'ab12' }, 4711, 'win32')).toBe('supervised');
		});
	});
});

describe('WorkerSupervisionSchema', () => {
	it('accepts exactly the three declared members', () => {
		for (const state of WORKER_SUPERVISION_STATES) {
			expect(WorkerSupervisionSchema.parse(state)).toBe(state);
		}
		expect(WorkerSupervisionSchema.safeParse('launchd').success).toBe(false);
	});
});

describe('resolveOwnSupervision', () => {
	it('answers one of the three members for the process running this suite', () => {
		expect(WORKER_SUPERVISION_STATES).toContain(resolveOwnSupervision());
	});
});
