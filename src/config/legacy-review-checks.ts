/**
 * Adoption of the pre-#1109 project-wide Review check policy and check wait.
 *
 * Review's zero-check policy and its wait budget used to be `pipeline.review.checks`
 * and `pipeline.review.checksWaitMinutes`, one value each for every repository a
 * project owns. Issue #1109 moved them onto each `repositories[]` entry
 * (`ProjectRepositorySchema.reviewChecks` / `reviewChecksWaitMinutes`, `./schema.ts`),
 * because whether a repository has CI is a property of that repository. An
 * unmigrated `swarm.config.json` must keep its behaviour rather than lose the
 * settings: `pipeline.review` is a non-strict object, so the old keys would otherwise
 * be stripped silently and every repository would fall back to the defaults.
 *
 * The rules — the #1066 `autoMerge` adoption's (`./legacy-auto-merge.ts`), applied to
 * each key independently:
 * - every entry that states no `reviewChecks` takes `review.checks`, and every entry
 *   that states no `reviewChecksWaitMinutes` takes `review.checksWaitMinutes`; an
 *   entry's own value wins;
 * - values are copied as-is, so an invalid one fails validation on the entry
 *   (`repositories.<i>.reviewChecks`) instead of disappearing;
 * - both legacy keys are then removed from `pipeline.review`, keeping its other keys,
 *   so the result is already in the new shape and adopting it again is a no-op.
 *
 * Only `ProjectRecordSchema` applies this — the scoped config has no `repositories`
 * list to copy onto, and no operator-authored surface parses one. Persisted rows are
 * migrated by its SQL twin, migration 0080, since a DB read does not re-parse.
 */

export function adoptLegacyReviewChecks(raw: unknown): unknown {
	if (!isRecord(raw)) return raw;
	const pipeline = raw.pipeline;
	if (!isRecord(pipeline)) return raw;
	const review = pipeline.review;
	if (!isRecord(review)) return raw;
	if (review.checks === undefined && review.checksWaitMinutes === undefined) return raw;
	if (!Array.isArray(raw.repositories)) return raw;

	const { checks, checksWaitMinutes, ...rest } = review;
	const repositories = raw.repositories.map((entry: unknown) => {
		if (!isRecord(entry)) return entry;
		return {
			...entry,
			...(entry.reviewChecks === undefined && checks !== undefined ? { reviewChecks: checks } : {}),
			...(entry.reviewChecksWaitMinutes === undefined && checksWaitMinutes !== undefined
				? { reviewChecksWaitMinutes: checksWaitMinutes }
				: {}),
		};
	});
	return { ...raw, repositories, pipeline: { ...pipeline, review: rest } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
