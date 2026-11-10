import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../../../src/db/client.js';
import {
	addBugReportOccurrence,
	findOccurrenceFiledByRun,
	getBugReport,
	insertBugReport,
	listBugReportOccurrences,
	listBugReports,
	type NewBugReport,
	type NewBugReportOccurrence,
	updateBugReportStatus,
} from '../../../src/db/repositories/bugReportsRepository.js';
import { bugReportOccurrences, bugReports } from '../../../src/db/schema/bugReports.js';
import { truncateAll } from '../helpers/db.js';

const FILER = {
	filedByUserId: '22222222-2222-4222-8222-222222222222',
	filedByUserIdentifier: 'member@example.com',
	filedByRunId: null,
};

function newReport(overrides: Partial<NewBugReport> = {}): NewBugReport {
	return {
		title: 'Dispatch never claimed',
		description: 'A board dispatch sat waiting with an online worker.',
		status: 'new',
		projectId: 'proj-a',
		...FILER,
		...overrides,
	};
}

function occurrence(overrides: Partial<NewBugReportOccurrence> = {}): NewBugReportOccurrence {
	return {
		runId: null,
		dispatchId: null,
		taskId: null,
		repository: null,
		prNumber: null,
		note: null,
		...FILER,
		...overrides,
	};
}

async function file(overrides: Partial<NewBugReport> = {}, observedAt?: Date) {
	const { report } = await insertBugReport({
		report: newReport(overrides),
		occurrence: occurrence({ observedAt }),
	});
	return report;
}

const LIST = { includeInstallationWide: true, projectIds: null, limit: 50, offset: 0 };

// issue #1383 — only Postgres can prove the transactions, the counters, the scope
// filter's SQL, the ILIKE escaping and the duplicate FK's `set null`.
describe.skipIf(!process.env.SWARM_TEST_DB_AVAILABLE)('bugReportsRepository', () => {
	beforeEach(async () => {
		await truncateAll();
	});

	it('files a report with its first occurrence and a count of 1, with no project FK', async () => {
		const at = new Date('2026-11-01T10:00:00Z');
		const { report, occurrence: first } = await insertBugReport({
			report: newReport({ projectId: 'no-such-project' }),
			occurrence: occurrence({ runId: 'run-1', prNumber: 7, observedAt: at }),
		});

		expect(report).toMatchObject({
			projectId: 'no-such-project',
			occurrenceCount: 1,
			firstSeenAt: at,
			lastSeenAt: at,
			duplicateOfId: null,
		});
		expect(first).toMatchObject({ reportId: report.id, runId: 'run-1', prNumber: 7 });
		expect(await getDb().select().from(bugReportOccurrences)).toHaveLength(1);
	});

	it('adds an occurrence, bumping the count and the last seen time together', async () => {
		const report = await file({}, new Date('2026-11-01T10:00:00Z'));
		const later = new Date('2026-11-02T10:00:00Z');

		const added = await addBugReportOccurrence(
			report.id,
			occurrence({ note: 'again', observedAt: later }),
		);

		expect(added?.report).toMatchObject({ occurrenceCount: 2, lastSeenAt: later });
		expect(added?.report.firstSeenAt).toEqual(report.firstSeenAt);
		const occurrences = await listBugReportOccurrences(report.id, { limit: 10 });
		expect(occurrences.map((row) => row.note)).toEqual(['again', null]);
	});

	it('adds nothing to a report that does not exist', async () => {
		await expect(
			addBugReportOccurrence('11111111-1111-4111-8111-111111111111', occurrence()),
		).resolves.toBeUndefined();
		expect(await getDb().select().from(bugReportOccurrences)).toHaveLength(0);
	});

	it('lists by status and scope, most recently seen first, with the total', async () => {
		const older = await file({ projectId: 'proj-a' }, new Date('2026-11-01T00:00:00Z'));
		const newer = await file({ projectId: 'proj-b' }, new Date('2026-11-03T00:00:00Z'));
		const wide = await file({ projectId: null }, new Date('2026-11-02T00:00:00Z'));
		await file({ projectId: 'proj-a', status: 'resolved' });

		const all = await listBugReports({ ...LIST, statuses: ['new'], limit: 2 });
		expect(all.total).toBe(3);
		expect(all.data.map((row) => row.id)).toEqual([newer.id, wide.id]);

		const projectsOnly = await listBugReports({
			...LIST,
			statuses: ['new'],
			includeInstallationWide: false,
		});
		expect(projectsOnly.data.map((row) => row.id)).toEqual([newer.id, older.id]);

		const scoped = await listBugReports({
			...LIST,
			statuses: ['new'],
			projectIds: ['proj-a'],
			includeInstallationWide: false,
		});
		expect(scoped.data.map((row) => row.id)).toEqual([older.id]);

		const noProjects = await listBugReports({ ...LIST, statuses: ['new'], projectIds: [] });
		expect(noProjects.data.map((row) => row.id)).toEqual([wide.id]);

		const none = await listBugReports({
			...LIST,
			statuses: ['new'],
			projectIds: [],
			includeInstallationWide: false,
		});
		expect(none).toEqual({ data: [], total: 0 });
	});

	it('searches title and description case-insensitively, matching % and _ literally', async () => {
		const percent = await file({ title: 'Quota at 100% reported as 0' });
		const underscore = await file({ title: 'other', description: 'bad worker_id in a lease' });
		await file({ title: 'Quota at 1000 reported', description: 'workerXid' });

		const byPercent = await listBugReports({ ...LIST, statuses: ['new'], query: '100%' });
		expect(byPercent.data.map((row) => row.id)).toEqual([percent.id]);

		const byUnderscore = await listBugReports({ ...LIST, statuses: ['new'], query: 'WORKER_ID' });
		expect(byUnderscore.data.map((row) => row.id)).toEqual([underscore.id]);
	});

	it('writes a status change, and sets the duplicate target to null when it is deleted', async () => {
		const original = await file();
		const copy = await file();

		const updated = await updateBugReportStatus(copy.id, {
			status: 'duplicate',
			duplicateOfId: original.id,
			githubIssueUrl: null,
			statusChanged: true,
		});
		expect(updated).toMatchObject({ status: 'duplicate', duplicateOfId: original.id });
		expect(updated?.statusChangedAt).toBeInstanceOf(Date);

		await getDb().delete(bugReports).where(eq(bugReports.id, original.id));
		expect((await getBugReport(copy.id))?.duplicateOfId).toBeNull();
	});

	// issue #1395 — the Resolve problem settle's proof that the run filed something.
	it('finds the newest occurrence a run filed, whether it filed the report or added to one', async () => {
		const { report: own, occurrence: first } = await insertBugReport({
			report: newReport({ filedByRunId: 'run-agent' }),
			occurrence: occurrence({
				filedByRunId: 'run-agent',
				observedAt: new Date('2026-11-01T10:00:00Z'),
			}),
		});
		expect(await findOccurrenceFiledByRun('run-agent')).toEqual({
			id: first.id,
			reportId: own.id,
		});

		const other = await file({ title: 'Merge never retried' });
		const added = await addBugReportOccurrence(
			other.id,
			occurrence({ filedByRunId: 'run-agent', observedAt: new Date('2026-11-01T11:00:00Z') }),
		);
		expect(await findOccurrenceFiledByRun('run-agent')).toEqual({
			id: added?.occurrence.id,
			reportId: other.id,
		});

		// An occurrence filed by a person, or by another run, is not this run's.
		expect(await findOccurrenceFiledByRun('run-other')).toBeUndefined();
	});
});
