/**
 * Test data factories — sensible defaults + `Partial<T>` overrides, mirroring
 * Cascade's `tests/helpers/factories.ts` (ai/TESTING.md "Test data"). Prefer
 * these over hand-constructing the same fixture object inline in every test.
 *
 * Each factory returns a *validated* object (run through its Zod schema, so
 * defaults are applied) — tests exercising invalid input build raw objects
 * directly instead.
 */

import { type ProjectConfig, ProjectConfigSchema } from '@/config/schema.js';
import type { RunAgentCliOptions } from '@/harness/agent-cli.js';
import {
	type GitHubProjectsIntegrationConfig,
	githubProjectsConfigSchema,
} from '@/integrations/pm/github-projects/config-schema.js';
import { DEFAULT_AUTOMATION_LABEL } from '@/pm/automation-label.js';
import type { WorkItem } from '@/pm/types.js';
import {
	type GitHubProjectsWebhookJob,
	GitHubProjectsWebhookJobSchema,
	type ScmWebhookJob,
	ScmWebhookJobSchema,
} from '@/queue/jobs.js';
import {
	type GitHubProjectsParsedEvent,
	GitHubProjectsParsedEventSchema,
} from '@/router/adapters/github-projects.js';
import { type ScmEvent, ScmEventSchema } from '@/scm/events.js';
import type { SCMProvider } from '@/scm/types.js';
import type { BuildTaskAssignmentInput } from '@/transport/assignment.js';
import type { TriggerContext } from '@/triggers/types.js';

/**
 * `runAgentCli` options with the two required fields defaulted. `RunAgentCliOptions`
 * is a plain interface (not a boundary-crossing config), so this returns a raw
 * object rather than parsing through a schema.
 */
export function createMockRunAgentCliOptions(
	overrides: Partial<RunAgentCliOptions> = {},
): RunAgentCliOptions {
	return {
		cli: 'claude',
		cwd: '/wt',
		...overrides,
	};
}

export function createMockGitHubProjectsConfig(
	overrides: Partial<GitHubProjectsIntegrationConfig> = {},
): GitHubProjectsIntegrationConfig {
	return githubProjectsConfigSchema.parse({
		projectId: 'PVT_kwHOAC3TF84BcNwD',
		statusFieldId: 'PVTSSF_lAHOAC3TF84BcNwDzhW4MKo',
		// Keys are the canonical PM_STATUS_KEYS (src/pm/pipeline.ts); values are the
		// real board's Status option IDs (ai/RULES.md §5). `61e4505c` is Planning,
		// `3121a97d` is ToDo — mapping them to their matching canonical keys keeps
		// the fixture faithful to the board so the Planning trigger resolves.
		statusOptions: {
			backlog: 'f75ad846',
			planning: '61e4505c',
			todo: '3121a97d',
			inProgress: '47fc9ee4',
			inReview: 'df73e18b',
			done: '98236657',
		},
		...overrides,
	});
}

/**
 * A `WorkItem` fixture. Unlike the config factories above there's no Zod schema
 * to parse through — `WorkItem` is a provider-agnostic interface (`src/pm/types.ts`),
 * not a boundary-crossing config shape — so this returns a plain object.
 *
 * It carries the default automation label (issue #131) because the real board
 * does: every item SWARM works on is opted in, so a fixture without it would be
 * the unusual case, and every dispatch-level test would be gated out.
 */
export function createMockWorkItem(overrides: Partial<WorkItem> = {}): WorkItem {
	return {
		id: 'PVTI_lAHOAC3TF84BcNwDzgxczms',
		title: 'Example work item',
		description: 'An example work item body.',
		url: 'https://github.com/SmartTechBrewery/swarm/issues/10',
		status: 'In progress',
		statusId: '47fc9ee4',
		labels: [{ id: 'LA_swarm', name: DEFAULT_AUTOMATION_LABEL }],
		assignees: [],
		...overrides,
	};
}

/**
 * A raw `projects_v2_item` webhook body (the shape GitHub delivers, per
 * docs/github-projects-v2-api.md §5), for driving the PM router adapter /
 * receiver. Defaults describe a Status-field edit on the real board's IDs; pass
 * a partial `changes` / `projects_v2_item` to exercise other actions. Returns a
 * plain object — a webhook payload is untrusted input the adapter parses, not a
 * validated config shape.
 */
