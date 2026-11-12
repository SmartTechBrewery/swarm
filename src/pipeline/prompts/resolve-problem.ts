/**
 * Resolve-problem-phase prompt construction (issue #1395), following
 * `./resolve-conflicts.ts`: only the phase's instruction text lives here, the
 * orchestration in `src/pipeline/resolve-problem.ts`.
 *
 * The phase is the odd one out: its agent works on SWARM itself rather than on a
 * repository. It runs in an empty scratch directory with the SWARM operator MCP
 * server attached, under a short-lived credential bound to this run, and its job
 * is to find out why one run failed — or, since issue #1425, why one ticket holding
 * a WIP slot stopped moving — and, within hard limits, get the pipeline moving
 * again. So, unlike every other phase prompt, this one names no checkout,
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

/**
 * The stuck ticket a ticket attempt is about (issue #1425): a WIP slot holder the
 * panel shows as Waiting on you because it stopped moving.
 */
export interface ResolveProblemStuckTicket {
	taskId: string;
	/** The slot's repository (`owner/repo`). */
	repository: string;
	reason: 'stalled';
	/** ISO 8601 — when the ticket took its slot. */
	slotOpenedAt: string;
	/** ISO 8601 — when the ticket last moved, when it has run at all. */
	lastActivityAt?: string;
	prNumber?: string;
	workItemId?: string;
}

/** The runtime context the Resolve problem prompt is built from. */
export interface ResolveProblemPromptInput {
	project: { id: string; repo: string };
	/** This Resolve problem run's own id — what `filedByRunId` must name. */
	runId: string;
	/**
	 * The failed run a run attempt is about, or a ticket attempt's anchor — the
	 * ticket's latest run, when it has one. One of this and `ticket` is required.
	 */
	failedRun?: ResolveProblemFailedRun;
	/** A ticket attempt (issue #1425): the stuck ticket it is about. */
	ticket?: ResolveProblemStuckTicket;
	/** The real (non-dry-run) write calls the run's credential allows. */
	maxWriteActions: number;
}

/** The longest stretch of the failed run's error quoted into the prompt. */
const ERROR_QUOTE_LIMIT = 4_000;

function quotedError(error: string | null | undefined): string {
	if (!error) return '(no error was recorded)';
	return error.length > ERROR_QUOTE_LIMIT ? `${error.slice(0, ERROR_QUOTE_LIMIT - 1)}…` : error;
}

