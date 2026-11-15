/**
 * The shared-check-failure ledger's reads and writes (issue #1464) — the durable
 * half of `src/dispatch/shared-check-failure.ts`, which holds every decision.
 *
 * Sightings ({@link recordCheckFailureObservations}) are per approved head and
 * idempotent; an episode ({@link openEpisode}) is one per `(project, repository,
 * check)` while unresolved, guarded by the partial unique index; its report is
 * claimed once by a conditional update ({@link claimEpisodeReport}, the
 * `claimApprovedHeadOperatorNotice` pattern), so concurrent callers write it once.
 */

import { and, eq, gt, gte, inArray, isNull, lte, sql } from 'drizzle-orm';

import { getDb } from '../client.js';
import {
	sharedCheckFailureEpisodes,
	sharedCheckFailureObservations,
} from '../schema/sharedCheckFailures.js';

/** The approved head a sighting belongs to. */
export interface CheckFailureHeadKey {
	projectId: string;
	repository: string;
	prNumber: string;
	headSha: string;
}

export interface CheckFailureObservation {
	checkName: string;
	prNumber: string;
	headSha: string;
	observedAt: Date;
}

export interface SharedCheckFailureEpisode {
	id: string;
	checkName: string;
	openedAt: Date;
	reportedAt: Date | null;
}

const episodeColumns = {
	id: sharedCheckFailureEpisodes.id,
	checkName: sharedCheckFailureEpisodes.checkName,
	openedAt: sharedCheckFailureEpisodes.openedAt,
	reportedAt: sharedCheckFailureEpisodes.reportedAt,
};

/**
 * Record that each of `checks` failed on this approved head. A repeat sighting of
 * the same head refreshes `observed_at`, so the detection window measures the
 * latest one.
 */
export async function recordCheckFailureObservations(
	key: CheckFailureHeadKey,
	checks: readonly string[],
): Promise<void> {
	if (checks.length === 0) return;
	await getDb()
		.insert(sharedCheckFailureObservations)
		.values(checks.map((checkName) => ({ ...key, checkName })))
		.onConflictDoUpdate({
			target: [
				sharedCheckFailureObservations.projectId,
				sharedCheckFailureObservations.repository,
				sharedCheckFailureObservations.checkName,
				sharedCheckFailureObservations.prNumber,
				sharedCheckFailureObservations.headSha,
			],
			set: { observedAt: sql`now()` },
		});
}

/** The sightings of `checks` in one repository at or after `since`. */
export async function listRecentCheckFailureObservations(
	projectId: string,
	repository: string,
	checks: readonly string[],
	since: Date,
): Promise<CheckFailureObservation[]> {
	if (checks.length === 0) return [];
	return await getDb()
		.select({
			checkName: sharedCheckFailureObservations.checkName,
			prNumber: sharedCheckFailureObservations.prNumber,
			headSha: sharedCheckFailureObservations.headSha,
			observedAt: sharedCheckFailureObservations.observedAt,
		})
		.from(sharedCheckFailureObservations)
		.where(
			and(
				eq(sharedCheckFailureObservations.projectId, projectId),
				eq(sharedCheckFailureObservations.repository, repository),
				inArray(sharedCheckFailureObservations.checkName, [...checks]),
				gte(sharedCheckFailureObservations.observedAt, since),
			),
		);
}

/** The standing episodes of `checks`: unresolved, and opened after `openedAfter`. */
export async function findStandingEpisodes(
	projectId: string,
	repository: string,
	checks: readonly string[],
	openedAfter: Date,
): Promise<SharedCheckFailureEpisode[]> {
	if (checks.length === 0) return [];
	return await getDb()
		.select(episodeColumns)
		.from(sharedCheckFailureEpisodes)
		.where(
			and(
				eq(sharedCheckFailureEpisodes.projectId, projectId),
				eq(sharedCheckFailureEpisodes.repository, repository),
				inArray(sharedCheckFailureEpisodes.checkName, [...checks]),
				isNull(sharedCheckFailureEpisodes.resolvedAt),
				gt(sharedCheckFailureEpisodes.openedAt, openedAfter),
			),
		);
}

