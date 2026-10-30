import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:fs')>()),
	readFileSync: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({
	writeFile: vi.fn(async () => undefined),
}));

import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { ensureControlPlaneUrl, resolveControlPlaneUrl } from '@/cli/_shared/control-plane-env.js';

const URL_A = 'https://swarm.example.com';
const URL_B = 'https://other.example.com';

/** The `.env` text the call would have written. */
function written(): string {
	const [, contents] = vi.mocked(writeFile).mock.calls[0] ?? [];
	return String(contents);
}

/** A checkout with no `.env` at all — the machine's first worker. */
function noEnvFile(): void {
	vi.mocked(readFileSync).mockImplementation(() => {
		throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
	});
}

/** A checkout whose `.env` reads as `contents`. */
function envFile(contents: string): void {
	vi.mocked(readFileSync).mockReturnValue(contents);
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
		envFile('SWARM_WORKER_CREDENTIAL=abc\nLOG_LEVEL=debug\n');
		expect(await ensureControlPlaneUrl(URL_A)).toBe(URL_A);
		expect(written()).toBe(
			`SWARM_WORKER_CREDENTIAL=abc\nLOG_LEVEL=debug\nSWARM_CONTROL_PLANE_URL=${URL_A}\n`,
		);
	});

	it('does not absorb the assignment into a final line that lacks its newline', async () => {
		envFile('LOG_LEVEL=debug');
		expect(await ensureControlPlaneUrl(URL_A)).toBe(URL_A);
		expect(written()).toBe(`LOG_LEVEL=debug\nSWARM_CONTROL_PLANE_URL=${URL_A}\n`);
	});

	it('leaves an existing assignment untouched — a second worker changes nothing', async () => {
		envFile(`SWARM_CONTROL_PLANE_URL=${URL_A}\n`);
		expect(await ensureControlPlaneUrl(undefined)).toBe(URL_A);
		expect(writeFile).not.toHaveBeenCalled();
	});

	it('sees through quotes and an export prefix rather than adding a second assignment', async () => {
		envFile(`export SWARM_CONTROL_PLANE_URL="${URL_A}"\n`);
		expect(await ensureControlPlaneUrl(URL_A)).toBe(URL_A);
		expect(writeFile).not.toHaveBeenCalled();
	});

	it('ignores a commented-out assignment', async () => {
		envFile(`# SWARM_CONTROL_PLANE_URL=${URL_B}\n`);
		expect(await ensureControlPlaneUrl(URL_A)).toBe(URL_A);
		expect(written()).toBe(
			`# SWARM_CONTROL_PLANE_URL=${URL_B}\nSWARM_CONTROL_PLANE_URL=${URL_A}\n`,
		);
	});

	it('refuses to move a machine to another installation, naming both URLs', async () => {
		envFile(`SWARM_CONTROL_PLANE_URL=${URL_A}\n`);
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(await ensureControlPlaneUrl(URL_B)).toBeUndefined();
		expect(writeFile).not.toHaveBeenCalled();
		const printed = errors.mock.calls.flat().join(' ');
		expect(printed).toContain(URL_A);
		expect(printed).toContain(URL_B);
	});

	it('refuses an assignment carrying no value rather than guessing one', async () => {
		envFile('SWARM_CONTROL_PLANE_URL=\n');
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
		vi.mocked(readFileSync).mockImplementation(() => {
			throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
		});
		await expect(ensureControlPlaneUrl(URL_A)).rejects.toThrow('EACCES');
		expect(writeFile).not.toHaveBeenCalled();
	});

	it('refuses an exported URL that differs from .env — a registered worker would not follow it', async () => {
		envFile(`SWARM_CONTROL_PLANE_URL=${URL_A}\n`);
		process.env.SWARM_CONTROL_PLANE_URL = URL_B;
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(await ensureControlPlaneUrl(undefined)).toBeUndefined();
		expect(writeFile).not.toHaveBeenCalled();
		const printed = errors.mock.calls.flat().join(' ');
		expect(printed).toContain(URL_A);
		expect(printed).toContain(URL_B);
		expect(printed).toContain('unset SWARM_CONTROL_PLANE_URL');
	});

	// The reported bug (#1214): an exported URL silently lost to `.env`.
	it('uses an exported URL over .env in warn mode, naming both installations', async () => {
		envFile(`SWARM_CONTROL_PLANE_URL=${URL_A}\n`);
		process.env.SWARM_CONTROL_PLANE_URL = URL_B;
		const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(await ensureControlPlaneUrl(undefined, { onEnvFileConflict: 'warn' })).toBe(URL_B);
		expect(writeFile).not.toHaveBeenCalled();
		expect(process.env.SWARM_CONTROL_PLANE_URL).toBe(URL_B);
		const printed = warnings.mock.calls.flat().join(' ');
		expect(printed).toContain(URL_A);
		expect(printed).toContain(URL_B);
	});

	it('uses the flag over .env in warn mode', async () => {
		envFile(`SWARM_CONTROL_PLANE_URL=${URL_A}\n`);
		const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(await ensureControlPlaneUrl(URL_B, { onEnvFileConflict: 'warn' })).toBe(URL_B);
		expect(warnings).toHaveBeenCalled();
		expect(writeFile).not.toHaveBeenCalled();
	});

	it('neither warns nor writes when the environment agrees with .env', async () => {
		envFile(`SWARM_CONTROL_PLANE_URL=${URL_A}\n`);
		process.env.SWARM_CONTROL_PLANE_URL = URL_A;
		const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(await ensureControlPlaneUrl(undefined)).toBe(URL_A);
		expect(warnings).not.toHaveBeenCalled();
		expect(writeFile).not.toHaveBeenCalled();
	});
});

