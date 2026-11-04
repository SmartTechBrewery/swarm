/**
 * A **minimal, strict ustar reader** for the worker runtime tarball (issue #1281,
 * phase 1) — the format `bin/build-worker-runtime.js` writes, and nothing else.
 *
 * That format is one top-level `swarm-worker-runtime-<version>/` directory holding
 * plain files (typeflag `0`) and directories (`5`), gzipped. Extraction strips that
 * top directory, so `dist/transport/connect-entry.mjs` lands at the same relative
 * depth it has in the archive — the depth `swarmInstallRoot()` is anchored on.
 *
 * Anything outside that shape is refused rather than interpreted: a symlink, a
 * hardlink, a device, a PAX or GNU long-name header, an absolute path, a `..`
 * segment, a path outside the top directory, a bad header checksum, or an archive
 * that does not end in its zero blocks. The bytes are signature-verified before
 * they get here, so this strictness is not the security boundary; it keeps a
 * future mistake in the format from ever becoming a write outside `destDir`.
 * Files are created with `wx`, so nothing already on disk is overwritten.
 *
 * No imports from the daemon graph: the launcher (phase 2) bundles this module.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const BLOCK = 512;

export class RuntimeTarError extends Error {
	override name = 'RuntimeTarError';
}

function readString(header: Buffer, offset: number, length: number): string {
	const field = header.subarray(offset, offset + length);
	const end = field.indexOf(0);
	return field.subarray(0, end === -1 ? length : end).toString('utf8');
}

function readOctal(header: Buffer, offset: number, length: number, what: string): number {
	const text = readString(header, offset, length).trim();
	if (!/^[0-7]+$/.test(text)) throw new RuntimeTarError(`tar header ${what} is not octal`);
	return Number.parseInt(text, 8);
}

function checksumValid(header: Buffer): boolean {
	const stored = readOctal(header, 148, 8, 'checksum');
	let sum = 0;
	for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
	return sum === stored;
}

/** The entry's path relative to `expectedTopDir`, or a throw naming why it is refused. */
function relativeEntryPath(name: string, expectedTopDir: string): string {
	if (name.startsWith('/')) throw new RuntimeTarError(`tar entry ${name} is an absolute path`);
	const segments = name.split('/');
	if (segments.some((segment) => segment === '..' || segment === '.'))
		throw new RuntimeTarError(`tar entry ${name} has a relative path segment`);
	if (segments[0] !== expectedTopDir)
		throw new RuntimeTarError(`tar entry ${name} is outside ${expectedTopDir}/`);
	const rest = segments.slice(1).filter((segment, i, all) => segment || i < all.length - 1);
	if (rest.some((segment) => segment === ''))
		throw new RuntimeTarError(`tar entry ${name} has an empty path segment`);
	return rest.join('/');
}

interface TarEntryHeader {
	name: string;
	/** `'0'` for a file (a NUL typeflag is read as `'0'`), `'5'` for a directory. */
	typeflag: string;
	size: number;
}

function isZeroBlock(block: Buffer): boolean {
	return block.length === BLOCK && block.every((byte) => byte === 0);
}

/** Parse and check one ustar header, refusing anything outside the runtime's format. */
function parseHeader(header: Buffer, offset: number): TarEntryHeader {
	if (!checksumValid(header))
		throw new RuntimeTarError(`tar header at offset ${offset} has a bad checksum`);
	if (readString(header, 257, 6) !== 'ustar')
		throw new RuntimeTarError(`tar header at offset ${offset} is not ustar`);
	if (readString(header, 345, 155))
		throw new RuntimeTarError(`tar header at offset ${offset} uses a ustar name prefix`);

	const name = readString(header, 0, 100);
	if (!name) throw new RuntimeTarError(`tar header at offset ${offset} has no name`);
	// A NUL ends the name; anything after it would be a second, hidden name.
	const nul = header.subarray(0, 100).indexOf(0);
	if (nul !== -1 && header.subarray(nul, 100).some((byte) => byte !== 0))
		throw new RuntimeTarError(`tar entry ${name} has a NUL inside its name`);
	const typeflag = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
	return { name, typeflag, size: readOctal(header, 124, 12, 'size') };
}

/** Write one entry under `destDir`; returns the file written, if it is a file. */
function writeEntry(
	entry: TarEntryHeader,
	data: Buffer,
	expectedTopDir: string,
	destDir: string,
): string | undefined {
	const { name, typeflag, size } = entry;
	const relative = relativeEntryPath(name, expectedTopDir);
	if (typeflag === '5') {
		if (size !== 0) throw new RuntimeTarError(`tar directory ${name} has a size`);
		if (relative) mkdirSync(join(destDir, relative), { recursive: true, mode: 0o755 });
		return undefined;
	}
	if (typeflag !== '0')
		throw new RuntimeTarError(
			`tar entry ${name} has type ${JSON.stringify(typeflag)}; only files and directories are allowed`,
		);
	if (!relative || name.endsWith('/'))
		throw new RuntimeTarError(`tar file entry ${name} names a directory`);
	writeFileSync(join(destDir, relative), data, { flag: 'wx', mode: 0o644 });
	return relative;
}

/**
 * Gunzip `gz` and extract it into `destDir` (which must exist), stripping
 * `expectedTopDir`. Returns the files written, relative to `destDir`. Throws a
 * `RuntimeTarError` on anything outside the runtime's own format; what was
 * already written is left for the caller to discard with its staging directory.
 */
export function extractRuntimeTarball(
	gz: Buffer,
	expectedTopDir: string,
	destDir: string,
): string[] {
	let tar: Buffer;
	try {
		tar = gunzipSync(gz);
	} catch (err) {
		throw new RuntimeTarError(`the runtime archive is not valid gzip: ${(err as Error).message}`);
	}

	const written: string[] = [];
	let offset = 0;
	while (true) {
		if (offset + BLOCK > tar.length)
			throw new RuntimeTarError('the runtime archive is truncated (no end-of-archive blocks)');
		const header = tar.subarray(offset, offset + BLOCK);
		if (isZeroBlock(header)) {
			if (!isZeroBlock(tar.subarray(offset + BLOCK, offset + 2 * BLOCK)))
				throw new RuntimeTarError('the runtime archive is truncated (one end-of-archive block)');
			return written;
		}
		const entry = parseHeader(header, offset);
		const dataStart = offset + BLOCK;
		const dataEnd = dataStart + entry.size;
		if (dataEnd > tar.length) throw new RuntimeTarError(`tar entry ${entry.name} is truncated`);
		const file = writeEntry(entry, tar.subarray(dataStart, dataEnd), expectedTopDir, destDir);
		if (file) written.push(file);
		offset = dataStart + Math.ceil(entry.size / BLOCK) * BLOCK;
	}
}
