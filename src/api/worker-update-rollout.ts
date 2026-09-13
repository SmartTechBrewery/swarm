/**
 * Stage a fleet update into **waves that halt on a bad build** (issue #940) — the
 * control-plane policy `workers.startFleetUpdate` / `workers.fleetUpdateStatus`
 * program against, sitting beside the other `src/api/` helper modules
 * (`./worker-update-fanout.ts`, `./worker-access.ts`) rather than inside a router.
 *
 * It lives here rather than under `src/identity/` for one concrete reason: it
 * drives phase 1's `fanOutWorkerUpdate`, which is `src/api/` policy, and nothing
 * under `src/identity/` or `src/db/` imports `src/api/`. Only the *vocabulary* is a
 * domain fact, and that is where it stays (`../identity/worker-update-rollout.ts`),
 * so the schema and the repository can import it without either direction
 * inverting.
 *
 * **What is new here and what is not.** Nothing about the per-machine lifecycle
 * moves: a wave's members are asked through the very same `fanOutWorkerUpdate`,
 * which writes the same row, publishes the same notification, sends the same frame
 * and meets the same daemon decision layer. What is new is that the rollout now
 * *drains* the machines itself, a bounded number at a time, waits for each wave to
 * come back on the new build before starting the next, returns them to the pool,
 * and stops the whole thing when one of them says the build is bad.
 *
 * **Advancing happens when the operator asks.** Re-running `swarm workers update
 * --all <ref>` advances the rollout already in progress and prints where every
 * member stands — exactly as re-running `swarm workers drain` is already the
 * supported way to poll a drain, and for the same reason: the useful answer is not
 * "done" but "where is it now". Advancing with nobody watching is phase 3, which
 * hooks this same `advanceRollout` onto update reports, handshakes and a periodic
 * tick; it is deliberately not started here.
 *
 * **The draining precondition is not relaxed, it is satisfied.** Phase 1 could only
 * ask machines an operator had already drained by hand, which is what kept it from
 * taking a fleet's capacity down — and also what kept it from being a rollout. Here
 * the wave bound does that job instead: at most `waveSize` machines are out of the
 * pool at any instant, and a machine is signalled only once it has gone idle, so
 * draining still never interrupts a run.
 *
 * **There is no resume and no cancel.** A halted rollout is terminal, the way issue
 * #933 has no cancel for a single request: the way forward is to fix the build and
 * start a new rollout, which is possible precisely because only an `in_progress`
 * rollout blocks a new one.
 */

import {
	advanceUnderRolloutLock,
	createRollout,
	findInProgressRolloutForOwner,
	findLatestRolloutForOwner,
	type MemberPatch,
	type RolloutWriter,
	readRollout,
} from '../db/repositories/workerUpdateRolloutsRepository.js';
import type { Worker } from '../identity/worker.js';
import { deriveWorkerRunState } from '../identity/worker-enrollment-service.js';
import { getWorkers, listWorkersForOwner, setWorkerDraining } from '../identity/worker-service.js';
import { getLiveSessionForWorker, type WorkerSession } from '../identity/worker-session-service.js';
import {
	DEFAULT_ROLLOUT_WAVE_SIZE,
	isHaltingUpdateStatus,
	isSettledMemberState,
	type WorkerUpdateRollout,
	type WorkerUpdateRolloutMember,
} from '../identity/worker-update-rollout.js';
import type { WorkerUpdateStatus } from '../lib/build-identity.js';
import { fanOutWorkerUpdate } from './worker-update-fanout.js';

