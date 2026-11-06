/**
 * Whether a project can run, item by item, and what is missing (issue #1359) — the read
 * behind `projects.readiness` and the operator MCP server's `project_readiness`.
 *
 * Each item is one thing the pipeline needs before a card is picked up, reported as
 * `ok`, `missing` (the pipeline cannot run until it is fixed) or `unverified` (it may be
 * fine, but SWARM cannot read it back — a webhook registered in the provider's own UI).
 * The project is `ready` when nothing is `missing`. Five areas:
 *
 *  - **scm** — the project names a runtime-ready provider, and the project's own
 *    reviewer credential can read each repository (the default-branch read the New
 *    Project dialog already makes). The implementer side is each worker operator's own
 *    credential (issues #765, #1249), so it is not a property of the project and is not
 *    probed here.
 *  - **pm** — the provider is registered, its required credentials are stored, every
 *    canonical status key is mapped (not the creation-time placeholder), and the mapped
 *    board answers state discovery with every mapped id still present. Discovery runs
 *    through the manifest exactly as the board-mapping screen's does
 *    (`./routers/pm.ts`), with the board read off the member by the provider's own
 *    {@link PMProviderManifest.boardContainerId}, so nothing here names a provider.
 *  - **webhooks** — the secret each served route verifies deliveries with is stored.
 *    Whether the webhook itself is registered at the provider is `unverified`: every
 *    provider's registration lives in its own UI (or, for Trello, `swarm pm webhook`),
 *    and SWARM holds no read of it. The item names the URL to register.
 *  - **workers** — for each enabled phase and each repository, at least one enrolled,
 *    connected worker that the dispatch gate's own predicate
 *    (`evaluateWorkerEligibility`) would accept for one of the phase's targets. Capacity
 *    and CLI cool-downs are ignored on purpose: a busy or cooling worker can serve the
 *    phase, just not this minute.
 *  - **members** — the project has at least one `projectAdmin`.
 *
 * Read-only. A probe that fails is reported on its item, never thrown, so one broken
 * provider does not hide the rest of the report. No secret appears in any item.
 */

import { scopeProjectToRepository } from '../config/project-repository.js';
import {
	MissingPmCredentialError,
	resolvePmCredential,
	resolveScmCredentialOrNull,
} from '../config/provider.js';
import type { ProjectConfig, ProjectRecord } from '../config/schema.js';
import { listMembersWithUsers } from '../identity/membership-service.js';
import { evaluateWorkerEligibility } from '../identity/worker-eligibility.js';
import {
	listProjectDispatchCandidates,
	type WorkerDispatchCandidate,
} from '../identity/worker-enrollment-service.js';
import { PM_WEBHOOK_SECRET_ROLE, type PMProviderManifest } from '../integrations/pm/manifest.js';
import { getPMProvider } from '../integrations/pm/registry.js';
import {
	isRuntimeReadySCMProvider,
	type SCMProviderManifest,
} from '../integrations/scm/manifest.js';
import { getSCMProvider } from '../integrations/scm/registry.js';
import { resolveWebhookCallbackBaseUrl } from '../lib/env.js';
import { describeError } from '../lib/errors.js';
import { PM_STATUS_KEYS } from '../pm/pipeline.js';
import type { TriggerPhase } from '../triggers/types.js';
import {
	PHASE_DEFAULT_CLI,
	phaseAgentConfig,
	resolveTargetPolicy,
} from '../worker/target-policy.js';
import { resolveScmDefaultBranch } from './scm-default-branch.js';

export type ReadinessArea = 'scm' | 'pm' | 'webhooks' | 'workers' | 'members';
export type ReadinessStatus = 'ok' | 'missing' | 'unverified';

export interface ReadinessItem {
	area: ReadinessArea;
	/** What was checked, e.g. `repository owner/repo` or `phase review`. */
	item: string;
	status: ReadinessStatus;
	/** What was found, and for a `missing` item what to do about it. */
	detail: string;
}

export interface ProjectReadinessReport {
	projectId: string;
	/** `true` when no item is `missing`. `unverified` items do not block it. */
	ready: boolean;
	checkedAt: string;
	items: ReadinessItem[];
}

/** Test seam: the provider reads the report makes, defaulting to the real ones. */
export interface ReadinessDeps {
	readDefaultBranch: typeof resolveScmDefaultBranch;
	listCandidates: (projectId: string) => Promise<WorkerDispatchCandidate[]>;
	listMembers: typeof listMembersWithUsers;
	callbackBaseUrl: () => string | undefined;
	now: () => Date;
}

