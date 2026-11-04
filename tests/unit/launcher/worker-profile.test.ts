import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	isValidWorkerId,
	listWorkerProfiles,
	MAX_FAILED_STARTS,
	readWorkerProfile,
	readWorkerState,
	referencedRuntimeVersions,
	updateWorkerProfileRepoRoots,
	updateWorkerState,
	workerProfileDir,
	workerProfilePath,
	workerProfilesDir,
	writeWorkerProfile,
	writeWorkerState,
} from '@/launcher/worker-profile.js';
import { MAX_FAILED_STARTS as CLONE_MAX_FAILED_STARTS } from '@/worker/self-update.js';

const WORKER_ID = '3f1c2a7e-0d4b-4c55-9a7e-1b2c3d4e5f60';
const NOW = Date.parse('2026-11-04T12:00:00.000Z');

describe('worker profiles', () => {
	let home: string;
	let checkout: string;
	let extra: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), 'worker-profile-'));
		checkout = realpathSync(mkdtempSync(join(tmpdir(), 'worker-profile-checkout-')));
		extra = realpathSync(mkdtempSync(join(tmpdir(), 'worker-profile-extra-')));
	});
	afterEach(() => {
		for (const dir of [home, checkout, extra]) rmSync(dir, { recursive: true, force: true });
	});

	const write = (overrides: Partial<Parameters<typeof writeWorkerProfile>[0]> = {}) =>
		writeWorkerProfile({
			workerId: WORKER_ID,
			controlPlaneUrl: 'https://swarm.example.com/',
			credential: 'secret-credential',
			repoRoots: [checkout, extra],
			homeDir: home,
			now: () => NOW,
			...overrides,
		});

	it('writes ~/.swarm/workers/<workerId>/profile.json, normalised and canonical', () => {
		const path = write({ repoRoots: [`${checkout}/`, extra] });
		expect(path).toBe(join(home, '.swarm', 'workers', WORKER_ID, 'profile.json'));
		expect(path).toBe(workerProfilePath(WORKER_ID, home));
		expect(readWorkerProfile(WORKER_ID, home)).toEqual({
			workerId: WORKER_ID,
			controlPlaneUrl: 'https://swarm.example.com',
			credential: 'secret-credential',
			repoRoots: [checkout, extra],
			createdAt: '2026-11-04T12:00:00.000Z',
		});
	});

	it('sets 700 on the directories and 600 on the file regardless of what was there', () => {
		const dir = workerProfileDir(WORKER_ID, home);
		mkdirSync(dir, { recursive: true, mode: 0o755 });
		chmodSync(workerProfilesDir(home), 0o755);
		chmodSync(dir, 0o755);
		writeFileSync(join(dir, 'profile.json'), '{}', { mode: 0o644 });

		const path = write();
		expect(statSync(workerProfilesDir(home)).mode & 0o777).toBe(0o700);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it('rewrites atomically, leaving no temporary file behind', () => {
		write();
		write({ credential: 'rotated' });
		expect(readdirSync(workerProfileDir(WORKER_ID, home))).toEqual(['profile.json']);
		expect(readWorkerProfile(WORKER_ID, home)?.credential).toBe('rotated');
	});

	it('refuses a worker id that is not path-safe', () => {
		for (const bad of ['..', '.', '../escape', 'a/b', '', '.hidden', 'a b']) {
			expect(isValidWorkerId(bad)).toBe(false);
			expect(() => write({ workerId: bad })).toThrow(/not a valid worker id/);
			expect(() => readWorkerProfile(bad, home)).toThrow(/not a valid worker id/);
		}
		expect(readdirSync(home)).toEqual([]);
	});

	it('refuses a profile with no checkout or no URL', () => {
		expect(() => write({ repoRoots: [] })).toThrow();
		expect(() => write({ controlPlaneUrl: 'not a url' })).toThrow();
		expect(readWorkerProfile(WORKER_ID, home)).toBeNull();
	});

	it('answers null for no profile and undefined for an unreadable or mismatched one', () => {
		expect(readWorkerProfile(WORKER_ID, home)).toBeNull();
		const path = write();
		writeFileSync(path, '{not json');
		expect(readWorkerProfile(WORKER_ID, home)).toBeUndefined();

		const other = 'another-worker';
		write({ workerId: other });
		const record = JSON.parse(readFileSync(workerProfilePath(other, home), 'utf8'));
		writeFileSync(path, JSON.stringify({ ...record }));
		expect(readWorkerProfile(WORKER_ID, home)).toBeUndefined();
	});

	it('lists profiles by worker id, including unreadable ones', () => {
		write({ workerId: 'b-worker' });
		write({ workerId: 'a-worker' });
		mkdirSync(join(workerProfilesDir(home), 'empty-dir'));
		writeFileSync(workerProfilePath('b-worker', home), 'garbage');

		const listed = listWorkerProfiles(home);
		expect(listed.map(({ workerId }) => workerId)).toEqual(['a-worker', 'b-worker']);
		expect(listed[0].profile?.workerId).toBe('a-worker');
		expect(listed[1].profile).toBeUndefined();
		expect(listWorkerProfiles(join(home, 'nowhere'))).toEqual([]);
	});

	it('replaces the checkouts and nothing else', () => {
		write();
		const updated = updateWorkerProfileRepoRoots(WORKER_ID, [extra], home);
		expect(updated).toMatchObject({ repoRoots: [extra], credential: 'secret-credential' });
		expect(readWorkerProfile(WORKER_ID, home)).toEqual(updated);
		expect(() => updateWorkerProfileRepoRoots(WORKER_ID, [], home)).toThrow();
		expect(updateWorkerProfileRepoRoots('missing', [extra], home)).toBeNull();
	});

	it('keeps the launcher state in its own owner-only file', () => {
		const profilePath = write();
		const before = readFileSync(profilePath, 'utf8');
		expect(readWorkerState(WORKER_ID, home)).toBeNull();

		const state = { lastRuntimeVersion: '1.2.3', startedAt: '2026-11-04T12:00:00.000Z' };
		const path = writeWorkerState(WORKER_ID, state, home);
		expect(path).toBe(join(workerProfileDir(WORKER_ID, home), 'state.json'));
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readWorkerState(WORKER_ID, home)).toEqual(state);
		expect(readFileSync(profilePath, 'utf8')).toBe(before);

		writeFileSync(path, '[]');
		expect(readWorkerState(WORKER_ID, home)).toBeUndefined();
	});

	it('merges a patch into the state, keeping the fields it does not name', () => {
		write();
		expect(updateWorkerState(WORKER_ID, { selectedVersion: '2.0.0' }, home)).toBeNull();
		expect(readWorkerState(WORKER_ID, home)).toBeNull();

		const state = { lastRuntimeVersion: '1.2.3', startedAt: '2026-11-04T12:00:00.000Z' };
		writeWorkerState(WORKER_ID, state, home);
		expect(updateWorkerState(WORKER_ID, { selectedVersion: '2.0.0' }, home)).toEqual({
			...state,
			selectedVersion: '2.0.0',
		});
		expect(readWorkerState(WORKER_ID, home)).toEqual({ ...state, selectedVersion: '2.0.0' });
		expect(statSync(join(workerProfileDir(WORKER_ID, home), 'state.json')).mode & 0o777).toBe(
			0o600,
		);
	});

	it('derives a patch from the state as read, when given a function', () => {
		write();
		writeWorkerState(
			WORKER_ID,
			{ lastRuntimeVersion: '1.2.3', startedAt: '2026-11-04T12:00:00.000Z' },
			home,
		);
		updateWorkerState(
			WORKER_ID,
			(state) => ({ lastKnownGoodVersion: state.lastKnownGoodVersion ?? state.lastRuntimeVersion }),
			home,
		);
		writeWorkerState(
			WORKER_ID,
			{
				...readWorkerState(WORKER_ID, home),
				lastRuntimeVersion: '2.0.0',
				startedAt: '2026-11-04T12:00:00.000Z',
			},
			home,
		);
		updateWorkerState(
			WORKER_ID,
			(state) => ({ lastKnownGoodVersion: state.lastKnownGoodVersion ?? state.lastRuntimeVersion }),
			home,
		);
		expect(readWorkerState(WORKER_ID, home)?.lastKnownGoodVersion).toBe('1.2.3');
	});

	it('reads a state written before the pending-verification record as nothing pending', () => {
		write();
		writeWorkerState(
			WORKER_ID,
			{ lastRuntimeVersion: '1.2.3', startedAt: '2026-11-04T12:00:00.000Z' },
			home,
		);
		expect(readWorkerState(WORKER_ID, home)?.pendingVerification ?? null).toBeNull();
	});

	it("counts failed starts against the same budget as a clone's build verification", () => {
		expect(MAX_FAILED_STARTS).toBe(CLONE_MAX_FAILED_STARTS);
	});

	describe('referencedRuntimeVersions', () => {
		it('names every version any worker state names, profile or not', () => {
			writeWorkerState(
				'worker-one',
				{
					lastRuntimeVersion: '2.0.0',
					startedAt: '2026-11-04T12:00:00.000Z',
					selectedVersion: '3.0.0',
					lastKnownGoodVersion: '1.0.0',
					pendingVerification: {
						version: '3.0.0',
						previousVersion: '2.0.0',
						failedStarts: 1,
						startedAt: '2026-11-04T12:00:00.000Z',
					},
				},
				home,
			);
			// A state with no profile beside it still names what a launcher starts from.
			const orphan = join(workerProfilesDir(home), 'not.a.worker.id');
			mkdirSync(orphan, { recursive: true });
			writeFileSync(
				join(orphan, 'state.json'),
				JSON.stringify({ lastRuntimeVersion: '0.9.0', startedAt: '2026-11-04T12:00:00.000Z' }),
			);
			// A directory with no state, and a stray file, name nothing.
			mkdirSync(join(workerProfilesDir(home), 'worker-two'));
			writeFileSync(join(workerProfilesDir(home), 'README'), 'not a worker');
			expect([...(referencedRuntimeVersions(home) ?? ['unreadable'])].sort()).toEqual([
				'0.9.0',
				'1.0.0',
				'2.0.0',
				'3.0.0',
			]);
		});

		it('is empty when there are no workers at all', () => {
			expect(referencedRuntimeVersions(home)).toEqual(new Set());
		});

		it('cannot tell when any state is unreadable', () => {
			writeWorkerState(
				'worker-one',
				{ lastRuntimeVersion: '2.0.0', startedAt: '2026-11-04T12:00:00.000Z' },
				home,
			);
			mkdirSync(join(workerProfilesDir(home), 'worker-two'));
			writeFileSync(join(workerProfilesDir(home), 'worker-two', 'state.json'), '{ not json');
			expect(referencedRuntimeVersions(home)).toBeUndefined();
		});
	});
});
