/**
 * `swarm workers` — the operator front-door onto the registered-worker identity
 * model (#132 Phase 1) and its project enrollment (#337 Phase 3). It lets an
 * owner register the local machines they run agent CLIs on and declare which
 * CLIs each supports, then enroll a worker into a project and control its
 * sharing consent. The worker-side companion to `swarm users`
 * (`commands/users.ts`) and `swarm members` (`commands/members.ts`).
 *
 * **It holds no `DATABASE_URL`** (issue #800). Every subcommand reaches the
 * control plane's operator API over `SWARM_CONTROL_PLANE_URL`
 * (`../_shared/operator-client.ts` → the router's `/operator/trpc/*` mount),
 * authenticated by the session `swarm login` caches — so the whole command group
 * runs from a machine that has never had Postgres credentials, which is precisely
 * the machine being onboarded. It imports nothing from `../../db/*` and nothing
 * from `../../identity/*-service.js`; a thin file/CLI shell over the same
 * procedures the dashboard calls, using `node:util` `parseArgs` +
 * `_shared/output.ts` like `commands/members.ts`.
 *
 * That re-pointing **narrows four things deliberately**, because the tRPC layer
 * enforces ownership the direct-DB CLI never did (see `docs/cli.md`):
 * `set-scm-credential` and `remove` are strictly owner-only — so sign in as the
 * worker's owner — `remove` refuses a machine that is running a job, `list`
 * is an installation-wide read unless it names the signed-in operator's own
 * handle, which is served by `workers.listMine` instead, and `consent` and
 * `update-enrollment` are strictly the machine owner's too (sharing consent and
 * execution constraints are the owner's call, not an administrative one), so an
 * installation admin acting on somebody else's machine gets the same
 * `Enrollment … not found` a stranger does.
 *
 * Exactly one subcommand goes the other way (issue #922): `request-update` is an
 * **installation administrator's**, and asks every machine on the installation —
 * other owners' included — to move to a build. It is not an exception to the rule
 * above but the other side of it, and the reason is that it only ever *asks*: a
 * machine acts solely if its own host set `SWARM_WORKER_SELF_UPDATE=true`, and one
 * its owner has not drained is reported and left alone, so both of the switches that
 * decide whether anything happens stay the owner's. `docs/onboarding-worker.md`
 * states the rule beside #800's; a non-administrator running it is refused outright
 * rather than quietly shown their own machines.
 *
 * One thing also stopped being atomic: `--active` on `enroll` is a `projectAdmin`
 * call made *after* the create, so an owner who does not administer the project
 * gets a real, pending enrollment plus a refusal. Both paths report the created
 * row and name the approvals still outstanding rather than telling anyone to
 * enroll again (`performEnroll` / `remainingEnrollmentSteps` below). Since issue
 * #901 the two flags are applied independently of each other, so that refusal no
 * longer costs the caller the `--consent` they were entitled to grant: what is
 * left outstanding is the administrator's approval alone.
 *
 * A refusal is reported in the **control plane's own words**: the procedures
 * already name what disagrees (the capability set, the two repositories, the
 * busy machine), so re-wording them here would only let the two drift. What this
 * command still says for itself is everything it validates before calling:
 * arguments, the CLI list, the SCM provider id, an empty secret, and which
 * enrollment a `(worker, project)` pair names.
 *
 * The secrets it handles are both write-only. `register` prints the **worker
 * credential** exactly once with a "store it now" note (analogous to `swarm users
 * set-password` never echoing a stored secret), and it is never printed again;
 * `set-scm-credential` stores the **operator's own SCM credential** for this
 * machine (issue #765) read without echo, and prints no preview of it. No
 * subcommand prints a credential or its hash.
 *
 * Both registration paths *also* write the worker credential to this machine's
 * per-checkout cache (`_shared/worker-credential-cache.ts`, issue #788), so
 * `swarm run:worker` can start the daemon from that checkout with nothing to
 * paste. Printing stays: a remote machine, or a process supervisor, still needs
 * the value, and this cache only ever answers for the checkout it was written in.
 *
 * `register` *points at* that second secret's write surfaces rather than taking
 * it (issue #767): a worker's SCM provider is a property of its enrollments and
 * is not known at registration time, so prompting here would have to guess one
 * provider — exactly the GitHub assumption `ai/RULES.md` §2 keeps out of the SCM
 * layer. It therefore gains no token flag and no prompt of any kind.
 *
 * `register-and-enroll` (issue #786) is the recommended path for a *new* machine
 * and the third write surface onto that per-`(worker, provider)` store: it
 * composes `register` + `set-scm-credential` + `enroll` and ends with the exact
 * command that starts the daemon. It also bootstraps the checkout it runs in,
 * leaving `.env` pointed at the control plane (`_shared/control-plane-env.ts`)
 * before it needs the URL itself — the last onboarding step that was still prose
 * rather than a command, and one `swarm init` must not serve, since that scaffolds
 * a stack `.env` with a `DATABASE_URL` no worker may hold. It may prompt where
 * `register` may not,
 * precisely because it is handed the target project and therefore *resolves* the
 * provider (`workers.projectScmProvider`) instead of guessing one — the condition
 * #767 recorded as missing at registration time.
 *
 * Subcommands:
 *   swarm workers register <owner-identifier> --name <displayName> --cli <c1,c2,...>
 *   swarm workers register-and-enroll <owner-identifier> <project-id> --name <displayName> --cli <c1,c2,...> [--control-plane-url <url>] [--repo-root <path>]
 *   swarm workers list [<owner-identifier>]
 *   swarm workers set-cli <worker-id> (--cli <c1,c2,...> | --auto)
 *   swarm workers set-scm-credential <worker-id> <scm-provider-id>
 *   swarm workers remove <worker-id>
 *   swarm workers drain <worker-id>
 *   swarm workers undrain <worker-id>
 *   swarm workers update <worker-id> <ref>
 *   swarm workers update --all <ref> [--wave <n>]
 *   swarm workers update --status
 *   swarm workers request-update <ref>
 *   swarm workers sweep-worktrees <worker-id>
 *   swarm workers sweeps
 *   swarm workers enroll <worker-id> <project-id> --cli <c1,c2,...> [--concurrency <n>] [--active] [--consent]
 *   swarm workers update-enrollment <worker-id> <project-id> [--cli <c1,c2,...>] [--concurrency <n>]
 *   swarm workers approve <worker-id> <project-id>
 *   swarm workers consent <worker-id> <project-id> <on|off>
 */

import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { type AgentCli, AgentCliSchema } from '../../harness/agent-cli.js';
import { describeError } from '../../lib/errors.js';
import { operatorCredentialCopyFor } from '../../scm/operator-credential-copy.js';
import { SCM_TYPES } from '../../scm/types.js';
import { ensureControlPlaneUrl } from '../_shared/control-plane-env.js';
import {
	createOperatorClient,
	OperatorApiError,
	type OperatorClient,
	type OperatorSession,
	requireOperatorSession,
} from '../_shared/operator-client.js';
import * as out from '../_shared/output.js';
import { promptHidden, readStdin } from '../_shared/secret-input.js';
import { writeWorkerCredentialCache } from '../_shared/worker-credential-cache.js';

const AGENT_CLIS = AgentCliSchema.options;
/**
 * The provider ids `set-scm-credential` accepts. Taken from the closed value list
 * rather than the SCM registry so validity does not depend on which provider
 * modules this CLI process happened to import — the same reasoning
 * `ProjectConfigSchema` applies to `scm`. The control plane re-checks it against
 * its *own* registry, which is the check that decides whether a credential can be
 * stored; this one only spares an operator a round trip for a typo.
 */
const SCM_PROVIDER_IDS = SCM_TYPES;