// Each read is wrapped rather than referenced, so a module that mocks one of these
// dependencies without that export still loads this one.
const DEFAULT_DEPS: ReadinessDeps = {
	readDefaultBranch: (providerId, repo, secret) =>
		resolveScmDefaultBranch(providerId, repo, secret),
	listCandidates: (projectId) => listProjectDispatchCandidates(projectId),
	listMembers: (projectId) => listMembersWithUsers(projectId),
	callbackBaseUrl: () => resolveWebhookCallbackBaseUrl(),
	now: () => new Date(),
};

/** Check everything a project needs to run and report each item. */
export async function checkProjectReadiness(
	project: ProjectRecord,
	deps: ReadinessDeps = DEFAULT_DEPS,
): Promise<ProjectReadinessReport> {
	const scoped = scopeProjectToRepository(project);
	const scmManifest = (project.scm ? getSCMProvider(project.scm) : undefined) ?? undefined;
	const pmManifest = getPMProvider(project.pm.type) ?? undefined;
	const items: ReadinessItem[] = [
		...(await checkScm(project, scmManifest, deps)),
		...(await checkPm(scoped, pmManifest)),
		...(await checkWebhooks(scoped, scmManifest, pmManifest, deps)),
		...(await checkWorkers(project, deps)),
		...(await checkMembers(project, deps)),
	];
	return {
		projectId: project.id,
		ready: items.every((item) => item.status !== 'missing'),
		checkedAt: deps.now().toISOString(),
		items,
	};
}

async function checkScm(
	project: ProjectRecord,
	manifest: SCMProviderManifest | undefined,
	deps: ReadinessDeps,
): Promise<ReadinessItem[]> {
	if (!project.scm) {
		return [
			{
				area: 'scm',
				item: 'provider',
				status: 'missing',
				detail: 'The project names no SCM provider. Set `scm` (for example `github`).',
			},
		];
	}
	if (!manifest || !isRuntimeReadySCMProvider(manifest)) {
		return [
			{
				area: 'scm',
				item: 'provider',
				status: 'missing',
				detail: `No runtime-ready SCM provider is registered for '${project.scm}'.`,
			},
		];
	}
	const items: ReadinessItem[] = [
		{ area: 'scm', item: 'provider', status: 'ok', detail: manifest.label },
	];
	for (const { repo } of project.repositories) {
		items.push(await checkRepository(project, manifest, repo, deps));
	}
	return items;
}

async function checkRepository(
	project: ProjectRecord,
	manifest: SCMProviderManifest,
	repo: string,
	deps: ReadinessDeps,
): Promise<ReadinessItem> {
	const item = `repository ${repo}`;
	try {
		const secret = await resolveScmCredentialOrNull(
			scopeProjectToRepository(project, repo),
			manifest.id,
			'reviewer',
		);
		if (!secret) {
			return {
				area: 'scm',
				item,
				status: 'missing',
				detail: `No ${manifest.label} reviewer credential is stored for this project. Set it with \`project_credential_set\` (side \`scm\`, role \`reviewer\`) or on the Source Control tab.`,
			};
		}
		const branch = await deps.readDefaultBranch(manifest.id, repo, secret);
		if (branch === null) {
			return {
				area: 'scm',
				item,
				status: 'missing',
				detail: `The project's ${manifest.label} reviewer credential cannot read ${repo}. Check the repository coordinates and the credential's access.`,
			};
		}
		return {
			area: 'scm',
			item,
			status: 'ok',
			detail: `Readable with the reviewer credential; default branch '${branch}'.`,
		};
	} catch (error) {
		return { area: 'scm', item, status: 'missing', detail: describeError(error) };
	}
}

async function checkPm(
	project: ProjectConfig,
	manifest: PMProviderManifest | undefined,
): Promise<ReadinessItem[]> {
	if (!manifest) {
		return [
			{
				area: 'pm',
				item: 'provider',
				status: 'missing',
				detail: `No PM provider is registered for '${project.pm.type}'.`,
			},
		];
	}
	const items: ReadinessItem[] = [
		{ area: 'pm', item: 'provider', status: 'ok', detail: manifest.label },
	];

	for (const spec of manifest.credentialRoles) {
		if (spec.optional || spec.inheritsSharedCredential || spec.role === PM_WEBHOOK_SECRET_ROLE) {
			continue;
		}
		const secret = await resolvePmCredential(project, spec.role).catch(() => null);
		items.push({
			area: 'pm',
			item: `credential ${spec.role}`,
			status: secret ? 'ok' : 'missing',
			detail: secret
				? `${spec.label} is stored.`
				: `No ${spec.label} is stored. Set it with \`project_credential_set\` (side \`pm\`, role \`${spec.role}\`).`,
		});
	}

	const statusOptions: Record<string, string> = project.pm.statusOptions ?? {};
	const containerId = manifest.boardContainerId(project.pm);
	items.push(checkBoardMapping(project, manifest, containerId, statusOptions));
	if (containerId)
		items.push(await checkBoardReachable(project, manifest, containerId, statusOptions));
	return items;
}

