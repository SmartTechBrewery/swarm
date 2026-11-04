import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	FOLLOW_GRACE_MS,
	followInstallationVersion,
	followInstallationVersionIfDue,
} from '@/api/worker-follow-installation.js';
import type { RolloutView, StartRolloutResult } from '@/api/worker-update-rollout.js';
import type { AppSettings } from '@/config/app-settings.js';
import type { SwarmUser } from '@/identity/schema.js';
import type { WorkerUpdateRollout } from '@/identity/worker-update-rollout.js';
import type { WorkerBuild } from '@/lib/build-identity.js';

/**
 * Rolling the fleet onto the installation's own version (issue #1284).
 *
 * Every collaborator is mocked: the settings, the build identity, the two reads and
 * `startRollout` are datastores and policy this module owns none of. What is under
 * test is the decision — whether a rollout is started, to what, and under whose name —
 * and the rollout's own behaviour (waves, halt, per-member report) is pinned where it
 * lives (`tests/unit/api/worker-update-rollout.test.ts`).
 */

const { getAppSettings } = vi.hoisted(() => ({
	getAppSettings: vi.fn<() => Promise<AppSettings>>(),
}));
vi.mock('@/db/repositories/appSettingsRepository.js', () => ({ getAppSettings }));

const { resolveOwnBuildIdentity } = vi.hoisted(() => ({
	resolveOwnBuildIdentity: vi.fn<() => Promise<WorkerBuild | undefined>>(),
}));
vi.mock('@/lib/build-identity.js', () => ({ resolveOwnBuildIdentity }));

const { findInstallationRolloutForTarget } = vi.hoisted(() => ({
	findInstallationRolloutForTarget:
		vi.fn<(target: string) => Promise<WorkerUpdateRollout | undefined>>(),
}));
vi.mock('@/db/repositories/workerUpdateRolloutsRepository.js', () => ({
	findInstallationRolloutForTarget,
}));

const { listUsers } = vi.hoisted(() => ({ listUsers: vi.fn<() => Promise<SwarmUser[]>>() }));
vi.mock('@/db/repositories/usersRepository.js', () => ({ listUsers }));

const { startRollout } = vi.hoisted(() => ({
	startRollout: vi.fn<(input: unknown) => Promise<StartRolloutResult>>(),
}));
vi.mock('@/api/worker-update-rollout.js', () => ({ startRollout }));

const COMMIT = '0a50d89c0a50d89c0a50d89c0a50d89c0a50d89c';
const ROLLOUT_ID = '77777777-7777-4777-8777-777777777777';
const ADMIN_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ADMIN_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '22222222-2222-4222-8222-222222222222';

function settings(followInstallationVersion: boolean): AppSettings {
	return { appearance: { theme: 'dark' }, workers: { followInstallationVersion } };
}

function makeUser(id: string, identifier: string, instanceAdmin: boolean): SwarmUser {
	return {
		id,
		identifier,
		displayName: identifier,
		instanceAdmin,
		createdAt: new Date(0),
		updatedAt: new Date(0),
	};
}

function makeRollout(overrides: Partial<WorkerUpdateRollout> = {}): WorkerUpdateRollout {
	return {
		id: ROLLOUT_ID,
		requestedByUserId: ADMIN_ID,
		scope: 'installation',
		target: COMMIT,
		waveSize: 1,
		status: 'in_progress',
		haltReason: null,
		createdAt: new Date('2026-11-04T10:00:00Z'),
		updatedAt: new Date('2026-11-04T10:00:00Z'),
		...overrides,
	};
}

function makeView(rollout: WorkerUpdateRollout = makeRollout()): RolloutView {
	return { rollout, members: [] };
}

beforeEach(() => {
	vi.clearAllMocks();
	getAppSettings.mockResolvedValue(settings(true));
	resolveOwnBuildIdentity.mockResolvedValue({ commit: COMMIT, dirty: false, version: '1.4.0' });
	findInstallationRolloutForTarget.mockResolvedValue(undefined);
	// `listUsers` answers by identifier, so the first administrator is the first in it.
	listUsers.mockResolvedValue([
		makeUser(USER_ID, 'ada@example.com', false),
		makeUser(ADMIN_ID, 'grace@example.com', true),
		makeUser(OTHER_ADMIN_ID, 'linus@example.com', true),
	]);
	startRollout.mockResolvedValue({ outcome: 'started', view: makeView() });
});

