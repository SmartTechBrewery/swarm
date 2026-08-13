import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
	access: vi.fn(),
	copyFile: vi.fn(async () => undefined),
	readFile: vi.fn(),
	writeFile: vi.fn(async () => undefined),
}));

import { access, copyFile, readFile, writeFile } from 'node:fs/promises';
import { run as initRun } from '@/cli/commands/init.js';

const VALID_CONFIG = {
	projects: [
		{
			id: 'p',
			name: 'P',
			repositories: [{ repo: 'owner/repo' }],
			repoRoot: '/tmp/p',
			pm: {
				type: 'github-projects',
				projectId: 'PVT_x',
				statusFieldId: 'PVTSSF_x',
				statusOptions: { backlog: 'OPT' },
			},
			credentials: {
				implementer: 'IMPL',
				reviewer: 'REV',
				webhookSecret: 'HOOK',
			},
		},
	],
};

describe('swarm init', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	it('creates .env and the config template when neither exists', async () => {
		vi.mocked(access).mockRejectedValue(new Error('ENOENT'));
		expect(await initRun([])).toBe(0);
		expect(copyFile).toHaveBeenCalledTimes(1);
		expect(writeFile).toHaveBeenCalledTimes(1);
		// The scaffolded config template must itself be schema-valid.
		const [, written] = vi.mocked(writeFile).mock.calls[0];
		expect(() => JSON.parse(written as string)).not.toThrow();
	});

	it('leaves existing files untouched and validates a valid config', async () => {
		vi.mocked(access).mockResolvedValue(undefined);
		vi.mocked(readFile).mockResolvedValue(JSON.stringify(VALID_CONFIG));
		expect(await initRun([])).toBe(0);
		expect(copyFile).not.toHaveBeenCalled();
		expect(writeFile).not.toHaveBeenCalled();
	});

	it('exits 1 when an existing config is invalid', async () => {
		vi.mocked(access).mockResolvedValue(undefined);
		vi.mocked(readFile).mockResolvedValue(JSON.stringify({ projects: [] }));
		expect(await initRun([])).toBe(1);
	});
});
