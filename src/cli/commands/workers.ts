/**
 * `swarm workers` — the operator front-door onto the registered-worker identity
 * model (#132 Phase 1) and its project enrollment (#337 Phase 3). It lets an
 * owner register the local machines they run agent CLIs on and declare which
 * CLIs each supports, then enroll a worker into a project and control its
 * sharing consent — before any dashboard worker UI exists. The worker-side
 * companion to `swarm users` (`commands/users.ts`) and `swarm members`
 * (`commands/members.ts`).
 *
 * A thin file/CLI shell over `identity/worker-service.ts` and
 * `identity/worker-enrollment-service.ts` (+ a couple of repository lookups),
 * using `node:util` `parseArgs` + `_shared/output.ts` like `commands/members.ts`,
 * resolving owners by their login handle so operators work in the identifiers
 * they know rather than raw uuids. The DB pool is closed in a `finally`
 * (`closeDb()`).
 *
 * The secrets it handles are both write-only. `register` prints the **worker
 * credential** exactly once with a "store it now" note (analogous to `swarm users
 * set-password` never echoing a stored secret), and it is never shown again;
 * `set-scm-credential` stores the **operator's own SCM credential** for this
 * machine (issue #765) read without echo, and prints no preview of it. No
 * subcommand prints a credential or its hash.
 *
 * Subcommands:
 *   swarm workers register <owner-identifier> --name <displayName> --cli <c1,c2,...>
 *   swarm workers list [<owner-identifier>]
 *   swarm workers set-cli <worker-id> --cli <c1,c2,...>
 *   swarm workers set-scm-credential <worker-id> <scm-provider-id>
 *   swarm workers remove <worker-id>
 *   swarm workers enroll <worker-id> <project-id> --cli <c1,c2,...> [--concurrency <n>] [--active] [--consent]
 *   swarm workers update-enrollment <worker-id> <project-id> [--cli <c1,c2,...>] [--concurrency <n>]
 *   swarm workers approve <worker-id> <project-id>
 *   swarm workers consent <worker-id> <project-id> <on|off>
 */

import { parseArgs } from 'node:util';
import { closeDb } from '../../db/client.js';
import { findProjectByIdFromDb } from '../../db/repositories/projectsRepository.js';
import { findUserByIdentifier, listUsers } from '../../db/repositories/usersRepository.js';
import { getEnrollment } from '../../db/repositories/workerEnrollmentsRepository.js';
import { writeWorkerScmCredential } from '../../db/repositories/workerScmCredentialsRepository.js';
import { removeWorker } from '../../db/repositories/workersRepository.js';
import { type AgentCli, AgentCliSchema } from '../../harness/agent-cli.js';
import type { Worker } from '../../identity/worker.js';
import {
	AllowedClisNotCapableError,
	approveEnrollment,
	EnrollmentRepositoryMismatchError,
	enrollWorker,
	setSharingConsent,
	updateEnrollmentConstraints,
} from '../../identity/worker-enrollment-service.js';
import {
	getWorker,
	listWorkersForOwner,
	refreshWorkerCapabilities,
	registerWorker,
	WorkerCapabilityReductionError,
} from '../../identity/worker-service.js';
import { SCM_TYPES, type ScmType } from '../../scm/types.js';
import * as out from '../_shared/output.js';
import { promptHidden, readStdin } from '../_shared/secret-input.js';

const AGENT_CLIS = AgentCliSchema.options;
/**
 * The provider ids `set-scm-credential` accepts. Taken from the closed value list
 * rather than the SCM registry so validity does not depend on which provider
 * modules this CLI process happened to import — the same reasoning
 * `ProjectConfigSchema` applies to `scm`.
 */
const SCM_PROVIDER_IDS = SCM_TYPES;

