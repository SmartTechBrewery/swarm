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
	WORKER_SUPERVISION_STATES,
	WorkerSupervisionSchema,
} from '@/lib/worker-supervision.js';

/** The value a real launchd job on this fleet reports, verified live on the issue. */
const LAUNCHD_LABEL = 'pl.smarttechbrewery.swarm.worker.tb-rover.e19f1081';

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

		it('refuses the variable alone — it is inherited by any child', () => {
			expect(detectWorkerSupervision({ XPC_SERVICE_NAME: LAUNCHD_LABEL }, 4711, 'darwin')).toBe(
				'unsupervised',
			);
		});

		// Pinned deliberately rather than discovered later: the worker plists on this
		// installation run `swarm run:worker` → `npm run dev:worker` → the daemon, so a
		// genuinely launchd-restarted daemon's parent is `npm` and it declares
		// `unsupervised`. The module header says why that error is left pointing this
		// way, and phase 2/2 has to reckon with it before it refuses on this value.
		it('reads a daemon launchd started through a launcher as unsupervised', () => {
			expect(detectWorkerSupervision({ XPC_SERVICE_NAME: LAUNCHD_LABEL }, 23110, 'darwin')).toBe(
				'unsupervised',
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
