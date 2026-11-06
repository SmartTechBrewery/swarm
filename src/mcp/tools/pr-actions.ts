/**
 * The operator MCP server's pull-request write tools (issue #1348):
 * `pr_force_re_review` and `pr_recheck_mergeability`, both registered through the
 * audited write-tool framework (`../write-tool.ts`) — a mandatory `reason`, a
 * `dryRun`, and an `operator_actions` row for every call.
 *
 * Each wraps the dashboard's own procedure through the framework's caller:
 * `pr_force_re_review` is `runs.forceReReview` (the run page's "Force re-review"),
 * and `pr_recheck_mergeability` is `runs.recheckMergeability`, which schedules the
 * conflict check a merged sibling's resolve-conflicts fan-out would have. Both need
 * `member` on the project, and their dry runs — `runs.previewForceReReview` and
 * `runs.previewMergeabilityRecheck` — are gated at the same role and report the
 * same refusals in the same words.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { SwarmUser } from '../../identity/schema.js';
import { registerWriteTool } from '../write-tool.js';

const forceReReviewInput = {
	runId: z
		.string()
		.min(1)
		.describe('The completed Review run the review cap stopped (as `runs_list` reports it).'),
};

const recheckInput = {
	projectId: z.string().min(1).describe('The project id.'),
	repository: z
		.string()
		.min(1)
		.describe('The repository the pull request is in, exactly as the project configures it.'),
	prNumber: z.number().int().positive().describe('The pull request number.'),
};

/** Register the pull-request write tools on `server`, authorizing and auditing every call as `user`. */
export function registerPullRequestActionTools(server: McpServer, user: SwarmUser): void {
	registerWriteTool(server, user, {
		name: 'pr_force_re_review',
		title: 'Force a re-review past the review cap',
		description:
			'WRITE. Continues a pull request the review-verdict cap stopped, as the run page\'s "Force ' +
			're-review" does: for a Review run whose last permitted verdict requested changes, grants ' +
			'one extra review and dispatches Respond-to-review; for a cap-spent approval that merge ' +
			'automation refused because a later push moved the head, grants one extra review and ' +
			'dispatches a Review of the current head. Refused when the head did not move after that ' +
			'approval (`head-unchanged`), for a closed pull request, and for a run the cap did not ' +
			"stop. Needs `member` on the run's project. Requires a `reason`; pass `dryRun: true` " +
			'first to see the cap state and whether the head moved.',
		inputSchema: forceReReviewInput,
		destructive: false,
		targetOf: (input) => input.runId,
		preview: async (input, caller) => {
			const plan = await caller.runs.previewForceReReview({ runId: input.runId });
			return { projectId: plan.run.projectId, plan };
		},
		apply: (input, caller) => caller.runs.forceReReview({ runId: input.runId }),
	});

	registerWriteTool(server, user, {
		name: 'pr_recheck_mergeability',
		title: "Re-check a pull request's mergeability",
		description:
			"WRITE. Schedules the conflict check a merged sibling's resolve-conflicts fan-out would " +
			'have scheduled for this pull request, against its own base, superseding one already ' +
			'pending. The check reads mergeability and dispatches Resolve-conflicts when the pull ' +
			'request genuinely conflicts — use it when a fan-out skipped this pull request. Refused ' +
			'for a closed pull request. Needs `member` on the project. Requires a `reason`; pass ' +
			"`dryRun: true` first to see the pull request's current mergeability and the job.",
		inputSchema: recheckInput,
		destructive: false,
		targetOf: (input) => `${input.repository}#${input.prNumber}`,
		preview: async (input, caller) => ({
			projectId: input.projectId,
			plan: await caller.runs.previewMergeabilityRecheck(input),
		}),
		apply: (input, caller) => caller.runs.recheckMergeability(input),
	});
}
