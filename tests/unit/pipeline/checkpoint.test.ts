import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	CHECKPOINT_FILENAME,
	CheckpointSchema,
	hasCheckpoint,
	readCheckpoint,
} from '@/pipeline/checkpoint.js';
import { buildImplementationPrompt } from '@/pipeline/implementation.js';
import { buildPlanningPrompt } from '@/pipeline/planning.js';
import { buildResolveConflictsPrompt } from '@/pipeline/resolve-conflicts.js';
import { buildRespondToCiPrompt } from '@/pipeline/respond-to-ci.js';
import { buildRespondToReviewPrompt } from '@/pipeline/respond-to-review.js';
import { buildReviewPrompt } from '@/pipeline/review.js';
import { HANDOFF_FILENAMES } from '@/scm/delivery.js';
import { createMockWorkItem } from '../../helpers/factories.js';

const roots: string[] = [];

function checkpointRoot(body?: string): string {
	const root = mkdtempSync(join(tmpdir(), 'swarm-checkpoint-'));
	roots.push(root);
	if (body !== undefined) writeFileSync(join(root, CHECKPOINT_FILENAME), body);
	return root;
}

const VALID = {
	phase: 'implementation',
	completed: ['Added the schema'],
	remaining: ['Update the docs'],
	decisions: ['Left the dashboard alone'],
	workingTree: { modified: ['src/pipeline/checkpoint.ts'], added: [], deleted: [] },
};

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('CheckpointSchema (issue #299)', () => {
	it('is the filename registered as a delivery scratch artifact', () => {
		expect(CHECKPOINT_FILENAME).toBe('swarm_checkpoint.json');
		expect(HANDOFF_FILENAMES.checkpoint).toBe(CHECKPOINT_FILENAME);
	});

	it('accepts the documented shape', () => {
		expect(CheckpointSchema.parse(VALID)).toEqual(VALID);
	});

	it('defaults decisions and the working-tree arrays', () => {
		const checkpoint = CheckpointSchema.parse({
			phase: 'respond-to-ci',
			completed: ['Read the failing run log'],
			remaining: ['Fix the failing test'],
			workingTree: { modified: ['src/index.ts'] },
		});
		expect(checkpoint.decisions).toEqual([]);
		expect(checkpoint.workingTree).toEqual({
			modified: ['src/index.ts'],
			added: [],
			deleted: [],
		});
	});

	it('rejects a checkpoint with nothing remaining or nothing completed', () => {
		expect(() => CheckpointSchema.parse({ ...VALID, remaining: [] })).toThrow();
		expect(() => CheckpointSchema.parse({ ...VALID, completed: [] })).toThrow();
	});

	it('rejects a working tree that names no path at all', () => {
		expect(() =>
			CheckpointSchema.parse({ ...VALID, workingTree: { modified: [], added: [], deleted: [] } }),
		).toThrow(/at least one modified, added, or deleted path/);
		expect(() => CheckpointSchema.parse({ ...VALID, workingTree: {} })).toThrow(
			/at least one modified, added, or deleted path/,
		);
	});

	it('rejects a phase outside the pipeline vocabulary', () => {
		expect(() => CheckpointSchema.parse({ ...VALID, phase: 'deploy' })).toThrow();
	});
});

describe('readCheckpoint / hasCheckpoint (issue #299)', () => {
	it('reads a valid checkpoint from the worktree root', () => {
		const root = checkpointRoot(`${JSON.stringify(VALID)}\n`);
		expect(hasCheckpoint(root)).toBe(true);
		expect(readCheckpoint(root)).toEqual(VALID);
	});

	it('reports no checkpoint when the file is absent', () => {
		const root = checkpointRoot();
		expect(hasCheckpoint(root)).toBe(false);
		expect(() => readCheckpoint(root)).toThrow(
			`Agent did not write required hand-off ${CHECKPOINT_FILENAME}`,
		);
	});

	it('fails with an actionable, filename-naming error on malformed JSON', () => {
		const root = checkpointRoot('{ not json');
		expect(() => readCheckpoint(root)).toThrow(`Invalid hand-off ${CHECKPOINT_FILENAME}`);
	});

	it('fails with an actionable, filename-naming error on a schema-violating body', () => {
		const root = checkpointRoot(JSON.stringify({ ...VALID, remaining: [] }));
		expect(() => readCheckpoint(root)).toThrow(`Invalid hand-off ${CHECKPOINT_FILENAME}`);
	});
});

/** The four worktree-editing phases, which must all ask for the checkpoint. */
const IMPLEMENTER_BUILDERS: Array<{ name: string; build: () => string }> = [
	{
		name: 'implementation',
		build: () =>
			buildImplementationPrompt(createMockWorkItem(), {
				repo: 'o/r',
				taskId: '7',
				branch: 'issue-7',
				baseBranch: 'main',
			}),
	},
	{
		name: 'respond-to-review',
		build: () =>
			buildRespondToReviewPrompt({
				repo: 'o/r',
				prNumber: '7',
				prBranch: 'issue-7',
				reviewId: '99',
			}),
	},
	{
		name: 'respond-to-ci',
		build: () =>
			buildRespondToCiPrompt({
				repo: 'o/r',
				prNumber: '7',
				prBranch: 'issue-7',
				headSha: 'abc123',
			}),
	},
	{
		name: 'resolve-conflicts',
		build: () =>
			buildResolveConflictsPrompt({
				project: { repo: 'o/r' },
				prNumber: '7',
				prBranch: 'issue-7',
				headSha: 'abc123',
				baseBranch: 'main',
				baseSha: 'def456',
			}),
	},
];

describe.each(IMPLEMENTER_BUILDERS)('$name prompt asks for a checkpoint', ({ name, build }) => {
	it('names the checkpoint file and forbids committing it', () => {
		const prompt = build();
		expect(prompt).toContain(CHECKPOINT_FILENAME);
		expect(prompt).toContain(`Do NOT \`git add\` or commit "${CHECKPOINT_FILENAME}"`);
	});

	it('names its own phase, so a continuation can tell whose checkpoint it is', () => {
		expect(build()).toContain(`phase (exactly "${name}")`);
	});
});

describe('phases that deliberately do not write a checkpoint', () => {
	it('planning and review never mention it', () => {
		expect(buildPlanningPrompt(createMockWorkItem(), false)).not.toContain(CHECKPOINT_FILENAME);
		expect(buildReviewPrompt({ repo: 'o/r', prNumber: '7', headSha: 'abc123' })).not.toContain(
			CHECKPOINT_FILENAME,
		);
	});
});

describe('Antigravity implementation prompt (issue #226)', () => {
	it('places the checkpoint inside the named absolute worktree path', () => {
		const prompt = buildImplementationPrompt(createMockWorkItem(), {
			repo: 'o/r',
			taskId: '7',
			branch: 'issue-7',
			baseBranch: 'main',
			worktreePath: '/tmp/worktrees/task-7',
		});
		expect(prompt).toContain(`"${CHECKPOINT_FILENAME}") inside\n/tmp/worktrees/task-7`);
	});
});