/**
 * How long a machine that reported `applied` has to come back on the new build
 * before the rollout calls the build bad and halts.
 *
 * By the time this window opens the apply is already **finished and reported** —
 * the daemon reports `applied` and only then releases its session and exits — so
 * none of `src/worker/self-update.ts`'s long command timeouts are inside it. What
 * is left is the process exit, the host supervisor's restart (launchd `KeepAlive` /
 * systemd `Restart=always`), the new build's own start, and the reconnect ladder,
 * which is capped at a jittered 30s (`DEFAULT_BACKOFF.maxMs`,
 * `../transport/worker-client.ts`) — the same ladder `offlineSilenceMs`
 * (`../router/worker-liveness.ts`) sizes its two-minute floor off. Ten minutes
 * clears that by 5x, so an ordinary slow restart never halts a rollout, while a
 * build that cannot start is caught long before issue #934's own three failed
 * starts would have returned the machine to its last known good build.
 *
 * Coded rather than configurable, like `MAX_FAILED_STARTS` next door: a larger
 * number only lengthens how long a fleet keeps rolling onto a build that is already
 * known not to start.
 */
const COME_BACK_WINDOW_MS = 10 * 60_000;

/** One machine's line in a rollout readout — its member row plus the label an operator reads it by. */
export interface RolloutMemberView extends WorkerUpdateRolloutMember {
	displayName: string;
}

/** A rollout as the API surfaces answer it. */
export interface RolloutView {
	rollout: WorkerUpdateRollout;
	members: RolloutMemberView[];
}

/**
 * What a `startRollout` call did. Four outcomes rather than a view alone, because
 * the caller words three of them differently:
 *
 * - `started` — a new rollout, with its first wave already drained and signalled.
 * - `advanced` — one was already in progress **for this same target**, so this call
 *   advanced it. That is the issue's own contract: re-running the command is how an
 *   operator moves a rollout along, so asking for the build it is already moving to
 *   must never be an error.
 * - `conflict` — one is in progress for a **different** target. Two rollouts over
 *   the same machines would drain and undrain each other's members, so this is
 *   refused naming the status command rather than silently re-targeting a fleet
 *   mid-move.
 * - `no-machines` — the caller operates none, so there is nothing to roll out and
 *   no rollout is recorded. An honest empty answer, not an error, exactly as
 *   `requestUpdateForMine` answers an operator with no machines.
 */
export type StartRolloutResult =
	| { outcome: 'started'; view: RolloutView }
	| { outcome: 'advanced'; view: RolloutView }
	| { outcome: 'conflict'; view: RolloutView }
	| { outcome: 'no-machines' };

/** The fields a caller supplies to start a rollout. */
export interface StartRolloutInput {
	ownerUserId: string;
	target: string;
	/** Omit for {@link DEFAULT_ROLLOUT_WAVE_SIZE}; ignored when an existing rollout is advanced. */
	waveSize?: number;
}

/**
 * Start a rollout over every machine the caller owns — or advance the one already
 * moving to this same target.
 *
 * The membership snapshot is `listWorkersForOwner` order, which is what `swarm
 * workers list` already prints, so the order a rollout moves a fleet in is the
 * order the operator read it in. Nothing is recorded about a machine the operator
 * does not own: the set is theirs and nothing wider, inheriting `requestUpdate`'s
 * strictly-owner-only rule rather than restating it (issue #922 owns the
 * administrator-over-someone-else's-machine question).
 *
 * A new rollout is advanced once before it is returned, so starting one *is*
 * draining and signalling its first wave rather than recording an intention.
 *
 * The "one in progress per owner" rule is decided by the insert's own partial
 * unique index, not by the read above it: two `swarm workers update --all` calls
 * landing at the same instant would both find nothing and both insert. The loser's
 * `23505` is caught here and re-resolved against whatever actually won, so a race
 * produces the same answer as arriving second.
 */
