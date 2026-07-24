import { describe, expect, it } from 'vitest';
import {
	type AgentConfig,
	AgentConfigSchema,
	AgentsConfigSchema,
	CUSTOM_PROMPT_MAX_LENGTH,
	PipelineConfigSchema,
	PROJECT_DEFAULTS,
	ProjectConfigSchema,
	SwarmConfigSchema,
	validateConfig,
	type WorktreeRetentionConfig,
} from '@/config/schema.js';
import { createMockProjectConfig } from '../../helpers/factories.js';

describe('ProjectConfigSchema', () => {
	it('accepts a fully-specified project', () => {
		const project = createMockProjectConfig();
		expect(project.repo).toBe('jkwiecien/swarm');
		expect(project.credentials.reviewer).toBe('SCM_TOKEN_REVIEWER');
		expect(project.githubProjects.statusFieldId).toBe('PVTSSF_lAHOAC3TF84BcNwDzhW4MKo');
	});

	it('applies worktree/branch/pm defaults when omitted', () => {
		const project = ProjectConfigSchema.parse({
			id: 'swarm',
			name: 'swarm',
			repo: 'jkwiecien/swarm',
			repoRoot: '/Users/dev/swarm/swarm',
			githubProjects: {
				projectId: 'PVT_x',
				statusFieldId: 'PVTSSF_y',
				statusOptions: { backlog: 'opt-1' },
			},
			credentials: {
				implementer: 'A',
				reviewer: 'B',
				webhookSecret: 'C',
			},
		});
		expect(project.worktreeRoot).toBe(PROJECT_DEFAULTS.worktreeRoot);
		expect(project.baseBranch).toBe(PROJECT_DEFAULTS.baseBranch);
		expect(project.branchPrefix).toBe(PROJECT_DEFAULTS.branchPrefix);
		expect(project.maxConcurrentJobs).toBe(PROJECT_DEFAULTS.maxConcurrentJobs);
		expect(project.pm.type).toBe('github-projects');
	});

	it('accepts only positive integer maximum concurrent jobs', () => {
		expect(createMockProjectConfig({ maxConcurrentJobs: 4 }).maxConcurrentJobs).toBe(4);
		for (const maxConcurrentJobs of [0, -1, 1.5]) {
			expect(() => createMockProjectConfig({ maxConcurrentJobs })).toThrow();
		}
	});

	it('rejects a repo that is not owner/repo', () => {
		expect(() => createMockProjectConfig({ repo: 'not-a-slug' })).toThrow(/owner\/repo/);
	});

	it('requires the githubProjects board mapping', () => {
		expect(() =>
			ProjectConfigSchema.parse({
				id: 'swarm',
				name: 'swarm',
				repo: 'jkwiecien/swarm',
				repoRoot: '/Users/dev/swarm/swarm',
				credentials: { reviewer: 'B', webhookSecret: 'C' },
			}),
		).toThrow();
	});

	it('requires every credential reference', () => {
		expect(() => createMockProjectConfig({ credentials: undefined as never })).toThrow();
		expect(() =>
			createMockProjectConfig({
				credentials: { reviewer: 'B', webhookSecret: '' },
			}),
		).toThrow();
	});

	it('strips a legacy implementer credential reference rather than rejecting it (issue #396)', () => {
		const project = createMockProjectConfig({
			credentials: {
				implementer: 'SCM_TOKEN_IMPLEMENTER',
				reviewer: 'B',
				webhookSecret: 'C',
			} as never,
		});
		expect('implementer' in project.credentials).toBe(false);
		expect(project.credentials.reviewer).toBe('B');
	});

	it('omits agents entirely by default (every phase keeps its coded default)', () => {
		const project = createMockProjectConfig();
		expect(project.agents).toBeUndefined();
	});

	it('accepts a per-phase agent CLI/model override (normalizing legacy antigravity strings)', () => {
		const project = createMockProjectConfig({
			agents: {
				planning: { cli: 'claude', model: 'sonnet' },
				implementation: { cli: 'antigravity', model: 'Gemini 3.5 Flash (High)' },
				review: { cli: 'codex', model: 'gpt-5.6-sol' },
			},
		});
		// Each single selection is also mirrored into a one-element `targets` list
		// (issue #342); the top-level fields stay the highest-priority target.
		expect(project.agents).toEqual({
			planning: { cli: 'claude', model: 'sonnet', targets: [{ cli: 'claude', model: 'sonnet' }] },
			// The legacy combined antigravity string migrates losslessly to logical
			// model + reasoning (issue #180).
			implementation: {
				cli: 'antigravity',
				model: 'gemini-3.5-flash',
				reasoning: 'high',
				targets: [{ cli: 'antigravity', model: 'gemini-3.5-flash', reasoning: 'high' }],
			},
			review: {
				cli: 'codex',
				model: 'gpt-5.6-sol',
				targets: [{ cli: 'codex', model: 'gpt-5.6-sol' }],
			},
		});
	});

	it('accepts the gemini-3.6-flash antigravity model via the normal cli/model/reasoning path', () => {
		const project = createMockProjectConfig({
			agents: { planning: { cli: 'antigravity', model: 'gemini-3.6-flash', reasoning: 'high' } },
		});
		expect(project.agents?.planning).toEqual({
			cli: 'antigravity',
			model: 'gemini-3.6-flash',
			reasoning: 'high',
			targets: [{ cli: 'antigravity', model: 'gemini-3.6-flash', reasoning: 'high' }],
		});
	});

	it('accepts an explicit per-phase reasoning level supported by the model', () => {
		const project = createMockProjectConfig({
			agents: { planning: { cli: 'claude', model: 'sonnet', reasoning: 'high' } },
		});
		expect(project.agents?.planning).toEqual({
			cli: 'claude',
			model: 'sonnet',
			reasoning: 'high',
			targets: [{ cli: 'claude', model: 'sonnet', reasoning: 'high' }],
		});
	});

	it('rejects a reasoning level the selected model does not support', () => {
		// Antigravity Gemini 3.1 Pro exposes only low/high — medium is invalid.
		expect(() =>
			createMockProjectConfig({
				agents: { planning: { cli: 'antigravity', model: 'gemini-3.1-pro', reasoning: 'medium' } },
			}),
		).toThrow(/reasoning/);
	});

	it('rejects a reasoning level on a single-variant model with no choices', () => {
		expect(() =>
			createMockProjectConfig({
				agents: {
					planning: { cli: 'antigravity', model: 'claude-sonnet-4.6', reasoning: 'high' },
				},
			}),
		).toThrow(/reasoning/);
	});

	it('rejects an unknown cli value in an agent override', () => {
		expect(() =>
			createMockProjectConfig({ agents: { planning: { cli: 'gpt' as never } } }),
		).toThrow();
	});

	it('rejects a model not in the known list for its cli', () => {
		expect(() =>
			createMockProjectConfig({ agents: { planning: { cli: 'claude', model: 'nonsense' } } }),
		).toThrow(/known models/);
	});

	it("rejects a claude alias passed under cli: 'antigravity' (and vice versa)", () => {
		expect(() =>
			createMockProjectConfig({ agents: { planning: { cli: 'antigravity', model: 'sonnet' } } }),
		).toThrow();
		expect(() =>
			createMockProjectConfig({
				agents: { review: { cli: 'claude', model: 'Gemini 3.5 Flash (High)' } },
			}),
		).toThrow();
	});

	it("rejects a codex model under cli: 'claude' and a claude alias under cli: 'codex'", () => {
		expect(() =>
			createMockProjectConfig({ agents: { planning: { cli: 'claude', model: 'gpt-5.6-sol' } } }),
		).toThrow();
		expect(() =>
			createMockProjectConfig({ agents: { planning: { cli: 'codex', model: 'sonnet' } } }),
		).toThrow();
	});

	it('checks a model against the combined list when cli is omitted', () => {
		expect(() =>
			createMockProjectConfig({ agents: { planning: { model: 'sonnet' } } }),
		).not.toThrow();
		expect(() =>
			createMockProjectConfig({
				agents: { planning: { model: 'Gemini 3.5 Flash (High)' } },
			}),
		).not.toThrow();
		expect(() =>
			createMockProjectConfig({ agents: { planning: { model: 'gpt-5.6-sol' } } }),
		).not.toThrow();
		expect(() =>
			createMockProjectConfig({ agents: { planning: { model: 'nonsense' } } }),
		).toThrow();
	});

	it('omits pipeline entirely by default', () => {
		const project = createMockProjectConfig();
		expect(project.pipeline).toBeUndefined();
	});

	it('accepts a Planning autoAdvance override', () => {
		const project = createMockProjectConfig({
			pipeline: { planning: { autoAdvance: true } },
		});
		expect(project.pipeline).toEqual({
			planning: { autoAdvance: true },
		});
	});

	it('accepts an optional respond-to-review autoMerge override', () => {
		expect(PipelineConfigSchema.parse({ respondToReview: { autoMerge: true } })).toMatchObject({
			respondToReview: { autoMerge: true },
		});
	});

	it('accepts the default-on skip-minors Respond-to-review override', () => {
		expect(PipelineConfigSchema.parse({ respondToReview: { skipOnMinors: true } })).toMatchObject({
			respondToReview: { skipOnMinors: true },
		});
	});

	it.each(['required', 'if-present'])('accepts the review checks policy %s', (checks) => {
		expect(PipelineConfigSchema.parse({ review: { checks } })).toMatchObject({
			review: { checks },
		});
	});

	it('rejects an unsupported review checks policy', () => {
		expect(PipelineConfigSchema.safeParse({ review: { checks: 'always' } }).success).toBe(false);
	});

	it('omits the review checks policy when unset, leaving the required default to the consumer', () => {
		expect(PipelineConfigSchema.parse({ review: { enabled: true } })).toEqual({
			review: { enabled: true },
		});
	});

	it('limits per-phase timeouts to five through forty-five minutes', () => {
		expect(() => AgentConfigSchema.parse({ timeoutMs: 5 * 60 * 1000 })).not.toThrow();
		expect(() => AgentConfigSchema.parse({ timeoutMs: 45 * 60 * 1000 })).not.toThrow();
		expect(() => AgentConfigSchema.parse({ timeoutMs: 5 * 60 * 1000 - 1 })).toThrow();
		expect(() => AgentConfigSchema.parse({ timeoutMs: 45 * 60 * 1000 + 1 })).toThrow();
	});

	describe('custom prompt (issue #135)', () => {
		it('leaves prompt unset when omitted', () => {
			expect(AgentConfigSchema.parse({}).prompt).toBeUndefined();
		});

		it('trims a custom prompt on parse', () => {
			expect(AgentConfigSchema.parse({ prompt: '  follow house style  ' }).prompt).toBe(
				'follow house style',
			);
		});

		it('normalizes a whitespace-only prompt to unset (not stored as an override)', () => {
			expect(AgentConfigSchema.parse({ prompt: '   \n\t ' }).prompt).toBeUndefined();
			expect(AgentConfigSchema.parse({ prompt: '' }).prompt).toBeUndefined();
		});

		it('accepts a prompt at the maximum length and rejects one over it', () => {
			expect(() =>
				AgentConfigSchema.parse({ prompt: 'a'.repeat(CUSTOM_PROMPT_MAX_LENGTH) }),
			).not.toThrow();
			expect(() =>
				AgentConfigSchema.parse({ prompt: 'a'.repeat(CUSTOM_PROMPT_MAX_LENGTH + 1) }),
			).toThrow(/at most/);
		});

		it('measures the bound against the trimmed value', () => {
			// Over the bound only counting whitespace — trims to the max, so it passes.
			const padded = `${'a'.repeat(CUSTOM_PROMPT_MAX_LENGTH)}${'  '.repeat(50)}`;
			expect(() => AgentConfigSchema.parse({ prompt: padded })).not.toThrow();
		});
	});

	it('omits worktreeRetention entirely by default', () => {
		const project = createMockProjectConfig();
		expect(project.worktreeRetention).toBeUndefined();
	});

	it('applies defaults to worktreeRetention.maxWorktrees when the block is present but field is omitted', () => {
		const project = createMockProjectConfig({
			worktreeRetention: {} as unknown as WorktreeRetentionConfig,
		});
		expect(project.worktreeRetention).toEqual({
			maxWorktrees: PROJECT_DEFAULTS.maxWorktrees,
		});
	});

	it('accepts a valid worktreeRetention config', () => {
		const project = createMockProjectConfig({
			worktreeRetention: { maxWorktrees: 5 },
		});
		expect(project.worktreeRetention?.maxWorktrees).toBe(5);
	});

	it('rejects a non-positive or non-integer maxWorktrees', () => {
		expect(() =>
			createMockProjectConfig({
				worktreeRetention: { maxWorktrees: 0 },
			}),
		).toThrow();

		expect(() =>
			createMockProjectConfig({
				worktreeRetention: { maxWorktrees: -3 },
			}),
		).toThrow();

		expect(() =>
			createMockProjectConfig({
				worktreeRetention: { maxWorktrees: 5.5 },
			}),
		).toThrow();
	});
});