const USAGE = `swarm workers — register and manage local workers (identity + declared CLIs)

Usage:
  swarm workers register <owner-identifier> --name <displayName> --cli <c1,c2,...>
  swarm workers list [<owner-identifier>]
  swarm workers set-cli <worker-id> --cli <c1,c2,...>
  swarm workers set-scm-credential <worker-id> <scm-provider-id>
  swarm workers remove <worker-id>
  swarm workers enroll <worker-id> <project-id> --cli <c1,c2,...> [--concurrency <n>] [--active] [--consent]
  swarm workers update-enrollment <worker-id> <project-id> [--cli <c1,c2,...>] [--concurrency <n>]
  swarm workers approve <worker-id> <project-id>
  swarm workers consent <worker-id> <project-id> <on|off>

  register   Register a worker for an owner (by login handle) with a display
             name and declared CLIs (--cli, comma-separated, one or more of
             ${AGENT_CLIS.join(' | ')}). Prints a worker credential ONCE — store
             it then, it is never shown again.
  list       List workers ('<id>\\t<displayName>\\t<clis>' per line). With an
             owner identifier, only that owner's; without, all owners' (prefixed
             with the owner identifier). Never prints a credential or its hash.
  set-cli    Replace a worker's declared CLIs by worker id.
  set-scm-credential
             Store (or rotate) this worker's OPERATOR credential for one SCM
             provider (${SCM_PROVIDER_IDS.join(' | ')}) — the account every phase
             it runs against a project on that provider commits, pushes and
             comments as. Prompts (no echo) on a TTY, otherwise reads the secret
             from stdin; never takes it as an argument and never prints it back.
             Takes effect on the next dispatch — no worker restart.
  remove     Deregister a worker by worker id.
  enroll     Enroll a worker into a project with allowed CLIs (--cli, a subset of
             the worker's capabilities) and --concurrency, this worker's share of
             the project. Omit --concurrency for 1 (the default): one of the
             project's jobs at a time on this machine. A larger value lets the
             project run several jobs here at once, still bounded by the worker's
             own --concurrency launch flag (SWARM_WORKER_CONCURRENCY) and the
             project's Maximum Concurrent Jobs. Starts pending with sharing consent
             off; --active approves it and --consent grants sharing consent at once
             (operator seeding).
  update-enrollment
             Change an existing enrollment's execution constraints: --cli (a
             subset of the worker's capabilities) replaces the allowed CLIs and
             --concurrency replaces this worker's share of the project. At least
             one is required; an omitted flag leaves the stored value alone.
             Approval status and sharing consent are untouched (see approve /
             consent). Takes effect on the next dispatch — a running agent is
             never interrupted.
  approve    Approve a pending enrollment (worker + project) → active.
  consent    Turn an enrollment's owner-controlled sharing consent on or off.
             Revoking it blocks future dispatch without stopping a running agent.

Requires DATABASE_URL. A worker is a local execution environment owned by a
SWARM user; an enrollment offers it to a project, and it is routable only while
active AND sharing consent is on.`;

const SUBCOMMANDS = [
	'register',
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
 * A duplicate `(owner, displayName)` surfaces the pg `23505` unique violation,
 * which drizzle-orm wraps in an error whose original pg error (carrying `code`)
 * is on `.cause` — mirrors the check in `commands/members.ts`.
 */
function hasUniqueViolationCode(error: unknown): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { code: unknown }).code === '23505'
	);
}

function isUniqueViolation(error: unknown): boolean {
	return (
		hasUniqueViolationCode(error) || (error instanceof Error && hasUniqueViolationCode(error.cause))
	);
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

	const owner = await findUserByIdentifier(identifier);
	if (!owner) {
		out.error(`no user with identifier '${identifier}'`);
		return 1;
	}

	try {
		const { worker, credential } = await registerWorker({
			ownerUserId: owner.id,
			displayName: values.name,
			capabilities,
		});
		out.info(
			`registered worker '${worker.displayName}' for '${identifier}' (id ${worker.id}, CLIs: ${worker.capabilities.join(', ')})`,
		);
		out.info('worker credential (store it now — it will not be shown again):');
		out.info(credential);
		return 0;
	} catch (err) {
		if (isUniqueViolation(err)) {
			out.error(`a worker named '${values.name}' already exists for '${identifier}'`);
			return 1;
		}
		throw err;
	}
}

