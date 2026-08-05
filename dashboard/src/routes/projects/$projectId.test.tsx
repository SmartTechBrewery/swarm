// @vitest-environment jsdom

import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it, type Mock, vi } from 'vitest';
import type { AgentConfig, ProjectConfig } from '../../../../src/config/schema.js';

const mockMutate = vi.fn();
const mockSetQueryData = vi.fn();

vi.mock('@tanstack/react-query', () => ({
	useQuery: vi.fn(),
	useQueryClient: () => ({
		setQueryData: mockSetQueryData,
	}),
	useMutation: ({
		mutationFn,
		onSuccess,
		onSettled,
	}: {
		mutationFn: (vars: unknown) => Promise<unknown>;
		onSuccess?: (data: unknown) => void;
		onSettled?: () => void;
	}) => {
		return {
			mutate: (
				variables: unknown,
				options?: { onSuccess?: (data: unknown) => void; onError?: (err: unknown) => void },
			) => {
				mutationFn(variables)
					.then((data: unknown) => {
						if (onSuccess) onSuccess(data);
						if (options?.onSuccess) options.onSuccess(data);
					})
					.catch((err: unknown) => {
						if (options?.onError) options.onError(err);
					})
					.finally(() => {
						if (onSettled) onSettled();
					});
			},
			isError: false,
			error: null,
		};
	},
}));

vi.mock('@/lib/trpc.js', () => ({
	trpcClient: {
		projects: {
			update: {
				mutate: (vars: unknown) => mockMutate(vars),
			},
		},
	},
	trpc: {
		projects: {
			getById: {
				queryOptions: (args: unknown) => ({
					queryKey: ['projects', 'getById', args],
				}),
			},
		},
	},
}));

import {
	diffProjectForSync,
	PhaseConfigRow,
	PhaseEnabledCell,
	PhaseSettingsDetail,
	PipelineSettingsForm,
	ToggleSaveIndicator,
	toggleSaveKey,
	useToggleAutoSave,
} from './$projectId.js';

/** Minimal valid ProjectConfig for the slices `diffProjectForSync` compares. */
function makeProject(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
	return {
		id: 'p1',
		name: 'Proj',
		repo: 'owner/repo',
		repoRoot: '/repo',
		worktreeRoot: '.worktrees',
		baseBranch: 'main',
		branchPrefix: 'issue-',
		maxConcurrentJobs: 1,
		visibility: 'private',
		pm: { type: 'github-projects' } as ProjectConfig['pm'],
		credentials: {} as ProjectConfig['credentials'],
		...overrides,
	} as ProjectConfig;
}

describe('toggleSaveKey', () => {
	it('builds a stable per-phase, per-kind key', () => {
		expect(toggleSaveKey('review', 'enabled')).toBe('review:enabled');
		expect(toggleSaveKey('planning', 'autoAdvance')).toBe('planning:autoAdvance');
		// The two kinds never collide for the same phase.
		expect(toggleSaveKey('planning', 'enabled')).not.toBe(toggleSaveKey('planning', 'autoAdvance'));
	});
});

describe('ToggleSaveIndicator', () => {
	it('renders a labelled spinner while a save is in flight', () => {
		render(<ToggleSaveIndicator saving={true} />);
		expect(screen.getByLabelText('Saving')).toBeDefined();
	});

	it('renders nothing when idle', () => {
		const { container } = render(<ToggleSaveIndicator saving={false} />);
		expect(container.firstChild).toBeNull();
		expect(screen.queryByLabelText('Saving')).toBeNull();
	});
});

