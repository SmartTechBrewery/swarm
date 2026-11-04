import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runtimesDir } from '@/launcher/runtime-store.js';
import { readWorkerState, writeWorkerState } from '@/launcher/worker-profile.js';
import type { WorkerRuntimeManifest } from '@/transport/runtime-manifest.js';
import {
	applyRuntimeUpdate,
	NOT_A_RELEASE_REASON,
	type RuntimeUpdateOptions,
	runtimeUpdateApply,
} from '@/transport/runtime-update.js';
import {
	buildRuntimeTarball,
	type MinisignTestKey,
	makeMinisignKey,
	signMinisign,
} from '../../helpers/runtime-fixtures.js';

const CONTROL_PLANE = 'https://swarm.example.com';
const WORKER_ID = 'worker-one';
const CREDENTIAL = 'worker-credential';
const KEY = makeMinisignKey();
const RUNNING = { version: '1.0.0', commit: 'a'.repeat(40) };
/** The installation's own release. */
const OWN = { version: '2.0.0', commit: 'b'.repeat(40) };
/** Another signed release. */
const OTHER = { version: '3.0.0', commit: 'c'.repeat(40) };
const MANIFEST_URL = `${CONTROL_PLANE}/worker/runtime/manifest`;

interface Release {
	version: string;
	commit: string;
}

function routesFor(
	release: Release,
	key: MinisignTestKey = KEY,
	launcherProtocol?: number | null,
): { manifest: WorkerRuntimeManifest; artifact: [string, Buffer] } {
	const tarball = buildRuntimeTarball(release.version, release.commit, { launcherProtocol });
	const name = `swarm-worker-runtime-${release.version}.tar.gz`;
	return {
		manifest: {
			available: true,
			version: release.version,
			commit: release.commit,
			artifact: {
				name,
				url: `/worker/runtime/artifacts/${name}`,
				size: tarball.length,
				sha256: createHash('sha256').update(tarball).digest('hex'),
			},
			signature: {
				format: 'minisign',
				minisig: signMinisign(
					key,
					tarball,
					`swarm-worker-runtime ${release.version} ${release.commit}`,
				),
			},
		},
		artifact: [`${CONTROL_PLANE}/worker/runtime/artifacts/${name}`, tarball],
	};
}

interface ControlPlane {
	fetch: typeof globalThis.fetch;
	calls: string[];
}

function controlPlane(
	options: {
		badSignatureFor?: string;
		unavailable?: Record<string, string>;
		/** A release whose runtime predates `launcherProtocol`. */
		unstampedFor?: string;
	} = {},
): ControlPlane {
	const calls: string[] = [];
	const routes = new Map<string, () => Response>();
	for (const release of [OWN, OTHER]) {
		const key = options.badSignatureFor === release.version ? makeMinisignKey() : KEY;
		const { manifest, artifact } = routesFor(
			release,
			key,
			options.unstampedFor === release.version ? null : undefined,
		);
		routes.set(`${MANIFEST_URL}?version=${release.version}`, () => Response.json(manifest));
		if (release === OWN) routes.set(MANIFEST_URL, () => Response.json(manifest));
		routes.set(artifact[0], () => new Response(new Uint8Array(artifact[1])));
	}
	for (const [version, reason] of Object.entries(options.unavailable ?? {}))
		routes.set(`${MANIFEST_URL}?version=${version}`, () =>
			Response.json({ available: false, reason }),
		);
	const fetch = (async (input: URL | string) => {
		const url = input.toString();
		calls.push(url);
		const route = routes.get(url);
		return route ? route() : new Response('not found', { status: 404 });
	}) as typeof globalThis.fetch;
	return { fetch, calls };
}