describe('AgentConfigSchema targets (issue #342)', () => {
	it('keeps an ordered target list and mirrors the highest-priority one', () => {
		const agent = AgentConfigSchema.parse({
			targets: [
				{ cli: 'claude', model: 'sonnet', reasoning: 'high' },
				{ cli: 'codex', model: 'gpt-5.6-terra' },
			],
		});
		expect(agent.targets).toEqual([
			{ cli: 'claude', model: 'sonnet', reasoning: 'high' },
			{ cli: 'codex', model: 'gpt-5.6-terra' },
		]);
		expect(agent).toMatchObject({ cli: 'claude', model: 'sonnet', reasoning: 'high' });
	});

	it('folds a legacy single-selection config into a one-element list', () => {
		const agent = AgentConfigSchema.parse({ cli: 'claude', model: 'sonnet' });
		expect(agent.targets).toEqual([{ cli: 'claude', model: 'sonnet' }]);
		// The mirror is what every pre-#342 reader (the worker, the dashboard) uses.
		expect(agent).toMatchObject({ cli: 'claude', model: 'sonnet' });
	});

	it('migrates a legacy antigravity combined string into its sole target', () => {
		const agent = AgentConfigSchema.parse({
			cli: 'antigravity',
			model: 'Gemini 3.5 Flash (High)',
		});
		expect(agent.targets).toEqual([
			{ cli: 'antigravity', model: 'gemini-3.5-flash', reasoning: 'high' },
		]);
		expect(agent).toMatchObject({
			cli: 'antigravity',
			model: 'gemini-3.5-flash',
			reasoning: 'high',
		});
	});

	it('rewrites a stale mirror from the highest-priority target', () => {
		const agent = AgentConfigSchema.parse({
			cli: 'codex',
			model: 'gpt-5.5',
			reasoning: 'high',
			targets: [{ cli: 'claude' }],
		});
		expect(agent.cli).toBe('claude');
		expect(agent.model).toBeUndefined();
		expect(agent.reasoning).toBeUndefined();
	});

	it('rejects two targets naming the same cli', () => {
		expect(() =>
			AgentConfigSchema.parse({ targets: [{ cli: 'claude' }, { cli: 'claude', model: 'opus' }] }),
		).toThrow(/same cli twice/);
	});

	it('validates every target, not just the highest-priority one', () => {
		expect(() =>
			AgentConfigSchema.parse({ targets: [{ cli: 'claude' }, { cli: 'codex', model: 'opus' }] }),
		).toThrow(/known models/);
		expect(() =>
			AgentConfigSchema.parse({
				targets: [
					{ cli: 'claude', model: 'sonnet' },
					{ cli: 'antigravity', reasoning: 'high' },
				],
			}),
		).toThrow(/reasoning/);
	});

	it('leaves a selection-free override on the coded defaults', () => {
		// No cli/model/reasoning anywhere — no list to build and nothing to mirror.
		expect(AgentConfigSchema.parse({})).toEqual({});
		expect(AgentConfigSchema.parse({ targets: [] })).toEqual({});
		// timeoutMs and prompt stay phase-level: they bound the run whichever target wins.
		const agent = AgentConfigSchema.parse({ timeoutMs: 10 * 60 * 1000, prompt: '  house style ' });
		expect(agent).toEqual({ timeoutMs: 10 * 60 * 1000, prompt: 'house style' });
	});

	it('clears stale top-level fields when targets is explicitly empty', () => {
		// A user can clear configured target/mirror fields by specifying targets: []
		// even if legacy top-level fields are present in the input.
		expect(
			AgentConfigSchema.parse({
				cli: 'claude',
				model: 'sonnet',
				reasoning: 'high',
				targets: [],
			}),
		).toEqual({});
	});

	it('continues to fold legacy fields into one target when targets is absent', () => {
		// Absent targets means legacy input should be folded.
		const agent = AgentConfigSchema.parse({
			cli: 'claude',
			model: 'sonnet',
		});
		expect(agent).toEqual({
			cli: 'claude',
			model: 'sonnet',
			targets: [{ cli: 'claude', model: 'sonnet' }],
		});
	});

	it('keeps targets optional on the inferred type (existing literals still compile)', () => {
		// The dashboard builds `AgentConfig` literals with the mirror fields only
		// (`cleanAgentConfig`, dashboard/src/routes/projects/$projectId.tsx) — adding
		// `targets` must not force the key onto them.
		const legacyLiteral = { cli: 'claude', model: 'sonnet' } satisfies AgentConfig;
		expect(AgentConfigSchema.parse(legacyLiteral).targets).toHaveLength(1);
	});
});

