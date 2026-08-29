import { describe, expect, it } from 'vitest';

import {
	buildPlanVerificationPrompt,
	PLAN_CORRECTION_MARKER,
} from '@/pipeline/prompts/plan-verification.js';
import {
	PROPOSED_PLAN_FILENAME,
	PROPOSED_SCOPE_FILENAME,
	PROPOSED_SPLIT_FILENAME,
} from '@/pipeline/prompts/planning.js';

describe('buildPlanVerificationPrompt', () => {
	it('carries the pipeline phase guard, like every other dispatched phase prompt', () => {
		const prompt = buildPlanVerificationPrompt(false);
		expect(prompt).toContain('Do NOT invoke the `solve-issue` skill');
		expect(prompt).toContain('Do NOT spawn subagents or delegate work to another agent or model.');
	});

	it('names the plan file and states the fact-check role', () => {
		const prompt = buildPlanVerificationPrompt(false);
		expect(prompt).toContain(PROPOSED_PLAN_FILENAME);
		expect(prompt).toMatch(/fact-check/i);
		expect(prompt).toMatch(/falsifiable claims/i);
	});

	it('names the split file and its subTasks plans only when the run proposed a split', () => {
		expect(buildPlanVerificationPrompt(false)).not.toContain(PROPOSED_SPLIT_FILENAME);

		const prompt = buildPlanVerificationPrompt(true);
		expect(prompt).toContain(PROPOSED_SPLIT_FILENAME);
		expect(prompt).toContain('"subTasks"');
		// Why it matters: a split child replays this plan and never gets its own run.
		expect(prompt).toMatch(/never gets a Planning run of its own/i);
	});

	it('lists what counts as a checkable claim', () => {
		const prompt = buildPlanVerificationPrompt(false);
		expect(prompt).toMatch(/file and directory paths/i);
		expect(prompt).toMatch(/function, type, class/i);
		expect(prompt).toMatch(/line numbers/i);
		expect(prompt).toMatch(/already merged/i);
		expect(prompt).toMatch(/descriptions of existing behavior/i);
	});

	it('states the fact-check-only rules', () => {
		const prompt = buildPlanVerificationPrompt(true);
		expect(prompt).toMatch(/Do NOT relitigate the plan's design, approach, ordering, or scope/);
		expect(prompt).toMatch(/Do NOT edit any other file/);
		expect(prompt).toMatch(/Do NOT run `git commit`/);
		expect(prompt).toMatch(/Do NOT rewrite the plan wholesale/);
		expect(prompt).toMatch(/change NOTHING at all/);
	});

	it('asks for small in-place corrections carrying the inline marker', () => {
		const prompt = buildPlanVerificationPrompt(false);
		expect(prompt).toContain(PLAN_CORRECTION_MARKER);
		expect(prompt).toMatch(/smallest precise replacement/i);
	});

	it('never offers the scope declaration as an editable file', () => {
		for (const prompt of [buildPlanVerificationPrompt(false), buildPlanVerificationPrompt(true)]) {
			// It is named only in the "do not edit" rule, never among the editable files.
			expect(prompt).toMatch(
				new RegExp(`Do NOT edit any other file[\\s\\S]*"${PROPOSED_SCOPE_FILENAME}"`),
			);
			expect(prompt).not.toMatch(
				new RegExp(
					`FILES YOU MAY READ AND EDIT[\\s\\S]*"${PROPOSED_SCOPE_FILENAME}"[\\s\\S]*HARD RULES`,
				),
			);
		}
	});

	it('does not splice in the work item or project instructions — an auditor plans nothing', () => {
		const prompt = buildPlanVerificationPrompt(true);
		expect(prompt).not.toContain('--- WORK ITEM ---');
		expect(prompt).not.toContain('PROJECT INSTRUCTIONS');
	});
});