/** Print one worker line, optionally prefixed with its owner identifier. Never prints the credential. */
function printWorker(worker: Worker, ownerIdentifier?: string): void {
	const prefix = ownerIdentifier ? `${ownerIdentifier}\t` : '';
	out.info(`${prefix}${worker.id}\t${worker.displayName}\t${worker.capabilities.join(',')}`);
}

async function listWorkersCommand(argv: string[]): Promise<number> {
	const { positionals } = parseArgs({ args: argv, allowPositionals: true });
	const identifier = positionals[0];

	if (identifier) {
		const owner = await findUserByIdentifier(identifier);
		if (!owner) {
			out.error(`no user with identifier '${identifier}'`);
			return 1;
		}
		const workers = await listWorkersForOwner(owner.id);
		if (workers.length === 0) {
			out.info(`no workers for '${identifier}'`);
			return 0;
		}
		for (const worker of workers) printWorker(worker);
		return 0;
	}

	// No owner given: list every owner's workers, prefixed with the owner
	// identifier (resolved via listUsers, like `members list` resolves ids).
	const users = await listUsers();
	let printed = 0;
	for (const user of users) {
		const workers = await listWorkersForOwner(user.id);
		for (const worker of workers) {
			printWorker(worker, user.identifier);
			printed += 1;
		}
	}
	if (printed === 0) out.info('no workers');
	return 0;
}

