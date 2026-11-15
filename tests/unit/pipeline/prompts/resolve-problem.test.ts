import { describe, expect, it } from 'vitest';

import {
	buildResolveProblemPrompt,
	RED_HEAD_BUG_REPORT_TITLE,
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
		// Issue #1462: a fix only a person may make is a hand-off, not a failure.
		expect(prompt).toContain(
			'If the only fix is one of these, report `handed-off` and say what the person must do.',
		);
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
		expect(prompt).toContain(
			'"outcome": "resolved" | "already-resolved" | "handed-off" | "unresolved"',
		);
		// Issue #1462: when to hand off, and that `unresolved` means "could not diagnose".
		expect(prompt).toContain(
			'`handed-off` when you identified the cause and the only remedy is a person’s action you must not take',
		);
		expect(prompt).toContain('`unresolved` only when you could not diagnose the situation');
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
		expect(prompt).toContain(
			'only a person can make — report `handed-off` and say exactly what the person should do.',
		);
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

describe('buildResolveProblemPrompt — the pull request’s live state (issue #1441)', () => {
	it('has a run attempt with a pull request read its live state and report already-resolved when it is gone', () => {
		const prompt = buildResolveProblemPrompt({
			...INPUT,
			failedRun: { ...FAILED_RUN, prNumber: '2219' },
		});
		expect(prompt).toContain(
			'`pr_live_state` (`projectId: "swarm"`, `repository: "SmartTechBrewery/swarm"`, `prNumber: 2219`)',
		);
		expect(prompt).toContain('before any remedy, and again before you write your report');
		expect(prompt).toContain(
			'If it is `merged` or `closed`, the failure no longer blocks anything',
		);
		expect(prompt).toContain('do not tell the operator to re-run, merge or push anything');
		expect(prompt).toContain('report `already-resolved`');
	});

	it("has a ticket attempt read the ticket's own pull request in the ticket's repository", () => {
		const prompt = buildResolveProblemPrompt({
			...INPUT,
			ticket: {
				taskId: '1425',
				repository: 'SmartTechBrewery/other',
				reason: 'stalled',
				slotOpenedAt: '2026-11-10T08:00:00.000Z',
				prNumber: '42',
			},
		});
		expect(prompt).toContain(
			'`pr_live_state` (`projectId: "swarm"`, `repository: "SmartTechBrewery/other"`, `prNumber: 42`)',
		);
	});

	it('names no live pull-request check for an attempt without a pull request', () => {
		const prompt = buildResolveProblemPrompt(INPUT);
		expect(prompt).not.toContain('pr_live_state');
		// The outcome itself stays available: a newer run may already have done the work.
		expect(prompt).toContain('`already-resolved` when the problem was already gone');
	});
});

describe('buildResolveProblemPrompt — red pull-request heads (issue #1459)', () => {
	const RED_HEAD_INPUT: ResolveProblemPromptInput = {
		...INPUT,
		failedRun: {
			...FAILED_RUN,
			id: 'run-ci',
			phase: 'respond-to-ci',
			taskId: '2401-ci',
			prNumber: '2401',
			error: null,
		},
		redHead: {
			repository: 'SmartTechBrewery/under-control-platform',
			prNumber: '2401',
			headSha: '372520d3',
			taskId: '2401-ci',
			failedChecks: ['integration'],
			workItemId: 'card-2386',
		},
	};

	it('names the pull request, the head, the failing checks and that nothing acts on it', () => {
		const prompt = buildResolveProblemPrompt(RED_HEAD_INPUT);
		expect(prompt).toContain('--- THE RED PULL REQUEST HEAD ---');
		expect(prompt).toContain(
			'pull request #2401 in SmartTechBrewery/under-control-platform, head 372520d3',
		);
		expect(prompt).toContain('Failing checks: `integration`');
		expect(prompt).toContain('Board card: card-2386');
		expect(prompt).toContain('--- ITS LATEST RUN ---');
		expect(prompt).toContain('Run id: run-ci');
		expect(prompt).toContain('no run, no non-terminal dispatch, no check re-run still settling');
		expect(prompt).not.toContain('THE FAILED RUN');
	});

	it('asks for what SWARM last did and why nothing followed', () => {
		const prompt = buildResolveProblemPrompt(RED_HEAD_INPUT);
		expect(prompt).toContain('`pr_status` for pull request #2401');
		expect(prompt).toContain('settled `no-fix` on a head merge automation brought up to date');
		expect(prompt).toContain('why nothing followed it');
	});

	it('records every occurrence on the one class report, adding to the oldest', () => {
		const prompt = buildResolveProblemPrompt(RED_HEAD_INPUT);
		expect(prompt).toContain(`\`query: "${RED_HEAD_BUG_REPORT_TITLE}"\``);
		expect(prompt).toContain('add an occurrence to the oldest one');
		expect(prompt).toContain(`whose title is exactly \`${RED_HEAD_BUG_REPORT_TITLE}\``);
		expect(prompt).toContain('`runId: "run-ci"`');
		expect(prompt).toContain('`prNumber: 2401`');
		expect(prompt).toContain('`filedByRunId: "run-resolve"`');
		expect(prompt).not.toContain(
			'search `bug_reports_list` (with `query`) for a report of the same problem',
		);
	});

	it('says no tool re-runs checks, and keeps the hard limits on safety stops', () => {
		const prompt = buildResolveProblemPrompt(RED_HEAD_INPUT);
		expect(prompt).toContain('No SWARM tool re-runs a pull request’s checks');
		expect(prompt).toContain('re-run the failed job');
		expect(prompt).toContain(
			'If nothing SWARM can do moves the pull request, that is the expected outcome: report `handed-off`',
		);
		expect(prompt).not.toContain('leave it `unresolved`');
		expect(prompt).toContain('never override a safety stop SWARM placed on purpose');
		expect(prompt).toContain('a user termination');
		expect(prompt).toContain(
			'`pr_live_state` (`projectId: "swarm"`, `repository: "SmartTechBrewery/under-control-platform"`, `prNumber: 2401`)',
		);
		expect(prompt).toContain('naming the red pull-request head');
	});

	it('leaves failed-run and ticket attempts without the red-head wording', () => {
		const prompt = buildResolveProblemPrompt(INPUT);
		expect(prompt).not.toContain(RED_HEAD_BUG_REPORT_TITLE);
		expect(prompt).not.toContain('THE RED PULL REQUEST HEAD');
		expect(prompt).not.toContain('No SWARM tool re-runs');
	});
});
