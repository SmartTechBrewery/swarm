/**
 * The **staged fleet update** vocabulary (issue #940) — the durable record that
 * turns issue #921's one-shot fan-out into a rollout an operator advances a wave
 * at a time, and which stops on its own when the target build turns out to be bad.
 *
 * It sits beside `./worker.ts` for that module's reason: this is the domain shape,
 * so the `worker_update_rollouts` / `worker_update_rollout_members` tables
 * (`../db/schema/workerUpdateRollouts.ts`), the repository over them, and the
 * control-plane policy that drives them (`../api/worker-update-rollout.ts`) all
 * import *this* definition rather than re-declaring three nearly-identical ones
 * (ai/CODING_STANDARDS.md "Zod is the source of truth"). Dependency-free beyond
 * `zod` and the shared build vocabulary, exactly like `./worker.ts`.
 *
 * The two state machines are deliberately separate. The **rollout** says whether
 * the operator's action is still moving (`in_progress`), stopped itself on a bad
 * build (`halted`), or finished (`completed`); the **member** says where one
 * machine stands inside it. Neither is derivable from the other: a halted rollout
 * still has members mid-flight whose outcome is worth recording, and a rollout
 * whose every member is settled is only `completed` if none of them settled badly.
 */

import { z } from 'zod';

import { WorkerUpdateStatusSchema, WorkerUpdateTargetSchema } from '../lib/build-identity.js';

/**
 * What a rollout as a whole is doing.
 *
 * - `in_progress` — the operator's action is live: advancing it drains, signals,
 *   verifies and returns machines to the pool.
 * - `halted` — a member reported `failed`/`refused`/`declined`, or applied and
 *   never came back. No further wave is drained or signalled; `haltReason` records
 *   why, in the machine's own words where it had any. **Terminal** — there is no
 *   resume, exactly as issue #933 has no cancel for a single request; the way
 *   forward is to fix the build and start a new rollout.
 * - `completed` — every member settled, none of them badly.
 *
 * Stored as free `text` with this enum as the source of truth, the treatment
 * `worker_project_enrollments.status` already gets.
 */
export const WORKER_UPDATE_ROLLOUT_STATUSES = ['in_progress', 'halted', 'completed'] as const;
export const WorkerUpdateRolloutStatusSchema = z.enum(WORKER_UPDATE_ROLLOUT_STATUSES);
export type WorkerUpdateRolloutStatus = z.infer<typeof WorkerUpdateRolloutStatusSchema>;

/**
 * Where one machine stands inside a rollout. The first four are *unsettled* — the
 * rollout is waiting on that machine and will not start another wave — and the last
 * three are settled.
 *
 * - `queued` — named by the rollout, not yet touched. It is still in the dispatch
 *   pool and stays there until its wave comes up, which is what bounds the capacity
 *   a rollout can take down at once.
 * - `draining` — the rollout took it out of the pool and is waiting for it to go
 *   idle. Draining never interrupts a run, so a machine mid-phase simply waits here
 *   and is signalled on a later advance.
 * - `signalled` — idle, and asked to move through the same per-machine request
 *   phase 1 sends (`fanOutWorkerUpdate`). Waiting for the machine's own report.
 * - `verifying` — the machine reported `applied` or `adopted`; waiting for a daemon
 *   on the new build to take a fresh lease. This is the state the come-back window
 *   bounds.
 * - `done` — settled good: it came back on the new build, or reported
 *   `already-current` — the install root was on the target and the daemon was already
 *   running it — and so needed no restart at all.
 * - `skipped` — settled without being moved, and **not** a failure: the rollout
 *   halted before this machine's wave came up, or another session re-targeted the
 *   machine so there is nothing left for this rollout to verify.
 * - `failed` — settled bad. This is the state that halts the rollout.
 */
export const WORKER_UPDATE_ROLLOUT_MEMBER_STATES = [
	'queued',
	'draining',
	'signalled',
	'verifying',
	'done',
	'skipped',
	'failed',
] as const;
export const WorkerUpdateRolloutMemberStateSchema = z.enum(WORKER_UPDATE_ROLLOUT_MEMBER_STATES);
export type WorkerUpdateRolloutMemberState = z.infer<typeof WorkerUpdateRolloutMemberStateSchema>;

