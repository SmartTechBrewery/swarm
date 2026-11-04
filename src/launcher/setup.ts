/**
 * `swarm-worker setup` — register this host as a profile-based worker for the
 * project checkout it is run in, with no SWARM clone (issue #1311).
 *
 * It ends with a worker that is registered, enrolled, credentialed, kept in its own
 * profile (`~/.swarm/workers/<id>/profile.json`), on a verified runtime, supervised
 * by launchd, and connected — or it says which of those it could not do and how to
 * finish. In order:
 *
 *   1. the control-plane URL (`--control-plane-url`), then the operator session: a
 *      live cached one for that URL is reused with no password asked; otherwise
 *      email + password sign in (`./operator-session.ts`), caching only the token;
 *   2. the project, picked from the projects the operator can access
 *      (`workers.enrollableProjects`) — auto-picked when there is only one;
 *   3. the agent CLIs (those on `PATH`, confirmable) and the worker's name;
 *   4. the operator's SCM token for the project's provider, typed without echo or
 *      read from `--scm-token-file`;
 *   5. registration, enrollment and the credential — `swarm workers setup
 *      --profile`'s own code (`executeRegisterAndEnroll`), so the refusals, the
 *      ordering and the recovery hints are that command's;
 *   6. the runtime prefetch: the installation's runtime is downloaded and verified
 *      now, so a verification refusal is reported here rather than in a launchd
 *      log. A refusal stops setup before anything is installed under launchd; a
 *      control plane that names no runtime yet is only a warning, since the
 *      launcher fetches it at start;
 *   7. the LaunchAgent (`swarm-worker-agent install --profile <id>`), then a wait of
 *      up to a minute for the control plane to see the worker connected.
 *
 * Every question has a flag, so it runs unattended; with no terminal a missing
 * answer fails naming its flag (`./operator-prompts.ts`).
 *
 * **Nothing here reads or writes a `.env`.** The URL is the flag's (or the
 * operator's typed answer), and it is passed explicitly to every step — never
 * resolved through `SWARM_CONTROL_PLANE_URL` or a checkout default — because the
 * daemon `swarm-worker run` starts reads its installation from the profile alone.
 *
 * **The password is never echoed, printed, logged, written or stored.** It is read,
 * sent in the sign-in request, and dropped. The SCM token is sent once, to
 * `workers.scmCredentials.set`. The worker credential is kept in the profile and
 * printed only when the profile could not be written (`executeRegisterAndEnroll`).
 *
 * A non-admin's enrollment still needs a project administrator's approval, as it
 * does everywhere else. Setup then installs and starts the worker anyway — it
 * connects, and takes work once approved — and says who has to approve it.
 */

import { hostname } from 'node:os';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { workerAgentCommand } from '../cli/_shared/installation-command.js';
import {
	OperatorApiError,
	type OperatorClient,
	type OperatorSession,
} from '../cli/_shared/operator-client.js';
import { normalizeControlPlaneUrl } from '../cli/_shared/operator-session-cache.js';
import * as out from '../cli/_shared/output.js';
import {
	installProfileWorkerAutostart,
	type WorkerAutostartResult,
} from '../cli/_shared/worker-autostart.js';
import {
	alreadyRegisteredHere,
	defaultWorkerName,
	executeRegisterAndEnroll,
	type Operator,
	type OperatorCredentialReader,
	operatorCredentialPrompt,
	parseClis,
	type RegisterAndEnrollPlan,
	type RegisteredAndEnrolled,
	refuseProfileServingCheckout,
	reportAutostart,
	reportProfileStart,
	resolveOperatorCredentialForProject,
} from '../cli/commands/workers.js';
import type { AgentCli } from '../harness/agent-cli.js';
import { resolveDeclarableOriginRepoSlug } from '../scm/repo-slug.js';
import { discoverAvailableClis } from '../transport/cli-discovery.js';
import { canonicalCheckoutPath } from '../worktree/checkout-key.js';
import { readTrustedPublicKey } from './main.js';
import {
	defaultPromptIo,
	missingAnswer,
	type PromptIo,
	refuseTwoStdinSources,
	resolveAnswer,
	resolveSecret,
} from './operator-prompts.js';
import { ensureSession, operatorClientFor } from './operator-session.js';
import { ensureRuntime, fetchRuntimeManifest } from './runtime-store.js';
import { listOwnWorkers } from './status.js';