describe('AgentsConfigSchema', () => {
	it('allows every phase to be omitted', () => {
		expect(AgentsConfigSchema.safeParse({}).success).toBe(true);
	});

	it('allows cli and model to each be specified independently', () => {
		expect(AgentsConfigSchema.safeParse({ review: { cli: 'claude' } }).success).toBe(true);
		expect(AgentsConfigSchema.safeParse({ review: { model: 'opus' } }).success).toBe(true);
	});

	it('accepts an implementationUnplanned override and validates its model for the cli', () => {
		expect(
			AgentsConfigSchema.safeParse({
				implementationUnplanned: { cli: 'codex', model: 'gpt-5.6-terra', reasoning: 'max' },
			}).success,
		).toBe(true);
		expect(
			AgentsConfigSchema.safeParse({
				implementationUnplanned: { cli: 'codex', model: 'opus' },
			}).success,
		).toBe(false);
	});

	it('accepts valid defaults block', () => {
		expect(
			AgentsConfigSchema.safeParse({
				defaults: {
					claude: 'sonnet',
					antigravity: 'Gemini 3.5 Flash (Medium)',
					codex: 'gpt-5.6-terra',
				},
			}).success,
		).toBe(true);
	});

	it('rejects invalid defaults block model names', () => {
		expect(
			AgentsConfigSchema.safeParse({
				defaults: {
					claude: 'Gemini 3.5 Flash (Medium)',
				},
			}).success,
		).toBe(false);
	});
});