describe('PhaseEnabledCell', () => {
	it('renders "Always on" text for mandatory phases when enabled is undefined', () => {
		render(
			<PhaseEnabledCell phase="planning" label="Planning" enabled={undefined} isPending={false} />,
		);

		expect(screen.getByText('Always on')).toBeDefined();
		expect(screen.queryByRole('switch')).toBeNull();
	});

	it('renders an interactive toggle switch for optional phases when enabled is defined', () => {
		const handleChange = vi.fn();
		render(
			<PhaseEnabledCell
				phase="review"
				label="Review"
				enabled={true}
				isPending={false}
				handleEnabledChange={handleChange}
			/>,
		);

		const switchElement = screen.getByRole('switch') as HTMLButtonElement;
		expect(switchElement).toBeDefined();
		expect(switchElement.getAttribute('aria-checked')).toBe('true');

		fireEvent.click(switchElement);
		expect(handleChange).toHaveBeenCalledWith('review', false);
	});

	it('renders a disabled toggle switch when enabledDisabled is true', () => {
		render(
			<PhaseEnabledCell
				phase="respondToReview"
				label="Respond to Review"
				enabled={true}
				enabledDisabled={true}
				isPending={false}
			/>,
		);

		const switchElement = screen.getByRole('switch') as HTMLButtonElement;
		expect(switchElement.disabled).toBe(true);
	});

	it('shows a spinner on the toggle whose immediate save is in flight', () => {
		render(
			<PhaseEnabledCell
				phase="review"
				label="Review"
				enabled={true}
				isPending={false}
				savingToggleKey={toggleSaveKey('review', 'enabled')}
			/>,
		);
		expect(screen.getByLabelText('Saving')).toBeDefined();
	});

	it('disables the toggle while any toggle save is in flight, without its own spinner', () => {
		// A different toggle is saving: this one must not accept a flip mid-write
		// (saves are serialized) and shows no spinner of its own.
		render(
			<PhaseEnabledCell
				phase="review"
				label="Review"
				enabled={true}
				isPending={false}
				savingToggleKey={toggleSaveKey('respondToCi', 'enabled')}
			/>,
		);
		const switchElement = screen.getByRole('switch') as HTMLButtonElement;
		expect(switchElement.disabled).toBe(true);
		expect(screen.queryByLabelText('Saving')).toBeNull();
	});
});

describe('PhaseConfigRow', () => {
	const mockConfig: AgentConfig = {
		targets: [{ cli: 'claude', model: 'sonnet', reasoning: 'high' }],
		timeoutMs: 30 * 60 * 1000,
	};

	it('renders Planning row with auto-advance toggle', () => {
		const handleAutoAdvanceChange = vi.fn();
		render(
			<table>
				<tbody>
					<PhaseConfigRow
						phase="planning"
						config={mockConfig}
						isPending={false}
						enabled={undefined}
						autoAdvance={true}
						handleAutoAdvanceChange={handleAutoAdvanceChange}
						onSelect={() => {}}
					/>
				</tbody>
			</table>,
		);

		expect(screen.getByText('Planning')).toBeDefined();
		expect(screen.getByText('Always on')).toBeDefined();

		// Auto-advance toggle should exist
		const switches = screen.getAllByRole('switch') as HTMLButtonElement[];
		expect(switches).toHaveLength(1);
		expect(switches[0].getAttribute('aria-label')).toBe('Planning auto-advance');
		expect(switches[0].getAttribute('aria-checked')).toBe('true');

		// Click the auto-advance toggle
		fireEvent.click(switches[0]);
		expect(handleAutoAdvanceChange).toHaveBeenCalledWith('planning', false);
	});

	it('shows a spinner on the Planning auto-advance toggle while its save is in flight', () => {
		render(
			<table>
				<tbody>
					<PhaseConfigRow
						phase="planning"
						config={mockConfig}
						isPending={false}
						enabled={undefined}
						autoAdvance={true}
						savingToggleKey={toggleSaveKey('planning', 'autoAdvance')}
						handleAutoAdvanceChange={() => {}}
						onSelect={() => {}}
					/>
				</tbody>
			</table>,
		);
		expect(screen.getByLabelText('Saving')).toBeDefined();
		const switches = screen.getAllByRole('switch') as HTMLButtonElement[];
		expect(switches[0].disabled).toBe(true);
	});

	it('shows the preferred target as CLI • Model with reasoning beneath it', () => {
		render(
			<table>
				<tbody>
					<PhaseConfigRow
						phase="planning"
						config={{
							targets: [
								{ cli: 'claude', model: 'sonnet', reasoning: 'high' },
								{ cli: 'codex', model: 'gpt-5.6-terra' },
							],
							timeoutMs: 30 * 60 * 1000,
						}}
						isPending={false}
						enabled={undefined}
						onSelect={() => {}}
					/>
				</tbody>
			</table>,
		);

		expect(screen.getByText('Claude • Sonnet')).toBeDefined();
		expect(screen.getByText('High')).toBeDefined();
		// Only the preferred (first) target is summarized, not the fallback.
		expect(screen.queryByText(/GPT-5.6 Terra/)).toBeNull();
		expect(screen.queryByText(/30m/)).toBeNull();
	});

	it('renders Review row with auto-advance as N/A', () => {
		render(
			<table>
				<tbody>
					<PhaseConfigRow
						phase="review"
						config={mockConfig}
						isPending={false}
						enabled={true}
						autoAdvance={undefined}
						onSelect={() => {}}
					/>
				</tbody>
			</table>,
		);

		expect(screen.getByText('Review')).toBeDefined();
		expect(screen.getByText('N/A')).toBeDefined();

		// The only switch should be the Enabled cell switch
		const switches = screen.getAllByRole('switch') as HTMLButtonElement[];
		expect(switches).toHaveLength(1);
		expect(switches[0].getAttribute('aria-label')).toBe('Review enabled');
	});

	it('renders Implementation (unplanned) without an auto-advance setting', () => {
		render(
			<table>
				<tbody>
					<PhaseConfigRow
						phase="implementationUnplanned"
						config={mockConfig}
						isPending={false}
						enabled={undefined}
						onSelect={() => {}}
					/>
				</tbody>
			</table>,
		);

		expect(screen.getByText('Implementation (unplanned)')).toBeDefined();
		expect(screen.getByText('Implements an issue with no prior plan')).toBeDefined();
		expect(screen.getByText('Always on')).toBeDefined();
		expect(screen.getByText('N/A')).toBeDefined();
		expect(screen.queryByLabelText(/Implementation.*auto-advance/)).toBeNull();
	});

	it('calls onSelect when clicking the row itself, but not when clicking the toggle', () => {
		const handleSelect = vi.fn();
		const handleEnabledChange = vi.fn();

		render(
			<table>
				<tbody>
					<PhaseConfigRow
						phase="review"
						config={mockConfig}
						isPending={false}
						enabled={true}
						handleEnabledChange={handleEnabledChange}
						onSelect={handleSelect}
					/>
				</tbody>
			</table>,
		);

		// Click the toggle switch
		const switchElement = screen.getByRole('switch') as HTMLButtonElement;
		fireEvent.click(switchElement);
		expect(handleEnabledChange).toHaveBeenCalledTimes(1);
		expect(handleSelect).not.toHaveBeenCalled();

		// Click the row/text
		fireEvent.click(screen.getByText('Review'));
		expect(handleSelect).toHaveBeenCalledTimes(1);
	});

	it('shows the configured default for a preferred target without a model override', () => {
		render(
			<table>
				<tbody>
					<PhaseConfigRow
						phase="planning"
						config={{
							targets: [{ cli: 'codex' }],
						}}
						projectDefaults={{ codex: 'gpt-5.5' }}
						isPending={false}
						onSelect={() => {}}
					/>
				</tbody>
			</table>,
		);

		expect(screen.getByText('Codex • Default (GPT-5.5)')).toBeDefined();
	});

	it('shows the model from a config written before targets existed', () => {
		render(
			<table>
				<tbody>
					<PhaseConfigRow
						phase="planning"
						config={{ cli: 'antigravity', model: 'Gemini 3.5 Flash (High)' }}
						isPending={false}
						onSelect={() => {}}
					/>
				</tbody>
			</table>,
		);

		expect(screen.getByText('Antigravity • Gemini 3.5 Flash')).toBeDefined();
	});

	it('falls back to "Coded default" when the phase overrides nothing', () => {
		render(
			<table>
				<tbody>
					<PhaseConfigRow phase="planning" config={{}} isPending={false} onSelect={() => {}} />
				</tbody>
			</table>,
		);

		expect(screen.getByText('Coded default')).toBeDefined();
	});
});

