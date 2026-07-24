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
	type GitHubWebhookJob,
	GitHubWebhookJobSchema,
} from '@/queue/jobs.js';
import { type GitHubParsedEvent, GitHubParsedEventSchema } from '@/router/adapters/github.js';
import {
	type GitHubProjectsParsedEvent,
	GitHubProjectsParsedEventSchema,
} from '@/router/adapters/github-projects.js';
import type { BuildTaskAssignmentInput } from '@/transport/assignment.js';

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
		url: 'https://github.com/jkwiecien/swarm/issues/10',
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

export function createMockGitHubParsedEvent(
	overrides: Partial<GitHubParsedEvent> = {},
): GitHubParsedEvent {
	return GitHubParsedEventSchema.parse({
		eventType: 'pull_request',
		action: 'opened',
		repoFullName: 'jkwiecien/swarm',
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

export function createMockGitHubWebhookJob(
	overrides: Partial<GitHubWebhookJob> = {},
): GitHubWebhookJob {
	return GitHubWebhookJobSchema.parse({
		type: 'github',
		projectId: 'swarm',
		deliveryId: 'delivery-uuid-1',
		event: createMockGitHubParsedEvent(),
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
		repo: 'jkwiecien/swarm',
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
