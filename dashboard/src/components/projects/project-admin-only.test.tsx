// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_ADMIN_TABS } from '@/lib/project-nav.js';
import { ProjectAdminOnly } from './project-admin-only.js';

/**
 * Stands in for a configuration panel: it *would* issue its `projectAdmin`-gated
 * query on mount, so the spy firing at all proves a panel rendered behind a denial.
 */
const mountSpy = vi.fn();
function ConfigPanel() {
	mountSpy();
	return <div>config-panel</div>;
}

beforeEach(() => {
	mountSpy.mockReset();
});

describe('ProjectAdminOnly (issue #655)', () => {
	it('renders the configuration panel for a project administrator', () => {
		render(
			<ProjectAdminOnly tab="credentials" canAdminister={true}>
				<ConfigPanel />
			</ProjectAdminOnly>,
		);

		expect(screen.getByText('config-panel')).toBeDefined();
		expect(mountSpy).toHaveBeenCalled();
	});

	it('denies a non-administrator on every configuration tab, mounting nothing', () => {
		// Nothing mounting is the point: a denied panel's credential/board-discovery
		// queries are never issued, so the denial can't render as a wall of FORBIDDEN.
		for (const tab of PROJECT_ADMIN_TABS) {
			mountSpy.mockReset();
			const { unmount } = render(
				<ProjectAdminOnly tab={tab} canAdminister={false}>
					<ConfigPanel />
				</ProjectAdminOnly>,
			);

			expect(
				screen.getByText("This tab is available to this project's administrators only."),
			).toBeDefined();
			expect(screen.queryByText('config-panel')).toBeNull();
			expect(mountSpy).not.toHaveBeenCalled();
			unmount();
		}
	});

	it('points a denied viewer at the tabs that are theirs', () => {
		render(
			<ProjectAdminOnly tab="general" canAdminister={false}>
				<ConfigPanel />
			</ProjectAdminOnly>,
		);

		expect(screen.getByText(/Runs and Workers tabs show what this project is doing/)).toBeDefined();
	});

	it('passes the operational tabs through untouched for a non-administrator', () => {
		// Runs and Workers are not gated at all — an enrolled member keeps them, so the
		// gate must not deny the tab it happens to wrap when one of those is active.
		render(
			<ProjectAdminOnly tab="runs" canAdminister={false}>
				<ConfigPanel />
			</ProjectAdminOnly>,
		);

		expect(screen.getByText('config-panel')).toBeDefined();
		expect(screen.queryByText(/administrators only/)).toBeNull();
	});
});
