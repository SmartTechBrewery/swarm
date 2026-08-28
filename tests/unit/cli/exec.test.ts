import { describe, expect, it } from 'vitest';
import { runCommand } from '@/cli/_shared/exec.js';

describe('runCommand', () => {
	it('resolves with the child process exit code', async () => {
		await expect(runCommand('node', ['-e', 'process.exit(3)'])).resolves.toBe(3);
	});

	it('resolves 0 when the child exits cleanly', async () => {
		await expect(runCommand('node', ['-e', ''])).resolves.toBe(0);
	});

	// Merged inside the helper rather than at the call site, so a caller that passes
	// one variable does not silently strip PATH (and everything else) from the child.
	it('merges env over the parent environment instead of replacing it', async () => {
		process.env.SWARM_EXEC_TEST_INHERITED = 'inherited';
		process.env.SWARM_EXEC_TEST_OVERRIDDEN = 'parent';
		try {
			const script =
				"process.exit(process.env.SWARM_EXEC_TEST_INHERITED === 'inherited' && " +
				"process.env.SWARM_EXEC_TEST_OVERRIDDEN === 'child' ? 0 : 1)";
			await expect(
				runCommand('node', ['-e', script], { env: { SWARM_EXEC_TEST_OVERRIDDEN: 'child' } }),
			).resolves.toBe(0);
		} finally {
			delete process.env.SWARM_EXEC_TEST_INHERITED;
			delete process.env.SWARM_EXEC_TEST_OVERRIDDEN;
		}
	});

	it('rejects with a PATH hint when the binary is missing', async () => {
		await expect(runCommand('swarm-no-such-binary-xyz', [])).rejects.toThrow(/not found on PATH/);
	});
});