describe('followInstallationVersion', () => {
	it('starts one installation-wide rollout to the control plane’s own commit, under the first administrator', async () => {
		const result = await followInstallationVersion();

		expect(result.outcome).toBe('started');
		expect(findInstallationRolloutForTarget).toHaveBeenCalledWith(COMMIT);
		expect(startRollout).toHaveBeenCalledTimes(1);
		expect(startRollout).toHaveBeenCalledWith({
			ownerUserId: ADMIN_ID,
			scope: 'installation',
			target: COMMIT,
		});
	});

	it('does nothing at all when the setting is off', async () => {
		getAppSettings.mockResolvedValue(settings(false));

		expect(await followInstallationVersion()).toEqual({ outcome: 'disabled' });
		expect(resolveOwnBuildIdentity).not.toHaveBeenCalled();
		expect(startRollout).not.toHaveBeenCalled();
	});

	it('starts nothing when the control plane cannot name its own build', async () => {
		resolveOwnBuildIdentity.mockResolvedValue(undefined);

		expect(await followInstallationVersion()).toEqual({ outcome: 'unidentified' });
		expect(startRollout).not.toHaveBeenCalled();
	});

	// A dirty build names no release a worker could be moved to.
	it('starts nothing when the control plane runs a dirty build', async () => {
		resolveOwnBuildIdentity.mockResolvedValue({ commit: COMMIT, dirty: true });

		expect(await followInstallationVersion()).toEqual({ outcome: 'unidentified' });
		expect(findInstallationRolloutForTarget).not.toHaveBeenCalled();
		expect(startRollout).not.toHaveBeenCalled();
	});

	// One guard, three acceptance criteria: a restart on the same version (a completed
	// rollout), a rollout still moving (not duplicated), and a halted one (not retried).
	for (const status of ['completed', 'in_progress', 'halted'] as const) {
		it(`starts nothing once the build was already offered (a ${status} rollout)`, async () => {
			findInstallationRolloutForTarget.mockResolvedValue(makeRollout({ status }));

			expect(await followInstallationVersion()).toEqual({
				outcome: 'already-offered',
				rolloutId: ROLLOUT_ID,
			});
			expect(startRollout).not.toHaveBeenCalled();
		});
	}

	it('starts nothing when the installation has no instance administrator', async () => {
		listUsers.mockResolvedValue([makeUser(USER_ID, 'ada@example.com', false)]);

		expect(await followInstallationVersion()).toEqual({ outcome: 'no-administrator' });
		expect(startRollout).not.toHaveBeenCalled();
	});

	// Waiting on another rollout, a fleet already current, or no machines at all: each
	// records nothing, so a later tick decides again.
	for (const answer of [
		{ outcome: 'conflict', view: makeView(makeRollout({ target: 'v1.3.0' })) },
		{ outcome: 'blocked-by-other-scope', view: makeView(makeRollout({ scope: 'owner' })) },
		{ outcome: 'all-current' },
		{ outcome: 'no-machines' },
	] satisfies StartRolloutResult[]) {
		it(`passes startRollout's ${answer.outcome} through`, async () => {
			startRollout.mockResolvedValue(answer);

			expect(await followInstallationVersion()).toEqual(answer);
		});
	}
});

describe('followInstallationVersionIfDue', () => {
	const STARTED_AT = Date.parse('2026-11-04T10:00:00Z');

	// A control-plane restart drops every session; deciding before the fleet has
	// reconnected would pass most of it over as offline.
	it('decides nothing inside the grace period', async () => {
		await followInstallationVersionIfDue(STARTED_AT, STARTED_AT + FOLLOW_GRACE_MS - 1);

		expect(getAppSettings).not.toHaveBeenCalled();
		expect(startRollout).not.toHaveBeenCalled();
	});

	it('decides once the grace period has passed', async () => {
		await followInstallationVersionIfDue(STARTED_AT, STARTED_AT + FOLLOW_GRACE_MS);

		expect(startRollout).toHaveBeenCalledTimes(1);
	});

	it('never throws — a failed decision is logged and left to the next tick', async () => {
		startRollout.mockRejectedValue(new Error('database went away'));

		await expect(
			followInstallationVersionIfDue(STARTED_AT, STARTED_AT + FOLLOW_GRACE_MS),
		).resolves.toBeUndefined();
	});
});
