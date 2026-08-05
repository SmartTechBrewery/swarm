import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	CHECKPOINT_FILENAME,
	type Checkpoint,
	CheckpointSchema,
	DEFAULT_MAX_CONTINUATIONS,
	hasCheckpoint,
	readCheckpoint,
	resolveMaxContinuations,
	tryReadCheckpoint,
	validateCheckpointForContinuation,
} from '@/pipeline/checkpoint.js';
import { buildImplementationPrompt } from '@/pipeline/implementation.js';
import { buildPlanningPrompt } from '@/pipeline/planning.js';
import { checkpointContinuationSection } from '@/pipeline/prompts/checkpoint.js';
import { buildResolveConflictsPrompt } from '@/pipeline/resolve-conflicts.js';
import { buildRespondToCiPrompt } from '@/pipeline/respond-to-ci.js';
import { buildRespondToReviewPrompt } from '@/pipeline/respond-to-review.js';
import { buildReviewPrompt } from '@/pipeline/review.js';
import { HANDOFF_FILENAMES } from '@/scm/delivery.js';
import { createMockProjectConfig, createMockWorkItem } from '../../helpers/factories.js';

const roots: string[] = [];

function checkpointRoot(body?: string): string {
	const root = mkdtempSync(join(tmpdir(), 'swarm-checkpoint-'));
	roots.push(root);
	if (body !== undefined) writeFileSync(join(root, CHECKPOINT_FILENAME), body);
	return root;
}

// The validator reads `git status` in the worktree, so its fixture is a real
// repository. `GIT_*` is stripped for the same reason the production read scrubs
// it: an ambient GIT_DIR would redirect the fixture's own setup commands.
const fixtureGitEnvironment = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);

function fixtureGit(cwd: string, args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8', env: fixtureGitEnvironment });
}

function writeFile(root: string, path: string, body: string): void {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), body);
}

/**
 * A committed repository with `tracked` files, then `dirty` applied on top as
 * uncommitted edits (`null` deletes) and `checkpoint` written to its root.
 */
