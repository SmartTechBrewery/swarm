import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createMockProjectRecord } from '../../../helpers/factories.js';

vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }));
vi.mock('@/config/apply.js', () => ({ applyConfig: vi.fn() }));
vi.mock('@/db/client.js', () => ({ closeDb: vi.fn(async () => undefined) }));

import { readFile } from 'node:fs/promises';
import { run as configRun } from '@/cli/commands/config.js';
import { applyConfig } from '@/config/apply.js';
import { closeDb } from '@/db/client.js';

const CONFIG_JSON = JSON.stringify({ projects: [createMockProjectRecord({ id: 'proj-1' })] });

describe('swarm config', () => {
	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.mocked(readFile).mockReset().mockResolvedValue(CONFIG_JSON);
		vi.mocked(applyConfig)
			.mockReset()
			.mockResolvedValue({ projects: ['proj-1'], credentialsWritten: 3, credentialsSkipped: [] });
		vi.mocked(closeDb).mockClear();
	});

	it('apply validates the file and delegates to applyConfig, then closes the db', async () => {
		expect(await configRun(['apply'])).toBe(0);
		expect(applyConfig).toHaveBeenCalledTimes(1);
		// The parsed+validated config (with schema defaults applied) is what's passed on.
		const [passed] = vi.mocked(applyConfig).mock.calls[0];
		expect(passed.projects[0].id).toBe('proj-1');
		expect(closeDb).toHaveBeenCalledTimes(1);
	});

	it('reads the default <repo>/swarm.config.json, or the --config path when given', async () => {
		await configRun(['apply']);
		expect(vi.mocked(readFile).mock.calls[0][0]).toMatch(/swarm\.config\.json$/);

		vi.mocked(readFile).mockClear();
		await configRun(['apply', '--config', '/tmp/custom.json']);
		expect(vi.mocked(readFile).mock.calls[0][0]).toBe('/tmp/custom.json');
	});

	it('warns for each skipped credential reference', async () => {
		vi.mocked(applyConfig).mockResolvedValue({
			projects: ['proj-1'],
			credentialsWritten: 1,
			credentialsSkipped: ['proj-1/REV_KEY'],
		});
		const warn = vi.spyOn(console, 'warn');
		expect(await configRun(['apply'])).toBe(0);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('proj-1/REV_KEY'));
	});

	it('closes the db even when applyConfig throws', async () => {
		vi.mocked(applyConfig).mockRejectedValue(new Error('db down'));
		await expect(configRun(['apply'])).rejects.toThrow('db down');
		expect(closeDb).toHaveBeenCalledTimes(1);
	});

	it('rejects an invalid config before touching the db', async () => {
		vi.mocked(readFile).mockResolvedValue(JSON.stringify({ projects: [] }));
		await expect(configRun(['apply'])).rejects.toThrow();
		expect(applyConfig).not.toHaveBeenCalled();
	});

	it('returns 1 for an unknown subcommand', async () => {
		expect(await configRun(['nope'])).toBe(1);
		expect(applyConfig).not.toHaveBeenCalled();
	});

	it('returns 1 with no subcommand and 0 for explicit --help', async () => {
		expect(await configRun([])).toBe(1);
		expect(await configRun(['--help'])).toBe(0);
		expect(applyConfig).not.toHaveBeenCalled();
	});
});