export async function startRollout(input: StartRolloutInput): Promise<StartRolloutResult> {
	const waveSize = input.waveSize ?? DEFAULT_ROLLOUT_WAVE_SIZE;
	const existing = await findInProgressRolloutForOwner(input.ownerUserId);
	if (existing) return await resolveAgainstExisting(existing, input.target);

	const workers = await listWorkersForOwner(input.ownerUserId);
	if (workers.length === 0) return { outcome: 'no-machines' };

	let rolloutId: string;
	try {
		const created = await createRollout({
			requestedByUserId: input.ownerUserId,
			target: input.target,
			waveSize,
			workerIds: workers.map((worker) => worker.id),
		});
		rolloutId = created.rollout.id;
	} catch (error) {
		if (!isUniqueViolation(error)) throw error;
		// Lost the race to another call of this same procedure. Whatever won is the
		// rollout in progress now, so answer against it exactly as arriving second would.
		const winner = await findInProgressRolloutForOwner(input.ownerUserId);
		if (!winner) throw error;
		return await resolveAgainstExisting(winner, input.target);
	}

	const view = await advanceRollout(rolloutId);
	// Unreachable in practice — the row was just inserted — but the lock answers
	// `undefined` for a rollout that is gone, and inventing a view would be a lie.
	if (!view) throw new Error(`Rollout ${rolloutId} disappeared immediately after it was created`);
	return { outcome: 'started', view };
}

/** Advance an existing in-progress rollout, or refuse it for naming a different build. */
async function resolveAgainstExisting(
	existing: WorkerUpdateRollout,
	target: string,
): Promise<StartRolloutResult> {
	if (existing.target !== target) {
		const view = await readRolloutView(existing.id);
		if (view) return { outcome: 'conflict', view };
		// It finished between the two reads; fall through to the caller's retry rather
		// than refusing over a rollout that no longer exists.
		return { outcome: 'no-machines' };
	}
	const view = await advanceRollout(existing.id);
	if (!view) return { outcome: 'no-machines' };
	return { outcome: 'advanced', view };
}

/** The owner's most recent rollout, or `null` when they have never started one. */
export async function getRolloutForOwner(ownerUserId: string): Promise<RolloutView | null> {
	const rollout = await findLatestRolloutForOwner(ownerUserId);
	if (!rollout) return null;
	return (await readRolloutView(rollout.id)) ?? null;
}

/** One rollout as a view, resolving each member's machine label. */
async function readRolloutView(rolloutId: string): Promise<RolloutView | undefined> {
	const loaded = await readRollout(rolloutId);
	if (!loaded) return undefined;
	const workers = await resolveWorkers(loaded.members);
	return { rollout: loaded.rollout, members: loaded.members.map((m) => withLabel(m, workers)) };
}

/**
 * Move a rollout on by one step, under the rollout row's own lock so two callers
 * cannot both decide the same wave has settled and both drain the next one. Returns
 * `undefined` when no rollout has that id.
 *
 * The order of the steps is the whole design, and each one only ever looks at
 * durable state, so re-running it is a no-op rather than a second effect:
 *
 * 1. **Settle** every member that was signalled, from the answer on its own
 *    `workers` row. `applied` moves it on to verification, `already-current`
 *    settles it on the spot (nothing restarted, so there is nothing to come back
 *    from), and `failed`/`refused`/`declined` settles it badly and **halts**.
 * 2. **Verify** every member that applied: it has come back when a daemon has taken
 *    a fresh lease *and* the machine is no longer declaring the build it started
 *    from. Not coming back inside {@link COME_BACK_WINDOW_MS} halts too — a build
 *    that cannot start says nothing, so silence has to be the verdict.
 * 3. **Return** each member the rollout is finished with to the dispatch pool, but
 *    only one the rollout drained itself: a machine the operator had drained for
 *    their own reasons is left exactly as they left it.
 * 4. **Stand down** every machine the rollout has not committed to yet, if it has
 *    halted — so a halt leaves the untouched majority of the fleet in the pool.
 * 5. **Advance**, while it is still in progress: take the next `waveSize` queued
 *    members only once nothing is in flight, drain them, and signal the ones that
 *    have gone idle. A member still running a phase stays draining and is signalled
 *    on a later advance — draining never interrupts a run.
 * 6. **Complete** when every member has settled.
 */
export async function advanceRollout(rolloutId: string): Promise<RolloutView | undefined> {
	return await advanceUnderRolloutLock(rolloutId, async (loaded, write) => {
		const pass = new AdvancePass(loaded.rollout, loaded.members, write);
		await pass.run();
		return pass.view();
	});
}