async function setCliCommand(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		options: { cli: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
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
	if (!values.cli) {
		out.error('workers set-cli: --cli <c1,c2,...> is required');
		out.info(USAGE);
		return 1;
	}

	const capabilities = parseClis(values.cli);
	if (!capabilities) return 1;

	try {
		const updated = await refreshWorkerCapabilities(workerId, capabilities);
		if (!updated) {
			out.error(`no worker with id '${workerId}'`);
			return 1;
		}
		out.info(
			`set CLIs for worker '${updated.displayName}' (${workerId}) to ${updated.capabilities.join(', ')}`,
		);
		return 0;
	} catch (err) {
		if (err instanceof WorkerCapabilityReductionError) {
			out.error(err.message);
			return 1;
		}
		throw err;
	}
}

/**
 * Store (or rotate) a worker's operator SCM credential for one provider — the
 * write side of the per-`(worker, provider)` store the dispatcher resolves from
 * (`src/identity/worker-scm-credential.ts`, issue #765).
 *
 * Structural validation only: the provider id must be a known one and the worker
 * must exist (so an unknown id fails with a message rather than an FK violation),
 * and the secret must be non-empty. Verifying it actually authenticates against the
 * provider's API is phase 2/3's, with the dashboard form that pastes it.
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

	const worker = await getWorker(workerId);
	if (!worker) {
		out.error(`no worker with id '${workerId}'`);
		return 1;
	}

	// Read exactly as `users set-password` does — never from argv, where it would
	// land in the shell history and in `ps` output.
	const secret = process.stdin.isTTY
		? await promptHidden(`Operator ${providerId} credential for '${worker.displayName}': `)
		: await readStdin();
	const credential = secret.trim();
	if (credential.length === 0) {
		out.error('the credential must not be empty');
		return 1;
	}

	await writeWorkerScmCredential(workerId, providerId as ScmType, credential);
	out.info(
		`stored operator scm credential for worker '${worker.displayName}' (${workerId}) on provider '${providerId}'`,
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

	const removed = await removeWorker(workerId);
	if (!removed) {
		out.error(`no worker with id '${workerId}'`);
		return 1;
	}
	out.info(`removed worker '${workerId}'`);
	return 0;
}

/**
 * Resolve a worker + project the operator named by id, printing a friendly error
 * and returning `undefined` if either is missing — shared by the enrollment
 * subcommands.
 */
async function resolveWorkerAndProject(workerId: string, projectId: string) {
	const worker = await getWorker(workerId);
	if (!worker) {
		out.error(`no worker with id '${workerId}'`);
		return undefined;
	}
	const project = await findProjectByIdFromDb(projectId);
	if (!project) {
		out.error(`no project with id '${projectId}'`);
		return undefined;
	}
	return { worker };
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
 * Perform the enrollment write and report it, translating the three known
 * rejections to exit 1: allowed CLIs the machine does not declare, a project whose
 * repository is not the machine's checkout (issue #690), and a duplicate
 * enrollment. Each prints one actionable line — the two typed errors already name
 * what disagrees, so their message is printed as written rather than re-worded.
 */
async function performEnroll(
	worker: Worker,
	projectId: string,
	allowedClis: AgentCli[],
	concurrencyAllocation: number | undefined,
	active: boolean,
	consent: boolean,
): Promise<number> {
	try {
		const enrollment = await enrollWorker({
			worker,
			projectId,
			allowedClis,
			concurrencyAllocation,
			status: active ? 'active' : undefined,
			sharingConsent: consent,
		});
		out.info(
			`enrolled worker '${worker.displayName}' (${worker.id}) in '${projectId}' — status ${enrollment.status}, CLIs ${enrollment.allowedClis.join(', ')}, concurrency ${enrollment.concurrencyAllocation}, sharing consent ${enrollment.sharingConsent ? 'on' : 'off'}`,
		);
		return 0;
	} catch (err) {
		if (
			err instanceof AllowedClisNotCapableError ||
			err instanceof EnrollmentRepositoryMismatchError
		) {
			out.error(err.message);
			return 1;
		}
		if (isUniqueViolation(err)) {
			out.error(`worker '${worker.id}' is already enrolled in '${projectId}'`);
			return 1;
		}
		throw err;
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

	const resolved = await resolveWorkerAndProject(workerId, projectId);
	if (!resolved) return 1;

	return performEnroll(
		resolved.worker,
		projectId,
		allowedClis,
		concurrency.value,
		values.active ?? false,
		values.consent ?? false,
	);
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

	const resolved = await resolveWorkerAndProject(workerId, projectId);
	if (!resolved) return 1;

	const enrollment = await getEnrollment(workerId, projectId);
	if (!enrollment) {
		out.error(`no enrollment for worker '${workerId}' in '${projectId}'`);
		return 1;
	}

	try {
		const updated = await updateEnrollmentConstraints({
			worker: resolved.worker,
			enrollmentId: enrollment.id,
			allowedClis,
			concurrencyAllocation: concurrency.value,
		});
		if (!updated) {
			out.error(`no enrollment for worker '${workerId}' in '${projectId}'`);
			return 1;
		}
		out.info(
			`updated enrollment for worker '${resolved.worker.displayName}' (${workerId}) in '${projectId}' — CLIs ${updated.allowedClis.join(', ')}, concurrency ${updated.concurrencyAllocation}`,
		);
		return 0;
	} catch (err) {
		if (err instanceof AllowedClisNotCapableError) {
			out.error(err.message);
			return 1;
		}
		throw err;
	}
}

async function approveCommand(argv: string[]): Promise<number> {
	const { positionals } = parseArgs({ args: argv, allowPositionals: true });
	const [workerId, projectId] = positionals;
	if (!workerId || !projectId) {
		out.error('workers approve: <worker-id> and <project-id> are required');
		out.info(USAGE);
		return 1;
	}

	const enrollment = await getEnrollment(workerId, projectId);
	if (!enrollment) {
		out.error(`no enrollment for worker '${workerId}' in '${projectId}'`);
		return 1;
	}
	await approveEnrollment(enrollment.id);
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

	const enrollment = await getEnrollment(workerId, projectId);
	if (!enrollment) {
		out.error(`no enrollment for worker '${workerId}' in '${projectId}'`);
		return 1;
	}
	await setSharingConsent(enrollment.id, toggle === 'on');
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
	} finally {
		await closeDb();
	}
}
