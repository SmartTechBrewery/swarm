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
 * **The launchd arm accepts two shapes, and refuses everything else.** The first is
 * launchd's *direct* child: `XPC_SERVICE_NAME` set to a real label **and**
 * `ppid === 1`. That used to be the only one, and it was narrower than SWARM's own
 * installer: the worker plists ran `swarm run:worker`, which spawned `npm run
 * dev:worker`, which spawned the daemon — so every machine `bin/swarm-worker-agent`
 * installed declared `unsupervised` although launchd would in fact restart it, and
 * on 2026-09-18 issue #1024's fleet update refused all twelve machines on this
 * installation. `swarm run:worker` and the launcher now replace their own process
 * with the daemon (`process.execve`, `../cli/commands/run-worker.ts`), so the job
 * launchd started *is* the daemon and `ppid === 1` holds.
 *
 * The second is **a job carrying a SWARM worker LaunchAgent label**
 * ({@link WORKER_LAUNCH_AGENT_LABEL_PREFIX}), whatever the parent (issue #1376). A
 * host may run its worker agent under an operator-supplied wrapper program
 * (`~/.swarm/launchd-wrapper`, written into the plist by `bin/swarm-worker-agent`)
 * which starts the usual command as its *child* — so the daemon's parent is the
 * wrapper, never pid 1, and the first shape alone would read every such machine
 * `unsupervised` and have fleet updates refuse it all over again. The same holds
 * for a launcher that had to fall back to spawning the daemon. The label is what
 * tells these apart from a hand-run daemon: `XPC_SERVICE_NAME` is inherited by every
 * descendant of any launchd job, but a Terminal window or an ssh session inherits
 * *its own* job's label, not one SWARM's installer wrote.
 *
 * **What that second shape cannot prove, accepted deliberately.** A process started
 * from *inside* a SWARM worker agent's tree — an agent CLI's shell, say — inherits
 * that agent's label, so a daemon started by hand from there would read
 * `supervised`. Nothing SWARM runs does that, and an operator who does it has gone
 * out of their way to; whereas refusing the label would refuse every wrapped
 * machine, which is the failure that took the fleet out once already. Any other
 * label — and launchd's `0` sentinel, and no variable at all — still needs
 * `ppid === 1`, so a daemon run by hand from a terminal still reads `unsupervised`.
 */

import { z } from 'zod';

/**
 * The label prefix of every SWARM worker LaunchAgent — clone and profile agents alike
 * (`bin/swarm-worker-agent`'s `resolve`/`resolve_profile`, and
 * `../launcher/clone-agent.ts`, which reads them back).
 */
export const WORKER_LAUNCH_AGENT_LABEL_PREFIX = 'pl.smarttechbrewery.swarm.worker.';

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
 *    pid 1. Both halves are required for an arbitrary label: `ppid === 1` alone is
 *    also what an *orphaned* hand-run daemon reports, and the variable alone is
 *    inherited by children. A SWARM worker LaunchAgent label is enough on its own,
 *    so a daemon under an operator's wrapper program still reads `supervised` (see
 *    the module comment for the trade-off).
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
	if (declared(xpcServiceName) && xpcServiceName !== '0') {
		if (ppid === 1) return 'supervised';
		if (isWorkerLaunchAgentLabel(xpcServiceName)) return 'supervised';
	}
	if (platform === 'darwin' || platform === 'linux') return 'unsupervised';
	return 'unknown';
}

/** Whether a launchd job label is one `bin/swarm-worker-agent` writes. */
function isWorkerLaunchAgentLabel(label: string | undefined): boolean {
	return (
		typeof label === 'string' &&
		label.startsWith(WORKER_LAUNCH_AGENT_LABEL_PREFIX) &&
		label.length > WORKER_LAUNCH_AGENT_LABEL_PREFIX.length
	);
}

/**
 * This process's own answer. Not memoized: the supervision of a running process is
 * fixed for its life and the read is three property accesses, so there is nothing
 * to cache and no second answer to invite.
 */
export function resolveOwnSupervision(): WorkerSupervision {
	return detectWorkerSupervision(process.env, process.ppid, process.platform);
}