export const SETUP_USAGE = `swarm-worker setup — register this checkout's host as a SWARM worker

Usage:
  swarm-worker setup [--control-plane-url <url>] [--email <email>]
                     [--password-file <path|->] [--project <id>] [--cli <c1,c2>]
                     [--name <name>] [--scm-token-file <path|->] [--no-autostart] [--yes]

Run it in the project checkout the worker is to serve. It signs you in (or reuses
your live session), lets you pick the project, registers and enrolls the worker,
stores your source-control token for the project's provider, installs and verifies
the installation's runtime, installs the LaunchAgent and waits for the worker to
connect. Its credential is kept in ~/.swarm/workers/<id>/profile.json.

  --control-plane-url <url>  The installation's router, e.g. https://swarm.example.com.
  --email <email>            The email you sign in with (alias: --identifier).
  --password-file <path|->   Read your SWARM password from a file, or from stdin (-).
  --project <id>             The project to enroll in; picked from yours otherwise.
  --cli <c1,c2>              The agent CLIs to declare; those on PATH otherwise.
  --name <name>              The worker's name; <you>_<host>_<repo> otherwise.
  --scm-token-file <path|->  Read your source-control token from a file, or stdin (-).
  --no-autostart             Register only; start it with swarm-worker run <id>.
  --yes, -y                  Accept the defaults instead of asking.

Passwords and tokens are typed without echo, or read from a file or stdin — never
taken as arguments. Only one of the two may be -. Your password is never printed,
logged or stored; only the session token is cached, under ~/.swarm/operator-sessions/.
With no terminal, every answer without a default must come from its flag.
An enrollment into a project you do not administer waits for a project
administrator's approval; the worker is started anyway, and takes work once approved.`;

/** How long setup waits for the control plane to see the new worker connected. */
export const CONNECT_TIMEOUT_MS = 60_000;
const CONNECT_POLL_MS = 2_000;

/** What prefetching the installation's runtime came to. */
export type RuntimePrefetch =
	| { kind: 'ready'; version: string; installed: boolean }
	| { kind: 'deferred'; reason: string }
	| { kind: 'refused'; error: string };

export interface PrefetchInput {
	controlPlaneUrl: string;
	/** The worker credential, sent to the control-plane origin only. */
	credential: string;
	fetch?: typeof globalThis.fetch;
	trustedPublicKey?: string;
	homeDir?: string;
}

/**
 * Install and verify the runtime the installation serves, exactly as
 * `swarm-worker run` would at start (`ensureRuntime`). A manifest that cannot be
 * fetched, or names no runtime, is `deferred` — the launcher asks again at every
 * start. A runtime that fails a check is `refused`, naming the check: the launcher
 * would refuse to start it too.
 */
export async function prefetchRuntime(input: PrefetchInput): Promise<RuntimePrefetch> {
	const manifest = await fetchRuntimeManifest(input.controlPlaneUrl, { fetch: input.fetch });
	if ('error' in manifest) return { kind: 'deferred', reason: manifest.error };
	if (!manifest.available) return { kind: 'deferred', reason: manifest.reason };
	const ensured = await ensureRuntime({
		controlPlaneUrl: input.controlPlaneUrl,
		manifest,
		bearer: input.credential,
		trustedPublicKey: input.trustedPublicKey,
		homeDir: input.homeDir,
		fetch: input.fetch,
	});
	if ('error' in ensured)
		return { kind: 'refused', error: `v${manifest.version}: ${ensured.error}` };
	return { kind: 'ready', version: ensured.version, installed: ensured.installed };
}

