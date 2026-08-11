// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/use-current-user.js', () => ({ useCurrentUser: vi.fn() }));

import { useCurrentUser } from '@/lib/use-current-user.js';
import { InstanceAdminOnly } from './instance-admin-only.js';

/** A react-query-shaped result carrying just the `data` the gate reads. */
function session(user: { instanceAdmin: boolean } | undefined) {
	// biome-ignore lint/suspicious/noExplicitAny: a partial query result is all the gate reads.
	return { data: user } as any;
}

/**
 * Stands in for a guarded screen: it *would* issue the installation-wide query,
 * so the spy firing at all proves the screen mounted behind a denial.
 */
const mountSpy = vi.fn();
function GuardedScreen() {
	mountSpy();
	return <div>guarded-screen</div>;
}

beforeEach(() => {
	mountSpy.mockReset();
	vi.mocked(useCurrentUser).mockReset();
});

describe('InstanceAdminOnly (issue #647)', () => {
	it('renders the guarded screen for an instance administrator', () => {
		vi.mocked(useCurrentUser).mockReturnValue(session({ instanceAdmin: true }));

		render(
			<InstanceAdminOnly view="runs">
				<GuardedScreen />
			</InstanceAdminOnly>,
		);

		expect(screen.getByText('guarded-screen')).toBeDefined();
		expect(mountSpy).toHaveBeenCalled();
	});

	it('denies a non-admin and never mounts the screen, so its queries never fire', () => {
		vi.mocked(useCurrentUser).mockReturnValue(session({ instanceAdmin: false }));

		render(
			<InstanceAdminOnly view="workers">
				<GuardedScreen />
			</InstanceAdminOnly>,
		);

		expect(
			screen.getByText('This page is available to instance administrators only.'),
		).toBeDefined();
		expect(screen.queryByText('guarded-screen')).toBeNull();
		expect(mountSpy).not.toHaveBeenCalled();
	});

	it('names the denied view and points the caller at their projects', () => {
		vi.mocked(useCurrentUser).mockReturnValue(session({ instanceAdmin: false }));

		render(
			<InstanceAdminOnly view="workers">
				<GuardedScreen />
			</InstanceAdminOnly>,
		);

		expect(screen.getByText(/installation-wide workers view/)).toBeDefined();
		expect(screen.getByText(/Open a project you are enrolled in/)).toBeDefined();
	});

	it('renders neither the screen nor a denial while the session is unresolved', () => {
		vi.mocked(useCurrentUser).mockReturnValue(session(undefined));

		render(
			<InstanceAdminOnly view="runs">
				<GuardedScreen />
			</InstanceAdminOnly>,
		);

		expect(screen.queryByText('guarded-screen')).toBeNull();
		expect(screen.queryByText(/instance administrators only/)).toBeNull();
		expect(mountSpy).not.toHaveBeenCalled();
	});
});