/** Whether a board is selected and every canonical status key is mapped on it. */
function checkBoardMapping(
	project: ProjectConfig,
	manifest: PMProviderManifest,
	containerId: string | undefined,
	statusOptions: Record<string, string>,
): ReadinessItem {
	const item = 'board mapping';
	if (!containerId) {
		return {
			area: 'pm',
			item,
			status: 'missing',
			detail:
				'No board is selected — the project is still on the creation-time placeholder mapping. Discover boards with `pm_board_discover` and save one with `pm_board_set`.',
		};
	}
	if (!manifest.configSchema.safeParse(project.pm).success) {
		return {
			area: 'pm',
			item,
			status: 'missing',
			detail: `The stored ${manifest.label} mapping does not satisfy the provider's schema. Save it again with \`pm_board_set\`.`,
		};
	}
	const unmapped = PM_STATUS_KEYS.filter((key) => !statusOptions[key]);
	if (unmapped.length > 0) {
		return {
			area: 'pm',
			item,
			status: 'missing',
			detail: `Unmapped status keys: ${unmapped.join(', ')}. Map every key with \`pm_board_set\`.`,
		};
	}
	return {
		area: 'pm',
		item,
		status: 'ok',
		detail: `Board ${containerId}; every status key is mapped.`,
	};
}

async function checkBoardReachable(
	project: ProjectConfig,
	manifest: PMProviderManifest,
	containerId: string,
	statusOptions: Record<string, string>,
): Promise<ReadinessItem> {
	const item = 'board reachable';
	if (!manifest.discovery.includes('states')) {
		return {
			area: 'pm',
			item,
			status: 'unverified',
			detail: `${manifest.label} declares no state discovery, so the board cannot be probed.`,
		};
	}
	try {
		const provider = manifest.createProvider(project);
		if (!provider.discover) {
			return {
				area: 'pm',
				item,
				status: 'unverified',
				detail: `${manifest.label} implements no discovery, so the board cannot be probed.`,
			};
		}
		const { states } = await provider.discover('states', { containerId });
		const known = new Set(states.map((state) => state.id));
		const stale = Object.entries(statusOptions)
			.filter(([key, id]) => (PM_STATUS_KEYS as readonly string[]).includes(key) && !known.has(id))
			.map(([key]) => key);
		if (stale.length > 0) {
			return {
				area: 'pm',
				item,
				status: 'missing',
				detail: `The board answered, but these keys map to states it no longer has: ${stale.join(', ')}. Re-map them with \`pm_board_set\`.`,
			};
		}
		return {
			area: 'pm',
			item,
			status: 'ok',
			detail: `The board answered with ${states.length} states; every mapped state exists.`,
		};
	} catch (error) {
		return {
			area: 'pm',
			item,
			status: 'missing',
			detail:
				error instanceof MissingPmCredentialError
					? `No ${error.label} is stored, so the board cannot be read.`
					: `The board could not be read: ${describeError(error)}`,
		};
	}
}

async function checkWebhooks(
	project: ProjectConfig,
	scmManifest: SCMProviderManifest | undefined,
	pmManifest: PMProviderManifest | undefined,
	deps: ReadinessDeps,
): Promise<ReadinessItem[]> {
	const base = deps.callbackBaseUrl();
	const urlFor = (route: string) =>
		base
			? `${base}${route}`
			: `<your SWARM public URL>${route} (WEBHOOK_CALLBACK_BASE_URL is not set)`;
	const items: ReadinessItem[] = [];

	if (scmManifest && project.scm) {
		const secret = await resolveScmCredentialOrNull(project, scmManifest.id, 'webhookSecret').catch(
			() => null,
		);
		items.push(
			secret
				? {
						area: 'webhooks',
						item: `${scmManifest.id} webhook`,
						status: 'unverified',
						detail: `The webhook secret is stored. Register a ${scmManifest.label} webhook for each repository at ${urlFor(scmManifest.webhookRoute)} with that secret — SWARM cannot read the registration back.`,
					}
				: {
						area: 'webhooks',
						item: `${scmManifest.id} webhook`,
						status: 'missing',
						detail: `No ${scmManifest.label} webhook secret is stored, so every delivery to ${urlFor(scmManifest.webhookRoute)} is refused. Set it with \`project_credential_set\` (side \`scm\`, role \`webhookSecret\`).`,
					},
		);
	}

	const pmSecretSpec = pmManifest?.credentialRoles.find(
		(spec) => spec.role === PM_WEBHOOK_SECRET_ROLE,
	);
	if (pmManifest && pmSecretSpec) {
		const item = `${pmManifest.id} webhook`;
		if (pmSecretSpec.inheritsSharedCredential) {
			items.push({
				area: 'webhooks',
				item,
				status: 'unverified',
				detail: `${pmManifest.label} deliveries use the repository webhook's secret. Subscribe the webhook at ${urlFor(pmManifest.webhookRoute)} to the board's events too — SWARM cannot read the registration back.`,
			});
		} else {
			const secret = await resolvePmCredential(project, PM_WEBHOOK_SECRET_ROLE).catch(() => null);
			items.push(
				secret
					? {
							area: 'webhooks',
							item,
							status: 'unverified',
							detail: `The webhook secret is stored. Register the ${pmManifest.label} webhook at ${urlFor(pmManifest.webhookRoute)} — SWARM cannot read the registration back.`,
						}
					: {
							area: 'webhooks',
							item,
							status: 'missing',
							detail: `No ${pmManifest.label} webhook secret is stored, so board deliveries to ${urlFor(pmManifest.webhookRoute)} are refused. Set it with \`project_credential_set\` (side \`pm\`, role \`${PM_WEBHOOK_SECRET_ROLE}\`).`,
						},
			);
		}
	}
	return items;
}