export interface SetupDeps {
	io?: PromptIo;
	/** For the sign-in, the runtime manifest and artifact, and the operator API. */
	fetch?: typeof globalThis.fetch;
	createClient?: (session: OperatorSession) => OperatorClient;
	discoverClis?: () => Promise<AgentCli[]>;
	prefetchRuntime?: (input: PrefetchInput) => Promise<RuntimePrefetch>;
	installAutostart?: (workerId: string) => Promise<WorkerAutostartResult>;
	/** `null` for none; omitted to read the launcher's own `minisign.pub`. */
	trustedPublicKey?: string | null;
	cwd?: string;
	hostname?: string;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
	connectTimeoutMs?: number;
	homeDir?: string;
}

function parseSetupArgs(argv: string[]) {
	return parseArgs({
		args: argv,
		options: {
			'control-plane-url': { type: 'string' },
			email: { type: 'string' },
			identifier: { type: 'string' },
			'password-file': { type: 'string' },
			project: { type: 'string' },
			cli: { type: 'string' },
			name: { type: 'string' },
			'scm-token-file': { type: 'string' },
			'no-autostart': { type: 'boolean' },
			yes: { type: 'boolean', short: 'y' },
			help: { type: 'boolean', short: 'h' },
		},
		allowPositionals: true,
	});
}
type SetupValues = ReturnType<typeof parseSetupArgs>['values'];

