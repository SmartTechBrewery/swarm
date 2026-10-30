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
		branchPattern: '',
		autoMerge: false,
		reviewChecks: 'required',
		reviewChecksWaitMinutes: '',
		wipLimit: '',
		...overrides,
	};
}

function renderList({
	repositories = [row()],
	duplicates = [] as string[],
	scm,
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
			scm={scm}
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
		// Issue #1241: a legacy prefix reads as the pattern it stands for.
		const pattern = screen.getByLabelText('Branch name pattern, entry 2') as HTMLInputElement;
		expect(pattern.value).toBe('work-{issue_key}');
		expect(pattern.readOnly).toBe(true);
	});

	// Issue #727: a project has one SCM provider, stated together with the credentials it
	// needs. A per-row selector offered a provider whose credentials had nowhere to be
	// entered, so the row no longer has one — and since issue #729 the section points at
	// the provider card directly above it rather than at another tab.
	it('offers no per-repository provider, and says where the project\u2019s one is set', () => {
		renderList({ repositories: TWO });

		expect(screen.queryByLabelText(/Source control provider/)).toBeNull();
		// The only per-row select is Review's check policy (issue #1109), never a provider.
		expect(screen.queryByRole('combobox', { name: /provider/i })).toBeNull();
		expect(screen.getByText(/live on the provider selected above/)).toBeDefined();
	});

	// Issue #1063: since #713 a board card runs against the repository that claims it, and an
	// unclaimed card in a multi-repository project is refused — never sent to the first entry.
	// So no row is badged as a default, and the copy describes no such fallback.
	it.each([
		['one repository', [row()]],
		['several repositories', TWO],
	])('singles out no row as a default with %s', (_label, repositories) => {
		renderList({ repositories });

		expect(screen.queryByText('Default')).toBeNull();
		expect(screen.queryByText(/default/i)).toBeNull();
		expect(screen.getByText(/refused rather than run against the first/)).toBeDefined();
	});

	// Issue #1089 phase 6/6: an Azure DevOps repository has three segments, so a row
	// takes its project provider's shape rather than a fixed `owner/repo` pattern.
	it("shapes each row's repository input after the project's provider", () => {
		const { unmount } = renderList({ scm: 'azure-devops' });
		const azureInput = screen.getByLabelText('Repository, entry 1');
		expect(azureInput.getAttribute('pattern')).toBe('[^/]+/[^/]+/[^/]+');
		expect(azureInput.getAttribute('placeholder')).toBe('organization/project/repository');
		unmount();

		renderList({ scm: 'gitlab' });
		const gitlabInput = screen.getByLabelText('Repository, entry 1');
		expect(gitlabInput.getAttribute('pattern')).toBe('[^/]+/[^/]+');
		expect(gitlabInput.getAttribute('placeholder')).toBe('namespace/project');
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

	// Issue #1058 made a second repository usable end to end — a worker holds a checkout
	// per repository — so the warning that said otherwise is gone, with one entry or two.
	it('no longer warns that a second repository is unusable', () => {
		const { unmount } = renderList();
		expect(screen.queryByText(/not yet fully usable/)).toBeNull();
		unmount();

		renderList({ repositories: TWO });
		expect(screen.queryByText(/not yet fully usable/)).toBeNull();
	});

	// Issue #1066: merge automation is per repository, with the copy the Pipeline tab
	// used to carry for the project-wide toggle.
	it('gives each row its own merge automation toggle', () => {
		const { onChange } = renderList({
			repositories: [row({ id: '1', autoMerge: true }), row({ id: '2', repo: 'acme/second' })],
		});

		const first = screen.getByLabelText('Merge automation, entry 1') as HTMLInputElement;
		const second = screen.getByLabelText('Merge automation, entry 2') as HTMLInputElement;
		expect(first.checked).toBe(true);
		expect(second.checked).toBe(false);
		expect(
			screen.getAllByText(/After a SWARM review approves a pull request, merge it directly/),
		).toHaveLength(2);

		fireEvent.click(second);
		expect(onChange).toHaveBeenCalledWith(1, { autoMerge: true });
	});

	// Issue #1109: Review's check policy and check wait are per repository too, moved
	// off the Pipeline tab's project-wide radio group.
	it('gives each row its own Review check policy and check wait', () => {
		const { onChange } = renderList({
			repositories: [
				row({ id: '1', reviewChecks: 'if-present' }),
				row({ id: '2', repo: 'acme/second', reviewChecksWaitMinutes: '30' }),
			],
		});

		const firstPolicy = screen.getByLabelText('Review check policy, entry 1') as HTMLSelectElement;
		const secondPolicy = screen.getByLabelText('Review check policy, entry 2') as HTMLSelectElement;
		expect(firstPolicy.value).toBe('if-present');
		expect(secondPolicy.value).toBe('required');
		expect(screen.getAllByText(/Dispatches Review immediately/)).toHaveLength(1);
		expect(screen.getAllByText(/stays pending and is rechecked/)).toHaveLength(1);

		const firstWait = screen.getByLabelText('Check wait in minutes, entry 1') as HTMLInputElement;
		const secondWait = screen.getByLabelText('Check wait in minutes, entry 2') as HTMLInputElement;
		expect(firstWait.value).toBe('');
		expect(firstWait.placeholder).toBe('10');
		expect(secondWait.value).toBe('30');

		fireEvent.change(secondPolicy, { target: { value: 'if-present' } });
		expect(onChange).toHaveBeenCalledWith(1, { reviewChecks: 'if-present' });
		fireEvent.change(firstWait, { target: { value: '45' } });
		expect(onChange).toHaveBeenCalledWith(0, { reviewChecksWaitMinutes: '45' });
	});

	// Issue #1185: the WIP limit is per repository, a positive whole number, blank = 1.
	it('gives each row its own WIP limit input', () => {
		const { onChange } = renderList({
			repositories: [row({ id: '1' }), row({ id: '2', repo: 'acme/second', wipLimit: '3' })],
		});

		const first = screen.getByLabelText('WIP limit, entry 1') as HTMLInputElement;
		const second = screen.getByLabelText('WIP limit, entry 2') as HTMLInputElement;
		expect(first.value).toBe('');
		expect(first.placeholder).toBe('1');
		expect(first.min).toBe('1');
		expect(first.step).toBe('1');
		expect(second.value).toBe('3');

		fireEvent.change(first, { target: { value: '2' } });
		expect(onChange).toHaveBeenCalledWith(0, { wipLimit: '2' });
	});

	it('disables every control while a save is in flight', () => {
		renderList({ repositories: TWO, isPending: true });

		expect((screen.getByLabelText('Repository, entry 1') as HTMLInputElement).disabled).toBe(true);
		expect((screen.getByLabelText('Add repository') as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByLabelText('Remove repository 2') as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByLabelText('Merge automation, entry 1') as HTMLInputElement).disabled).toBe(
			true,
		);
		expect(
			(screen.getByLabelText('Review check policy, entry 1') as HTMLSelectElement).disabled,
		).toBe(true);
		expect(
			(screen.getByLabelText('Check wait in minutes, entry 1') as HTMLInputElement).disabled,
		).toBe(true);
	});

	// Issue #1241: the pattern is composed in an editor, never typed into the row.
	describe('branch name pattern editor', () => {
		const patternInput = () => screen.getByLabelText('Pattern') as HTMLInputElement;
		const apply = () => screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement;

		it('describes every element and previews the pattern for a sample task', () => {
			renderList({ repositories: TWO });
			fireEvent.click(screen.getByLabelText('Edit branch name pattern, entry 1'));

			for (const name of ['issue_key', 'work_type', 'friendly_name']) {
				expect(screen.getByLabelText(`Insert {${name}}`)).toBeTruthy();
			}
			expect(patternInput().value).toBe('issue-{issue_key}');
			expect(screen.getByTestId('branch-pattern-preview').textContent).toBe('issue-VT-1538');

			fireEvent.change(patternInput(), { target: { value: '{issue_key}/{friendly_name}' } });
			expect(screen.getByTestId('branch-pattern-preview').textContent).toBe(
				'VT-1538/pierwsza-strona-testowa',
			);
		});

		it('refuses a pattern without {issue_key} or with it twice', () => {
			renderList({ repositories: TWO });
			fireEvent.click(screen.getByLabelText('Edit branch name pattern, entry 1'));

			fireEvent.change(patternInput(), { target: { value: 'feature/{friendly_name}' } });
			expect(apply().disabled).toBe(true);
			expect(screen.getByText(/must contain \{issue_key\}/)).toBeTruthy();

			fireEvent.change(patternInput(), { target: { value: '{issue_key}-{issue_key}' } });
			expect(apply().disabled).toBe(true);
			expect(screen.getByText('{issue_key} must appear exactly once.')).toBeTruthy();
		});

		it('warns on a flat key but still applies it', () => {
			const { onChange } = renderList({ repositories: TWO });
			fireEvent.click(screen.getByLabelText('Edit branch name pattern, entry 1'));

			fireEvent.change(patternInput(), { target: { value: '{issue_key}' } });
			expect(screen.getByText(/bare issue key/)).toBeTruthy();
			expect(apply().disabled).toBe(false);
			fireEvent.click(apply());
			expect(onChange).toHaveBeenCalledWith(0, { branchPattern: '{issue_key}' });
		});

		it('applies a pattern to its own row, and the prefix’s own pattern as none', () => {
			const { onChange } = renderList({ repositories: TWO });

			fireEvent.click(screen.getByLabelText('Edit branch name pattern, entry 2'));
			fireEvent.change(patternInput(), {
				target: { value: '{work_type}/{issue_key}-{friendly_name}' },
			});
			fireEvent.click(apply());
			expect(onChange).toHaveBeenCalledWith(1, {
				branchPattern: '{work_type}/{issue_key}-{friendly_name}',
			});

			fireEvent.click(screen.getByLabelText('Edit branch name pattern, entry 1'));
			fireEvent.click(apply());
			expect(onChange).toHaveBeenLastCalledWith(0, { branchPattern: '' });
		});
	});
});
