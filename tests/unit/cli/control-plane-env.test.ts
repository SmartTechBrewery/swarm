import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(async () => undefined),
}));
vi.mock('node:fs', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:fs')>()),
	readFileSync: vi.fn(),
}));

import { readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
	ensureControlPlaneUrl,
	installationControlPlaneUrl,
} from '@/cli/_shared/control-plane-env.js';
import { REPO_ROOT } from '@/cli/_shared/paths.js';

const URL_A = 'https://swarm.example.com';
const URL_B = 'https://other.example.com';

/** The `.env` text the call would have written. */
function written(): string {
	const [, contents] = vi.mocked(writeFile).mock.calls[0] ?? [];
	return String(contents);
}

/** A checkout with no `.env` at all — the machine's first worker. */
function noEnvFile(): void {
	vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
}

describe('ensureControlPlaneUrl', () => {
	const originalUrl = process.env.SWARM_CONTROL_PLANE_URL;
	const originalIsTty = process.stdin.isTTY;

	beforeEach(() => {
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		// Both are ambient inputs this reads; a developer's own shell must not decide
		// whether these tests prompt or inherit a URL.
		delete process.env.SWARM_CONTROL_PLANE_URL;
		process.stdin.isTTY = false;
	});

	afterEach(() => {
		if (originalUrl === undefined) delete process.env.SWARM_CONTROL_PLANE_URL;
		else process.env.SWARM_CONTROL_PLANE_URL = originalUrl;
		process.stdin.isTTY = originalIsTty;
		vi.clearAllMocks();
	});

	it('creates .env with the assignment when the checkout has none', async () => {
		noEnvFile();
		expect(await ensureControlPlaneUrl(URL_A)).toBe(URL_A);
		expect(written()).toBe(`SWARM_CONTROL_PLANE_URL=${URL_A}\n`);
	});

	it('appends without disturbing what the file already carries', async () => {
		vi.mocked(readFile).mockResolvedValue('SWARM_WORKER_CREDENTIAL=abc\nLOG_LEVEL=debug\n');
		expect(await ensureControlPlaneUrl(URL_A)).toBe(URL_A);
		expect(written()).toBe(
			`SWARM_WORKER_CREDENTIAL=abc\nLOG_LEVEL=debug\nSWARM_CONTROL_PLANE_URL=${URL_A}\n`,
		);
	});

	it('does not absorb the assignment into a final line that lacks its newline', async () => {
		vi.mocked(readFile).mockResolvedValue('LOG_LEVEL=debug');
		expect(await ensureControlPlaneUrl(URL_A)).toBe(URL_A);
		expect(written()).toBe(`LOG_LEVEL=debug\nSWARM_CONTROL_PLANE_URL=${URL_A}\n`);
	});

	it('leaves an existing assignment untouched — a second worker changes nothing', async () => {
		vi.mocked(readFile).mockResolvedValue(`SWARM_CONTROL_PLANE_URL=${URL_A}\n`);
		expect(await ensureControlPlaneUrl(undefined)).toBe(URL_A);
		expect(writeFile).not.toHaveBeenCalled();
	});

	it('sees through quotes and an export prefix rather than adding a second assignment', async () => {
		vi.mocked(readFile).mockResolvedValue(`export SWARM_CONTROL_PLANE_URL="${URL_A}"\n`);
		expect(await ensureControlPlaneUrl(URL_A)).toBe(URL_A);
		expect(writeFile).not.toHaveBeenCalled();
	});

	it('ignores a commented-out assignment', async () => {
		vi.mocked(readFile).mockResolvedValue(`# SWARM_CONTROL_PLANE_URL=${URL_B}\n`);
		expect(await ensureControlPlaneUrl(URL_A)).toBe(URL_A);
		expect(written()).toBe(
			`# SWARM_CONTROL_PLANE_URL=${URL_B}\nSWARM_CONTROL_PLANE_URL=${URL_A}\n`,
		);
	});

	it('refuses to move a machine to another installation, naming both URLs', async () => {
		vi.mocked(readFile).mockResolvedValue(`SWARM_CONTROL_PLANE_URL=${URL_A}\n`);
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(await ensureControlPlaneUrl(URL_B)).toBeUndefined();
		expect(writeFile).not.toHaveBeenCalled();
		const printed = errors.mock.calls.flat().join(' ');
		expect(printed).toContain(URL_A);
		expect(printed).toContain(URL_B);
	});

	it('refuses an assignment carrying no value rather than guessing one', async () => {
		vi.mocked(readFile).mockResolvedValue('SWARM_CONTROL_PLANE_URL=\n');
		expect(await ensureControlPlaneUrl(URL_A)).toBeUndefined();
		expect(writeFile).not.toHaveBeenCalled();
	});

	it('takes the URL from the environment when none is passed', async () => {
		noEnvFile();
		process.env.SWARM_CONTROL_PLANE_URL = URL_B;
		expect(await ensureControlPlaneUrl(undefined)).toBe(URL_B);
		expect(written()).toBe(`SWARM_CONTROL_PLANE_URL=${URL_B}\n`);
	});

	it('names the flag when nothing supplies a URL and there is nobody to prompt', async () => {
		noEnvFile();
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(await ensureControlPlaneUrl(undefined)).toBeUndefined();
		expect(writeFile).not.toHaveBeenCalled();
		expect(errors.mock.calls.flat().join(' ')).toContain('--control-plane-url');
	});

	it('rejects a URL the worker client could not connect to', async () => {
		noEnvFile();
		expect(await ensureControlPlaneUrl('swarm.example.com')).toBeUndefined();
		expect(await ensureControlPlaneUrl('ftp://swarm.example.com')).toBeUndefined();
		expect(writeFile).not.toHaveBeenCalled();
	});

	it('exports the resolved URL for a process that started without it', async () => {
		noEnvFile();
		await ensureControlPlaneUrl(URL_A);
		expect(process.env.SWARM_CONTROL_PLANE_URL).toBe(URL_A);
	});

	it('propagates a read failure that is not a missing file', async () => {
		vi.mocked(readFile).mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
		await expect(ensureControlPlaneUrl(URL_A)).rejects.toThrow('EACCES');
		expect(writeFile).not.toHaveBeenCalled();
	});
});

