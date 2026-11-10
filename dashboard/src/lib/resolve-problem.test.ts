import { describe, expect, it } from 'vitest';
import {
	isMaxWriteActionsDirty,
	maxWriteActionsInputToSync,
	parseMaxWriteActionsInput,
	toMaxWriteActionsInput,
	toMaxWriteActionsPatch,
} from './resolve-problem.js';

describe('Resolve problem write-cap field (issue #1384)', () => {
	const stored = { resolveProblem: { enabled: true, maxWriteActions: 8 } };

	it('shows a stored cap, and blank when none is stored', () => {
		expect(toMaxWriteActionsInput(stored)).toBe('8');
		expect(toMaxWriteActionsInput(undefined)).toBe('');
	});

	it('reads 1–50 and blank, and rejects anything else', () => {
		expect(parseMaxWriteActionsInput('')).toEqual({ ok: true, value: null });
		expect(parseMaxWriteActionsInput(' 1 ')).toEqual({ ok: true, value: 1 });
		expect(parseMaxWriteActionsInput('50')).toEqual({ ok: true, value: 50 });
		for (const input of ['0', '51', '2.5', '-1', 'x']) {
			expect(parseMaxWriteActionsInput(input).ok).toBe(false);
		}
	});

	it('is dirty only when the text differs from the stored cap', () => {
		expect(isMaxWriteActionsDirty('8', stored)).toBe(false);
		expect(isMaxWriteActionsDirty('9', stored)).toBe(true);
		expect(isMaxWriteActionsDirty('', undefined)).toBe(false);
	});

	it('patches only the cap, clears it on blank, and sends nothing when unchanged or invalid', () => {
		expect(toMaxWriteActionsPatch('3', stored)).toEqual({ resolveProblem: { maxWriteActions: 3 } });
		expect(toMaxWriteActionsPatch('', stored)).toEqual({
			resolveProblem: { maxWriteActions: null },
		});
		expect(toMaxWriteActionsPatch('8', stored)).toBeUndefined();
		expect(toMaxWriteActionsPatch('99', stored)).toBeUndefined();
	});

	it('re-seeds on first load and when the stored cap moved, never on an enabled-only change', () => {
		expect(maxWriteActionsInputToSync(undefined, stored, true)).toBe('8');
		expect(
			maxWriteActionsInputToSync({ resolveProblem: { maxWriteActions: 8 } }, stored, false),
		).toBeUndefined();
		expect(maxWriteActionsInputToSync(stored, undefined, false)).toBe('');
	});
});
