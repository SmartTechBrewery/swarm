// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const navigate = vi.fn();

vi.mock('@tanstack/react-router', () => ({
	useNavigate: () => navigate,
}));

import { ProjectsTable } from './projects-table.js';

const projects = [
	{ id: 'proj-a', name: 'Project A', repo: 'acme/widgets', repoRoot: '/work/widgets' },
];

describe('ProjectsTable', () => {
	it('renders no per-project actions', () => {
		render(<ProjectsTable projects={projects} />);

		expect(screen.queryAllByRole('button')).toHaveLength(0);
		expect(screen.queryAllByRole('link')).toHaveLength(0);
	});

	it('opens the project screen when its row is clicked', () => {
		render(<ProjectsTable projects={projects} />);

		fireEvent.click(screen.getByText('Project A'));

		expect(navigate).toHaveBeenCalledWith({
			to: '/projects/$projectId',
			params: { projectId: 'proj-a' },
		});
	});
});