const USAGE = `swarm workers — register and manage local workers (identity + declared CLIs)

Usage:
  swarm workers register <owner-identifier> --name <displayName> --cli <c1,c2,...>
  swarm workers register-and-enroll <owner-identifier> <project-id> --name <displayName> --cli <c1,c2,...> [--control-plane-url <url>] [--repo-root <path>]
  swarm workers list [<owner-identifier>]
  swarm workers set-cli <worker-id> (--cli <c1,c2,...> | --auto)
  swarm workers set-scm-credential <worker-id> <scm-provider-id>
  swarm workers remove <worker-id>
  swarm workers drain <worker-id>
  swarm workers undrain <worker-id>
  swarm workers update <worker-id> <ref>
  swarm workers update --all <ref> [--wave <n>]
  swarm workers update --status
  swarm workers request-update <ref>
  swarm workers sweep-worktrees <worker-id>
  swarm workers sweeps
  swarm workers enroll <worker-id> <project-id> --cli <c1,c2,...> [--concurrency <n>] [--active] [--consent]
  swarm workers update-enrollment <worker-id> <project-id> [--cli <c1,c2,...>] [--concurrency <n>]
  swarm workers approve <worker-id> <project-id>
  swarm workers consent <worker-id> <project-id> <on|off>

  register   Register a worker for an owner (by login handle) with a display
             name and declared CLIs (--cli, comma-separated, one or more of
             ${AGENT_CLIS.join(' | ')}). Prints a worker credential ONCE — store
             it then, it is never shown again. Registration gives the machine no
             SCM identity: it cannot run a phase until its operator
             source-control credential is set for the provider its projects use.
             Its owner does that in the dashboard at /workers/<worker-id> →
             "Operator source-control credential"; for their own machine, run
             set-scm-credential below. This command asks for no token of any
             kind — the provider is not known at registration time. The
             credential is also cached for the checkout this runs in
             (~/.swarm/worker-credentials/), so \`swarm run:worker\` can start
             this worker from here with nothing to paste. Registering for
             somebody else is an installation-admin act.
  register-and-enroll
             The one-command path for a NEW machine: points this checkout's .env
             at the control plane, registers the worker, stores its operator
             source-control credential, and enrolls it in <project-id> — then
             prints the exact command that starts it. SWARM_CONTROL_PLANE_URL is
             taken from .env when it is already there (left untouched, so a
             second worker on this machine changes nothing), otherwise from
             --control-plane-url, the environment, or a prompt on a TTY, and
             written to .env for the daemon to read. Nothing else is scaffolded:
             a worker holds no DATABASE_URL, which is why \`swarm init\` is the
             wrong command for this machine. The
             provider is resolved from the target project, so the credential
             prompt names the provider that project actually runs on
             (${SCM_PROVIDER_IDS.join(' | ')}); prompts without echo on a TTY and
             otherwise reads the secret from stdin, and never prints it back. The
             secret is verified against the provider before it is stored. Sharing
             consent is always recorded; on a project you administer the
             enrollment also ends up active, so the machine is routable as soon as
             it connects, and on one you do not it stays pending until an
             administrator approves it — routable from that moment, with nothing
             further from you. It does NOT start the worker: the
             daemon is a foreground, operator-owned process, so the final line is
             a command to run on that machine yourself. The printed
             SWARM_WORKER_REPO_ROOT (and the checkout the credential is cached
             for) is the directory you run this in, exactly like register; pass
             --repo-root when you are onboarding a machine from somewhere else.
             The worker credential is shown ONCE, in that final line — and cached
             for that same checkout, exactly as register does.
  list       List workers ('<id>\\t<displayName>\\t<clis>' per line). With your
             own login handle, your machines; with somebody else's, or with none
             at all (prefixed with the owner identifier), the installation-wide
             roster — which is an installation-admin read. Never prints a
             credential or its hash.
  set-cli    Declare which CLIs a worker should run (--cli), or hand it back to
             auto-discovery (--auto); exactly one of the two. The declaration is
             durable: unlike the CLIs a daemon probes on its own PATH, it survives
             the machine's next reconnect. It may only narrow what that machine's
             daemon last reported — naming a CLI it never reported is refused, and
             installing one is the machine's own business (or declare it there with
             SWARM_WORKER_TRANSPORT_CLIS). Dropping a CLI an active enrollment
             requires is refused too. Takes effect on the next dispatch. The
             machine's owner alone may do it.
  set-scm-credential
             Store (or rotate) this worker's OPERATOR credential for one SCM
             provider (${SCM_PROVIDER_IDS.join(' | ')}) — the account every phase
             it runs against a project on that provider commits, pushes and
             comments as. Prompts (no echo) on a TTY, naming the kind of secret
             that provider expects, otherwise reads the secret from stdin; never
             takes it as an argument and never prints it back.
             The value is verified against the provider before it is stored, and
             the account it resolved to is named back. Takes effect on the next
             dispatch — no worker restart. The machine's owner alone may do it,
             so sign in as them.
  remove     Deregister a worker by worker id. The machine's owner alone may do
             it, and it is refused while that machine is running a job.
  drain      Take a machine OUT of the dispatch pool so it can be restarted: it
             is given no new work from the next dispatch on, while whatever it is
             already running is left alone. Work that would have gone there is
             deferred, never failed, and runs on another eligible machine on the
             next re-check. Prints whether the machine has gone idle yet, so
             re-running this is how you check when it is safe to restart —
             re-draining keeps the original 'draining since' instant. The drain
             survives the restart: a reconnecting machine does NOT rejoin the
             pool, only undrain puts it back. The machine's owner alone may do
             it, so sign in as them.
  undrain    Put a drained machine back in the pool — it may be given work again
             from the next re-check. The machine's owner alone may do it.
  update     Ask a machine to move its SWARM install root to <ref> — a branch,
             tag, or commit id, never a command, a path, or a URL — and restart
             into it. Refused unless the machine is already draining, so drain
             it first: the daemon waits for the phases it is already running to
             finish before it applies anything, and only draining stops new work
             arriving into that wait. The machine acts only if its host opted in
             with SWARM_WORKER_SELF_UPDATE=true. On a host where several daemons
             share one SWARM install root, the first to act does the fetch and
             build and the rest report already-current; an update is refused
             outright while a peer daemon there is mid-phase, naming the worker
             to drain. Every
             outcome — applied, already-current, declined, refused, failed — is
             reported back and shown by 'list'; anything but 'applied' leaves the
             machine working on the build it has. Requesting again replaces a
             request that has not been answered yet. The machine's owner alone may
             do it, so sign in as them. Remember to undrain it afterwards.
             With --all and no worker id, every machine you own is moved to <ref>
             as a STAGED ROLLOUT instead: SWARM drains at most --wave machines (one
             by default), waits for each to go idle, asks it, waits for it to come
             back on the new build, puts it back in the pool, and only then starts
             the next wave — so a fleet update never takes the whole fleet's
             capacity down at once. It advances itself from there — off each
             machine's report, its reconnect, and a periodic check — so one run of
             this command moves the whole fleet. Re-running it is how you read the
             rollout, and nudges it along too; each run prints where every machine
             stands (queued, draining, signalled, verifying, done, skipped,
             failed). A machine that reports failed, refused or declined, or that
             applies and never comes back, HALTS the rollout: nothing further is
             drained or signalled, the reason is recorded, and the untouched
             machines stay in the pool. A halted rollout is final — fix the build
             and start a new one; there is no resume and no cancel. --status prints
             the same table without advancing anything. One rollout at a time per
             operator: asking for a different ref while one is under way is refused
             rather than re-targeting a fleet mid-move.
  request-update
             Ask EVERY machine on the installation — other people's included — to
             move to <ref>, and print what became of each. An INSTALLATION
             ADMINISTRATOR's command; anybody else is refused outright rather than
             shown their own machines. It only ever ASKS: a machine acts solely if
             its own host sets SWARM_WORKER_SELF_UPDATE=true, and a machine whose
             owner has not drained it is reported 'in-pool' and left alone, because
             draining stays the owner's own call. So its owner can refuse it, or
             stop it later, without asking you. Each line carries the machine, its
             owner, the disposition (requested | queued-offline | in-pool |
             already-asked | answered) and 'owner opted out' for a machine that
             last reported 'declined'. Every request records who made it, so
             'swarm workers update <worker-id> <ref>' is what an owner runs for
             their own machine and this is what an administrator runs for the fleet.
  sweep-worktrees
             Ask a machine to remove its own task-<id> checkouts that nothing has
             touched for the project's abandonedAfterDays (10 by default), across
             every project it is enrolled in — INCLUDING ones holding uncommitted
             or unpushed work, which the ordinary retention sweep keeps forever. A
             checkout something is still using is never removed at any age, so the
             machine needs no draining and no run is disturbed. It prints what that
             machine's LAST sweep removed — each path with its age and whether it
             held uncommitted or unpushed work — and then asks for a new one, which
             is also the moment that previous record is replaced: a machine keeps
             only its most recent sweep. The new answer lands later and is printed
             by the next run of this command. The machine's owner alone may do it.
  sweeps     What the FLEET last deleted: one block per machine on the
             installation with its last recorded sweep and every path that sweep
             removed, each with its age and whether it held uncommitted or
             unpushed work; a machine that has never reported prints "never
             swept". It asks for nothing and replaces nothing, which is what
             sweep-worktrees cannot do — that one prints the record and destroys
             it in the same breath. Sweeps are requested across the whole
             installation once a week by the API server itself
             (SWARM_WORKTREE_ABANDONED_SWEEP_INTERVAL_MS), so this is the ordinary
             way to read what came back. A machine asked but not yet heard from —
             typically one offline since the signal went out — says so; it is
             handed the request on its next connection. An INSTALLATION
             ADMINISTRATOR's read, like the unfiltered list.
  enroll     Enroll a worker into a project with allowed CLIs (--cli, a subset of
             the worker's capabilities) and --concurrency, this worker's share of
             the project. Omit --concurrency for 1 (the default): one of the
             project's jobs at a time on this machine. A larger value lets the
             project run several jobs here at once, still bounded by the
             project's Maximum Concurrent Jobs. Enrolling your own machine in a
             project you administer creates it active and consenting; otherwise it
             starts pending with sharing consent off, and --active/--consent then
             approve it and grant consent (operator seeding). --active is a
             project administrator's call, so it can be refused on a project you
             do not administer — the enrollment is still created, and the refusal
             names what is left to run rather than asking you to enroll again. The
             two flags are applied independently, so a --consent you are entitled
             to grant is still recorded when --active is refused.
  update-enrollment
             Change an existing enrollment's execution constraints: --cli (a
             subset of the worker's capabilities) replaces the allowed CLIs and
             --concurrency replaces this worker's share of the project. At least
             one is required; an omitted flag leaves the stored value alone.
             Approval status and sharing consent are untouched (see approve /
             consent). Takes effect on the next dispatch — a running agent is
             never interrupted. The machine's owner alone may do it.
  approve    Approve a pending enrollment (worker + project) → active. A project
             administrator's call.
  consent    Turn an enrollment's owner-controlled sharing consent on or off.
             Revoking it blocks future dispatch without stopping a running agent.
             The machine's owner alone may do it, so sign in as them.

Requires SWARM_CONTROL_PLANE_URL and a \`swarm login\` session — and no
DATABASE_URL: every subcommand calls the control plane's operator API, so this
runs from the machine being onboarded. A worker is a local execution environment
owned by a SWARM user; an enrollment offers it to a project, and it is routable
only while active AND sharing consent is on.`;

const SUBCOMMANDS = [
	'register',
	'register-and-enroll',
	'list',
	'set-cli',
	'set-scm-credential',
	'remove',
	'drain',
	'undrain',
	'update',
	'request-update',
	'sweep-worktrees',
	'sweeps',
	'enroll',
	'update-enrollment',
	'approve',
	'consent',
];

/**
 * What each procedure's answer is read for, declared rather than duck-typed
 * (ai/CODING_STANDARDS.md), and deliberately **not** imported from the routers:
 * pulling `../../api/routers/workers.ts` in would drag `../../db/*` into a CLI
 * whose whole point is holding none. None is `.strict()` — a control plane
 * answering with more fields than these, newer or older, is not a failure — and a
 * capability list is read as plain strings because every one of them is printed
 * rather than acted on, so a machine declaring a CLI this build has never heard of
 * must not make `list` fail.
 */
const CapabilityListSchema = z.array(z.string());

const RegisteredWorkerSchema = z.object({
	worker: z.object({
		id: z.string().min(1),
		displayName: z.string().min(1),
		capabilities: CapabilityListSchema,
	}),
	credential: z.string().min(1),
});

const WorkerSchema = z.object({
	id: z.string().min(1),
	displayName: z.string().min(1),
	capabilities: CapabilityListSchema,
});

/**
 * The self-update state a row may carry (issue #933), read for the marker `list`
 * prints. Optional and loosely typed on the same rule as everything else here: an
 * older control plane simply answers without it, and `status` is read as a plain
 * string because it is printed rather than acted on — a vocabulary this build has
 * never heard of must not make `list` fail.
 */
const WorkerUpdateStateSchema = z.object({
	requestId: z.string().nullable(),
	target: z.string().min(1),
	status: z.string().nullable(),
	// The machine's own prose beside the outcome, read only by the fleet report's
	// detail column (issue #921) — optional on the same rule as everything else here.
	message: z.string().nullable().optional(),
});
type WorkerUpdateState = z.infer<typeof WorkerUpdateStateSchema>;

const RosterSchema = z.array(
	z.object({
		workerId: z.string().min(1),
		displayName: z.string().min(1),
		capabilities: CapabilityListSchema,
		// Optional per this file's own rule: a control plane answering with fewer
		// fields than these is not a failure, so an older one simply marks nothing.
		drainingSince: z.string().nullable().optional(),
		update: WorkerUpdateStateSchema.nullable().optional(),
		owner: z.object({ identifier: z.string().min(1) }).nullable(),
	}),
);

const OwnWorkersSchema = z.array(
	z.object({
		workerId: z.string().min(1),
		displayName: z.string().min(1),
		capabilities: CapabilityListSchema,
		drainingSince: z.string().nullable().optional(),
		update: WorkerUpdateStateSchema.nullable().optional(),
	}),
);

/** `workers.getById`, read for the display name and for the enrollment id a `(worker, project)` pair names. */
const WorkerDetailSchema = z.object({
	workerId: z.string().min(1),
	displayName: z.string().min(1),
	enrollments: z.array(z.object({ enrollmentId: z.string().min(1), projectId: z.string().min(1) })),
});

const EnrollmentSchema = z.object({
	id: z.string().min(1),
	status: z.string().min(1),
	allowedClis: CapabilityListSchema,
	concurrencyAllocation: z.number(),
	sharingConsent: z.boolean(),
});

const RemovedWorkerSchema = z.object({ workerId: z.string().min(1) });

