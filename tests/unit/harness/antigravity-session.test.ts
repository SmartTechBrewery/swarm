import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectNewConversationId, snapshotConversationIds } from '@/harness/antigravity-session.js';

describe('antigravity-session', () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), 'agy-conv-'));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const touch = (name: string): void => writeFileSync(path.join(dir, name), '');

	it('snapshots only conversation .db basenames, ignoring -wal/-shm companions', () => {
		touch('aaaa.db');
		touch('aaaa.db-wal');
		touch('aaaa.db-shm');
		touch('bbbb.db');
		expect(snapshotConversationIds(dir)).toEqual(new Set(['aaaa', 'bbbb']));
	});

	it('returns an empty set when the store does not exist', () => {
		expect(snapshotConversationIds(path.join(dir, 'missing'))).toEqual(new Set());
	});

	it('detects the single new conversation created since the snapshot', () => {
		const before = snapshotConversationIds(dir);
		touch('new-conv.db');
		expect(detectNewConversationId(before, dir)).toBe('new-conv');
	});

	it('returns undefined when nothing new appeared', () => {
		touch('existing.db');
		const before = snapshotConversationIds(dir);
		expect(detectNewConversationId(before, dir)).toBeUndefined();
	});

	it('returns undefined when multiple new conversations are ambiguous (never guesses)', () => {
		// When two agy runs overlap on one machine (an enrollment whose
		// concurrencyAllocation is above 1) the concurrent run can create its own
		// conversation in the window; guessing would risk resuming a sibling task's
		// session, so capture is skipped and the retry starts fresh instead.
		const before = snapshotConversationIds(dir);
		touch('conv-a.db');
		touch('conv-b.db');
		expect(detectNewConversationId(before, dir)).toBeUndefined();
	});
});