export function createMockProjectsV2ItemPayload(
	overrides: {
		action?: string;
		projectsV2Item?: Record<string, unknown>;
		changes?: Record<string, unknown> | null;
		sender?: Record<string, unknown>;
	} = {},
): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		action: overrides.action ?? 'edited',
		projects_v2_item: {
			node_id: 'PVTI_lAHOAC3TF84BcNwDzgxczms',
			project_node_id: 'PVT_kwHOAC3TF84BcNwD',
			content_node_id: 'I_kwDONODE',
			content_type: 'Issue',
			creator: { login: 'human-dev' },
			created_at: '2026-07-02T00:00:00Z',
			updated_at: '2026-07-02T00:00:00Z',
			archived_at: null,
			...overrides.projectsV2Item,
		},
		sender: overrides.sender ?? { login: 'human-dev' },
	};
	// `changes` is present on `edited` events; allow callers to drop it (e.g. for
	// a `created` event) by passing `null`.
	if (overrides.changes !== null) {
		payload.changes = overrides.changes ?? {
			field_value: {
				field_node_id: 'PVTSSF_lAHOAC3TF84BcNwDzhW4MKo',
				field_type: 'single_select',
			},
		};
	}
	return payload;
}

/** A Bitbucket `Account` object as it appears in a webhook body. */
function bitbucketAccount(nickname: string): Record<string, unknown> {
	return {
		nickname,
		display_name: nickname,
		uuid: `{uuid-${nickname}}`,
		account_id: `account-${nickname}`,
	};
}

/**
 * A raw Bitbucket Cloud `pullrequest:*` webhook body, for driving the Bitbucket
 * webhook adapter. Defaults follow Atlassian's own event-payload reference —
 * including its **12-character** `source.commit.hash`, which is the abbreviated-hash
 * invariant `src/integrations/scm/bitbucket/webhook.ts` documents. Nested
 * overrides replace the whole sub-object (shallow merge), same as
 * {@link createMockProjectsV2ItemPayload}. Returns a plain object — a webhook
 * payload is untrusted input the adapter parses, not a validated config shape.
 */
export function createMockBitbucketPullRequestPayload(
	overrides: {
		actor?: Record<string, unknown>;
		pullrequest?: Record<string, unknown>;
		repository?: Record<string, unknown>;
	} = {},
): Record<string, unknown> {
	return {
		actor: overrides.actor ?? bitbucketAccount('human-dev'),
		pullrequest: {
			id: 17,
			title: 'Add a thing',
			state: 'OPEN',
			draft: false,
			author: bitbucketAccount('human-dev'),
			source: {
				branch: { name: 'swarm/issue-17' },
				commit: { hash: 'd3022fc0ca3d' },
				repository: { full_name: 'jkwiecien/swarm' },
			},
			destination: {
				branch: { name: 'main' },
				commit: { hash: 'ce5965ddd289' },
				repository: { full_name: 'jkwiecien/swarm' },
			},
			links: { html: { href: 'https://bitbucket.org/jkwiecien/swarm/pull-requests/17' } },
			...overrides.pullrequest,
		},
		repository: overrides.repository ?? { full_name: 'jkwiecien/swarm' },
	};
}

/**
 * A Bitbucket review-verdict webhook body — a pull-request payload plus the
 * `{ date, user }` verdict wrapper. `verdictKey` picks the wrapper Bitbucket uses
 * for the event under test: `approval` for `pullrequest:approved` /
 * `:unapproved`, `changes_request` for the `changes_request_*` pair. The verdict's
 * user doubles as the event `actor` by default, which is what Bitbucket sends.
 */
export function createMockBitbucketApprovalPayload(
	overrides: {
		actor?: Record<string, unknown>;
		pullrequest?: Record<string, unknown>;
		repository?: Record<string, unknown>;
		verdictKey?: 'approval' | 'changes_request';
		user?: Record<string, unknown>;
	} = {},
): Record<string, unknown> {
	const { verdictKey = 'approval', user, ...prOverrides } = overrides;
	const verdictUser = user ?? bitbucketAccount('swarm-rev');
	return {
		...createMockBitbucketPullRequestPayload({ actor: verdictUser, ...prOverrides }),
		[verdictKey]: { date: '2026-08-04T10:00:00.000000+00:00', user: verdictUser },
	};
}

/**
 * A raw Bitbucket `repo:commit_status_*` webhook body. Note what it does *not*
 * carry: no `pullrequest`, and no `commit_status.commit` — the commit is named
 * only by `links.commit.href`, whose last segment is the **full** 40-character
 * SHA (unlike a PR payload's abbreviated one).
 */