/**
 * `workers.setDraining` (issue #919), which answers with the flag *and* the
 * server-derived run state — so this one call is also the "has it gone idle, is it
 * safe to restart yet?" check, with no second read.
 */
const DrainStateSchema = z.object({
	workerId: z.string().min(1),
	displayName: z.string().min(1),
	drainingSince: z.string().nullable(),
	busy: z.boolean(),
	currentRunId: z.string().nullable(),
});

/**
 * `workers.requestUpdate` (issue #933) — the acknowledgement, not an outcome: the
 * machine has been *asked*, and what it answers arrives later on its own route and
 * is read back through `list`.
 */
const RequestedUpdateSchema = z.object({
	workerId: z.string().min(1),
	displayName: z.string().min(1),
	target: z.string().min(1),
});

/**
 * One machine's recorded sweep — what it removed, kept and failed on. Shared by
 * `sweep-worktrees`, which reads the one sweep it is about to replace, and `sweeps`
 * (issue #956), which reads every machine's without replacing anything.
 *
 * `status` is read as a plain string on this file's own rule: it is printed rather
 * than acted on, so a control plane that grows a third value must not make the
 * command fail.
 */
const WorktreeSweepReportSchema = z.object({
	reportedAt: z.string().min(1),
	status: z.string().min(1),
	result: z.object({
		removed: z.array(
			z.object({
				projectId: z.string().min(1),
				taskId: z.string().min(1),
				path: z.string().min(1),
				ageDays: z.number(),
				hadUncommittedChanges: z.boolean(),
				hadUnpushedCommits: z.boolean(),
			}),
		),
		removedCount: z.number(),
		keptLiveCount: z.number(),
		failedCount: z.number(),
		message: z.string().min(1),
	}),
});
type WorktreeSweepReport = z.infer<typeof WorktreeSweepReportSchema>;

/**
 * `workers.requestWorktreeSweep` (issue #955) — the acknowledgement plus the sweep
 * this request replaced, which is the only moment that previous record is still
 * readable (a machine keeps one sweep).
 *
 * Optional on this file's own rule: an older control plane simply answers without
 * `previousSweep`.
 */
const RequestedWorktreeSweepSchema = z.object({
	workerId: z.string().min(1),
	displayName: z.string().min(1),
	previousSweep: WorktreeSweepReportSchema.nullable().optional(),
});
type RequestedWorktreeSweep = z.infer<typeof RequestedWorktreeSweepSchema>;

/**
 * `workers.listSweeps` (issue #956) — every machine on the installation with its
 * last recorded sweep, the fleet-wide readout `sweeps` prints. `pendingRequestedAt`
 * is a request nobody has answered yet, which on an unattended weekly schedule is
 * the ordinary state of a machine that has been offline since the signal went out.
 */
const FleetWorktreeSweepsSchema = z.object({
	workers: z.array(
		z.object({
			workerId: z.string().min(1),
			displayName: z.string().min(1),
			pendingRequestedAt: z.string().nullable().optional(),
			lastSweep: WorktreeSweepReportSchema.nullable().optional(),
		}),
	),
});

/**
 * `workers.requestUpdateForInstallation` (issue #922) — the installation-wide
 * request, one entry per machine on the installation.
 *
 * `disposition` is read as a plain string on this file's own rule: it is printed
 * rather than acted on, so a word a newer control plane reports and this build has
 * never heard of must not make the command fail. `owner` is nullable for the same
 * tolerance the roster reads it with, and `optedOut` is the server's own derivation
 * from the machine's last report — not re-derived here, so the two cannot drift.
 */
const InstallationUpdateRequestSchema = z.object({
	target: z.string().min(1),
	requestedBy: z.string().min(1),
	workers: z.array(
		z.object({
			workerId: z.string().min(1),
			displayName: z.string().min(1),
			disposition: z.string().min(1),
			optedOut: z.boolean(),
			owner: z.object({ identifier: z.string().min(1) }).nullable(),
		}),
	),
});
type InstallationUpdateRequest = z.infer<typeof InstallationUpdateRequestSchema>;

/**
 * `workers.startFleetUpdate` / `workers.fleetUpdateStatus` (issue #940) — the whole
 * staged rollout, one entry per machine.
 *
 * `status`, `state` and `outcome` are read as plain strings for the reason every
 * other vocabulary in this file is: they are printed rather than acted on, so a word
 * a newer control plane reports and this build has never heard of must not make the
 * command fail.
 */
const RolloutMemberSchema = z.object({
	workerId: z.string().min(1),
	displayName: z.string().min(1),
	state: z.string().min(1),
	outcome: z.string().nullable().optional(),
	message: z.string().nullable().optional(),
});
type RolloutMember = z.infer<typeof RolloutMemberSchema>;

const RolloutSchema = z.object({
	id: z.string().min(1),
	target: z.string().min(1),
	waveSize: z.number(),
	status: z.string().min(1),
	haltReason: z.string().nullable().optional(),
	members: z.array(RolloutMemberSchema),
});
type Rollout = z.infer<typeof RolloutSchema>;

/** `workers.startFleetUpdate` — the rollout it started or advanced, and which of the two it did. */
const StartFleetUpdateSchema = z.object({
	action: z.string().min(1),
	target: z.string().min(1),
	rollout: RolloutSchema.nullable(),
});

/** `workers.fleetUpdateStatus` — the same rollout, with nothing moved. */
const FleetUpdateStatusSchema = z.object({ rollout: RolloutSchema.nullable() });

/**
 * The member states this build knows, in the order the summary counts them — the
 * control plane's own vocabulary (`src/identity/worker-update-rollout.ts`), restated
 * here only to order a printed tally. Anything outside it is still counted, after
 * these.
 */
const ROLLOUT_MEMBER_STATES = [
	'queued',
	'draining',
	'signalled',
	'verifying',
	'done',
	'skipped',
	'failed',
];

const StoredScmCredentialSchema = z.object({ login: z.string().min(1) });
const ProjectScmProviderSchema = z.object({ providerId: z.string().min(1) });

/** A `parse` for {@link OperatorClient} calls, so each call site names its schema and nothing else. */
function parseWith<T>(schema: z.ZodType<T>): (value: unknown) => T {
	return (value) => schema.parse(value);
}

/** The signed-in operator plus a client bound to their session — what every subcommand needs. */
interface Operator {
	client: OperatorClient;
	session: OperatorSession;
}

/**
 * Resolve `SWARM_CONTROL_PLANE_URL` + the cached `swarm login` session into a
 * client, printing the one actionable line and returning `undefined` when either
 * is missing. Called *after* a subcommand has parsed its arguments, so `--help`
 * and a usage error still answer on a machine that has never logged in.
 */
function requireOperator(): Operator | undefined {
	const resolved = requireOperatorSession();
	if ('error' in resolved) {
		out.error(resolved.error);
		return undefined;
	}
	return { client: createOperatorClient(resolved.session), session: resolved.session };
}

/**
 * Reject a worker id that is not a uuid before it reaches the API, printing the
 * message a missing worker gets. The procedures type `workerId` as a uuid, so a
 * display name typed in its place would otherwise come back as a raw input-schema
 * dump — and "no worker with id 'ada-laptop'" is both truer and shorter.
 */
function requireWorkerId(workerId: string): boolean {
	if (z.string().uuid().safeParse(workerId).success) return true;
	out.error(`no worker with id '${workerId}'`);
	return false;
}

/**
 * Parse a comma-separated `--cli` value into a validated `AgentCli[]`, printing a
 * friendly error and returning `undefined` on an empty list or unknown value. The
 * service re-validates and de-dupes; this just gives the operator a clear message
 * before a write is attempted.
 */
function parseClis(raw: string) {
	const parts = raw
		.split(',')
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	if (parts.length === 0) {
		out.error('--cli must list at least one CLI');
		return undefined;
	}
	const clis: AgentCli[] = [];
	for (const part of parts) {
		const parsed = AgentCliSchema.safeParse(part);
		if (!parsed.success) {
			out.error(`invalid CLI '${part}' — must be one of: ${AGENT_CLIS.join(', ')}`);
			return undefined;
		}
		clis.push(parsed.data);
	}
	return clis;
}

/**
 * The checkout the operator is standing in — what both registration paths key the
 * credential cache to, and what `register-and-enroll` prints as
 * `SWARM_WORKER_REPO_ROOT`. npm resets its script's cwd to the package root but
 * preserves the caller's directory in `INIT_CWD`; the global binary has no
 * `INIT_CWD`, so cwd is already its invocation checkout. The same expression
 * `swarm run:worker` resolves its own checkout with, so a worker registered here
 * starts there. Never ambient `SWARM_WORKER_REPO_ROOT` (see
 * `cacheCredentialForCheckout`), and no canonicalisation here:
 * `writeWorkerCredentialCache` already routes the path through
 * `canonicalCheckoutPath`.
 */
function invokingCheckout(): string {
	return process.env.INIT_CWD ?? process.cwd();
}

/**
 * Cache the freshly issued credential for a checkout,
 * and print the path — never the value (issue #788). Both registration paths call
 * this, so `swarm run:worker` finds a worker made either way.
 *
 * The caller chooses the checkout explicitly: both paths default to the checkout
 * this command is being run in (`invokingCheckout`), and `register-and-enroll`
 * additionally honours an explicit `--repo-root` for onboarding a machine from
 * somewhere else. Neither trusts ambient `SWARM_WORKER_REPO_ROOT`, which could name
 * a different worker than the one being registered.
 *
 * Best-effort by design. The credential is already issued and is about to be
 * printed, so a cache the operator can re-create by re-registering must never be
 * the reason registration reports failure — that would strand a registered worker
 * whose credential was never shown.
 */
function cacheCredentialForCheckout(workerId: string, credential: string, repoRoot: string): void {
	try {
		const cachePath = writeWorkerCredentialCache({
			repoRoot,
			workerId,
			credential,
		});
		if (existsSync(repoRoot)) {
			out.info(
				`also cached for ${repoRoot} — start this worker there with: swarm run:worker (${cachePath})`,
			);
		} else {
			out.info(`also cached for checkout ${repoRoot}: ${cachePath}`);
		}
	} catch (err) {
		out.warn(`could not cache the credential for ${repoRoot}: ${describeError(err)}`);
	}
}

async function registerWorkerCommand(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		options: {
			name: { type: 'string' },
			cli: { type: 'string' },
			help: { type: 'boolean', short: 'h' },
		},
		allowPositionals: true,
	});
	if (values.help) {
		out.info(USAGE);
		return 0;
	}

	const identifier = positionals[0];
	if (!identifier) {
		out.error('workers register: an <owner-identifier> is required');
		out.info(USAGE);
		return 1;
	}
	if (!values.name) {
		out.error('workers register: --name <displayName> is required');
		out.info(USAGE);
		return 1;
	}
	if (!values.cli) {
		out.error('workers register: --cli <c1,c2,...> is required');
		out.info(USAGE);
		return 1;
	}

	const capabilities = parseClis(values.cli);
	if (!capabilities) return 1;

	const operator = requireOperator();
	if (!operator) return 1;

	const { worker, credential } = await operator.client.mutate(
		'workers.register',
		{ ownerIdentifier: identifier, displayName: values.name, capabilities },
		parseWith(RegisteredWorkerSchema),
	);
	out.info(
		`registered worker '${worker.displayName}' for '${identifier}' (id ${worker.id}, CLIs: ${worker.capabilities.join(', ')})`,
	);
	cacheCredentialForCheckout(worker.id, credential, invokingCheckout());
	// Registration issues the worker's *connection* credential and nothing else, so
	// the machine still has no source-control identity and every dispatch to it
	// fails until one is stored (issue #765). Name both write surfaces and no
	// provider: which one a worker ends up on is decided by its enrollments, so the
	// hand-off goes to a surface that offers the right field per provider rather
	// than prompting here for one provider's secret. The credential stays the last
	// line printed — that "copy the last line" affordance is what
	// docs/onboarding-worker.md tells operators to do.
	out.info(
		'this worker has no operator source-control credential yet and cannot run a phase until it does — one per SCM provider its projects use',
	);
	out.info(
		`  its owner sets it in the dashboard at /workers/${worker.id} → "Operator source-control credential", or from that machine: swarm workers set-scm-credential ${worker.id} <scm-provider-id>`,
	);
	out.info('worker credential (store it now — it will not be shown again):');
	out.info(credential);
	return 0;
}