/**
 * The member states the rollout is finished with — the complement of "still
 * waiting". Exported as a list, and not only through the predicate below, because
 * the repository's own "is this rollout still worth advancing" read has to express
 * the same set in SQL and must not restate it (issue #1023).
 */
export const SETTLED_WORKER_UPDATE_ROLLOUT_MEMBER_STATES = [
	'done',
	'skipped',
	'failed',
] as const satisfies readonly WorkerUpdateRolloutMemberState[];

const SETTLED_MEMBER_STATES = new Set<WorkerUpdateRolloutMemberState>(
	SETTLED_WORKER_UPDATE_ROLLOUT_MEMBER_STATES,
);

/** Whether the rollout has finished with this member, whatever became of it. */
export function isSettledMemberState(state: WorkerUpdateRolloutMemberState): boolean {
	return SETTLED_MEMBER_STATES.has(state);
}

/**
 * The member states in which the rollout has **committed** to the machine — taken it
 * into a wave and not yet settled it. A `queued` member is neither: it is not reached
 * yet, nothing was drained for it, and nothing is owed on it.
 *
 * Exported as a list for the same reason the settled one is: the repository's
 * "does another rollout still hold this machine" read has to express the same set in
 * SQL (issue #1023) and must not restate it.
 */
export const COMMITTED_WORKER_UPDATE_ROLLOUT_MEMBER_STATES = [
	'draining',
	'signalled',
	'verifying',
] as const satisfies readonly WorkerUpdateRolloutMemberState[];

const COMMITTED_MEMBER_STATES = new Set<WorkerUpdateRolloutMemberState>(
	COMMITTED_WORKER_UPDATE_ROLLOUT_MEMBER_STATES,
);

/** Whether the rollout has taken this machine into a wave and still owes it an answer. */
export function isCommittedMemberState(state: WorkerUpdateRolloutMemberState): boolean {
	return COMMITTED_MEMBER_STATES.has(state);
}

/**
 * The reported outcomes that halt a rollout. `failed` and `refused` are the machine
 * saying the move did not happen; `declined` is the legacy answer from a machine
 * still on a build predating issue #975, whose host had not set the per-host opt-in
 * that issue removed (`../lib/build-identity.ts`).
 *
 * `declined` halts for the same reason the other two do, even though it says nothing
 * about the *build*: a fleet whose next machine cannot be moved is a fleet the
 * rollout cannot finish, and carrying on would drain machine after machine only to
 * be declined by each in turn. Halting says so once, on the first one. The remedy is
 * now to update that machine by hand once — after which it is on a build with no
 * opt-in to decline from, and never declines again.
 *
 * `applied`, `adopted` and `already-current` are the three that do not halt — the
 * first two move the member to `verifying`, the third settles it on the spot.
 */
export const HALTING_WORKER_UPDATE_STATUSES = ['failed', 'refused', 'declined'] as const;
const HALTING_STATUSES = new Set<string>(HALTING_WORKER_UPDATE_STATUSES);

/** Whether a machine's reported outcome is one that stops the rollout. */
export function isHaltingUpdateStatus(status: string): boolean {
	return HALTING_STATUSES.has(status);
}

/**
 * The other half of that vocabulary: the reported outcomes that end with the machine
 * restarting, so a rollout waits for it to come back before settling the member.
 *
 * `applied` is the daemon that did the fetch and the build; `adopted` is one that
 * restarted onto a build a peer on the same machine fetched (issue #973). Both are
 * successes and both restart, which is the only thing this distinction is asked for
 * here — it lives in this module rather than in the control-plane policy that reads it
 * because this is where the domain words are defined, so the policy asks rather than
 * hard-codes.
 */
export const RESTARTING_WORKER_UPDATE_STATUSES = ['applied', 'adopted'] as const;
const RESTARTING_STATUSES = new Set<string>(RESTARTING_WORKER_UPDATE_STATUSES);

/** Whether a machine's reported outcome is one it restarts into a new build on. */
export function isRestartingUpdateStatus(status: string): boolean {
	return RESTARTING_STATUSES.has(status);
}