function gitFixture(options: {
	tracked?: Record<string, string>;
	dirty?: Record<string, string | null>;
	checkpoint?: unknown;
}): string {
	const root = mkdtempSync(join(tmpdir(), 'swarm-checkpoint-git-'));
	roots.push(root);
	fixtureGit(root, ['init']);
	fixtureGit(root, ['config', 'user.name', 'Fixture']);
	fixtureGit(root, ['config', 'user.email', 'fixture@example.com']);
	// A base commit must exist for `git status` to compare against.
	for (const [path, body] of Object.entries({ 'README.md': 'base\n', ...options.tracked }))
		writeFile(root, path, body);
	fixtureGit(root, ['add', '--all']);
	fixtureGit(root, ['commit', '-m', 'base']);
	for (const [path, body] of Object.entries(options.dirty ?? {})) {
		if (body === null) rmSync(join(root, path));
		else writeFile(root, path, body);
	}
	if (options.checkpoint !== undefined)
		writeFileSync(join(root, CHECKPOINT_FILENAME), JSON.stringify(options.checkpoint));
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
		expect(() => readCheckpoint(root)).toThrow(`No checkpoint ${CHECKPOINT_FILENAME} in ${root}`);
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

/**
 * The *settle*-path read (issue #503). Unlike {@link readCheckpoint} it must never
 * throw: a settle that failed over a bad hand-off would lose the run's outcome, and
 * "there is nothing to continue from" is a perfectly good answer.
 */
describe('tryReadCheckpoint / resolveMaxContinuations (issue #503)', () => {
	it('reads a valid checkpoint', () => {
		expect(tryReadCheckpoint(checkpointRoot(JSON.stringify(VALID)))).toEqual(VALID);
	});

	it('reports undefined instead of throwing when the file is absent', () => {
		expect(tryReadCheckpoint(checkpointRoot())).toBeUndefined();
	});

	it('reports undefined instead of throwing on a malformed or schema-violating body', () => {
		expect(tryReadCheckpoint(checkpointRoot('{ not json'))).toBeUndefined();
		expect(
			tryReadCheckpoint(checkpointRoot(JSON.stringify({ ...VALID, remaining: [] }))),
		).toBeUndefined();
	});

	it('reads the continuation budget from the project, defaulting when unset', () => {
		expect(resolveMaxContinuations(createMockProjectConfig())).toBe(DEFAULT_MAX_CONTINUATIONS);
		expect(
			resolveMaxContinuations(createMockProjectConfig({ pipeline: { maxContinuations: 5 } })),
		).toBe(5);
	});
});

describe('validateCheckpointForContinuation (issue #502)', () => {
	it('accepts a checkpoint whose recorded paths are all still changed', async () => {
		const root = gitFixture({
			tracked: { 'src/a.ts': 'a\n', 'src/gone.ts': 'gone\n' },
			dirty: { 'src/a.ts': 'edited\n', 'src/new.ts': 'new\n', 'src/gone.ts': null },
			checkpoint: {
				...VALID,
				workingTree: { modified: ['src/a.ts'], added: ['src/new.ts'], deleted: ['src/gone.ts'] },
			},
		});
		const result = await validateCheckpointForContinuation(root, 'implementation');
		expect(result.valid).toBe(true);
		if (result.valid) expect(result.checkpoint.remaining).toEqual(VALID.remaining);
	});

	it('tolerates extra unrecorded paths — the agent under-reporting is not divergence', async () => {
		// The checkpoint file itself is one such path on every real continuation.
		const root = gitFixture({
			tracked: { 'src/a.ts': 'a\n' },
			dirty: { 'src/a.ts': 'edited\n', 'src/unrecorded.ts': 'extra\n' },
			checkpoint: { ...VALID, workingTree: { modified: ['src/a.ts'] } },
		});
		await expect(validateCheckpointForContinuation(root, 'implementation')).resolves.toMatchObject({
			valid: true,
		});
	});

	it('accepts a recorded path an agent wrote with a leading "./"', async () => {
		const root = gitFixture({
			tracked: { 'src/a.ts': 'a\n' },
			dirty: { 'src/a.ts': 'edited\n' },
			checkpoint: { ...VALID, workingTree: { modified: ['./src/a.ts'] } },
		});
		await expect(validateCheckpointForContinuation(root, 'implementation')).resolves.toMatchObject({
			valid: true,
		});
	});

	it('sees a file added inside a brand-new untracked directory', async () => {
		// `git status --porcelain` alone would collapse this to `src/fresh/`.
		const root = gitFixture({
			dirty: { 'src/fresh/deep.ts': 'new\n' },
			checkpoint: { ...VALID, workingTree: { added: ['src/fresh/deep.ts'] } },
		});
		await expect(validateCheckpointForContinuation(root, 'implementation')).resolves.toMatchObject({
			valid: true,
		});
	});

	it('credits both sides of a rename, which a checkpoint records as an add plus a delete', async () => {
		const root = gitFixture({ tracked: { 'src/old.ts': 'x\n' } });
		fixtureGit(root, ['mv', 'src/old.ts', 'src/new.ts']);
		writeFileSync(
			join(root, CHECKPOINT_FILENAME),
			JSON.stringify({
				...VALID,
				workingTree: { added: ['src/new.ts'], deleted: ['src/old.ts'] },
			}),
		);
		await expect(validateCheckpointForContinuation(root, 'implementation')).resolves.toMatchObject({
			valid: true,
		});
	});

	it('reports missing-validation when no checkpoint was written at all', async () => {
		const root = gitFixture({ dirty: { 'src/a.ts': 'new\n' } });
		await expect(validateCheckpointForContinuation(root, 'implementation')).resolves.toMatchObject({
			valid: false,
			reason: 'missing-validation',
		});
	});

	it('reports checkpoint-divergent for a malformed or schema-violating file', async () => {
		const malformed = gitFixture({ dirty: { 'src/a.ts': 'new\n' } });
		writeFileSync(join(malformed, CHECKPOINT_FILENAME), '{ not json');
		await expect(
			validateCheckpointForContinuation(malformed, 'implementation'),
		).resolves.toMatchObject({ valid: false, reason: 'checkpoint-divergent' });

		const violating = gitFixture({
			dirty: { 'src/a.ts': 'new\n' },
			checkpoint: { ...VALID, remaining: [] },
		});
		await expect(
			validateCheckpointForContinuation(violating, 'implementation'),
		).resolves.toMatchObject({ valid: false, reason: 'checkpoint-divergent' });
	});

	it('refuses another phase’s checkpoint left in the same reused checkout', async () => {
		const root = gitFixture({
			tracked: { 'src/a.ts': 'a\n' },
			dirty: { 'src/a.ts': 'edited\n' },
			checkpoint: { ...VALID, workingTree: { modified: ['src/a.ts'] } },
		});
		const result = await validateCheckpointForContinuation(root, 'respond-to-ci');
		expect(result).toMatchObject({ valid: false, reason: 'checkpoint-divergent' });
		if (!result.valid)
			expect(result.detail).toContain("written by the 'implementation' phase, not 'respond-to-ci'");
	});

	it('blocks and names the specific paths the working tree no longer changes', async () => {
		const root = gitFixture({
			tracked: { 'src/a.ts': 'a\n' },
			dirty: { 'src/a.ts': 'edited\n' },
			checkpoint: {
				...VALID,
				workingTree: { modified: ['src/a.ts'], added: ['src/reverted.ts', 'src/lost.ts'] },
			},
		});
		const result = await validateCheckpointForContinuation(root, 'implementation');
		expect(result).toMatchObject({ valid: false, reason: 'checkpoint-divergent' });
		if (!result.valid) {
			expect(result.detail).toContain('src/reverted.ts, src/lost.ts');
			expect(result.detail).not.toContain('src/a.ts,');
		}
	});

	it('blocks when the tree is clean but the checkpoint records paths', async () => {
		const root = gitFixture({ tracked: { 'src/a.ts': 'a\n' } });
		writeFileSync(join(root, '.gitignore'), `${CHECKPOINT_FILENAME}\n`);
		fixtureGit(root, ['add', '--all']);
		fixtureGit(root, ['commit', '-m', 'ignore the checkpoint']);
		writeFileSync(join(root, CHECKPOINT_FILENAME), JSON.stringify(VALID));
		const result = await validateCheckpointForContinuation(root, 'implementation');
		expect(result).toMatchObject({ valid: false, reason: 'checkpoint-divergent' });
		if (!result.valid) expect(result.detail).toContain('is clean');
	});

	it('fails closed when the working tree cannot be read at all', async () => {
		const root = checkpointRoot(JSON.stringify(VALID)); // not a git repository
		await expect(validateCheckpointForContinuation(root, 'implementation')).resolves.toMatchObject({
			valid: false,
			reason: 'checkpoint-divergent',
		});
	});
});

/** A validated checkpoint a continuation would be seeded from. */
const CONTINUATION: Checkpoint = CheckpointSchema.parse({
	phase: 'implementation',
	completed: ['Added the schema', 'Wrote its unit tests'],
	remaining: ['Update the README table', 'Run lint and the focused tests'],
	decisions: ['Storage migration is out of scope'],
	workingTree: {
		modified: ['src/config/schema.ts'],
		added: ['tests/unit/config/schema.test.ts'],
		deleted: [],
	},
});

describe('checkpointContinuationSection (issue #502)', () => {
	const checkpoint = CONTINUATION;

	it('carries every element of the checkpoint plus the remainder-only instruction', () => {
		const rendered = checkpointContinuationSection(checkpoint).join('\n');
		for (const step of [...checkpoint.completed, ...checkpoint.remaining, ...checkpoint.decisions])
			expect(rendered).toContain(step);
		expect(rendered).toContain('src/config/schema.ts');
		expect(rendered).toContain('tests/unit/config/schema.test.ts');
		expect(rendered).toContain('deleted: none');
		expect(rendered).toContain('Complete only the remainder');
		expect(rendered).toContain('Do not re-explore settled work unless verification requires it');
	});

	it('numbers the remaining steps in the recorded order', () => {
		const rendered = checkpointContinuationSection(checkpoint).join('\n');
		expect(rendered).toContain('(1) Update the README table (2) Run lint and the focused tests');
	});

	it('omits the decisions paragraph when the checkpoint recorded none', () => {
		const rendered = checkpointContinuationSection(
			CheckpointSchema.parse({ ...checkpoint, decisions: [] }),
		).join('\n');
		expect(rendered).not.toContain('already settled');
	});

	it('emits newline-free paragraphs, so both prompt join styles can splice it', () => {
		for (const paragraph of checkpointContinuationSection(checkpoint))
			expect(paragraph).not.toContain('\n');
	});
});

/**
 * The four worktree-editing phases, which must all ask for the checkpoint — and
 * all splice a continuation's back in when one was adopted.
 */
const IMPLEMENTER_BUILDERS: Array<{ name: string; build: (checkpoint?: Checkpoint) => string }> = [
	{
		name: 'implementation',
		build: (checkpoint) =>
			buildImplementationPrompt(createMockWorkItem(), {
				repo: 'o/r',
				taskId: '7',
				branch: 'issue-7',
				baseBranch: 'main',
				checkpoint,
			}),
	},
	{
		name: 'respond-to-review',
		build: (checkpoint) =>
			buildRespondToReviewPrompt({
				repo: 'o/r',
				prNumber: '7',
				prBranch: 'issue-7',
				reviewId: '99',
				checkpoint,
			}),
	},
	{
		name: 'respond-to-ci',
		build: (checkpoint) =>
			buildRespondToCiPrompt({
				repo: 'o/r',
				prNumber: '7',
				prBranch: 'issue-7',
				headSha: 'abc123',
				checkpoint,
			}),
	},
	{
		name: 'resolve-conflicts',
		build: (checkpoint) =>
			buildResolveConflictsPrompt({
				project: { repo: 'o/r' },
				prNumber: '7',
				prBranch: 'issue-7',
				headSha: 'abc123',
				baseBranch: 'main',
				baseSha: 'def456',
				checkpoint,
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

	it('only asks for a checkpoint once its required contents exist', () => {
		const prompt = build();
		expect(prompt).toContain('Do not create one before a completed step.');
		expect(prompt).toContain('completed (a non-empty array');
		expect(prompt).toContain('remaining (a non-empty array');
	});

	it('seeds the recorded remainder when the run adopted a checkpoint (issue #502)', () => {
		const prompt = build(CONTINUATION);
		expect(prompt).toContain('--- CONTINUING FROM A CHECKPOINT ---');
		for (const step of [...CONTINUATION.completed, ...CONTINUATION.remaining])
			expect(prompt).toContain(step);
		expect(prompt).toContain('Complete only the remainder');
	});

	it('says nothing about a continuation on an ordinary run', () => {
		expect(build()).not.toContain('CONTINUING FROM A CHECKPOINT');
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