/**
 * Print one worker line, optionally prefixed with its owner identifier. Never
 * prints the credential.
 *
 * A machine that has been taken out of the dispatch pool is marked with a trailing
 * `draining` (issue #919), so an operator scanning the list can see at a glance
 * which machines are taking no work — a drain is sticky and expires on nothing, so
 * without the marker a machine left drained is silently idle forever.
 */
function printWorker(
	workerId: string,
	displayName: string,
	capabilities: string[],
	ownerIdentifier?: string,
	drainingSince?: string | null,
	update?: WorkerUpdateState | null,
): void {
	const prefix = ownerIdentifier ? `${ownerIdentifier}\t` : '';
	const suffix = `${drainingSince ? '\tdraining' : ''}${describeUpdate(update)}`;
	out.info(`${prefix}${workerId}\t${displayName}\t${capabilities.join(',')}${suffix}`);
}

/**
 * The self-update marker on a `list` line (issue #933): the target the machine was
 * asked for, and either that the request is still outstanding or the outcome it
 * reported.
 *
 * Both halves are worth a column of their own. A request nobody has answered is the
 * thing an operator is waiting on — a machine that is offline, or has not been
 * restarted into the new build yet — and an outcome that is not `applied` is the
 * one an operator would otherwise never see: nothing about the machine changes when
 * an update is declined or fails, so without this it simply carries on looking
 * normal on a build that is not the one asked for.
 */
function describeUpdate(update?: WorkerUpdateState | null): string {
	if (!update) return '';
	if (update.requestId) return `\tupdate ${update.target} pending`;
	return `\tupdate ${update.target} ${update.status ?? 'unreported'}`;
}

/**
 * List workers, from whichever read the caller is entitled to.
 *
 * Asking for **your own** handle is answered by `workers.listMine`, which needs
 * nothing beyond a session. Anything wider — another owner's machines, or every
 * owner's — is the installation roster (`workers.list`), reserved to an
 * `instanceAdmin` since issue #647; an owner filter on it is applied here rather
 * than server-side, since `RosterOwner` already carries the identifier. An
 * identifier nobody owns a worker under is "no workers for …" rather than "no such
 * user": user lookup is not on the operator API, deliberately, and an empty answer
 * is the honest one either way.
 */
async function listWorkersCommand(argv: string[]): Promise<number> {
	const { positionals } = parseArgs({ args: argv, allowPositionals: true });
	const identifier = positionals[0];

	const operator = requireOperator();
	if (!operator) return 1;

	if (identifier && sameIdentifier(identifier, operator.session.identifier)) {
		const mine = await operator.client.query(
			'workers.listMine',
			undefined,
			parseWith(OwnWorkersSchema),
		);
		if (mine.length === 0) {
			out.info(`no workers for '${identifier}'`);
			return 0;
		}
		for (const worker of mine) {
			printWorker(
				worker.workerId,
				worker.displayName,
				worker.capabilities,
				undefined,
				worker.drainingSince,
				worker.update,
			);
		}
		return 0;
	}

	const roster = await operator.client.query('workers.list', undefined, parseWith(RosterSchema));
	if (identifier) {
		const owned = roster.filter(
			(worker) => worker.owner && sameIdentifier(worker.owner.identifier, identifier),
		);
		if (owned.length === 0) {
			out.info(`no workers for '${identifier}'`);
			return 0;
		}
		for (const worker of owned) {
			printWorker(
				worker.workerId,
				worker.displayName,
				worker.capabilities,
				undefined,
				worker.drainingSince,
				worker.update,
			);
		}
		return 0;
	}

	if (roster.length === 0) {
		out.info('no workers');
		return 0;
	}
	for (const worker of roster) {
		printWorker(
			worker.workerId,
			worker.displayName,
			worker.capabilities,
			worker.owner?.identifier,
			worker.drainingSince,
			worker.update,
		);
	}
	return 0;
}

/** Login handles are matched the way an operator types them — a handle is not case-sensitive here. */
function sameIdentifier(left: string, right: string): boolean {
	return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * State the owner's durable CLI **declaration** for a worker, or clear it with
 * `--auto` (issue #783). It writes through `workers.setDeclaredCapabilities`, not
 * the probe path a handshake uses, which is what makes the statement survive the
 * machine's next reconnect — writing the probe column, as this used to, meant the
 * next handshake silently overwrote it.
 */
async function setCliCommand(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		options: {
			cli: { type: 'string' },
			auto: { type: 'boolean' },
			help: { type: 'boolean', short: 'h' },
		},
		allowPositionals: true,
	});
	if (values.help) {
		out.info(USAGE);
		return 0;
	}

	const workerId = positionals[0];
	if (!workerId) {
		out.error('workers set-cli: a <worker-id> is required');
		out.info(USAGE);
		return 1;
	}
	// Exactly one of the two: `--cli` states a declaration and `--auto` withdraws it,
	// so accepting both would leave which one won to argument order.
	if (values.cli && values.auto) {
		out.error('workers set-cli: --cli and --auto are mutually exclusive');
		out.info(USAGE);
		return 1;
	}
	if (!values.cli && !values.auto) {
		out.error('workers set-cli: one of --cli <c1,c2,...> or --auto is required');
		out.info(USAGE);
		return 1;
	}

	let capabilities: AgentCli[] | null = null;
	if (values.cli) {
		const parsed = parseClis(values.cli);
		if (!parsed) return 1;
		capabilities = parsed;
	}
	if (!requireWorkerId(workerId)) return 1;

	const operator = requireOperator();
	if (!operator) return 1;

	const updated = await operator.client.mutate(
		'workers.setDeclaredCapabilities',
		{ workerId, capabilities },
		parseWith(WorkerSchema),
	);
	if (capabilities === null) {
		out.info(
			`cleared the CLI declaration for worker '${updated.displayName}' (${workerId}) — it is back on auto-discovery, currently ${updated.capabilities.join(', ')}`,
		);
	} else {
		out.info(
			`declared CLIs for worker '${updated.displayName}' (${workerId}) as ${updated.capabilities.join(', ')} — this survives the machine's next reconnect`,
		);
	}
	return 0;
}

/**
 * Store (or rotate) a worker's operator SCM credential for one provider — the
 * write side of the per-`(worker, provider)` store the dispatcher resolves from
 * (`src/identity/worker-scm-credential.ts`, issue #765).
 *
 * The provider id must be a known one and the secret must be non-empty before a
 * call is made. Everything else is the control plane's: it re-checks the provider
 * against its own registry, requires the caller to **own** the worker, and
 * verifies the secret actually resolves to an account before storing it — a
 * credential that resolves to none is refused with nothing written, and the login
 * it did resolve to is named back so the operator can confirm the account this
 * machine will commit as.
 */
async function setScmCredentialCommand(argv: string[]): Promise<number> {
	const { positionals } = parseArgs({ args: argv, allowPositionals: true });
	const [workerId, providerId] = positionals;
	if (!workerId || !providerId) {
		out.error('workers set-scm-credential: <worker-id> and <scm-provider-id> are required');
		out.info(USAGE);
		return 1;
	}
	if (!(SCM_PROVIDER_IDS as readonly string[]).includes(providerId)) {
		out.error(
			`invalid SCM provider '${providerId}' — must be one of: ${SCM_PROVIDER_IDS.join(', ')}`,
		);
		return 1;
	}
	if (!requireWorkerId(workerId)) return 1;

	const operator = requireOperator();
	if (!operator) return 1;

	// Read for the display name the prompt names, so the operator sees which machine
	// they are about to give an identity to before typing a secret.
	const worker = await operator.client.query(
		'workers.getById',
		{ workerId },
		parseWith(WorkerDetailSchema),
	);

	const credential = await readOperatorCredential(providerId, worker.displayName);
	if (!credential) return 1;

	const { login } = await operator.client.mutate(
		'workers.scmCredentials.set',
		{ workerId, providerId, value: credential },
		parseWith(StoredScmCredentialSchema),
	);
	out.info(
		`stored operator scm credential for worker '${worker.displayName}' (${workerId}) on provider '${providerId}' — it authenticates as '${login}'`,
	);
	return 0;
}

async function removeWorkerCommand(argv: string[]): Promise<number> {
	const { positionals } = parseArgs({ args: argv, allowPositionals: true });
	const workerId = positionals[0];
	if (!workerId) {
		out.error('workers remove: a <worker-id> is required');
		out.info(USAGE);
		return 1;
	}
	if (!requireWorkerId(workerId)) return 1;

	const operator = requireOperator();
	if (!operator) return 1;

	await operator.client.mutate('workers.remove', { workerId }, parseWith(RemovedWorkerSchema));
	out.info(`removed worker '${workerId}'`);
	return 0;
}

/**
 * Take a machine out of the dispatch pool, or put it back (issue #919) — one
 * function for both subcommands, which differ only in the boolean they send and
 * the line they print.
 *
 * A drain is not an interruption: the machine keeps running whatever it already
 * started, and only the *next* dispatch is refused. So the useful answer is not
 * "done" but "has the old work finished yet", which is why `workers.setDraining`
 * returns the server-derived run state and why re-running this command is the
 * supported way to poll — the write is idempotent and keeps the instant the first
 * drain recorded.
 */
async function drainCommand(argv: string[], draining: boolean): Promise<number> {
	const subcommand = draining ? 'drain' : 'undrain';
	const { positionals } = parseArgs({ args: argv, allowPositionals: true });
	const workerId = positionals[0];
	if (!workerId) {
		out.error(`workers ${subcommand}: a <worker-id> is required`);
		out.info(USAGE);
		return 1;
	}
	if (!requireWorkerId(workerId)) return 1;

	const operator = requireOperator();
	if (!operator) return 1;

	const state = await operator.client.mutate(
		'workers.setDraining',
		{ workerId, draining },
		parseWith(DrainStateSchema),
	);
	const machine = `worker '${state.displayName}' (${workerId})`;
	if (!draining) {
		out.info(`${machine} is back in the pool — it may be given work again`);
		return 0;
	}
	if (state.busy) {
		out.info(
			`${machine} is draining — it will be given no new work. It is still running ${state.currentRunId ?? 'a job'}; wait for that to finish before restarting it, and re-run this command to check.`,
		);
		return 0;
	}
	out.info(
		`${machine} is draining and idle — safe to restart. It stays out of the pool until 'swarm workers undrain ${workerId}'.`,
	);
	return 0;
}

