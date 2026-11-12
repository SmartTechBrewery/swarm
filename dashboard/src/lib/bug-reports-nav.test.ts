import { describe, expect, it } from 'vitest';
import {
	bugReportsSearch,
	bugReportsSearchSchema,
	canChangeBugReportStatus,
} from './bug-reports-nav.js';

const REPORT = '00000000-0000-4000-8000-000000000001';

describe('bugReportsSearchSchema', () => {
	it('parses the report shown in detail, and drops a malformed one', () => {
		expect(bugReportsSearchSchema.parse({ report: REPORT })).toEqual({ report: REPORT });
		expect(bugReportsSearchSchema.parse({ report: 'nope' })).toEqual({ report: undefined });
		expect(bugReportsSearchSchema.parse({})).toEqual({});
	});

	it('round-trips through bugReportsSearch', () => {
		expect(bugReportsSearch(REPORT)).toEqual({ report: REPORT });
		expect(bugReportsSearch(undefined)).toEqual({});
	});
});

describe('canChangeBugReportStatus', () => {
	const ADMIN = { instanceAdmin: true };
	const USER = { instanceAdmin: false };
	const PROJECTS = [
		{ id: 'admin', role: 'projectAdmin' as const },
		{ id: 'member', role: 'member' as const },
		{ id: 'reader', role: 'contributor' as const },
		{ id: 'installation-role', role: null },
	];

	it('offers controls on a project the viewer is at least a member of', () => {
		expect(canChangeBugReportStatus('admin', USER, PROJECTS)).toBe(true);
		expect(canChangeBugReportStatus('member', USER, PROJECTS)).toBe(true);
	});

	it('offers none to a contributor, a stranger, or before the projects resolve', () => {
		expect(canChangeBugReportStatus('reader', USER, PROJECTS)).toBe(false);
		expect(canChangeBugReportStatus('elsewhere', USER, PROJECTS)).toBe(false);
		expect(canChangeBugReportStatus('installation-role', USER, PROJECTS)).toBe(false);
		expect(canChangeBugReportStatus('member', USER, undefined)).toBe(false);
		expect(canChangeBugReportStatus('member', undefined, PROJECTS)).toBe(false);
	});

	it('offers installation-wide reports to an instance administrator only', () => {
		expect(canChangeBugReportStatus(null, ADMIN, [])).toBe(true);
		expect(canChangeBugReportStatus(null, USER, PROJECTS)).toBe(false);
		expect(canChangeBugReportStatus('reader', ADMIN, undefined)).toBe(true);
	});
});
