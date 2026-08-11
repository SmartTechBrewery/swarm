import { describe, expect, it } from 'vitest';
import { readAntigravityQuota } from '@/harness/antigravity-quota.js';

describe('readAntigravityQuota', () => {
	it.each([
		['daily', 1440, 'Daily'],
		['12h', 720, '12-hour'],
		['90m', 90, '90-minute'],
		['3d', 4320, '3-day'],
	])('maps the %s window', (window, durationMins, label) => {
		const reading = readAntigravityQuota({
			groups: [
				{
					name: 'Limits',
					buckets: [{ window, remaining_fraction: 0.5 }],
				},
			],
		});

		expect(reading?.windows).toEqual([
			{
				name: `Limits — ${label}`,
				durationMins,
				usedPercent: 50,
			},
		]);
	});

	it('does not treat inherited object keys as named windows', () => {
		const reading = readAntigravityQuota({
			groups: [{ name: 'Limits', buckets: [{ window: 'constructor', remaining_fraction: 0.5 }] }],
		});

		expect(reading?.windows).toEqual([
			{ name: 'Limits — constructor', durationMins: undefined, usedPercent: 50 },
		]);
	});
});
