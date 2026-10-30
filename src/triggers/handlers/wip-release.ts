/**
 * The `wip-release` trigger (issue #1185): a ticket's pull request closing — merged
 * or abandoned — frees the ticket's slot in its repository's WIP limit, which starts
 * the next ticket waiting for one.
 *
 * A side effect only: `handle` always returns `null`, the registry's "not for me,
 * keep going", so the same merged close still reaches `resolve-conflicts`. Every
 * source-control provider normalizes a close to `pull-request` / `closed` with
 * `merged` beside it, and SWARM's own merges arrive the same way — ingress loop
 * prevention drops only SWARM-generated comments, never pull request lifecycle
 * events — so this covers both without naming a provider (ai/RULES.md §2).
 *
 * The ticket is recovered from SWARM's own branch naming,
 * `findTaskIdForPrBranch(project, prBranch, { strict: true })` — the branch
 * Implementation recorded, or its decode under the repository's naming (issue #1247) —
 * the derivation merge automation already uses: a branch SWARM did not name maps to no
 * ticket and frees nothing. The release is idempotent, so a pull request whose ticket held no
 * slot is a no-op.
 */

import { findTaskIdForPrBranch } from '../../dispatch/pr-branch-task.js';
import { releaseTicketSlot } from '../../dispatch/wip-limit.js';
import type { TriggerContext, TriggerHandler, TriggerResult } from '../types.js';

export function createWipReleaseTrigger(): TriggerHandler {
	return {
		name: 'wip-release',
		description: "Frees a ticket's WIP slot when its pull request is merged or closed",
		matches(ctx: TriggerContext): boolean {
			// The coalesced conflict re-checks `resolve-conflicts` fans out carry the
			// merged event they were scheduled from, and a merge catch-up is not a close
			// at all — neither is this ticket's pull request closing.
			return (
				ctx.source === 'scm' &&
				ctx.event.kind === 'pull-request' &&
				ctx.event.action === 'closed' &&
				ctx.event.conflictPrNumber === undefined &&
				ctx.mergeCatchUp === undefined
			);
		},
		async handle(ctx: TriggerContext): Promise<TriggerResult | null> {
			if (ctx.source !== 'scm' || !ctx.event.prBranch) return null;
			const taskId = await findTaskIdForPrBranch(ctx.project, ctx.event.prBranch, {
				strict: true,
			});
			if (!taskId) return null;
			await releaseTicketSlot(
				ctx.project.id,
				ctx.project.repo,
				taskId,
				ctx.event.merged === true ? 'pull-request-merged' : 'pull-request-closed',
			);
			return null;
		},
	};
}
