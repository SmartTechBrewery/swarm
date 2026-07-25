/**
 * "Is this PR one SWARM manages?" — the ownership gate the `pr-review` trigger
 * applies before it spends a review on a PR (`handlers/review.ts`).
 *
 * **Why not the PR's author.** SWARM used to answer this by matching the PR
 * author against its own persona logins (`isSwarmBot`). Under the federated
 * model (ADR-004 §3, issue #397) the implementer credential is the *worker
 * operator's own* GitHub token, so a SWARM PR is authored by a plain user
 * account — and `resolvePersonaIdentities` only ever resolves the identities of
 * the process it runs in, so the control plane cannot even name the operator
 * that opened a PR on another machine. An author gate therefore skips every
 * federated PR (auto-review silently stops firing) while *accepting* the same
 * operator's hand-written PRs. Author identity stopped carrying the signal.
 *
 * **What does.** SWARM opens every PR from a branch it named itself
 * (`<branchPrefix><workItemNumber>`, `GitWorktreeManager.provision`) and leaves
 * a best-effort `runs` row for every phase it dispatched. So a PR is SWARM-managed iff its
 * head branch decodes to a work-item number under the project's `branchPrefix`
 * **and** SWARM has an `implementation` run row for that work item in that
 * project. Both halves are provider-agnostic (ai/RULES.md §2): no GitHub URL or
 * payload shape is parsed, and `runs` is SWARM's own table.
 *
 * The run row is the stronger half: it exists only because the composition root
 * (`src/worker/consumer.ts`) already verified board membership *and* the `pipeline.automationLabel`
 * opt-in before `tryCreateRun` at dispatch. A human PR that merely happens to
 * sit on an `issue-42` branch is only claimed once SWARM itself has worked that
 * item — which is the intended reading of "linked to a SWARM work item", not a
 * bug. The lookup is deliberately status-agnostic and never requires
 * `runs.workerId`: Implementation opens its PR from inside its still-running
 * process, and `workerId` is NULL on every unfederated project.
 *
 * The independent-reviewer invariant (PROJECT.md §5.3) is unaffected — it is
 * maintained by the reviewer persona the Review phase submits under, not by who
 * authored the PR.
 */

import type { ProjectConfig } from '../config/schema.js';
import { hasRunForTask as hasRunForTaskDefault } from '../db/repositories/runsRepository.js';
import { issueNumberFromBranch } from '../pipeline/task-branch.js';

export interface SwarmManagedPrDeps {
	/** Injectable run-history read — defaults to the real repository call. */
	hasRunForTask?: typeof hasRunForTaskDefault;
}

export type SwarmManagedPrResult =
	| { managed: true; taskId: string }
	| { managed: false; reason: 'not-a-task-branch' }
	| { managed: false; reason: 'no-run'; taskId: string };

/**
 * Whether `headBranch` belongs to a PR SWARM manages (see the module header).
 * Returns a discriminated result distinguishing non-task branches from
 * task branches lacking an Implementation run row.
 * A branch outside the project's `branchPrefix` — or a missing one — is a
 * definitive `'not-a-task-branch'` and costs no query. A failing run-history lookup throws:
 * the caller owns the defer-vs-skip decision, since dropping a legitimate
 * review over a transient DB blip is worse than a bounded recheck.
 */
export async function isSwarmManagedPullRequest(
	project: ProjectConfig,
	headBranch: string | undefined,
	deps: SwarmManagedPrDeps = {},
): Promise<SwarmManagedPrResult> {
	const taskId = headBranch
		? issueNumberFromBranch(headBranch, project.branchPrefix, { strict: true })
		: undefined;
	if (!taskId) return { managed: false, reason: 'not-a-task-branch' };

	// Scoped to `implementation`: it is the only phase that opens a PR, and an
	// unscoped lookup could match a `review` run whose taskId (a PR number)
	// numerically collides with this branch's work-item number.
	const hasRunForTask = deps.hasRunForTask ?? hasRunForTaskDefault;
	const hasRun = await hasRunForTask(project.id, taskId, 'implementation');
	if (!hasRun) return { managed: false, reason: 'no-run', taskId };

	return { managed: true, taskId };
}
