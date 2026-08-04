/**
 * Antigravity session capture — the **fallback** half of "resume an `agy` run".
 *
 * The primary source is the CLI's own output: `agy --output-format stream-json`
 * prints a `conversation_id` in its opening event and repeats it on every
 * record after ({@link ./antigravity-stream.ts}), and the harness prefers that
 * ({@link ./agent-cli.ts}'s `resolveSessionId`). This module covers the two
 * cases that stream can't:
 *
 *  1. **An `agy` predating `--output-format`** — 1.1.3 has no such flag, so the
 *     harness's capability probe ({@link ./antigravity-capabilities.ts}) drops
 *     it and the run prints plain text with no id in it.
 *  2. **A run killed before its opening event was captured** — precisely the
 *     rate-limited and timed-out runs that resume exists for.
 *
 * Unlike `claude` (which lets SWARM *assign* a session UUID via `--session-id`)
 * `agy` has no assign-upfront flag at all, so a fresh run's id can only ever be
 * learned after the fact. When stdout carries none, the remaining route is its
 * on-disk conversation store: snapshot the set of conversation files *before*
 * the run, then diff *after* it, and the new file's basename is this run's
 * conversation id — the value `agy --conversation <id>` takes to resume it
 * (ai/RULES.md §6: each CLI's resume mechanism differs; the harness owns these
 * quirks). The conversation `.db` doesn't embed the working directory (verified
 * live), so the diff is the only handle on "which one was mine".
 *
 * This is best-effort: if the store is missing, unreadable, or the diff is
 * ambiguous, capture returns `undefined` and the run simply isn't resumable —
 * the caller falls back to a from-scratch retry, never a failure.
 */

import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { logger } from '../lib/logger.js';

/**
 * Where `agy` stores one SQLite file per conversation, `<conversation-id>.db`
 * (plus transient `-wal`/`-shm` companions). Overridable via
 * `SWARM_ANTIGRAVITY_CONVERSATIONS_DIR` for tests and non-default installs;
 * defaults to the observed live location.
 */
export function conversationsDir(): string {
	return (
		process.env.SWARM_ANTIGRAVITY_CONVERSATIONS_DIR ||
		path.join(homedir(), '.gemini', 'antigravity-cli', 'conversations')
	);
}

/** Map a directory entry to its conversation id, or undefined if it isn't one. */
function conversationIdFromEntry(entry: string): string | undefined {
	// Only the primary `.db` file names the conversation; `.db-wal` / `.db-shm`
	// are transient SQLite companions for the same id and must not be counted as
	// separate conversations.
	return entry.endsWith('.db') ? entry.slice(0, -'.db'.length) : undefined;
}

/**
 * Snapshot the conversation ids present before a run starts. Returns an empty
 * set when the store doesn't exist yet (a first-ever `agy` run creates it) or
 * can't be read — the after-diff then simply attributes any new file to this run.
 *
 * Synchronous on purpose: it runs immediately before `spawn` in the harness, and
 * a sync read keeps the spawn on the same tick (no observable delay to the run,
 * and the harness's "spawn happens synchronously" contract holds). The store is
 * a small local directory, so the read is cheap.
 */
export function snapshotConversationIds(dir = conversationsDir()): Set<string> {
	try {
		const ids = new Set<string>();
		for (const entry of readdirSync(dir)) {
			const id = conversationIdFromEntry(entry);
			if (id) ids.add(id);
		}
		return ids;
	} catch {
		return new Set<string>();
	}
}

/**
 * Diff the conversation store against a {@link snapshotConversationIds} taken
 * before the run, returning the id of the conversation this run created — the one
 * id that appeared since the snapshot. Returns `undefined` when nothing new
 * appeared, the store can't be read, or the result is **ambiguous**.
 *
 * Ambiguity (more than one new `.db`) only arises at
 * `SWARM_WORKER_CONCURRENCY > 1`, when a concurrent `agy` run created its own
 * conversation in the same window. We deliberately give up rather than guess: an
 * `agy` `.db` is written throughout its run (not only at close), so "newest
 * mtime" does not reliably identify *this* run's conversation, and picking a
 * sibling task's id would resume the wrong session's context into this worktree.
 * Returning `undefined` degrades safely — the run simply isn't resumable and the
 * retry starts fresh, which is strictly better than resuming the wrong session.
 */
export function detectNewConversationId(
	before: Set<string>,
	dir = conversationsDir(),
): string | undefined {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return undefined;
	}
	const fresh: string[] = [];
	for (const entry of entries) {
		const id = conversationIdFromEntry(entry);
		if (id && !before.has(id)) fresh.push(id);
	}
	if (fresh.length === 1) return fresh[0];
	if (fresh.length > 1) {
		logger.debug('antigravity-session: ambiguous new conversations, skipping capture', {
			count: fresh.length,
		});
	}
	return undefined;
}
