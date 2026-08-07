import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BinaryProbeOutcome } from '@/harness/binary-probe.js';

const mockProbeBinary =
	vi.fn<(command: string, options?: { timeoutMs?: number }) => Promise<BinaryProbeOutcome>>();
vi.mock('@/harness/binary-probe.js', () => ({
	probeBinary: (command: string, options?: { timeoutMs?: number }) =>
		mockProbeBinary(command, options),
	DEFAULT_PROBE_TIMEOUT_MS: 5_000,
}));

import {
	discoverAvailableClis,
	parseDeclaredClisOverride,
	probeAvailableClis,
} from '@/transport/cli-discovery.js';

/** Answer each binary with a fixed outcome, one entry per call in order. */
function outcomes(byBinary: Record<string, BinaryProbeOutcome[]>): void {
	const remaining = new Map(Object.entries(byBinary).map(([k, v]) => [k, [...v]]));
	mockProbeBinary.mockImplementation(async (command) => {
		const queue = remaining.get(command);
		const next = queue?.shift();
		return next ?? 'present';
	});
}

describe('probeAvailableClis', () => {
	beforeEach(() => {
		mockProbeBinary.mockReset();
	});

	it('declares every CLI whose probe answered present', async () => {
		outcomes({ claude: ['present'], agy: ['present'], codex: ['present'] });
		const report = await probeAvailableClis();
		expect(report.declared).toEqual(['claude', 'antigravity', 'codex']);
		expect(report.absent).toEqual([]);
		expect(report.unconfirmed).toEqual([]);
	});

	it('drops only the CLIs proven absent', async () => {
		outcomes({ claude: ['present'], agy: ['absent'], codex: ['present'] });
		const report = await probeAvailableClis();
		expect(report.declared).toEqual(['claude', 'codex']);
		expect(report.absent).toEqual(['antigravity']);
	});

	// Issue #559: the observed failure was a `claude --version` that timed out on a
	// busy machine. A retry with a wider budget answers it, and the daemon declares
	// the CLI it actually has instead of handshaking with a fatally narrow set.
	it('re-probes an unsettled CLI with a wider budget and declares it when it answers', async () => {
		outcomes({ claude: ['indeterminate', 'present'], agy: ['present'], codex: ['present'] });
		const report = await probeAvailableClis();
		expect(report.declared).toEqual(['claude', 'antigravity', 'codex']);
		expect(report.unconfirmed).toEqual([]);
		const retry = mockProbeBinary.mock.calls.find(
			([command, options]) => command === 'claude' && options !== undefined,
		);
		expect(retry?.[1]?.timeoutMs).toBeGreaterThan(5_000);
	});

	it('still declares a CLI whose re-probe never settles either', async () => {
		outcomes({
			claude: ['indeterminate', 'indeterminate'],
			agy: ['present'],
			codex: ['present'],
		});
		const report = await probeAvailableClis();
		expect(report.declared).toContain('claude');
		expect(report.unconfirmed).toEqual(['claude']);
		expect(report.absent).toEqual([]);
	});

	it('does not re-probe a CLI whose first answer was proof of absence', async () => {
		outcomes({ claude: ['present'], agy: ['absent'], codex: ['present'] });
		await probeAvailableClis();
		expect(mockProbeBinary.mock.calls.filter(([command]) => command === 'agy')).toHaveLength(1);
	});

	it('reports an empty set only when every CLI is proven absent', async () => {
		outcomes({ claude: ['absent'], agy: ['absent'], codex: ['absent'] });
		await expect(discoverAvailableClis()).resolves.toEqual([]);
	});
});

describe('parseDeclaredClisOverride', () => {
	it('returns undefined for an empty or unset value', () => {
		expect(parseDeclaredClisOverride(undefined)).toBeUndefined();
		expect(parseDeclaredClisOverride('  ,  ')).toBeUndefined();
	});

	it('parses and de-duplicates a comma-separated list', () => {
		expect(parseDeclaredClisOverride('claude, codex , claude')).toEqual(['claude', 'codex']);
	});

	it('throws on an unknown CLI rather than narrowing the set silently', () => {
		expect(() => parseDeclaredClisOverride('claude,gemini')).toThrow(/unknown CLI 'gemini'/);
	});
});
