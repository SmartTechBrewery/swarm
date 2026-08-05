import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { validateMigrationJournal } from '@/db/migration-journal.js';

const THIS_DIR = dirname(fileURLToPath(import.meta.url));

const roots: string[] = [];

/** A migrations dir with `.sql` files and a matching `meta/_journal.json`/snapshots for each tag. */
function migrationsDir(tags: Array<{ tag: string; when: number }>): string {
	const root = mkdtempSync(join(tmpdir(), 'swarm-migration-journal-'));
	roots.push(root);
	mkdirSync(join(root, 'meta'), { recursive: true });
	tags.forEach(({ tag }, idx) => {
		writeFileSync(join(root, `${tag}.sql`), `-- ${idx}\n`);
		writeFileSync(join(root, 'meta', `${tag.slice(0, 4)}_snapshot.json`), '{}');
	});
	writeFileSync(
		join(root, 'meta', '_journal.json'),
		JSON.stringify({
			version: '7',
			dialect: 'postgresql',
			entries: tags.map(({ tag, when }, idx) => ({
				idx,
				version: '7',
				when,
				tag,
				breakpoints: true,
			})),
		}),
	);
	return root;
}

afterEach(() => {
	while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe('validateMigrationJournal', () => {
	it('is clean for a well-formed journal', () => {
		const dir = migrationsDir([
			{ tag: '0000_first', when: 1000 },
			{ tag: '0001_second', when: 2000 },
			{ tag: '0002_third', when: 3000 },
		]);
		expect(validateMigrationJournal(dir)).toEqual([]);
	});

	it('flags a phantom entry naming a .sql file that was never committed', () => {
		const dir = migrationsDir([
			{ tag: '0000_first', when: 1000 },
			{ tag: '0001_second', when: 2000 },
		]);
		// The exact PR #508 shape: a journal entry with no matching .sql/snapshot on disk.
		writeFileSync(
			join(dir, 'meta', '_journal.json'),
			JSON.stringify({
				version: '7',
				dialect: 'postgresql',
				entries: [
					{ idx: 0, version: '7', when: 1000, tag: '0000_first', breakpoints: true },
					{ idx: 1, version: '7', when: 2000, tag: '0001_second', breakpoints: true },
					{ idx: 2, version: '7', when: 3000, tag: '0002_phantom', breakpoints: true },
				],
			}),
		);
		const issues = validateMigrationJournal(dir);
		expect(issues).toEqual(
			expect.arrayContaining([
				expect.stringContaining('3 entries but 2 .sql files'),
				expect.stringContaining('names "0002_phantom", but'),
				expect.stringContaining('no matching snapshot'),
			]),
		);
	});

	it('flags a migration renumbered to an earlier "when" than the one ahead of it', () => {
		const dir = migrationsDir([
			{ tag: '0000_first', when: 1000 },
			{ tag: '0001_second', when: 2000 },
			// The exact PR #508 shape: the branch's own migration renumbered after
			// a merge, but its timestamp left below the entry now ahead of it.
			{ tag: '0002_third', when: 1500 },
		]);
		const issues = validateMigrationJournal(dir);
		expect(issues).toEqual([
			expect.stringContaining(
				"when=1500, not strictly greater than the previous entry's when=2000",
			),
		]);
	});

	it('flags an idx that does not match its array position', () => {
		const dir = migrationsDir([
			{ tag: '0000_first', when: 1000 },
			{ tag: '0001_second', when: 2000 },
		]);
		writeFileSync(
			join(dir, 'meta', '_journal.json'),
			JSON.stringify({
				version: '7',
				dialect: 'postgresql',
				entries: [
					{ idx: 0, version: '7', when: 1000, tag: '0000_first', breakpoints: true },
					{ idx: 2, version: '7', when: 2000, tag: '0001_second', breakpoints: true },
				],
			}),
		);
		expect(validateMigrationJournal(dir)).toEqual([
			expect.stringContaining('array position 1 has idx 2'),
		]);
	});

	it('reports a missing journal file rather than throwing', () => {
		const root = mkdtempSync(join(tmpdir(), 'swarm-migration-journal-'));
		roots.push(root);
		mkdirSync(join(root, 'meta'), { recursive: true });
		expect(validateMigrationJournal(root)).toEqual([
			expect.stringContaining('No migration journal found'),
		]);
	});

	it('reports invalid JSON rather than throwing', () => {
		const root = mkdtempSync(join(tmpdir(), 'swarm-migration-journal-'));
		roots.push(root);
		mkdirSync(join(root, 'meta'), { recursive: true });
		writeFileSync(join(root, 'meta', '_journal.json'), '{not json');
		expect(validateMigrationJournal(root)).toEqual([expect.stringContaining('not valid JSON')]);
	});

	// The regression guard (issue #514 follow-up): this exact class of defect —
	// a resolve-conflicts merge leaving the real, committed journal
	// inconsistent with the real, committed .sql files — is what let PR #508
	// keep failing review for a cause unrelated to its own changes. Run against
	// the actual repo state, not a fixture, so any future merge that reproduces
	// it fails `npm test` immediately instead of surfacing three review passes
	// later.
	it("is clean against this repo's own committed migrations", () => {
		const repoMigrationsDir = join(THIS_DIR, '../../../src/db/migrations');
		expect(validateMigrationJournal(repoMigrationsDir)).toEqual([]);
	});
});
