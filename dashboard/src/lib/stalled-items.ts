/**
 * Pure display helpers for the Stalled section (issue #847). They only derive a
 * stable key, a phase label, and the run-description shape from an
 * already-fetched {@link StalledItem}; the server owns the ordering
 * (longest-silent first) and the classification itself, so nothing here re-sorts
 * or re-decides whether an item is stalled. Kept side-effect-free and free of
 * React so they can be unit-tested in the node environment, matching the other
 * `dashboard/src/lib/*.test.ts` helpers.
 */

import type { WorkItemCellRun } from '@/components/runs/work-item-cell.js';
import { queuedPhaseHintSchema, type StalledItem } from '@/types/runs.js';
import { formatPhase } from './format.js';
import { queuedPhaseLabel } from './queued-runs.js';

/** Not a byte a project id, repository slug, or task id can contain. */
const KEY_SEPARATOR = '\u0000';

/**
 * Stable React key for a stalled row — the server's own unit identity
 * (`src/dispatch/item-liveness.ts`), which is unique across the report by
 * construction. The run id is deliberately not the key: the same unit reports a
 * different latest run as it ages, and a key that changed for a row that has not
 * moved would remount it on every poll.
 */
export function stalledItemKey(item: StalledItem): string {
	return [item.projectId, item.repository, item.unit, item.reference].join(KEY_SEPARATOR);
}

/**
 * Human-readable label for the phase a unit stopped in, reusing the Queued
 * section's vocabulary so one phase reads the same in both sections. The read
 * model types `phase` as a bare string (it is whatever the run row recorded), so
 * a value outside that vocabulary falls back to {@link formatPhase} rather than
 * rendering blank.
 */
export function stalledPhaseLabel(phase: string): string {
	const known = queuedPhaseHintSchema.safeParse(phase);
	return known.success ? queuedPhaseLabel(known.data) : formatPhase(phase);
}

/**
 * Adapt a stalled item onto the run-description shape every other run surface is
 * described by ({@link WorkItemCellRun}, `ai/DESIGN_SYSTEM.md` "Describing a
 * run's work"), so a stalled pull request reads identically here and in the Runs
 * table instead of growing a second wording — and links out through the same
 * reference line rather than a URL assembled here. The read model reports absent
 * fields as `undefined` while a run row reports `null`; that is the whole
 * difference.
 *
 * `prUrl` is the one field this shape carries that a run row does not: the server
 * resolved it through the project's own SCM provider, so a stalled GitLab or
 * Bitbucket pull request links to its own host rather than to the GitHub URL
 * `WorkItemCell` would otherwise derive from `repository` + `prNumber`.
 */
export function stalledItemRun(item: StalledItem): WorkItemCellRun {
	return {
		taskId: item.taskId,
		repository: item.repository,
		phase: item.phase,
		workItemId: item.workItemId ?? null,
		workItemTitle: item.workItemTitle ?? null,
		workItemUrl: item.workItemUrl ?? null,
		prNumber: item.prNumber ?? null,
		prUrl: item.prUrl ?? null,
		prTitle: item.prTitle ?? null,
	};
}

/** Why the section lists what it lists — shown once, under the header. */
export const STALLED_SECTION_EXPLANATION =
	'No run, no queued dispatch, and nothing due: these items need a look.';
