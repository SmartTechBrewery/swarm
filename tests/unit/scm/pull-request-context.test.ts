import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SCRATCH_PATHSPECS } from '@/scm/delivery.js';
import {
	PULL_REQUEST_CONTEXT_FILENAME,
	renderPullRequestContext,
	ScmReadUnsupportedError,
	unsupportedPullRequestContextRead,
	unsupportedReviewRead,
	writePullRequestContext,
} from '@/scm/pull-request-context.js';
import {
	createMockPullRequestContext,
	createMockPullRequestReview,
} from '../../helpers/factories.js';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('renderPullRequestContext', () => {
	it('renders the pull request’s identity, branches and description verbatim', () => {
		const rendered = renderPullRequestContext(
			createMockPullRequestContext({ description: 'Closes #17\n\n- [ ] item' }),
		);
		expect(rendered).toContain('# Pull request #99: Add the widget');
		expect(rendered).toContain('- URL: https://github.com/SmartTechBrewery/swarm/pull/99');
		expect(rendered).toContain('- Base branch: main');
		expect(rendered).toContain('- Head branch: issue-17');
		expect(rendered).toContain('## Description\n\nCloses #17\n\n- [ ] item');
	});

	it('marks an empty description and an empty discussion', () => {
		const rendered = renderPullRequestContext(
			createMockPullRequestContext({ description: '  ', discussion: [] }),
		);
		expect(rendered).toContain('_(no description)_');
		expect(rendered).toContain('## Discussion (0)\n\n_(no comments or reviews)_');
	});

	it('renders the linked-issue section only when the provider offers a way to read one', () => {
		expect(renderPullRequestContext(createMockPullRequestContext())).not.toContain(
			'## Linked issues',
		);
		expect(
			renderPullRequestContext(
				createMockPullRequestContext({ issueReadHint: 'Read one with `gh issue view <n>`.' }),
			),
		).toContain('## Linked issues\n\nRead one with `gh issue view <n>`.');
	});

	it('orders the discussion chronologically, stably, with undated entries last', () => {
		const rendered = renderPullRequestContext(
			createMockPullRequestContext({
				discussion: [
					{ kind: 'comment', author: null, createdAt: null, body: 'undated' },
					{ kind: 'comment', author: 'b', createdAt: '2026-01-02T00:00:00Z', body: 'second' },
					{ kind: 'comment', author: 'a', createdAt: '2026-01-01T00:00:00Z', body: 'first' },
					{ kind: 'comment', author: 'c', createdAt: '2026-01-02T00:00:00Z', body: 'third' },
				],
			}),
		);
		const order = ['first', 'second', 'third', 'undated'].map((body) => rendered.indexOf(body));
		expect(order).toEqual([...order].sort((x, y) => x - y));
		expect(rendered).toContain('### Comment by unknown · undated');
	});

	it('labels reviews with their state and file-anchored comments with their location', () => {
		const rendered = renderPullRequestContext(
			createMockPullRequestContext({
				discussion: [
					{
						kind: 'review',
						author: 'swarm-reviewer',
						createdAt: '2026-01-01T00:00:00Z',
						body: '',
						reviewState: 'approved',
					},
					{
						kind: 'review-comment',
						author: 'human',
						createdAt: '2026-01-02T00:00:00Z',
						body: 'Off by one.',
						path: 'src/a.ts',
						line: 12,
					},
				],
			}),
		);
		expect(rendered).toContain(
			'### Review (approved) by swarm-reviewer · 2026-01-01T00:00:00Z\n\n_(no text)_',
		);
		expect(rendered).toContain('### Comment on src/a.ts:12 by human · 2026-01-02T00:00:00Z');
	});
});

