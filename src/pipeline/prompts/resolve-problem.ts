/**
 * Resolve-problem-phase prompt construction (issue #1395), following
 * `./resolve-conflicts.ts`: only the phase's instruction text lives here, the
 * orchestration in `src/pipeline/resolve-problem.ts`.
 *
 * The phase is the odd one out: its agent works on SWARM itself rather than on a
 * repository. It runs in an empty scratch directory with the SWARM operator MCP
 * server attached, under a short-lived credential bound to this run, and its job
 * is to find out why one run failed and — within hard limits — get the pipeline
 * moving again. So, unlike every other phase prompt, this one names no checkout,
 * no branch and no pull request to change, and states the guardrails the server
 * itself enforces (dry-run first, a `reason` on every write, a write cap) so the
 * agent plans with them rather than discovering them.
 */

import { pipelinePhaseGuard } from '@/pipeline/agent-scope.js';
import { projectInstructionsParagraph } from '@/pipeline/prompts/custom-prompt.js';
import type { FailureDiagnosis } from '@/worker/failure-diagnosis.js';

/** The hand-off file the agent writes in its working directory. */
export const RESOLVE_PROBLEM_REPORT_FILENAME = 'resolve_problem_report.json';

/** The failed run a Resolve problem attempt is about, as SWARM recorded it. */
export interface ResolveProblemFailedRun {
	id: string;
	phase: string;
	taskId: string | null;
	prNumber?: string | null;
	error?: string | null;
	failureDiagnosis?: FailureDiagnosis | null;
}

/** The runtime context the Resolve problem prompt is built from. */
export interface ResolveProblemPromptInput {
	project: { id: string; repo: string };
	/** This Resolve problem run's own id — what `filedByRunId` must name. */
	runId: string;
	failedRun: ResolveProblemFailedRun;
	/** The real (non-dry-run) write calls the run's credential allows. */
	maxWriteActions: number;
}

/** The longest stretch of the failed run's error quoted into the prompt. */
const ERROR_QUOTE_LIMIT = 4_000;

function quotedError(error: string | null | undefined): string {
	if (!error) return '(no error was recorded)';
	return error.length > ERROR_QUOTE_LIMIT ? `${error.slice(0, ERROR_QUOTE_LIMIT - 1)}…` : error;
}

/** What SWARM knows about the failed run, as the agent's starting point. */
function failedRunSection(input: ResolveProblemPromptInput): string[] {
	const { failedRun, project } = input;
	const lines = [
		'--- THE FAILED RUN ---',
		`Run id: ${failedRun.id}`,
		`Project: ${project.id} (repository ${project.repo})`,
		`Phase: ${failedRun.phase}`,
		`Task: ${failedRun.taskId ?? '(none)'}`,
		`Pull request: ${failedRun.prNumber ? `#${failedRun.prNumber}` : '(none)'}`,
		'Error:',
		'```',
		quotedError(failedRun.error),
		'```',
	];
	const diagnosis = failedRun.failureDiagnosis;
	if (diagnosis) {
		lines.push(
			`SWARM's failure diagnosis (${diagnosis.kind}): ${diagnosis.title}`,
			diagnosis.message,
			`Suggested recovery: ${diagnosis.recovery}`,
		);
	} else {
		lines.push('SWARM recorded no failure diagnosis for it.');
	}
	return lines;
}

/**
 * Build the prompt handed to the Resolve problem agent. `customPrompt` is the
 * project's optional `agents.resolveProblem.prompt`, appended after the SWARM
 * instructions as a supplement-only section (empty when unset).
 */
export function buildResolveProblemPrompt(
	input: ResolveProblemPromptInput,
	customPrompt?: string,
): string {
	const { failedRun, runId, maxWriteActions } = input;
	return [
		'You are the operator agent assigned only to SWARM’s Resolve problem phase.',
		...pipelinePhaseGuard(),
		`A SWARM pipeline run failed: run ${failedRun.id}. Your job is to find out why, and — only where SWARM's own recovery tools can do it safely — get the pipeline moving again. Your own run id is ${runId}.`,
		'You have the SWARM operator MCP server (`swarm`) attached, under a credential that works only for this project, only for this run, and only until this run ends. You have no repository checkout: your working directory is an empty scratch directory.',
		'Diagnose first, through the read tools: `run_get` on the failed run (its error, diagnosis, logs and recovery state), `runs_list` for the task’s other runs, and `dispatch_history` for what SWARM tried to dispatch around it. Name the cause before you change anything.',
		`Then try remedies one at a time. After each one, check with the read tools whether the pipeline actually moved before you try the next. Never repeat an action on the same target. You may make at most ${maxWriteActions} real (non-dry-run) write calls in this run; SWARM refuses any beyond that.`,
		'Every write tool takes `dryRun` and a mandatory `reason`. Call each write with `dryRun: true` first and read the preview, then repeat it for real only if the preview shows exactly what you intend. Give every call a specific `reason` naming the failed run and the cause you found.',
		'Hard limits — never cross them, even if a tool would let you: never change code; never edit, push to, approve or merge a pull request; never override a safety stop SWARM placed on purpose — the review-verdict cap, merge-retry-exhausted, a user termination and anything like them. A safety stop is a hand-off to a person: report it, do not undo it. If the only fix is one of these, leave the problem unresolved and say so.',
		`Record what you found, whatever the outcome: search \`bug_reports_list\` (with \`query\`) for a report of the same problem. If one exists, add an occurrence to it with \`bug_report_add_occurrence\`; otherwise create one with \`bug_report_create\`. Either way pass \`runId: "${failedRun.id}"\` and \`filedByRunId: "${runId}"\` — SWARM checks that this run filed one and fails the run otherwise. Use status \`environmental\` for a cause outside SWARM (the network, a CLI quota, Docker, a machine).`,
		`Finally write \`${RESOLVE_PROBLEM_REPORT_FILENAME}\` in your working directory as JSON: \`{ "outcome": "resolved" | "unresolved", "bugReportId": "<the report you created or added to>", "actions": [{ "tool": "<tool name>", "target": "<what it acted on>", "result": "<what happened>" }], "summary": "<the cause and what you did, for the operator>" }\`. List every real write in \`actions\` (an empty list if you made none). Say \`resolved\` only when you saw the pipeline move again; otherwise \`unresolved\`, with the summary saying what a person needs to do next.`,
		failedRunSection(input).join('\n'),
		...projectInstructionsParagraph(customPrompt),
	].join('\n\n');
}
