import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNTIME_ENTRYPOINT, runtimesDir, STALE_STAGING_MS } from '@/launcher/runtime-store.js';
import {
	MAX_FAILED_STARTS,
	readWorkerState,
	type WorkerState,
	writeWorkerState,
} from '@/launcher/worker-profile.js';
import {
	createRuntimeHandshakePromotion,
	type RuntimeVerificationOptions,
	returnRuntimeAfterFatalHandshake,
} from '@/transport/runtime-verification.js';
import {
	WorkerCapabilityConflictError,
	WorkerSessionConflictError,
	WorkerTransportAuthError,
	WorkerTransportProtocolError,
	WorkerTransportTransientError,
} from '@/transport/worker-client.js';

const WORKER_ID = 'worker-one';
const STARTED_AT = '2026-11-04T12:00:00.000Z';

/** Started by the launcher on 2.0.0, moved there from 1.0.0 and not yet proved. */
const PENDING: WorkerState = {
	lastRuntimeVersion: '2.0.0',
	startedAt: STARTED_AT,
	selectedVersion: '2.0.0',
	lastKnownGoodVersion: '1.0.0',
	pendingVerification: {
		version: '2.0.0',
		previousVersion: '1.0.0',
		failedStarts: 1,
		startedAt: STARTED_AT,
	},
};

describe('runtime verification', () => {
	let home: string;
	let options: RuntimeVerificationOptions;
	let exit: ReturnType<typeof vi.fn<(code: number) => void>>;
	let shutdown: ReturnType<typeof vi.fn<() => Promise<void>>>;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), 'runtime-verification-'));
		exit = vi.fn<(code: number) => void>();
		shutdown = vi.fn<() => Promise<void>>(async () => {});
		options = {
			workerId: WORKER_ID,
			homeDir: home,
			exit,
			shutdown,
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		};
	});
	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	const state = () => readWorkerState(WORKER_ID, home);

	describe('createRuntimeHandshakePromotion', () => {
		it('promotes the pending version on the first session', () => {
			writeWorkerState(WORKER_ID, PENDING, home);
			createRuntimeHandshakePromotion(options)();
			expect(state()).toEqual({
				...PENDING,
				lastKnownGoodVersion: '2.0.0',
				pendingVerification: null,
			});
		});

		it('does nothing on the reconnects after it', () => {
			writeWorkerState(WORKER_ID, { ...PENDING, pendingVerification: null }, home);
			const promote = createRuntimeHandshakePromotion(options);
			promote();
			// A later move, recorded while this process still runs, is not this one's to prove.
			writeWorkerState(WORKER_ID, PENDING, home);
			promote();
			expect(state()).toEqual(PENDING);
		});

		it('leaves a record naming another version than the one this daemon was started on', () => {
			const other = { ...PENDING, lastRuntimeVersion: '1.0.0' };
			writeWorkerState(WORKER_ID, other, home);
			createRuntimeHandshakePromotion(options)();
			expect(state()).toEqual(other);
		});

		it('removes the version the worker was moved from once it is promoted away from it', async () => {
			const old = new Date(Date.now() - STALE_STAGING_MS - 60_000);
			for (const version of ['1.0.0', '2.0.0']) {
				const dir = join(runtimesDir(home), version);
				mkdirSync(join(dir, 'dist/transport'), { recursive: true });
				writeFileSync(join(dir, RUNTIME_ENTRYPOINT), version);
				utimesSync(dir, old, old);
			}
			writeWorkerState(WORKER_ID, PENDING, home);
			await createRuntimeHandshakePromotion(options)();
			expect(existsSync(join(runtimesDir(home), '1.0.0'))).toBe(false);
			expect(existsSync(join(runtimesDir(home), '2.0.0'))).toBe(true);
			expect(options.logger?.info).toHaveBeenCalledWith(
				'removed a runtime version no worker on this host uses any more',
				{ workerId: WORKER_ID, version: '1.0.0' },
			);
		});

		it('removes nothing when there is nothing to promote', async () => {
			// Named by no worker, so only the absence of a promotion keeps it.
			const dir = join(runtimesDir(home), '0.5.0');
			mkdirSync(join(dir, 'dist/transport'), { recursive: true });
			writeFileSync(join(dir, RUNTIME_ENTRYPOINT), '0.5.0');
			const old = new Date(Date.now() - STALE_STAGING_MS - 60_000);
			utimesSync(dir, old, old);
			writeWorkerState(WORKER_ID, { ...PENDING, lastRuntimeVersion: '1.0.0' }, home);
			await createRuntimeHandshakePromotion(options)();
			expect(existsSync(dir)).toBe(true);
		});

		it('never throws, with no state at all or an invalid worker id', () => {
			expect(() => createRuntimeHandshakePromotion(options)()).not.toThrow();
			expect(() =>
				createRuntimeHandshakePromotion({ ...options, workerId: '../escape' })(),
			).not.toThrow();
		});
	});

	describe('returnRuntimeAfterFatalHandshake', () => {
		it.each([
			['a protocol rejection', new WorkerTransportProtocolError()],
			['a capability rejection', new WorkerCapabilityConflictError(['claude'])],
			['a refused credential', new WorkerTransportAuthError()],
		])('spends the start budget and exits on %s', async (_label, err) => {
			writeWorkerState(WORKER_ID, PENDING, home);
			expect(await returnRuntimeAfterFatalHandshake(err, options)).toBe(true);
			expect(state()?.pendingVerification).toEqual({
				...PENDING.pendingVerification,
				failedStarts: MAX_FAILED_STARTS,
			});
			expect(shutdown).toHaveBeenCalledOnce();
			expect(exit).toHaveBeenCalledWith(0);
		});

		it.each([
			['a transient failure', new WorkerTransportTransientError('503')],
			['a session conflict', new WorkerSessionConflictError()],
		])('ignores %s', async (_label, err) => {
			writeWorkerState(WORKER_ID, PENDING, home);
			expect(await returnRuntimeAfterFatalHandshake(err, options)).toBe(false);
			expect(state()).toEqual(PENDING);
			expect(exit).not.toHaveBeenCalled();
		});

		it('leaves a fatal rejection to the caller when nothing is being verified', async () => {
			writeWorkerState(WORKER_ID, { ...PENDING, pendingVerification: null }, home);
			expect(
				await returnRuntimeAfterFatalHandshake(new WorkerTransportProtocolError(), options),
			).toBe(false);
			expect(exit).not.toHaveBeenCalled();
		});

		it('exits even when releasing the session fails', async () => {
			writeWorkerState(WORKER_ID, PENDING, home);
			shutdown.mockRejectedValueOnce(new Error('socket gone'));
			expect(
				await returnRuntimeAfterFatalHandshake(new WorkerTransportProtocolError(), options),
			).toBe(true);
			expect(exit).toHaveBeenCalledWith(0);
		});
	});
});