/**
 * Open the episode for one check. An unresolved episode opened at or before
 * `expiredAtOrBefore` is first resolved `expired`, in the same transaction, so it
 * cannot hold the partial unique index against its successor. When another caller
 * holds the standing episode already, that one is answered with `created: false`.
 */
export async function openEpisode(
	projectId: string,
	repository: string,
	checkName: string,
	expiredAtOrBefore: Date,
): Promise<{ episode: SharedCheckFailureEpisode; created: boolean }> {
	return await getDb().transaction(async (tx) => {
		const unresolvedOf = and(
			eq(sharedCheckFailureEpisodes.projectId, projectId),
			eq(sharedCheckFailureEpisodes.repository, repository),
			eq(sharedCheckFailureEpisodes.checkName, checkName),
			isNull(sharedCheckFailureEpisodes.resolvedAt),
		);
		await tx
			.update(sharedCheckFailureEpisodes)
			.set({ resolvedAt: new Date(), resolution: 'expired' })
			.where(and(unresolvedOf, lte(sharedCheckFailureEpisodes.openedAt, expiredAtOrBefore)));
		const inserted = await tx
			.insert(sharedCheckFailureEpisodes)
			.values({ projectId, repository, checkName })
			.onConflictDoNothing()
			.returning(episodeColumns);
		if (inserted[0]) return { episode: inserted[0], created: true };
		const [standing] = await tx
			.select(episodeColumns)
			.from(sharedCheckFailureEpisodes)
			.where(unresolvedOf);
		if (!standing) throw new Error(`shared check failure: no standing episode for ${checkName}`);
		return { episode: standing, created: false };
	});
}

/** Claim an episode's once-only report. `true` only for the caller that wins it. */
export async function claimEpisodeReport(episodeId: string): Promise<boolean> {
	const rows = await getDb()
		.update(sharedCheckFailureEpisodes)
		.set({ reportedAt: new Date() })
		.where(
			and(
				eq(sharedCheckFailureEpisodes.id, episodeId),
				isNull(sharedCheckFailureEpisodes.reportedAt),
			),
		)
		.returning({ id: sharedCheckFailureEpisodes.id });
	return rows.length > 0;
}

/**
 * The check of a standing episode (unresolved, opened after `openedAfter`) this
 * head was sighted failing on, or `undefined` — read by Resolve problem's red-head
 * leg, so it leaves a head the episode covers alone.
 */
export async function findStandingEpisodeCheckForHead(
	key: CheckFailureHeadKey,
	openedAfter: Date,
): Promise<string | undefined> {
	const [row] = await getDb()
		.select({ checkName: sharedCheckFailureEpisodes.checkName })
		.from(sharedCheckFailureEpisodes)
		.innerJoin(
			sharedCheckFailureObservations,
			and(
				eq(sharedCheckFailureObservations.projectId, sharedCheckFailureEpisodes.projectId),
				eq(sharedCheckFailureObservations.repository, sharedCheckFailureEpisodes.repository),
				eq(sharedCheckFailureObservations.checkName, sharedCheckFailureEpisodes.checkName),
			),
		)
		.where(
			and(
				eq(sharedCheckFailureEpisodes.projectId, key.projectId),
				eq(sharedCheckFailureEpisodes.repository, key.repository),
				isNull(sharedCheckFailureEpisodes.resolvedAt),
				gt(sharedCheckFailureEpisodes.openedAt, openedAfter),
				eq(sharedCheckFailureObservations.prNumber, key.prNumber),
				eq(sharedCheckFailureObservations.headSha, key.headSha),
			),
		)
		.limit(1);
	return row?.checkName;
}
