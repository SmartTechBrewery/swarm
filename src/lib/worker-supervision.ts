/**
 * **How the daemon running this process is supervised** — whether a process
 * supervisor will start it again after it exits (issue #997).
 *
 * It exists because a machine that takes itself down has no way of saying so. A
 * daemon started by launchd or systemd exits and comes straight back on the new
 * build; one started by hand in a terminal (`npm run dev:worker`, `swarm
 * run:worker`) exits and is simply gone, and the control plane cannot tell those
 * two machines apart — the handshake's four self-declared facts (`capabilities`,
 * `supportedPhases`, `repository`, `build`) are identical on both. So this is the
 * fifth self-declared fact, resolved once at startup and carried to the operator
 * surfaces.
 *
 * Lives in `src/lib/` for the same reason `./build-identity.ts` does: its schema is
 * imported by the wire protocol (`../transport/protocol.ts`), by the DB layer
 * (`../db/schema/workers.ts`), and by the identity read model
 * (`../identity/worker.ts`), so it can belong to none of them. Unlike
 * `build-identity.ts` it binds no `node:child_process` and no `node:fs` — the whole
 * fact is `process.env` plus `process.ppid` — so there is no lazy-import dance to
 * repeat here.
 *
 * **Two things the reads cannot prove, both accepted deliberately.** First,
 * `INVOCATION_ID` is *inherited*: a shell started from inside a systemd service
 * reads as supervised, and so does anything launched from that shell. Second,
 * neither marker says the supervisor is configured to *restart* the job —
 * launchd's `KeepAlive` and systemd's `Restart=always` are not readable from
 * inside the process, so what this declares is "I am under launchd/systemd", not
 * "I will come back". Both residual errors leave the machine exactly where it is
 * today, which is what makes them acceptable: the failure this closes is the
 * *silent* one, a machine claiming nothing while exiting for nobody.
 *
 * **The launchd arm reads `supervised` only for launchd's *direct* child, and that
 * is narrower than "started by a LaunchAgent".** Verified live on this
 * installation: the worker plists run `swarm run:worker`, which spawns `npm run
 * dev:worker`, which spawns the daemon — so the daemon's parent is `npm` and only
 * the launcher three levels up has ppid 1. Such a machine declares `unsupervised`
 * although launchd will in fact restart it.
 *
 * That conjunct is kept anyway, because dropping it is worse and nothing cheaper
 * replaces it: `XPC_SERVICE_NAME` is inherited by *every* descendant of *any*
 * launchd job — a Terminal window, an ssh session — so the variable alone would
 * read a hand-run daemon as supervised, and no in-process read distinguishes "my
 * own LaunchAgent started me" from "I descend from somebody else's job" without
 * either carrying the supervisor's job label or planting a SWARM-owned marker in
 * the plist, both of which issue #997 puts out of scope. So the error is left
 * pointing the **safe** way: this never claims `supervised` for a machine that
 * would not come back, only `unsupervised` for one that would. A consumer that
 * refuses on `unsupervised` (phase 2/2) must reckon with that before it ships —
 * on an installation shaped like this one it refuses everything.
 */

import { z } from 'zod';

/**
 * How a daemon is supervised, in the one vocabulary the handshake declares in, the
 * `workers` row records, and the operator surfaces read.
 *
 * `unknown` is a **real answer**, not a null in disguise, and is why this enum has
 * three members rather than being a boolean: a platform whose supervisors these
 * reads do not cover cannot be said to have none, so it says so rather than
 * claiming either answer. It is also what a daemon on a build predating the field
 * lands on, and what a worker that has never connected says.
 */
export const WORKER_SUPERVISION_STATES = ['supervised', 'unsupervised', 'unknown'] as const;
export const WorkerSupervisionSchema = z.enum(WORKER_SUPERVISION_STATES);
export type WorkerSupervision = z.infer<typeof WorkerSupervisionSchema>;

/**
 * An environment variable that is set to something meaningful — an absent,
 * empty-string, or whitespace-only value is treated as absent, since a supervisor
 * that exports a variable it left blank has told us nothing.
 */
function declared(value: string | undefined): boolean {
	return typeof value === 'string' && value.trim() !== '';
}

/**
 * Resolve how a daemon with this environment is supervised — the testable form of
 * {@link resolveOwnSupervision}, taking its whole world as arguments so every
 * branch is reachable without touching `process`.
 *
 * The order matters and each step is a different claim:
 *
 * 1. **systemd** sets `INVOCATION_ID` for every unit it starts. The parent is
 *    deliberately *not* checked beside it: a *user* unit's parent is the per-user
 *    manager, not pid 1, so requiring `ppid === 1` would read every user service as
 *    unsupervised.
 * 2. **launchd** sets `XPC_SERVICE_NAME` — but to the literal `0` for a process
 *    that is not an XPC service, which is not a label — and reparents its jobs to
 *    pid 1. Both halves are required: `ppid === 1` alone is also what an *orphaned*
 *    hand-run daemon reports, and the variable alone is inherited by children.
 * 3. **A platform these reads answer for** (`darwin`, `linux`) with neither marker
 *    is `unsupervised`. That is the machine this whole declaration exists for.
 * 4. **Anything else** is `unknown` — never `supervised`, and never `unsupervised`
 *    either.
 */
export function detectWorkerSupervision(
	env: NodeJS.ProcessEnv,
	ppid: number,
	platform: NodeJS.Platform,
): WorkerSupervision {
	if (declared(env.INVOCATION_ID)) return 'supervised';
	const xpcServiceName = env.XPC_SERVICE_NAME?.trim();
	if (declared(xpcServiceName) && xpcServiceName !== '0' && ppid === 1) return 'supervised';
	if (platform === 'darwin' || platform === 'linux') return 'unsupervised';
	return 'unknown';
}

/**
 * This process's own answer. Not memoized: the supervision of a running process is
 * fixed for its life and the read is three property accesses, so there is nothing
 * to cache and no second answer to invite.
 */
export function resolveOwnSupervision(): WorkerSupervision {
	return detectWorkerSupervision(process.env, process.ppid, process.platform);
}