export async function runSetup(argv: string[], deps: SetupDeps = {}): Promise<number> {
	let parsed: ReturnType<typeof parseSetupArgs>;
	try {
		parsed = parseSetupArgs(argv);
	} catch (err) {
		out.error(`swarm-worker setup: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
	const { values, positionals } = parsed;
	if (values.help) {
		console.log(SETUP_USAGE);
		return 0;
	}
	if (positionals.length > 0) {
		out.error("swarm-worker setup takes no positional arguments — run it in the worker's checkout");
		return 1;
	}
	try {
		return await setUp(values, deps);
	} catch (err) {
		// Every control-plane refusal reaches the operator as its own one line.
		if (!(err instanceof OperatorApiError)) throw err;
		out.error(err.message);
		return 1;
	}
}

async function setUp(values: SetupValues, deps: SetupDeps): Promise<number> {
	const io = deps.io ?? defaultPromptIo();
	const signed = await signInHere(values, deps, io);
	if (typeof signed === 'number') return signed;
	const planned = await planWorker(values, deps, io, signed);
	if (typeof planned === 'number') return planned;

	const registered = await executeRegisterAndEnroll(signed.operator, planned, {
		allowPendingApproval: true,
	});
	if (!registered.ok) return registered.code;
	// No profile, nothing for the launcher to start from — the credential was printed.
	if (!registered.saved) return reportProfileStart(registered, undefined);

	if (!(await installRuntime(signed.controlPlaneUrl, registered, deps))) return 1;
	const code = await startWorker(signed, planned.displayName, registered, values, deps);
	reportPendingApproval(planned.projectId, registered.pending);
	return code;
}

/** What setup has once it knows the checkout, the installation and the operator. */
interface SignedIn {
	repoRoot: string;
	controlPlaneUrl: string;
	operator: Operator;
}

/**
 * The checkout, the installation and a live operator session — or an exit code with
 * the refusal printed. Every refusal here precedes any write but the session cache.
 */
async function signInHere(
	values: SetupValues,
	deps: SetupDeps,
	io: PromptIo,
): Promise<SignedIn | number> {
	const twoStdin = refuseTwoStdinSources('setup', {
		'--password-file': values['password-file'],
		'--scm-token-file': values['scm-token-file'],
	});
	if (twoStdin) return fail(twoStdin);
	if (values.email && values.identifier && values.email !== values.identifier)
		return fail('swarm-worker setup: --email and --identifier name the same thing — pass one');

	const repoRoot = canonicalCheckoutPath(deps.cwd ?? process.cwd());
	if (alreadyRegisteredHere('setup', repoRoot)) return 1;

	const url = await resolveControlPlaneUrl(io, values['control-plane-url']);
	if ('error' in url) return fail(url.error);
	const controlPlaneUrl = url.value;
	if (refuseProfileServingCheckout('setup', repoRoot, controlPlaneUrl)) return 1;

	const signed = await ensureSession({
		command: 'setup',
		controlPlaneUrl,
		email: values.email ?? values.identifier,
		passwordFile: values['password-file'],
		io,
		fetch: deps.fetch,
		homeDir: deps.homeDir,
		now: deps.now,
	});
	if ('error' in signed) return fail(signed.error);
	const { session } = signed;
	const client = (deps.createClient ?? ((s) => operatorClientFor(s, deps.fetch)))(session);
	return { repoRoot, controlPlaneUrl, operator: { client, session } };
}

/**
 * Everything `executeRegisterAndEnroll` is handed — the project, the CLIs, the name
 * and the operator's SCM token — or an exit code with the reason printed. Nothing
 * has been registered yet, so every refusal here leaves no worker behind.
 */
async function planWorker(
	values: SetupValues,
	deps: SetupDeps,
	io: PromptIo,
	{ repoRoot, controlPlaneUrl, operator }: SignedIn,
): Promise<RegisterAndEnrollPlan | number> {
	const yes = values.yes ?? false;
	const { identifier } = operator.session;
	const originSlug = await resolveDeclarableOriginRepoSlug(repoRoot);
	const repoName = (originSlug ?? repoRoot).split('/').pop() ?? '';

	const project = await pickProject(
		io,
		operator.client,
		controlPlaneUrl,
		values.project,
		repoName,
		yes,
	);
	if ('error' in project) return fail(project.error);
	const projectId = project.value;

	const capabilities = await resolveClis(io, values.cli, yes, deps);
	if (!capabilities) return 1;

	const name = await resolveAnswer(io, {
		command: 'setup',
		what: 'a worker name',
		flag: '--name <name>',
		value: values.name,
		question: 'Worker name',
		fallback: defaultWorkerName(identifier, deps.hostname ?? hostname(), repoName),
		acceptDefault: yes,
	});
	if ('error' in name) return fail(name.error);
	const displayName = name.value;
	out.info(
		`setting up worker '${displayName}' for '${identifier}' in project '${projectId}' (CLIs: ${capabilities.join(', ')}, checkout: ${repoRoot})`,
	);

	const readToken: OperatorCredentialReader = async (providerId, forName) => {
		const token = await resolveSecret(io, {
			command: 'setup',
			what: `your ${providerId} token`,
			flag: '--scm-token-file <path|->',
			source: values['scm-token-file'],
			prompt: operatorCredentialPrompt(providerId, forName),
		});
		if ('error' in token) {
			out.error(token.error);
			return undefined;
		}
		return token.value.trim();
	};
	const secret = await resolveOperatorCredentialForProject(
		operator,
		projectId,
		displayName,
		readToken,
	);
	if (!secret) return 1;
	return {
		identifier,
		projectId,
		displayName,
		capabilities,
		...secret,
		repoRoot,
		extraRepoRoots: [],
		profile: true,
	};
}

/**
 * Prefetch and verify the installation's runtime, reporting the outcome; answers
 * whether setup may go on. A refusal stops it before launchd is touched.
 */
async function installRuntime(
	controlPlaneUrl: string,
	registered: RegisteredAndEnrolled,
	deps: SetupDeps,
): Promise<boolean> {
	const trustedPublicKey =
		deps.trustedPublicKey === undefined
			? readTrustedPublicKey()
			: (deps.trustedPublicKey ?? undefined);
	const runtime = await (deps.prefetchRuntime ?? prefetchRuntime)({
		controlPlaneUrl,
		credential: registered.credential,
		fetch: deps.fetch,
		trustedPublicKey,
		homeDir: deps.homeDir,
	});
	if (runtime.kind === 'refused') {
		out.error(
			`swarm-worker setup: the installation's runtime was not installed — ${runtime.error}`,
		);
		out.info(
			`the worker is registered and its profile saved, but nothing was installed under launchd; fix the cause, then run: ${workerAgentCommand()} install --profile ${registered.workerId}`,
		);
		return false;
	}
	if (runtime.kind === 'deferred')
		out.warn(
			`could not fetch the installation's runtime yet (${runtime.reason}); the worker fetches it when it starts`,
		);
	else
		out.info(
			runtime.installed
				? `installed and verified runtime v${runtime.version}`
				: `runtime v${runtime.version} is already installed`,
		);
	return true;
}

