// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
	applyBranchPattern,
	applyCommitSubjectPattern,
	type RepositoryForm,
	toRepositoryEntries,
} from '@/lib/project-repository.js';
import { NamingPatterns } from './naming-patterns.js';

function row(overrides: Partial<RepositoryForm> = {}): RepositoryForm {
	return {
		id: '1',
		repo: 'acme/first',
		baseBranch: 'main',
		branchPrefix: 'issue-',
		branchPattern: '',
		commitSubjectPattern: '',
		commitSubjectMaxLength: '',
		autoMerge: false,
		reviewChecks: 'required',
		reviewChecksWaitMinutes: '',
		wipLimit: '',
		...overrides,
	};
}

function renderPatterns({
	repositories = [row()],
	isPending = false,
	onApplyBranchPattern = vi.fn(),
	onApplyCommitSubjectPattern = vi.fn(),
}: Partial<Parameters<typeof NamingPatterns>[0]> = {}) {
	render(
		<NamingPatterns
			repositories={repositories}
			isPending={isPending}
			onApplyBranchPattern={onApplyBranchPattern}
			onApplyCommitSubjectPattern={onApplyCommitSubjectPattern}
		/>,
	);
	return { onApplyBranchPattern, onApplyCommitSubjectPattern };
}

const TWO: RepositoryForm[] = [row(), row({ id: '2', repo: 'acme/second' })];

const branchField = () => screen.getByLabelText('Branch name pattern') as HTMLInputElement;
const commitField = () => screen.getByLabelText('Commit subject pattern') as HTMLInputElement;
const patternInput = () => screen.getByLabelText('Pattern') as HTMLInputElement;
const apply = () => screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement;

