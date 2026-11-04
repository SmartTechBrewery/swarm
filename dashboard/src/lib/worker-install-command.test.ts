import { describe, expect, it } from 'vitest';
import { detectViewerPlatform, workerInstallCommandFor } from './worker-install-command.js';

describe('workerInstallCommandFor', () => {
	it("pipes the installation's own install.sh to sh off Windows", () => {
		expect(workerInstallCommandFor('https://swarm.example.com', 'posix')).toBe(
			'curl -fsSL https://swarm.example.com/install.sh | sh',
		);
	});

	it("pipes the installation's own install.ps1 to iex on Windows", () => {
		expect(workerInstallCommandFor('https://swarm.example.com', 'windows')).toBe(
			'irm https://swarm.example.com/install.ps1 | iex',
		);
	});
});

describe('detectViewerPlatform', () => {
	it('prefers userAgentData', () => {
		expect(detectViewerPlatform({ userAgentData: { platform: 'Windows' }, platform: '' })).toBe(
			'windows',
		);
		expect(detectViewerPlatform({ userAgentData: { platform: 'macOS' }, platform: 'Win32' })).toBe(
			'posix',
		);
	});

	it('falls back to navigator.platform', () => {
		expect(detectViewerPlatform({ platform: 'Win32' })).toBe('windows');
		expect(detectViewerPlatform({ userAgentData: { platform: '' }, platform: 'Win32' })).toBe(
			'windows',
		);
		expect(detectViewerPlatform({ platform: 'MacIntel' })).toBe('posix');
		expect(detectViewerPlatform({ platform: 'Linux x86_64' })).toBe('posix');
	});

	it('answers posix when the browser names nothing', () => {
		expect(detectViewerPlatform({})).toBe('posix');
	});
});
