import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/**
 * The project readiness check (issue #1359): each area reported item by item, with a
 * `missing` item blocking `ready` and an `unverified` one not. Providers are stubs
 * registered into the real registries; credential resolution and every provider read
 * are injected, so nothing reaches a network or a database.
 */
const { resolveScmCredentialOrNull, resolvePmCredential } = vi.hoisted(() => ({
	resolveScmCredentialOrNull: vi.fn(),
	resolvePmCredential: vi.fn(),
}));
vi.mock('@/config/provider.js', async () => ({
	...(await vi.importActual<typeof import('@/config/provider.js')>('@/config/provider.js')),
	resolveScmCredentialOrNull,
	resolvePmCredential,
}));

import {
	checkProjectReadiness,
	enabledPhases,
	type ReadinessDeps,
} from '@/api/project-readiness.js';
import type { ProjectRecord } from '@/config/schema.js';
import type { WorkerDispatchCandidate } from '@/identity/worker-enrollment-service.js';
import type { PMProviderManifest } from '@/integrations/pm/manifest.js';
import {
	_resetPMProviderRegistryForTesting,
	registerPMProvider,
} from '@/integrations/pm/registry.js';
import type { SCMProviderManifest } from '@/integrations/scm/manifest.js';
import {
	_resetSCMProviderRegistryForTesting,
	registerSCMProvider,
} from '@/integrations/scm/registry.js';
import { ALL_TRIGGER_PHASES } from '@/triggers/types.js';
import { createMockProjectRecord } from '../../helpers/factories.js';

const FULL_MAPPING = {
	backlog: 'opt-backlog',
	planning: 'opt-planning',
	todo: 'opt-todo',
	inProgress: 'opt-progress',
	inReview: 'opt-review',
	done: 'opt-done',
};

let discoverStates: ReturnType<typeof vi.fn>;

function registerStubs(): void {
	_resetSCMProviderRegistryForTesting();
	registerSCMProvider({
		id: 'github',
		label: 'GitHub',
		category: 'scm',
		webhookRoute: '/github/webhook',
		credentialRoles: [
			{ role: 'reviewer', envVarKey: 'GITHUB_TOKEN_REVIEWER' },
			{ role: 'webhookSecret', envVarKey: 'GITHUB_WEBHOOK_SECRET' },
		],
	} as unknown as SCMProviderManifest);
	_resetPMProviderRegistryForTesting();
	registerPMProvider({
		id: 'github-projects',
		label: 'GitHub Projects',
		category: 'pm',
		configSchema: z.object({
			type: z.literal('github-projects'),
			projectId: z.string().min(1),
			statusFieldId: z.string().min(1),
			statusOptions: z.record(z.string(), z.string()),
		}),
		boardContainerId: (pm: ProjectRecord['pm']) =>
			(pm.type === 'github-projects' && pm.projectId) || undefined,
		credentialRoles: [
			{ role: 'apiToken', label: 'GitHub Projects API token', envVarKey: 'PM_TOKEN' },
			{
				role: 'webhookSecret',
				label: 'Webhook secret',
				envVarKey: 'GITHUB_WEBHOOK_SECRET',
				inheritsSharedCredential: 'webhookSecret',
			},
		],
		webhookRoute: '/github/webhook',
		discovery: ['containers', 'states'],
		createProvider: () => ({ discover: discoverStates }),
	} as unknown as PMProviderManifest);
}

function mappedProject(
	overrides: Parameters<typeof createMockProjectRecord>[0] = {},
): ProjectRecord {
	return createMockProjectRecord({
		id: 'p1',
		scm: 'github',
		repositories: [{ repo: 'acme/app' }],
		pm: {
			type: 'github-projects',
			projectId: 'PVT_1',
			statusFieldId: 'FIELD_1',
			statusOptions: FULL_MAPPING,
		},
		...overrides,
	});
}

function candidate(
	overrides: {
		connected?: boolean;
		clis?: string[];
		ownerPrivilege?: WorkerDispatchCandidate['ownerPrivilege'];
	} = {},
): WorkerDispatchCandidate {
	return {
		worker: {
			id: 'w1',
			displayName: 'laptop',
			capabilities: overrides.clis ?? ['claude'],
			supportedPhases: [...ALL_TRIGGER_PHASES],
			repositories: [],
			drainingSince: null,
		},
		enrollment: {
			status: 'active',
			sharingConsent: true,
			allowedClis: overrides.clis ?? ['claude'],
			allowedPhases: [...ALL_TRIGGER_PHASES],
			concurrencyAllocation: 1,
		},
		availability: { connected: overrides.connected ?? true, activeRuns: 1 },
		rateLimitedClis: new Map(),
		ownerPrivilege: overrides.ownerPrivilege ?? 'projectAdmin',
	} as unknown as WorkerDispatchCandidate;
}