/**
 * What one member's durable state says should become of it: the patch to write,
 * whether the machine goes back in the dispatch pool, and the sentence that stops
 * the rollout when this settlement is the one that stops it.
 *
 * Every rule below is a **pure function returning one of these** rather than a
 * method that writes, so the state machine reads as a table of decisions and the
 * class beneath it does nothing but apply them in order. That is also what makes the
 * rules testable against facts alone, with no transaction in sight.
 */
interface MemberVerdict {
	patch: MemberPatch;
	returnToPool?: boolean;
	halt?: string;
}

/** The message recorded for a member whose machine another session asked again. */
const SUPERSEDED_MESSAGE =
	'another request replaced this rollout’s, so there was nothing left to verify here';

/**
 * What a signalled member's own `workers` row says became of it, or `undefined`
 * while the machine has not answered yet.
 *
 * A row still waiting on the exact request this member was signalled with is the
 * machine not having answered. A row that has moved off it — another session
 * re-targeted the machine, or asked it again — leaves *this* rollout nothing to
 * verify, and nothing has said the build is bad, so the member is skipped rather
 * than failed and the rollout carries on.
 */
function decideSettlement(
	member: WorkerUpdateRolloutMember,
	worker: Worker,
	target: string,
	now: Date,
): MemberVerdict | undefined {
	const update = worker.update;
	if (update?.requestId && update.requestId === member.requestId) return undefined;
	if (!update || update.requestId || update.target !== target || !update.status) {
		return {
			patch: { state: 'skipped', message: SUPERSEDED_MESSAGE, settledAt: now },
			returnToPool: true,
		};
	}
	return decideReportedOutcome(worker, update.status, update.message, now);
}

/**
 * What one reported outcome means for the member that reported it — the one place
 * the five-word vocabulary is turned into a member state, shared by the machine that
 * answered this rollout's own request and the one that had already answered for this
 * same build before the rollout reached it.
 *
 * `applied` is deliberately **not** settled: the machine has done the work, but a
 * build only counts once a daemon running it has come back, which is the next step's
 * question. `already-current` settles at once, because nothing was installed and
 * nothing restarted, so there is nothing to wait for.
 */
function decideReportedOutcome(
	worker: Worker,
	outcome: WorkerUpdateStatus | null,
	message: string | null,
	now: Date,
): MemberVerdict {
	if (outcome === 'applied') return { patch: { state: 'verifying', outcome, message } };
	if (outcome && isHaltingUpdateStatus(outcome)) {
		return {
			patch: { state: 'failed', outcome, message, settledAt: now },
			halt: `worker '${worker.displayName}' reported ${outcome}${message ? `: ${message}` : ''}`,
		};
	}
	// `already-current`, or an outcome vocabulary this build has never heard of: the
	// machine answered for this build and nothing in the answer said it went badly.
	return { patch: { state: 'done', outcome, message, settledAt: now }, returnToPool: true };
}

/**
 * Whether a machine that applied has come back **on the new build**, which is two
 * facts rather than one, or `undefined` while it is still inside its window.
 *
 * A fresh lease (`worker_sessions.fencing_token`, per-worker monotonic and bumped on
 * every re-acquire) is the exact "a new daemon process took the lease" signal and
 * answers *came back*. It does not answer *on the new build*: a machine that returned
 * itself to its last known good build (issue #934) also comes back with a bumped
 * token, and calling that a success would let a rollout march a whole fleet through a
 * build none of them end up running. So the commit the machine declares at handshake
 * (issue #918) has to have moved as well — and where that cannot be answered (no
 * build declared on one side or the other) the lease stands alone, rather than a
 * member being failed over a fact nobody recorded.
 *
 * Silence past {@link COME_BACK_WINDOW_MS} is the third verdict, and it has to be:
 * a build that cannot start says nothing at all, so waiting for it to speak would
 * wait forever.
 */
