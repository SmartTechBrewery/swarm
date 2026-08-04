import { describe, expect, it } from 'vitest';

import {
	DEFAULT_WORKER_SUPPORTED_PHASES,
	WorkerCapabilitiesSchema,
	WorkerDisplayNameSchema,
	WorkerSchema,
	WorkerSupportedPhasesSchema,
} from '@/identity/worker.js';

const validWorker = {
	id: '11111111-1111-4111-8111-111111111111',
	ownerUserId: '22222222-2222-4222-8222-222222222222',
	displayName: 'ada-laptop',
	capabilities: ['claude', 'codex'],
	supportedPhases: [...DEFAULT_WORKER_SUPPORTED_PHASES],
	createdAt: new Date('2026-01-01T00:00:00Z'),
	updatedAt: new Date('2026-01-01T00:00:00Z'),
};

describe('WorkerCapabilitiesSchema', () => {
	it('rejects an empty set', () => {
		expect(() => WorkerCapabilitiesSchema.parse([])).toThrow();
	});

	it('de-duplicates repeated CLIs', () => {
		expect(WorkerCapabilitiesSchema.parse(['claude', 'claude', 'codex'])).toEqual([
			'claude',
			'codex',
		]);
	});

	it('rejects an unknown CLI', () => {
		expect(() => WorkerCapabilitiesSchema.parse(['claude', 'copilot'])).toThrow();
	});
});

describe('WorkerDisplayNameSchema', () => {
	it('trims surrounding whitespace', () => {
		expect(WorkerDisplayNameSchema.parse('  ada-laptop  ')).toBe('ada-laptop');
	});

	it('rejects an empty (or whitespace-only) name', () => {
		expect(() => WorkerDisplayNameSchema.parse('')).toThrow();
		expect(() => WorkerDisplayNameSchema.parse('   ')).toThrow();
	});

	it('rejects a name longer than 80 chars', () => {
		expect(() => WorkerDisplayNameSchema.parse('a'.repeat(81))).toThrow();
	});
});

// Issue #467 — the phase axis alongside the CLI one. Mirrors the CLI schema's
// contract, and the default is what a worker means before its daemon declares
// anything (a row that predates the column, or a machine never yet connected).
describe('WorkerSupportedPhasesSchema', () => {
	it('rejects an empty set (a daemon that can run no phase is a bug)', () => {
		expect(() => WorkerSupportedPhasesSchema.parse([])).toThrow();
	});

	it('de-duplicates repeated phases', () => {
		expect(WorkerSupportedPhasesSchema.parse(['review', 'review', 'planning'])).toEqual([
			'review',
			'planning',
		]);
	});

	it('rejects an unknown phase', () => {
		expect(() => WorkerSupportedPhasesSchema.parse(['deploy'])).toThrow();
	});

	it('accepts the DB-free subset, which omits planning', () => {
		const parsed = WorkerSupportedPhasesSchema.parse(['implementation', 'review']);
		expect(parsed).toEqual(['implementation', 'review']);
		expect(DEFAULT_WORKER_SUPPORTED_PHASES).toContain('planning');
	});
});

describe('WorkerSchema', () => {
	it('round-trips a valid worker', () => {
		expect(WorkerSchema.parse(validWorker)).toEqual(validWorker);
	});

	it('rejects a non-uuid id', () => {
		expect(() => WorkerSchema.parse({ ...validWorker, id: 'not-a-uuid' })).toThrow();
	});

	it('rejects a non-uuid ownerUserId', () => {
		expect(() => WorkerSchema.parse({ ...validWorker, ownerUserId: 'nope' })).toThrow();
	});

	it('has no credential/hash field in the read model', () => {
		const parsed = WorkerSchema.parse(validWorker);
		expect(parsed).not.toHaveProperty('credentialHash');
		expect(parsed).not.toHaveProperty('credential');
	});
});
