/**
 * Fixtures for the worker runtime store (issue #1281): a minisign key pair and
 * signer built on `node:crypto` (no `minisign` binary), and a ustar `.tar.gz`
 * writer that packs the way `bin/build-worker-runtime.js` does.
 */

import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from 'node:crypto';
import { gzipSync } from 'node:zlib';

export interface MinisignTestKey {
	keyId: Buffer;
	privateKey: KeyObject;
	/** The `minisign.pub` text. */
	publicKey: string;
}

export function makeMinisignKey(keyId: Buffer = randomBytes(8)): MinisignTestKey {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
	const body = Buffer.concat([Buffer.from('Ed', 'latin1'), keyId, raw]).toString('base64');
	return {
		keyId,
		privateKey,
		publicKey: `untrusted comment: minisign public key test\n${body}\n`,
	};
}

/** A `.minisig` for `data`, as `minisign -S -t <trustedComment>` writes it. */
export function signMinisign(
	key: MinisignTestKey,
	data: Buffer,
	trustedComment: string,
	options: { algorithm?: 'ED' | 'Ed'; keyId?: Buffer } = {},
): string {
	const algorithm = options.algorithm ?? 'ED';
	const message = algorithm === 'ED' ? createHash('blake2b512').update(data).digest() : data;
	const signature = sign(null, message, key.privateKey);
	const sigLine = Buffer.concat([
		Buffer.from(algorithm, 'latin1'),
		options.keyId ?? key.keyId,
		signature,
	]).toString('base64');
	const globalSignature = sign(
		null,
		Buffer.concat([signature, Buffer.from(trustedComment, 'utf8')]),
		key.privateKey,
	);
	return [
		'untrusted comment: signature from minisign secret key',
		sigLine,
		`trusted comment: ${trustedComment}`,
		globalSignature.toString('base64'),
		'',
	].join('\n');
}

export interface TarEntry {
	name: string;
	/** Omitted for a directory (typeflag `5`). */
	data?: Buffer | string;
	/** Overrides the typeflag, for refusal tests. */
	typeflag?: string;
}

/** A ustar header, pinned the way `bin/build-worker-runtime.js` pins it. */
export function tarHeader(name: string, size: number, typeflag: string): Buffer {
	const header = Buffer.alloc(512);
	const field = (offset: number, length: number, value: string) =>
		header.write(value, offset, length, 'utf8');
	const octal = (offset: number, length: number, value: number) =>
		field(offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
	field(0, 100, name);
	octal(100, 8, typeflag === '5' ? 0o755 : 0o644);
	octal(108, 8, 0);
	octal(116, 8, 0);
	octal(124, 12, size);
	octal(136, 12, 0);
	field(148, 8, ' '.repeat(8));
	field(156, 1, typeflag);
	field(257, 6, 'ustar\0');
	field(263, 2, '00');
	let sum = 0;
	for (const byte of header) sum += byte;
	field(148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
	return header;
}

/** The uncompressed tar bytes for `entries`, end-of-archive blocks included. */
export function buildTar(entries: TarEntry[]): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const isDir = entry.data === undefined;
		const data = isDir ? Buffer.alloc(0) : Buffer.from(entry.data ?? '');
		blocks.push(tarHeader(entry.name, data.length, entry.typeflag ?? (isDir ? '5' : '0')));
		if (!isDir) blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
	}
	blocks.push(Buffer.alloc(1024));
	return Buffer.concat(blocks);
}

export const TEST_ENTRYPOINT_SOURCE = 'console.log("runtime");\n';

export interface RuntimeFixtureOptions {
	/** The stamp's `launcherProtocol`; `null` for a runtime predating it. Defaults to 1. */
	launcherProtocol?: number | null;
}

/** The entries of a runtime tarball for `version`, as the build script lays them out. */
export function runtimeEntries(
	version: string,
	commit?: string,
	options: RuntimeFixtureOptions = {},
): TarEntry[] {
	const launcherProtocol = options.launcherProtocol === undefined ? 1 : options.launcherProtocol;
	const top = `swarm-worker-runtime-${version}`;
	return [
		{ name: `${top}/` },
		{ name: `${top}/dist/` },
		{ name: `${top}/dist/transport/` },
		{
			name: `${top}/package.json`,
			data: `${JSON.stringify({ name: 'swarm-worker-runtime', version })}\n`,
		},
		...(commit
			? [
					{
						name: `${top}/build-info.json`,
						data: `${JSON.stringify({ version, commit, ...(launcherProtocol === null ? {} : { launcherProtocol }) })}\n`,
					},
				]
			: []),
		{ name: `${top}/dist/transport/connect-entry.mjs`, data: TEST_ENTRYPOINT_SOURCE },
	];
}

export function buildRuntimeTarball(
	version: string,
	commit?: string,
	options: RuntimeFixtureOptions = {},
): Buffer {
	return gzipSync(buildTar(runtimeEntries(version, commit, options)));
}