function decideComeBack(
	member: WorkerUpdateRolloutMember,
	worker: Worker,
	session: WorkerSession | undefined,
	target: string,
	now: Date,
): MemberVerdict | undefined {
	// A null token at signal time means the machine had no live session to read one
	// from, so any live session now is the new daemon.
	const tookFreshLease =
		session !== undefined &&
		(member.fencingTokenAtSignal === null || session.fencingToken > member.fencingTokenAtSignal);
	const buildMoved =
		member.buildCommitAtSignal === null || !worker.build
			? undefined
			: worker.build.commit !== member.buildCommitAtSignal;

	if (tookFreshLease && buildMoved !== false) {
		return { patch: { state: 'done', settledAt: now }, returnToPool: true };
	}
	if (tookFreshLease) {
		return {
			patch: {
				state: 'failed',
				message: `came back still on ${member.buildCommitAtSignal}, the build it was asked to move off`,
				settledAt: now,
			},
			halt:
				`worker '${worker.displayName}' applied '${target}' and then came back on ` +
				`${member.buildCommitAtSignal} — the build it started from — so it did not stay on the new one`,
		};
	}
	// The window is measured from the instant the machine said `applied`, which is
	// after its own bounded fetch/install/build, so none of that time is counted
	// against it. `signalledAt` is the fallback for a member whose row no longer
	// carries the report (another session asked it again).
	const appliedAt = worker.update?.reportedAt ?? member.signalledAt ?? now;
	if (now.getTime() - appliedAt.getTime() <= COME_BACK_WINDOW_MS) return undefined;
	return {
		patch: { state: 'failed', message: 'applied the update and never came back', settledAt: now },
		halt:
			`worker '${worker.displayName}' applied '${target}' and has not come back within ` +
			`${Math.round(COME_BACK_WINDOW_MS / 60_000)} minutes — treat the build as unable to start`,
	};
}

/**
 * One advance, as a small state machine over a working copy of the member list.
 *
 * A class rather than a chain of functions because every step reads and writes the
 * same three things — the members as they stand *now*, whether the rollout has
 * halted, and the machines behind them — and threading that triple through six free
 * functions would say less than it costs. The *rules* are the free functions above;
 * what is left here is reading the world, applying them, and writing.
 */
class AdvancePass {
	private readonly members: WorkerUpdateRolloutMember[];
	private status: WorkerUpdateRollout['status'];
	private haltReason: string | null;
	private workers = new Map<string, Worker>();
	private readonly now = new Date();

	constructor(
		private readonly rollout: WorkerUpdateRollout,
		members: WorkerUpdateRolloutMember[],
		private readonly write: RolloutWriter,
	) {
		this.members = members.map((member) => ({ ...member }));
		this.status = rollout.status;
		this.haltReason = rollout.haltReason;
	}

	async run(): Promise<void> {
		this.workers = await resolveWorkers(this.members);
		await this.settleSignalled();
		await this.verifyApplied();
		await this.standDownUncommitted();
		await this.advanceWave();
		await this.completeIfSettled();
	}

	view(): RolloutView {
		return {
			rollout: { ...this.rollout, status: this.status, haltReason: this.haltReason },
			members: this.members.map((member) => withLabel(member, this.workers)),
		};
	}

	/** Step 1 — read each signalled member's answer off its own `workers` row. */
	private async settleSignalled(): Promise<void> {
		for (const member of this.members) {
			if (member.state !== 'signalled') continue;
			const worker = this.workers.get(member.workerId);
			if (!worker) continue;
			const verdict = decideSettlement(member, worker, this.rollout.target, this.now);
			if (verdict) await this.apply(member, verdict);
		}
	}

	/** Step 2 — decide whether each machine that applied has come back on the new build. */
	private async verifyApplied(): Promise<void> {
		for (const member of this.members) {
			if (member.state !== 'verifying') continue;
			const worker = this.workers.get(member.workerId);
			if (!worker) continue;
			const session = await getLiveSessionForWorker(member.workerId);
			const verdict = decideComeBack(member, worker, session, this.rollout.target, this.now);
			if (verdict) await this.apply(member, verdict);
		}
	}

