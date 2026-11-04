import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
	formatKeyId,
	parseMinisig,
	parseMinisignPublicKey,
	verifyMinisign,
} from '@/launcher/minisign.js';
import { makeMinisignKey, signMinisign } from '../../helpers/runtime-fixtures.js';

const DATA = Buffer.from('the worker runtime tarball');
const COMMENT = 'swarm-worker-runtime 1.2.3 abcdef1234567';

describe('verifyMinisign', () => {
	const key = makeMinisignKey();

	it.each([
		'ED',
		'Ed',
	] as const)('accepts a %s signature and returns its trusted comment', (algorithm) => {
		const minisig = signMinisign(key, DATA, COMMENT, { algorithm });
		expect(verifyMinisign({ data: DATA, minisig, publicKey: key.publicKey })).toEqual({
			ok: true,
			trustedComment: COMMENT,
		});
	});

	it('accepts the bare base64 line of the public key', () => {
		const minisig = signMinisign(key, DATA, COMMENT);
		const bare = key.publicKey.split('\n')[1];
		expect(verifyMinisign({ data: DATA, minisig, publicKey: bare }).ok).toBe(true);
	});

	it('rejects a tampered byte of the data', () => {
		const minisig = signMinisign(key, DATA, COMMENT);
		const tampered = Buffer.from(DATA);
		tampered[0] ^= 1;
		expect(verifyMinisign({ data: tampered, minisig, publicKey: key.publicKey })).toEqual({
			ok: false,
			reason: 'the signature does not verify against the trusted key',
		});
	});

	it('rejects a swapped trusted comment through the global signature', () => {
		const minisig = signMinisign(key, DATA, COMMENT).replace('1.2.3', '9.9.9');
		expect(verifyMinisign({ data: DATA, minisig, publicKey: key.publicKey })).toEqual({
			ok: false,
			reason: 'the trusted comment does not verify against the trusted key',
		});
	});

	it('rejects a signature from a different key id, naming both ids', () => {
		const other = makeMinisignKey();
		const minisig = signMinisign(other, DATA, COMMENT);
		const result = verifyMinisign({ data: DATA, minisig, publicKey: key.publicKey });
		expect(result).toEqual({
			ok: false,
			reason: `signed by a different key (${formatKeyId(other.keyId)}), not the trusted key (${formatKeyId(key.keyId)})`,
		});
	});

	it('rejects a different key that claims the trusted key id', () => {
		const impostor = makeMinisignKey(key.keyId);
		const minisig = signMinisign(impostor, DATA, COMMENT);
		expect(verifyMinisign({ data: DATA, minisig, publicKey: key.publicKey })).toEqual({
			ok: false,
			reason: 'the signature does not verify against the trusted key',
		});
	});

	it('returns a reason, never a throw, for malformed input', () => {
		const minisig = signMinisign(key, DATA, COMMENT);
		const lines = minisig.split('\n');
		const cases: Array<[string, string]> = [
			[key.publicKey, ''],
			[key.publicKey, 'untrusted comment: x\n'],
			[key.publicKey, [lines[0], '!!not base64!!', lines[2], lines[3]].join('\n')],
			[
				key.publicKey,
				[lines[0], randomBytes(10).toString('base64'), lines[2], lines[3]].join('\n'),
			],
			[key.publicKey, [lines[0], lines[1], 'no trusted comment', lines[3]].join('\n')],
			[
				key.publicKey,
				[lines[0], lines[1], lines[2], randomBytes(10).toString('base64')].join('\n'),
			],
			[key.publicKey, ['not a comment', lines[1], lines[2], lines[3]].join('\n')],
			['', minisig],
			['untrusted comment: k\n####', minisig],
			[randomBytes(42).toString('base64'), minisig],
			[randomBytes(12).toString('base64'), minisig],
		];
		for (const [publicKey, sig] of cases) {
			const result = verifyMinisign({ data: DATA, minisig: sig, publicKey });
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toMatch(/\S/);
		}
	});
});

describe('parsers', () => {
	it('reads the algorithm, key id and trusted comment of a .minisig', () => {
		const key = makeMinisignKey(Buffer.from('0102030405060708', 'hex'));
		const parsed = parseMinisig(signMinisign(key, DATA, COMMENT, { algorithm: 'Ed' }));
		expect(parsed).toMatchObject({ algorithm: 'Ed', trustedComment: COMMENT });
		if (!('error' in parsed)) expect(formatKeyId(parsed.keyId)).toBe('0807060504030201');
	});

	it('refuses an unknown signature algorithm', () => {
		const key = makeMinisignKey();
		const lines = signMinisign(key, DATA, COMMENT).split('\n');
		const raw = Buffer.from(lines[1], 'base64');
		raw.write('XX', 0, 'latin1');
		lines[1] = raw.toString('base64');
		expect(parseMinisig(lines.join('\n'))).toEqual({
			error: 'the signature algorithm "XX" is not supported',
		});
	});

	it('refuses a public key that is not an Ed key', () => {
		const key = makeMinisignKey();
		const raw = Buffer.from(key.publicKey.split('\n')[1], 'base64');
		raw.write('RW', 0, 'latin1');
		expect(parseMinisignPublicKey(raw.toString('base64'))).toEqual({
			error: 'the public key is not an Ed25519 minisign key',
		});
	});
});
