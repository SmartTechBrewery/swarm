import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db/repositories/credentialsRepository.js', () => ({
	resolveAllProjectCredentials: vi.fn(),
	writeProjectCredential: vi.fn(),
	deleteProjectCredential: vi.fn(),
}));

vi.mock('@/db/repositories/projectsRepository.js', () => ({
	getProjectByIdFromDb: vi.fn(),
	// The PM procedures persist the `credentials.pm` role → reference map through the
	// project row (issue #537).
	upsertProjectToDb: vi.fn(),
}));

vi.mock('@/identity/membership-service.js', () => ({
	getMembership: vi.fn(),
	listAccessibleProjectIds: vi.fn(),
}));

// Registers the real PM *and* SCM manifests, so the procedures below resolve the roles
// GitHub Projects and each SCM provider actually declare rather than a stub's.
import '@/integrations/entrypoint.js';
import { credentialsRouter } from '@/api/routers/credentials.js';
import {
	deleteProjectCredential,
	resolveAllProjectCredentials,
	writeProjectCredential,
} from '@/db/repositories/credentialsRepository.js';
import { getProjectByIdFromDb, upsertProjectToDb } from '@/db/repositories/projectsRepository.js';
import type { ProjectMembership, ProjectRole } from '@/identity/membership.js';
import { getMembership } from '@/identity/membership-service.js';
import type { SwarmUser } from '@/identity/schema.js';
import { createMockProjectConfig } from '../../../helpers/factories.js';

const ADMIN_USER: SwarmUser = {
	id: '00000000-0000-4000-8000-000000000000',
	identifier: 'tester@example.com',
	displayName: 'Tester',
	instanceAdmin: true,
	createdAt: new Date(0),
	updatedAt: new Date(0),
};

const ORDINARY_USER: SwarmUser = {
	id: '00000000-0000-4000-8000-0000000000ff',
	identifier: 'member@example.com',
	displayName: 'Member',
	instanceAdmin: false,
	createdAt: new Date(0),
	updatedAt: new Date(0),
};

function membershipFor(role: ProjectRole): ProjectMembership {
	return {
		id: '99999999-9999-4999-8999-999999999999',
		projectId: 'p1',
		userId: ORDINARY_USER.id,
		role,
		createdAt: new Date(0),
	};
}

