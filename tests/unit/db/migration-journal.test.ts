import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type MigrationJournal = {
	entries: Array<{
		when: number;
		tag: string;
	}>;
};

const migrationsPath = fileURLToPath(new URL('../../../src/db/migrations/', import.meta.url));
const journal = JSON.parse(
	readFileSync(
		fileURLToPath(new URL('../../../src/db/migrations/meta/_journal.json', import.meta.url)),
		'utf8',
	),
) as MigrationJournal;

describe('migration journal', () => {
	it('matches the committed migration files, snapshots, and application order', () => {
		const sqlFiles = readdirSync(migrationsPath).filter((file) => file.endsWith('.sql'));

		expect(journal.entries).toHaveLength(sqlFiles.length);

		for (const [index, entry] of journal.entries.entries()) {
			expect(existsSync(`${migrationsPath}${entry.tag}.sql`)).toBe(true);
			expect(existsSync(`${migrationsPath}meta/${entry.tag.slice(0, 4)}_snapshot.json`)).toBe(true);

			if (index > 0) {
				expect(entry.when).toBeGreaterThan(journal.entries[index - 1].when);
			}
		}
	});
});
