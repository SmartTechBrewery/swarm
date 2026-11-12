import { describe, expect, it } from 'vitest';

import {
	buildResolveProblemPrompt,
	RESOLVE_PROBLEM_REPORT_FILENAME,
	type ResolveProblemFailedRun,
	type ResolveProblemPromptInput,
} from '@/pipeline/prompts/resolve-problem.js';

const FAILED_RUN: ResolveProblemFailedRun = {
	id: 'run-failed',
	phase: 'implementation',
	taskId: '1395',
	prNumber: null,
	error: 'Agent did not write required hand-off implementation_handoff.json',
	failureDiagnosis: null,
};

const INPUT: ResolveProblemPromptInput = {
	project: { id: 'swarm', repo: 'SmartTechBrewery/swarm' },
	runId: 'run-resolve',
	failedRun: FAILED_RUN,
	maxWriteActions: 5,
};

describe('buildResolveProblemPrompt (issue #1395)', () => {
	it("carries the failed run's id, phase, task, PR and error", () => {
		const prompt = buildResolveProblemPrompt(INPUT);
		expect(prompt).toContain('Run id: run-failed');
		expect(prompt).toContain('Phase: implementation');
		expect(prompt).toContain('Task: 1395');
		expect(prompt).toContain('Pull request: (none)');
		expect(prompt).toContain('Agent did not write required hand-off implementation_handoff.json');
		expect(prompt).toContain('SWARM recorded no failure diagnosis');
	});

	it('carries the failure diagnosis when one was recorded', () => {
		const prompt = buildResolveProblemPrompt({
			...INPUT,
			failedRun: {
				...FAILED_RUN,
				prNumber: '42',
				failureDiagnosis: {
					kind: 'worker-shutdown',
					title: 'The worker disappeared',
					message: 'Its transport closed mid-run.',
					recovery: 'Reset the run.',
				},
			},
		});
		expect(prompt).toContain('Pull request: #42');
		expect(prompt).toContain('(worker-shutdown): The worker disappeared');
		expect(prompt).toContain('Its transport closed mid-run.');
		expect(prompt).toContain('Suggested recovery: Reset the run.');
	});

	it('states the guardrails: read first, one remedy at a time, dry-run with a reason, the cap', () => {
		const prompt = buildResolveProblemPrompt(INPUT);
		expect(prompt).toContain('`run_get`');
		expect(prompt).toContain('`dispatch_history`');
		expect(prompt).toContain('one at a time');
		expect(prompt).toContain('Never repeat an action on the same target');
		expect(prompt).toContain('`dryRun: true` first');
		expect(prompt).toContain('mandatory `reason`');
		expect(prompt).toContain('at most 5 real (non-dry-run) write calls');
	});

	it('forbids code changes, PR edits and merges, and overriding safety stops', () => {
		const prompt = buildResolveProblemPrompt(INPUT);
		expect(prompt).toContain('never change code');
		expect(prompt).toContain('merge a pull request');
		expect(prompt).toContain('the review-verdict cap, merge-retry-exhausted');
	});

	it('requires a bug report filed by this run and the hand-off report', () => {
		const prompt = buildResolveProblemPrompt(INPUT);
		expect(prompt).toContain('`bug_reports_list`');
		expect(prompt).toContain('`bug_report_add_occurrence`');
		expect(prompt).toContain('`bug_report_create`');
		expect(prompt).toContain('filedByRunId: "run-resolve"');
		expect(prompt).toContain('runId: "run-failed"');
		expect(prompt).toContain('`environmental`');
		expect(prompt).toContain(RESOLVE_PROBLEM_REPORT_FILENAME);
		expect(prompt).toContain('"outcome": "resolved" | "unresolved"');
	});

	it("appends the project's custom prompt as a supplement", () => {
		expect(buildResolveProblemPrompt(INPUT)).not.toContain('PROJECT INSTRUCTIONS');
		const prompt = buildResolveProblemPrompt(INPUT, 'Ping #ops before any reset.');
		expect(prompt).toContain('--- PROJECT INSTRUCTIONS ---');
		expect(prompt).toContain('Ping #ops before any reset.');
	});
});

describe('buildResolveProblemPrompt — stuck tickets (issue #1425)', () => {
	const TICKET = {
		taskId: '1425',
		repository: 'SmartTechBrewery/swarm',
		reason: 'stalled' as const,
		slotOpenedAt: '2026-11-10T08:00:00.000Z',
		lastActivityAt: '2026-11-10T09:00:00.000Z',
		prNumber: '42',
		workItemId: 'PVTI_card',
	};

	it('describes the stuck ticket and its latest run, and files the report on that run', () => {
		const prompt = buildResolveProblemPrompt({ ...INPUT, ticket: TICKET });
		expect(prompt).toContain('has stopped moving: task 1425 in SmartTechBrewery/swarm');
		expect(prompt).toContain('no run and no dispatch since 2026-11-10T09:00:00.000Z');
		expect(prompt).toContain('--- THE STUCK TICKET ---');
		expect(prompt).toContain('Pull request: #42');
		expect(prompt).toContain('Board card: PVTI_card');
		expect(prompt).toContain('Slot held since: 2026-11-10T08:00:00.000Z');
		expect(prompt).toContain('--- ITS LATEST RUN ---');
		expect(prompt).not.toContain('--- THE FAILED RUN ---');
		expect(prompt).toContain('runId: "run-failed"');
		expect(prompt).toContain('filedByRunId: "run-resolve"');
		expect(prompt).toContain('If no SWARM tool can move the ticket');
	});

	it('files the report on the task and project when the ticket never ran', () => {
		const { failedRun: _, ...input } = INPUT;
		const { lastActivityAt: __, ...ticket } = TICKET;
		const prompt = buildResolveProblemPrompt({ ...input, ticket });
		expect(prompt).toContain('no run and no dispatch since 2026-11-10T08:00:00.000Z');
		expect(prompt).not.toContain('--- ITS LATEST RUN ---');
		expect(prompt).toContain('taskId: "1425"');
		expect(prompt).toContain('projectId: "swarm"');
		expect(prompt).not.toContain('runId: "');
		expect(prompt).toContain('filedByRunId: "run-resolve"');
	});

	it('leaves a failed-run attempt without the ticket wording', () => {
		const prompt = buildResolveProblemPrompt(INPUT);
		expect(prompt).not.toContain('THE STUCK TICKET');
		expect(prompt).not.toContain('If no SWARM tool can move the ticket');
	});
});