describe('renderPullRequestContext with the review being answered (issue #1240)', () => {
	it('renders the review ahead of the discussion, inline comments in chronological order', () => {
		const rendered = renderPullRequestContext(
			createMockPullRequestContext(),
			createMockPullRequestReview({
				comments: [
					{
						kind: 'review-comment',
						author: 'swarm-reviewer',
						createdAt: '2026-08-04T11:05:00.000Z',
						body: 'Second.',
						path: 'src/b.ts',
						line: 3,
					},
					{
						kind: 'review-comment',
						author: 'swarm-reviewer',
						createdAt: '2026-08-04T11:01:00.000Z',
						body: 'First.',
						path: 'src/a.ts',
					},
				],
			}),
		);

		expect(rendered).toContain('## Review being answered');
		expect(rendered).toContain('- Review id: 4242');
		expect(rendered).toContain(
			'- Author: swarm-reviewer · State: changes-requested · Submitted: 2026-08-04T11:00:00.000Z',
		);
		expect(rendered).toContain('### Inline comments (2)');
		expect(rendered.indexOf('#### src/a.ts · swarm-reviewer')).toBeLessThan(
			rendered.indexOf('#### src/b.ts:3 · swarm-reviewer'),
		);
		expect(rendered.indexOf('## Review being answered')).toBeLessThan(
			rendered.indexOf('## Discussion'),
		);
	});

	it('says so when the review has no body, no inline comments, and unknown fields', () => {
		const rendered = renderPullRequestContext(
			createMockPullRequestContext(),
			createMockPullRequestReview({
				author: null,
				state: null,
				submittedAt: null,
				body: '  ',
				comments: [],
			}),
		);
		expect(rendered).toContain('- Author: unknown · State: unknown · Submitted: undated');
		expect(rendered).toContain('_(no summary body)_');
		expect(rendered).toContain('### Inline comments (0)');
		expect(rendered).toContain('_(no inline comments)_');
	});

	it('renders no review section without a review', () => {
		expect(renderPullRequestContext(createMockPullRequestContext())).not.toContain(
			'Review being answered',
		);
	});
});

describe('writePullRequestContext', () => {
	it('writes the review section when given one', () => {
		const root = mkdtempSync(join(tmpdir(), 'swarm-pr-context-'));
		roots.push(root);
		const context = createMockPullRequestContext();
		const review = createMockPullRequestReview();

		const path = writePullRequestContext(root, context, review);

		expect(readFileSync(path, 'utf8')).toBe(renderPullRequestContext(context, review));
		expect(readFileSync(path, 'utf8')).toContain('## Review being answered');
	});

	it('writes the rendered context to the worktree root', () => {
		const root = mkdtempSync(join(tmpdir(), 'swarm-pr-context-'));
		roots.push(root);
		const context = createMockPullRequestContext();

		const path = writePullRequestContext(root, context);

		expect(path).toBe(join(root, PULL_REQUEST_CONTEXT_FILENAME));
		expect(readFileSync(path, 'utf8')).toBe(renderPullRequestContext(context));
	});

	it('is scratch, so it never lands in a delivered commit', () => {
		expect(SCRATCH_PATHSPECS).toContain(PULL_REQUEST_CONTEXT_FILENAME);
	});
});

describe('unsupportedPullRequestContextRead', () => {
	it('rejects with a declared gap, worded clear of the conformance suite’s stub sentinel', async () => {
		const read = unsupportedPullRequestContextRead('Example SCM');
		const error = await read(1).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ScmReadUnsupportedError);
		expect((error as Error).message).toContain('not yet supported on Example SCM');
		expect((error as Error).message).not.toMatch(/not\s+implemented/i);
	});
});

describe('unsupportedReviewRead', () => {
	it('rejects with a declared gap, worded clear of the conformance suite’s stub sentinel', async () => {
		const read = unsupportedReviewRead('Example SCM');
		const error = await read(1, '1').catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(ScmReadUnsupportedError);
		expect((error as Error).message).toBe(
			'reading a pull request review is not yet supported on Example SCM',
		);
	});
});
