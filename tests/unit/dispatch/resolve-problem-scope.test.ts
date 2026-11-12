import { describe, expect, it } from 'vitest';

import {
	RESOLVE_PROBLEM_WAITING_SCOPE,
	resolveProblemScopeFor,
} from '@/dispatch/resolve-problem-scope.js';
import { WipOperatorReasonSchema } from '@/queue/wip-usage.js';

describe('Resolve problem Waiting-on-you scope (issue #1425)', () => {
	it('classifies every operator reason the WIP panel can show', () => {
		expect(Object.keys(RESOLVE_PROBLEM_WAITING_SCOPE).sort()).toEqual(
			[...WipOperatorReasonSchema.options].sort(),
		);
	});

	it('takes on exactly stalled and failed holders', () => {
		const inScope = WipOperatorReasonSchema.options.filter(
			(reason) => resolveProblemScopeFor(reason).inScope,
		);
		expect(inScope.sort()).toEqual(['failed', 'stalled']);
	});

	it('states why every excluded reason is left to a person', () => {
		for (const reason of WipOperatorReasonSchema.options) {
			const scope = resolveProblemScopeFor(reason);
			if (!scope.inScope) expect(scope.reason.trim()).not.toBe('');
		}
	});

	it('excludes a holder with no recorded reason', () => {
		const scope = resolveProblemScopeFor(undefined);
		expect(scope.inScope).toBe(false);
		expect(scope.inScope === false && scope.reason).toMatch(/no recorded hand-off/);
	});
});
