import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The `bugReports` router (issue #1383) against mocked repositories and memberships:
 * who may read and write which report, where a report's project comes from, the
 * status rules, and that each preview runs the same plan as its mutation. The SQL
 * itself is `tests/integration/db/bugReportsRepository.test.ts`'s.
 */
vi.mock('@/db/repositories/bugReportsRepository.js', () => ({
	addBugReportOccurrence: vi.fn(),
	getBugReport: vi.fn(),
	insertBugReport: vi.fn(),
	listBugReportOccurrences: vi.fn(),
	listBugReports: vi.fn(),
	updateBugReportStatus: vi.fn(),
}));

vi.mock('@/db/repositories/runsRepository.js', () => ({
	getRunByIdFromDb: vi.fn(),
}));

vi.mock('@/identity/membership-service.js', () => ({
	getMembership: vi.fn(),
	listAccessibleProjectIds: vi.fn(),
}));

import { validateStatusChange } from '@/api/bug-reports.js';
import { bugReportsRouter } from '@/api/routers/bugReports.js';
import {
	addBugReportOccurrence,
	type BugReportRow,
	getBugReport,
	insertBugReport,
	listBugReportOccurrences,
	listBugReports,
	updateBugReportStatus,
} from '@/db/repositories/bugReportsRepository.js';
import { getRunByIdFromDb } from '@/db/repositories/runsRepository.js';
import type { ProjectRole } from '@/identity/membership.js';
import { getMembership, listAccessibleProjectIds } from '@/identity/membership-service.js';
import { type SwarmUser, scopeUserToProjects } from '@/identity/schema.js';

const ADMIN: SwarmUser = {
	id: '00000000-0000-4000-8000-000000000000',
	identifier: 'admin@example.com',
	displayName: 'Admin',
	instanceAdmin: true,
	createdAt: new Date(0),
	updatedAt: new Date(0),
};

const USER: SwarmUser = {
	id: '00000000-0000-4000-8000-0000000000ff',
	identifier: 'member@example.com',
	displayName: 'Member',
	instanceAdmin: false,
	createdAt: new Date(0),
	updatedAt: new Date(0),
};

const REPORT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';

function report(overrides: Partial<BugReportRow> = {}): BugReportRow {
	return {
		id: REPORT_ID,
		title: 'Dispatch never claimed',
		description: 'A board dispatch sat waiting with an online worker.',
		status: 'new',
		projectId: 'p1',
		duplicateOfId: null,
		githubIssueUrl: null,
		filedByUserId: USER.id,
		filedByUserIdentifier: USER.identifier,
		filedByRunId: null,
		occurrenceCount: 1,
		firstSeenAt: new Date(0),
		lastSeenAt: new Date(0),
		statusChangedAt: null,
		createdAt: new Date(0),
		updatedAt: new Date(0),
		...overrides,
	};
}

/** `USER` holds `role` on `p1` (and on `also` when given), nothing elsewhere. */
function grant(role: ProjectRole | undefined, also: Record<string, ProjectRole> = {}) {
	vi.mocked(getMembership).mockImplementation(async (_userId, projectId) => {
		const held = projectId === 'p1' ? role : also[projectId];
		return held
			? { id: 'm', projectId, userId: USER.id, role: held, createdAt: new Date(0) }
			: undefined;
	});
}

function runIn(projectId: string) {
	return { id: 'run-1', projectId } as Awaited<ReturnType<typeof getRunByIdFromDb>>;
}

const admin = bugReportsRouter.createCaller({ user: ADMIN });
const user = bugReportsRouter.createCaller({ user: USER });

const code = (value: string) => expect.objectContaining({ code: value });

beforeEach(() => {
	vi.mocked(getBugReport).mockReset();
	vi.mocked(getRunByIdFromDb).mockReset();
	vi.mocked(getMembership).mockReset();
	vi.mocked(listAccessibleProjectIds).mockReset();
	vi.mocked(listBugReports).mockReset().mockResolvedValue({ data: [], total: 0 });
	vi.mocked(listBugReportOccurrences).mockReset().mockResolvedValue([]);
	vi.mocked(insertBugReport).mockReset();
	vi.mocked(addBugReportOccurrence).mockReset();
	vi.mocked(updateBugReportStatus).mockReset();
});

describe('list', () => {
	it('defaults to the open statuses over the caller’s projects, without installation-wide reports', async () => {
		vi.mocked(listAccessibleProjectIds).mockResolvedValue(['p1', 'p2']);

		await user.list({});

		expect(listBugReports).toHaveBeenCalledWith({
			statuses: ['new', 'confirmed', 'environmental', 'ticketed'],
			projectIds: ['p1', 'p2'],
			includeInstallationWide: false,
			query: undefined,
			limit: 50,
			offset: 0,
		});
	});

	it('gives an instance admin every project and the installation-wide reports', async () => {
		await admin.list({ status: 'resolved', query: '50%_off' });

		expect(listBugReports).toHaveBeenCalledWith(
			expect.objectContaining({
				statuses: ['resolved'],
				projectIds: null,
				includeInstallationWide: true,
				query: '50%_off',
			}),
		);
	});

	it('narrows to one project for its contributor, and hides it from a non-member', async () => {
		grant('contributor');
		await user.list({ projectId: 'p1', status: ['duplicate', 'dismissed'] });
		expect(listBugReports).toHaveBeenCalledWith(
			expect.objectContaining({
				statuses: ['duplicate', 'dismissed'],
				projectIds: ['p1'],
				includeInstallationWide: false,
			}),
		);

		await expect(user.list({ projectId: 'p9' })).rejects.toThrowError(code('NOT_FOUND'));
	});

	it('never shows a scoped agent credential installation-wide reports', async () => {
		const scoped = bugReportsRouter.createCaller({ user: scopeUserToProjects(ADMIN, ['p1']) });

		await scoped.list({});

		expect(listBugReports).toHaveBeenCalledWith(
			expect.objectContaining({ projectIds: ['p1'], includeInstallationWide: false }),
		);
	});
});

describe('get', () => {
	it('returns the report, its occurrences and a readable duplicate target', async () => {
		grant('contributor');
		vi.mocked(getBugReport).mockImplementation(async (id) =>
			id === REPORT_ID
				? report({ status: 'duplicate', duplicateOfId: OTHER_ID })
				: report({ id: OTHER_ID, title: 'Original', status: 'confirmed' }),
		);

		const result = await user.get({ reportId: REPORT_ID });

		expect(result.duplicateOf).toEqual({ id: OTHER_ID, title: 'Original', status: 'confirmed' });
		expect(listBugReportOccurrences).toHaveBeenCalledWith(REPORT_ID, { limit: 50 });
	});

	it('hides a duplicate target the caller cannot read', async () => {
		grant('contributor');
		vi.mocked(getBugReport).mockImplementation(async (id) =>
			id === REPORT_ID
				? report({ status: 'duplicate', duplicateOfId: OTHER_ID })
				: report({ id: OTHER_ID, projectId: 'p-secret' }),
		);

		expect((await user.get({ reportId: REPORT_ID })).duplicateOf).toBeNull();
	});

	it('reads as not found for a non-member, and for an installation-wide report to a non-admin', async () => {
		grant(undefined);
		vi.mocked(getBugReport).mockResolvedValue(report());
		await expect(user.get({ reportId: REPORT_ID })).rejects.toThrowError(
			expect.objectContaining({
				code: 'NOT_FOUND',
				message: `Bug report "${REPORT_ID}" not found.`,
			}),
		);

		vi.mocked(getBugReport).mockResolvedValue(report({ projectId: null }));
		await expect(user.get({ reportId: REPORT_ID })).rejects.toThrowError(code('NOT_FOUND'));
		await expect(admin.get({ reportId: REPORT_ID })).resolves.toMatchObject({
			report: { projectId: null },
		});
	});
});

describe('create', () => {
	const INPUT = { title: 'Lease lost', description: 'The worker lease lapsed mid-run.' };

	it('takes the project from the run and files the first occurrence as the caller', async () => {
		grant('member');
		vi.mocked(getRunByIdFromDb).mockResolvedValue(runIn('p1'));
		vi.mocked(insertBugReport).mockResolvedValue({
			report: report(),
		} as Awaited<ReturnType<typeof insertBugReport>>);

		await user.create({ ...INPUT, runId: 'run-1', prNumber: 7, note: 'lease 3' });

		expect(insertBugReport).toHaveBeenCalledWith({
			report: {
				...INPUT,
				status: 'new',
				projectId: 'p1',
				filedByUserId: USER.id,
				filedByUserIdentifier: USER.identifier,
				filedByRunId: null,
			},
			occurrence: {
				runId: 'run-1',
				dispatchId: null,
				taskId: null,
				repository: null,
				prNumber: 7,
				note: 'lease 3',
				filedByUserId: USER.id,
				filedByUserIdentifier: USER.identifier,
				filedByRunId: null,
			},
		});
	});

	it('refuses a run of another project than the one named', async () => {
		grant('member', { p2: 'member' });
		vi.mocked(getRunByIdFromDb).mockResolvedValue(runIn('p2'));

		await expect(user.create({ ...INPUT, projectId: 'p1', runId: 'run-1' })).rejects.toThrowError(
			code('BAD_REQUEST'),
		);
		expect(insertBugReport).not.toHaveBeenCalled();
	});

	it('reads a run the caller cannot see as not found, and so a claimed filing run', async () => {
		grant('member');
		vi.mocked(getRunByIdFromDb).mockResolvedValue(runIn('p-secret'));

		await expect(user.create({ ...INPUT, runId: 'run-1' })).rejects.toThrowError(
			expect.objectContaining({ code: 'NOT_FOUND', message: 'Run with ID "run-1" not found' }),
		);
		await expect(
			user.create({ ...INPUT, projectId: 'p1', filedByRunId: 'run-1' }),
		).rejects.toThrowError(code('NOT_FOUND'));
		expect(insertBugReport).not.toHaveBeenCalled();
	});

	it('lets a contributor read but not file', async () => {
		grant('contributor');
		await expect(user.create({ ...INPUT, projectId: 'p1' })).rejects.toThrowError(
			code('FORBIDDEN'),
		);
	});

	it('files an installation-wide report for an instance admin only', async () => {
		grant('member');
		await expect(user.create(INPUT)).rejects.toThrowError(code('FORBIDDEN'));

		const preview = await admin.previewCreate({ ...INPUT, status: 'environmental' });
		expect(preview).toMatchObject({
			projectId: null,
			report: { projectId: null, status: 'environmental', filedByUserId: ADMIN.id },
		});
		expect(insertBugReport).not.toHaveBeenCalled();
	});

	it('previews exactly what create writes', async () => {
		grant('member');
		vi.mocked(insertBugReport).mockResolvedValue({} as Awaited<ReturnType<typeof insertBugReport>>);
		const input = { ...INPUT, projectId: 'p1', taskId: '42', status: 'confirmed' as const };

		const preview = await user.previewCreate(input);
		await user.create(input);

		expect(insertBugReport).toHaveBeenCalledWith({
			report: preview.report,
			occurrence: preview.occurrence,
		});
	});
});

describe('addOccurrence', () => {
	it('adds to the report and previews the count it moves to', async () => {
		grant('member');
		vi.mocked(getBugReport).mockResolvedValue(report({ occurrenceCount: 3 }));
		vi.mocked(getRunByIdFromDb).mockResolvedValue(runIn('p1'));
		vi.mocked(addBugReportOccurrence).mockResolvedValue({
			report: report({ occurrenceCount: 4 }),
		} as Awaited<ReturnType<typeof addBugReportOccurrence>>);

		const preview = await user.previewAddOccurrence({ reportId: REPORT_ID, runId: 'run-1' });
		expect(preview).toMatchObject({ projectId: 'p1', occurrenceCount: { from: 3, to: 4 } });
		expect(preview).not.toHaveProperty('warning');

		await user.addOccurrence({ reportId: REPORT_ID, runId: 'run-1' });
		expect(addBugReportOccurrence).toHaveBeenCalledWith(REPORT_ID, preview.occurrence);
	});

	it('warns about a closed duplicate and names its original, without rerouting', async () => {
		grant('member');
		vi.mocked(getBugReport).mockResolvedValue(
			report({ status: 'duplicate', duplicateOfId: OTHER_ID }),
		);

		await expect(user.previewAddOccurrence({ reportId: REPORT_ID })).resolves.toMatchObject({
			warning: 'report is duplicate',
			duplicateOfId: OTHER_ID,
			report: { id: REPORT_ID },
		});
	});

	it("refuses a run outside the report's project, and a contributor", async () => {
		grant('member', { p2: 'contributor' });
		vi.mocked(getBugReport).mockResolvedValue(report());
		vi.mocked(getRunByIdFromDb).mockResolvedValue(runIn('p2'));
		await expect(user.addOccurrence({ reportId: REPORT_ID, runId: 'run-1' })).rejects.toThrowError(
			code('BAD_REQUEST'),
		);

		grant('contributor');
		await expect(user.addOccurrence({ reportId: REPORT_ID })).rejects.toThrowError(
			code('FORBIDDEN'),
		);
		expect(addBugReportOccurrence).not.toHaveBeenCalled();
	});
});

describe('setStatus', () => {
	it('tickets a report with its issue link and stamps the status change', async () => {
		grant('member');
		vi.mocked(getBugReport).mockResolvedValue(report({ status: 'confirmed' }));
		vi.mocked(updateBugReportStatus).mockResolvedValue(report({ status: 'ticketed' }));
		const input = {
			reportId: REPORT_ID,
			status: 'ticketed' as const,
			githubIssueUrl: 'https://github.com/acme/swarm/issues/9',
		};

		await expect(user.previewSetStatus(input)).resolves.toEqual({
			projectId: 'p1',
			change: { from: 'confirmed', to: 'ticketed' },
			githubIssueUrl: { from: null, to: input.githubIssueUrl },
			duplicateOfId: { from: null, to: null },
		});
		await user.setStatus(input);

		expect(updateBugReportStatus).toHaveBeenCalledWith(REPORT_ID, {
			status: 'ticketed',
			duplicateOfId: null,
			githubIssueUrl: input.githubIssueUrl,
			statusChanged: true,
		});
	});

	it('refuses a non-https issue link at the input', async () => {
		await expect(
			admin.setStatus({ reportId: REPORT_ID, status: 'ticketed', githubIssueUrl: 'http://x.io/1' }),
		).rejects.toThrowError(code('BAD_REQUEST'));
		expect(getBugReport).not.toHaveBeenCalled();
	});

	it('needs a duplicate target the caller can read', async () => {
		grant('member');
		vi.mocked(getBugReport).mockImplementation(async (id) =>
			id === REPORT_ID ? report() : report({ id: OTHER_ID, projectId: 'p-secret' }),
		);

		await expect(
			user.setStatus({ reportId: REPORT_ID, status: 'duplicate', duplicateOfId: OTHER_ID }),
		).rejects.toThrowError(
			expect.objectContaining({
				code: 'NOT_FOUND',
				message: `Bug report "${OTHER_ID}" not found.`,
			}),
		);
		expect(updateBugReportStatus).not.toHaveBeenCalled();
	});

	it('refuses a contributor and a no-op change', async () => {
		grant('contributor');
		vi.mocked(getBugReport).mockResolvedValue(report());
		await expect(user.setStatus({ reportId: REPORT_ID, status: 'confirmed' })).rejects.toThrowError(
			code('FORBIDDEN'),
		);

		grant('member');
		await expect(user.setStatus({ reportId: REPORT_ID, status: 'new' })).rejects.toThrowError(
			expect.objectContaining({
				code: 'BAD_REQUEST',
				message: 'The bug report is already "new".',
			}),
		);
		expect(updateBugReportStatus).not.toHaveBeenCalled();
	});
});

describe('validateStatusChange', () => {
	const base = { id: REPORT_ID, status: 'new', duplicateOfId: null, githubIssueUrl: null };

	it('needs a duplicate target that is not the report itself', () => {
		expect(validateStatusChange(base, { status: 'duplicate' })).toMatchObject({ ok: false });
		expect(
			validateStatusChange(base, { status: 'duplicate', duplicateOfId: REPORT_ID }),
		).toMatchObject({ ok: false, message: 'A bug report cannot be a duplicate of itself.' });
		expect(validateStatusChange(base, { status: 'duplicate', duplicateOfId: OTHER_ID })).toEqual({
			ok: true,
			patch: { status: 'duplicate', duplicateOfId: OTHER_ID, githubIssueUrl: null },
		});
	});

	it('clears the duplicate target on any other status, and refuses one named with it', () => {
		const duplicate = { ...base, status: 'duplicate', duplicateOfId: OTHER_ID };
		expect(validateStatusChange(duplicate, { status: 'confirmed' })).toEqual({
			ok: true,
			patch: { status: 'confirmed', duplicateOfId: null, githubIssueUrl: null },
		});
		expect(
			validateStatusChange(base, { status: 'confirmed', duplicateOfId: OTHER_ID }),
		).toMatchObject({ ok: false });
	});

	it('needs an issue link for ticketed unless one is stored, and keeps a stored one', () => {
		expect(validateStatusChange(base, { status: 'ticketed' })).toMatchObject({ ok: false });
		const ticketed = { ...base, status: 'ticketed', githubIssueUrl: 'https://x.io/1' };
		expect(validateStatusChange(ticketed, { status: 'resolved' })).toEqual({
			ok: true,
			patch: { status: 'resolved', duplicateOfId: null, githubIssueUrl: 'https://x.io/1' },
		});
	});

	it('accepts a new link alone on the current status, and refuses a change of nothing', () => {
		expect(
			validateStatusChange(base, { status: 'new', githubIssueUrl: 'https://x.io/2' }),
		).toMatchObject({ ok: true });
		expect(validateStatusChange(base, { status: 'new' })).toMatchObject({ ok: false });
	});
});