export function createMockBitbucketCommitStatusPayload(
	overrides: {
		actor?: Record<string, unknown>;
		commitStatus?: Record<string, unknown>;
		repository?: Record<string, unknown>;
	} = {},
): Record<string, unknown> {
	return {
		actor: overrides.actor ?? bitbucketAccount('ci-bot'),
		repository: overrides.repository ?? { full_name: 'jkwiecien/swarm' },
		commit_status: {
			name: 'Unit Tests',
			description: 'All tests passed',
			state: 'SUCCESSFUL',
			key: 'mybuildtool',
			type: 'build',
			url: 'https://my-build-tool.com/builds/MY-PROJECT/BUILD-792',
			links: {
				commit: {
					href: 'https://api.bitbucket.org/2.0/repositories/jkwiecien/swarm/commit/d3022fc0ca3d65c7f6654eea129d6bf0cf0ee08e',
				},
			},
			...overrides.commitStatus,
		},
	};
}

/**
 * A Bitbucket Cloud **REST** pull-request object, as
 * `GET /2.0/repositories/{w}/{s}/pullrequests/{id}` returns it — the read
 * counterpart of {@link createMockBitbucketPullRequestPayload}'s webhook body.
 * Unlike the webhook shape it carries `participants` (Bitbucket's stand-in for
 * reviews) and no `actor`. Top-level overrides are shallow-merged, so passing
 * `source` replaces the whole sub-object.
 */
export function createMockBitbucketPullRequestResponse(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: 17,
		title: 'Add a thing',
		state: 'OPEN',
		draft: false,
		author: bitbucketAccount('human-dev'),
		source: {
			branch: { name: 'swarm/issue-17' },
			commit: { hash: 'd3022fc0ca3d' },
			repository: { full_name: 'jkwiecien/swarm' },
		},
		destination: {
			branch: { name: 'main' },
			commit: { hash: 'ce5965ddd289' },
			repository: { full_name: 'jkwiecien/swarm' },
		},
		participants: [],
		links: { html: { href: 'https://bitbucket.org/jkwiecien/swarm/pull-requests/17' } },
		...overrides,
	};
}

/**
 * A Bitbucket Cloud **REST** commit build status, as
 * `GET /2.0/repositories/{w}/{s}/commit/{sha}/statuses` returns each `values`
 * entry. `key` is what identifies a build definition across re-runs, so it is what
 * the aggregate read dedupes on.
 */
export function createMockBitbucketBuildStatusResponse(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		type: 'build',
		key: 'UNIT-TESTS',
		name: 'Unit Tests',
		state: 'SUCCESSFUL',
		description: 'All tests passed',
		url: 'https://my-build-tool.com/builds/MY-PROJECT/BUILD-792',
		created_on: '2026-08-04T10:00:00.000000+00:00',
		updated_on: '2026-08-04T10:05:00.000000+00:00',
		...overrides,
	};
}

export function createMockScmEvent(overrides: Partial<ScmEvent> = {}): ScmEvent {
	return ScmEventSchema.parse({
		kind: 'pull-request',
		action: 'opened',
		repoFullName: 'SmartTechBrewery/swarm',
		workItemId: '17',
		actorLogin: 'human-dev',
		isCommentEvent: false,
		...overrides,
	});
}

export function createMockGitHubProjectsParsedEvent(
	overrides: Partial<GitHubProjectsParsedEvent> = {},
): GitHubProjectsParsedEvent {
	return GitHubProjectsParsedEventSchema.parse({
		eventType: 'projects_v2_item',
		action: 'edited',
		itemNodeId: 'PVTI_lAHOAC3TF84BcNwDzgxczms',
		projectNodeId: 'PVT_kwHOAC3TF84BcNwD',
		contentNodeId: 'I_kwDONODE',
		contentType: 'Issue',
		changedFieldNodeId: 'PVTSSF_lAHOAC3TF84BcNwDzhW4MKo',
		changedFieldType: 'single_select',
		actorLogin: 'human-dev',
		...overrides,
	});
}

export function createMockScmWebhookJob(overrides: Partial<ScmWebhookJob> = {}): ScmWebhookJob {
	return ScmWebhookJobSchema.parse({
		type: 'scm',
		providerId: 'github',
		projectId: 'swarm',
		deliveryId: 'delivery-uuid-1',
		event: createMockScmEvent(),
		...overrides,
	});
}

