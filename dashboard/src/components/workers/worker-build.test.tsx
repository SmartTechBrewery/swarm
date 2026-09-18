// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { formatWorkerBuild } from '@/components/workers/worker-build.js';

const COMMIT = { commit: 'abc1234def5678', dirty: false };

describe('formatWorkerBuild', () => {
	// What an operator says out loud leads; the commit stays because it is what the
	// Outdated mark was actually decided on.
	it('leads with the declared version and keeps the commit beside it', () => {
		expect(formatWorkerBuild(COMMIT, '1.2.0')).toBe('1.2.0 (abc1234)');
	});

	// A version only moves when somebody bumps it, so most machines carry none for a
	// while after this lands. Their line must read exactly as it did before.
	it('reads exactly as before for a machine that declared no version', () => {
		expect(formatWorkerBuild(COMMIT, null)).toBe('abc1234');
		expect(formatWorkerBuild(COMMIT, undefined)).toBe('abc1234');
		expect(formatWorkerBuild(COMMIT)).toBe('abc1234');
	});

	// The dirty flag is about the commit, so it stays attached to the commit rather
	// than floating out to the end of the line where it would read as the version's.
	it('keeps +dirty attached to the commit, not to the version', () => {
		expect(formatWorkerBuild({ ...COMMIT, dirty: true }, '1.2.0')).toBe('1.2.0 (abc1234+dirty)');
		expect(formatWorkerBuild({ ...COMMIT, dirty: true })).toBe('abc1234+dirty');
	});

	// The bundle compares no versions and parses none: whatever the machine declared is
	// printed, because a control plane may be newer than this build.
	it('prints an unexpected version string verbatim', () => {
		expect(formatWorkerBuild(COMMIT, '2.0.0-rc.1+build.7')).toBe('2.0.0-rc.1+build.7 (abc1234)');
	});
});