/**
 * How many machines one advance may take out of the pool.
 *
 * **One**, deliberately, because the default has to be the safe one: this is the
 * knob that decides how much of a fleet's capacity is down at any instant, and an
 * operator who has not thought about it should get the rollout that costs the least.
 * A wider wave is an explicit `--wave N`, and is not capped — an operator who asks
 * for their whole fleet at once has chosen a big-bang with their eyes open, and a
 * cap would only be a second, arbitrary number to argue with.
 */
export const DEFAULT_ROLLOUT_WAVE_SIZE = 1;

/** A wave size: a positive integer. See {@link DEFAULT_ROLLOUT_WAVE_SIZE} for why it is uncapped. */
export const RolloutWaveSizeSchema = z.number().int().positive();

/**
 * One machine's place in a rollout — the persisted form of a
 * `worker_update_rollout_members` row.
 *
 * `position` is the order the rollout will reach the machines in, taken from
 * `listWorkersForOwner` at start so it matches the list `swarm workers list`
 * already prints. `requestId` is the per-machine request id phase 1 minted, kept so
 * a report can be told from a stale one exactly as the `workers` row tells them
 * apart. `outcome`/`message` are the machine's own words, recorded verbatim.
 *
 * Three fields exist purely so the come-back verdict is decidable *later*, against
 * what was true at signal time:
 *
 * - `drainedByRollout` — whether *this rollout* took the machine out of the pool. A
 *   machine the operator had already drained for their own reasons is left drained
 *   when the rollout is done with it; only one it drained itself is returned.
 * - `fencingTokenAtSignal` — `worker_sessions.fencing_token` as it stood when the
 *   machine was signalled. It is per-worker monotonic and bumped on every
 *   re-acquire, so a larger one is the exact "a new daemon process took the lease"
 *   signal. `null` when the machine had no live session to read one from, in which
 *   case any live session afterwards is that signal.
 * - `buildCommitAtSignal` — the commit the machine's install root declared then. A
 *   machine that returned *itself* to its last known good build (issue #934) also
 *   comes back with a bumped token, so the token alone answers "came back" and not
 *   "came back **on the new build**"; the commit having moved is what answers the
 *   second. `null` when the machine declared no build, which is the one case the
 *   verdict falls back to the token alone.
 */
export const WorkerUpdateRolloutMemberSchema = z.object({
	workerId: z.string().uuid(),
	position: z.number().int().nonnegative(),
	state: WorkerUpdateRolloutMemberStateSchema,
	requestId: z.string().uuid().nullable(),
	outcome: WorkerUpdateStatusSchema.nullable(),
	message: z.string().nullable(),
	drainedByRollout: z.boolean(),
	fencingTokenAtSignal: z.number().nullable(),
	buildCommitAtSignal: z.string().nullable(),
	signalledAt: z.date().nullable(),
	settledAt: z.date().nullable(),
});
export type WorkerUpdateRolloutMember = z.infer<typeof WorkerUpdateRolloutMemberSchema>;

/**
 * A staged fleet update — the persisted form of a `worker_update_rollouts` row.
 *
 * `requestedByUserId` is both the owner whose machines it names and the scope it is
 * read back under: a rollout is strictly one operator's own fleet, inheriting
 * `requestUpdateForMine`'s owner-only rule rather than restating it (issue #922 owns
 * the administrator-over-someone-else's-machine question). `target` is the build
 * every member is being moved to, `waveSize` how many may be taken out of the pool
 * per advance, and `haltReason` the operator-facing sentence recorded when `status`
 * became `halted` — `null` at every other status.
 */
export const WorkerUpdateRolloutSchema = z.object({
	id: z.string().uuid(),
	requestedByUserId: z.string().uuid(),
	target: WorkerUpdateTargetSchema,
	waveSize: RolloutWaveSizeSchema,
	status: WorkerUpdateRolloutStatusSchema,
	haltReason: z.string().nullable(),
	createdAt: z.date(),
	updatedAt: z.date(),
});
export type WorkerUpdateRollout = z.infer<typeof WorkerUpdateRolloutSchema>;
