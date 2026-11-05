/**
 * The provider-neutral read of a pull request an agent reviews or answers
 * (issue #1239) — its title, description, branches, URL and discussion — and the
 * Markdown file SWARM renders it into for the agent.
 *
 * Reading the pull request is SWARM's job, not the agent's. The Review agent used
 * to read it with `gh pr view` / `gh pr diff`, which only GitHub answers, so on any
 * other provider the agent could read nothing, wrote no hand-off, and the run
 * reported that consequence instead of the cause. Each provider now answers
 * `ScmDeliveryProvider.readPullRequestContext` (`./delivery.ts`) in this one shape,
 * the phase renders it to {@link PULL_REQUEST_CONTEXT_FILENAME} at the worktree
 * root before the agent starts, and the prompt points at that file — so every
 * provider is read the same way, and an unreadable pull request fails the run
 * before the agent does.
 *
 * Respond-to-review reuses this module (issue #1240): it also reads the one
 * submitted review it answers through `ScmDeliveryProvider.readReview` and
 * renders it into the same file, as a "Review being answered" section ahead of
 * the discussion, so its agent reads the review through SWARM too.
 *
 * Plain interfaces rather than Zod schemas, like `PullRequestDetails`
 * (`./types.ts`): nothing here crosses the wire. Keep the exports stable.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The scratch file the pull request is rendered into, at the worktree root. It is
 * SWARM's *input* to the agent, not a hand-off, so it is registered in
 * `SCRATCH_PATHSPECS` (`./delivery.ts`) — which keeps it out of every commit and
 * out of the dirty-worktree check — but not in `HANDOFF_FILENAMES`.
 */
export const PULL_REQUEST_CONTEXT_FILENAME = 'swarm_pull_request.md';

/** A top-level comment, a submitted review, or a comment anchored to a file. */
export type PullRequestDiscussionKind = 'comment' | 'review' | 'review-comment';

/** One entry of a pull request's discussion, in no provider's vocabulary. */
export interface PullRequestDiscussionEntry {
	kind: PullRequestDiscussionKind;
	/** The provider's display handle for the author, or `null` when it names none. */
	author: string | null;
	/** ISO-8601, or `null` when the provider reports no date. */
	createdAt: string | null;
	body: string;
	/** `review` entries only: the `ScmReviewState` spelling where it maps, verbatim otherwise. */
	reviewState?: string;
	/** File-anchored entries: the repository-relative path. */
	path?: string;
	line?: number;
}

/** A pull request as the agent reads it. */
export interface PullRequestContext {
	number: number;
	title: string;
	description: string;
	baseBranch: string;
	headBranch: string;
	url: string;
	discussion: PullRequestDiscussionEntry[];
	/**
	 * Provider-authored instruction for reading an issue the pull request references
	 * (GitHub: `gh issue view`), rendered verbatim. Absent when the provider offers
	 * none — the agent is then told no way to read one, rather than a wrong one.
	 */
	issueReadHint?: string;
}

/** The one submitted review a Respond-to-review run answers (issue #1240). */
export interface PullRequestReview {
	/** The id the run was dispatched with, verbatim (numeric on GitHub, synthetic on Azure DevOps). */
	id: string;
	/** The provider's display handle for the reviewer, or `null` when it names none. */
	author: string | null;
	/** The `ScmReviewState` spelling where it maps, verbatim otherwise; `null` when unknown. */
	state: string | null;
	/** ISO-8601, or `null` when the provider reports no date. */
	submittedAt: string | null;
	/** The review's summary body. */
	body: string;
	/** The review's file-anchored comments: `review-comment` entries carrying `path`/`line`. */
	comments: PullRequestDiscussionEntry[];
}

/**
 * A provider that has no reader for this yet — a declared gap with its own
 * follow-up, reported as the run's failure reason rather than as a missing hand-off.
 */
export class ScmReadUnsupportedError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = 'ScmReadUnsupportedError';
	}
}

/**
 * The `readPullRequestContext` a provider without a reader declares. Worded "not
 * yet supported" on purpose: the SCM conformance suite reads a "not implemented"
 * method body as a stub, and this is a stated gap, not a stub.
 */
export function unsupportedPullRequestContextRead(
	providerLabel: string,
): (prNumber: number) => Promise<PullRequestContext> {
	return async () => {
		throw new ScmReadUnsupportedError(
			`reading a pull request's context is not yet supported on ${providerLabel}`,
		);
	};
}

