import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
	commitPreparedTree,
	DeliveryDeferredError,
	DeliveryDivergedError,
	deliveryIdentity,
	HANDOFF_FILENAMES,
	ImplementationHandoffSchema,
	loadDeliveryProgress,
	pushDeliveredBranch,
	readHandoff,
	saveDeliveryProgress,
	shouldDeferDeliveryFailure,
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

/**
 * The push guard (issue #558). Run against real repositories rather than a stub
 * git, because the whole question is what git *actually* reports for a rejected
 * push and whether the two histories really have diverged.
 */
describe('pushDeliveredBranch', () => {
	/** A bare origin plus a clone of it, both with one shared commit on `main`. */
	function makeRemoteAndClone(): { origin: string; clone: string } {
		const root = mkdtempSync(join(tmpdir(), 'swarm-push-'));
		roots.push(root);
		const origin = join(root, 'origin.git');
		const seed = join(root, 'seed');
		const clone = join(root, 'clone');
		execFileSync('git', ['init', '--bare', '-b', 'main', origin], { env: fixtureGitEnvironment });
		execFileSync('git', ['clone', origin, seed], { env: fixtureGitEnvironment });
		writeFileSync(join(seed, 'README.md'), 'seed\n');
		fixtureGit(seed, ['add', '.']);
		fixtureGit(seed, ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-m', 'seed']);
		fixtureGit(seed, ['push', 'origin', 'main']);
		execFileSync('git', ['clone', origin, clone], { env: fixtureGitEnvironment });
		return { origin, clone };
	}

	/** Commit `content` on `branch` in `cwd` and return the new sha. */
	function commitOn(cwd: string, branch: string, content: string): string {
		fixtureGit(cwd, ['checkout', '-q', '-B', branch]);
		writeFileSync(join(cwd, 'work.txt'), content);
		fixtureGit(cwd, ['add', '.']);
		fixtureGit(cwd, ['-c', 'user.email=t@e.com', '-c', 'user.name=T', 'commit', '-m', content]);
		return fixtureGit(cwd, ['rev-parse', 'HEAD']).trim();
	}

	/** A delivery whose `pushBranch` is a real `git push` of `<sha>:refs/heads/<branch>`. */
	const realPush = {
		pushBranch: async (cwd: string, branch: string, expectedSha: string) => {
			execFileSync('git', ['push', 'origin', `${expectedSha}:refs/heads/${branch}`], {
				cwd,
				env: fixtureGitEnvironment,
				stdio: 'pipe',
			});
		},
	};

	it('pushes a fast-forward delivery unchanged', async () => {
		const { clone } = makeRemoteAndClone();
		const sha = commitOn(clone, 'issue-1', 'first\n');

		await expect(pushDeliveredBranch(realPush, clone, 'issue-1', sha)).resolves.toBeUndefined();
	});

	// The incident's inner loop: the branch on origin carries someone else's commit,
	// so this push is rejected identically however many times it is retried.
	it('names the divergence and fails terminally when the branch cannot fast-forward', async () => {
		const { origin, clone } = makeRemoteAndClone();
		const other = mkdtempSync(join(tmpdir(), 'swarm-push-other-'));
		roots.push(other);
		execFileSync('git', ['clone', origin, other], { env: fixtureGitEnvironment });
		const remoteSha = commitOn(other, 'issue-1', 'delivered by the first attempt\n');
		fixtureGit(other, ['push', 'origin', 'issue-1']);
		const localSha = commitOn(clone, 'issue-1', 'a second implementation of the same task\n');

		const error = await pushDeliveredBranch(realPush, clone, 'issue-1', localSha).catch((e) => e);

		expect(error).toBeInstanceOf(DeliveryDivergedError);
		// The message is the whole point: it names both heads so an operator can act
		// without reproducing the push.
		expect(error.message).toContain(remoteSha);
		expect(error.message).toContain(localSha);
		// Terminal, not deferrable — a retry would repeat the identical rejection.
		// Asserted with delivery progress actually recorded in the checkout, since
		// that is the condition that would otherwise turn any failure into a deferral.
		expect(error).not.toBeInstanceOf(DeliveryDeferredError);
		saveDeliveryProgress(clone, {
			deliveryId: 'd1',
			commitSha: localSha,
			pushed: false,
			followUpEnqueued: false,
		});
		expect(shouldDeferDeliveryFailure(new Error('transient API failure'), clone)).toBe(true);
		expect(shouldDeferDeliveryFailure(error, clone)).toBe(false);
	});

	// Only a *proven* divergence is terminal. A rejection whose remote head is still
	// an ancestor (a hook, a protected branch, a race that has resolved) stays the
	// deferrable failure it was, so a transient condition keeps its retry.
	it('rethrows a rejection that is not a divergence', async () => {
		const { clone } = makeRemoteAndClone();
		const sha = commitOn(clone, 'issue-1', 'first\n');
		await realPush.pushBranch(clone, 'issue-1', sha);
		const rejected = {
			pushBranch: async () => {
				throw new Error('Command failed: git push\n ! [rejected] issue-1 -> issue-1 (fetch first)');
			},
		};

		const error = await pushDeliveredBranch(rejected, clone, 'issue-1', sha).catch((e) => e);

		expect(error).not.toBeInstanceOf(DeliveryDivergedError);
		expect(error.message).toContain('[rejected]');
	});

	it('rethrows a push failure that is not a rejection at all', async () => {
		const { clone } = makeRemoteAndClone();
		const failing = {
			pushBranch: async () => {
				throw new Error('fatal: could not read from remote repository');
			},
		};

		await expect(pushDeliveredBranch(failing, clone, 'issue-1', 'deadbeef')).rejects.toThrow(
			'could not read from remote repository',
		);
	});
});
