import { describe, expect, it } from 'vitest';
import { nameQuotaWindow } from '@/harness/quota.js';

describe('nameQuotaWindow', () => {
	it.each([
		[10080, 'Weekly'],
		[1440, 'Daily'],
		[60, 'Hourly'],
		[300, '5-hour'],
		[20160, '2-week'],
		[4320, '3-day'],
		[90, '90-minute'],
	])('names a %i-minute window %s', (durationMins, expected) => {
		expect(nameQuotaWindow(durationMins)).toBe(expected);
	});

	it.each([
		[undefined],
		[null],
		[0],
		[-5],
		[Number.NaN],
	])('falls back to a neutral name for %s', (durationMins) => {
		expect(nameQuotaWindow(durationMins)).toBe('Usage limit');
	});
});