/**
 * Install the LaunchAgent and wait for the worker to connect — or, with
 * `--no-autostart`, name the command that starts it — as an exit code.
 */
async function startWorker(
	{ controlPlaneUrl, operator }: SignedIn,
	displayName: string,
	registered: RegisteredAndEnrolled,
	values: SetupValues,
	deps: SetupDeps,
): Promise<number> {
	const { workerId } = registered;
	if (values['no-autostart'])
		return reportProfileStart(registered, 'autostart skipped (--no-autostart)');
	const autostart = await (deps.installAutostart ?? installProfileWorkerAutostart)(workerId);
	const code = reportAutostart(displayName, autostart, workerId);
	if (code !== 0 || autostart.kind !== 'installed') return code;

	if (await waitForConnection(operator.client, workerId, deps)) {
		out.info(`worker '${displayName}' (${workerId}) is connected to ${controlPlaneUrl}`);
		return 0;
	}
	const seconds = Math.round((deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS) / 1000);
	out.error(
		`swarm-worker setup: the worker is installed, but the control plane has not seen it connect within ${seconds}s`,
	);
	out.info(
		`  check it with: swarm-worker status ${workerId} (its log: ${workerAgentCommand()} logs --profile ${workerId})`,
	);
	return 1;
}

function fail(message: string): number {
	out.error(message);
	return 1;
}

/** `--control-plane-url`, else asked for on a terminal; validated as an http(s) URL. */
async function resolveControlPlaneUrl(
	io: PromptIo,
	flag: string | undefined,
): Promise<{ value: string } | { error: string }> {
	const answer = await resolveAnswer(io, {
		command: 'setup',
		what: "the installation's control-plane URL",
		flag: '--control-plane-url <url>',
		value: flag,
		question: 'Control-plane URL (e.g. https://swarm.example.com)',
	});
	if ('error' in answer) return answer;
	return validateControlPlaneUrl(answer.value);
}

/** An http(s) URL, normalised the way the session cache and the profile key on it. */
export function validateControlPlaneUrl(raw: string): { value: string } | { error: string } {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return { error: `'${raw}' is not a valid control-plane URL` };
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
		return { error: `the control-plane URL must be http(s), got '${raw}'` };
	return { value: normalizeControlPlaneUrl(raw) };
}

const EnrollableProjectsSchema = z.array(
	z.object({ id: z.string().min(1), name: z.string(), role: z.string().nullable().optional() }),
);
type EnrollableProject = z.infer<typeof EnrollableProjectsSchema>[number];

function describeProject(project: EnrollableProject): string {
	const role = project.role ? ` — ${project.role}` : '';
	return project.name && project.name !== project.id
		? `${project.name} (${project.id})${role}`
		: `${project.id}${role}`;
}

/**
 * The project to enroll in, from the projects the operator can access: `--project`
 * when it is one of them; the only one when there is one; otherwise a numbered
 * pick on a terminal, offering the project named like the checkout's repository
 * (which `--yes` accepts). With several and no terminal, `--project` is required.
 */
