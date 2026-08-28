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
 * One thing also stopped being atomic: `--active` on `enroll` is a `projectAdmin`
 * call made *after* the create, so an owner who does not administer the project
 * gets a real, pending enrollment plus a refusal. Both paths report the created
 * row and name the approvals still outstanding rather than telling anyone to
 * enroll again (`performEnroll` / `remainingEnrollmentSteps` below).
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
 * command that starts the daemon. It may prompt where `register` may not,
 * precisely because it is handed the target project and therefore *resolves* the
 * provider (`workers.projectScmProvider`) instead of guessing one — the condition
 * #767 recorded as missing at registration time.
 *
 * Subcommands:
 *   swarm workers register <owner-identifier> --name <displayName> --cli <c1,c2,...>
 *   swarm workers register-and-enroll <owner-identifier> <project-id> --name <displayName> --cli <c1,c2,...> [--repo-root <path>]
 *   swarm workers list [<owner-identifier>]
 *   swarm workers set-cli <worker-id> (--cli <c1,c2,...> | --auto)
 *   swarm workers set-scm-credential <worker-id> <scm-provider-id>
 *   swarm workers remove <worker-id>
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
import { SCM_TYPES } from '../../scm/types.js';
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
  swarm workers register-and-enroll <owner-identifier> <project-id> --name <displayName> --cli <c1,c2,...> [--repo-root <path>]
  swarm workers list [<owner-identifier>]
  swarm workers set-cli <worker-id> (--cli <c1,c2,...> | --auto)
  swarm workers set-scm-credential <worker-id> <scm-provider-id>
  swarm workers remove <worker-id>
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
             The one-command path for a NEW machine: registers the worker,
             stores its operator source-control credential, and enrolls it in
             <project-id> — then prints the exact command that starts it. The
             provider is resolved from the target project, so the credential
             prompt names the provider that project actually runs on
             (${SCM_PROVIDER_IDS.join(' | ')}); prompts without echo on a TTY and
             otherwise reads the secret from stdin, and never prints it back. The
             secret is verified against the provider before it is stored. The
             enrollment ends up active with sharing consent on, so the machine is
             routable as soon as it connects. It does NOT start the worker: the
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
             comments as. Prompts (no echo) on a TTY, otherwise reads the secret
             from stdin; never takes it as an argument and never prints it back.
             The value is verified against the provider before it is stored, and
             the account it resolved to is named back. Takes effect on the next
             dispatch — no worker restart. The machine's owner alone may do it,
             so sign in as them.
  remove     Deregister a worker by worker id. The machine's owner alone may do
             it, and it is refused while that machine is running a job.
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
             names what is left to run rather than asking you to enroll again.
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

const RosterSchema = z.array(
	z.object({
		workerId: z.string().min(1),
		displayName: z.string().min(1),
		capabilities: CapabilityListSchema,
		owner: z.object({ identifier: z.string().min(1) }).nullable(),
	}),
);

const OwnWorkersSchema = z.array(
	z.object({
		workerId: z.string().min(1),
		displayName: z.string().min(1),
		capabilities: CapabilityListSchema,
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

/** Print one worker line, optionally prefixed with its owner identifier. Never prints the credential. */
function printWorker(
	workerId: string,
	displayName: string,
	capabilities: string[],
	ownerIdentifier?: string,
): void {
	const prefix = ownerIdentifier ? `${ownerIdentifier}\t` : '';
	out.info(`${prefix}${workerId}\t${displayName}\t${capabilities.join(',')}`);
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
			printWorker(worker.workerId, worker.displayName, worker.capabilities);
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
			printWorker(worker.workerId, worker.displayName, worker.capabilities);
		}
		return 0;
	}

	if (roster.length === 0) {
		out.info('no workers');
		return 0;
	}
	for (const worker of roster) {
		printWorker(worker.workerId, worker.displayName, worker.capabilities, worker.owner?.identifier);
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
 * `workers enroll` and get `CONFLICT` for their trouble.
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
	let enrollment: z.infer<typeof EnrollmentSchema> | undefined;
	try {
		enrollment = await client.mutate(
			'workers.enroll',
			{ workerId: worker.id, projectId, allowedClis, concurrencyAllocation },
			parseWith(EnrollmentSchema),
		);
		if (active && enrollment.status !== 'active') {
			enrollment = await client.mutate(
				'workers.approveEnrollment',
				{ enrollmentId: enrollment.id },
				parseWith(EnrollmentSchema),
			);
		}
		if (consent && !enrollment.sharingConsent) {
			enrollment = await client.mutate(
				'workers.setConsent',
				{ enrollmentId: enrollment.id, sharingConsent: true },
				parseWith(EnrollmentSchema),
			);
		}
		out.info(
			`enrolled worker '${worker.displayName}' (${worker.id}) in '${projectId}' — status ${enrollment.status}, CLIs ${enrollment.allowedClis.join(', ')}, concurrency ${enrollment.concurrencyAllocation}, sharing consent ${enrollment.sharingConsent ? 'on' : 'off'}`,
		);
		return { code: 0, enrollment };
	} catch (err) {
		if (!(err instanceof OperatorApiError)) throw err;
		out.error(err.message);
		if (enrollment) {
			out.info(
				`the enrollment was created — worker '${worker.displayName}' (${worker.id}) in '${projectId}': status ${enrollment.status}, sharing consent ${enrollment.sharingConsent ? 'on' : 'off'}. Do not enroll it again.`,
			);
			out.info(
				"it is routable only while active AND consenting — approving is a project administrator's call, consent the machine owner's own",
			);
		}
		return { code: 1, enrollment };
	}
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
 * inaccessible project is refused here, before the secret is asked for. The
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
 */
async function readOperatorCredential(
	providerId: string,
	displayName: string,
): Promise<string | undefined> {
	const secret = process.stdin.isTTY
		? await promptHidden(`Operator ${providerId} credential for '${displayName}': `)
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
