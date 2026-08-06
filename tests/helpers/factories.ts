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
import { resolveStatusKeyByOptionId } from '@/integrations/pm/github-projects/status-mapping.js';
import {
	type LinearIntegrationConfig,
	linearConfigSchema,
} from '@/integrations/pm/linear/config-schema.js';
import { DEFAULT_AUTOMATION_LABEL } from '@/pm/automation-label.js';
import { type PmEvent, PmEventSchema } from '@/pm/events.js';
import type { WorkItem } from '@/pm/types.js';
import {
	type PmWebhookJob,
	PmWebhookJobSchema,
	type ScmWebhookJob,
	ScmWebhookJobSchema,
} from '@/queue/jobs.js';
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

export function createMockLinearConfig(
	overrides: Partial<LinearIntegrationConfig> = {},
): LinearIntegrationConfig {
	return linearConfigSchema.parse({
		teamId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
		statusOptions: {
			backlog: '9e1a4a5f-8d0c-4ea2-a27c-8142ad0297a0',
			planning: 'f4dd18f6-7943-4a6d-9a0e-4e6cb6e3acb6',
			todo: '02f2a0de-a18d-4cef-a5e6-82bcc98d0e3e',
			inProgress: '24a31a62-af5f-449a-aa73-8e636a81e5a2',
			inReview: '34f47bf9-0d47-4cc6-af6e-7a40d2fcc430',
			done: '44a7a8b5-4c34-4668-a63e-47aa8f0fbcc5',
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
	const item: WorkItem = {
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
	// A real provider resolves `statusKey` from its board mapping on every read
	// (issue #297), so derive it here from the fixture board too — a test that
	// overrides only `statusId` still gets the matching canonical key, and one that
	// names `statusKey` explicitly keeps its value.
	//
	// `taskRef` gets the same treatment (issue #498): the GitHub Projects provider
	// resolves it from the backing Issue/PR it read, so a fixture that overrides
	// only `url` still comes back with the matching reference — and one that names
	// `taskRef` explicitly (including `undefined`, for a draft card) keeps it.
	if (!('taskRef' in overrides)) {
		item.taskRef = item.url.match(/\/(?:issues|pull)\/(\d+)(?:[/?#]|$)/)?.[1];
	}
	if ('statusKey' in overrides) return item;
	return {
		...item,
		statusKey: item.statusId
			? resolveStatusKeyByOptionId(createMockGitHubProjectsConfig(), item.statusId)
			: undefined,
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
 * A Bitbucket Cloud **REST** top-level pull-request comment, as
 * `GET /2.0/repositories/{w}/{s}/pullrequests/{id}/comments` returns each `values`
 * entry. `content.raw` is where a delivery's idempotency marker travels, so it is
 * what the marker scan reads.
 */
export function createMockBitbucketCommentResponse(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		type: 'pullrequest_comment',
		id: 118571088,
		content: { raw: 'looks good', markup: 'markdown' },
		user: bitbucketAccount('swarm-rev'),
		deleted: false,
		created_on: '2026-08-04T10:00:00.000000+00:00',
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

/** A GitLab user object as it appears in a webhook body (`user`, `reviewers[]`). */
function gitlabUser(username: string, id: number): Record<string, unknown> {
	return {
		id,
		name: username,
		username,
		avatar_url: `https://gitlab.com/uploads/-/system/user/avatar/${id}/avatar.png`,
		email: `${username}@example.com`,
	};
}

/** The GitLab `project` object every hook carries — `path_with_namespace` is what SWARM matches on. */
function gitlabProject(): Record<string, unknown> {
	return {
		id: 42,
		name: 'swarm',
		path_with_namespace: 'jkwiecien/swarm',
		web_url: 'https://gitlab.com/jkwiecien/swarm',
		default_branch: 'main',
	};
}

/** The `last_commit` object a merge request carries — GitLab reports **full** 40-character SHAs. */
function gitlabLastCommit(): Record<string, unknown> {
	return {
		id: 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7',
		message: 'Add a thing',
		url: 'https://gitlab.com/jkwiecien/swarm/-/commit/da1560886d4f094c3e6c9ef40349f7d38b5d27d7',
		author: { name: 'human-dev', email: 'human-dev@example.com' },
	};
}

/**
 * A raw GitLab `Merge Request Hook` webhook body, for driving the GitLab webhook
 * adapter. Defaults follow GitLab's own webhook-events reference — including the
 * **full 40-character** `last_commit.id`, since GitLab (unlike Bitbucket) never
 * abbreviates. Nested overrides replace the whole sub-object (shallow merge),
 * same as {@link createMockBitbucketPullRequestPayload}. Returns a plain object —
 * a webhook payload is untrusted input the adapter parses, not a validated config
 * shape.
 */
export function createMockGitLabMergeRequestPayload(
	overrides: {
		user?: Record<string, unknown>;
		objectAttributes?: Record<string, unknown>;
		project?: Record<string, unknown>;
		reviewers?: Array<Record<string, unknown>>;
		objectKind?: string;
	} = {},
): Record<string, unknown> {
	return {
		object_kind: overrides.objectKind ?? 'merge_request',
		event_type: 'merge_request',
		user: overrides.user ?? gitlabUser('human-dev', 6),
		project: overrides.project ?? gitlabProject(),
		object_attributes: {
			id: 99,
			iid: 17,
			title: 'Add a thing',
			state: 'opened',
			action: 'open',
			draft: false,
			work_in_progress: false,
			author_id: 6,
			source_branch: 'swarm/issue-17',
			target_branch: 'main',
			source_project_id: 42,
			target_project_id: 42,
			last_commit: gitlabLastCommit(),
			url: 'https://gitlab.com/jkwiecien/swarm/-/merge_requests/17',
			...overrides.objectAttributes,
		},
		reviewers: overrides.reviewers ?? [],
		labels: [],
	};
}

/**
 * A raw GitLab `Note Hook` webhook body. `noteable_type` defaults to
 * `MergeRequest` — the only target SWARM acts on — and `system` to `false`, since
 * GitLab's own bookkeeping notes are the case the adapter drops.
 */
export function createMockGitLabNotePayload(
	overrides: {
		user?: Record<string, unknown>;
		objectAttributes?: Record<string, unknown>;
		project?: Record<string, unknown>;
		mergeRequest?: Record<string, unknown> | null;
		objectKind?: string;
	} = {},
): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		object_kind: overrides.objectKind ?? 'note',
		event_type: 'note',
		user: overrides.user ?? gitlabUser('human-dev', 6),
		project: overrides.project ?? gitlabProject(),
		object_attributes: {
			id: 1244,
			note: 'can you rebase this?',
			noteable_type: 'MergeRequest',
			noteable_id: 99,
			system: false,
			author_id: 6,
			url: 'https://gitlab.com/jkwiecien/swarm/-/merge_requests/17#note_1244',
			...overrides.objectAttributes,
		},
	};
	// A note on a non-merge-request target carries no `merge_request`; pass `null`
	// to model that.
	if (overrides.mergeRequest !== null) {
		payload.merge_request = overrides.mergeRequest ?? {
			id: 99,
			iid: 17,
			title: 'Add a thing',
			state: 'opened',
			source_branch: 'swarm/issue-17',
			target_branch: 'main',
			source_project_id: 42,
			target_project_id: 42,
			last_commit: gitlabLastCommit(),
			url: 'https://gitlab.com/jkwiecien/swarm/-/merge_requests/17',
		};
	}
	return payload;
}

/**
 * A raw GitLab `Pipeline Hook` webhook body. The nested `merge_request` is what a
 * **merge-request** pipeline carries and a **branch** pipeline does not — pass
 * `null` to model the branch case the adapter leaves `workItemId` unset for.
 */
export function createMockGitLabPipelinePayload(
	overrides: {
		user?: Record<string, unknown>;
		objectAttributes?: Record<string, unknown>;
		project?: Record<string, unknown>;
		mergeRequest?: Record<string, unknown> | null;
		objectKind?: string;
	} = {},
): Record<string, unknown> {
	const payload: Record<string, unknown> = {
		object_kind: overrides.objectKind ?? 'pipeline',
		object_attributes: {
			id: 31,
			iid: 3,
			ref: 'swarm/issue-17',
			tag: false,
			sha: 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7',
			source: 'merge_request_event',
			status: 'success',
			detailed_status: 'passed',
			stages: ['test'],
			url: 'https://gitlab.com/jkwiecien/swarm/-/pipelines/31',
			...overrides.objectAttributes,
		},
		user: overrides.user ?? gitlabUser('ci-bot', 7),
		project: overrides.project ?? gitlabProject(),
		commit: { id: 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7', message: 'Add a thing' },
		builds: [],
	};
	if (overrides.mergeRequest !== null) {
		payload.merge_request = overrides.mergeRequest ?? {
			id: 99,
			iid: 17,
			title: 'Add a thing',
			source_branch: 'swarm/issue-17',
			target_branch: 'main',
			source_project_id: 42,
			target_project_id: 42,
			state: 'opened',
			url: 'https://gitlab.com/jkwiecien/swarm/-/merge_requests/17',
		};
	}
	return payload;
}

/**
 * A GitLab **REST** merge-request object, as
 * `GET /projects/:id/merge_requests/:iid` returns it — the read counterpart of
 * {@link createMockGitLabMergeRequestPayload}'s webhook body. Unlike the webhook
 * shape it names the head commit in `sha` and carries `diff_refs` (whose
 * `base_sha` is the **merge base**) and the mergeability pair
 * `merge_status`/`detailed_merge_status`. Top-level overrides are shallow-merged,
 * so passing `diff_refs` replaces the whole sub-object.
 */
export function createMockGitLabMergeRequestResponse(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: 99,
		iid: 17,
		project_id: 42,
		title: 'Add a thing',
		state: 'opened',
		draft: false,
		work_in_progress: false,
		author: gitlabUser('human-dev', 6),
		source_branch: 'swarm/issue-17',
		target_branch: 'main',
		source_project_id: 42,
		target_project_id: 42,
		sha: 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7',
		merge_status: 'can_be_merged',
		detailed_merge_status: 'mergeable',
		diff_refs: {
			base_sha: 'ce5965ddd2890b1e39d0f7b0d5b1e3f0b2c4a6d8',
			head_sha: 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7',
			start_sha: 'ce5965ddd2890b1e39d0f7b0d5b1e3f0b2c4a6d8',
		},
		web_url: 'https://gitlab.com/jkwiecien/swarm/-/merge_requests/17',
		...overrides,
	};
}

/**
 * A GitLab **REST** merge-request note, as
 * `GET /projects/:id/merge_requests/:iid/notes` returns each array entry. `body` is
 * where a delivery's idempotency marker travels, so it is what the marker scan
 * reads, and `system` distinguishes a human comment from one of GitLab's own
 * activity entries — the case the scan must skip.
 */
export function createMockGitLabNoteResponse(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: 301,
		body: 'looks good',
		author: gitlabUser('swarm-rev', 8),
		system: false,
		noteable_type: 'MergeRequest',
		noteable_iid: 17,
		resolvable: false,
		internal: false,
		created_at: '2026-08-05T10:00:00.000Z',
		updated_at: '2026-08-05T10:00:00.000Z',
		...overrides,
	};
}

/**
 * A GitLab **REST** commit status, as
 * `GET /projects/:id/repository/commits/:sha/statuses` returns each array entry.
 * `name` is what identifies a job across re-runs, so it is what the aggregate read
 * dedupes on, and `status` uses the same vocabulary a pipeline reports.
 */
export function createMockGitLabCommitStatusResponse(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		id: 91,
		name: 'unit-tests',
		status: 'success',
		ref: 'swarm/issue-17',
		sha: 'da1560886d4f094c3e6c9ef40349f7d38b5d27d7',
		allow_failure: false,
		description: null,
		target_url: 'https://gitlab.com/jkwiecien/swarm/-/jobs/91',
		author: gitlabUser('ci-bot', 7),
		created_at: '2026-08-04T10:00:00.000Z',
		started_at: '2026-08-04T10:01:00.000Z',
		finished_at: '2026-08-04T10:05:00.000Z',
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

/**
 * A normalized {@link PmEvent} (`src/pm/events.ts`) — the provider-neutral board
 * event the queue and the triggers speak. Defaults describe a Status-field edit on
 * the real board's IDs, matching what `GitHubProjectsRouterAdapter.parseWebhook`
 * produces from {@link createMockProjectsV2ItemPayload}.
 */
export function createMockPmEvent(overrides: Partial<PmEvent> = {}): PmEvent {
	return PmEventSchema.parse({
		action: 'updated',
		itemId: 'PVTI_lAHOAC3TF84BcNwDzgxczms',
		containerId: 'PVT_kwHOAC3TF84BcNwD',
		contentId: 'I_kwDONODE',
		contentType: 'Issue',
		changedField: 'PVTSSF_lAHOAC3TF84BcNwDzhW4MKo',
		changedFieldType: 'single_select',
		actorHandle: 'human-dev',
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

export function createMockPmWebhookJob(overrides: Partial<PmWebhookJob> = {}): PmWebhookJob {
	return PmWebhookJobSchema.parse({
		type: 'pm',
		providerId: 'github-projects',
		projectId: 'swarm',
		deliveryId: 'delivery-uuid-2',
		event: createMockPmEvent(),
		...overrides,
	});
}

export function createMockProjectConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
	return ProjectConfigSchema.parse({
		id: 'swarm',
		name: 'swarm',
		repo: 'SmartTechBrewery/swarm',
		repoRoot: '/Users/dev/swarm/swarm',
		// The board mapping lives under the provider that owns it (issue #495).
		pm: { type: 'github-projects', ...createMockGitHubProjectsConfig() },
		credentials: {
			reviewer: 'SCM_TOKEN_REVIEWER',
			webhookSecret: 'SCM_WEBHOOK_SECRET',
		},
		...overrides,
	});
}

export function createMockLinearProjectConfig(
	overrides: Partial<ProjectConfig> = {},
): ProjectConfig {
	return ProjectConfigSchema.parse({
		id: 'linear-project',
		name: 'linear-project',
		repo: 'SmartTechBrewery/swarm',
		repoRoot: '/Users/dev/swarm/swarm',
		pm: { type: 'linear', ...createMockLinearConfig() },
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
		operatorDeliveryProvider: unstubbed('operatorDeliveryProvider'),
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
