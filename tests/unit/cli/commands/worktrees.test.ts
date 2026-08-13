import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProjectConfig } from '../../../helpers/factories.js';

vi.mock('@/db/repositories/projectsRepository.js', () => ({
	listAllProjectsFromDb: vi.fn(),
	findProjectByIdFromDb: vi.fn(),
}));
vi.mock('@/worktree/retention.js', () => ({
	pruneStaleWorktrees: vi.fn(),
}));
vi.mock('@/db/client.js', () => ({
	closeDb: vi.fn(async () => undefined),
}));

import { run as worktreesRun } from '@/cli/commands/worktrees.js';
import { closeDb } from '@/db/client.js';
import {
	findProjectByIdFromDb,
	listAllProjectsFromDb,
} from '@/db/repositories/projectsRepository.js';
import { pruneStaleWorktrees } from '@/worktree/retention.js';

const mockProject1 = createMockProjectConfig({ id: 'proj-1', name: 'Project One' });
const mockProject2 = createMockProjectConfig({ id: 'proj-2', name: 'Project Two' });

describe('swarm worktrees', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});

		vi.mocked(listAllProjectsFromDb).mockReset().mockResolvedValue([mockProject1, mockProject2]);
		vi.mocked(findProjectByIdFromDb).mockReset().mockResolvedValue(mockProject1);

		vi.mocked(pruneStaleWorktrees)
			.mockReset()
			.mockResolvedValue({
				kept: ['/path/to/task-3', '/path/to/task-2'],
				pruned: ['/path/to/task-1'],
				skippedInFlight: [],
				skippedDirty: [],
				skippedUnpushed: [],
				skippedDeferred: [],
				ignored: [],
				sweptState: [],
			});

		vi.mocked(closeDb).mockClear();
	});

	it('prune subcommand sweeps all projects by default and closes the db', async () => {
		expect(await worktreesRun(['prune'])).toBe(0);
		expect(listAllProjectsFromDb).toHaveBeenCalledTimes(1);
		expect(pruneStaleWorktrees).toHaveBeenCalledTimes(2);
		expect(pruneStaleWorktrees).toHaveBeenNthCalledWith(1, mockProject1, { dryRun: false });
		expect(pruneStaleWorktrees).toHaveBeenNthCalledWith(2, mockProject2, { dryRun: false });
		expect(closeDb).toHaveBeenCalledTimes(1);
	});

	it('prune subcommand supports --project to sweep a single project', async () => {
		expect(await worktreesRun(['prune', '--project', 'proj-1'])).toBe(0);
		expect(findProjectByIdFromDb).toHaveBeenCalledWith('proj-1');
		expect(listAllProjectsFromDb).not.toHaveBeenCalled();
		expect(pruneStaleWorktrees).toHaveBeenCalledTimes(1);
		expect(pruneStaleWorktrees).toHaveBeenCalledWith(mockProject1, { dryRun: false });
	});

	it('errors cleanly for an unknown project ID', async () => {
		vi.mocked(findProjectByIdFromDb).mockResolvedValue(undefined);
		expect(await worktreesRun(['prune', '--project', 'invalid-id'])).toBe(1);
		expect(pruneStaleWorktrees).not.toHaveBeenCalled();
		expect(closeDb).toHaveBeenCalledTimes(1);
	});

	it('threads --dry-run option to pruneStaleWorktrees', async () => {
		expect(await worktreesRun(['prune', '--dry-run'])).toBe(0);
		expect(pruneStaleWorktrees).toHaveBeenCalledTimes(2);
		expect(pruneStaleWorktrees).toHaveBeenNthCalledWith(1, mockProject1, { dryRun: true });
	});

	it('prints warning lines for skipped dirty worktrees', async () => {
		vi.mocked(pruneStaleWorktrees).mockResolvedValue({
			kept: ['/path/to/task-2'],
			pruned: [],
			skippedInFlight: [],
			skippedDirty: ['/path/to/task-1'],
			skippedUnpushed: [],
			skippedDeferred: [],
			ignored: [],
			sweptState: [],
		});
		const warnSpy = vi.spyOn(console, 'warn');
		expect(await worktreesRun(['prune'])).toBe(0);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('has uncommitted changes'));
	});

	it('prints warning lines for skipped unpushed worktrees', async () => {
		vi.mocked(pruneStaleWorktrees).mockResolvedValue({
			kept: ['/path/to/task-2'],
			pruned: [],
			skippedInFlight: [],
			skippedDirty: [],
			skippedUnpushed: ['/path/to/task-1'],
			skippedDeferred: [],
			ignored: [],
			sweptState: [],
		});
		const warnSpy = vi.spyOn(console, 'warn');
		expect(await worktreesRun(['prune'])).toBe(0);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('has unpushed commits'));
	});

	// The artifact basenames are opaque `<sha256>` hashes, so printing them is the only
	// way an operator can tell which task's debris the sweep removed (issue #721).
	it('names every expired host-local artifact swept, honouring the dry-run phrasing', async () => {
		const pin = '/path/to/.swarm-workspaces/.swarm-state/9f2b.pin.json';
		vi.mocked(pruneStaleWorktrees).mockResolvedValue({
			kept: ['/path/to/task-2'],
			pruned: [],
			skippedInFlight: [],
			skippedDirty: [],
			skippedUnpushed: [],
			skippedDeferred: [],
			ignored: [],
			sweptState: [pin],
		});
		const logSpy = vi.spyOn(console, 'log');

		expect(await worktreesRun(['prune'])).toBe(0);
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining('swept expired host-local state: 1 artifact(s)'),
		);
		expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(pin));

		logSpy.mockClear();
		expect(await worktreesRun(['prune', '--dry-run'])).toBe(0);
		expect(logSpy).toHaveBeenCalledWith(
			expect.stringContaining('would sweep expired host-local state: 1 artifact(s)'),
		);
	});

	it('closes the db even when pruneStaleWorktrees throws', async () => {
		vi.mocked(pruneStaleWorktrees).mockRejectedValue(new Error('sweep failed'));
		expect(await worktreesRun(['prune'])).toBe(1);
		expect(closeDb).toHaveBeenCalledTimes(1);
	});

	it('returns 1 for unknown subcommands', async () => {
		expect(await worktreesRun(['invalid-subcommand'])).toBe(1);
		expect(pruneStaleWorktrees).not.toHaveBeenCalled();
	});

	it('returns 1 with no subcommand and 0 for --help', async () => {
		expect(await worktreesRun([])).toBe(1);
		expect(await worktreesRun(['--help'])).toBe(0);
		expect(pruneStaleWorktrees).not.toHaveBeenCalled();
	});
});
