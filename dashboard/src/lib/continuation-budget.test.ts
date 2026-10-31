import { describe, expect, it } from 'vitest';
import {
	DEFAULT_MAX_CONTINUATIONS,
	effectiveMaxContinuations,
	formatMinutes,
	maxPhaseRunMinutes,
	parseMaxContinuationsInput,
	toMaxContinuationsInput,
} from './continuation-budget.js';

describe('continuation budget (issue #1259)', () => {
	it('projects the stored budget onto the field, blank when unset', () => {
		expect(toMaxContinuationsInput(undefined)).toBe('');
		expect(toMaxContinuationsInput({})).toBe('');
		expect(toMaxContinuationsInput({ maxContinuations: 3 })).toBe('3');
	});

	it('parses blank as a clear and a positive integer as itself', () => {
		expect(parseMaxContinuationsInput('  ')).toEqual({ ok: true, value: null });
		expect(parseMaxContinuationsInput(' 5 ')).toEqual({ ok: true, value: 5 });
	});

	it.each(['0', '-1', '1.5', 'abc', '1e2'])('rejects %s', (input) => {
		expect(parseMaxContinuationsInput(input).ok).toBe(false);
	});

	it('describes the default for a blank field and keeps the stored value for an invalid one', () => {
		expect(effectiveMaxContinuations('', 5)).toBe(DEFAULT_MAX_CONTINUATIONS);
		expect(effectiveMaxContinuations('4', undefined)).toBe(4);
		expect(effectiveMaxContinuations('x', 5)).toBe(5);
		expect(effectiveMaxContinuations('x', undefined)).toBe(DEFAULT_MAX_CONTINUATIONS);
	});

	it('bounds a phase at its timeout once per attempt', () => {
		expect(maxPhaseRunMinutes(30, 2)).toBe(90);
		expect(maxPhaseRunMinutes(90, 2)).toBe(270);
	});

	it('formats minutes as hours and minutes', () => {
		expect(formatMinutes(45)).toBe('45 min');
		expect(formatMinutes(90)).toBe('1 h 30 min');
		expect(formatMinutes(180)).toBe('3 h');
	});
});
