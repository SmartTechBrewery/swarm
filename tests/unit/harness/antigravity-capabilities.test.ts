import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the subprocess boundary — unit tests never run a real CLI (ai/TESTING.md).
// Node's real `execFile` carries a `promisify.custom` implementation that
// resolves to `{ stdout, stderr }` (a plain promisify would yield stdout alone),
// and rejects with an error carrying those same fields. The fake reproduces both
// halves, since the module under test consumes exactly that contract.
const fake = vi.hoisted(() => {
	const calls = vi.fn<(command: string, args: string[], options: unknown) => void>();
	let outcome: () => Promise<unknown> = () => Promise.resolve({ stdout: '', stderr: '' });
	const execFile = (command: string, args: string[], options: unknown): Promise<unknown> => {
		calls(command, args, options);
		return outcome();
	};
	// The custom symbol is what `promisify` picks up, so the fake is already
	// promise-shaped and never needs a callback form.
	Object.assign(execFile, { [Symbol.for('nodejs.util.promisify.custom')]: execFile });
	return {
		calls,
		execFile,
		setOutcome: (next: () => Promise<unknown>) => {
			outcome = next;
		},
	};
});
vi.mock('node:child_process', () => ({ execFile: fake.execFile }));

const execFileMock = fake.calls;
const succeedsWith = (stdout: string, stderr = '') => {
	fake.setOutcome(() => Promise.resolve({ stdout, stderr }));
};
const failsWith = (err: unknown) => {
	fake.setOutcome(() => Promise.reject(err));
};

import {
	resetAntigravityCapabilityCache,
	supportsOutputFormat,
	supportsPrintTimeout,
} from '@/harness/antigravity-capabilities.js';

/** The real `agy --help` output, trimmed to the lines that matter (1.1.10). */
const AGY_1_1_10_HELP = [
	'Usage of agy:',
	'  --add-dir                       Add a directory to the workspace (repeatable) (default [])',
	'  --conversation                  Resume a previous conversation by ID',
	'  --output-format                 Output format for print mode (text, json, stream-json) (default text)',
	'  -p                              Short alias for --print',
	'  --print-timeout                 Timeout for print mode wait (default 5m0s)',
].join('\n');

/** The same help without either flag — how agy 1.1.3 presented itself. */
const AGY_OLD_HELP = [
	'Usage of agy:',
	'  --add-dir                       Add a directory to the workspace (repeatable) (default [])',
	'  -p                              Short alias for --print',
].join('\n');

/**
 * agy 1.1.5, verbatim in the lines that matter: it declares `--print-timeout`
 * but *not* `--output-format`, so the two capabilities are genuinely
 * independent and neither may be inferred from the other.
 */
const AGY_1_1_5_HELP = [
	'Usage of agy:',
	'  --add-dir                       Add a directory to the workspace (repeatable) (default [])',
	'  -p                              Short alias for --print',
	'  --print-timeout                 Timeout for print mode wait (default 5m0s)',
].join('\n');

beforeEach(() => {
	execFileMock.mockClear();
	resetAntigravityCapabilityCache();
	succeedsWith('');
});