/**
 * Ask a machine to move its SWARM install root to a ref and restart into it (issue
 * #933).
 *
 * What it prints is an **acknowledgement, not an outcome**, and says so: the machine
 * may be offline, and even when it is connected it waits for the phases it is
 * already running to finish before applying anything. The answer lands on the row
 * later and is read back through `list`, which is why this command does not poll —
 * unlike `drain`, whose useful answer (`has it gone idle yet?`) is server-derived and
 * available immediately.
 *
 * The two refusals an operator will actually meet are both the control plane's own
 * words, printed verbatim like every other refusal in this file: a machine still in
 * the dispatch pool (`CONFLICT`, naming `swarm workers drain`) and a target that is
 * not a well-formed ref (`BAD_REQUEST`). Validating the ref here as well would only
 * let the two grammars drift.
 *
 * `--all` and `--status` hand over to {@link rolloutCommand} (issue #940) — the
 * staged form, which drains, signals, verifies and undrains a bounded wave at a time
 * and so answers in an entirely different shape from this one machine's
 * acknowledgement.
 */
async function updateWorkerCommand(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			all: { type: 'boolean' },
			status: { type: 'boolean' },
			wave: { type: 'string' },
		},
	});
	// `--all` is a staged rollout over every machine the operator owns, and `--status`
	// reads the one already under way; both are the same per-machine request as below,
	// scheduled rather than sent at once (issue #940).
	if (values.all || values.status) return await rolloutCommand(values, positionals);

	const [workerId, target] = positionals;
	if (!workerId || !target) {
		out.error('workers update: a <worker-id> and a <ref> are required');
		out.info(USAGE);
		return 1;
	}
	// A wave is a property of a rollout, so it means nothing here — refused rather
	// than silently ignored, since an operator who typed it meant to stage something.
	if (values.wave !== undefined) {
		out.error(
			'workers update: --wave sizes a staged fleet rollout, so it goes with --all — this form asks one machine',
		);
		out.info(USAGE);
		return 1;
	}
	if (!requireWorkerId(workerId)) return 1;

	const operator = requireOperator();
	if (!operator) return 1;

	const requested = await operator.client.mutate(
		'workers.requestUpdate',
		{ workerId, target },
		parseWith(RequestedUpdateSchema),
	);
	out.info(
		`asked worker '${requested.displayName}' (${workerId}) to move to '${requested.target}' and restart`,
	);
	out.info(
		'  it applies this once it holds no in-flight phase, and only if its host sets SWARM_WORKER_SELF_UPDATE=true',
	);
	out.info(
		`  run 'swarm workers list' to read what it reported, then 'swarm workers undrain ${workerId}' to put it back in the pool`,
	);
	return 0;
}

/**
 * `swarm workers sweep-worktrees <worker-id>` (issue #955): ask one machine to remove
 * its own long-abandoned `task-<id>` checkouts, and print what its last sweep removed.
 *
 * Both halves in one command because the request is what destroys the previous
 * record: a machine keeps only its most recent sweep, so the control plane answers
 * the mutation with the one it is replacing. What is printed is therefore *last
 * time's* outcome, and the sweep just asked for is read by the next run — the same
 * "acknowledgement, not an outcome" shape `update` has, for the same reason (the
 * machine may be offline, and the request waits on the row until it reconnects).
 *
 * Since issue #956 this is no longer the only way to read a machine's sweep —
 * `swarm workers sweeps` reads the whole fleet's without replacing any of them —
 * and this stays what an operator runs to ask one machine *now*.
 */
async function sweepWorktreesCommand(argv: string[]): Promise<number> {
	const { positionals } = parseArgs({ args: argv, allowPositionals: true });
	const workerId = positionals[0];
	if (!workerId) {
		out.error('workers sweep-worktrees: a <worker-id> is required');
		out.info(USAGE);
		return 1;
	}
	if (!requireWorkerId(workerId)) return 1;

	const operator = requireOperator();
	if (!operator) return 1;

	const requested = await operator.client.mutate(
		'workers.requestWorktreeSweep',
		{ workerId },
		parseWith(RequestedWorktreeSweepSchema),
	);
	printLastSweep(requested);
	out.info(
		`asked worker '${requested.displayName}' (${workerId}) to sweep its abandoned worktrees`,
	);
	out.info(
		'  it sweeps every project it is enrolled in, skipping any checkout still in use; run this command again to read what it removed',
	);
	return 0;
}

/** The previous sweep's own report, or one line saying there is none yet. */
function printLastSweep(requested: RequestedWorktreeSweep): void {
	const previous = requested.previousSweep;
	if (!previous) {
		out.info(`worker '${requested.displayName}' has no recorded sweep yet`);
		return;
	}
	printSweepReport(previous, '');
}

/**
 * One sweep's summary line followed by every path it removed, indented by `indent`
 * so the fleet readout can nest it under the machine it belongs to.
 *
 * The removed paths are printed individually rather than counted, because the count
 * alone hides the fact this feature exists to make visible: a removal that destroyed
 * uncommitted or unpushed work.
 */
function printSweepReport(sweep: WorktreeSweepReport, indent: string): void {
	const { result } = sweep;
	out.info(
		`${indent}last sweep (${sweep.reportedAt}, ${sweep.status}): removed ${result.removedCount}, kept ${result.keptLiveCount} still in use, ${result.failedCount} failed`,
	);
	for (const removal of result.removed) {
		// The two flags are the whole point of the record — an age-based sweep removes
		// work by design — so a removal that destroyed some says so on its own line.
		const lost = [
			removal.hadUncommittedChanges ? 'uncommitted changes' : undefined,
			removal.hadUnpushedCommits ? 'unpushed commits' : undefined,
		].filter((entry): entry is string => entry !== undefined);
		const suffix = lost.length > 0 ? ` — held ${lost.join(' and ')}` : '';
		out.info(
			`${indent}  ${removal.path} (${removal.projectId}, ${Math.round(removal.ageDays)}d untouched)${suffix}`,
		);
	}
	if (result.removedCount > result.removed.length) {
		out.info(`${indent}  … and ${result.removedCount - result.removed.length} more not listed`);
	}
	if (result.failedCount > 0) out.info(`${indent}  ${result.message}`);
}

/**
 * `swarm workers sweeps` (issue #956): what the **fleet** last deleted — one block
 * per machine, with its last recorded sweep and every path that sweep removed.
 *
 * The read half of the weekly schedule. Once sweeps are requested by the API
 * server's own clock rather than by an operator, `sweep-worktrees` is no longer a
 * way to read one: it prints the record and *replaces* it in the same breath, so
 * reading a machine's sweep used to cost that machine another. This asks for
 * nothing and replaces nothing.
 *
 * An installation administrator's command, like `request-update` and the unfiltered
 * `list`: it reads every owner's machines. The control plane's own refusal is
 * printed rather than re-worded, exactly as everywhere else in this group.
 *
 * Exit 0 whenever the call succeeded, including for a fleet that has never swept:
 * this is a report, not a pass/fail.
 */
async function sweepsCommand(): Promise<number> {
	const operator = requireOperator();
	if (!operator) return 1;

	const { workers } = await operator.client.query(
		'workers.listSweeps',
		undefined,
		parseWith(FleetWorktreeSweepsSchema),
	);
	if (workers.length === 0) {
		out.info('no workers are registered on this installation');
		return 0;
	}
	for (const worker of workers) {
		out.info(`${worker.displayName} (${worker.workerId})`);
		if (worker.lastSweep) printSweepReport(worker.lastSweep, '  ');
		// "Never swept" and "asked but not heard from" are different states and are
		// both worth saying: the second is what a machine offline since the weekly
		// signal went out looks like, and it resolves itself on that machine's next
		// connection rather than needing anything from the operator.
		else out.info('  never swept');
		if (worker.pendingRequestedAt) {
			out.info(`  a sweep requested ${worker.pendingRequestedAt} has not been answered yet`);
		}
	}
	return 0;
}

/**
 * `swarm workers update --all <ref> [--wave N]` and `swarm workers update --status`
 * (issue #940): move every machine the operator owns to a build as a **staged
 * rollout**, and read where that rollout stands.
 *
 * **Re-running it is how a rollout is advanced.** The first call drains and signals
 * the first wave; each later one settles what the machines have reported, verifies
 * the ones that applied, returns them to the pool and starts the next wave. That is
 * the same contract `drain` already has — re-run it to see where the machine is now —
 * and it is why this command prints the whole member table every time rather than an
 * acknowledgement. Advancing with nobody watching is phase 3 of issue #921.
 *
 * **Exit 0 whenever the call succeeded**, halted rollouts included: this is a report,
 * not a pass/fail, exactly as the fan-out it replaces was. Non-zero stays reserved
 * for a usage error or a failed call.
 *
 * `--status` is the same table with nothing moved, so an operator can look without
 * advancing anything.
 */
async function rolloutCommand(
	values: { all?: boolean; status?: boolean; wave?: string },
	positionals: string[],
): Promise<number> {
	if (values.status) {
		if (values.all || positionals.length > 0 || values.wave !== undefined) {
			out.error(
				'workers update: --status only reads the fleet update already under way, so it takes no <ref>, no --wave and no --all',
			);
			out.info(USAGE);
			return 1;
		}
		const operator = requireOperator();
		if (!operator) return 1;
		const { rollout } = await operator.client.query(
			'workers.fleetUpdateStatus',
			undefined,
			parseWith(FleetUpdateStatusSchema),
		);
		if (!rollout) {
			out.info(
				'you have never started a fleet update — `swarm workers update --all <ref>` starts one',
			);
			return 0;
		}
		printRollout(rollout);
		return 0;
	}

	// A worker id alongside `--all` is two different requests typed as one, so it is
	// refused naming both forms rather than resolved by guessing which was meant.
	if (positionals.length > 1) {
		out.error(
			'workers update: --all moves every machine you own, so it takes a <ref> and nothing else — for one machine run `swarm workers update <worker-id> <ref>`',
		);
		out.info(USAGE);
		return 1;
	}
	const target = positionals[0];
	if (!target) {
		out.error('workers update: a <ref> is required with --all');
		out.info(USAGE);
		return 1;
	}
	const waveSize = parseWaveSize(values.wave);
	if (waveSize === 'invalid') return 1;

	const operator = requireOperator();
	if (!operator) return 1;

	const result = await operator.client.mutate(
		'workers.startFleetUpdate',
		{ target, waveSize },
		parseWith(StartFleetUpdateSchema),
	);
	if (!result.rollout) {
		out.info(`you operate no machines — nothing to move to '${result.target}'`);
		return 0;
	}
	printRollout(result.rollout, result.action);
	return 0;
}

/**
 * `swarm workers request-update <ref>` (issue #922): ask **every machine on the
 * installation** — other owners' included — to move to a build, and print what
 * became of each.
 *
 * It is a separate subcommand rather than a flag on `update` because it is a
 * different *authorization*, not a different scope of the same one. `update` and
 * `update --all` are the machine owner's own calls about their own machines; this one
 * is an installation administrator's, and burying that behind `--everyone` would make
 * the most consequential form the least visible one. The two also answer in different
 * shapes — this reports a disposition per machine, where `--all` reports a staged
 * rollout's members — so they would have shared no output either.
 *
 * **A request, and only a request**, which is what the printed lines say out loud:
 * a machine acts solely if its own host opted in, and one its owner has not drained
 * comes back `in-pool` untouched. Both of those are the *owner's* switches and neither
 * needs the administrator, so the machines that did not move are as much of the answer
 * as the ones that did — which is why every machine gets a line and why the exit code
 * is 0 whatever the dispositions say, exactly as `update --all` is a report rather
 * than a pass/fail.
 *
 * The refusal for a non-administrator is the control plane's own words, printed
 * verbatim like every other refusal in this file.
 */
