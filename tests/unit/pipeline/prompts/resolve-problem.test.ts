import { describe, expect, it } from 'vitest';

import {
	buildResolveProblemPrompt,
	RESOLVE_PROBLEM_REPORT_FILENAME,
	type ResolveProblemPromptInput,
} from '@/pipeline/prompts/resolve-problem.js';

const INPUT: ResolveProblemPromptInput = {
	project: { id: 'swarm', repo: 'SmartTechBrewery/swarm' },
	runId: 'run-resolve',
	failedRun: {
		id: 'run-failed',
		phase: 'implementation',
		taskId: '1395',
		prNumber: null,
		error: 'Agent did not write required hand-off implementation_handoff.json',
		failureDiagnosis: null,
	},
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
				...INPUT.failedRun,
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
