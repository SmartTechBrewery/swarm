/** Host-local worktree coordination for a DB/Redis-free remote worker. */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { WorktreeRuntime } from './worktree-runtime.js';

const LocalLeaseSchema = z.object({
	token: z.string().min(1),
	ownerId: z.string().min(1),
	ownerKey: z.string().min(1),
	pid: z.number().int().positive(),
	createdAt: z.string().datetime(),
});
type LocalLease = z.infer<typeof LocalLeaseSchema>;

const LocalPinSchema = z.object({
	ownerKey: z.string().min(1),
	createdAt: z.string().datetime(),
});

export interface HostLocalWorktreeRuntimeOptions {
	repoRoot: string;
	worktreeRoot: string;
	/** The dispatch currently executing in this process. */
	ownerId: string;
	/** Stable run id used to let that run adopt its own preserved checkout. */
	runId?: string;
	isOwnerLive(ownerId: string): boolean;
	shutdownSignal?: AbortSignal;
}

function stateKey(projectId: string, taskId: string): string {
	return createHash('sha256').update(`${projectId}\0${taskId}`).digest('hex');
}

function readJson<T>(path: string, schema: z.ZodType<T>): T | null | undefined {
	if (!existsSync(path)) return null;
	try {
		return schema.parse(JSON.parse(readFileSync(path, 'utf8')));
	} catch {
		return undefined;
	}
}

function pidIsLive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}

/**
 * Atomic directory creation is the local equivalent of Redis `SET NX`. A
 * takeover guard serializes stale-lock replacement across daemon processes, so
 * two provisioners cannot both remove or adopt one checkout.
 */
export function createHostLocalWorktreeRuntime(
	options: HostLocalWorktreeRuntimeOptions,
): WorktreeRuntime {
	const stateRoot = resolve(options.repoRoot, options.worktreeRoot, '.swarm-state');
	const ownerKey = options.runId ?? options.ownerId;

	function paths(projectId: string, taskId: string) {
		const key = stateKey(projectId, taskId);
		return {
			lock: resolve(stateRoot, `${key}.lock`),
			owner: resolve(stateRoot, `${key}.lock`, 'owner.json'),
			pin: resolve(stateRoot, `${key}.pin.json`),
			takeover: resolve(stateRoot, `${key}.takeover`),
		};
	}

	function ownerIsLive(owner: LocalLease): boolean {
		if (owner.pid === process.pid) return options.isOwnerLive(owner.ownerId);
		return pidIsLive(owner.pid);
	}

	function writeOwner(path: string, token: string): void {
		const owner: LocalLease = {
			token,
			ownerId: options.ownerId,
			ownerKey,
			pid: process.pid,
			createdAt: new Date().toISOString(),
		};
		writeFileSync(path, `${JSON.stringify(owner)}\n`, { encoding: 'utf8', flag: 'wx' });
	}

	function clearOwnPin(projectId: string, taskId: string): void {
		const pinPath = paths(projectId, taskId).pin;
		const pin = readJson(pinPath, LocalPinSchema);
		if (pin?.ownerKey === ownerKey) rmSync(pinPath, { force: true });
	}

	const runtime: WorktreeRuntime = {
		async tryClaim(projectId, taskId, token = '1') {
			const path = paths(projectId, taskId);
			mkdirSync(stateRoot, { recursive: true });
			if (existsSync(path.takeover)) return false;
			try {
				mkdirSync(path.lock);
				try {
					writeOwner(path.owner, token);
				} catch (error) {
					rmSync(path.lock, { recursive: true, force: true });
					throw error;
				}
				clearOwnPin(projectId, taskId);
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
				throw error;
			}
		},
		async claim(projectId, taskId, token = '1') {
			if (await runtime.tryClaim(projectId, taskId, token)) return;
			const path = paths(projectId, taskId);
			const current = readJson(path.owner, LocalLeaseSchema);
			if (current?.ownerId === options.ownerId) {
				clearOwnPin(projectId, taskId);
				return;
			}
			if (
				current &&
				!ownerIsLive(current) &&
				(await runtime.takeOver(projectId, taskId, current.token, token))
			) {
				return;
			}
			throw new Error(`Host-local worktree lease is already held for task '${taskId}'`);
		},
		async release(projectId, taskId, token) {
			const path = paths(projectId, taskId);
			const current = readJson(path.owner, LocalLeaseSchema);
			if (!current || current.ownerId !== options.ownerId) return;
			if (token !== undefined && current.token !== token) return;
			rmSync(path.lock, { recursive: true, force: true });
		},
		async read(projectId, taskId) {
			const current = readJson(paths(projectId, taskId).owner, LocalLeaseSchema);
			if (current === null) return null;
			return current?.token ?? 'unreadable-host-local-lease';
		},
		async takeOver(projectId, taskId, expectedToken, token) {
			const path = paths(projectId, taskId);
			try {
				mkdirSync(path.takeover);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
				throw error;
			}
			try {
				const current = readJson(path.owner, LocalLeaseSchema);
				if (!current || current.token !== expectedToken || ownerIsLive(current)) return false;
				rmSync(path.lock, { recursive: true, force: true });
				mkdirSync(path.lock);
				writeOwner(path.owner, token);
				clearOwnPin(projectId, taskId);
				return true;
			} finally {
				rmSync(path.takeover, { recursive: true, force: true });
			}
		},
		async isLeased(projectId, taskId) {
			const current = readJson(paths(projectId, taskId).owner, LocalLeaseSchema);
			if (current === null) return false;
			if (current === undefined) return true;
			return ownerIsLive(current);
		},
		async hasLiveOwner(projectId, taskId) {
			return runtime.isLeased(projectId, taskId);
		},
		async isResumablePinned(projectId, taskId) {
			const pin = readJson(paths(projectId, taskId).pin, LocalPinSchema);
			if (pin === null) return false;
			if (pin === undefined) return true;
			return pin.ownerKey !== ownerKey;
		},
		async isCancellationRequested() {
			return options.shutdownSignal?.aborted === true;
		},
		async preserve(projectId, taskId) {
			const path = paths(projectId, taskId);
			mkdirSync(stateRoot, { recursive: true });
			const temp = `${path.pin}.${randomUUID()}.tmp`;
			writeFileSync(
				temp,
				`${JSON.stringify({ ownerKey, createdAt: new Date().toISOString() })}\n`,
				'utf8',
			);
			renameSync(temp, path.pin);
			await runtime.release(projectId, taskId);
		},
		async clearPreservation(projectId, taskId) {
			rmSync(paths(projectId, taskId).pin, { force: true });
		},
	};

	return runtime;
}