describe('resolveControlPlaneUrl', () => {
	const originalUrl = process.env.SWARM_CONTROL_PLANE_URL;

	beforeEach(() => {
		delete process.env.SWARM_CONTROL_PLANE_URL;
	});

	afterEach(() => {
		if (originalUrl === undefined) delete process.env.SWARM_CONTROL_PLANE_URL;
		else process.env.SWARM_CONTROL_PLANE_URL = originalUrl;
		vi.clearAllMocks();
	});

	it('prefers the flag over the environment and .env', () => {
		envFile(`SWARM_CONTROL_PLANE_URL=${URL_A}\n`);
		process.env.SWARM_CONTROL_PLANE_URL = URL_A;
		expect(resolveControlPlaneUrl(URL_B)).toEqual({ url: URL_B, source: 'flag' });
	});

	it('prefers the environment over .env', () => {
		envFile(`SWARM_CONTROL_PLANE_URL=${URL_A}\n`);
		process.env.SWARM_CONTROL_PLANE_URL = URL_B;
		expect(resolveControlPlaneUrl()).toEqual({ url: URL_B, source: 'environment' });
	});

	it("falls back to the checkout's .env when nothing is exported", () => {
		envFile(`SWARM_CONTROL_PLANE_URL=${URL_A}\n`);
		expect(resolveControlPlaneUrl()).toEqual({ url: URL_A, source: 'env-file' });
	});

	it('reads .env as the daemon does — the last assignment wins', () => {
		envFile(`SWARM_CONTROL_PLANE_URL=${URL_A}\nSWARM_CONTROL_PLANE_URL=${URL_B}\n`);
		expect(resolveControlPlaneUrl()).toEqual({ url: URL_B, source: 'env-file' });
	});

	it('reports unset, naming .env, when nothing carries a URL', () => {
		noEnvFile();
		const resolved = resolveControlPlaneUrl();
		expect(resolved).toEqual({
			error: expect.stringContaining('SWARM_CONTROL_PLANE_URL is unset'),
		});
		expect(resolved).toEqual({ error: expect.stringContaining('.env') });
	});

	it('treats an empty .env assignment as unset', () => {
		envFile('SWARM_CONTROL_PLANE_URL=\n');
		expect(resolveControlPlaneUrl()).toEqual({
			error: expect.stringContaining('SWARM_CONTROL_PLANE_URL is unset'),
		});
	});

	it('names where an invalid URL came from', () => {
		envFile('SWARM_CONTROL_PLANE_URL=swarm.example.com\n');
		const resolved = resolveControlPlaneUrl();
		expect(resolved).toEqual({ error: expect.stringContaining('is not a valid URL') });
		expect(resolved).toEqual({ error: expect.stringContaining('.env') });
	});
});
