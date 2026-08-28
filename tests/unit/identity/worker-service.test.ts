import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
	createWorker,
	findWorkerByCredentialHash,
	getWorkerById,
	setWorkerDeclaredCapabilities,
	updateWorkerCapabilities,
	updateWorkerDisplayName,
	updateWorkerSupportedPhases,
} = vi.hoisted(() => ({
	createWorker: vi.fn(),
	findWorkerByCredentialHash: vi.fn(),
	getWorkerById: vi.fn(),
	setWorkerDeclaredCapabilities: vi.fn(),
	updateWorkerCapabilities: vi.fn(),
	updateWorkerDisplayName: vi.fn(),
	updateWorkerSupportedPhases: vi.fn(),
	listWorkersForOwner: vi.fn(),
}));
const { listWorkersForOwner } = vi.hoisted(() => ({ listWorkersForOwner: vi.fn() }));

vi.mock('@/db/repositories/workersRepository.js', () => ({
	createWorker,
	findWorkerByCredentialHash,
	getWorkerById,
	setWorkerDeclaredCapabilities,
	updateWorkerCapabilities,
	updateWorkerDisplayName,
	updateWorkerSupportedPhases,
	listWorkersForOwner,
}));

import { DEFAULT_WORKER_SUPPORTED_PHASES, type Worker } from '@/identity/worker.js';
import {
	declareWorkerCapabilities,
	declareWorkerSupportedPhases,
	hashWorkerCredential,
	issueWorkerCredential,
	refreshWorkerCapabilities,
	registerWorker,
	renameWorker,
	resolveWorkerByCredential,
	WorkerCapabilityNotProbedError,
	WorkerCapabilityReductionError,
} from '@/identity/worker-service.js';

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

const OWNER_ID = '22222222-2222-4222-8222-222222222222';

function makeWorker(overrides: Partial<Worker> = {}): Worker {
	const worker: Worker = {
		id: '11111111-1111-4111-8111-111111111111',
		ownerUserId: OWNER_ID,
		displayName: 'ada-laptop',
		capabilities: ['claude'],
		// No declaration (issue #783), so the probe is the effective set.
		probedCapabilities: ['claude'],
		declaredCapabilities: null,
		supportedPhases: [...DEFAULT_WORKER_SUPPORTED_PHASES],
		repository: null,
		createdAt: new Date('2026-01-01T00:00:00Z'),
		updatedAt: new Date('2026-01-01T00:00:00Z'),
		...overrides,
	};
	// Keep the two CLI fields in step when a test overrides only `capabilities`.
	return { ...worker, probedCapabilities: overrides.probedCapabilities ?? worker.capabilities };
}

beforeEach(() => {
	createWorker.mockReset();
	findWorkerByCredentialHash.mockReset();
	getWorkerById.mockReset();
	setWorkerDeclaredCapabilities.mockReset();
	updateWorkerCapabilities.mockReset();
	updateWorkerDisplayName.mockReset();
	updateWorkerSupportedPhases.mockReset();
	listWorkersForOwner.mockReset();
});

describe('credential primitives', () => {
	it('issues a raw token whose SHA-256 equals the returned hash', () => {
		const { token, hash } = issueWorkerCredential();
		expect(token).toBeTruthy();
		expect(hash).toBe(sha256(token));
		expect(hash).toBe(hashWorkerCredential(token));
	});

	it('issues a distinct token on each call', () => {
		const a = issueWorkerCredential();
		const b = issueWorkerCredential();
		expect(a.token).not.toBe(b.token);
		expect(a.hash).not.toBe(b.hash);
	});
});

describe('registerWorker', () => {
	it('persists only the credential hash and returns the raw credential once', async () => {
		createWorker.mockImplementation(async (input) =>
			makeWorker({ displayName: input.displayName, capabilities: input.capabilities }),
		);

		const { worker, credential } = await registerWorker({
			ownerUserId: OWNER_ID,
			displayName: 'ada-laptop',
			capabilities: ['claude', 'claude', 'codex'],
		});

		// The credential is returned in raw form...
		expect(credential).toBeTruthy();
		// ...but the persisted value is its hash, never the raw token.
		const stored = createWorker.mock.calls[0][0];
		expect(stored.credentialHash).toBe(sha256(credential));
		expect(stored.credentialHash).not.toBe(credential);
		// Capabilities are validated + de-duplicated before persistence.
		expect(stored.capabilities).toEqual(['claude', 'codex']);
		// The returned worker carries no credential material.
		expect(worker).not.toHaveProperty('credentialHash');
		expect(worker).not.toHaveProperty('credential');
	});

	it('rejects an empty capability set without hitting the repository', async () => {
		await expect(
			registerWorker({ ownerUserId: OWNER_ID, displayName: 'ada-laptop', capabilities: [] }),
		).rejects.toThrow();
		expect(createWorker).not.toHaveBeenCalled();
	});

	it('rejects a blank display name without hitting the repository', async () => {
		await expect(
			registerWorker({ ownerUserId: OWNER_ID, displayName: '   ', capabilities: ['claude'] }),
		).rejects.toThrow();
		expect(createWorker).not.toHaveBeenCalled();
	});
});