describe('applyRuntimeUpdate', () => {
	let home: string;
	let keyPath: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), 'runtime-update-'));
		keyPath = join(home, 'minisign.pub');
		writeFileSync(keyPath, KEY.publicKey);
		writeWorkerState(
			WORKER_ID,
			{
				lastRuntimeVersion: RUNNING.version,
				startedAt: '2026-11-04T12:00:00.000Z',
				selectedVersion: RUNNING.version,
			},
			home,
		);
	});
	afterEach(() => {
		execFileSync('chmod', ['-R', 'u+w', home]);
		rmSync(home, { recursive: true, force: true });
	});

	const apply = (
		target: string,
		plane: ControlPlane,
		overrides: Partial<RuntimeUpdateOptions> = {},
	) =>
		applyRuntimeUpdate({
			target,
			workerId: WORKER_ID,
			controlPlaneUrl: CONTROL_PLANE,
			credential: CREDENTIAL,
			build: { commit: RUNNING.commit, dirty: false, version: RUNNING.version },
			trustedKeyPath: keyPath,
			homeDir: home,
			fetch: plane.fetch,
			lockPollMs: 5,
			...overrides,
		});

	const selected = () => readWorkerState(WORKER_ID, home)?.selectedVersion;

	it.each([
		'3.0.0',
		'v3.0.0',
	])('installs and selects the release %s, and reports applied', async (target) => {
		const plane = controlPlane();
		const outcome = await apply(target, plane);
		expect(outcome).toMatchObject({
			status: 'applied',
			commit: OTHER.commit,
			previousCommit: RUNNING.commit,
		});
		expect(outcome.status === 'applied' && outcome.message).toContain('v3.0.0');
		expect(selected()).toBe('3.0.0');
		expect(existsSync(join(runtimesDir(home), '3.0.0'))).toBe(true);
		expect(plane.calls).toContain(`${MANIFEST_URL}?version=3.0.0`);
	});

	it('records the move as awaiting verification, keeping the version it ran as the one to go back to', async () => {
		const outcome = await apply('3.0.0', controlPlane(), {
			now: () => Date.parse('2026-11-04T13:00:00.000Z'),
		});
		expect(outcome).toMatchObject({ status: 'applied' });
		expect(readWorkerState(WORKER_ID, home)).toEqual({
			lastRuntimeVersion: RUNNING.version,
			startedAt: '2026-11-04T12:00:00.000Z',
			selectedVersion: '3.0.0',
			lastKnownGoodVersion: RUNNING.version,
			pendingVerification: {
				version: '3.0.0',
				previousVersion: RUNNING.version,
				failedStarts: 0,
				startedAt: '2026-11-04T13:00:00.000Z',
			},
		});
	});

	it('keeps a last known good version already recorded', async () => {
		writeWorkerState(
			WORKER_ID,
			{
				lastRuntimeVersion: RUNNING.version,
				startedAt: '2026-11-04T12:00:00.000Z',
				selectedVersion: RUNNING.version,
				lastKnownGoodVersion: '0.9.0',
			},
			home,
		);
		await apply('3.0.0', controlPlane());
		expect(readWorkerState(WORKER_ID, home)?.lastKnownGoodVersion).toBe('0.9.0');
	});

	it('refuses a runtime that predates launcher-driven verification, leaving the state untouched', async () => {
		const before = readWorkerState(WORKER_ID, home);
		const outcome = await apply('3.0.0', controlPlane({ unstampedFor: '3.0.0' }));
		expect(outcome).toMatchObject({ status: 'refused' });
		expect(outcome.status === 'refused' && outcome.reason).toContain(
			'v3.0.0 predates launcher-driven verification',
		);
		expect(readWorkerState(WORKER_ID, home)).toEqual(before);
	});

	it("resolves the installation's own commit, abbreviated, to its own release", async () => {
		const plane = controlPlane();
		expect(await apply(OWN.commit.slice(0, 9), plane)).toMatchObject({
			status: 'applied',
			commit: OWN.commit,
		});
		expect(selected()).toBe('2.0.0');
		expect(plane.calls).not.toContain(`${MANIFEST_URL}?version=2.0.0`);
	});

	it.each([
		['a branch', 'main'],
		['a release branch', 'release/v3'],
		['a commit that is not the installation’s own', 'deadbeef1234'],
	])('refuses %s and changes nothing', async (_label, target) => {
		const plane = controlPlane();
		const outcome = await apply(target, plane);
		expect(outcome).toMatchObject({ status: 'refused' });
		expect(outcome.status === 'refused' && outcome.reason).toContain(NOT_A_RELEASE_REASON);
		expect(selected()).toBe(RUNNING.version);
		expect(plane.calls.filter((url) => url.includes('/artifacts/'))).toEqual([]);
	});

	it('answers already-current, with no fetch, for the version it runs', async () => {
		const plane = controlPlane();
		expect(await apply('v1.0.0', plane)).toEqual({
			status: 'already-current',
			commit: RUNNING.commit,
		});
		expect(plane.calls).toEqual([]);
	});

	it('refuses a version with no signed release, with the control plane’s reason', async () => {
		const plane = controlPlane({ unavailable: { '9.9.9': 'no signed release v9.9.9' } });
		const outcome = await apply('9.9.9', plane);
		expect(outcome).toMatchObject({ status: 'refused' });
		expect(outcome.status === 'refused' && outcome.reason).toContain('no signed release v9.9.9');
		expect(selected()).toBe(RUNNING.version);
	});

	it('fails with the store’s reason on a bad signature, selecting and installing nothing', async () => {
		const plane = controlPlane({ badSignatureFor: '3.0.0' });
		const outcome = await apply('3.0.0', plane);
		expect(outcome).toMatchObject({
			status: 'failed',
			stage: 'install',
			rolledBack: true,
			previousCommit: RUNNING.commit,
			outputTail: '',
		});
		expect(outcome.status === 'failed' && outcome.reason).toContain('signature');
		expect(selected()).toBe(RUNNING.version);
		expect(existsSync(join(runtimesDir(home), '3.0.0'))).toBe(false);
	});

	it('fails closed with no trusted key, unless the release is already installed', async () => {
		const plane = controlPlane();
		const noKey = await apply('3.0.0', plane, { trustedKeyPath: undefined });
		expect(noKey).toMatchObject({ status: 'failed' });
		expect(noKey.status === 'failed' && noKey.reason).toContain('no trusted runtime signing key');
		expect(selected()).toBe(RUNNING.version);

		await apply('3.0.0', plane);
		writeWorkerState(
			WORKER_ID,
			{
				lastRuntimeVersion: RUNNING.version,
				startedAt: '2026-11-04T12:00:00.000Z',
				selectedVersion: RUNNING.version,
			},
			home,
		);
		expect(await apply('3.0.0', plane, { trustedKeyPath: undefined })).toMatchObject({
			status: 'applied',
		});
		expect(selected()).toBe('3.0.0');
	});

	it('installs once when two workers on the host ask for the same release', async () => {
		writeWorkerState(
			'worker-two',
			{ lastRuntimeVersion: RUNNING.version, startedAt: '2026-11-04T12:00:00.000Z' },
			home,
		);
		const plane = controlPlane();
		const outcomes = await Promise.all([
			apply('3.0.0', plane),
			apply('3.0.0', plane, { workerId: 'worker-two' }),
		]);
		expect(outcomes.map((outcome) => outcome.status)).toEqual(['applied', 'applied']);
		expect(plane.calls.filter((url) => url.includes('/artifacts/'))).toHaveLength(1);
		expect(readWorkerState('worker-two', home)?.selectedVersion).toBe('3.0.0');
	});
});

describe('runtimeUpdateApply', () => {
	const context = { controlPlaneUrl: CONTROL_PLANE, credential: CREDENTIAL, build: undefined };

	it('keeps the git path for a daemon the launcher did not start', () => {
		expect(runtimeUpdateApply({}, context)).toBeUndefined();
		expect(runtimeUpdateApply({ SWARM_WORKER_ID: '  ' }, context)).toBeUndefined();
	});

	it('moves a launcher-run daemon by runtime, recording under its own worker id', async () => {
		const apply = runtimeUpdateApply({ SWARM_WORKER_ID: '../escape' }, context);
		expect(apply).toBeTypeOf('function');
		expect(await apply?.('3.0.0')).toMatchObject({
			status: 'refused',
			reason: expect.stringContaining('not a valid worker id'),
		});
	});
});
