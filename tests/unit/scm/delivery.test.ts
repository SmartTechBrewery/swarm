import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	commitPreparedTree,
	deliveryIdentity,
	HANDOFF_FILENAMES,
	ImplementationHandoffSchema,
	loadDeliveryProgress,
	readHandoff,
	saveDeliveryProgress,
	validatePreparedTree,
} from '@/scm/delivery.js';

const roots: string[] = [];
const fixtureGitEnvironment = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
);

function fixtureGit(cwd: string, args: string[]): string {
	return execFileSync('git', args, {
		cwd,
		encoding: 'utf8',
		env: fixtureGitEnvironment,
	});
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('SCM delivery hand-offs', () => {
	it('validates implementation evidence before delivery', () => {
		const root = mkdtempSync(join(tmpdir(), 'swarm-delivery-'));
		roots.push(root);
		writeFileSync(
			join(root, 'handoff.json'),
			JSON.stringify({
				summary: 'Prepared change',
				commitSubject: 'feat: prepare change',
				verification: [{ command: 'npm test', outcome: 'passed' }],
				limitations: [],
				readyForDelivery: true,
			}),
		);
		expect(readHandoff(root, 'handoff.json', ImplementationHandoffSchema).readyForDelivery).toBe(
			true,
		);
	});

	it('rejects missing verification evidence', () => {
		expect(() =>
			ImplementationHandoffSchema.parse({
				summary: 'Prepared change',
				commitSubject: 'feat: prepare change',
				verification: [],
				readyForDelivery: true,
			}),
		).toThrow();
	});

	it('persists and reloads step-level progress under a stable identity', () => {
		const root = mkdtempSync(join(tmpdir(), 'swarm-delivery-'));
		roots.push(root);
		const deliveryId = deliveryIdentity(['review', 'acme/widgets', '42', 'abc']);
		saveDeliveryProgress(root, {
			deliveryId,
			pushed: true,
			commitSha: 'abc1234',
			followUpEnqueued: false,
		});
		expect(loadDeliveryProgress(root, deliveryId)).toEqual({
			deliveryId,
			pushed: true,
			commitSha: 'abc1234',
			followUpEnqueued: false,
		});
		expect(readFileSync(join(root, '.swarm_delivery.json'), 'utf8')).not.toContain('token');
	});

	it('commits with the selected persona rather than ambient git config', async () => {
		const root = mkdtempSync(join(tmpdir(), 'swarm-delivery-'));
		roots.push(root);
		fixtureGit(root, ['init']);
		fixtureGit(root, ['config', 'user.name', 'Ambient User']);
		fixtureGit(root, ['config', 'user.email', 'ambient@example.com']);
		writeFileSync(join(root, 'change.txt'), 'prepared\n');
		const sha = await commitPreparedTree(root, 'feat: deliver', {
			name: 'swarm-implementer',
			email: 'swarm-implementer@users.noreply.github.com',
		});
		const identity = fixtureGit(root, ['show', '-s', '--format=%an <%ae>|%cn <%ce>', sha]).trim();
		expect(identity).toBe(
			'swarm-implementer <swarm-implementer@users.noreply.github.com>|swarm-implementer <swarm-implementer@users.noreply.github.com>',
		);
	});

	it('commits deliverable changes when hand-off artifacts are ignored', async () => {
		const root = mkdtempSync(join(tmpdir(), 'swarm-delivery-'));
		roots.push(root);
		fixtureGit(root, ['init']);
		writeFileSync(
			join(root, '.gitignore'),
			['implementation_handoff.json', '.swarm_delivery.json'].join('\n'),
		);
		writeFileSync(join(root, 'change.txt'), 'prepared\n');
		writeFileSync(join(root, 'implementation_handoff.json'), '{}\n');
		writeFileSync(join(root, '.swarm_delivery.json'), '{}\n');

		const sha = await commitPreparedTree(root, 'feat: deliver', {
			name: 'swarm-implementer',
			email: 'swarm-implementer@users.noreply.github.com',
		});
		const committed = fixtureGit(root, ['show', '--format=', '--name-only', sha]);
		expect(committed.trim().split('\n')).toEqual(['.gitignore', 'change.txt']);
	});

	// The Tier 2 checkpoint (issue #299) is a scratch artifact only because it is
	// registered in `HANDOFF_FILENAMES`. Assert that against real git rather than
	// inheriting it from the entry: it is the acceptance criterion that a
	// checkpoint can never reach a commit, and therefore never a pushed branch.
	it('keeps a checkpoint file out of the delivered commit', async () => {
		const root = mkdtempSync(join(tmpdir(), 'swarm-delivery-'));
		roots.push(root);
		fixtureGit(root, ['init']);
		writeFileSync(join(root, '.gitignore'), `${HANDOFF_FILENAMES.checkpoint}\n`);
		writeFileSync(join(root, 'change.txt'), 'prepared\n');
		writeFileSync(join(root, HANDOFF_FILENAMES.checkpoint), '{"phase":"implementation"}\n');

		const sha = await commitPreparedTree(root, 'feat: deliver', {
			name: 'swarm-implementer',
			email: 'swarm-implementer@users.noreply.github.com',
		});
		const committed = fixtureGit(root, ['show', '--format=', '--name-only', sha]);
		expect(committed.trim().split('\n')).toEqual(['.gitignore', 'change.txt']);
		expect(fixtureGit(root, ['ls-files'])).not.toContain(HANDOFF_FILENAMES.checkpoint);
	});

	it('refuses to deliver a tree where the checkpoint has been force-added', async () => {
		const root = mkdtempSync(join(tmpdir(), 'swarm-delivery-'));
		roots.push(root);
		fixtureGit(root, ['init']);
		writeFileSync(join(root, '.gitignore'), `${HANDOFF_FILENAMES.checkpoint}\n`);
		writeFileSync(join(root, 'change.txt'), 'prepared\n');
		writeFileSync(join(root, HANDOFF_FILENAMES.checkpoint), '{"phase":"implementation"}\n');
		fixtureGit(root, ['add', '--force', '--', HANDOFF_FILENAMES.checkpoint]);

		await expect(validatePreparedTree(root)).rejects.toThrow(
			`scratch artifact is tracked (${HANDOFF_FILENAMES.checkpoint})`,
		);
	});
});
