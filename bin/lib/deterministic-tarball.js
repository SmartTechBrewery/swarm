// The byte-deterministic tar.gz packer shared by `bin/build-worker-runtime.js`
// (issue #1279) and `bin/build-worker-launcher.js` (issue #1283).
//
// Both artifacts are checksummed — the runtime is signed too — so one source tree
// and commit must always produce the same bytes. They are packed here rather than
// by `tar`, whose BSD and GNU flavours disagree on the flags that pin order,
// owners and times: the caller's fixed entry order (never `readdir`'s), mtime 0,
// uid/gid 0, and a gzip header with no time or name and its OS byte pinned to Unix.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

/**
 * Pack `<stage>/<entry>` for every entry, in the order given, under the top-level
 * directory `<name>/`, and answer the gzipped bytes.
 *
 * An entry is a path relative to `stage` — `''` and anything ending in `/` is a
 * directory (mode 0755), which must precede its contents — or `{ path, mode,
 * optional }`: `mode` overrides a file's default 0644 (an executable is 0755), and
 * an `optional` file that does not exist is left out rather than failing the pack.
 *
 * @param {string} stage
 * @param {string} name
 * @param {Array<string | { path: string, mode?: number, optional?: boolean }>} entries
 * @returns {Buffer}
 */
export function packDeterministicTarball(stage, name, entries) {
	const blocks = [];
	for (const raw of entries) {
		const entry = typeof raw === 'string' ? { path: raw } : raw;
		const isDir = entry.path === '' || entry.path.endsWith('/');
		if (isDir) {
			blocks.push(tarHeader(`${name}/${entry.path}`, 0, 0o755, true));
			continue;
		}
		let data;
		try {
			data = readFileSync(join(stage, entry.path));
		} catch (err) {
			if (entry.optional && err.code === 'ENOENT') continue;
			throw err;
		}
		blocks.push(
			tarHeader(`${name}/${entry.path}`, data.length, entry.mode ?? 0o644, false),
			data,
			padding(data.length),
		);
	}
	blocks.push(Buffer.alloc(1024));

	const gz = gzipSync(Buffer.concat(blocks), { level: 9 });
	// The header's OS byte is whatever platform zlib was built for; pin it to Unix
	// so a macOS and a Linux build of the same tree agree.
	gz[9] = 3;
	return gz;
}

/** A POSIX ustar header for one entry, with every variable field pinned. */
function tarHeader(path, size, mode, isDir) {
	if (Buffer.byteLength(path) > 100) throw new Error(`tar entry name too long: ${path}`);
	const header = Buffer.alloc(512);
	const field = (offset, length, value) => header.write(value, offset, length, 'ascii');
	const octal = (offset, length, value) =>
		field(offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
	field(0, 100, path);
	octal(100, 8, mode);
	octal(108, 8, 0); // uid
	octal(116, 8, 0); // gid
	octal(124, 12, size);
	octal(136, 12, 0); // mtime
	field(148, 8, ' '.repeat(8)); // checksum placeholder, summed as spaces
	field(156, 1, isDir ? '5' : '0');
	field(257, 6, 'ustar\0');
	field(263, 2, '00');
	let sum = 0;
	for (const byte of header) sum += byte;
	field(148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
	return header;
}

function padding(size) {
	return Buffer.alloc((512 - (size % 512)) % 512);
}