	/**
	 * Step 4 — once halted, settle every machine the rollout has not committed to.
	 *
	 * A `queued` member was never drained, so this only records that it will not be
	 * reached; a `draining` one was taken out of the pool for a wave that will now
	 * never be signalled, so it is put back. Members that *are* committed — signalled
	 * or verifying — are deliberately left alone: they are mid-flight, their answer is
	 * still worth recording, and later advances go on settling them even though the
	 * rollout as a whole has stopped.
	 *
	 * Idempotent, and run on every halted advance rather than only on the one that
	 * halted, so a member drained by a pass that then failed part-way is still stood
	 * down.
	 */
	private async standDownUncommitted(): Promise<void> {
		if (this.status !== 'halted') return;
		for (const member of this.members) {
			if (member.state !== 'queued' && member.state !== 'draining') continue;
			await this.apply(member, {
				patch: {
					state: 'skipped',
					message: 'the rollout halted before this machine was asked to move',
					settledAt: this.now,
				},
				returnToPool: true,
			});
		}
	}

	/** Step 5 — take the next wave if nothing is in flight, then signal whatever has gone idle. */
	private async advanceWave(): Promise<void> {
		if (this.status !== 'in_progress') return;
		const draining = await this.takeNextWave();
		if (draining.length === 0) return;
		const drained = await this.reassertDrain(draining);
		const idle = await this.idleAmong(draining, drained);
		if (idle.length > 0) await this.signal(idle, drained);
	}

	/**
	 * The members this pass will try to signal: whatever is already draining, plus the
	 * next `waveSize` queued machines — but the queued ones **only when nothing at all
	 * is in flight**. That is what bounds how much of the fleet is out of the pool at
	 * any instant, and what makes "verified before the next wave moves" true rather
	 * than hoped for.
	 *
	 * The transition it makes is **written**, not only staged: `drainedByRollout` is
	 * decided here and nowhere else, and the advance that later settles a member is a
	 * different pass reading the row back, so leaving the decision in memory would lose
	 * it — and with it every successfully updated machine's way back into the pool.
	 */
	private async takeNextWave(): Promise<WorkerUpdateRolloutMember[]> {
		// "In flight" is the wave the rollout has actually committed to — a `queued`
		// member is neither settled nor in flight, it is simply not reached yet, so it
		// must not count as a reason to hold the next wave back.
		const inFlight = this.members.filter(
			(member) => !isSettledMemberState(member.state) && member.state !== 'queued',
		);
		const draining = inFlight.filter((member) => member.state === 'draining');
		if (inFlight.length > 0) return draining;
		for (const member of this.members
			.filter((candidate) => candidate.state === 'queued')
			.slice(0, this.rollout.waveSize)) {
			const worker = this.workers.get(member.workerId);
			if (!worker) continue;
			// `drainedByRollout` is decided once, here, from the snapshot taken before this
			// pass drained anything: only a machine the rollout took out of the pool is put
			// back into it afterwards. Once this pass has drained it, the same question can
			// never be asked again — the machine is draining now because *this* rollout
			// drained it — so the answer has to be durable from the instant it is reached.
			await this.apply(member, {
				patch: { state: 'draining', drainedByRollout: worker.drainingSince === null },
			});
			draining.push(member);
		}
		return draining;
	}