async function requestUpdateForInstallationCommand(argv: string[]): Promise<number> {
	const { positionals } = parseArgs({ args: argv, allowPositionals: true });
	if (positionals.length !== 1) {
		out.error(
			'workers request-update: a single <ref> is required — it asks every machine on the installation, so it takes no worker id',
		);
		out.info(USAGE);
		return 1;
	}
	const target = positionals[0] as string;

	const operator = requireOperator();
	if (!operator) return 1;

	const result = await operator.client.mutate(
		'workers.requestUpdateForInstallation',
		{ target },
		parseWith(InstallationUpdateRequestSchema),
	);
	printInstallationUpdateRequest(result);
	return 0;
}

/**
 * The installation-wide report: a heading naming who asked and for what, one line per
 * machine with its owner, and the two lines that say what an administrator can and
 * cannot do about the machines that did not move.
 *
 * Lines are printed in the order the control plane answered in — grouped by owner —
 * so the machines an administrator would have to go and talk to one person about sit
 * together.
 */
function printInstallationUpdateRequest(result: InstallationUpdateRequest): void {
	if (result.workers.length === 0) {
		out.info(
			`no workers are registered on this installation — nothing to ask for '${result.target}'`,
		);
		return;
	}
	out.info(
		`requested '${result.target}' from ${result.workers.length} machine${result.workers.length === 1 ? '' : 's'} on this installation, as ${result.requestedBy}`,
	);
	for (const worker of result.workers) {
		const owner = worker.owner?.identifier ?? 'owner unknown';
		const optedOut = worker.optedOut ? '\towner opted out' : '';
		out.info(
			`${worker.workerId}\t${worker.displayName}\t${owner}\t${worker.disposition}${optedOut}`,
		);
	}
	// The two things an administrator cannot do anything about on their own, named
	// rather than left to be inferred from a disposition — they are the machine
	// owner's two switches, and the whole reason this command is allowed to be
	// installation-wide.
	const inPool = result.workers.filter((worker) => worker.disposition === 'in-pool');
	if (inPool.length > 0) {
		out.info(
			`  ${inPool.length} still in the dispatch pool and so not asked — draining is the machine owner's own call, so ask ${ownersOf(inPool)} to run 'swarm workers drain <worker-id>', then run this again`,
		);
	}
	const optedOut = result.workers.filter((worker) => worker.optedOut);
	if (optedOut.length > 0) {
		out.info(
			`  ${optedOut.length} last reported 'declined' — ${ownersOf(optedOut)} have not set SWARM_WORKER_SELF_UPDATE=true on those hosts, and that is theirs to decide`,
		);
	}
	out.info(
		"  every machine asked applies this once it holds no in-flight phase; read what they reported with 'swarm workers list'",
	);
}

/** The distinct owners named on a set of report lines, for a line that says who to go and ask. */
function ownersOf(workers: InstallationUpdateRequest['workers']): string {
	const owners = [...new Set(workers.map((worker) => worker.owner?.identifier ?? 'their owner'))];
	return owners.join(', ');
}

/**
 * `--wave N` as a positive integer, or `undefined` when it was not given (the
 * control plane then applies its own default). Checked here rather than left to the
 * input schema only because "workers update: --wave must be a positive integer" is
 * shorter and truer than a raw schema dump for a typo.
 */
function parseWaveSize(raw: string | undefined): number | undefined | 'invalid' {
	if (raw === undefined) return undefined;
	const wave = Number(raw);
	if (!Number.isInteger(wave) || wave < 1) {
		out.error(`workers update: --wave must be a positive integer, got '${raw}'`);
		return 'invalid';
	}
	return wave;
}

/**
 * The whole rollout: a heading, one line per machine, a tally, and the one line that
 * says what to do next.
 *
 * The member table is printed in the rollout's own order — the order it will reach
 * the machines in, which is the order `swarm workers list` already prints — so an
 * operator reads the two against each other rather than matching ids.
 */
function printRollout(rollout: Rollout, action?: string): void {
	const wave = `${rollout.waveSize} machine${rollout.waveSize === 1 ? '' : 's'} per wave`;
	const lead = action === 'started' ? 'started fleet update' : 'fleet update';
	out.info(
		`${lead} ${rollout.id} to '${rollout.target}' — ${describeRolloutStatus(rollout.status)}, ${wave}`,
	);
	for (const member of rollout.members) {
		out.info(`${member.workerId}\t${member.displayName}\t${member.state}${memberDetail(member)}`);
	}
	out.info(summariseRollout(rollout.members));
	if (rollout.status === 'halted') {
		out.info(`  halted: ${rollout.haltReason ?? 'no reason recorded'}`);
		out.info(
			'  no further machine is drained or signalled. Fix the build, then start a new fleet update — there is no resume.',
		);
		// A machine that failed is left out of the pool on purpose, so the undrain that
		// ends that is named here rather than left to be remembered.
		const failed = rollout.members.filter((member) => member.state === 'failed');
		if (failed.length > 0) {
			out.info(
				`  left drained so you can look at ${failed.length === 1 ? 'it' : 'them'}: ${failed
					.map((member) => `swarm workers undrain ${member.workerId}`)
					.join('; ')}`,
			);
		}
		return;
	}
	if (rollout.status === 'completed') {
		out.info(`  every machine is on '${rollout.target}' and back in the dispatch pool`);
		return;
	}
	// The one thing an operator cannot see from the table: a machine only acts if its
	// own host opted in, and a machine that has not reports `declined` — which halts
	// the rollout, so it is worth naming before that happens rather than after.
	if (rollout.members.some((member) => member.state === 'signalled')) {
		out.info(
			'  each machine asked applies this once it holds no in-flight phase, and only if its host sets SWARM_WORKER_SELF_UPDATE=true',
		);
	}
	// It advances itself (issue #941), so the line under the table says what will
	// happen rather than what to type — the commands are how you *watch* it now.
	out.info(
		`  it advances on its own from here — read it with 'swarm workers update --status', or re-run 'swarm workers update --all ${rollout.target}' to nudge and read it`,
	);
}

/** The rollout status in the words an operator reads it in, not the stored token. */
function describeRolloutStatus(status: string): string {
	if (status === 'in_progress') return 'in progress';
	if (status === 'halted') return 'HALTED';
	if (status === 'completed') return 'completed';
	// A status this build has never heard of is printed as it came, on the same
	// tolerance every other vocabulary in this file is read with.
	return status;
}

/**
 * The detail column on a member line: what the machine reported, and the first line
 * of its own message. The message is cut to its first line for the reason the fleet
 * report already cut it — it carries a bounded command tail for a failed build, which
 * belongs in the halt reason under the table rather than in the middle of it.
 */
function memberDetail(member: RolloutMember): string {
	const firstLine = member.message?.split('\n')[0]?.trim();
	if (member.outcome && firstLine) return `\t${member.outcome}: ${firstLine}`;
	if (member.outcome) return `\t${member.outcome}`;
	return firstLine ? `\t${firstLine}` : '';
}

/** One tally line under the table, so a fleet is read without counting rows. */
function summariseRollout(members: RolloutMember[]): string {
	const counts = new Map<string, number>();
	for (const member of members) {
		counts.set(member.state, (counts.get(member.state) ?? 0) + 1);
	}
	const known = ROLLOUT_MEMBER_STATES.filter((state) => counts.has(state));
	// A state this build has never heard of is still counted, after the known ones —
	// the same tolerance the schema above reads the word with.
	const unknown = [...counts.keys()].filter((state) => !ROLLOUT_MEMBER_STATES.includes(state));
	const tally = [...known, ...unknown.sort()]
		.map((state) => `${counts.get(state)} ${state}`)
		.join(', ');
	return `${members.length} machine${members.length === 1 ? '' : 's'}: ${tally}`;
}

/**
 * Bridge the CLI's `(worker-id, project-id)` arguments to the enrollment-id-keyed
 * mutations, which is what `workers.getById` is read for: its detail carries
 * `enrollments[].enrollmentId` per visible project. Prints the message and returns
 * `undefined` when the pair names no enrollment — shared by the three enrollment
 * subcommands, replacing the direct `getEnrollment(workerId, projectId)` lookup.
 */
async function resolveEnrollment(
	client: OperatorClient,
	workerId: string,
	projectId: string,
): Promise<{ displayName: string; enrollmentId: string } | undefined> {
	const worker = await client.query('workers.getById', { workerId }, parseWith(WorkerDetailSchema));
	const enrollment = worker.enrollments.find((entry) => entry.projectId === projectId);
	if (!enrollment) {
		out.error(`no enrollment for worker '${workerId}' in '${projectId}'`);
		return undefined;
	}
	return { displayName: worker.displayName, enrollmentId: enrollment.enrollmentId };
}

/**
 * Parse the optional `--concurrency` flag into a positive integer, printing a
 * friendly error on an invalid value — including a value-less `--concurrency`,
 * which must not read as "clear the allocation" (issue #480).
 * `{ ok: true, value: undefined }` means the flag was omitted, and the service
 * then applies `DEFAULT_CONCURRENCY_ALLOCATION`.
 */
function parseConcurrencyFlag(
	raw: string | undefined,
): { ok: true; value?: number } | { ok: false } {
	if (raw === undefined) return { ok: true, value: undefined };
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1) {
		out.error(`--concurrency must be a positive integer, got '${raw}'`);
		return { ok: false };
	}
	return { ok: true, value };
}

/**
 * What {@link performEnroll} left behind, so a caller names only the steps that
 * really remain. `enrollment` is present whenever `workers.enroll` succeeded —
 * *including* when a later `--active` / `--consent` was refused — so its absence
 * is what says nothing was written and re-running `workers enroll` is the way
 * forward. Getting that backwards is how an operator ends up re-running a create
 * that can only answer `CONFLICT`.
 */
interface EnrollOutcome {
	readonly code: number;
	readonly enrollment?: { readonly status: string; readonly sharingConsent: boolean };
}

/**
 * The subcommands a created-but-not-routable enrollment still needs, in the order
 * they are run. Kept copy-pastable — who may run which is said once by
 * {@link performEnroll}'s refusal report, never glued onto the command itself.
 */
function remainingEnrollmentSteps(
	workerId: string,
	projectId: string,
	enrollment: { status: string; sharingConsent: boolean },
): string[] {
	const steps: string[] = [];
	if (enrollment.status !== 'active') {
		steps.push(`swarm workers approve ${workerId} ${projectId}`);
	}
	if (!enrollment.sharingConsent) {
		steps.push(`swarm workers consent ${workerId} ${projectId} on`);
	}
	return steps;
}

/** {@link remainingEnrollmentSteps}, printed — the standalone `enroll`'s half of the recovery. */
function reportRemainingEnrollmentSteps(
	workerId: string,
	projectId: string,
	enrollment: { status: string; sharingConsent: boolean },
): void {
	const steps = remainingEnrollmentSteps(workerId, projectId, enrollment);
	if (steps.length === 0) return;
	out.info('finish it by hand with:');
	for (const command of steps) out.info(`  ${command}`);
}