/**
 * The phases a project runs: Planning, Implementation and Resolve-conflicts always, and
 * the three review-loop phases unless `pipeline` turns them off — the same
 * `enabled === false` reads their trigger handlers make.
 */
export function enabledPhases(project: Pick<ProjectRecord, 'pipeline'>): TriggerPhase[] {
	const pipeline = project.pipeline;
	return [
		'planning',
		'implementation',
		...(pipeline?.review?.enabled === false ? [] : (['review'] as const)),
		...(pipeline?.respondToReview?.enabled === false ? [] : (['respond-to-review'] as const)),
		...(pipeline?.respondToCi?.enabled === false ? [] : (['respond-to-ci'] as const)),
		'resolve-conflicts',
	];
}

async function checkWorkers(project: ProjectRecord, deps: ReadinessDeps): Promise<ReadinessItem[]> {
	const candidates = await deps.listCandidates(project.id);
	if (candidates.length === 0) {
		return [
			{
				area: 'workers',
				item: 'enrollment',
				status: 'missing',
				detail:
					'No worker is enrolled in this project. Enroll one (`swarm workers register-and-enroll`) and approve it.',
			},
		];
	}
	const scoped = scopeProjectToRepository(project);
	const items: ReadinessItem[] = [];
	for (const phase of enabledPhases(project)) {
		const { targets } = resolveTargetPolicy(phaseAgentConfig(scoped, phase));
		const clis = [...new Set(targets.map((target) => target.cli ?? PHASE_DEFAULT_CLI[phase]))];
		const unserved: string[] = [];
		const reasons = new Set<string>();
		for (const { repo } of project.repositories) {
			const served = candidates.some((candidate) =>
				targets.some((target) => {
					const verdict = evaluateWorkerEligibility({
						worker: candidate.worker,
						enrollment: candidate.enrollment,
						// Able to serve, not free this minute: capacity and cool-downs are ignored.
						availability: { connected: candidate.availability.connected, activeRuns: 0 },
						target,
						phaseDefaultCli: PHASE_DEFAULT_CLI[phase],
						phase,
						repository: repo,
						rateLimitedClis: new Map(),
					});
					if (!verdict.eligible) reasons.add(`${candidate.worker.displayName}: ${verdict.reason}`);
					return verdict.eligible;
				}),
			);
			if (!served) unserved.push(repo);
		}
		items.push(
			unserved.length === 0
				? {
						area: 'workers',
						item: `phase ${phase}`,
						status: 'ok',
						detail: `A connected, enrolled worker can run it (${clis.join(' or ')}).`,
					}
				: {
						area: 'workers',
						item: `phase ${phase}`,
						status: 'missing',
						detail: `No connected, enrolled worker can run it with ${clis.join(' or ')} for ${unserved.join(', ')}. Why each worker is refused: ${[...reasons].join('; ')}.`,
					},
		);
	}
	return items;
}

async function checkMembers(project: ProjectRecord, deps: ReadinessDeps): Promise<ReadinessItem[]> {
	const members = await deps.listMembers(project.id);
	const admins = members.filter((member) => member.role === 'projectAdmin');
	const summary = members.map((member) => `${member.identifier} (${member.role})`).join(', ');
	return [
		admins.length > 0
			? { area: 'members', item: 'roles', status: 'ok', detail: `Members: ${summary}.` }
			: {
					area: 'members',
					item: 'roles',
					status: 'missing',
					detail: `The project has no projectAdmin${members.length > 0 ? ` (members: ${summary})` : ''}. Add one with \`swarm members add\`.`,
				},
	];
}