	/**
	 * Re-assert the rollout's drain over every member of the wave and return the rows
	 * as they now stand.
	 *
	 * Done on every pass rather than only when a member is first taken, for three
	 * reasons at once: the write is idempotent (`coalesce` keeps the instant the first
	 * drain recorded), it returns the row *after* this pass's own drain — which is what
	 * the fan-out's eligibility check reads, so handing it the pre-drain snapshot would
	 * have it report every machine this rollout just drained as `in-pool` — and it puts
	 * back a machine another session undrained while its wave was in flight.
	 */
	private async reassertDrain(draining: WorkerUpdateRolloutMember[]): Promise<Map<string, Worker>> {
		const drained = new Map<string, Worker>();
		for (const member of draining) {
			const worker = await setWorkerDraining(member.workerId, true);
			if (!worker) {
				// Deregistered between the member read and this write; the row is on its way out
				// through the FK cascade, so there is nothing to move and nothing to halt over.
				await this.apply(member, {
					patch: {
						state: 'skipped',
						message: 'the machine was deregistered while the rollout held it',
						settledAt: this.now,
					},
				});
				continue;
			}
			drained.set(member.workerId, worker);
			this.workers.set(member.workerId, worker);
		}
		return drained;
	}

	/**
	 * The wave's members that have gone idle. Only those are signalled: the daemon
	 * waits for its in-flight phases before it applies anything, so asking one
	 * mid-phase would only leave it waiting with a request outstanding — it stays
	 * `draining` and is asked on a later advance instead, which is how draining never
	 * interrupts a run. The run state is read from the run lifecycle, exactly as
	 * `workers.remove` and `setDraining` read it.
	 */
	private async idleAmong(
		draining: WorkerUpdateRolloutMember[],
		drained: Map<string, Worker>,
	): Promise<WorkerUpdateRolloutMember[]> {
		const idle: WorkerUpdateRolloutMember[] = [];
		for (const member of draining) {
			if (!drained.has(member.workerId)) continue;
			const runState = await deriveWorkerRunState(member.workerId);
			if (!runState.busy) idle.push(member);
		}
		return idle;
	}

	/** Ask the idle members through phase 1's fan-out, and record what it made of each. */
	private async signal(
		idle: WorkerUpdateRolloutMember[],
		drained: Map<string, Worker>,
	): Promise<void> {
		// Read before the fan-out, never after: these are the facts the come-back verdict
		// is reached against, and by the time the machine has been asked they are already
		// the facts of a machine on its way out.
		const atSignal = new Map<string, MemberPatch>();
		for (const member of idle) {
			const session = await getLiveSessionForWorker(member.workerId);
			atSignal.set(member.workerId, {
				fencingTokenAtSignal: session?.fencingToken ?? null,
				buildCommitAtSignal: drained.get(member.workerId)?.build?.commit ?? null,
			});
		}

		const entries = await fanOutWorkerUpdate(
			idle.map((member) => drained.get(member.workerId) as Worker),
			this.rollout.target,
		);
		for (const entry of entries) {
			const member = this.members.find((candidate) => candidate.workerId === entry.workerId);
			if (member) await this.recordSignal(member, entry, atSignal.get(entry.workerId));
		}
	}

	/**
	 * Record what the fan-out made of one machine.
	 *
	 * `requested` and `queued-offline` both recorded a request, and `already-asked`
	 * left one standing for this same build, so all three leave the member waiting on
	 * an answer — the difference between them is only whether a push is on its way,
	 * which the machine's own report settles either way. `answered` is a machine that
	 * had already reported for this exact build before the rollout reached it, so its
	 * outcome is read straight away rather than waited for; it has no signal-time
	 * baseline, so if it applied, its come-back verdict falls back to the lease alone.
	 * `in-pool` is a machine another session returned to the dispatch pool between this
	 * pass's drain and the fan-out's write: nothing was recorded, so the member stays
	 * draining and is asked again on the next advance.
	 */
	private async recordSignal(
		member: WorkerUpdateRolloutMember,
		entry: { disposition: string; update: Worker['update'] },
		atSignal: MemberPatch | undefined,
	): Promise<void> {
		if (entry.disposition === 'in-pool') return;
		const worker = this.workers.get(member.workerId);
		if (entry.disposition === 'answered' && worker) {
			const verdict = decideReportedOutcome(
				worker,
				entry.update?.status ?? null,
				entry.update?.message ?? null,
				this.now,
			);
			await this.apply(member, {
				...verdict,
				patch: { ...verdict.patch, signalledAt: this.now },
			});
			return;
		}
		await this.apply(member, {
			patch: {
				state: 'signalled',
				requestId: entry.update?.requestId ?? null,
				outcome: null,
				message: null,
				signalledAt: this.now,
				fencingTokenAtSignal: atSignal?.fencingTokenAtSignal ?? null,
				buildCommitAtSignal: atSignal?.buildCommitAtSignal ?? null,
			},
		});
	}

