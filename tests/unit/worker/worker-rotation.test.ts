import { describe, expect, it } from 'vitest';

import type { WorkerDispatchCandidate } from '@/identity/worker-enrollment-service.js';
import { orderForRotation, resolveShuffleWorkers } from '@/worker/worker-rotation.js';

/** Only the two fields the rotation reads — the worker id to name it, and the enrollment's record. */
function candidate(id: string, lastDispatchedAt: string | null): WorkerDispatchCandidate {
	return {
		worker: { id },
		enrollment: { lastDispatchedAt: lastDispatchedAt ? new Date(lastDispatchedAt) : null },
	} as unknown as WorkerDispatchCandidate;
}

const ids = (candidates: WorkerDispatchCandidate[]) => candidates.map((c) => c.worker.id);

describe('resolveShuffleWorkers (issue #1416)', () => {
	it('is off unless the project turns it on', () => {
		expect(resolveShuffleWorkers(undefined)).toBe(false);
		expect(resolveShuffleWorkers({})).toBe(false);
		expect(resolveShuffleWorkers({ shuffleWorkers: false })).toBe(false);
		expect(resolveShuffleWorkers({ shuffleWorkers: true })).toBe(true);
	});
});

describe('orderForRotation (issue #1416)', () => {
	it('puts never-dispatched workers first, then the least recently dispatched', () => {
		const ordered = orderForRotation([
			candidate('w-a', '2026-11-01T10:02:00Z'),
			candidate('w-b', null),
			candidate('w-c', '2026-11-01T10:01:00Z'),
			candidate('w-d', null),
		]);

		expect(ids(ordered)).toEqual(['w-b', 'w-d', 'w-c', 'w-a']);
	});

	it('keeps the configured order between workers with the same record', () => {
		const at = '2026-11-01T10:00:00Z';
		expect(
			ids(orderForRotation([candidate('w-c', at), candidate('w-a', at), candidate('w-b', at)])),
		).toEqual(['w-c', 'w-a', 'w-b']);
	});

	it('does not reorder its input in place', () => {
		const input = [candidate('w-a', '2026-11-01T10:02:00Z'), candidate('w-b', null)];
		orderForRotation(input);
		expect(ids(input)).toEqual(['w-a', 'w-b']);
	});
});
