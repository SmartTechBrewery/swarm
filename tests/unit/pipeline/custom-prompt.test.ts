import { describe, expect, it } from 'vitest';
import { buildImplementationPrompt } from '@/pipeline/implementation.js';
import { buildPlanningPrompt } from '@/pipeline/planning.js';
import {
	projectInstructionsParagraph,
	projectInstructionsSection,
} from '@/pipeline/prompts/custom-prompt.js';
import { buildResolveConflictsPrompt } from '@/pipeline/resolve-conflicts.js';
import { buildRespondToCiPrompt } from '@/pipeline/respond-to-ci.js';
import { buildRespondToReviewPrompt } from '@/pipeline/respond-to-review.js';
import { buildReviewPrompt } from '@/pipeline/review.js';
import { createMockWorkItem } from '../../helpers/factories.js';

const SECTION_HEADER = '--- PROJECT INSTRUCTIONS ---';
const CUSTOM = 'Prefer our internal utility modules over adding new dependencies.';

describe('projectInstructionsSection (issue #135)', () => {
	it('returns no lines when the custom prompt is absent or whitespace-only', () => {
		expect(projectInstructionsSection(undefined)).toEqual([]);
		expect(projectInstructionsSection('')).toEqual([]);
		expect(projectInstructionsSection('   \n\t ')).toEqual([]);
	});

	it('emits a delimited, supplement-only, trimmed section when set', () => {
		const lines = projectInstructionsSection(`  ${CUSTOM}  `);
		expect(lines).toContain(SECTION_HEADER);
		// trimmed
		expect(lines).toContain(CUSTOM);
		const joined = lines.join('\n');
		expect(joined).toMatch(/SUPPLEMENT/);
		expect(joined).toMatch(/do NOT override/);
	});
});

describe('projectInstructionsParagraph (issue #135)', () => {
	it('returns no lines when unset', () => {
		expect(projectInstructionsParagraph('   ')).toEqual([]);
	});

	it('returns the section as a single pre-joined element for a \\n\\n-joined prompt', () => {
		const parts = projectInstructionsParagraph(CUSTOM);
		expect(parts).toHaveLength(1);
		expect(parts[0]).toContain(SECTION_HEADER);
		expect(parts[0]).toContain(CUSTOM);
		// No leading blank separator (the paragraph join handles spacing).
		expect(parts[0]?.startsWith(SECTION_HEADER)).toBe(true);
	});
});

/** Every phase's prompt builder, invoked with a trailing `customPrompt` arg. */
const BUILDERS: Array<{ name: string; build: (customPrompt?: string) => string }> = [
	{ name: 'planning', build: (p) => buildPlanningPrompt(createMockWorkItem(), false, p) },
	{
		name: 'implementation',
		build: (p) =>
			buildImplementationPrompt(
				createMockWorkItem(),
				{ repo: 'o/r', taskId: '7', branch: 'issue-7', baseBranch: 'main' },
				p,
			),
	},
	{
		name: 'review',
		build: (p) =>
			buildReviewPrompt({ repo: 'o/r', prNumber: '7', headSha: 'abc123', baseBranch: 'main' }, p),
	},
	{
		name: 'respond-to-review',
		build: (p) =>
			buildRespondToReviewPrompt(
				{ repo: 'o/r', prNumber: '7', prBranch: 'issue-7', reviewId: '99' },
				p,
			),
	},
	{
		name: 'respond-to-ci',
		build: (p) =>
			buildRespondToCiPrompt(
				{ repo: 'o/r', prNumber: '7', prBranch: 'issue-7', headSha: 'abc123' },
				p,
			),
	},
	{
		name: 'resolve-conflicts',
		build: (p) =>
			buildResolveConflictsPrompt(
				{
					project: { repo: 'o/r' },
					prNumber: '7',
					prBranch: 'issue-7',
					headSha: 'abc123',
					baseBranch: 'main',
					baseSha: 'def456',
				},
				p,
			),
	},
];

describe.each(BUILDERS)('$name prompt composition (issue #135)', ({ build }) => {
	it('is unchanged (no project-instructions section) when no custom prompt is set', () => {
		expect(build(undefined)).not.toContain(SECTION_HEADER);
	});

	it('treats a whitespace-only custom prompt as unset', () => {
		expect(build('   \n  ')).not.toContain(SECTION_HEADER);
	});

	it('appends the custom prompt in a supplement-only section without weakening the phase guard', () => {
		const prompt = build(CUSTOM);
		expect(prompt).toContain(SECTION_HEADER);
		expect(prompt).toContain(CUSTOM);
		expect(prompt).toMatch(/SUPPLEMENT/);
		// The SWARM phase guard must still be present alongside the custom prompt.
		expect(prompt).toContain('SWARM pipeline agent');
	});
});

describe('custom prompt placement relative to task context', () => {
	it('planning places the section after the instructions and before the work item', () => {
		const prompt = buildPlanningPrompt(createMockWorkItem(), false, CUSTOM);
		expect(prompt.indexOf(SECTION_HEADER)).toBeLessThan(prompt.indexOf('--- WORK ITEM ---'));
	});

	it('implementation places the section after the instructions and before the work item', () => {
		const prompt = buildImplementationPrompt(
			createMockWorkItem(),
			{ repo: 'o/r', taskId: '7', branch: 'issue-7', baseBranch: 'main' },
			CUSTOM,
		);
		expect(prompt.indexOf(SECTION_HEADER)).toBeLessThan(prompt.indexOf('--- WORK ITEM ---'));
	});
});