/** The `readReview` a provider without a reader declares; worded like {@link unsupportedPullRequestContextRead}. */
export function unsupportedReviewRead(
	providerLabel: string,
): (prNumber: number, reviewId: string) => Promise<PullRequestReview> {
	return async () => {
		throw new ScmReadUnsupportedError(
			`reading a pull request review is not yet supported on ${providerLabel}`,
		);
	};
}

/**
 * The discussion in chronological order, undated entries last. Stable, so entries
 * a provider reports with the same timestamp keep the order it listed them in.
 * Sorted here so no provider has to.
 */
function chronological(entries: PullRequestDiscussionEntry[]): PullRequestDiscussionEntry[] {
	return entries
		.map((entry, index) => ({
			entry,
			index,
			at: entry.createdAt ? Date.parse(entry.createdAt) : NaN,
		}))
		.sort((a, b) => {
			const aDated = !Number.isNaN(a.at);
			const bDated = !Number.isNaN(b.at);
			if (aDated && bDated && a.at !== b.at) return a.at - b.at;
			if (aDated !== bDated) return aDated ? -1 : 1;
			return a.index - b.index;
		})
		.map(({ entry }) => entry);
}

function entryHeading(entry: PullRequestDiscussionEntry): string {
	const location = entry.path
		? `${entry.path}${entry.line !== undefined ? `:${entry.line}` : ''}`
		: '';
	let label: string;
	if (entry.kind === 'review')
		label = entry.reviewState ? `Review (${entry.reviewState})` : 'Review';
	else if (entry.kind === 'review-comment')
		label = location ? `Comment on ${location}` : 'Review comment';
	else label = 'Comment';
	return `### ${label} by ${entry.author ?? 'unknown'} · ${entry.createdAt ?? 'undated'}`;
}

/** The "Review being answered" section, ahead of the discussion. */
function reviewSection(review: PullRequestReview): string[] {
	const comments = chronological(review.comments);
	const lines = [
		'## Review being answered',
		'',
		`- Review id: ${review.id}`,
		`- Author: ${review.author ?? 'unknown'} · State: ${review.state ?? 'unknown'} · Submitted: ${review.submittedAt ?? 'undated'}`,
		'',
		review.body.trim() ? review.body : '_(no summary body)_',
		'',
		`### Inline comments (${comments.length})`,
		'',
	];
	if (comments.length === 0) lines.push('_(no inline comments)_', '');
	for (const comment of comments) {
		const location = comment.path
			? `${comment.path}${comment.line !== undefined ? `:${comment.line}` : ''}`
			: 'unanchored';
		lines.push(
			`#### ${location} · ${comment.author ?? 'unknown'} · ${comment.createdAt ?? 'undated'}`,
			'',
			comment.body.trim() ? comment.body : '_(no text)_',
			'',
		);
	}
	return lines;
}

/**
 * Render a pull request's context as the Markdown the agent reads. Deterministic.
 * With a `review` (Respond-to-review, issue #1240) the review being answered is
 * rendered ahead of the discussion; without one the output is unchanged.
 */
export function renderPullRequestContext(
	context: PullRequestContext,
	review?: PullRequestReview,
): string {
	const discussion = chronological(context.discussion);
	const lines = [
		`# Pull request #${context.number}: ${context.title}`,
		'',
		'_SWARM wrote this file from the source-control provider before this run started. It is the pull request as the provider reported it then._',
		'',
		`- URL: ${context.url}`,
		`- Base branch: ${context.baseBranch}`,
		`- Head branch: ${context.headBranch}`,
		'',
		'## Description',
		'',
		context.description.trim() ? context.description : '_(no description)_',
		'',
	];
	if (context.issueReadHint) lines.push('## Linked issues', '', context.issueReadHint, '');
	if (review) lines.push(...reviewSection(review));
	lines.push(`## Discussion (${discussion.length})`, '');
	if (discussion.length === 0) lines.push('_(no comments or reviews)_', '');
	for (const entry of discussion)
		lines.push(entryHeading(entry), '', entry.body.trim() ? entry.body : '_(no text)_', '');
	return lines.join('\n');
}

/** Write {@link renderPullRequestContext}'s output to the worktree root; returns the path written. */
export function writePullRequestContext(
	worktreePath: string,
	context: PullRequestContext,
	review?: PullRequestReview,
): string {
	const path = join(worktreePath, PULL_REQUEST_CONTEXT_FILENAME);
	writeFileSync(path, renderPullRequestContext(context, review), 'utf8');
	return path;
}
