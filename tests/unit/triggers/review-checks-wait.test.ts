import { describe, expect, it } from 'vitest';
import {
	DEFAULT_CHECKS_WAIT_MINUTES,
	resolveChecksWaitMinutes,
	stateRecheckCap,
} from '@/triggers/review-checks-wait.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

function projectWaiting(checksWaitMinutes: number) {
	return createMockProjectConfig({ reviewChecksWaitMinutes: checksWaitMinutes });
}

describe('review CI wait (issue #1083)', () => {
	it("keeps today's 10 minutes — 20 rechecks at 30 s — when the project sets nothing", () => {
		const project = createMockProjectConfig();
		expect(resolveChecksWaitMinutes(project)).toBe(DEFAULT_CHECKS_WAIT_MINUTES);
		expect(resolveChecksWaitMinutes(project)).toBe(10);
		expect(stateRecheckCap(project)).toBe(20);
	});

	it.each([
		[1, 2],
		[15, 30],
		[120, 240],
	])('derives the recheck cap for %i minutes as %i attempts', (minutes, cap) => {
		expect(resolveChecksWaitMinutes(projectWaiting(minutes))).toBe(minutes);
		expect(stateRecheckCap(projectWaiting(minutes))).toBe(cap);
	});
});
