/**
 * **Minisign verification** for the worker runtime (issue #1281, phase 1), with
 * nothing but `node:crypto`: Ed25519 for the signatures and BLAKE2b-512 for the
 * prehashed (`ED`) form `minisign -S` writes by default since 0.10.
 *
 * The formats are minisign's own:
 *
 *   - **public key** — an `untrusted comment:` line, then base64 of 42 bytes:
 *     `Ed` ‖ 8-byte key id ‖ 32-byte Ed25519 public key.
 *   - **`.minisig`** — an `untrusted comment:` line; base64 of 74 bytes:
 *     algorithm (`Ed` legacy, `ED` prehashed) ‖ 8-byte key id ‖ 64-byte signature;
 *     a `trusted comment: <text>` line; and base64 of the 64-byte **global**
 *     signature over `signature ‖ <text>`, which is what makes the trusted comment
 *     the publisher's rather than whoever handed the file over.
 *
 * Every malformed input is a reason string, never a throw: a caller deciding
 * whether to install a runtime wants one answer, not an exception to classify.
 *
 * No imports from the daemon graph: the launcher (phase 2) bundles this module.
 */

import { createHash, createPublicKey, type KeyObject, verify } from 'node:crypto';

/** The DER prefix that wraps a raw 32-byte Ed25519 key as SPKI. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const KEY_ID_BYTES = 8;
const PUBLIC_KEY_BYTES = 2 + KEY_ID_BYTES + 32;
const SIGNATURE_BYTES = 2 + KEY_ID_BYTES + 64;
const GLOBAL_SIGNATURE_BYTES = 64;
const TRUSTED_COMMENT_PREFIX = 'trusted comment: ';
const UNTRUSTED_COMMENT_PREFIX = 'untrusted comment:';

export interface MinisignPublicKey {
	keyId: Buffer;
	key: KeyObject;
}

export interface MinisignSignature {
	/** `ED` (BLAKE2b-512 prehashed) or `Ed` (legacy, the whole message). */
	algorithm: 'ED' | 'Ed';
	keyId: Buffer;
	signature: Buffer;
	/** The trusted comment's text, without its `trusted comment: ` prefix. */
	trustedComment: string;
	globalSignature: Buffer;
}

export type MinisignVerification =
	| { ok: true; trustedComment: string }
	| { ok: false; reason: string };

/** Strict base64: the alphabet and padding only, so junk is not silently dropped. */
function decodeBase64(text: string, bytes: number, what: string): Buffer | { error: string } {
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return { error: `${what} is not valid base64` };
	const decoded = Buffer.from(text, 'base64');
	if (decoded.length !== bytes)
		return { error: `${what} is ${decoded.length} bytes, expected ${bytes}` };
	return decoded;
}

/** A key id as minisign prints it: the little-endian 64-bit number, upper-case hex. */
export function formatKeyId(keyId: Buffer): string {
	return Buffer.from(keyId).reverse().toString('hex').toUpperCase();
}

function contentLines(text: string): string[] {
	return text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/**
 * Parse a minisign public key: either the whole `minisign.pub` file or its bare
 * base64 line. The last non-comment line is the key.
 */
export function parseMinisignPublicKey(text: string): MinisignPublicKey | { error: string } {
	const lines = contentLines(text).filter((line) => !line.startsWith(UNTRUSTED_COMMENT_PREFIX));
	const last = lines.at(-1);
	if (!last) return { error: 'the public key is empty' };
	const raw = decodeBase64(last, PUBLIC_KEY_BYTES, 'the public key');
	if (!Buffer.isBuffer(raw)) return raw;
	if (raw.subarray(0, 2).toString('latin1') !== 'Ed')
		return { error: 'the public key is not an Ed25519 minisign key' };
	try {
		const key = createPublicKey({
			key: Buffer.concat([ED25519_SPKI_PREFIX, raw.subarray(2 + KEY_ID_BYTES)]),
			format: 'der',
			type: 'spki',
		});
		return { keyId: raw.subarray(2, 2 + KEY_ID_BYTES), key };
	} catch (err) {
		return { error: `the public key is not a usable Ed25519 key: ${(err as Error).message}` };
	}
}

/** Parse a `.minisig` file's four lines. */
export function parseMinisig(text: string): MinisignSignature | { error: string } {
	const lines = text.split(/\r?\n/);
	if (lines.length < 4) return { error: 'the signature is truncated' };
	const [untrusted, sigLine, trustedLine, globalLine] = lines.map((line) =>
		line.replace(/\r$/, ''),
	);
	if (!untrusted.startsWith(UNTRUSTED_COMMENT_PREFIX))
		return { error: 'the signature does not start with an untrusted comment' };

	const raw = decodeBase64(sigLine.trim(), SIGNATURE_BYTES, 'the signature');
	if (!Buffer.isBuffer(raw)) return raw;
	const algorithm = raw.subarray(0, 2).toString('latin1');
	if (algorithm !== 'ED' && algorithm !== 'Ed')
		return { error: `the signature algorithm ${JSON.stringify(algorithm)} is not supported` };

	if (!trustedLine.startsWith(TRUSTED_COMMENT_PREFIX))
		return { error: 'the signature has no trusted comment' };
	const globalSignature = decodeBase64(
		globalLine.trim(),
		GLOBAL_SIGNATURE_BYTES,
		'the global signature',
	);
	if (!Buffer.isBuffer(globalSignature)) return globalSignature;

	return {
		algorithm,
		keyId: raw.subarray(2, 2 + KEY_ID_BYTES),
		signature: raw.subarray(2 + KEY_ID_BYTES),
		trustedComment: trustedLine.slice(TRUSTED_COMMENT_PREFIX.length),
		globalSignature,
	};
}

function ed25519Verify(message: Buffer, key: KeyObject, signature: Buffer): boolean {
	try {
		return verify(null, message, key, signature);
	} catch {
		return false;
	}
}

/**
 * Verify `data` against a `.minisig` and the trusted public key: the key ids
 * match, the signature covers the data, and the global signature covers the
 * signature and the trusted comment. Never throws.
 */
export function verifyMinisign(input: {
	data: Buffer;
	minisig: string;
	publicKey: string;
}): MinisignVerification {
	const key = parseMinisignPublicKey(input.publicKey);
	if ('error' in key) return { ok: false, reason: key.error };
	const sig = parseMinisig(input.minisig);
	if ('error' in sig) return { ok: false, reason: sig.error };

	if (!sig.keyId.equals(key.keyId))
		return {
			ok: false,
			reason: `signed by a different key (${formatKeyId(sig.keyId)}), not the trusted key (${formatKeyId(key.keyId)})`,
		};

	const message =
		sig.algorithm === 'ED' ? createHash('blake2b512').update(input.data).digest() : input.data;
	if (!ed25519Verify(message, key.key, sig.signature))
		return { ok: false, reason: 'the signature does not verify against the trusted key' };

	const signed = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, 'utf8')]);
	if (!ed25519Verify(signed, key.key, sig.globalSignature))
		return { ok: false, reason: 'the trusted comment does not verify against the trusted key' };

	return { ok: true, trustedComment: sig.trustedComment };
}
