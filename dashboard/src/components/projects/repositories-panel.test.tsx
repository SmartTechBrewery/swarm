// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RepositoryForm } from '@/lib/project-repository.js';
import { RepositoriesPanel } from './repositories-panel.js';

const REPOSITORIES: RepositoryForm[] = [
	{ id: '1', repo: 'acme/first', baseBranch: 'main', branchPrefix: 'issue-' },
	{ id: '2', repo: 'acme/second', baseBranch: 'main', branchPrefix: 'issue-' },
];

function renderPanel(overrides: Partial<Parameters<typeof RepositoriesPanel>[0]> = {}) {
	const handleSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
	const handleReset = vi.fn();
	render(
		<RepositoriesPanel
			repositories={REPOSITORIES}
			duplicates={[]}
			onChange={vi.fn()}
			onAdd={vi.fn()}
			onRemove={vi.fn()}
			onMove={vi.fn()}
			handleSubmit={handleSubmit}
			handleReset={handleReset}
			isDirty={true}
			isPending={false}
			isSuccess={false}
			isError={false}
			{...overrides}
		/>,
	);
	return { handleSubmit, handleReset };
}

describe('RepositoriesPanel', () => {
	// The whole editor moved here from the Settings tab (issue #729) — every row and every
	// per-row control comes with it, not just the list's copy.
	it('renders the repository editor with its rows and per-row controls', () => {
		renderPanel();

		expect(screen.getByLabelText('Repository, entry 1')).toBeDefined();
		expect(screen.getByLabelText('Repository, entry 2')).toBeDefined();
		expect(screen.getByLabelText('Add repository')).toBeDefined();
		expect(screen.getByLabelText('Remove repository 2')).toBeDefined();
		expect(screen.getByLabelText('Move repository 2 up')).toBeDefined();
		// The first entry is the project's default, and the panel says so.
		expect(screen.getByText('Default')).toBeDefined();
	});

	// Its own Save, sending `repositories` alone: the Settings tab keeps a separate one for
	// `name`/`repoRoot`/`worktreeRoot`/`maxConcurrentJobs`.
	it('saves and resets on its own controls', () => {
		const { handleSubmit, handleReset } = renderPanel();

		fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
		expect(handleSubmit).toHaveBeenCalled();

		fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
		expect(handleReset).toHaveBeenCalled();
	});

	it('offers neither Save nor Reset while the list is unchanged', () => {
		renderPanel({ isDirty: false });

		expect(screen.getByRole('button', { name: 'Save Changes' })).toHaveProperty('disabled', true);
		expect(screen.getByRole('button', { name: 'Reset' })).toHaveProperty('disabled', true);
	});

	// A repository listed twice is the one rule with no server-side twin, so it blocks Save
	// even though the form is otherwise dirty and valid.
	it('blocks Save on a duplicate repository, and Enter-to-submit with it', () => {
		const { handleSubmit } = renderPanel({ duplicates: ['acme/first'] });

		const save = screen.getByRole('button', { name: 'Save Changes' });
		expect(save).toHaveProperty('disabled', true);
		fireEvent.click(save);
		expect(handleSubmit).not.toHaveBeenCalled();
		expect(screen.getByText(/Each repository can appear at most once/)).toBeDefined();
	});

	// A repository **another** project owns stays a server-side CONFLICT; this card's own
	// banner is where it surfaces now that the list has left the Settings tab.
	it("renders the server's repository conflict in its error banner", () => {
		renderPanel({ isError: true, errorMessage: 'Project ID or repository already exists' });

		expect(
			screen.getByText(/Failed to save repositories: Project ID or repository already exists/),
		).toBeDefined();
	});

	it('confirms a successful save', () => {
		renderPanel({ isSuccess: true });

		expect(screen.getByText('Repositories saved successfully.')).toBeDefined();
	});

	// The route feeds `configWriteInFlight` in, so a Settings save, an Agents-tab toggle
	// auto-save, or the Source Control tab's own SCM provider select (issue #734) all
	// disable this Save too — writes stay serialized (#369). The panel only ever sees the
	// one merged boolean; which upstream write raised it is `isConfigWriteInFlight`'s
	// concern (`$projectId.test.tsx`), not this component's.
	it('disables its controls while any config write is in flight', () => {
		renderPanel({ isPending: true });

		expect(screen.getByRole('button', { name: /Saving…/ })).toHaveProperty('disabled', true);
		expect(screen.getByRole('button', { name: 'Reset' })).toHaveProperty('disabled', true);
		expect(screen.getByLabelText('Repository, entry 1')).toHaveProperty('disabled', true);
	});
});