/** What SWARM knows about one run, as the agent's starting point. */
function runSection(
	heading: string,
	failedRun: ResolveProblemFailedRun,
	project: ResolveProblemPromptInput['project'],
): string[] {
	const lines = [
		heading,
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

/** What SWARM knows about the stuck ticket, as the agent's starting point. */
function ticketSection(
	ticket: ResolveProblemStuckTicket,
	project: ResolveProblemPromptInput['project'],
): string[] {
	return [
		'--- THE STUCK TICKET ---',
		`Task: ${ticket.taskId}`,
		`Project: ${project.id} (repository ${ticket.repository})`,
		`Pull request: ${ticket.prNumber ? `#${ticket.prNumber}` : '(none)'}`,
		`Board card: ${ticket.workItemId ?? '(none recorded)'}`,
		`Why it waits on a person: ${ticket.reason} — it holds a WIP slot, and no run or dispatch has moved it`,
		`Slot held since: ${ticket.slotOpenedAt}`,
		`Last moved: ${ticket.lastActivityAt ?? '(it has not run since taking the slot)'}`,
	];
}

/** The "what happened" lines of the prompt: a failed run, or a stuck ticket. */
function subjectLine(input: ResolveProblemPromptInput): string {
	const { ticket, runId } = input;
	if (ticket) {
		const since = ticket.lastActivityAt ?? ticket.slotOpenedAt;
		return `A ticket holding one of SWARM's WIP slots has stopped moving: task ${ticket.taskId} in ${ticket.repository}, with no run and no dispatch since ${since}. Your job is to find out why, and — only where SWARM's own recovery tools can do it safely — get the pipeline moving again. Your own run id is ${runId}.`;
	}
	return `A SWARM pipeline run failed: run ${input.failedRun?.id}. Your job is to find out why, and — only where SWARM's own recovery tools can do it safely — get the pipeline moving again. Your own run id is ${runId}.`;
}

function diagnoseLine(input: ResolveProblemPromptInput): string {
	if (input.ticket) {
		const anchor = input.failedRun ? `\`run_get\` on its latest run (${input.failedRun.id}), ` : '';
		return `Diagnose first, through the read tools: ${anchor}\`runs_list\` for the task’s runs, \`dispatch_history\` for what SWARM tried to dispatch for it, and \`pipeline_snapshot\` for the project around it. Name the cause before you change anything.`;
	}
	return 'Diagnose first, through the read tools: `run_get` on the failed run (its error, diagnosis, logs and recovery state), `runs_list` for the task’s other runs, and `dispatch_history` for what SWARM tried to dispatch around it. Name the cause before you change anything.';
}

/**
 * The pull request the attempt is about, when it has one: the ticket's own (or its
 * anchor run's) for a ticket attempt, the failed run's otherwise.
 */
function subjectPullRequest(
	input: ResolveProblemPromptInput,
): { repository: string; prNumber: string } | undefined {
	const prNumber = input.ticket?.prNumber ?? input.failedRun?.prNumber;
	if (!prNumber) return undefined;
	return { repository: input.ticket?.repository ?? input.project.repo, prNumber };
}

/**
 * The live pull-request check (issue #1441): SWARM's own records do not see a
 * merge, close or push made outside SWARM, so the agent asks the provider before it
 * acts — and reports `already-resolved` when the pull request is no longer open.
 */
function livePullRequestLine(input: ResolveProblemPromptInput): string[] {
	const pr = subjectPullRequest(input);
	if (!pr) return [];
	const call = `\`pr_live_state\` (\`projectId: "${input.project.id}"\`, \`repository: "${pr.repository}"\`, \`prNumber: ${pr.prNumber}\`)`;
	return [
		`SWARM’s own records (\`run_get\`, \`pr_status\`) do not see a merge, a close or a push made outside SWARM. So call ${call} to read pull request #${pr.prNumber}’s live state from the source-control provider before any remedy, and again before you write your report. If it is \`merged\` or \`closed\`, the failure no longer blocks anything: make no recovery write, and do not tell the operator to re-run, merge or push anything. Still record the bug report below, then report \`already-resolved\` with a summary naming the pull request’s state and head as the reason.`,
	];
}

/**
 * Which record the bug report names: the failed run (or a ticket's anchor run)
 * through `runId`, or — for a ticket that never ran — its task, filed under the
 * project (`bug_report_create` takes the project from `runId` only when there is one).
 */
function bugReportSubject(input: ResolveProblemPromptInput): string {
	return input.failedRun
		? `\`runId: "${input.failedRun.id}"\``
		: `\`taskId: "${input.ticket?.taskId}"\` — and \`projectId: "${input.project.id}"\` to \`bug_report_create\` — but no \`runId\`, since the ticket has no run`;
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
	const { failedRun, ticket, runId, maxWriteActions, project } = input;
	const subjectSections = ticket
		? [
				ticketSection(ticket, project).join('\n'),
				...(failedRun ? [runSection('--- ITS LATEST RUN ---', failedRun, project).join('\n')] : []),
			]
		: failedRun
			? [runSection('--- THE FAILED RUN ---', failedRun, project).join('\n')]
			: [];
	const reasonSubject = ticket ? 'the stuck ticket' : 'the failed run';
	return [
		'You are the operator agent assigned only to SWARM’s Resolve problem phase.',
		...pipelinePhaseGuard(),
		subjectLine(input),
		'You have the SWARM operator MCP server (`swarm`) attached, under a credential that works only for this project, only for this run, and only until this run ends. You have no repository checkout: your working directory is an empty scratch directory.',
		diagnoseLine(input),
		...livePullRequestLine(input),
		`Then try remedies one at a time. After each one, check with the read tools whether the pipeline actually moved before you try the next. Never repeat an action on the same target. You may make at most ${maxWriteActions} real (non-dry-run) write calls in this run; SWARM refuses any beyond that.`,
		`Every write tool takes \`dryRun\` and a mandatory \`reason\`. Call each write with \`dryRun: true\` first and read the preview, then repeat it for real only if the preview shows exactly what you intend. Give every call a specific \`reason\` naming ${reasonSubject} and the cause you found.`,
		'Hard limits — never cross them, even if a tool would let you: never change code; never edit, push to, approve or merge a pull request; never override a safety stop SWARM placed on purpose — the review-verdict cap, merge-retry-exhausted, a user termination and anything like them. A safety stop is a hand-off to a person: report it, do not undo it. If the only fix is one of these, leave the problem unresolved and say so.',
		...(ticket
			? [
					'If no SWARM tool can move the ticket — for example, its board card needs a move only a person can make — leave it unresolved and say exactly what the person should do.',
				]
			: []),
		`Record what you found, whatever the outcome: search \`bug_reports_list\` (with \`query\`) for a report of the same problem. If one exists, add an occurrence to it with \`bug_report_add_occurrence\`; otherwise create one with \`bug_report_create\`. Either way pass ${bugReportSubject(input)} and \`filedByRunId: "${runId}"\` — SWARM checks that this run filed one and fails the run otherwise. Use status \`environmental\` for a cause outside SWARM (the network, a CLI quota, Docker, a machine).`,
		`Finally write \`${RESOLVE_PROBLEM_REPORT_FILENAME}\` in your working directory as JSON: \`{ "outcome": "resolved" | "already-resolved" | "unresolved", "bugReportId": "<the report you created or added to>", "actions": [{ "tool": "<tool name>", "target": "<what it acted on>", "result": "<what happened>" }], "summary": "<the cause and what you did, for the operator>" }\`. List every real write in \`actions\` (an empty list if you made none). Say \`resolved\` only when you saw the pipeline move again; \`already-resolved\` when the problem was already gone before you fixed anything — its pull request merged or closed outside SWARM, or a newer run already did the work — with the summary saying how you know; otherwise \`unresolved\`, with the summary saying what a person needs to do next.`,
		...subjectSections,
		...projectInstructionsParagraph(customPrompt),
	].join('\n\n');
}
