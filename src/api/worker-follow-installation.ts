/**
 * Keep the fleet on the installation's own version (issue #1284) — the decision to
 * start an installation-wide rollout to the build the control plane itself runs,
 * with nobody asking for it.
 *
 * Upgrading an installation (`npm run release`, then `npm run deploy`) moves
 * the control plane and nothing else, so until this module the fleet stayed on the
 * previous build until an administrator ran `swarm workers update --all <ref>` —
 * ADR-006's drift by default, moved from the host to the operator. With
 * `workers.followInstallationVersion` on (the default, justified on
 * `AppWorkersSettingsSchema`, `../config/app-settings.ts`), the control plane now
 * starts that rollout itself. **Nothing about the rollout is new:** it is the same
 * `startRollout({ scope: 'installation' })` (`./worker-update-rollout.ts`) the
 * administrator's command calls, so the waves, the drain, the halt on a bad build and
 * the per-member report — a clone-based worker that refuses, a machine that is
 * offline or unreachable — are all that module's, and each machine that cannot take
 * the build is settled and reported there exactly once.
 *
 * **When.** On the rollout ticker (`../router/worker-rollout-advance.ts`), but only
 * once the process has been up for {@link FOLLOW_GRACE_MS}: see its own comment for
 * why not at startup. Every later tick decides again, which is what lets a rollout
 * refused because another one was moving start once that one has finished.
 *
 * **At most once per build, durably.** Before anything is started the rollout table
 * is asked whether an installation-wide rollout that names this *build* exists *in
 * any status* (`listInstallationRollouts`, matched by {@link targetNamesBuild}). That
 * one read is what keeps a restart on the same version from starting anything, keeps
 * an in-progress rollout from being duplicated, and keeps a halted one from being
 * retried automatically — a halt is terminal by design, and the way past it is a
 * fixed build, which is a new version and so a new rollout. An administrator can
 * still restart one by hand. It matches the build rather than the literal target
 * because an administrator's rollout stores its target as typed: `swarm workers
 * update --all v1.6.0` (or an abbreviated commit) that halted is this build's halt
 * just as much as this module's own full-commit record would be.
 *
 * **Whose name it runs under.** `requested_by_user_id` is required and every
 * per-machine request is recorded under it, and an installation-wide rollout is an
 * administrator's act (`assertInstallationRolloutAdmin`, `./routers/workers.ts`), so
 * the rollout is recorded under the first instance administrator by identifier. An
 * installation with none starts nothing and says so; the next tick asks again.
 */

import { getAppSettings } from '../db/repositories/appSettingsRepository.js';
import { listUsers } from '../db/repositories/usersRepository.js';
import { listInstallationRollouts } from '../db/repositories/workerUpdateRolloutsRepository.js';
import { isInstanceAdmin } from '../identity/schema.js';
import {
	buildIsOnTarget,
	resolveOwnBuildIdentity,
	type WorkerBuild,
} from '../lib/build-identity.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { type StartRolloutResult, startRollout } from './worker-update-rollout.js';

/**
 * How long a control plane must have been up before it decides whether to roll the
 * fleet onto its own version.
 *
 * A control-plane restart — which is what an upgrade is — drops every worker
 * session. A rollout started at boot would find most machines without a live
 * session, pass them over as offline, and read each one's build from before the
 * restart. Two minutes is `OFFLINE_SILENCE_FLOOR_MS` (`../router/worker-liveness.ts`)
 * and the rollout's own `ABANDON_AFTER_MS`: the point at which the control plane
 * already calls a machine that has not reconnected *probably gone*, with the
 * reconnect ladder capped at a jittered 30s well inside it. Coded rather than
 * configurable, like both of those.
 */
export const FOLLOW_GRACE_MS = 120_000;

/**
 * What one decision did. `disabled`, `unidentified`, `already-offered` and
 * `no-administrator` start nothing of their own; every other outcome is
 * `startRollout`'s, passed through.
 */
