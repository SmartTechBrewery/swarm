import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractRuntimeTarball, RuntimeTarError } from '@/launcher/runtime-tar.js';
import {
	buildRuntimeTarball,
	buildTar,
	runtimeEntries,
	type TarEntry,
	TEST_ENTRYPOINT_SOURCE,
} from '../../helpers/runtime-fixtures.js';

const TOP = 'swarm-worker-runtime-1.2.3';

describe('extractRuntimeTarball', () => {
	let dest: string;
	beforeEach(() => {
		dest = mkdtempSync(join(tmpdir(), 'runtime-tar-'));
	});
	afterEach(() => rmSync(dest, { recursive: true, force: true }));

	const extract = (entries: TarEntry[]) =>
		extractRuntimeTarball(gzipSync(buildTar(entries)), TOP, dest);

	it('extracts the runtime layout with the top directory stripped', () => {
		const written = extractRuntimeTarball(buildRuntimeTarball('1.2.3', 'a'.repeat(40)), TOP, dest);
		expect(written).toEqual([
			'package.json',
			'build-info.json',
			'dist/transport/connect-entry.mjs',
		]);
		expect(readFileSync(join(dest, 'dist/transport/connect-entry.mjs'), 'utf8')).toBe(
			TEST_ENTRYPOINT_SOURCE,
		);
	});

	it.each<[string, TarEntry[], RegExp]>([
		[
			'a .. segment',
			[{ name: `${TOP}/` }, { name: `${TOP}/../evil`, data: 'x' }],
			/relative path segment/,
		],
		['an absolute path', [{ name: `/${TOP}/evil`, data: 'x' }], /absolute path/],
		['an entry outside the top directory', [{ name: 'other/evil', data: 'x' }], /outside/],
		[
			'a symlink',
			[{ name: `${TOP}/` }, { name: `${TOP}/link`, data: '', typeflag: '2' }],
			/type "2"/,
		],
		[
			'a hardlink',
			[{ name: `${TOP}/` }, { name: `${TOP}/link`, data: '', typeflag: '1' }],
			/type "1"/,
		],
		['a PAX header', [{ name: `${TOP}/pax`, data: 'x', typeflag: 'x' }], /type "x"/],
		['a GNU long name', [{ name: `${TOP}/@LongLink`, data: 'x', typeflag: 'L' }], /type "L"/],
		['a dot segment', [{ name: `${TOP}/./x`, data: 'x' }], /relative path segment/],
	])('refuses %s', (_label, entries, message) => {
		expect(() => extract(entries)).toThrow(RuntimeTarError);
		expect(() => extract(entries)).toThrow(message);
	});

	it('refuses a header with a bad checksum', () => {
		const tar = buildTar(runtimeEntries('1.2.3'));
		tar[600] ^= 1; // inside the second header's name
		expect(() => extractRuntimeTarball(gzipSync(tar), TOP, dest)).toThrow(/bad checksum/);
	});

	it('refuses a truncated archive', () => {
		const tar = buildTar(runtimeEntries('1.2.3'));
		for (const cut of [1024, 512, 1100]) {
			const into = mkdtempSync(join(dest, 'cut-'));
			expect(() =>
				extractRuntimeTarball(gzipSync(tar.subarray(0, tar.length - cut)), TOP, into),
			).toThrow(/truncated/);
		}
	});

	it('refuses bytes that are not gzip', () => {
		expect(() => extractRuntimeTarball(Buffer.from('not gzip'), TOP, dest)).toThrow(
			/not valid gzip/,
		);
	});
});
