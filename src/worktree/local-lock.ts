/**
 * The liveness/expiry primitives SWARM's host-local locks share.
 *
 * Two locks on a worker host ask the same question about a record left on disk —
 * *is the process that wrote this still there?* — at different scopes:
 * `./host-local-runtime.ts` per `(project, task)` checkout, and
 * `./checkout-lock.ts` per repository checkout, for the daemon itself (issue
 * #689). Their TTLs are deliberately different, because a single agent run and a
 * daemon that lives for days are not the same lifetime, but the answer to "is
 * that owner still alive" must not fork — so it is defined once, here.
 *
 * Liveness (a pid check) is the *fast* path; a recorded timestamp is the backstop
 * for what liveness cannot see — a reused pid, a crash between two syscalls, a
 * truncated write.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import type { z } from 'zod';

/**
 * `null` — absent. `undefined` — present but unparseable, which is *not* the same
 * answer: an absent artifact is free, an unreadable one is occupied by something
 * this process cannot identify.
 */
export function readJson<T>(path: string, schema: z.ZodType<T>): T | null | undefined {
	if (!existsSync(path)) return null;
	try {
		return schema.parse(JSON.parse(readFileSync(path, 'utf8')));
	} catch {
		return undefined;
	}
}

/** An unparseable or missing timestamp counts as expired — it cannot be trusted to bound anything. */
export function isExpired(createdAt: string, ttlMs: number, now = Date.now()): boolean {
	const at = Date.parse(createdAt);
	if (Number.isNaN(at)) return true;
	return now - at > ttlMs;
}

/** Fallback age for an artifact whose own timestamp is unreadable or was never written. */
export function pathOlderThan(path: string, ttlMs: number, now = Date.now()): boolean {
	try {
		return now - statSync(path).mtimeMs > ttlMs;
	} catch {
		// Vanished underneath us — treat as gone rather than as protected.
		return true;
	}
}

export function pidIsLive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'EPERM';
	}
}
