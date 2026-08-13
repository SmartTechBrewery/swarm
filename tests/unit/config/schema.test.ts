import { describe, expect, it } from 'vitest';
import {
	type AgentConfig,
	AgentConfigSchema,
	AgentsConfigSchema,
	CUSTOM_PROMPT_MAX_LENGTH,
	PipelineConfigSchema,
	PROJECT_DEFAULTS,
	ProjectConfigSchema,
	ProjectRecordSchema,
	SwarmConfigSchema,
	validateConfig,
	type WorktreeRetentionConfig,
} from '@/config/schema.js';
import { requireGitHubProjectsConfig } from '@/integrations/pm/github-projects/config-schema.js';
import {
	createMockJiraProjectConfig,
	createMockLinearProjectConfig,
	createMockProjectConfig,
	createMockProjectRecord,
	createMockTrelloProjectConfig,
} from '../../helpers/factories.js';

describe('ProjectConfigSchema', () => {
	it('accepts a fully-specified project', () => {
		const project = createMockProjectConfig();
		const pm = requireGitHubProjectsConfig(project);
		expect(project.repo).toBe('SmartTechBrewery/swarm');
		expect(project.credentials.reviewer).toBe('SCM_TOKEN_REVIEWER');
		expect(project.pm.type).toBe('github-projects');
		expect(pm.statusFieldId).toBe('PVTSSF_lAHOAC3TF84BcNwDzhW4MKo');
	});

	it('applies worktree/branch defaults when omitted', () => {
		const project = ProjectConfigSchema.parse({
			id: 'swarm',
			name: 'swarm',
			repo: 'SmartTechBrewery/swarm',
			repoRoot: '/Users/dev/swarm/swarm',
			pm: {
				type: 'github-projects',
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
});

// Issue #684: the four per-repository fields leave the project's top level and become
// entries of `repositories` on the *record*. `ProjectConfigSchema` above is that record
// scoped to one entry, which is why none of its cases changed.
describe('ProjectRecordSchema', () => {
	/** The shared half of a record, so each case states only the list under test. */
	const shared = {
		id: 'swarm',
		name: 'swarm',
		repoRoot: '/Users/dev/swarm/swarm',
		pm: {
			type: 'github-projects',
			projectId: 'PVT_x',
			statusFieldId: 'PVTSSF_y',
			statusOptions: { backlog: 'opt-1' },
		},
		credentials: {
			reviewer: 'B',
			webhookSecret: 'C',
			pm: { 'github-projects': { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' } },
		},
	};

	it('applies the branch defaults per entry, not per project', () => {
		const record = ProjectRecordSchema.parse({
			...shared,
			repositories: [{ repo: 'SmartTechBrewery/swarm' }],
		});
		expect(record.repositories).toEqual([
			{
				repo: 'SmartTechBrewery/swarm',
				baseBranch: PROJECT_DEFAULTS.baseBranch,
				branchPrefix: PROJECT_DEFAULTS.branchPrefix,
			},
		]);
	});

	it('accepts a per-repository scm override beside the project-level default', () => {
		const record = ProjectRecordSchema.parse({
			...shared,
			scm: 'github',
			repositories: [{ repo: 'SmartTechBrewery/swarm', scm: 'gitlab' }],
		});
		expect(record.scm).toBe('github');
		expect(record.repositories[0].scm).toBe('gitlab');
	});

	it('rejects a project that owns no repository', () => {
		expect(() => ProjectRecordSchema.parse({ ...shared, repositories: [] })).toThrow();
	});

	it('rejects an entry whose repo is not owner/repo', () => {
		expect(() =>
			ProjectRecordSchema.parse({ ...shared, repositories: [{ repo: 'not-a-slug' }] }),
		).toThrow(/owner\/repo/);
	});

	// Issue #684 phase 2 lifted phase 1's one-entry cap: the chosen repository now
	// travels from webhook ingress through the durable dispatch and the run row to the
	// worker (`repositoryForJob`), so a webhook from repository B can no longer run
	// against repository A. Each entry keeps its own defaults; the first is the
	// project's default repository.
	it('accepts several repositories, each defaulted independently', () => {
		const record = ProjectRecordSchema.parse({
			...shared,
			repositories: [
				{ repo: 'acme/one' },
				{ repo: 'acme/two', baseBranch: 'develop', branchPrefix: 'task-' },
				{ repo: 'acme/three', scm: 'gitlab' },
			],
		});
		expect(record.repositories).toEqual([
			{
				repo: 'acme/one',
				baseBranch: PROJECT_DEFAULTS.baseBranch,
				branchPrefix: PROJECT_DEFAULTS.branchPrefix,
			},
			{ repo: 'acme/two', baseBranch: 'develop', branchPrefix: 'task-' },
			{
				repo: 'acme/three',
				scm: 'gitlab',
				baseBranch: PROJECT_DEFAULTS.baseBranch,
				branchPrefix: PROJECT_DEFAULTS.branchPrefix,
			},
		]);
	});

	// Issue #686 phase 1: a repository entry declares the provider-native id a board
	// card carries to claim it. Uniqueness within the project is a parse error, so
	// `swarm config apply` catches it rather than a dispatch discovering it later.
	it('accepts distinct routing tokens, and an entry that declares none', () => {
		const record = ProjectRecordSchema.parse({
			...shared,
			repositories: [
				{ repo: 'acme/one', pmRoutingToken: 'component-1' },
				{ repo: 'acme/two', pmRoutingToken: 'component-2' },
				{ repo: 'acme/three' },
			],
		});
		expect(record.repositories.map((entry) => entry.pmRoutingToken)).toEqual([
			'component-1',
			'component-2',
			undefined,
		]);
	});

	it('rejects two repositories claiming the same routing token, naming the token', () => {
		expect(() =>
			ProjectRecordSchema.parse({
				...shared,
				repositories: [
					{ repo: 'acme/one', pmRoutingToken: 'component-1' },
					{ repo: 'acme/two', pmRoutingToken: 'component-1' },
				],
			}),
		).toThrow(/pmRoutingToken 'component-1' is claimed by both 'acme\/one' and 'acme\/two'/);
	});

	it('reports the duplicate at the second claimant’s own path', () => {
		const result = ProjectRecordSchema.safeParse({
			...shared,
			repositories: [
				{ repo: 'acme/one', pmRoutingToken: 'dupe' },
				{ repo: 'acme/two', pmRoutingToken: 'dupe' },
			],
		});
		expect(result.success).toBe(false);
		expect(result.error?.issues.map((issue) => issue.path)).toEqual([
			['repositories', 1, 'pmRoutingToken'],
		]);
	});

	it('rejects an empty routing token rather than treating it as absent', () => {
		expect(() =>
			ProjectRecordSchema.parse({
				...shared,
				repositories: [{ repo: 'acme/one', pmRoutingToken: '' }],
			}),
		).toThrow();
	});

	// The record carries the same cross-field credential checks the scoped config does —
	// neither reads a repository, so both refine through the same two functions.
	it('applies the same credential cross-field checks the scoped config does', () => {
		expect(() =>
			ProjectRecordSchema.parse({
				...shared,
				credentials: { ...shared.credentials, pm: { 'githb-projects': { apiToken: 'X' } } },
				repositories: [{ repo: 'SmartTechBrewery/swarm' }],
			}),
		).toThrow(/is not a PM provider id/);
	});

	// `scm` is the discriminator `requireProjectSCMProvider` resolves (issue #478).
	// Validated here at the config boundary rather than pattern-matched at the lookup
	// (ai/CODING_STANDARDS.md "Zod is the source of truth").
	describe('scm discriminator (issue #478)', () => {
		it('accepts every provider id the contract names', () => {
			for (const scm of ['github', 'bitbucket', 'gitlab'] as const) {
				expect(createMockProjectConfig({ scm }).scm).toBe(scm);
			}
		});

		it('rejects a provider id that is not an ScmType', () => {
			expect(() => createMockProjectConfig({ scm: 'gitea' as never })).toThrow();
		});

		// Absence is the back-compat path: a config predating the field parses with the
		// key *absent* (not an explicit undefined), and resolves to the sole
		// runtime-ready provider.
		it('leaves the key absent when omitted', () => {
			const project = createMockProjectConfig();
			expect(project.scm).toBeUndefined();
			expect(Object.hasOwn(project, 'scm')).toBe(false);
		});
	});

	// `pm` carries the board mapping since issue #495, so it has no default: a
	// project with no PM block, or one naming a provider SWARM has no config member
	// for, is rejected rather than silently defaulted onto GitHub Projects.
	it('requires the pm block with its provider board mapping', () => {
		const base = {
			id: 'swarm',
			name: 'swarm',
			repo: 'SmartTechBrewery/swarm',
			repoRoot: '/Users/dev/swarm/swarm',
			credentials: { reviewer: 'B', webhookSecret: 'C' },
		};
		expect(() => ProjectConfigSchema.parse(base)).toThrow();
		// Present, but without the provider's own mapping.
		expect(() => ProjectConfigSchema.parse({ ...base, pm: { type: 'github-projects' } })).toThrow();
		// A `PMType` value whose provider has no config member yet (src/pm/types.ts).
		expect(() =>
			ProjectConfigSchema.parse({ ...base, pm: { type: 'jira', projectId: 'PROJ' } }),
		).toThrow();
	});

	// The union discriminates on `type`, so each member's own schema validates the
	// rest of the block — a GitHub Projects mapping is rejected on its own terms.
	it('validates the selected provider member of the pm union', () => {
		expect(() =>
			createMockProjectConfig({
				pm: { type: 'github-projects', projectId: 'PVT_x', statusFieldId: '', statusOptions: {} },
			}),
		).toThrow();
		expect(
			createMockProjectConfig({
				pm: {
					type: 'github-projects',
					projectId: 'PVT_x',
					statusFieldId: 'PVTSSF_y',
					statusOptions: { backlog: 'opt-1' },
					phaseLabels: { 'phase-0': 'phase-0' },
				},
			}).pm,
		).toEqual({
			type: 'github-projects',
			projectId: 'PVT_x',
			statusFieldId: 'PVTSSF_y',
			statusOptions: { backlog: 'opt-1' },
			phaseLabels: { 'phase-0': 'phase-0' },
		});
	});

	it('parses Linear mappings while rejecting missing or GitHub-only fields', () => {
		const linear = createMockLinearProjectConfig();
		expect(linear.pm).toMatchObject({ type: 'linear', teamId: expect.any(String) });

		expect(() =>
			ProjectConfigSchema.parse({
				...linear,
				pm: { type: 'linear', statusOptions: { backlog: 'state-1' } },
			}),
		).toThrow();
		expect(() =>
			ProjectConfigSchema.parse({
				...linear,
				pm: {
					type: 'linear',
					teamId: 'team-1',
					statusOptions: { backlog: 'state-1' },
					projectId: 'PVT_not-linear',
				},
			}),
		).toThrow();
	});

	it('parses Jira mappings while rejecting missing or foreign fields', () => {
		const jira = createMockJiraProjectConfig();
		expect(jira.pm).toMatchObject({
			type: 'jira',
			baseUrl: 'https://example.atlassian.net',
			projectKey: 'SWARM',
		});

		expect(() =>
			ProjectConfigSchema.parse({
				...jira,
				pm: { type: 'jira', projectKey: 'SWARM', statusOptions: { backlog: '10000' } },
			}),
		).toThrow();
		expect(() =>
			ProjectConfigSchema.parse({
				...jira,
				pm: {
					type: 'jira',
					baseUrl: 'https://example.atlassian.net',
					projectKey: 'SWARM',
					statusOptions: { backlog: '10000' },
					teamId: 'not-a-jira-field',
				},
			}),
		).toThrow();
	});

	it('parses Trello mappings while rejecting missing or foreign fields', () => {
		const trello = createMockTrelloProjectConfig();
		expect(trello.pm).toMatchObject({
			type: 'trello',
			boardId: expect.any(String),
			statusOptions: expect.objectContaining({ inProgress: expect.any(String) }),
		});

		expect(() =>
			ProjectConfigSchema.parse({
				...trello,
				pm: { type: 'trello', statusOptions: { backlog: 'list-1' } },
			}),
		).toThrow();
		expect(() =>
			ProjectConfigSchema.parse({
				...trello,
				// Cascade names Trello's mapping `lists`; the SWARM member keeps the neutral
				// `statusOptions` key, so the Cascade shape is rejected rather than ignored.
				pm: { type: 'trello', boardId: 'board-1', lists: { backlog: 'list-1' } },
			}),
		).toThrow();
	});

	it('requires a credentials block, and rejects an empty reference string', () => {
		expect(() => createMockProjectConfig({ credentials: undefined as never })).toThrow();
		expect(() =>
			createMockProjectConfig({
				credentials: { reviewer: 'B', webhookSecret: '' },
			}),
		).toThrow();
		expect(() =>
			createMockProjectConfig({
				credentials: { scm: { github: { reviewer: '' } } },
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

	// Issue #628: the SCM references are per provider, and a pre-#628 config is adopted
	// onto that shape on parse so nothing has to be re-entered by hand. The manifest-facing
	// half of the validation (role names) lives in `pm-credentials.test.ts`-style suites
	// that register real manifests; this file registers none, so only the registry-free
	// rules are asserted here.
	describe('credentials.scm', () => {
		it('accepts a per-provider reference map, keeping each provider separate', () => {
			const project = createMockProjectConfig({
				scm: 'gitlab',
				credentials: {
					scm: {
						github: { reviewer: 'GH_REVIEWER', webhookSecret: 'GH_HOOK' },
						gitlab: { reviewer: 'GL_REVIEWER', webhookSecret: 'GL_HOOK' },
					},
					pm: { 'github-projects': { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' } },
				},
			});

			expect(project.credentials.scm?.github?.reviewer).toBe('GH_REVIEWER');
			expect(project.credentials.scm?.gitlab?.reviewer).toBe('GL_REVIEWER');
		});

		it('adopts a legacy shared pair under the provider the project runs on', () => {
			const project = createMockProjectConfig({
				scm: 'bitbucket',
				credentials: { reviewer: 'REV_KEY', webhookSecret: 'HOOK_KEY' },
			});

			expect(project.credentials.scm).toEqual({
				bitbucket: { reviewer: 'REV_KEY', webhookSecret: 'HOOK_KEY' },
			});
			// The legacy keys stay in place beside it — phase 1's Source Control tab reads them.
			expect(project.credentials.reviewer).toBe('REV_KEY');
		});

		it('rejects a key that is not an SCM provider id, naming the ids', () => {
			expect(() =>
				createMockProjectConfig({
					credentials: { scm: { githbu: { reviewer: 'TYPO_KEY' } } },
				}),
			).toThrow(/'githbu' is not an SCM provider id/);
		});

		/**
		 * Presence is a *resolution-time* rule, not a schema rule (see
		 * `validateScmCredentialReferences`): the dashboard's Source Control tab persists a
		 * provider switch on its own, so "selected but not yet configured" is a state one
		 * click legitimately creates. Rejecting it here would leave an operator with a config
		 * file `swarm config apply` refuses for a state the dashboard just made. This test is
		 * what keeps a parse-time presence check from being reintroduced.
		 */
		it('parses a project whose active provider has no references at all', () => {
			const project = createMockProjectConfig({
				scm: 'gitlab',
				credentials: {
					scm: { github: { reviewer: 'GH_REVIEWER' } },
					pm: { 'github-projects': { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' } },
				},
			});

			expect(project.credentials.scm?.gitlab).toBeUndefined();
		});
	});

	// Issue #631: the PM references are per provider too, and a pre-#631 flat role map is
	// nested under `pm.type` on parse. Same split as `credentials.scm` above — this file
	// registers no manifest, so only the registry-free rules are asserted here, and the
	// role-name/presence halves live in `pm-credentials.test.ts`.
	describe('credentials.pm', () => {
		it('accepts a per-provider reference map, keeping each provider separate', () => {
			const project = createMockProjectConfig({
				credentials: {
					pm: {
						'github-projects': { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' },
						jira: { email: 'JIRA_EMAIL', apiToken: 'JIRA_API_TOKEN' },
					},
				},
			});

			// The collision this shape exists to remove: one `apiToken` per provider.
			expect(project.credentials.pm?.['github-projects']?.apiToken).toBe(
				'PM_GITHUB_PROJECTS_TOKEN',
			);
			expect(project.credentials.pm?.jira?.apiToken).toBe('JIRA_API_TOKEN');
		});

		it('nests a legacy flat role map under the provider the project runs on', () => {
			const project = createMockProjectConfig({
				credentials: { pm: { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' } } as never,
			});

			expect(project.credentials.pm).toEqual({
				'github-projects': { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' },
			});
		});

		it('rejects a key that is not a PM provider id, naming the ids', () => {
			expect(() =>
				createMockProjectConfig({
					credentials: { pm: { jiar: { apiToken: 'TYPO_KEY' } } },
				}),
			).toThrow(/'jiar' is not a PM provider id/);
		});
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

	// The Tier 2 continuation budget (issue #503). Left unset here so
	// `resolveMaxContinuations` supplies the coded default — a Zod default would never
	// be seen, since the whole `pipeline` block is optional.
	it('leaves maxContinuations unset by default (read as the coded default)', () => {
		expect(PipelineConfigSchema.parse({}).maxContinuations).toBeUndefined();
	});

	it('accepts a positive integer maxContinuations', () => {
		expect(PipelineConfigSchema.parse({ maxContinuations: 4 })).toMatchObject({
			maxContinuations: 4,
		});
	});

	// Zero or a negative budget would be a silently disabled fallback rather than a
	// configured one; a fraction is a typo.
	it('rejects a non-positive or fractional maxContinuations', () => {
		expect(PipelineConfigSchema.safeParse({ maxContinuations: 0 }).success).toBe(false);
		expect(PipelineConfigSchema.safeParse({ maxContinuations: -1 }).success).toBe(false);
		expect(PipelineConfigSchema.safeParse({ maxContinuations: 1.5 }).success).toBe(false);
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
		const config = validateConfig({ projects: [createMockProjectRecord()] });
		expect(config.projects).toHaveLength(1);
	});

	it('rejects a config with no projects', () => {
		expect(() => validateConfig({ projects: [] })).toThrow();
	});

	it('rejects a non-object config', () => {
		expect(() => validateConfig(null)).toThrow();
	});

	it('is the SwarmConfigSchema parser', () => {
		expect(SwarmConfigSchema.safeParse({ projects: [createMockProjectRecord()] }).success).toBe(
			true,
		);
	});
});
