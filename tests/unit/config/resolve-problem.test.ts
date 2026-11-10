import { describe, expect, it } from 'vitest';
import {
	DEFAULT_RESOLVE_PROBLEM_MAX_WRITE_ACTIONS,
	isResolveProblemEnabled,
	resolveProblemMaxWriteActions,
} from '../../../src/config/resolve-problem.js';

describe('Resolve problem settings (issue #1384)', () => {
	it('is disabled with the default cap when nothing is stored', () => {
		expect(DEFAULT_RESOLVE_PROBLEM_MAX_WRITE_ACTIONS).toBe(5);
		for (const pipeline of [undefined, {}, { resolveProblem: {} }]) {
			expect(isResolveProblemEnabled(pipeline)).toBe(false);
			expect(resolveProblemMaxWriteActions(pipeline)).toBe(5);
		}
	});

	it('is enabled only by an explicit true', () => {
		expect(isResolveProblemEnabled({ resolveProblem: { enabled: true } })).toBe(true);
		expect(isResolveProblemEnabled({ resolveProblem: { enabled: false } })).toBe(false);
	});

	it('respects a stored cap', () => {
		expect(resolveProblemMaxWriteActions({ resolveProblem: { maxWriteActions: 12 } })).toBe(12);
	});
});