describe('PhaseSettingsDetail', () => {
	const mockConfig: AgentConfig = {
		targets: [{ cli: 'claude', model: 'sonnet', reasoning: 'high' }],
		timeoutMs: 30 * 60 * 1000,
		prompt: 'Custom test instructions',
	};

	/** The target handlers every render needs; override only what a test asserts on. */
	const targetHandlers = () => ({
		handleTargetChange: vi.fn(),
		handleAddTarget: vi.fn(),
		handleRemoveTarget: vi.fn(),
		handleMoveTarget: vi.fn(),
	});

	it('renders with Enabled toggle aligned with the current state', () => {
		const handleEnabledChange = vi.fn();
		render(
			<PhaseSettingsDetail
				phase="review"
				config={mockConfig}
				isPending={false}
				enabled={true}
				handleEnabledChange={handleEnabledChange}
				{...targetHandlers()}
				handleTimeoutChange={() => {}}
				handlePromptChange={() => {}}
				onBack={() => {}}
			/>,
		);

		// Check title
		expect(screen.getByRole('heading', { level: 2, name: 'Review' })).toBeDefined();

		// Should have Enabled switch showing checked=true
		const switches = screen.getAllByRole('switch') as HTMLButtonElement[];
		expect(switches).toHaveLength(1);
		expect(switches[0].getAttribute('aria-label')).toBe('Review enabled');
		expect(switches[0].getAttribute('aria-checked')).toBe('true');

		// Toggle enabled
		fireEvent.click(switches[0]);
		expect(handleEnabledChange).toHaveBeenCalledWith('review', false);
	});

	it('renders with always-on disabled switch for mandatory phases', () => {
		render(
			<PhaseSettingsDetail
				phase="planning"
				config={mockConfig}
				isPending={false}
				enabled={undefined}
				{...targetHandlers()}
				handleTimeoutChange={() => {}}
				handlePromptChange={() => {}}
				onBack={() => {}}
			/>,
		);

		const switchElement = screen.getByRole('switch') as HTMLButtonElement;
		expect(switchElement.disabled).toBe(true);
		expect(switchElement.getAttribute('aria-checked')).toBe('true');
		expect(screen.getByText('Enabled')).toBeDefined();
		expect(screen.getByText('Always on')).toBeDefined();
	});

	it('renders Implementation (unplanned) without an auto-advance setting', () => {
		render(
			<PhaseSettingsDetail
				phase="implementationUnplanned"
				config={mockConfig}
				isPending={false}
				enabled={undefined}
				{...targetHandlers()}
				handleTimeoutChange={() => {}}
				handlePromptChange={() => {}}
				onBack={() => {}}
			/>,
		);

		expect(
			screen.getByRole('heading', { level: 2, name: 'Implementation (unplanned)' }),
		).toBeDefined();

		// The phase is always on and has no configurable completion transition.
		const switches = screen.getAllByRole('switch') as HTMLButtonElement[];
		expect(switches).toHaveLength(1);
		expect(switches[0].disabled).toBe(true);
		expect(switches[0].getAttribute('aria-checked')).toBe('true');
		expect(screen.queryByText('Auto-advance')).toBeNull();
		expect(screen.getByText('Always on')).toBeDefined();

		expect(
			screen.getByText(/Used only when Implementation was not preceded by a Planning run/),
		).toBeDefined();
	});

	it('renders Auto-advance toggle switch when autoAdvance is defined', () => {
		const handleAutoAdvanceChange = vi.fn();
		render(
			<PhaseSettingsDetail
				phase="planning"
				config={mockConfig}
				isPending={false}
				enabled={undefined}
				autoAdvance={true}
				handleAutoAdvanceChange={handleAutoAdvanceChange}
				{...targetHandlers()}
				handleTimeoutChange={() => {}}
				handlePromptChange={() => {}}
				onBack={() => {}}
			/>,
		);

		// Should have auto-advance switch
		const autoAdvanceSwitch = screen.getByLabelText('Planning auto-advance') as HTMLButtonElement;
		expect(autoAdvanceSwitch).toBeDefined();
		expect(autoAdvanceSwitch.getAttribute('aria-checked')).toBe('true');

		fireEvent.click(autoAdvanceSwitch);
		expect(handleAutoAdvanceChange).toHaveBeenCalledWith('planning', false);
	});

	it('renders locked state label for respondToReview when enabledDisabled is true', () => {
		render(
			<PhaseSettingsDetail
				phase="respondToReview"
				config={mockConfig}
				isPending={false}
				enabled={true}
				enabledDisabled={true}
				{...targetHandlers()}
				handleTimeoutChange={() => {}}
				handlePromptChange={() => {}}
				onBack={() => {}}
			/>,
		);

		expect(screen.getByText('Enabled')).toBeDefined();
		expect(screen.getByText('Locked off while Review is disabled.')).toBeDefined();
	});
});

