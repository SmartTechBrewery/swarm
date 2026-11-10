/**
 * The operator MCP server's bug-report tools (issue #1383): two reads,
 * `bug_reports_list` and `bug_report_get`, and three audited writes,
 * `bug_report_create`, `bug_report_add_occurrence` and `bug_report_set_status`.
 *
 * Each wraps a `bugReports` procedure (`../../api/routers/bugReports.ts`) through
 * {@link callerFor}, so a report is read and written exactly as its project's
 * dashboard roles allow — `contributor` to read, `member` to write, installation-wide
 * reports for instance administrators alone. The writes register through
 * `registerWriteTool`: a mandatory `reason`, a `dryRun` answered by the matching
 * `preview…` procedure (gated exactly as the write), and an `operator_actions` row.
 *
 * Filing and adding an occurrence are open to a scoped agent credential, so an
 * agent can record what it diagnosed; triage (`bug_report_set_status`) is not.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
	AddBugReportOccurrenceInputSchema,
	BUG_REPORT_STATUS_DESCRIPTIONS,
	BUG_REPORT_STATUSES,
	CreateBugReportInputSchema,
	GetBugReportInputSchema,
	ListBugReportsInputSchema,
	OPEN_BUG_REPORT_STATUSES,
	SetBugReportStatusInputSchema,
} from '../../api/bug-reports.js';
import type { ToolContext } from '../tool-access.js';
import { callerFor, runTool } from '../tool-helpers.js';
import { registerWriteTool } from '../write-tool.js';

/** Every status and its meaning, as one sentence a calling model reads. */
const STATUS_GLOSSARY = `Statuses: ${BUG_REPORT_STATUSES.map(
	(status) => `\`${status}\` — ${BUG_REPORT_STATUS_DESCRIPTIONS[status]}`,
).join('; ')}. Open: ${OPEN_BUG_REPORT_STATUSES.map((status) => `\`${status}\``).join(', ')}.`;

const listShape = ListBugReportsInputSchema.shape;
const listInput = {
	projectId: listShape.projectId.describe(
		'Only reports of this project id. Omit to list every project you can read (plus installation-wide reports, for an instance administrator).',
	),
	status: listShape.status.describe(
		'Only reports in this status, or in any of an array of statuses. Omit for the open ones (`new`, `confirmed`, `environmental`, `ticketed`).',
	),
	query: listShape.query.describe(
		'Case-insensitive text to find in the title or the description. Search with it before filing a report.',
	),
	limit: listShape.limit.describe('Page size (1–200, default 50).'),
	offset: listShape.offset.describe('Rows to skip, for paging (default 0).'),
};

const getShape = GetBugReportInputSchema.shape;
const getInput = {
	reportId: getShape.reportId.describe('The report id, as `bug_reports_list` returns it.'),
	occurrenceLimit: getShape.occurrenceLimit.describe(
		'How many of its newest occurrences to return (1–200, default 50).',
	),
};

/** The occurrence fields, shared by filing and adding an occurrence. */
const createShape = CreateBugReportInputSchema.shape;
const occurrenceInput = {
	runId: createShape.runId.describe(
		"The run it was observed on. Places a new report in the run's project; must be a run you can read.",
	),
	dispatchId: createShape.dispatchId.describe('The dispatch it was observed on.'),
	prNumber: createShape.prNumber.describe('The pull request number it was observed on.'),
	taskId: createShape.taskId.describe('The task id (issue/card) it was observed on.'),
	repository: createShape.repository.describe(
		'The repository it was observed in, as the project names it (e.g. `owner/repo`).',
	),
	note: createShape.note.describe('What this occurrence looked like (an error line, a symptom).'),
	filedByRunId: createShape.filedByRunId.describe(
		'When an agent is filing: the id of the run it is working in. Must be a run you can read.',
	),
};

const createInput = {
	title: createShape.title.describe('A one-line summary of the problem (at most 200 characters).'),
	description: createShape.description.describe(
		'What goes wrong, what you expected, and what you found out about the cause.',
	),
	projectId: createShape.projectId.describe(
		'The project it was observed in. Omit to take it from `runId`; with neither, the report is installation-wide (instance administrators only).',
	),
	status: createShape.status.describe(
		'`new` (default), `confirmed` or `environmental` — the other statuses are reached by `bug_report_set_status`.',
	),
	...occurrenceInput,
};

const addShape = AddBugReportOccurrenceInputSchema.shape;
const addOccurrenceInput = {
	reportId: addShape.reportId.describe('The report seen again, as `bug_reports_list` returns it.'),
	...occurrenceInput,
};

const statusShape = SetBugReportStatusInputSchema.shape;
const setStatusInput = {
	reportId: statusShape.reportId.describe('The report to triage.'),
	status: statusShape.status.describe('The new status.'),
	duplicateOfId: statusShape.duplicateOfId.describe(
		'With `duplicate` (required there): the report this one duplicates. Refused with any other status.',
	),
	githubIssueUrl: statusShape.githubIssueUrl.describe(
		'An https link to the issue the report became. Required with `ticketed` unless the report already has one; stored with any status.',
	),
};

/** Register the bug-report tools on `server`, authorizing (and auditing) every call as `context`'s user. */
export function registerBugReportTools(server: McpServer, context: ToolContext): void {
	server.registerTool(
		'bug_reports_list',
		{
			title: 'List bug reports',
			description:
				"Read-only. Lists SWARM's own bug reports — defects in SWARM, or in what it runs on, " +
				'that an agent or a person observed — most recently seen first, as `{ data, total }`. ' +
				'Each row carries its title, description, status, project (`null` for an ' +
				'installation-wide report), `occurrenceCount`, `firstSeenAt`/`lastSeenAt`, ' +
				'`duplicateOfId`, `githubIssueUrl` and who filed it. Search with `query` before ' +
				'filing a report with `bug_report_create`. ' +
				STATUS_GLOSSARY,
			inputSchema: listInput,
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		(input) =>
			runTool(context, 'bug_reports_list', () => callerFor(context.user).bugReports.list(input)),
	);

	server.registerTool(
		'bug_report_get',
		{
			title: 'Get a bug report',
			description:
				'Read-only. Reads one bug report with its newest occurrences — the run, dispatch, ' +
				'pull request, task and note of each time it was observed, and who recorded it — as ' +
				'`{ report, occurrences, duplicateOf }`. `duplicateOf` names the original of a ' +
				'`duplicate` when you can read it. A report you cannot read is reported as not found.',
			inputSchema: getInput,
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		(input) =>
			runTool(context, 'bug_report_get', () => callerFor(context.user).bugReports.get(input)),
	);

	registerWriteTool(server, context, {
		name: 'bug_report_create',
		title: 'File a bug report',
		description:
			'WRITE. Files a new bug report about SWARM, with its first occurrence. **Search first** ' +
			'(`bug_reports_list` with `query`): when the problem is already reported, call ' +
			'`bug_report_add_occurrence` on that report instead of filing a duplicate. The report ' +
			"belongs to `projectId`, else to `runId`'s project; with neither it is installation-wide, " +
			'which only an instance administrator may file. Use `environmental` when the cause lies ' +
			'outside SWARM (network, CLI quota, Docker, a machine) — such a report is potentially not ' +
			"actionable. Needs `member` on the report's project. Requires a `reason`; pass " +
			'`dryRun: true` to see the report it would write. ' +
			STATUS_GLOSSARY,
		inputSchema: createInput,
		destructive: false,
		targetOf: (input) => input.projectId ?? input.runId ?? 'installation',
		preview: async (input, caller) => {
			const plan = await caller.bugReports.previewCreate(input);
			return { projectId: plan.projectId, plan };
		},
		apply: (input, caller) => caller.bugReports.create(input),
	});

	registerWriteTool(server, context, {
		name: 'bug_report_add_occurrence',
		title: 'Record another occurrence of a bug report',
		description:
			'WRITE. Records that a reported problem was observed again — on which run, dispatch, ' +
			"pull request or task, with a note — and bumps the report's `occurrenceCount` and " +
			'`lastSeenAt`. Use it instead of filing a duplicate. A closed or `duplicate` report still ' +
			"accepts one, and the dry run warns about it (naming a duplicate's original, which may be " +
			"the better place). A `runId` must belong to the report's project. Needs `member` on the " +
			"report's project. Requires a `reason`; pass `dryRun: true` first to see what it would record.",
		inputSchema: addOccurrenceInput,
		destructive: false,
		targetOf: (input) => input.reportId,
		preview: async (input, caller) => {
			const plan = await caller.bugReports.previewAddOccurrence(input);
			return { projectId: plan.projectId, plan };
		},
		apply: (input, caller) => caller.bugReports.addOccurrence(input),
	});

	registerWriteTool(server, context, {
		name: 'bug_report_set_status',
		title: "Change a bug report's status",
		description:
			'WRITE. Triages a bug report: sets its status, and with it the report it duplicates ' +
			'(`duplicate` needs `duplicateOfId`) or the link to the issue it became (`ticketed` ' +
			'needs `githubIssueUrl`). Turning a report into a GitHub issue happens outside SWARM — ' +
			"file the issue, then record it here with `{ status: 'ticketed', githubIssueUrl }`. " +
			'Re-setting the current status with nothing else changed is refused. Needs `member` on ' +
			"the report's project. Requires a `reason`; pass `dryRun: true` first to see the change. " +
			STATUS_GLOSSARY,
		inputSchema: setStatusInput,
		destructive: false,
		targetOf: (input) => input.reportId,
		preview: async (input, caller) => {
			const plan = await caller.bugReports.previewSetStatus(input);
			return { projectId: plan.projectId, plan };
		},
		apply: (input, caller) => caller.bugReports.setStatus(input),
	});
}