describe('PipelineConfigSchema', () => {
	it('allows both phases to be omitted', () => {
		expect(PipelineConfigSchema.safeParse({}).success).toBe(true);
	});

	it('allows Planning autoAdvance to be set', () => {
		expect(PipelineConfigSchema.safeParse({ planning: { autoAdvance: true } }).success).toBe(true);
	});

	it('removes the legacy Implementation autoAdvance setting', () => {
		expect(PipelineConfigSchema.parse({ implementation: { autoAdvance: false } })).toEqual({});
	});

	it('rejects a non-boolean autoAdvance', () => {
		expect(PipelineConfigSchema.safeParse({ planning: { autoAdvance: 'yes' } }).success).toBe(
			false,
		);
	});

	it('allows SCM-event-driven phases to be disabled independently', () => {
		expect(
			PipelineConfigSchema.safeParse({
				review: { enabled: false },
				respondToReview: { enabled: false },
				respondToCi: { enabled: false },
			}).success,
		).toBe(true);
	});

	it('rejects Respond-to-review enabled while Review is disabled', () => {
		expect(
			PipelineConfigSchema.safeParse({
				review: { enabled: false },
				respondToReview: { enabled: true },
			}).success,
		).toBe(false);
		expect(PipelineConfigSchema.safeParse({ review: { enabled: false } }).success).toBe(false);
	});

	it('leaves prioritizeContinuations unset by default (read as on)', () => {
		// Absent → undefined; read sites treat `!== false` as the default-on switch.
		expect(PipelineConfigSchema.parse({}).prioritizeContinuations).toBeUndefined();
	});

	it('accepts an explicit prioritizeContinuations boolean', () => {
		expect(PipelineConfigSchema.parse({ prioritizeContinuations: false })).toMatchObject({
			prioritizeContinuations: false,
		});
		expect(PipelineConfigSchema.parse({ prioritizeContinuations: true })).toMatchObject({
			prioritizeContinuations: true,
		});
	});

	it('rejects a non-boolean prioritizeContinuations', () => {
		expect(PipelineConfigSchema.safeParse({ prioritizeContinuations: 'yes' }).success).toBe(false);
	});

	it('leaves automationLabel unset by default (read as the coded default)', () => {
		// Absent → undefined; `resolveAutomationLabel` supplies `swarm`, since the
		// whole `pipeline` block is optional and a Zod default would never be seen.
		expect(PipelineConfigSchema.parse({}).automationLabel).toBeUndefined();
	});

	it('accepts and trims an automationLabel', () => {
		expect(PipelineConfigSchema.parse({ automationLabel: '  automate  ' })).toMatchObject({
			automationLabel: 'automate',
		});
	});

	it('accepts an empty automationLabel as the explicit opt-out', () => {
		expect(PipelineConfigSchema.parse({ automationLabel: '' })).toMatchObject({
			automationLabel: '',
		});
	});
});

describe('validateConfig', () => {
	it('parses a config with at least one project', () => {
		const config = validateConfig({ projects: [createMockProjectConfig()] });
		expect(config.projects).toHaveLength(1);
	});

	it('rejects a config with no projects', () => {
		expect(() => validateConfig({ projects: [] })).toThrow();
	});

	it('rejects a non-object config', () => {
		expect(() => validateConfig(null)).toThrow();
	});

	it('is the SwarmConfigSchema parser', () => {
		expect(SwarmConfigSchema.safeParse({ projects: [createMockProjectConfig()] }).success).toBe(
			true,
		);
	});
});
