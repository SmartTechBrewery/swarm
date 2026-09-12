import { describe, expect, it } from 'vitest';
import { filterWorkersBySearch, workerMatchesSearch } from '@/lib/worker-search.js';
import type { WorkerRow } from '@/types/workers.js';

function makeWorker(overrides: Partial<WorkerRow> = {}): WorkerRow {
	return {
		workerId: 'worker-1',
		displayName: 'ada-laptop',
		owner: { userId: 'u1', identifier: 'ada@example.com', displayName: 'Ada Lovelace' },
		capabilities: ['claude'],
		supportedPhases: ['implementation'],
		repository: 'acme/frontend',
		connection: 'online',
		lastSeenAt: '2026-07-01T12:00:00.000Z',
		currentRun: null,
		enrollments: [],
		...overrides,
	};
}

describe('workerMatchesSearch', () => {
	it('matches the machine name, case-insensitively', () => {
		expect(workerMatchesSearch(makeWorker(), 'ADA-LAP')).toBe(true);
		expect(workerMatchesSearch(makeWorker(), 'grace')).toBe(false);
	});

	it('matches the owner’s display name and identifier', () => {
		expect(workerMatchesSearch(makeWorker(), 'Lovelace')).toBe(true);
		expect(workerMatchesSearch(makeWorker(), 'ada@example')).toBe(true);
	});

	it('matches the declared repository', () => {
		expect(workerMatchesSearch(makeWorker(), 'acme/front')).toBe(true);
	});

	it('treats an empty or whitespace-only query as no filter', () => {
		expect(workerMatchesSearch(makeWorker(), '')).toBe(true);
		expect(workerMatchesSearch(makeWorker(), '   ')).toBe(true);
	});

	it('ignores surrounding whitespace in the query', () => {
		expect(workerMatchesSearch(makeWorker(), '  laptop  ')).toBe(true);
	});

	it('tolerates a worker with no owner and no repository', () => {
		const anonymous = makeWorker({ owner: null, repository: null });
		expect(workerMatchesSearch(anonymous, 'ada')).toBe(true);
		expect(workerMatchesSearch(anonymous, 'acme')).toBe(false);
	});

	it('does not match across two unrelated fields', () => {
		// "laptopada" only exists if displayName and the owner are concatenated.
		expect(workerMatchesSearch(makeWorker(), 'laptopada')).toBe(false);
	});
});

describe('filterWorkersBySearch', () => {
	const ada = makeWorker();
	const grace = makeWorker({
		workerId: 'worker-2',
		displayName: 'grace-box',
		owner: { userId: 'u2', identifier: 'grace@example.com', displayName: 'Grace Hopper' },
		repository: 'acme/backend',
	});

	it('keeps only the matching rows', () => {
		expect(filterWorkersBySearch([ada, grace], 'grace')).toEqual([grace]);
	});

	it('preserves the server’s order rather than re-sorting', () => {
		expect(filterWorkersBySearch([grace, ada], 'acme')).toEqual([grace, ada]);
	});

	it('returns the caller’s own list for an empty query', () => {
		const rows = [ada, grace];
		expect(filterWorkersBySearch(rows, '  ')).toBe(rows);
	});

	it('returns nothing when a query matches no row', () => {
		expect(filterWorkersBySearch([ada, grace], 'nope')).toEqual([]);
	});
});