/**
 * Apply one of {@link performEnroll}'s two post-create flags, so a refusal of it
 * cannot suppress the other flag's call (issue #901). Returns the updated
 * enrollment, or `undefined` with the control plane's own words pushed onto
 * `refusals`.
 *
 * The two flags are separate decisions by separate people — `--active` is a
 * `projectAdmin`'s call, `--consent` strictly the machine owner's (ADR-001) — over
 * two independent columns, so neither's authorization depends on the other's
 * outcome. Running both inside one `try` meant the ordinary federated case, an
 * owner enrolling into a project they administer nothing on, jumped from the
 * pending-approval refusal straight past the `setConsent` this command had already
 * been asked to make: the administrator's later approval then landed on a row with
 * no consent on it, and the owner had to grant it by hand afterwards.
 */
async function applyEnrollmentFlag(
	apply: () => Promise<z.infer<typeof EnrollmentSchema>>,
	refusals: string[],
): Promise<z.infer<typeof EnrollmentSchema> | undefined> {
	try {
		return await apply();
	} catch (err) {
		// A non-API failure is a programming error, not an operator-facing line.
		if (!(err instanceof OperatorApiError)) throw err;
		refusals.push(err.message);
		return undefined;
	}
}

/**
 * Perform the enrollment write and report it, surfacing a refusal as one line and
 * exit 1 — the allowed CLIs the machine does not declare, a project whose
 * repository is not the machine's checkout (issue #690), a duplicate enrollment,
 * and an inaccessible project all already name what disagrees, so each message is
 * printed as the control plane wrote it.
 *
 * `--active` / `--consent` are applied *after* the create rather than sent with
 * it, because the server decides the initial state for itself (issue #784): a
 * caller who both owns the machine and administers the project has already made
 * both decisions in the act of enrolling, and gets an active, consenting
 * enrollment with no further call. Each flag is spent only when the created
 * enrollment is not already in that state.
 *
 * That makes the write non-atomic where the pre-#800 direct-DB one was, so a
 * refused `--active` (a `projectAdmin` call) or `--consent` (strictly the owner's)
 * leaves a *created* enrollment behind. It is reported as one extra line rather
 * than swallowed: the operator has to know the row exists, or they will re-run
 * `workers enroll` and get `CONFLICT` for their trouble. Since issue #901 the two
 * flags are also spent and refused *independently* of each other, so one refusal
 * neither skips the other call nor hides its message — a run may report two.
 */
async function performEnroll(
	client: OperatorClient,
	worker: { id: string; displayName: string },
	projectId: string,
	allowedClis: AgentCli[],
	concurrencyAllocation: number | undefined,
	active: boolean,
	consent: boolean,
): Promise<EnrollOutcome> {
	let enrollment: z.infer<typeof EnrollmentSchema>;
	try {
		enrollment = await client.mutate(
			'workers.enroll',
			{ workerId: worker.id, projectId, allowedClis, concurrencyAllocation },
			parseWith(EnrollmentSchema),
		);
	} catch (err) {
		// Nothing was created, so there is no row to report and the caller's own
		// recovery — `workers enroll …` again — is still the way forward.
		if (!(err instanceof OperatorApiError)) throw err;
		out.error(err.message);
		return { code: 1 };
	}

	// One id for all three responses, so neither call below reads a reassigned binding.
	const enrollmentId = enrollment.id;
	const refusals: string[] = [];
	if (active && enrollment.status !== 'active') {
		enrollment =
			(await applyEnrollmentFlag(
				() =>
					client.mutate('workers.approveEnrollment', { enrollmentId }, parseWith(EnrollmentSchema)),
				refusals,
			)) ?? enrollment;
	}
	// Reached whether or not the approval above was refused: this call is the
	// owner's own and was authorized independently of it (issue #901).
	if (consent && !enrollment.sharingConsent) {
		enrollment =
			(await applyEnrollmentFlag(
				() =>
					client.mutate(
						'workers.setConsent',
						{ enrollmentId, sharingConsent: true },
						parseWith(EnrollmentSchema),
					),
				refusals,
			)) ?? enrollment;
	}

	if (refusals.length === 0) {
		out.info(
			`enrolled worker '${worker.displayName}' (${worker.id}) in '${projectId}' — status ${enrollment.status}, CLIs ${enrollment.allowedClis.join(', ')}, concurrency ${enrollment.concurrencyAllocation}, sharing consent ${enrollment.sharingConsent ? 'on' : 'off'}`,
		);
		return { code: 0, enrollment };
	}
	// Every refusal, not just the first: the flags are applied independently, so a
	// caller entitled to neither decision can be refused twice in one run.
	for (const message of refusals) out.error(message);
	out.info(
		`the enrollment was created — worker '${worker.displayName}' (${worker.id}) in '${projectId}': status ${enrollment.status}, sharing consent ${enrollment.sharingConsent ? 'on' : 'off'}. Do not enroll it again.`,
	);
	out.info(
		"it is routable only while active AND consenting — approving is a project administrator's call, consent the machine owner's own",
	);
	return { code: 1, enrollment };
}

async function enrollCommand(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		options: {
			cli: { type: 'string' },
			concurrency: { type: 'string' },
			active: { type: 'boolean' },
			consent: { type: 'boolean' },
			help: { type: 'boolean', short: 'h' },
		},
		allowPositionals: true,
	});
	if (values.help) {
		out.info(USAGE);
		return 0;
	}

	const [workerId, projectId] = positionals;
	if (!workerId || !projectId) {
		out.error('workers enroll: <worker-id> and <project-id> are required');
		out.info(USAGE);
		return 1;
	}
	if (!values.cli) {
		out.error('workers enroll: --cli <c1,c2,...> is required');
		out.info(USAGE);
		return 1;
	}
	const allowedClis = parseClis(values.cli);
	if (!allowedClis) return 1;

	const concurrency = parseConcurrencyFlag(values.concurrency);
	if (!concurrency.ok) return 1;
	if (!requireWorkerId(workerId)) return 1;

	const operator = requireOperator();
	if (!operator) return 1;

	// Read for the display name the report names, and so an unknown worker is
	// refused before anything is written.
	const worker = await operator.client.query(
		'workers.getById',
		{ workerId },
		parseWith(WorkerDetailSchema),
	);

	const outcome = await performEnroll(
		operator.client,
		{ id: worker.workerId, displayName: worker.displayName },
		projectId,
		allowedClis,
		concurrency.value,
		values.active ?? false,
		values.consent ?? false,
	);
	// A refused `--active`/`--consent` left a real enrollment behind, so the way
	// forward is the one flag that did not land — never this command again.
	if (outcome.enrollment && outcome.code !== 0) {
		reportRemainingEnrollmentSteps(worker.workerId, projectId, outcome.enrollment);
	}
	return outcome.code;
}

/** Everything `register-and-enroll` resolves before it writes anything. */
interface RegisterAndEnrollPlan {
	readonly identifier: string;
	readonly projectId: string;
	readonly displayName: string;
	readonly capabilities: AgentCli[];
	/** The provider the target project runs on — never assumed. */
	readonly providerId: string;
	readonly operatorCredential: string;
	/**
	 * The checkout to print in the start command and cache the credential for:
	 * `--repo-root`, else the checkout this command is run in — the machine being
	 * onboarded, not whichever machine last registered the project.
	 */
	readonly repoRoot: string;
}

/**
 * Parse and resolve `register-and-enroll`'s whole input — arguments, the session,
 * the project's SCM provider, and the operator's secret — printing the message and
 * returning an exit code itself when any of it fails.
 *
 * Split out because the *ordering* is the design (see the command below): nothing
 * here has written anything, so every one of these failures leaves no worker row
 * and no half-configured machine behind. `workers.projectScmProvider` is what now
 * validates the project — it is a `contributor` read, so an unknown or
 * inaccessible project is refused here, before the secret is asked for; since
 * issue #899 it says which of the two it was, and the operator sees that line
 * unchanged because every refusal here is printed in the control plane's own
 * words. The
 * **owner identifier** is the one input that moved later: `workers.register`
 * resolves it, so a typo there costs an operator a wasted secret entry rather than
 * failing immediately. Nothing is written either way.
 */
async function planRegisterAndEnroll(
	argv: string[],
): Promise<
	{ ok: true; operator: Operator; plan: RegisterAndEnrollPlan } | { ok: false; code: number }
> {
	const { values, positionals } = parseArgs({
		args: argv,
		options: {
			name: { type: 'string' },
			cli: { type: 'string' },
			'control-plane-url': { type: 'string' },
			'repo-root': { type: 'string' },
			help: { type: 'boolean', short: 'h' },
		},
		allowPositionals: true,
	});
	if (values.help) {
		out.info(USAGE);
		return { ok: false, code: 0 };
	}

	const [identifier, projectId] = positionals;
	const { name, cli } = values;
	if (!identifier || !projectId || !name || !cli) {
		out.error(`workers register-and-enroll: ${missingArgument(identifier, projectId, name)}`);
		out.info(USAGE);
		return { ok: false, code: 1 };
	}

	const capabilities = parseClis(cli);
	if (!capabilities) return { ok: false, code: 1 };

	// Before `requireOperator`, which reads SWARM_CONTROL_PLANE_URL: on a machine
	// being onboarded for its first worker nothing has ever written it, and the
	// daemon this command ends by printing a start line for reads it from the same
	// `.env`. Idempotent by construction (`../_shared/control-plane-env.ts`), so a
	// second worker on an onboarded machine passes straight through. It is the one
	// write that precedes the plan-then-act ordering below, and deliberately: it
	// touches nothing on the control plane, and every step after it needs the URL.
	if (!(await ensureControlPlaneUrl(values['control-plane-url']))) return { ok: false, code: 1 };

	const operator = requireOperator();
	if (!operator) return { ok: false, code: 1 };

	// The provider is a property of the *project*, resolved server-side through the
	// same lookup the dispatcher uses so the credential is stored under the id a
	// dispatch will ask for — never `project.scm ?? 'github'`. Its refusals already
	// name the project and what it asked for.
	const { providerId } = await operator.client.query(
		'workers.projectScmProvider',
		{ projectId },
		parseWith(ProjectScmProviderSchema),
	);

	const operatorCredential = await readOperatorCredential(providerId, name);
	if (!operatorCredential) return { ok: false, code: 1 };

	return {
		ok: true,
		operator,
		plan: {
			identifier,
			projectId,
			displayName: name,
			capabilities,
			providerId,
			operatorCredential,
			repoRoot: values['repo-root'] ?? invokingCheckout(),
		},
	};
}

/**
 * Which required argument `register-and-enroll` is missing, in the order it reads
 * them — so `--cli` is what is left once the other three are present.
 */
function missingArgument(
	identifier: string | undefined,
	projectId: string | undefined,
	name: string | undefined,
): string {
	if (!identifier || !projectId) return 'an <owner-identifier> and a <project-id> are required';
	if (!name) return '--name <displayName> is required';
	return '--cli <c1,c2,...> is required';
}