	/** Step 6 — a rollout still in progress with nothing left unsettled is finished. */
	private async completeIfSettled(): Promise<void> {
		if (this.status !== 'in_progress') return;
		if (this.members.some((member) => !isSettledMemberState(member.state))) return;
		this.status = 'completed';
		this.haltReason = null;
		await this.write.setStatus('completed');
	}

	/**
	 * Apply one verdict: move the working copy on so later steps in this same pass see
	 * the new state, write the same patch to the row so the *next* pass does too, then
	 * the pool return and the halt it implies.
	 *
	 * Every member transition goes through here — there is no staging-only path — which
	 * is what makes "each step is decided from durable state" true of a member taken
	 * into a wave by one advance and settled by another.
	 */
	private async apply(member: WorkerUpdateRolloutMember, verdict: MemberVerdict): Promise<void> {
		Object.assign(member, verdict.patch);
		await this.write.setMember(member.workerId, verdict.patch);
		if (verdict.returnToPool) await this.returnToPool(member);
		if (verdict.halt) await this.halt(verdict.halt);
	}

	/**
	 * Step 3 — put a machine back in the dispatch pool, but only one this rollout took
	 * out of it. A machine the operator had drained for their own reasons keeps their
	 * drain: the rollout borrowed it, it did not create it.
	 *
	 * Reached for every member that settles **well** — `done` or `skipped` — and
	 * deliberately never for one that settles `failed`: a machine that could not take
	 * the build, or took it and did not come back, is exactly the machine an operator
	 * needs to look at before it is given work again, so it stays out of the pool until
	 * they run `swarm workers undrain` themselves. That is verbatim what issue #933's
	 * single-machine form already leaves them to do.
	 */
	private async returnToPool(member: WorkerUpdateRolloutMember): Promise<void> {
		if (!member.drainedByRollout) return;
		const worker = await setWorkerDraining(member.workerId, false);
		if (worker) this.workers.set(member.workerId, worker);
	}

	/** Stop the rollout, keeping the first reason — the one that actually stopped it. */
	private async halt(reason: string): Promise<void> {
		if (this.status !== 'in_progress') return;
		this.status = 'halted';
		this.haltReason = reason;
		await this.write.setStatus('halted', reason);
	}
}

/** The machines behind a member list, keyed by id; unknown ids are simply absent. */
async function resolveWorkers(members: WorkerUpdateRolloutMember[]): Promise<Map<string, Worker>> {
	const workers = await getWorkers(members.map((member) => member.workerId));
	return new Map(workers.map((worker) => [worker.id, worker]));
}

/**
 * Label a member with its machine's display name. A member whose `workers` row has
 * gone is named by its id rather than by an invented label — the row is on its way
 * out through the FK cascade, and calling it anything else would read as a machine.
 */
function withLabel(
	member: WorkerUpdateRolloutMember,
	workers: Map<string, Worker>,
): RolloutMemberView {
	return { ...member, displayName: workers.get(member.workerId)?.displayName ?? member.workerId };
}

function hasUniqueViolationCode(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { code: unknown }).code === '23505'
	);
}

/**
 * drizzle-orm wraps every node-postgres query error in a `DrizzleQueryError`, which
 * has no top-level `code` — the original pg error is on `.cause`. Check both,
 * exactly like `routers/workers.ts` and `routers/projects.ts`.
 */
function isUniqueViolation(error: unknown): boolean {
	return (
		hasUniqueViolationCode(error) || (error instanceof Error && hasUniqueViolationCode(error.cause))
	);
}
