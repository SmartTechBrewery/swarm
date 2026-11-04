import { describe, expect, it } from 'vitest';
import { workerInstallCommand } from './worker-install-command.js';

describe('workerInstallCommand', () => {
	it("pipes the installation's own install.sh to sh", () => {
		expect(workerInstallCommand('https://swarm.example.com')).toBe(
			'curl -fsSL https://swarm.example.com/install.sh | sh',
		);
	});
});