async function pickProject(
	io: PromptIo,
	client: OperatorClient,
	controlPlaneUrl: string,
	flag: string | undefined,
	repoName: string,
	yes: boolean,
): Promise<{ value: string } | { error: string }> {
	const projects = await client.query('workers.enrollableProjects', undefined, (value) =>
		EnrollableProjectsSchema.parse(value),
	);
	if (projects.length === 0)
		return {
			error: `swarm-worker setup: you are not a member of any project on ${controlPlaneUrl} — ask a project administrator to add you`,
		};
	const ids = projects.map((project) => project.id).join(', ');
	const wanted = flag?.trim();
	if (wanted) {
		if (projects.some((project) => project.id === wanted)) return { value: wanted };
		return {
			error: `swarm-worker setup: '${wanted}' is not a project you can enroll a worker into on ${controlPlaneUrl} — yours: ${ids}`,
		};
	}
	if (projects.length === 1) {
		out.info(`project: ${describeProject(projects[0])} — the only one you can enroll into`);
		return { value: projects[0].id };
	}
	const repo = repoName.toLowerCase();
	const suggested = projects.findIndex(
		(project) => project.id.toLowerCase() === repo || project.name.toLowerCase() === repo,
	);
	if (yes && suggested >= 0) {
		out.info(`project: ${describeProject(projects[suggested])}`);
		return { value: projects[suggested].id };
	}
	if (!io.isTTY)
		return { error: `${missingAnswer('setup', 'a project', '--project <id>')} — yours: ${ids}` };

	out.info('Projects you can enroll this worker into:');
	projects.forEach((project, index) => {
		out.info(`  ${index + 1}) ${describeProject(project)}`);
	});
	const hint = suggested >= 0 ? ` [${suggested + 1}]` : '';
	const answer = (await io.ask(`Project (1-${projects.length})${hint}: `)).trim();
	if (!answer && suggested >= 0) return { value: projects[suggested].id };
	const byNumber = /^\d+$/.test(answer) ? projects[Number(answer) - 1] : undefined;
	const chosen = byNumber ?? projects.find((project) => project.id === answer);
	if (!chosen)
		return { error: `swarm-worker setup: '${answer}' is not one of the projects listed` };
	return { value: chosen.id };
}

/**
 * `--cli` when given; otherwise the CLIs on this host's `PATH` — what the daemon
 * would itself declare — offered for confirmation on a terminal (and accepted as
 * they are with `--yes` or no terminal). `undefined` with the reason printed.
 */
async function resolveClis(
	io: PromptIo,
	flag: string | undefined,
	yes: boolean,
	deps: SetupDeps,
): Promise<AgentCli[] | undefined> {
	if (flag) return parseClis(flag);
	const discovered = await (deps.discoverClis ?? discoverAvailableClis)();
	if (discovered.length === 0) {
		out.error(
			'swarm-worker setup: none of the agent CLIs is on this host’s PATH — install and sign in to one, or name them with --cli',
		);
		return undefined;
	}
	if (yes || !io.isTTY) return discovered;
	const answer = (await io.ask(`Agent CLIs [${discovered.join(',')}]: `)).trim();
	return answer ? parseClis(answer) : discovered;
}

/**
 * Poll `workers.listMine` until the control plane sees the worker connected, for up
 * to {@link CONNECT_TIMEOUT_MS}. A refusal while polling is not the answer — the
 * worker may still connect — so it is retried until the time is up.
 */
async function waitForConnection(
	client: OperatorClient,
	workerId: string,
	deps: SetupDeps,
): Promise<boolean> {
	const now = deps.now ?? Date.now;
	const sleep =
		deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const deadline = now() + (deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
	out.info('waiting for the worker to connect…');
	for (;;) {
		try {
			const rows = await listOwnWorkers(client);
			if (rows.find((row) => row.workerId === workerId)?.connection === 'online') return true;
		} catch (err) {
			if (!(err instanceof OperatorApiError)) throw err;
		}
		if (now() >= deadline) return false;
		await sleep(CONNECT_POLL_MS);
	}
}

/** Say who still has to act before a pending enrollment takes work. */
function reportPendingApproval(projectId: string, pending: string[]): void {
	if (pending.length === 0) return;
	out.warn(
		`the worker takes no work in '${projectId}' until its enrollment is finished — approving it is a project administrator's call (the project's Workers tab, or):`,
	);
	for (const step of pending) out.warn(`  ${step}`);
}