describe('refreshWorkerCapabilities', () => {
	it('validates the set and delegates to the repository', async () => {
		updateWorkerCapabilities.mockImplementation(async (id, capabilities) =>
			makeWorker({ id, capabilities }),
		);

		const updated = await refreshWorkerCapabilities('worker-1', ['codex', 'codex']);
		expect(updated?.capabilities).toEqual(['codex']);
		// No phases passed through: the caller declared none, so the stored repertoire is
		// left untouched rather than reset to the every-phase default (issue #467) — the
		// `swarm workers set-cli` path, which knows nothing about phases.
		// The fourth argument is `undefined` for the same reason (issue #687): a caller
		// that knows nothing about checkouts must not clear the stored declaration.
		expect(updateWorkerCapabilities).toHaveBeenCalledWith(
			'worker-1',
			['codex'],
			undefined,
			undefined,
		);
	});

	it('validates and forwards a declared phase set when one is given', async () => {
		updateWorkerCapabilities.mockImplementation(async (id, capabilities) =>
			makeWorker({ id, capabilities }),
		);

		await refreshWorkerCapabilities(
			'worker-1',
			['claude'],
			['implementation', 'implementation', 'review'],
		);

		// De-duplicated by `WorkerSupportedPhasesSchema`, exactly as the CLI set is.
		expect(updateWorkerCapabilities).toHaveBeenCalledWith(
			'worker-1',
			['claude'],
			['implementation', 'review'],
			undefined,
		);
	});

	// Issue #687 — the daemon's checkout declaration, three-valued at this seam so the
	// CLI-only path can leave a fact it knows nothing about alone.
	it('validates and forwards a declared repository, normalised', async () => {
		updateWorkerCapabilities.mockImplementation(async (id, capabilities) =>
			makeWorker({ id, capabilities }),
		);

		await refreshWorkerCapabilities(
			'worker-1',
			['claude'],
			undefined,
			'SmartTechBrewery/Swarm.git',
		);

		expect(updateWorkerCapabilities).toHaveBeenCalledWith(
			'worker-1',
			['claude'],
			undefined,
			'smarttechbrewery/swarm',
		);
	});

	it('forwards null unchanged, which clears an earlier daemon’s declaration', async () => {
		updateWorkerCapabilities.mockImplementation(async (id, capabilities) =>
			makeWorker({ id, capabilities }),
		);

		await refreshWorkerCapabilities('worker-1', ['claude'], undefined, null);

		expect(updateWorkerCapabilities).toHaveBeenCalledWith('worker-1', ['claude'], undefined, null);
	});

	it('rejects a malformed repository without hitting the repository layer', async () => {
		await expect(
			refreshWorkerCapabilities('worker-1', ['claude'], undefined, 'not-a-slug'),
		).rejects.toThrow();
		expect(updateWorkerCapabilities).not.toHaveBeenCalled();
	});

	it('rejects an empty phase set without hitting the repository', async () => {
		await expect(refreshWorkerCapabilities('worker-1', ['claude'], [])).rejects.toThrow();
		expect(updateWorkerCapabilities).not.toHaveBeenCalled();
	});

	it('rejects an empty set without hitting the repository', async () => {
		await expect(refreshWorkerCapabilities('worker-1', [])).rejects.toThrow();
		expect(updateWorkerCapabilities).not.toHaveBeenCalled();
	});

	it('propagates WorkerCapabilityReductionError from repository when reduction violates existing enrollments', async () => {
		updateWorkerCapabilities.mockRejectedValue(
			new WorkerCapabilityReductionError('worker-1', ['claude']),
		);

		await expect(refreshWorkerCapabilities('worker-1', ['codex'])).rejects.toThrow(
			WorkerCapabilityReductionError,
		);
	});
});