function deps(overrides: Partial<ReadinessDeps> = {}): ReadinessDeps {
	return {
		readDefaultBranch: vi.fn().mockResolvedValue('main'),
		listCandidates: vi.fn().mockResolvedValue([candidate()]),
		listMembers: vi
			.fn()
			.mockResolvedValue([
				{ userId: 'u1', identifier: 'ada@example.com', displayName: 'Ada', role: 'projectAdmin' },
			]),
		callbackBaseUrl: () => 'https://swarm.example.com',
		now: () => new Date('2026-11-06T12:00:00Z'),
		...overrides,
	};
}

function itemsOf(report: Awaited<ReturnType<typeof checkProjectReadiness>>, area: string) {
	return report.items.filter((item) => item.area === area);
}

beforeEach(() => {
	registerStubs();
	discoverStates = vi.fn().mockResolvedValue({
		states: Object.values(FULL_MAPPING).map((id) => ({ id, name: id })),
	});
	resolveScmCredentialOrNull.mockReset().mockResolvedValue('stored');
	resolvePmCredential.mockReset().mockResolvedValue('stored');
});

describe('checkProjectReadiness', () => {
	it('is ready when every item is ok or merely unverified, and never returns a secret', async () => {
		resolveScmCredentialOrNull.mockResolvedValue('super-secret-token');
		const report = await checkProjectReadiness(mappedProject(), deps());

		expect(report.ready).toBe(true);
		expect(report.items.filter((item) => item.status === 'missing')).toEqual([]);
		expect(itemsOf(report, 'webhooks').every((item) => item.status === 'unverified')).toBe(true);
		expect(itemsOf(report, 'webhooks')[0]?.detail).toContain(
			'https://swarm.example.com/github/webhook',
		);
		expect(discoverStates).toHaveBeenCalledWith('states', { containerId: 'PVT_1' });
		expect(JSON.stringify(report)).not.toContain('super-secret-token');
	});

	it('reports the creation-time placeholder board as missing, and does not probe it', async () => {
		const report = await checkProjectReadiness(
			{
				// Spread past the schema, which refuses the placeholder exactly as a persisted mapping would.
				...mappedProject(),
				pm: { type: 'github-projects', projectId: '', statusFieldId: '', statusOptions: {} },
			},
			deps(),
		);

		expect(report.ready).toBe(false);
		expect(itemsOf(report, 'pm').find((item) => item.item === 'board mapping')).toMatchObject({
			status: 'missing',
		});
		expect(discoverStates).not.toHaveBeenCalled();
	});

	it('names unmapped status keys and mapped ids the board no longer has', async () => {
		const { done: _done, ...partial } = FULL_MAPPING;
		discoverStates.mockResolvedValue({ states: [{ id: 'opt-backlog', name: 'Backlog' }] });
		const report = await checkProjectReadiness(
			mappedProject({
				pm: {
					type: 'github-projects',
					projectId: 'PVT_1',
					statusFieldId: 'FIELD_1',
					statusOptions: partial,
				},
			}),
			deps(),
		);

		const pm = itemsOf(report, 'pm');
		expect(pm.find((item) => item.item === 'board mapping')?.detail).toContain('done');
		expect(pm.find((item) => item.item === 'board reachable')).toMatchObject({ status: 'missing' });
		expect(pm.find((item) => item.item === 'board reachable')?.detail).toContain('planning');
	});

	it('reports a board that cannot be read as missing rather than throwing', async () => {
		discoverStates.mockRejectedValue(new Error('Bad credentials'));
		const report = await checkProjectReadiness(mappedProject(), deps());

		expect(itemsOf(report, 'pm').find((item) => item.item === 'board reachable')).toMatchObject({
			status: 'missing',
			detail: expect.stringContaining('Bad credentials'),
		});
	});

	it('reports a missing reviewer credential and an unreadable repository per repository', async () => {
		resolveScmCredentialOrNull.mockImplementation(async (project: { repo: string }, _id, role) =>
			role === 'reviewer' && project.repo === 'acme/app' ? null : 'stored',
		);
		const report = await checkProjectReadiness(
			mappedProject({ repositories: [{ repo: 'acme/app' }, { repo: 'acme/api' }] }),
			deps({ readDefaultBranch: vi.fn().mockResolvedValue(null) }),
		);

		const scm = itemsOf(report, 'scm');
		expect(scm.find((item) => item.item === 'repository acme/app')?.detail).toContain(
			'No GitHub reviewer credential',
		);
		expect(scm.find((item) => item.item === 'repository acme/api')?.detail).toContain(
			'cannot read acme/api',
		);
		expect(report.ready).toBe(false);
	});

	it('reports a missing PM credential and a missing webhook secret', async () => {
		resolvePmCredential.mockResolvedValue(null);
		resolveScmCredentialOrNull.mockImplementation(async (_project, _id, role) =>
			role === 'webhookSecret' ? null : 'stored',
		);
		const report = await checkProjectReadiness(mappedProject(), deps());

		expect(itemsOf(report, 'pm').find((item) => item.item === 'credential apiToken')).toMatchObject(
			{
				status: 'missing',
			},
		);
		expect(
			itemsOf(report, 'webhooks').find((item) => item.item === 'github webhook'),
		).toMatchObject({ status: 'missing' });
	});

	it('counts a busy worker as able to serve, but not a disconnected one or one without the CLI', async () => {
		const busy = await checkProjectReadiness(mappedProject(), deps());
		expect(itemsOf(busy, 'workers').every((item) => item.status === 'ok')).toBe(true);

		const offline = await checkProjectReadiness(
			mappedProject(),
			deps({ listCandidates: vi.fn().mockResolvedValue([candidate({ connected: false })]) }),
		);
		expect(itemsOf(offline, 'workers').every((item) => item.status === 'missing')).toBe(true);
		expect(itemsOf(offline, 'workers')[0]?.detail).toContain('laptop: worker-unavailable');

		const noCli = await checkProjectReadiness(
			mappedProject({ agents: { review: { targets: [{ cli: 'codex' }] } } }),
			deps(),
		);
		expect(itemsOf(noCli, 'workers').find((item) => item.item === 'phase review')).toMatchObject({
			status: 'missing',
			detail: expect.stringContaining('codex'),
		});
		expect(itemsOf(noCli, 'workers').find((item) => item.item === 'phase planning')?.status).toBe(
			'ok',
		);
	});

	// Issue #1419: Resolve problem runs only on a worker owned by a project or
	// installation administrator, and readiness says so in plain words.
	it('does not count a member-owned worker as serving Resolve problem', async () => {
		const project = () => mappedProject({ pipeline: { resolveProblem: { enabled: true } } });
		const phaseItem = (report: Awaited<ReturnType<typeof checkProjectReadiness>>, phase: string) =>
			itemsOf(report, 'workers').find((item) => item.item === `phase ${phase}`);

		const memberOwned = await checkProjectReadiness(
			project(),
			deps({
				listCandidates: vi.fn().mockResolvedValue([candidate({ ownerPrivilege: 'none' })]),
			}),
		);
		expect(phaseItem(memberOwned, 'resolve-problem')).toMatchObject({
			status: 'missing',
			detail: expect.stringContaining(
				'laptop: owner is not a project or installation administrator (Resolve problem needs one)',
			),
		});
		expect(phaseItem(memberOwned, 'implementation')?.status).toBe('ok');

		const instanceOwned = await checkProjectReadiness(
			project(),
			deps({
				listCandidates: vi.fn().mockResolvedValue([candidate({ ownerPrivilege: 'instanceAdmin' })]),
			}),
		);
		expect(phaseItem(instanceOwned, 'resolve-problem')?.status).toBe('ok');
	});

	it('reports a project with no enrolled worker and one with no projectAdmin', async () => {
		const report = await checkProjectReadiness(
			mappedProject(),
			deps({
				listCandidates: vi.fn().mockResolvedValue([]),
				listMembers: vi.fn().mockResolvedValue([]),
			}),
		);

		expect(itemsOf(report, 'workers')).toEqual([
			expect.objectContaining({ item: 'enrollment', status: 'missing' }),
		]);
		expect(itemsOf(report, 'members')).toEqual([
			expect.objectContaining({ item: 'roles', status: 'missing' }),
		]);
	});
});

describe('enabledPhases', () => {
	it('drops only the review-loop phases a pipeline turns off', () => {
		expect(enabledPhases({ pipeline: undefined })).toEqual(
			ALL_TRIGGER_PHASES.filter((phase) => phase !== 'resolve-problem'),
		);
		expect(
			enabledPhases({
				pipeline: { review: { enabled: false }, respondToReview: { enabled: false } },
			}),
		).toEqual(['planning', 'implementation', 'respond-to-ci', 'resolve-conflicts']);
	});

	it('runs Resolve problem only when the project turns it on (issue #1395)', () => {
		expect(enabledPhases({ pipeline: undefined })).not.toContain('resolve-problem');
		expect(enabledPhases({ pipeline: { resolveProblem: { enabled: true } } })).toEqual([
			...ALL_TRIGGER_PHASES,
		]);
	});
});
