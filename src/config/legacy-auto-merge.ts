/**
 * Adoption of the pre-#1066 project-wide merge-automation key.
 *
 * Merge automation used to be `pipeline.respondToReview.autoMerge`, one switch for
 * every repository a project owns. Issue #1066 moved it onto each
 * `repositories[]` entry (`ProjectRepositorySchema.autoMerge`, `./schema.ts`), and
 * an unmigrated `swarm.config.json` must keep its behaviour rather than lose the
 * setting: `pipeline.respondToReview` is a non-strict object, so the old key would
 * otherwise be stripped silently and every repository would stop merging.
 *
 * The rules:
 * - every entry that states no `autoMerge` of its own takes the legacy value; an
 *   entry's own value wins;
 * - the value is copied as-is, so a non-boolean fails validation on the entry
 *   (`repositories.<i>.autoMerge`) instead of disappearing;
 * - the legacy key is then removed from `pipeline.respondToReview`, so the result is
 *   already in the new shape and adopting it again is a no-op.
 *
 * Only `ProjectRecordSchema` applies this — the scoped config has no `repositories`
 * list to copy onto, and no operator-authored surface parses one. Persisted rows are
 * migrated by its SQL twin, migration 0076, since a DB read does not re-parse.
 */

export function adoptLegacyAutoMerge(raw: unknown): unknown {
	if (!isRecord(raw)) return raw;
	const pipeline = raw.pipeline;
	if (!isRecord(pipeline)) return raw;
	const respondToReview = pipeline.respondToReview;
	if (!isRecord(respondToReview) || respondToReview.autoMerge === undefined) return raw;
	if (!Array.isArray(raw.repositories)) return raw;

	const { autoMerge: legacy, ...rest } = respondToReview;
	const repositories = raw.repositories.map((entry: unknown) =>
		isRecord(entry) && entry.autoMerge === undefined ? { ...entry, autoMerge: legacy } : entry,
	);
	return { ...raw, repositories, pipeline: { ...pipeline, respondToReview: rest } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
