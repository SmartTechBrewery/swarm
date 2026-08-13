// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { RepositoryForm } from '@/lib/project-repository.js';
import { RepositoryList } from './repository-list.js';

function row(overrides: Partial<RepositoryForm> = {}): RepositoryForm {
	return {
		id: '1',
		repo: 'acme/first',
		baseBranch: 'main',
		branchPrefix: 'issue-',
		...overrides,
	};
}

function renderList({
	repositories = [row()],
	duplicates = [] as string[],
	isPending = false,
	onChange = vi.fn(),
	onAdd = vi.fn(),
	onRemove = vi.fn(),
	onMove = vi.fn(),
}: Partial<Parameters<typeof RepositoryList>[0]> = {}) {
	const { unmount } = render(
		<RepositoryList
			repositories={repositories}
			duplicates={duplicates}
			isPending={isPending}
			onChange={onChange}
			onAdd={onAdd}
			onRemove={onRemove}
			onMove={onMove}
		/>,
	);
	return { onChange, onAdd, onRemove, onMove, unmount };
}

const TWO: RepositoryForm[] = [
	row(),
	row({ id: '2', repo: 'acme/second', baseBranch: 'trunk', branchPrefix: 'work-' }),
];

describe('RepositoryList', () => {
	it('renders one row per repository, in order', () => {
		renderList({ repositories: TWO });

		expect((screen.getByLabelText('Repository, entry 1') as HTMLInputElement).value).toBe(
			'acme/first',
		);
		expect((screen.getByLabelText('Base branch, entry 2') as HTMLInputElement).value).toBe('trunk');
		expect((screen.getByLabelText('Branch prefix, entry 2') as HTMLInputElement).value).toBe(
			'work-',
		);
	});

	// Issue #727: a project has one SCM provider, stated together with the credentials it
	// needs. A per-row selector offered a provider whose credentials had nowhere to be
	// entered, so the row no longer has one — and since issue #729 the section points at
	// the provider card directly above it rather than at another tab.
	it('offers no per-repository provider, and says where the project\u2019s one is set', () => {
		renderList({ repositories: TWO });

		expect(screen.queryByLabelText(/Source control provider/)).toBeNull();
		expect(screen.queryByRole('combobox')).toBeNull();
		expect(screen.getByText(/live on the provider selected above/)).toBeDefined();
	});

	// Order is meaningful — the first entry is what board-driven work runs against — so the
	// screen has to say so rather than leaving the ranking decorative.
	it('marks the first row as the project default and explains what that means', () => {
		renderList({ repositories: TWO });

		expect(screen.getByText('Default')).toBeDefined();
		expect(screen.getByText(/board-driven Planning and Implementation/)).toBeDefined();
	});

	it('reports edits, adds, removes and moves to its handlers', () => {
		const { onChange, onAdd, onRemove, onMove } = renderList({ repositories: TWO });

		fireEvent.change(screen.getByLabelText('Repository, entry 2'), {
			target: { value: 'acme/renamed' },
		});
		expect(onChange).toHaveBeenCalledWith(1, { repo: 'acme/renamed' });

		fireEvent.click(screen.getByLabelText('Add repository'));
		expect(onAdd).toHaveBeenCalled();

		fireEvent.click(screen.getByLabelText('Remove repository 2'));
		expect(onRemove).toHaveBeenCalledWith(1);

		fireEvent.click(screen.getByLabelText('Move repository 2 up'));
		expect(onMove).toHaveBeenCalledWith(1, 'up');
	});

	it('does not offer a move past either end of the list', () => {
		renderList({ repositories: TWO });

		expect((screen.getByLabelText('Move repository 1 up') as HTMLButtonElement).disabled).toBe(
			true,
		);
		expect((screen.getByLabelText('Move repository 2 down') as HTMLButtonElement).disabled).toBe(
			true,
		);
		expect((screen.getByLabelText('Move repository 1 down') as HTMLButtonElement).disabled).toBe(
			false,
		);
	});

	// A project owns at least one repository; the control states the rule rather than
	// disappearing.
	it('disables Remove on the only row, with the reason on it', () => {
		const { onRemove } = renderList();

		const remove = screen.getByLabelText('Remove repository 1') as HTMLButtonElement;
		expect(remove.disabled).toBe(true);
		expect(remove.title).toMatch(/at least one repository/);

		fireEvent.click(remove);
		expect(onRemove).not.toHaveBeenCalled();
	});

	it('surfaces a duplicate repository inline', () => {
		renderList({ repositories: TWO, duplicates: ['acme/first'] });

		expect(screen.getByText(/Each repository can appear at most once/)).toBeDefined();
		expect(screen.getByText('acme/first')).toBeDefined();
	});

	// `repoRoot` is still one checkout per project, so a second entry has a consequence the
	// operator has to be told about — but only once it exists.
	it('warns about the single checkout only once a second repository is listed', () => {
		const { unmount } = renderList();
		expect(screen.queryByText(/not yet fully usable/)).toBeNull();
		unmount();

		renderList({ repositories: TWO });
		expect(screen.getByText(/not yet fully usable/)).toBeDefined();
	});

	it('disables every control while a save is in flight', () => {
		renderList({ repositories: TWO, isPending: true });

		expect((screen.getByLabelText('Repository, entry 1') as HTMLInputElement).disabled).toBe(true);
		expect((screen.getByLabelText('Add repository') as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByLabelText('Remove repository 2') as HTMLButtonElement).disabled).toBe(true);
	});
});