/**
 * Read the operator's credential for one provider — never from argv, where it
 * would land in the shell history and in `ps` output. `undefined` (message already
 * printed) for an empty secret.
 *
 * The prompt names the **kind** of secret that provider expects (issue #807), from
 * the same catalogue the dashboard's operator-credential card names it in
 * (`SCM_OPERATOR_CREDENTIAL_COPY`, `src/scm/operator-credential-copy.ts`), so the
 * two cannot say different things about one credential. The bare provider id it
 * used to interpolate left an operator to know, or guess, that GitHub means a
 * personal access token while Bitbucket means an app password. A provider this
 * catalogue does not name — the control plane resolves the id through its *own*
 * registry, so a fourth one can arrive here first — keeps the old wording rather
 * than being described in GitHub's words.
 */
async function readOperatorCredential(
	providerId: string,
	displayName: string,
): Promise<string | undefined> {
	const copy = operatorCredentialCopyFor(providerId);
	const credentialType = copy ? ` (${copy.credentialType})` : '';
	const secret = process.stdin.isTTY
		? await promptHidden(
				`Operator ${providerId} credential${credentialType} for '${displayName}': `,
			)
		: await readStdin();
	const credential = secret.trim();
	if (credential.length === 0) {
		out.error('the credential must not be empty');
		return undefined;
	}
	return credential;
}

/**
 * `register-and-enroll` — the one command that takes an operator from "no worker"
 * to "registered, credentialed, enrolled, and here is what starts it" (issue #786).
 *
 * It adds no business logic: `workers.register`, `workers.scmCredentials.set` and
 * `performEnroll` are the same calls `register` / `set-scm-credential` / `enroll`
 * make, with the same refusals. What it does add is **ordering** — everything that
 * can fail without writing anything (the CLI list, the session, the project and
 * its SCM provider, an empty or aborted secret) is checked *before*
 * `workers.register` by `planRegisterAndEnroll`, so a mistyped argument never
 * leaves an orphaned worker behind.
 *
 * It also prompts for a secret where `register` deliberately does not (issue #767).
 * That is not a reversal: `register` has no project and so would have to *guess* a
 * provider, while this command is handed one and resolves it through
 * `workers.projectScmProvider` — never `project.scm ?? 'github'`.
 *
 * It does not start the daemon. That stays a foreground, operator-owned process on
 * the worker's own machine, so the last thing printed is the command to run there.
 */
async function registerAndEnrollCommand(argv: string[]): Promise<number> {
	const planned = await planRegisterAndEnroll(argv);
	if (!planned.ok) return planned.code;
	const { client } = planned.operator;
	const {
		identifier,
		projectId,
		displayName,
		capabilities,
		providerId,
		operatorCredential,
		repoRoot,
	} = planned.plan;

	const { worker, credential } = await client.mutate(
		'workers.register',
		{ ownerIdentifier: identifier, displayName, capabilities },
		parseWith(RegisteredWorkerSchema),
	);
	out.info(
		`registered worker '${worker.displayName}' for '${identifier}' (id ${worker.id}, CLIs: ${worker.capabilities.join(', ')})`,
	);
	cacheCredentialForCheckout(worker.id, credential, repoRoot);

	// From here the worker row exists and its credential is a one-time value held
	// only in memory, so a later failure must still hand it over — losing it means
	// `workers remove` + `workers register` again. Each recovery path names only the
	// step that did not complete, and prints the credential exactly once, last.
	const reportUnfinished = (remaining: string[]): number => {
		out.info(
			remaining.length > 0
				? 'the worker is registered; finish it by hand with:'
				: 'the worker is registered.',
		);
		for (const command of remaining) out.info(`  ${command}`);
		out.info('worker credential (store it now — it will not be shown again):');
		out.info(credential);
		return 1;
	};
	const enrollByHand = `swarm workers enroll ${worker.id} ${projectId} --cli ${capabilities.join(',')} --active --consent`;

	try {
		const { login } = await client.mutate(
			'workers.scmCredentials.set',
			{ workerId: worker.id, providerId, value: operatorCredential },
			parseWith(StoredScmCredentialSchema),
		);
		out.info(
			`stored operator scm credential for worker '${worker.displayName}' (${worker.id}) on provider '${providerId}' — it authenticates as '${login}'`,
		);
	} catch (err) {
		if (!(err instanceof OperatorApiError)) throw err;
		out.error(err.message);
		return reportUnfinished([
			`swarm workers set-scm-credential ${worker.id} ${providerId}`,
			enrollByHand,
		]);
	}

	// The same helper `enroll` uses, so the capability, repository-mismatch and
	// duplicate refusals are surfaced unchanged. Active + consenting with no flag:
	// an enrollment is routable only while both hold, and a pending, non-consenting
	// one is not "ready to start" — the four-command path stays for anyone who wants
	// the two human approvals kept separate.
	const enrolled = await performEnroll(
		client,
		{ id: worker.id, displayName: worker.displayName },
		projectId,
		capabilities,
		undefined,
		true,
		true,
	);
	if (enrolled.code !== 0) {
		// Which recovery is printed turns on whether the enrollment row exists: a
		// refused `--active` (a `projectAdmin` call the machine's owner may well not
		// have) already created it, so re-running `workers enroll` could only answer
		// `CONFLICT`. Name the approvals that are actually outstanding instead.
		return reportUnfinished(
			enrolled.enrollment
				? remainingEnrollmentSteps(worker.id, projectId, enrolled.enrollment)
				: [enrollByHand],
		);
	}

	// The credential's one and only appearance, on the last line — the "copy the
	// last line" affordance docs/onboarding-worker.md relies on.
	out.info(
		'start the worker on that machine — this command does not (its .env must already carry SWARM_CONTROL_PLANE_URL). Run:',
	);
	out.info(
		`SWARM_WORKER_CREDENTIAL=${credential} SWARM_WORKER_REPO_ROOT=${repoRoot} npm run dev:worker`,
	);
	return 0;
}

async function updateEnrollmentCommand(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		options: {
			cli: { type: 'string' },
			concurrency: { type: 'string' },
			help: { type: 'boolean', short: 'h' },
		},
		allowPositionals: true,
	});
	if (values.help) {
		out.info(USAGE);
		return 0;
	}

	const [workerId, projectId] = positionals;
	if (!workerId || !projectId) {
		out.error('workers update-enrollment: <worker-id> and <project-id> are required');
		out.info(USAGE);
		return 1;
	}
	if (values.cli === undefined && values.concurrency === undefined) {
		out.error(
			'workers update-enrollment: pass --cli and/or --concurrency — there is nothing to update',
		);
		out.info(USAGE);
		return 1;
	}

	let allowedClis: AgentCli[] | undefined;
	if (values.cli !== undefined) {
		allowedClis = parseClis(values.cli);
		if (!allowedClis) return 1;
	}
	const concurrency = parseConcurrencyFlag(values.concurrency);
	if (!concurrency.ok) return 1;
	if (!requireWorkerId(workerId)) return 1;

	const operator = requireOperator();
	if (!operator) return 1;

	const resolved = await resolveEnrollment(operator.client, workerId, projectId);
	if (!resolved) return 1;

	const updated = await operator.client.mutate(
		'workers.updateConstraints',
		{
			enrollmentId: resolved.enrollmentId,
			allowedClis,
			concurrencyAllocation: concurrency.value,
		},
		parseWith(EnrollmentSchema),
	);
	out.info(
		`updated enrollment for worker '${resolved.displayName}' (${workerId}) in '${projectId}' — CLIs ${updated.allowedClis.join(', ')}, concurrency ${updated.concurrencyAllocation}`,
	);
	return 0;
}

async function approveCommand(argv: string[]): Promise<number> {
	const { positionals } = parseArgs({ args: argv, allowPositionals: true });
	const [workerId, projectId] = positionals;
	if (!workerId || !projectId) {
		out.error('workers approve: <worker-id> and <project-id> are required');
		out.info(USAGE);
		return 1;
	}
	if (!requireWorkerId(workerId)) return 1;

	const operator = requireOperator();
	if (!operator) return 1;

	const resolved = await resolveEnrollment(operator.client, workerId, projectId);
	if (!resolved) return 1;

	await operator.client.mutate(
		'workers.approveEnrollment',
		{ enrollmentId: resolved.enrollmentId },
		parseWith(EnrollmentSchema),
	);
	out.info(`approved enrollment for worker '${workerId}' in '${projectId}' (now active)`);
	return 0;
}

async function consentCommand(argv: string[]): Promise<number> {
	const { positionals } = parseArgs({ args: argv, allowPositionals: true });
	const [workerId, projectId, toggle] = positionals;
	if (!workerId || !projectId || !toggle) {
		out.error('workers consent: <worker-id> <project-id> <on|off> are required');
		out.info(USAGE);
		return 1;
	}
	if (toggle !== 'on' && toggle !== 'off') {
		out.error(`workers consent: expected 'on' or 'off', got '${toggle}'`);
		return 1;
	}
	if (!requireWorkerId(workerId)) return 1;

	const operator = requireOperator();
	if (!operator) return 1;

	const resolved = await resolveEnrollment(operator.client, workerId, projectId);
	if (!resolved) return 1;

	await operator.client.mutate(
		'workers.setConsent',
		{ enrollmentId: resolved.enrollmentId, sharingConsent: toggle === 'on' },
		parseWith(EnrollmentSchema),
	);
	out.info(`sharing consent for worker '${workerId}' in '${projectId}' is now ${toggle}`);
	return 0;
}

export async function run(argv: string[]): Promise<number> {
	const [subcommand, ...rest] = argv;

	if (!subcommand || subcommand === '--help' || subcommand === '-h' || subcommand === 'help') {
		out.info(USAGE);
		// No subcommand is a usage error; an explicit --help is not.
		return subcommand ? 0 : 1;
	}

	if (!SUBCOMMANDS.includes(subcommand)) {
		out.error(`unknown workers subcommand '${subcommand}'`);
		out.info(USAGE);
		return 1;
	}

	try {
		switch (subcommand) {
			case 'register':
				return await registerWorkerCommand(rest);
			case 'register-and-enroll':
				return await registerAndEnrollCommand(rest);
			case 'list':
				return await listWorkersCommand(rest);
			case 'set-cli':
				return await setCliCommand(rest);
			case 'set-scm-credential':
				return await setScmCredentialCommand(rest);
			case 'drain':
				return await drainCommand(rest, true);
			case 'undrain':
				return await drainCommand(rest, false);
			case 'update':
				return await updateWorkerCommand(rest);
			case 'request-update':
				return await requestUpdateForInstallationCommand(rest);
			case 'sweep-worktrees':
				return await sweepWorktreesCommand(rest);
			case 'sweeps':
				return await sweepsCommand();
			case 'enroll':
				return await enrollCommand(rest);
			case 'update-enrollment':
				return await updateEnrollmentCommand(rest);
			case 'approve':
				return await approveCommand(rest);
			case 'consent':
				return await consentCommand(rest);
			default:
				return await removeWorkerCommand(rest);
		}
	} catch (err) {
		// Every refusal the control plane made — and every way it could not be reached
		// — already carries a message written for an operator, so it is printed as one
		// line and exits 1. Anything else is rethrown rather than dressed up as an
		// operator-facing refusal: `../index.ts`'s own catch is the blanket safety net,
		// and this one is deliberately not it.
		if (err instanceof OperatorApiError) {
			out.error(err.message);
			return 1;
		}
		throw err;
	}
}