export type FollowInstallationVersionResult =
	| { outcome: 'disabled' }
	| { outcome: 'unidentified' }
	| { outcome: 'already-offered'; rolloutId: string }
	| { outcome: 'no-administrator' }
	| StartRolloutResult;

/**
 * Whether a rollout's stored `target` names `build` — the "already offered" test.
 *
 * A commit-shaped target names it when one id prefixes the other, exactly as
 * `buildIsOnTarget` reads a machine against a target (which covers this module's own
 * full-commit record too); a version-shaped one when it is the build's own version,
 * with or without the leading `v`. A branch, or a tag that is not the version, is
 * not resolved: the control plane cannot tell what commit one named without
 * fetching, so it reads as another build.
 */
export function targetNamesBuild(target: string, build: WorkerBuild): boolean {
	if (buildIsOnTarget(build, target)) return true;
	const version = build.version?.replace(/^v/, '');
	return version !== undefined && (target === version || target === `v${version}`);
}

/**
 * Decide, once, whether to roll the fleet onto the control plane's own build — and
 * do it when the answer is yes. See the module header for every rule applied.
 */
export async function followInstallationVersion(): Promise<FollowInstallationVersionResult> {
	const settings = await getAppSettings();
	if (!settings.workers.followInstallationVersion) return { outcome: 'disabled' };

	// A dirty build names no release, so there is nothing a worker could be moved to.
	const build = await resolveOwnBuildIdentity();
	if (!build || build.dirty) {
		logger.debug(
			'fleet update: not following the installation version — its build is unknown or dirty',
		);
		return { outcome: 'unidentified' };
	}
	const target = build.commit;

	const offered = (await listInstallationRollouts()).find((rollout) =>
		targetNamesBuild(rollout.target, build),
	);
	if (offered) return { outcome: 'already-offered', rolloutId: offered.id };

	const administrator = (await listUsers()).find(isInstanceAdmin);
	if (!administrator) {
		logger.warn(
			'fleet update: not following the installation version — the installation has no instance administrator to record the rollout under',
			{ target },
		);
		return { outcome: 'no-administrator' };
	}

	const result = await startRollout({
		ownerUserId: administrator.id,
		scope: 'installation',
		target,
	});
	if (result.outcome === 'started' || result.outcome === 'advanced') {
		// The audit line for the action as a whole, mirroring the one an administrator's
		// own `startFleetUpdateForInstallation` writes.
		logger.info('fleet update: following the installation version', {
			action: result.outcome,
			requestedByUserId: administrator.id,
			target,
			version: build.version ?? null,
			rolloutId: result.view.rollout.id,
			status: result.view.rollout.status,
			members: result.view.members.length,
		});
	} else if (result.outcome === 'conflict' || result.outcome === 'blocked-by-other-scope') {
		// Asked again on every tick until that one finishes, so not worth more than debug.
		logger.debug(
			'fleet update: waiting for another rollout before following the installation version',
			{
				target,
				blockingRolloutId: result.view.rollout.id,
				blockingTarget: result.view.rollout.target,
			},
		);
	} else {
		logger.debug('fleet update: nothing to follow the installation version onto', {
			target,
			outcome: result.outcome,
		});
	}
	return result;
}

/**
 * {@link followInstallationVersion} once the process has been up for
 * {@link FOLLOW_GRACE_MS}, and nothing before. Never throws, on
 * `advanceRolloutsInProgress`' posture: it runs off a bare `setInterval`, and a
 * missed decision costs one tick — the next one decides again from durable state.
 */
export async function followInstallationVersionIfDue(
	processStartedAt: number,
	now: number = Date.now(),
): Promise<void> {
	if (now - processStartedAt < FOLLOW_GRACE_MS) return;
	try {
		await followInstallationVersion();
	} catch (err) {
		logger.warn(
			'fleet update: could not decide whether to follow the installation version — continuing',
			{
				error: describeError(err),
			},
		);
	}
}
