/**
 * Drizzle migration-journal integrity check (issue #514 follow-up).
 *
 * `src/db/migrations/meta/_journal.json` and the numbered `.sql` files beside
 * it are drizzle-kit-generated artifacts with invariants nothing in this repo
 * enforced until now: every journal entry must name a `.sql` file and a `meta/
 * <idx>_snapshot.json` that actually exist, the entry count must equal the
 * `.sql` file count (one entry per file, never a phantom or a missing one),
 * and `when` must strictly increase across entries — `PgDialect.migrate`
 * (drizzle-orm) applies only entries whose `when` exceeds the database's last
 * applied timestamp, so an out-of-order entry is silently *skipped*, not
 * merely misordered.
 *
 * Confirmed live on PR #508 (issue #503): three `resolve-conflicts` merges of
 * `main` into a long-lived branch that also added migrations left the journal
 * naming a `.sql` file that was never committed (a phantom entry) and gave the
 * branch's own renumbered migration a `when` earlier than the migration
 * already ahead of it on `main` — so on any database already migrated past
 * that point, the branch's own schema change would silently never apply. A
 * generic "resolve every conflict" merge prompt has no way to know these
 * invariants exist; this validator is the deterministic backstop.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

interface JournalEntry {
	idx: number;
	when: number;
	tag: string;
}

interface Journal {
	entries: JournalEntry[];
}

/**
 * Validate `<migrationsDir>/meta/_journal.json` against the `.sql` files
 * beside it. Returns one human-readable problem per violation, or `[]` when
 * the journal is internally consistent — never throws for a malformed
 * journal, so a caller (a repair-loop gate, a unit test) can report every
 * problem at once rather than stopping at the first.
 */
export function validateMigrationJournal(migrationsDir: string): string[] {
	const journalPath = join(migrationsDir, 'meta', '_journal.json');
	if (!existsSync(journalPath)) {
		return [`No migration journal found at ${journalPath}.`];
	}

	let journal: Journal;
	try {
		journal = JSON.parse(readFileSync(journalPath, 'utf8'));
	} catch (error) {
		return [
			`${journalPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		];
	}
	if (!Array.isArray(journal.entries)) {
		return [`${journalPath} has no "entries" array.`];
	}

	const issues: string[] = [];
	const sqlFileCount = readdirSync(migrationsDir).filter((name) => name.endsWith('.sql')).length;
	if (journal.entries.length !== sqlFileCount) {
		issues.push(
			`_journal.json has ${journal.entries.length} entries but ${sqlFileCount} .sql files exist in ${migrationsDir} — every entry must name exactly one committed migration file, one-to-one (a merge likely left a phantom entry or dropped a file).`,
		);
	}

	let previousWhen: number | undefined;
	journal.entries.forEach((entry, position) => {
		if (entry.idx !== position) {
			issues.push(
				`_journal.json entry at array position ${position} has idx ${entry.idx} ("${entry.tag}") — entries must be in idx order with no gaps or duplicates.`,
			);
		}
		const sqlPath = join(migrationsDir, `${entry.tag}.sql`);
		if (!existsSync(sqlPath)) {
			issues.push(
				`_journal.json entry idx ${entry.idx} names "${entry.tag}", but ${sqlPath} does not exist.`,
			);
		}
		const snapshotPath = join(migrationsDir, 'meta', `${entry.tag.slice(0, 4)}_snapshot.json`);
		if (!existsSync(snapshotPath)) {
			issues.push(
				`_journal.json entry idx ${entry.idx} ("${entry.tag}") has no matching snapshot at ${snapshotPath}.`,
			);
		}
		if (previousWhen !== undefined && entry.when <= previousWhen) {
			issues.push(
				`_journal.json entry idx ${entry.idx} ("${entry.tag}") has when=${entry.when}, not strictly greater than the previous entry's when=${previousWhen} — drizzle applies migrations in "when" order off the database's last-applied timestamp, so this entry would be silently skipped (not merely misordered) on any database already migrated past the previous entry.`,
			);
		}
		previousWhen = entry.when;
	});

	return issues;
}
