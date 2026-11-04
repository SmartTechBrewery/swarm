// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { formatWorkerBuild, WorkerBuildBadge } from '@/components/workers/worker-build.js';

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

	// Issue #1285: the control plane's own build carries its version inside it (the
	// image's comes from a build-time stamp), so it reads the same way unprompted.
	it("uses the build's own version when none is passed", () => {
		expect(formatWorkerBuild({ ...COMMIT, version: '1.5.4' })).toBe('1.5.4 (abc1234)');
		expect(formatWorkerBuild({ ...COMMIT, version: '1.5.4' }, '1.6.0')).toBe('1.6.0 (abc1234)');
	});

	// The bundle compares no versions and parses none: whatever the machine declared is
	// printed, because a control plane may be newer than this build.
	it('prints an unexpected version string verbatim', () => {
		expect(formatWorkerBuild(COMMIT, '2.0.0-rc.1+build.7')).toBe('2.0.0-rc.1+build.7 (abc1234)');
	});
});

describe('WorkerBuildBadge', () => {
	// A runtime-based worker declares the commit stamped into it, with a version and
	// never dirty (issue #1302); on another commit than the control plane's it is
	// Outdated exactly as a clone is, and the advice holds for both kinds.
	it('marks a stamped build on another commit Outdated, advising swarm workers update', () => {
		render(
			<WorkerBuildBadge
				buildIsCurrent={false}
				controlPlaneBuild={{ commit: 'abc1234def5678', dirty: false, version: '1.6.0' }}
			/>,
		);
		const badge = screen.getByText('Outdated');
		expect(badge.getAttribute('title')).toContain('1.6.0 (abc1234)');
		expect(badge.getAttribute('title')).toContain('swarm workers update');
		expect(badge.getAttribute('title')).not.toContain('checkout');
	});

	it('renders nothing for a current build or one with no answer', () => {
		const { container } = render(
			<>
				<WorkerBuildBadge buildIsCurrent={true} />
				<WorkerBuildBadge buildIsCurrent={null} />
			</>,
		);
		expect(container.textContent).toBe('');
	});
});