describe('NamingPatterns', () => {
	// Issue #1246: the patterns are the project's, so the tab shows one of each, however
	// many repositories there are.
	it('shows one branch name and one commit subject pattern for the whole project', () => {
		renderPatterns({ repositories: TWO });

		expect(branchField().value).toBe('issue-{issue_key}');
		expect(branchField().readOnly).toBe(true);
		expect(commitField().value).toBe('{work_type}: {subject}');
		expect(commitField().readOnly).toBe(true);
		expect(screen.getAllByRole('button', { name: /^Edit / })).toHaveLength(2);
		expect(screen.queryByText(/use different/)).toBeNull();
	});

	it('disables both editors while a save is in flight', () => {
		renderPatterns({ isPending: true });

		expect(
			(screen.getByRole('button', { name: 'Edit branch name pattern' }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
		expect(
			(screen.getByRole('button', { name: 'Edit commit subject pattern' }) as HTMLButtonElement)
				.disabled,
		).toBe(true);
	});

	describe('repositories that differ', () => {
		it('lists each repository’s branch name pattern instead of picking one', () => {
			const { onApplyBranchPattern } = renderPatterns({
				repositories: [row(), row({ id: '2', repo: 'acme/second', branchPrefix: 'work-' })],
			});

			expect(branchField().value).toBe('');
			expect(branchField().placeholder).toBe('Differs between repositories');
			expect(screen.getByText('The repositories use different branch name patterns.')).toBeTruthy();
			expect(screen.getByText('issue-{issue_key}')).toBeTruthy();
			expect(screen.getByText('work-{issue_key}')).toBeTruthy();

			fireEvent.click(screen.getByRole('button', { name: 'Edit branch name pattern' }));
			expect(screen.getByText(/name their branches differently now/)).toBeTruthy();
			expect(patternInput().value).toBe('issue-{issue_key}');
			fireEvent.change(patternInput(), { target: { value: '{issue_key}/{friendly_name}' } });
			fireEvent.click(apply());
			expect(onApplyBranchPattern).toHaveBeenCalledWith('{issue_key}/{friendly_name}');
		});

		// Stating none titles pull requests by their card; stating the default does not, so
		// the two are listed apart even though they render the same subject.
		it('lists each repository’s commit subject pattern and limit, naming the one stating none', () => {
			renderPatterns({
				repositories: [
					row(),
					row({ id: '2', repo: 'acme/second', commitSubjectPattern: '{work_type}: {subject}' }),
				],
			});

			expect(commitField().value).toBe('');
			expect(commitField().placeholder).toBe('Differs between repositories');
			expect(
				screen.getByText('The repositories use different commit subject patterns.'),
			).toBeTruthy();
			expect(
				screen.getByText(/not set, so pull requests keep their card's title; limit 72 characters/),
			).toBeTruthy();
			expect(screen.getAllByText(/limit 72 characters/)).toHaveLength(2);

			fireEvent.click(screen.getByRole('button', { name: 'Edit commit subject pattern' }));
			expect(screen.getByText(/word their commit subjects differently now/)).toBeTruthy();
		});

		it('sets every repository to the value applied', () => {
			const initial = [
				row({ branchPattern: '{issue_key}/{friendly_name}' }),
				row({ id: '2', repo: 'acme/second', commitSubjectPattern: '{issue_key} {Subject}' }),
				row({ id: '3', repo: 'acme/third', commitSubjectMaxLength: '60' }),
			];
			function Harness() {
				const [rows, setRows] = useState(initial);
				return (
					<>
						<NamingPatterns
							repositories={rows}
							isPending={false}
							onApplyBranchPattern={(pattern) => setRows(applyBranchPattern(rows, pattern))}
							onApplyCommitSubjectPattern={(pattern, maxLength) =>
								setRows(applyCommitSubjectPattern(rows, pattern, maxLength))
							}
						/>
						<output data-testid="saved">{JSON.stringify(toRepositoryEntries(rows))}</output>
					</>
				);
			}
			render(<Harness />);
			const saved = () =>
				JSON.parse(screen.getByTestId('saved').textContent ?? '[]') as Array<
					Record<string, unknown>
				>;

			fireEvent.click(screen.getByRole('button', { name: 'Edit branch name pattern' }));
			fireEvent.change(patternInput(), { target: { value: '{work_type}/{issue_key}' } });
			fireEvent.click(apply());
			fireEvent.click(screen.getByRole('button', { name: 'Edit commit subject pattern' }));
			fireEvent.change(patternInput(), { target: { value: '{issue_key} {Subject}' } });
			fireEvent.change(screen.getByLabelText('Length limit'), { target: { value: '80' } });
			fireEvent.click(apply());

			expect(branchField().value).toBe('{work_type}/{issue_key}');
			expect(commitField().value).toBe('{issue_key} {Subject}');
			expect(screen.queryByText(/use different/)).toBeNull();
			for (const entry of saved()) {
				expect(entry).toMatchObject({
					branchPattern: '{work_type}/{issue_key}',
					commitSubjectPattern: '{issue_key} {Subject}',
					commitSubjectMaxLength: 80,
				});
			}
		});
	});

	// Issue #1241: the pattern is composed in an editor, never typed into the field.
	describe('branch name pattern editor', () => {
		it('names no single repository, describes every element and previews a sample task', () => {
			renderPatterns({ repositories: TWO });
			fireEvent.click(screen.getByRole('button', { name: 'Edit branch name pattern' }));

			expect(screen.getByRole('heading', { name: 'Branch name pattern' })).toBeTruthy();
			expect(screen.queryByText(/repository \d/)).toBeNull();
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
			renderPatterns();
			fireEvent.click(screen.getByRole('button', { name: 'Edit branch name pattern' }));

			fireEvent.change(patternInput(), { target: { value: 'feature/{friendly_name}' } });
			expect(apply().disabled).toBe(true);
			expect(screen.getByText(/must contain \{issue_key\}/)).toBeTruthy();

			fireEvent.change(patternInput(), { target: { value: '{issue_key}-{issue_key}' } });
			expect(apply().disabled).toBe(true);
			expect(screen.getByText('{issue_key} must appear exactly once.')).toBeTruthy();
		});

		it('warns on a flat key but still applies it', () => {
			const { onApplyBranchPattern } = renderPatterns();
			fireEvent.click(screen.getByRole('button', { name: 'Edit branch name pattern' }));

			fireEvent.change(patternInput(), { target: { value: '{issue_key}' } });
			expect(screen.getByText(/bare issue key/)).toBeTruthy();
			expect(apply().disabled).toBe(false);
			fireEvent.click(apply());
			expect(onApplyBranchPattern).toHaveBeenCalledWith('{issue_key}');
		});

		// Only the legacy prefix shape stays recognised after a change (review of #1243).
		it('warns that replacing a repository’s own pattern strands branches open under it', () => {
			renderPatterns({
				repositories: [
					row({ branchPattern: '{issue_key}/{friendly_name}' }),
					row({ id: '2', repo: 'acme/second', branchPattern: '{issue_key}/{friendly_name}' }),
				],
			});
			fireEvent.click(screen.getByRole('button', { name: 'Edit branch name pattern' }));
			expect(screen.queryByText(/will no longer be recognised/)).toBeNull();

			fireEvent.change(patternInput(), {
				target: { value: '{work_type}/{issue_key}-{friendly_name}' },
			});
			expect(
				screen.getByText(/branches named by \{issue_key\}\/\{friendly_name\} will no longer be/),
			).toBeTruthy();
			expect(apply().disabled).toBe(false);
		});

		it('does not warn when replacing the legacy prefix’s pattern, which stays recognised', () => {
			renderPatterns({ repositories: TWO });
			fireEvent.click(screen.getByRole('button', { name: 'Edit branch name pattern' }));

			fireEvent.change(patternInput(), { target: { value: '{issue_key}/{friendly_name}' } });
			expect(screen.queryByText(/will no longer be recognised/)).toBeNull();
		});
	});

	// Issue #1242: the commit subject pattern is composed in its own editor, the same way.
	describe('commit subject pattern editor', () => {
		const lengthInput = () => screen.getByLabelText('Length limit') as HTMLInputElement;
		const preview = () => screen.getByTestId('commit-subject-pattern-preview').textContent;

		it('names no single repository, describes every element and previews a sample task', () => {
			renderPatterns({ repositories: TWO });
			fireEvent.click(screen.getByRole('button', { name: 'Edit commit subject pattern' }));

			expect(screen.getByRole('heading', { name: 'Commit subject pattern' })).toBeTruthy();
			expect(screen.queryByText(/repository \d/)).toBeNull();
			for (const name of ['issue_key', 'work_type', 'subject']) {
				expect(screen.getByLabelText(`Insert {${name}}`)).toBeTruthy();
			}
			expect(preview()).toBe('feat: add the starting page of the SWARM test bed');

			fireEvent.change(patternInput(), { target: { value: '{issue_key} {Subject}' } });
			expect(preview()).toBe('VT-1538 Add the starting page of the SWARM test bed');
		});

		it('warns when the preview runs over the length limit, without refusing it', () => {
			renderPatterns();
			fireEvent.click(screen.getByRole('button', { name: 'Edit commit subject pattern' }));

			fireEvent.change(patternInput(), { target: { value: '{issue_key} {Subject}' } });
			expect(screen.queryByText(/over the .*-character limit/)).toBeNull();
			fireEvent.change(lengthInput(), { target: { value: '40' } });
			expect(screen.getByText(/over the 40-character limit/)).toBeTruthy();
			expect(apply().disabled).toBe(false);
		});

		it('refuses a pattern without {subject}', () => {
			renderPatterns();
			fireEvent.click(screen.getByRole('button', { name: 'Edit commit subject pattern' }));

			fireEvent.change(patternInput(), { target: { value: '{issue_key}' } });
			expect(apply().disabled).toBe(true);
			expect(screen.getByText(/must contain \{subject\}/)).toBeTruthy();
		});

		it('applies the pattern and its length limit together', () => {
			const { onApplyCommitSubjectPattern } = renderPatterns({ repositories: TWO });
			fireEvent.click(screen.getByRole('button', { name: 'Edit commit subject pattern' }));

			fireEvent.change(patternInput(), { target: { value: '{issue_key} {Subject}' } });
			fireEvent.change(lengthInput(), { target: { value: '60' } });
			fireEvent.click(apply());
			expect(onApplyCommitSubjectPattern).toHaveBeenCalledWith('{issue_key} {Subject}', 60);
		});
	});
});