describe('credentialsRouter', () => {
	const AUTHED_USER = ADMIN_USER;
	const caller = credentialsRouter.createCaller({ user: AUTHED_USER });

	beforeEach(() => {
		vi.mocked(getProjectByIdFromDb).mockReset();
		vi.mocked(resolveAllProjectCredentials).mockReset();
		vi.mocked(writeProjectCredential).mockReset();
		vi.mocked(deleteProjectCredential).mockReset();
		vi.mocked(getMembership).mockReset();
	});

	// The SCM half (issue #632): addressed by `(providerId, role)` exactly as the PM half
	// is, with the store key resolved server-side, so one provider's credentials can
	// neither hide nor overwrite another's.
	describe('list', () => {
		// No `scm`, and a legacy pair adopted into `credentials.scm.github` — so its
		// references are the neutral post-#290 names, which is the *common* case of a
		// reference diverging from the manifest's conventional `envVarKey`.
		const project = createMockProjectConfig({ id: 'p1' });

		/** A project carrying both providers' references, running on GitHub. */
		function twoProviderProject() {
			return createMockProjectConfig({
				id: 'p1',
				scm: 'github',
				credentials: {
					scm: {
						github: { reviewer: 'SCM_TOKEN_REVIEWER', webhookSecret: 'SCM_WEBHOOK_SECRET' },
						gitlab: { reviewer: 'GITLAB_TOKEN_REVIEWER' },
					},
					pm: { 'github-projects': { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' } },
				},
			});
		}

		it('masks a long configured value to the same fixed marker, with no secret characters in the response', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({
				SCM_TOKEN_REVIEWER: 'test-token-reviewer',
			});

			const result = await caller.list({ projectId: 'p1' });
			const raw = JSON.stringify(result);

			expect(raw).not.toContain('test-token-reviewer');
			expect(raw).not.toContain('1234');

			const entry = result.roles.find((r) => r.role === 'reviewer');
			expect(entry).toEqual({
				role: 'reviewer',
				// The provider's conventional key and the key this project actually resolves
				// through are both reported, and they legitimately differ.
				envVarKey: 'GITHUB_TOKEN_REVIEWER',
				referenceKey: 'SCM_TOKEN_REVIEWER',
				isConfigured: true,
				maskedValue: '****',
			});
		});

		it('masks a short configured value to the identical fixed marker as a long one', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({
				SCM_TOKEN_REVIEWER: 'short',
			});

			const result = await caller.list({ projectId: 'p1' });
			const entry = result.roles.find((r) => r.role === 'reviewer');
			expect(entry?.maskedValue).toBe('****');
		});

		it('resolves a project still storing a legacy GitHub-named reference, unmigrated', async () => {
			const legacyProject = createMockProjectConfig({
				id: 'p1',
				credentials: {
					reviewer: 'GITHUB_TOKEN_REVIEWER',
					webhookSecret: 'GITHUB_WEBHOOK_SECRET',
					pm: { 'github-projects': { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' } },
				},
			});
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(legacyProject);
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({
				GITHUB_TOKEN_REVIEWER: 'test-token-reviewer',
			});

			const result = await caller.list({ projectId: 'p1' });
			expect(result.roles.find((r) => r.role === 'reviewer')).toEqual({
				role: 'reviewer',
				envVarKey: 'GITHUB_TOKEN_REVIEWER',
				referenceKey: 'GITHUB_TOKEN_REVIEWER',
				isConfigured: true,
				maskedValue: '****',
			});
		});

		it('reports an unconfigured slot as isConfigured: false, maskedValue: "not set"', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({});

			const result = await caller.list({ projectId: 'p1' });
			expect(result.roles.find((r) => r.role === 'reviewer')).toEqual({
				role: 'reviewer',
				envVarKey: 'GITHUB_TOKEN_REVIEWER',
				referenceKey: 'SCM_TOKEN_REVIEWER',
				isConfigured: false,
				maskedValue: 'not set',
			});
		});

		it('returns one entry per role the provider declares, in the manifest’s order (implementer is not project-scoped)', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({});

			const result = await caller.list({ projectId: 'p1' });
			expect(result.roles.map((r) => r.role)).toEqual(['reviewer', 'webhookSecret']);
			expect(result).toMatchObject({
				providerId: 'github',
				providerLabel: 'GitHub',
				providerRegistered: true,
			});
		});

		it('defaults to the provider the project runs on', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(
				createMockProjectConfig({
					id: 'p1',
					scm: 'gitlab',
					credentials: {
						scm: {
							github: { reviewer: 'GH_REVIEWER', webhookSecret: 'GH_HOOK' },
							gitlab: { reviewer: 'GL_REVIEWER', webhookSecret: 'GL_HOOK' },
						},
						pm: { 'github-projects': { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' } },
					},
				}),
			);
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({ GL_REVIEWER: 'gitlab-token' });

			const result = await caller.list({ projectId: 'p1' });
			expect(result.providerId).toBe('gitlab');
			expect(result.roles).toEqual([
				{
					role: 'reviewer',
					envVarKey: 'GITLAB_TOKEN_REVIEWER',
					referenceKey: 'GL_REVIEWER',
					isConfigured: true,
					maskedValue: '****',
				},
				{
					role: 'webhookSecret',
					envVarKey: 'GITLAB_WEBHOOK_SECRET',
					referenceKey: 'GL_HOOK',
					isConfigured: false,
					maskedValue: 'not set',
				},
			]);
		});

		// The read half of the reported symptom: selecting a provider with nothing saved
		// must show *its* empty state under *its* own reference names, while the provider
		// that is configured keeps reporting configured.
		it('reports a provider with nothing saved as unconfigured without disturbing the other’s state', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(twoProviderProject());
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({
				SCM_TOKEN_REVIEWER: 'github-reviewer',
				SCM_WEBHOOK_SECRET: 'github-hook',
			});

			const bitbucket = await caller.list({ projectId: 'p1', providerId: 'bitbucket' });
			expect(bitbucket.providerId).toBe('bitbucket');
			expect(bitbucket.roles).toEqual([
				{
					role: 'reviewer',
					envVarKey: 'BITBUCKET_TOKEN_REVIEWER',
					referenceKey: 'BITBUCKET_TOKEN_REVIEWER',
					isConfigured: false,
					maskedValue: 'not set',
				},
				{
					role: 'webhookSecret',
					envVarKey: 'BITBUCKET_WEBHOOK_SECRET',
					referenceKey: 'BITBUCKET_WEBHOOK_SECRET',
					isConfigured: false,
					maskedValue: 'not set',
				},
			]);

			const github = await caller.list({ projectId: 'p1', providerId: 'github' });
			expect(github.roles.every((role) => role.isConfigured)).toBe(true);
		});

		// The dashboard's provider catalogue is a hand-kept browser list, so it can name a
		// provider this installation has not registered. The tab renders its own
		// "not available" state from this rather than an error boundary.
		it('reports an unregistered provider as unregistered with no roles', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({});

			const result = await caller.list({ projectId: 'p1', providerId: 'gerrit' });
			expect(result).toEqual({
				providerId: 'gerrit',
				providerLabel: 'gerrit',
				providerRegistered: false,
				roles: [],
			});
		});

		it('throws NOT_FOUND for an unknown project without resolving credentials', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(undefined);

			await expect(caller.list({ projectId: 'missing' })).rejects.toThrowError(
				expect.objectContaining({
					code: 'NOT_FOUND',
					message: 'Project with ID "missing" not found',
				}),
			);
			expect(resolveAllProjectCredentials).not.toHaveBeenCalled();
		});
	});

	describe('set', () => {
		const project = createMockProjectConfig({ id: 'p1' });

		it("stores the secret under the project's own reference for that provider and role", async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(writeProjectCredential).mockResolvedValue(undefined);

			await caller.set({
				projectId: 'p1',
				providerId: 'github',
				role: 'reviewer',
				value: 'secret',
			});

			// The adopted reference, not the manifest's conventional `GITHUB_TOKEN_REVIEWER`:
			// rewriting the key would point the project at a `project_credentials` row that
			// does not exist.
			expect(writeProjectCredential).toHaveBeenCalledWith(
				'p1',
				'SCM_TOKEN_REVIEWER',
				'secret',
				null,
			);
			// The reference is unchanged, so the project row is left alone.
			expect(upsertProjectToDb).not.toHaveBeenCalled();
		});

		// The criterion test for issue #632: the reported failure was a silent in-place
		// overwrite, because the browser chose the store key.
		it('leaves another provider’s stored secret untouched, writing this provider’s own key', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(writeProjectCredential).mockResolvedValue(undefined);

			await caller.set({
				projectId: 'p1',
				providerId: 'gitlab',
				role: 'reviewer',
				value: 'glpat-secret',
			});

			expect(writeProjectCredential).toHaveBeenCalledWith(
				'p1',
				'GITLAB_TOKEN_REVIEWER',
				'glpat-secret',
				null,
			);
			expect(writeProjectCredential).not.toHaveBeenCalledWith(
				'p1',
				'SCM_TOKEN_REVIEWER',
				expect.anything(),
				expect.anything(),
			);
			// GitHub's block survives verbatim beside the new GitLab one, so switching back
			// finds the same references (and therefore the same stored secrets).
			expect(upsertProjectToDb).toHaveBeenCalledWith(
				expect.objectContaining({
					credentials: expect.objectContaining({
						scm: {
							github: { reviewer: 'SCM_TOKEN_REVIEWER', webhookSecret: 'SCM_WEBHOOK_SECRET' },
							gitlab: { reviewer: 'GITLAB_TOKEN_REVIEWER' },
						},
					}),
				}),
			);
		});

		it('refuses a role the provider does not declare, without writing', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);

			await expect(
				caller.set({ projectId: 'p1', providerId: 'github', role: 'apiToken', value: 'ghp' }),
			).rejects.toThrowError(
				expect.objectContaining({
					code: 'BAD_REQUEST',
					message: expect.stringContaining("declares no credential role 'apiToken'"),
				}),
			);
			expect(writeProjectCredential).not.toHaveBeenCalled();
		});

		it('refuses a provider nothing runtime-ready is registered for, without writing', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);

			await expect(
				caller.set({ projectId: 'p1', providerId: 'gerrit', role: 'reviewer', value: 'secret' }),
			).rejects.toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
			expect(writeProjectCredential).not.toHaveBeenCalled();
		});

		it('rejects an empty value before touching the repository', async () => {
			await expect(
				caller.set({ projectId: 'p1', providerId: 'github', role: 'reviewer', value: '' }),
			).rejects.toThrow();
			expect(writeProjectCredential).not.toHaveBeenCalled();
			expect(getProjectByIdFromDb).not.toHaveBeenCalled();
		});

		it('throws NOT_FOUND for an unknown project without writing', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(undefined);

			await expect(
				caller.set({
					projectId: 'missing',
					providerId: 'github',
					role: 'reviewer',
					value: 'secret',
				}),
			).rejects.toThrowError(
				expect.objectContaining({
					code: 'NOT_FOUND',
					message: 'Project with ID "missing" not found',
				}),
			);
			expect(writeProjectCredential).not.toHaveBeenCalled();
		});
	});

	describe('delete', () => {
		it('clears only the named provider’s row and reference', async () => {
			const project = createMockProjectConfig({
				id: 'p1',
				scm: 'github',
				credentials: {
					scm: {
						github: { reviewer: 'SCM_TOKEN_REVIEWER', webhookSecret: 'SCM_WEBHOOK_SECRET' },
						gitlab: { reviewer: 'GITLAB_TOKEN_REVIEWER' },
					},
					pm: { 'github-projects': { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' } },
				},
			});
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(deleteProjectCredential).mockResolvedValue(undefined);

			await caller.delete({ projectId: 'p1', providerId: 'gitlab', role: 'reviewer' });

			expect(deleteProjectCredential).toHaveBeenCalledWith('p1', 'GITLAB_TOKEN_REVIEWER');
			expect(deleteProjectCredential).toHaveBeenCalledTimes(1);
			// GitLab's block empties and drops out; GitHub's is untouched.
			expect(upsertProjectToDb).toHaveBeenCalledWith(
				expect.objectContaining({
					credentials: expect.objectContaining({
						scm: {
							github: { reviewer: 'SCM_TOKEN_REVIEWER', webhookSecret: 'SCM_WEBHOOK_SECRET' },
						},
					}),
				}),
			);
		});

		it('keeps the provider’s remaining role when only one is cleared', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(createMockProjectConfig({ id: 'p1' }));
			vi.mocked(deleteProjectCredential).mockResolvedValue(undefined);

			await caller.delete({ projectId: 'p1', providerId: 'github', role: 'reviewer' });

			expect(deleteProjectCredential).toHaveBeenCalledWith('p1', 'SCM_TOKEN_REVIEWER');
			expect(upsertProjectToDb).toHaveBeenCalledWith(
				expect.objectContaining({
					credentials: expect.objectContaining({
						scm: { github: { webhookSecret: 'SCM_WEBHOOK_SECRET' } },
					}),
				}),
			);
		});

		it('throws NOT_FOUND for an unknown project without deleting', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(undefined);

			await expect(
				caller.delete({ projectId: 'missing', providerId: 'github', role: 'reviewer' }),
			).rejects.toThrowError(
				expect.objectContaining({
					code: 'NOT_FOUND',
					message: 'Project with ID "missing" not found',
				}),
			);
			expect(deleteProjectCredential).not.toHaveBeenCalled();
		});
	});

	// The PM half (issue #537): the roles come from the project's PM provider manifest,
	// the client names a role rather than a store key, and no secret is ever returned.
	describe('listPm', () => {
		const project = createMockProjectConfig({ id: 'p1' });

		it("returns the provider's declared roles with their configured state", async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({
				PM_GITHUB_PROJECTS_TOKEN: 'ghp_board_token',
			});

			const result = await caller.listPm({ projectId: 'p1' });

			expect(result.providerId).toBe('github-projects');
			expect(result.providerLabel).toBe('GitHub Projects');
			expect(result.providerRegistered).toBe(true);
			expect(JSON.stringify(result)).not.toContain('ghp_board_token');
			expect(result.roles).toContainEqual(
				expect.objectContaining({
					role: 'apiToken',
					label: 'GitHub Projects API Token',
					envVarKey: 'PM_GITHUB_PROJECTS_TOKEN',
					referenceKey: 'PM_GITHUB_PROJECTS_TOKEN',
					optional: false,
					isConfigured: true,
					maskedValue: '****',
				}),
			);
		});

		it('reports an inherited role against the shared reference it resolves through', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({ SCM_WEBHOOK_SECRET: 'whsec' });

			const result = await caller.listPm({ projectId: 'p1' });
			const webhook = result.roles.find((role) => role.role === 'webhookSecret');

			expect(webhook).toMatchObject({
				inheritsSharedCredential: 'webhookSecret',
				referenceKey: 'SCM_WEBHOOK_SECRET',
				isConfigured: true,
			});
		});

		it('reports an unconfigured role as not set', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({});

			const result = await caller.listPm({ projectId: 'p1' });
			const apiToken = result.roles.find((role) => role.role === 'apiToken');

			expect(apiToken).toMatchObject({ isConfigured: false, maskedValue: 'not set' });
		});

		// An empty stored row is what `resolvePmCredential` treats as absent, so
		// reporting it as configured would have the panel claim the board is set up
		// while every board call answers "no credential configured".
		it('reports an empty stored value as not configured', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({ PM_GITHUB_PROJECTS_TOKEN: '' });

			const result = await caller.listPm({ projectId: 'p1' });
			const apiToken = result.roles.find((role) => role.role === 'apiToken');

			expect(apiToken).toMatchObject({ isConfigured: false, maskedValue: 'not set' });
		});

		it('throws NOT_FOUND for an unknown project', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(undefined);

			await expect(caller.listPm({ projectId: 'missing' })).rejects.toThrowError(
				expect.objectContaining({ code: 'NOT_FOUND' }),
			);
		});

		// Issue #641: the switch flow shows the *incoming* provider's roles, and shows them
		// as unconfigured, which is what tells an operator what still has to be entered.
		it('answers for a provider the project is not persisted on', async () => {
			const project = createMockProjectConfig({ id: 'p1' });
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({
				PM_GITHUB_PROJECTS_TOKEN: 'ghp_board_token',
			});

			const result = await caller.listPm({ projectId: 'p1', providerId: 'jira' });

			expect(result.providerId).toBe('jira');
			expect(result.providerLabel).toBe('Jira');
			expect(result.providerRegistered).toBe(true);
			expect(result.roles.map((role) => role.role)).toEqual(['email', 'apiToken', 'webhookSecret']);
			// Jira's `apiToken` and GitHub Projects' collide by name; reading Jira's must not
			// report the GitHub Projects secret as its own.
			expect(result.roles.find((role) => role.role === 'apiToken')).toMatchObject({
				referenceKey: 'JIRA_API_TOKEN',
				isConfigured: false,
				maskedValue: 'not set',
			});
		});

		it("reads the named provider's own retained references", async () => {
			const twoBoards = createMockProjectConfig({
				id: 'p1',
				credentials: {
					reviewer: 'SCM_TOKEN_REVIEWER',
					webhookSecret: 'SCM_WEBHOOK_SECRET',
					pm: {
						'github-projects': { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' },
						jira: { apiToken: 'CUSTOM_JIRA_TOKEN' },
					},
				},
			});
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(twoBoards);
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({ CUSTOM_JIRA_TOKEN: 'jira_pat' });

			const result = await caller.listPm({ projectId: 'p1', providerId: 'jira' });

			expect(result.roles.find((role) => role.role === 'apiToken')).toMatchObject({
				referenceKey: 'CUSTOM_JIRA_TOKEN',
				isConfigured: true,
			});
			expect(JSON.stringify(result)).not.toContain('jira_pat');
		});
	});

	describe('setPm', () => {
		it("stores the secret under the role's declared key and records the reference", async () => {
			// A project row with no `credentials.pm` at all: the dashboard-only setup path,
			// and every project persisted before #537 (DB reads don't re-validate, so this
			// state is reachable and must be fixable from the UI). Assembled rather than
			// parsed, because `ProjectConfigSchema` now rejects it.
			const project = {
				...createMockProjectConfig({ id: 'p1' }),
				credentials: { reviewer: 'SCM_TOKEN_REVIEWER', webhookSecret: 'SCM_WEBHOOK_SECRET' },
			};
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);

			await caller.setPm({ projectId: 'p1', role: 'apiToken', value: 'ghp_board_token' });

			expect(writeProjectCredential).toHaveBeenCalledWith(
				'p1',
				'PM_GITHUB_PROJECTS_TOKEN',
				'ghp_board_token',
				'GitHub Projects API Token',
			);
			expect(upsertProjectToDb).toHaveBeenCalledWith(
				expect.objectContaining({
					credentials: expect.objectContaining({
						pm: { 'github-projects': { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' } },
					}),
				}),
			);
		});

		// The reason `credentials.pm` is per provider (issue #631): the role names collide
		// across providers, so a write scoped to the current one is what stops a retained
		// provider's configuration being destroyed by an identically-named role.
		it("writes into its own provider's block and leaves another provider's intact", async () => {
			const twoBoards = createMockProjectConfig({
				id: 'p1',
				credentials: {
					reviewer: 'SCM_TOKEN_REVIEWER',
					webhookSecret: 'SCM_WEBHOOK_SECRET',
					pm: {
						'github-projects': { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' },
						jira: { email: 'JIRA_EMAIL', apiToken: 'JIRA_API_TOKEN' },
					},
				},
			});
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(twoBoards);

			await caller.setPm({ projectId: 'p1', role: 'apiToken', value: 'ghp_rotated' });

			expect(writeProjectCredential).toHaveBeenCalledWith(
				'p1',
				'PM_GITHUB_PROJECTS_TOKEN',
				'ghp_rotated',
				'GitHub Projects API Token',
			);
			// The reference itself was unchanged, so the row is not rewritten — and Jira's
			// block is therefore untouched by construction.
			expect(upsertProjectToDb).not.toHaveBeenCalled();
		});

		it("adds a role to its own provider's block without disturbing another's", async () => {
			// Assembled rather than parsed: GitHub Projects' `apiToken` is deliberately
			// absent so the write has something to add, which `ProjectConfigSchema` rejects.
			const project = {
				...createMockProjectConfig({ id: 'p1' }),
				credentials: {
					reviewer: 'SCM_TOKEN_REVIEWER',
					webhookSecret: 'SCM_WEBHOOK_SECRET',
					pm: { jira: { email: 'JIRA_EMAIL', apiToken: 'JIRA_API_TOKEN' } },
				},
			};
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);

			await caller.setPm({ projectId: 'p1', role: 'apiToken', value: 'ghp_board_token' });

			expect(upsertProjectToDb).toHaveBeenCalledWith(
				expect.objectContaining({
					credentials: expect.objectContaining({
						pm: {
							'github-projects': { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' },
							jira: { email: 'JIRA_EMAIL', apiToken: 'JIRA_API_TOKEN' },
						},
					}),
				}),
			);
		});

		it("replaces the value at the project's existing reference without rewriting the row", async () => {
			const project = createMockProjectConfig({
				id: 'p1',
				credentials: {
					reviewer: 'SCM_TOKEN_REVIEWER',
					webhookSecret: 'SCM_WEBHOOK_SECRET',
					pm: { 'github-projects': { apiToken: 'CUSTOM_BOARD_TOKEN' } },
				},
			});
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);

			await caller.setPm({ projectId: 'p1', role: 'apiToken', value: 'ghp_new' });

			expect(writeProjectCredential).toHaveBeenCalledWith(
				'p1',
				'CUSTOM_BOARD_TOKEN',
				'ghp_new',
				'GitHub Projects API Token',
			);
			expect(upsertProjectToDb).not.toHaveBeenCalled();
		});

		// The role *is* the shared SCM webhook secret (declared as data on the manifest),
		// so writing it here would fork one secret into two places.
		it('refuses a role that inherits a shared SCM credential, saying where it lives', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(createMockProjectConfig({ id: 'p1' }));

			await expect(
				caller.setPm({ projectId: 'p1', role: 'webhookSecret', value: 'whsec' }),
			).rejects.toThrowError(
				expect.objectContaining({
					code: 'BAD_REQUEST',
					message: expect.stringContaining('Source Control tab'),
				}),
			);
			expect(writeProjectCredential).not.toHaveBeenCalled();
		});

		it('refuses a role the provider does not declare', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(createMockProjectConfig({ id: 'p1' }));

			await expect(
				caller.setPm({ projectId: 'p1', role: 'apiKey', value: 'lin_api' }),
			).rejects.toThrowError(
				expect.objectContaining({
					code: 'BAD_REQUEST',
					message: expect.stringContaining("declares no credential role 'apiKey'"),
				}),
			);
			expect(writeProjectCredential).not.toHaveBeenCalled();
		});

		it('throws NOT_FOUND for an unknown project without writing', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(undefined);

			await expect(
				caller.setPm({ projectId: 'missing', role: 'apiToken', value: 'ghp' }),
			).rejects.toThrowError(expect.objectContaining({ code: 'NOT_FOUND' }));
			expect(writeProjectCredential).not.toHaveBeenCalled();
		});

		// Issue #641: entering the incoming provider's credentials is the *first* step of a
		// provider switch, so it happens while the project still runs on the outgoing one.
		describe('for a provider the project is not persisted on', () => {
			it("writes into the named provider's block and leaves the persisted one's intact", async () => {
				const project = createMockProjectConfig({ id: 'p1' });
				vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);

				await caller.setPm({
					projectId: 'p1',
					providerId: 'jira',
					role: 'apiToken',
					value: 'jira_pat',
				});

				// Jira's own conventional key, not GitHub Projects' — the role names collide,
				// and writing the persisted provider's reference would destroy its secret.
				expect(writeProjectCredential).toHaveBeenCalledWith(
					'p1',
					'JIRA_API_TOKEN',
					'jira_pat',
					'API Token',
				);
				expect(writeProjectCredential).toHaveBeenCalledOnce();
				expect(upsertProjectToDb).toHaveBeenCalledWith(
					expect.objectContaining({
						credentials: expect.objectContaining({
							pm: {
								'github-projects': { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' },
								jira: { apiToken: 'JIRA_API_TOKEN' },
							},
						}),
					}),
				);
				// The `pm` member itself is untouched: this phase persists no switch.
				expect(upsertProjectToDb).toHaveBeenCalledWith(expect.objectContaining({ pm: project.pm }));
			});

			it('refuses a role the named provider does not declare', async () => {
				vi.mocked(getProjectByIdFromDb).mockResolvedValue(createMockProjectConfig({ id: 'p1' }));

				// `apiKey` is Linear's and Trello's, never Jira's — validating against the
				// persisted provider instead would have accepted, or rejected, the wrong list.
				await expect(
					caller.setPm({ projectId: 'p1', providerId: 'jira', role: 'apiKey', value: 'x' }),
				).rejects.toThrowError(
					expect.objectContaining({
						code: 'BAD_REQUEST',
						message: expect.stringContaining("'jira' declares no credential role 'apiKey'"),
					}),
				);
				expect(writeProjectCredential).not.toHaveBeenCalled();
			});

			// Only GitHub Projects declares an inherited role, so the refusal is a property of
			// the provider being configured rather than of the one the project runs on.
			it("accepts the named provider's own webhook secret, which inherits nothing", async () => {
				vi.mocked(getProjectByIdFromDb).mockResolvedValue(createMockProjectConfig({ id: 'p1' }));

				await caller.setPm({
					projectId: 'p1',
					providerId: 'jira',
					role: 'webhookSecret',
					value: 'whsec_jira',
				});

				expect(writeProjectCredential).toHaveBeenCalledWith(
					'p1',
					'JIRA_WEBHOOK_SECRET',
					'whsec_jira',
					'Webhook Secret',
				);
			});
		});
	});

	describe('deletePm', () => {
		it('clears the stored secret and drops the reference so nothing ambient resolves', async () => {
			const project = createMockProjectConfig({ id: 'p1' });
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(project);

			await caller.deletePm({ projectId: 'p1', role: 'apiToken' });

			expect(deleteProjectCredential).toHaveBeenCalledWith('p1', 'PM_GITHUB_PROJECTS_TOKEN');
			// The emptied provider block is pruned rather than persisted as `{}` (issue #631).
			expect(upsertProjectToDb).toHaveBeenCalledWith(
				expect.objectContaining({ credentials: expect.objectContaining({ pm: {} }) }),
			);
		});

		it("removes only that role and keeps another provider's block", async () => {
			const twoBoards = createMockProjectConfig({
				id: 'p1',
				credentials: {
					reviewer: 'SCM_TOKEN_REVIEWER',
					webhookSecret: 'SCM_WEBHOOK_SECRET',
					pm: {
						'github-projects': { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' },
						jira: { email: 'JIRA_EMAIL', apiToken: 'JIRA_API_TOKEN' },
					},
				},
			});
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(twoBoards);

			await caller.deletePm({ projectId: 'p1', role: 'apiToken' });

			expect(deleteProjectCredential).toHaveBeenCalledWith('p1', 'PM_GITHUB_PROJECTS_TOKEN');
			expect(upsertProjectToDb).toHaveBeenCalledWith(
				expect.objectContaining({
					credentials: expect.objectContaining({
						pm: { jira: { email: 'JIRA_EMAIL', apiToken: 'JIRA_API_TOKEN' } },
					}),
				}),
			);
		});

		it('refuses to clear an inherited role', async () => {
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(createMockProjectConfig({ id: 'p1' }));

			await expect(
				caller.deletePm({ projectId: 'p1', role: 'webhookSecret' }),
			).rejects.toThrowError(expect.objectContaining({ code: 'BAD_REQUEST' }));
			expect(deleteProjectCredential).not.toHaveBeenCalled();
		});

		// Issue #641: abandoning a switch has to be able to clear what was entered for the
		// incoming provider without touching what the project is actually running on.
		it('prunes only the named provider’s block when it is not the persisted one', async () => {
			const twoBoards = createMockProjectConfig({
				id: 'p1',
				credentials: {
					reviewer: 'SCM_TOKEN_REVIEWER',
					webhookSecret: 'SCM_WEBHOOK_SECRET',
					pm: {
						'github-projects': { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' },
						jira: { apiToken: 'JIRA_API_TOKEN' },
					},
				},
			});
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(twoBoards);

			await caller.deletePm({ projectId: 'p1', providerId: 'jira', role: 'apiToken' });

			expect(deleteProjectCredential).toHaveBeenCalledWith('p1', 'JIRA_API_TOKEN');
			expect(deleteProjectCredential).toHaveBeenCalledOnce();
			expect(upsertProjectToDb).toHaveBeenCalledWith(
				expect.objectContaining({
					credentials: expect.objectContaining({
						pm: { 'github-projects': { apiToken: 'PM_GITHUB_PROJECTS_TOKEN' } },
					}),
				}),
			);
		});
	});

	// Reading the masked list needs `contributor`; writing or clearing a
	// credential is `projectAdmin`-only (#281 task 4).
	describe('project-scoped authorization', () => {
		const ordinary = credentialsRouter.createCaller({ user: ORDINARY_USER });

		it('denies a non-member list with NOT_FOUND without resolving credentials', async () => {
			vi.mocked(getMembership).mockResolvedValue(undefined);

			await expect(ordinary.list({ projectId: 'p1' })).rejects.toThrowError(
				expect.objectContaining({ code: 'NOT_FOUND' }),
			);
			expect(getProjectByIdFromDb).not.toHaveBeenCalled();
			expect(resolveAllProjectCredentials).not.toHaveBeenCalled();
		});

		it('lets a contributor read the masked list', async () => {
			vi.mocked(getMembership).mockResolvedValue(membershipFor('contributor'));
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(createMockProjectConfig({ id: 'p1' }));
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({});

			await expect(ordinary.list({ projectId: 'p1' })).resolves.toMatchObject({
				providerId: 'github',
			});
		});

		it('forbids a member from setting a credential', async () => {
			vi.mocked(getMembership).mockResolvedValue(membershipFor('member'));

			await expect(
				ordinary.set({
					projectId: 'p1',
					providerId: 'github',
					role: 'reviewer',
					value: 'secret',
				}),
			).rejects.toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
			expect(writeProjectCredential).not.toHaveBeenCalled();
		});

		it('lets a projectAdmin set a credential', async () => {
			vi.mocked(getMembership).mockResolvedValue(membershipFor('projectAdmin'));
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(createMockProjectConfig({ id: 'p1' }));
			vi.mocked(writeProjectCredential).mockResolvedValue(undefined);

			await ordinary.set({
				projectId: 'p1',
				providerId: 'github',
				role: 'reviewer',
				value: 'secret',
			});
			expect(writeProjectCredential).toHaveBeenCalledWith(
				'p1',
				'SCM_TOKEN_REVIEWER',
				'secret',
				null,
			);
		});

		it('forbids a contributor from deleting a credential', async () => {
			vi.mocked(getMembership).mockResolvedValue(membershipFor('contributor'));

			await expect(
				ordinary.delete({ projectId: 'p1', providerId: 'github', role: 'reviewer' }),
			).rejects.toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
			expect(deleteProjectCredential).not.toHaveBeenCalled();
		});

		// The PM procedures sit on the same boundary: a contributor may read the masked
		// role list, only a projectAdmin may write or clear one.
		it('lets a contributor read the PM role list', async () => {
			vi.mocked(getMembership).mockResolvedValue(membershipFor('contributor'));
			vi.mocked(getProjectByIdFromDb).mockResolvedValue(createMockProjectConfig({ id: 'p1' }));
			vi.mocked(resolveAllProjectCredentials).mockResolvedValue({});

			await expect(ordinary.listPm({ projectId: 'p1' })).resolves.toMatchObject({
				providerId: 'github-projects',
			});
		});

		it('forbids a contributor from setting or clearing a PM credential', async () => {
			vi.mocked(getMembership).mockResolvedValue(membershipFor('contributor'));

			await expect(
				ordinary.setPm({ projectId: 'p1', role: 'apiToken', value: 'ghp' }),
			).rejects.toThrowError(expect.objectContaining({ code: 'FORBIDDEN' }));
			await expect(ordinary.deletePm({ projectId: 'p1', role: 'apiToken' })).rejects.toThrowError(
				expect.objectContaining({ code: 'FORBIDDEN' }),
			);
			expect(writeProjectCredential).not.toHaveBeenCalled();
			expect(deleteProjectCredential).not.toHaveBeenCalled();
		});
	});
});