describe('supportsOutputFormat', () => {
	it('detects the flag in a help listing that declares it', async () => {
		succeedsWith(AGY_1_1_10_HELP);
		await expect(supportsOutputFormat('agy')).resolves.toBe(true);
		expect(execFileMock).toHaveBeenCalledWith('agy', ['--help'], expect.anything());
	});

	it('reports false for a binary whose help lacks the flag', async () => {
		succeedsWith(AGY_OLD_HELP);
		await expect(supportsOutputFormat('agy')).resolves.toBe(false);
	});

	it('ignores another flag merely mentioning the format in its prose', async () => {
		// agy's own `--json-schema` description names stream-json without that
		// implying `--output-format` exists — the anchored match is what tells the
		// declaration apart from the mention.
		succeedsWith(
			[
				'Usage of agy:',
				'  --json-schema    Optional JSON schema (for stream-json, only applicable to the final result)',
				'  --print          Run a single prompt non-interactively',
				'                   See also --output-format for machine-readable output',
			].join('\n'),
		);
		await expect(supportsOutputFormat('agy')).resolves.toBe(false);
	});

	it('still inspects the output of a help that exits non-zero', async () => {
		// Some CLIs print usage and exit 1; that still answered the question.
		failsWith({ code: 1, stdout: AGY_1_1_10_HELP, stderr: '' });
		await expect(supportsOutputFormat('agy')).resolves.toBe(true);
	});

	it('reads the flag from stderr when help goes there', async () => {
		succeedsWith('', AGY_1_1_10_HELP);
		await expect(supportsOutputFormat('agy')).resolves.toBe(true);
	});

	it('reports false — never throws — for a missing binary or a timed-out probe', async () => {
		failsWith(Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' }));
		await expect(supportsOutputFormat('agy')).resolves.toBe(false);

		resetAntigravityCapabilityCache();
		failsWith(Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }));
		await expect(supportsOutputFormat('agy')).resolves.toBe(false);
	});

	it('probes once per command, sharing the answer across concurrent runs', async () => {
		succeedsWith(AGY_1_1_10_HELP);
		const [first, second] = await Promise.all([
			supportsOutputFormat('agy'),
			supportsOutputFormat('agy'),
		]);
		expect([first, second]).toEqual([true, true]);
		await expect(supportsOutputFormat('agy')).resolves.toBe(true);
		expect(execFileMock).toHaveBeenCalledTimes(1);
	});

	it('probes each distinct command separately', async () => {
		succeedsWith(AGY_1_1_10_HELP);
		await supportsOutputFormat('agy');
		succeedsWith(AGY_OLD_HELP);
		await expect(supportsOutputFormat('/opt/old/agy')).resolves.toBe(false);
		expect(execFileMock).toHaveBeenCalledTimes(2);
	});
});

describe('supportsPrintTimeout', () => {
	it('detects the flag in a help listing that declares it', async () => {
		succeedsWith(AGY_1_1_5_HELP);
		await expect(supportsPrintTimeout('agy')).resolves.toBe(true);
		expect(execFileMock).toHaveBeenCalledWith('agy', ['--help'], expect.anything());
	});

	it('reports false for a binary whose help lacks the flag', async () => {
		succeedsWith(AGY_OLD_HELP);
		await expect(supportsPrintTimeout('agy')).resolves.toBe(false);
	});

	it('ignores another flag merely mentioning print timeouts in its prose', async () => {
		succeedsWith(
			[
				'Usage of agy:',
				'  --print          Run a single prompt non-interactively',
				'                   Waits up to the --print-timeout default before returning',
			].join('\n'),
		);
		await expect(supportsPrintTimeout('agy')).resolves.toBe(false);
	});

	it('reports false — never throws — for a missing binary or a timed-out probe', async () => {
		failsWith(Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' }));
		await expect(supportsPrintTimeout('agy')).resolves.toBe(false);
	});

	it('is answered by the same single probe as --output-format', async () => {
		// One `agy --help` answers both questions, so gating a second flag on
		// observed capability costs no extra process.
		succeedsWith(AGY_1_1_10_HELP);
		const [outputFormat, printTimeout] = await Promise.all([
			supportsOutputFormat('agy'),
			supportsPrintTimeout('agy'),
		]);
		expect([outputFormat, printTimeout]).toEqual([true, true]);
		expect(execFileMock).toHaveBeenCalledTimes(1);
	});

	it('answers the two flags independently', async () => {
		// agy 1.1.5 has --print-timeout and no --output-format; neither capability
		// may be inferred from the other.
		succeedsWith(AGY_1_1_5_HELP);
		await expect(supportsPrintTimeout('agy')).resolves.toBe(true);
		await expect(supportsOutputFormat('agy')).resolves.toBe(false);
	});
});