describe('PhaseSettingsDetail — model targets', () => {
	/** The four target-list handlers the detail screen calls, stubbed per render. */
	interface TargetHandlerMocks {
		handleTargetChange: Mock;
		handleAddTarget: Mock;
		handleRemoveTarget: Mock;
		handleMoveTarget: Mock;
	}

	const twoTargets: AgentConfig = {
		targets: [
			{ cli: 'claude', model: 'sonnet', reasoning: 'high' },
			{ cli: 'codex', model: 'gpt-5.6-terra' },
		],
	};

	function renderDetail(config: AgentConfig, handlers: Partial<TargetHandlerMocks> = {}) {
		const mocks: TargetHandlerMocks = {
			handleTargetChange: vi.fn(),
			handleAddTarget: vi.fn(),
			handleRemoveTarget: vi.fn(),
			handleMoveTarget: vi.fn(),
			...handlers,
		};
		render(
			<PhaseSettingsDetail
				phase="planning"
				config={config}
				isPending={false}
				enabled={undefined}
				{...mocks}
				handleTimeoutChange={() => {}}
				handlePromptChange={() => {}}
				onBack={() => {}}
			/>,
		);
		return mocks;
	}

	it('renders one row per target, in priority order, flagging the preferred one', () => {
		renderDetail(twoTargets);

		expect(screen.getByText('Priority 1')).toBeDefined();
		expect(screen.getByText('Priority 2')).toBeDefined();
		// The worker routes down the list when a CLI is unavailable (issue #346), so
		// the badge marks the *preferred* target — exactly one row.
		expect(screen.getAllByText('Preferred')).toHaveLength(1);

		expect((screen.getByLabelText('Agent CLI, target 1') as HTMLSelectElement).value).toBe(
			'claude',
		);
		expect((screen.getByLabelText('Model, target 1') as HTMLSelectElement).value).toBe('sonnet');
		expect((screen.getByLabelText('Reasoning, target 1') as HTMLSelectElement).value).toBe('high');
		expect((screen.getByLabelText('Agent CLI, target 2') as HTMLSelectElement).value).toBe('codex');
	});

	it('renders a config written before targets existed as its single target', () => {
		renderDetail({ cli: 'antigravity', model: 'Gemini 3.5 Flash (High)' });

		expect((screen.getByLabelText('Agent CLI, target 1') as HTMLSelectElement).value).toBe(
			'antigravity',
		);
		expect((screen.getByLabelText('Model, target 1') as HTMLSelectElement).value).toBe(
			'gemini-3.5-flash',
		);
		expect((screen.getByLabelText('Reasoning, target 1') as HTMLSelectElement).value).toBe('high');
	});

	it('offers each row only the CLIs no other row claims', () => {
		renderDetail(twoTargets);

		const first = screen.getByLabelText('Agent CLI, target 1') as HTMLSelectElement;
		const second = screen.getByLabelText('Agent CLI, target 2') as HTMLSelectElement;
		expect([...first.options].map((option) => option.value)).toEqual(['claude', 'antigravity']);
		expect([...second.options].map((option) => option.value)).toEqual(['antigravity', 'codex']);
	});

	it("scopes a row's Model options to its own CLI", () => {
		renderDetail(twoTargets);

		const model = screen.getByLabelText('Model, target 2') as HTMLSelectElement;
		const options = [...model.options].map((option) => option.value);
		expect(options).toContain('gpt-5.6-terra');
		expect(options).not.toContain('sonnet');
	});

	it("disables a row's Reasoning selector for a model with no reasoning control", () => {
		// Haiku has no `--effort` control, so the level isn't selectable for it.
		renderDetail({ targets: [{ cli: 'claude', model: 'haiku' }] });

		expect((screen.getByLabelText('Reasoning, target 1') as HTMLSelectElement).disabled).toBe(true);
	});

	it('reports a CLI/model/reasoning edit as a patch on that row', () => {
		const { handleTargetChange } = renderDetail(twoTargets);

		fireEvent.change(screen.getByLabelText('Agent CLI, target 2'), {
			target: { value: 'antigravity' },
		});
		expect(handleTargetChange).toHaveBeenCalledWith('planning', 1, { cli: 'antigravity' });

		fireEvent.change(screen.getByLabelText('Model, target 1'), { target: { value: 'opus' } });
		expect(handleTargetChange).toHaveBeenCalledWith('planning', 0, { model: 'opus' });

		fireEvent.change(screen.getByLabelText('Reasoning, target 1'), { target: { value: 'max' } });
		expect(handleTargetChange).toHaveBeenCalledWith('planning', 0, { reasoning: 'max' });
	});

	it('reorders and removes by position', () => {
		const { handleMoveTarget, handleRemoveTarget } = renderDetail(twoTargets);

		// The ends can't move past the list.
		expect((screen.getByLabelText('Move target 1 up') as HTMLButtonElement).disabled).toBe(true);
		expect((screen.getByLabelText('Move target 2 down') as HTMLButtonElement).disabled).toBe(true);

		fireEvent.click(screen.getByLabelText('Move target 2 up'));
		expect(handleMoveTarget).toHaveBeenCalledWith('planning', 1, 'up');

		fireEvent.click(screen.getByLabelText('Move target 1 down'));
		expect(handleMoveTarget).toHaveBeenCalledWith('planning', 0, 'down');

		fireEvent.click(screen.getByLabelText('Remove target 2'));
		expect(handleRemoveTarget).toHaveBeenCalledWith('planning', 1);
	});

	it('adds a target from the card below the target list', () => {
		const { handleAddTarget } = renderDetail(twoTargets);

		const add = screen.getByRole('button', { name: 'Add target' }) as HTMLButtonElement;
		expect(add.disabled).toBe(false);
		expect(add.className).toContain('border-dashed');
		expect(screen.getByRole('list').nextElementSibling).toBe(add);
		fireEvent.click(add);
		expect(handleAddTarget).toHaveBeenCalledWith('planning');
	});

	it('hides the add-target card once all three CLIs have one', () => {
		renderDetail({
			targets: [{ cli: 'claude' }, { cli: 'codex' }, { cli: 'antigravity' }],
		});

		expect(screen.queryByRole('button', { name: 'Add target' })).toBeNull();
	});

	it('explains that an empty list keeps the phase on coded defaults', () => {
		renderDetail({});

		expect(screen.queryByLabelText('Agent CLI, target 1')).toBeNull();
		expect(screen.getByText(/this phase runs on the pipeline's coded defaults/)).toBeDefined();
	});

	it('flags a duplicate CLI, the state the config schema rejects', () => {
		renderDetail({ targets: [{ cli: 'claude' }, { cli: 'claude', model: 'opus' }] });

		expect(screen.getByText(/Each agent CLI can appear at most once/)).toBeDefined();
	});
});

describe('PipelineSettingsForm — Review check policy', () => {
	const noop = () => {};

	it('defaults to Require CI checks selected', () => {
		render(
			<PipelineSettingsForm
				autoMerge={false}
				setAutoMerge={noop}
				skipRespondToReviewOnMinors={true}
				setSkipRespondToReviewOnMinors={noop}
				reviewChecksPolicy="required"
				setReviewChecksPolicy={noop}
				handleSubmit={(e) => e.preventDefault()}
				handleReset={noop}
				isDirty={false}
				isPending={false}
				isSuccess={false}
				isError={false}
			/>,
		);

		const required = screen.getByRole('radio', {
			name: /^Require CI checks/,
		}) as HTMLInputElement;
		const ifPresent = screen.getByRole('radio', {
			name: /^Review when no checks exist/,
		}) as HTMLInputElement;
		expect(required.checked).toBe(true);
		expect(ifPresent.checked).toBe(false);
	});

	it('reflects a stored if-present selection', () => {
		render(
			<PipelineSettingsForm
				autoMerge={false}
				setAutoMerge={noop}
				skipRespondToReviewOnMinors={true}
				setSkipRespondToReviewOnMinors={noop}
				reviewChecksPolicy="if-present"
				setReviewChecksPolicy={noop}
				handleSubmit={(e) => e.preventDefault()}
				handleReset={noop}
				isDirty={false}
				isPending={false}
				isSuccess={false}
				isError={false}
			/>,
		);

		const required = screen.getByRole('radio', {
			name: /^Require CI checks/,
		}) as HTMLInputElement;
		const ifPresent = screen.getByRole('radio', {
			name: /^Review when no checks exist/,
		}) as HTMLInputElement;
		expect(required.checked).toBe(false);
		expect(ifPresent.checked).toBe(true);
	});

	it('calls setReviewChecksPolicy when a different option is picked', () => {
		const setReviewChecksPolicy = vi.fn();
		render(
			<PipelineSettingsForm
				autoMerge={false}
				setAutoMerge={noop}
				skipRespondToReviewOnMinors={true}
				setSkipRespondToReviewOnMinors={noop}
				reviewChecksPolicy="required"
				setReviewChecksPolicy={setReviewChecksPolicy}
				handleSubmit={(e) => e.preventDefault()}
				handleReset={noop}
				isDirty={false}
				isPending={false}
				isSuccess={false}
				isError={false}
			/>,
		);

		fireEvent.click(screen.getByRole('radio', { name: /^Review when no checks exist/ }));
		expect(setReviewChecksPolicy).toHaveBeenCalledWith('if-present');
	});

	it('includes explanatory copy limiting the no-CI option to repositories without CI', () => {
		render(
			<PipelineSettingsForm
				autoMerge={false}
				setAutoMerge={noop}
				skipRespondToReviewOnMinors={true}
				setSkipRespondToReviewOnMinors={noop}
				reviewChecksPolicy="required"
				setReviewChecksPolicy={noop}
				handleSubmit={(e) => e.preventDefault()}
				handleReset={noop}
				isDirty={false}
				isPending={false}
				isSuccess={false}
				isError={false}
			/>,
		);

		expect(screen.getByText(/Only for repositories with no CI/)).toBeDefined();
		expect(screen.getByText(/not a way to bypass CI that exists/)).toBeDefined();
	});
});

describe('useToggleAutoSave hook', () => {
	const mockMutateFn = mockMutate;
	const mockSetQueryDataFn = mockSetQueryData;

	it('only sends the changed review enabled/disabled field patch and preserves it during subsequent Pipeline-tab updates', async () => {
		mockMutateFn.mockResolvedValue({
			id: 'p1',
			pipeline: {
				review: { enabled: false },
				respondToReview: { enabled: false },
			},
		});
		mockMutateFn.mockClear();
		mockSetQueryDataFn.mockClear();

		const pipelineEnabled = { review: true, respondToReview: true, respondToCi: true };
		const setPipelineEnabled = vi.fn();
		const pipelineAutoAdvance = { planning: false };
		const setPipelineAutoAdvance = vi.fn();

		const { result } = renderHook(() =>
			useToggleAutoSave({
				projectId: 'p1',
				pipelineEnabled,
				setPipelineEnabled,
				pipelineAutoAdvance,
				setPipelineAutoAdvance,
				blocked: false,
			}),
		);

		await act(async () => {
			result.current.handleEnabledChange('review', false);
		});

		// Verify the toggle mutation sends ONLY the changed review field and forced dependency.
		expect(mockMutateFn).toHaveBeenCalledWith({
			id: 'p1',
			pipeline: {
				review: { enabled: false },
				respondToReview: { enabled: false },
			},
		});

		expect(setPipelineEnabled).toHaveBeenCalledWith({
			review: false,
			respondToReview: false,
			respondToCi: true,
		});

		expect(mockSetQueryDataFn).toHaveBeenCalledWith(['projects', 'getById', { id: 'p1' }], {
			id: 'p1',
			pipeline: {
				review: { enabled: false },
				respondToReview: { enabled: false },
			},
		});
	});

	it('only sends the planning autoAdvance toggle patch', async () => {
		mockMutateFn.mockResolvedValue({
			id: 'p1',
			pipeline: {
				planning: { autoAdvance: true },
			},
		});
		mockMutateFn.mockClear();
		mockSetQueryDataFn.mockClear();

		const pipelineEnabled = { review: true, respondToReview: true, respondToCi: true };
		const setPipelineEnabled = vi.fn();
		const pipelineAutoAdvance = { planning: false };
		const setPipelineAutoAdvance = vi.fn();

		const { result } = renderHook(() =>
			useToggleAutoSave({
				projectId: 'p1',
				pipelineEnabled,
				setPipelineEnabled,
				pipelineAutoAdvance,
				setPipelineAutoAdvance,
				blocked: false,
			}),
		);

		await act(async () => {
			result.current.handleAutoAdvanceChange('planning', true);
		});

		// Verify the toggle mutation sends ONLY the changed autoAdvance field.
		expect(mockMutateFn).toHaveBeenCalledWith({
			id: 'p1',
			pipeline: {
				planning: { autoAdvance: true },
			},
		});

		expect(setPipelineAutoAdvance).toHaveBeenCalledWith({
			planning: true,
		});
	});

	it('refuses a toggle while a Save Changes mutation is in flight (blocked), leaving state untouched', () => {
		mockMutateFn.mockClear();
		const setPipelineEnabled = vi.fn();
		const setPipelineAutoAdvance = vi.fn();

		const { result } = renderHook(() =>
			useToggleAutoSave({
				projectId: 'p1',
				pipelineEnabled: { review: true, respondToReview: true, respondToCi: true },
				setPipelineEnabled,
				pipelineAutoAdvance: { planning: false },
				setPipelineAutoAdvance,
				// A tab's Save Changes mutation is running: `updateMutation.isPending`
				// is wired into `blocked` by the route.
				blocked: true,
			}),
		);

		act(() => {
			result.current.handleEnabledChange('review', false);
			result.current.handleAutoAdvanceChange('planning', true);
		});

		// No write is fired and the optimistic state is not touched — the toggle
		// auto-save cannot overlap the in-flight Save, so neither read-merge-upsert
		// can clobber the other (#369).
		expect(mockMutateFn).not.toHaveBeenCalled();
		expect(setPipelineEnabled).not.toHaveBeenCalled();
		expect(setPipelineAutoAdvance).not.toHaveBeenCalled();
	});

	it('serializes overlapping toggle saves: a second flip is ignored until the first resolves, and Review stays disabled', async () => {
		mockMutateFn.mockClear();
		mockSetQueryDataFn.mockClear();

		let resolveFirst: ((value: unknown) => void) | undefined;
		const persisted = {
			id: 'p1',
			pipeline: { review: { enabled: false }, respondToReview: { enabled: false } },
		};
		mockMutateFn.mockImplementationOnce(
			() =>
				new Promise((res) => {
					resolveFirst = res;
				}),
		);

		const setPipelineEnabled = vi.fn();
		const { result } = renderHook(() =>
			useToggleAutoSave({
				projectId: 'p1',
				pipelineEnabled: { review: true, respondToReview: true, respondToCi: true },
				setPipelineEnabled,
				pipelineAutoAdvance: { planning: false },
				setPipelineAutoAdvance: vi.fn(),
				blocked: false,
			}),
		);

		// Disable Review — its save is now in flight (the promise has not resolved).
		act(() => {
			result.current.handleEnabledChange('review', false);
		});
		expect(result.current.savingToggleKey).toBe(toggleSaveKey('review', 'enabled'));
		expect(mockMutateFn).toHaveBeenCalledTimes(1);

		// A second toggle flip while the first is outstanding is refused — writes
		// stay serialized so the in-flight Review save can't be clobbered.
		act(() => {
			result.current.handleEnabledChange('respondToCi', false);
		});
		expect(mockMutateFn).toHaveBeenCalledTimes(1);

		// Resolve the Review save: the gate clears and the cache holds the disabled
		// Review flag the successful write persisted.
		await act(async () => {
			resolveFirst?.(persisted);
		});
		expect(result.current.savingToggleKey).toBeUndefined();
		expect(mockSetQueryDataFn).toHaveBeenCalledWith(
			['projects', 'getById', { id: 'p1' }],
			persisted,
		);
	});
});

describe('diffProjectForSync', () => {
	it('reports every slice changed on the first sync (no previous project)', () => {
		expect(diffProjectForSync(undefined, makeProject())).toEqual({
			general: true,
			agents: true,
			pipeline: true,
			boardMapping: true,
		});
	});

	it('reports no slice changed when the project is identical', () => {
		const prev = makeProject({ agents: { defaults: {} }, pipeline: { review: { enabled: true } } });
		const next = makeProject({ agents: { defaults: {} }, pipeline: { review: { enabled: true } } });
		expect(diffProjectForSync(prev, next)).toEqual({
			general: false,
			agents: false,
			pipeline: false,
			boardMapping: false,
		});
	});

	it('flags only pipeline when a toggle save changed only the pipeline — Agents/General edits are not re-synced', () => {
		// This is the toggle-auto-save case: its success `setQueryData` (or a refetch)
		// updates only `pipeline`, so the route must not reset the user's unsaved
		// Agents/General/Board edits (#369).
		const prev = makeProject({
			agents: { defaults: {} },
			pipeline: { review: { enabled: true } },
		});
		const next = makeProject({
			agents: { defaults: {} },
			pipeline: { review: { enabled: false } },
		});
		expect(diffProjectForSync(prev, next)).toEqual({
			general: false,
			agents: false,
			pipeline: true,
			boardMapping: false,
		});
	});

	it('flags only agents when just the agents slice changed', () => {
		const prev = makeProject({ agents: { planning: {} } });
		const next = makeProject({ agents: { planning: { timeoutMs: 1000 } } });
		expect(diffProjectForSync(prev, next)).toMatchObject({ agents: true, pipeline: false });
	});

	it('flags general when a scalar field like maxConcurrentJobs changed', () => {
		const prev = makeProject({ maxConcurrentJobs: 1 });
		const next = makeProject({ maxConcurrentJobs: 4 });
		expect(diffProjectForSync(prev, next)).toMatchObject({ general: true, pipeline: false });
	});
});

describe('PipelineSettingsForm serialization', () => {
	it('disables its Save while a config write is in flight so a Pipeline save cannot overlap a toggle auto-save', () => {
		// The route feeds `configWriteInFlight` (updateMutation.isPending OR a toggle
		// save in flight) into `isPending`, so a toggle auto-save disables this tab's
		// Save — the reverse half of the two-way serialization (#369).
		render(
			<PipelineSettingsForm
				autoMerge={false}
				setAutoMerge={() => {}}
				skipRespondToReviewOnMinors={true}
				setSkipRespondToReviewOnMinors={() => {}}
				reviewChecksPolicy="required"
				setReviewChecksPolicy={() => {}}
				handleSubmit={(e) => e.preventDefault()}
				handleReset={() => {}}
				isDirty={true}
				isPending={true}
				isSuccess={false}
				isError={false}
			/>,
		);

		expect(screen.getByRole('button', { name: /Saving…/ })).toHaveProperty('disabled', true);
	});
});