// Issue #783: the owner's durable CLI declaration — the seam `swarm workers set-cli`
// writes through, distinct from the probe a handshake refreshes.
describe('declareWorkerCapabilities', () => {
	it('validates and de-duplicates the declaration, then delegates to the declaration writer', async () => {
		setWorkerDeclaredCapabilities.mockImplementation(async (id, declared) =>
			makeWorker({ id, capabilities: declared ?? ['claude'] }),
		);

		const updated = await declareWorkerCapabilities('worker-1', ['codex', 'codex']);

		expect(updated?.capabilities).toEqual(['codex']);
		expect(setWorkerDeclaredCapabilities).toHaveBeenCalledWith('worker-1', ['codex']);
		// The probe path is untouched: a declaration never rewrites what the daemon found.
		expect(updateWorkerCapabilities).not.toHaveBeenCalled();
	});

	it('passes null straight through, which returns the worker to auto-discovery', async () => {
		setWorkerDeclaredCapabilities.mockResolvedValue(makeWorker());

		await declareWorkerCapabilities('worker-1', null);

		expect(setWorkerDeclaredCapabilities).toHaveBeenCalledWith('worker-1', null);
	});

	// An empty declaration would mean "routable for nothing", which is what revoking an
	// enrollment's consent expresses — not a CLI set.
	it('rejects an empty declaration without hitting the repository', async () => {
		await expect(declareWorkerCapabilities('worker-1', [])).rejects.toThrow();
		expect(setWorkerDeclaredCapabilities).not.toHaveBeenCalled();
	});

	it('returns undefined for an unknown worker id', async () => {
		setWorkerDeclaredCapabilities.mockResolvedValue(undefined);
		expect(await declareWorkerCapabilities('nope', ['claude'])).toBeUndefined();
	});

	it('surfaces both repository guards unchanged', async () => {
		setWorkerDeclaredCapabilities.mockRejectedValue(
			new WorkerCapabilityNotProbedError('worker-1', ['codex'], ['claude']),
		);
		await expect(declareWorkerCapabilities('worker-1', ['codex'])).rejects.toThrow(
			WorkerCapabilityNotProbedError,
		);

		setWorkerDeclaredCapabilities.mockRejectedValue(
			new WorkerCapabilityReductionError('worker-1', ['claude']),
		);
		await expect(declareWorkerCapabilities('worker-1', ['codex'])).rejects.toThrow(
			WorkerCapabilityReductionError,
		);
	});
});

// Issue #467: the in-process host worker's declaration seam. It authenticates by
// acquiring an execution session rather than handshaking, so it must be able to state
// its phase repertoire without overwriting the operator-registered CLI set.
describe('declareWorkerSupportedPhases', () => {
	it('validates and de-duplicates the set, then delegates to the phase-only writer', async () => {
		updateWorkerSupportedPhases.mockImplementation(async (id, supportedPhases) =>
			makeWorker({ id, supportedPhases }),
		);

		const updated = await declareWorkerSupportedPhases('worker-1', [
			'planning',
			'planning',
			'implementation',
		]);

		expect(updated?.supportedPhases).toEqual(['planning', 'implementation']);
		expect(updateWorkerSupportedPhases).toHaveBeenCalledWith('worker-1', [
			'planning',
			'implementation',
		]);
		// Never routed through the CLI writer, which would need a capability set it has none of.
		expect(updateWorkerCapabilities).not.toHaveBeenCalled();
	});

	it('rejects an empty set without hitting the repository', async () => {
		await expect(declareWorkerSupportedPhases('worker-1', [])).rejects.toThrow();
		expect(updateWorkerSupportedPhases).not.toHaveBeenCalled();
	});

	it('rejects an unknown phase without hitting the repository', async () => {
		await expect(declareWorkerSupportedPhases('worker-1', ['deploy' as never])).rejects.toThrow();
		expect(updateWorkerSupportedPhases).not.toHaveBeenCalled();
	});
});

describe('renameWorker', () => {
	it('validates and trims the name, then delegates to the display-name writer', async () => {
		updateWorkerDisplayName.mockImplementation(async (id, displayName) =>
			makeWorker({ id, displayName }),
		);

		const updated = await renameWorker('worker-1', '  new-name  ');

		expect(updated?.displayName).toBe('new-name');
		expect(updateWorkerDisplayName).toHaveBeenCalledWith('worker-1', 'new-name');
	});

	it('rejects an empty (or whitespace-only) name without hitting the repository', async () => {
		await expect(renameWorker('worker-1', '   ')).rejects.toThrow();
		expect(updateWorkerDisplayName).not.toHaveBeenCalled();
	});

	it('rejects a name over 80 characters without hitting the repository', async () => {
		await expect(renameWorker('worker-1', 'x'.repeat(81))).rejects.toThrow();
		expect(updateWorkerDisplayName).not.toHaveBeenCalled();
	});
});

describe('resolveWorkerByCredential', () => {
	it('resolves a worker by the hash of its credential', async () => {
		const worker = makeWorker();
		findWorkerByCredentialHash.mockResolvedValue(worker);

		expect(await resolveWorkerByCredential('raw-credential')).toBe(worker);
		expect(findWorkerByCredentialHash).toHaveBeenCalledWith(sha256('raw-credential'));
	});

	it('returns undefined for an empty credential without a lookup', async () => {
		expect(await resolveWorkerByCredential('')).toBeUndefined();
		expect(findWorkerByCredentialHash).not.toHaveBeenCalled();
	});

	it('returns undefined for an unknown credential', async () => {
		findWorkerByCredentialHash.mockResolvedValue(undefined);
		expect(await resolveWorkerByCredential('nope')).toBeUndefined();
	});
});