// Issue #1215: the sync read every operator-API command and `run:worker` take the
// installation's URL from. It never reports — anything short of a value is
// `undefined`, leaving the caller on the ambient environment.
describe('installationControlPlaneUrl', () => {
	afterEach(() => {
		vi.mocked(readFileSync).mockReset();
	});

	it("reads this installation's own .env", () => {
		vi.mocked(readFileSync).mockReturnValue(`SWARM_CONTROL_PLANE_URL=${URL_A}\n`);
		expect(installationControlPlaneUrl()).toBe(URL_A);
		expect(readFileSync).toHaveBeenCalledWith(resolve(REPO_ROOT, '.env'), 'utf8');
	});

	it('sees through quotes and an export prefix', () => {
		vi.mocked(readFileSync).mockReturnValue(
			`LOG_LEVEL=debug\nexport SWARM_CONTROL_PLANE_URL="${URL_A}"\n`,
		);
		expect(installationControlPlaneUrl()).toBe(URL_A);
	});

	it.each([
		['no assignment', 'LOG_LEVEL=debug\n'],
		['a commented-out assignment', `# SWARM_CONTROL_PLANE_URL=${URL_A}\n`],
		['an empty assignment', 'SWARM_CONTROL_PLANE_URL=\n'],
	])('answers undefined for %s', (_label, contents) => {
		vi.mocked(readFileSync).mockReturnValue(contents);
		expect(installationControlPlaneUrl()).toBeUndefined();
	});

	it.each(['ENOENT', 'EACCES'])('answers undefined when the read fails with %s', (code) => {
		vi.mocked(readFileSync).mockImplementation(() => {
			throw Object.assign(new Error(code), { code });
		});
		expect(installationControlPlaneUrl()).toBeUndefined();
	});
});