export function createMockGitHubProjectsWebhookJob(
	overrides: Partial<GitHubProjectsWebhookJob> = {},
): GitHubProjectsWebhookJob {
	return GitHubProjectsWebhookJobSchema.parse({
		type: 'github-projects',
		projectId: 'swarm',
		deliveryId: 'delivery-uuid-2',
		event: createMockGitHubProjectsParsedEvent(),
		...overrides,
	});
}

export function createMockProjectConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
	return ProjectConfigSchema.parse({
		id: 'swarm',
		name: 'swarm',
		repo: 'SmartTechBrewery/swarm',
		repoRoot: '/Users/dev/swarm/swarm',
		githubProjects: createMockGitHubProjectsConfig(),
		credentials: {
			reviewer: 'SCM_TOKEN_REVIEWER',
			webhookSecret: 'SCM_WEBHOOK_SECRET',
		},
		...overrides,
	});
}

/**
 * A `buildTaskAssignment` input (`src/transport/assignment.ts`). Defaults to a
 * planning-phase assignment carrying a `workItem`; pass a `phase` + `pr` (and
 * drop `workItem`) via overrides to exercise the SCM-driven phases. Returns a
 * plain object — `BuildTaskAssignmentInput` is an interface, not a schema shape
 * — and carries the FULL project config so a test can assert the builder strips
 * its `credentials`.
 */
export function createMockTaskAssignmentInput(
	overrides: Partial<BuildTaskAssignmentInput> = {},
): BuildTaskAssignmentInput {
	return {
		dispatchId: '44444444-4444-4444-8444-444444444444',
		project: createMockProjectConfig(),
		phase: 'planning',
		taskId: '17',
		targetBranch: 'issue-17',
		systemPrompt: 'You are the SWARM planning agent. Do the thing.',
		target: { cli: 'claude' },
		workItem: createMockWorkItem(),
		...overrides,
	};
}

/**
 * A typed fake {@link SCMProvider} for the trigger handlers, which reach every
 * source-control operation through `ctx.scm` (`src/triggers/types.ts`). Each
 * method throws by default, so a handler that calls an operation the test didn't
 * stub fails loudly instead of silently seeing `undefined`; override exactly the
 * ones under test.
 *
 * Prefer this over `vi.mock`ing the GitHub integration: it is the contract, so a
 * handler that reaches around it (importing a concrete provider) no longer
 * type-checks.
 */
export function createFakeScmProvider(overrides: Partial<SCMProvider> = {}): SCMProvider {
	const unstubbed = (name: string) => () => {
		throw new Error(`createFakeScmProvider: unstubbed SCMProvider.${name}() call`);
	};
	return {
		type: 'github',
		category: 'scm',
		hasIntegration: unstubbed('hasIntegration'),
		hasPersonaToken: unstubbed('hasPersonaToken'),
		withPersonaCredentials: unstubbed('withPersonaCredentials'),
		resolvePersonaIdentities: unstubbed('resolvePersonaIdentities'),
		personaForActor: unstubbed('personaForActor'),
		isSwarmActor: unstubbed('isSwarmActor'),
		verifyWebhookSignature: unstubbed('verifyWebhookSignature'),
		readWebhookRequest: unstubbed('readWebhookRequest'),
		parseWebhookEvent: unstubbed('parseWebhookEvent'),
		isSwarmGeneratedEvent: unstubbed('isSwarmGeneratedEvent'),
		getPullRequest: unstubbed('getPullRequest'),
		getPullRequestTitle: unstubbed('getPullRequestTitle'),
		getAggregateCheckStatus: unstubbed('getAggregateCheckStatus'),
		listConflictCandidates: unstubbed('listConflictCandidates'),
		commentOnPullRequest: unstubbed('commentOnPullRequest'),
		mergePullRequest: unstubbed('mergePullRequest'),
		deliveryProvider: unstubbed('deliveryProvider'),
		...overrides,
	};
}

/**
 * An SCM {@link TriggerContext} — the shape `buildTriggerContext`
 * (`src/worker/consumer.ts`) hands a handler, with a fake provider attached.
 * Pass `scm` to stub the operations the handler under test performs.
 */
export function createMockScmTriggerContext(
	overrides: Partial<Extract<TriggerContext, { source: 'scm' }>> = {},
): Extract<TriggerContext, { source: 'scm' }> {
	return {
		project: createMockProjectConfig(),
		source: 'scm',
		providerId: 'github',
		event: createMockScmEvent(),
		scm: createFakeScmProvider(),
		...overrides,
	};
}
