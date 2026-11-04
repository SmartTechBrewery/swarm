/**
 * `swarm-worker login` — renew this host's operator session for an installation
 * (issue #1311), the launcher package's twin of `swarm login` with no SWARM clone.
 *
 * The URL defaults to the installation this host's profiles serve when they all
 * serve one, so on a host set up with `swarm-worker setup` a bare `swarm-worker
 * login` is enough. The email defaults to the identifier this host last signed in
 * as there. It always signs in afresh — that is what it is for — and, like
 * `swarm login`, caches only the session token (`700`/`600`), never the password,
 * and reads or writes no `.env`.
 */

import { parseArgs } from 'node:util';
import type { SignInFetch } from '../cli/_shared/operator-sign-in.js';
import * as out from '../cli/_shared/output.js';
import { defaultPromptIo, type PromptIo, resolveAnswer } from './operator-prompts.js';
import { ensureSession } from './operator-session.js';
import { validateControlPlaneUrl } from './setup.js';
import { listWorkerProfiles } from './worker-profile.js';

export const LOGIN_USAGE = `swarm-worker login — renew your session on a SWARM installation

Usage:
  swarm-worker login [--control-plane-url <url>] [--email <email>] [--password-file <path|->]

  --control-plane-url <url>  The installation to sign in to. Defaults to the one this
                             host's worker profiles serve, when they serve only one.
  --email <email>            The email you sign in with (alias: --identifier).
                             Defaults to the one you last signed in there as.
  --password-file <path|->   Read your password from a file, or from stdin (-).

The password is typed without echo, or read from a file or stdin — never taken as
an argument, printed, logged or stored. Only the session token is cached, under
~/.swarm/operator-sessions/ at 700/600.`;

export interface LoginDeps {
	io?: PromptIo;
	fetch?: SignInFetch;
	homeDir?: string;
	now?: () => number;
}

export async function runLogin(argv: string[], deps: LoginDeps = {}): Promise<number> {
	let values: ReturnType<typeof parseLoginArgs>['values'];
	try {
		({ values } = parseLoginArgs(argv));
	} catch (err) {
		out.error(`swarm-worker login: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	}
	if (values.help) {
		console.log(LOGIN_USAGE);
		return 0;
	}
	const io = deps.io ?? defaultPromptIo();

	const url = await resolveAnswer(io, {
		command: 'login',
		what: "the installation's control-plane URL",
		flag: '--control-plane-url <url>',
		value: values['control-plane-url'],
		question: 'Control-plane URL (e.g. https://swarm.example.com)',
		fallback: profilesInstallation(deps.homeDir),
		acceptDefault: true,
	});
	if ('error' in url) {
		out.error(url.error);
		return 1;
	}
	const controlPlaneUrl = validateControlPlaneUrl(url.value);
	if ('error' in controlPlaneUrl) {
		out.error(controlPlaneUrl.error);
		return 1;
	}

	const signed = await ensureSession({
		command: 'login',
		controlPlaneUrl: controlPlaneUrl.value,
		email: values.email ?? values.identifier,
		passwordFile: values['password-file'],
		renew: true,
		io,
		fetch: deps.fetch,
		homeDir: deps.homeDir,
		now: deps.now,
	});
	if ('error' in signed) {
		out.error(signed.error);
		return 1;
	}
	return 0;
}

/** The installation every readable profile on this host serves, when there is exactly one. */
function profilesInstallation(homeDir?: string): string | undefined {
	const urls = new Set(
		listWorkerProfiles(homeDir).flatMap(({ profile }) =>
			profile ? [profile.controlPlaneUrl] : [],
		),
	);
	return urls.size === 1 ? [...urls][0] : undefined;
}

function parseLoginArgs(argv: string[]) {
	return parseArgs({
		args: argv,
		options: {
			'control-plane-url': { type: 'string' },
			email: { type: 'string' },
			identifier: { type: 'string' },
			'password-file': { type: 'string' },
			help: { type: 'boolean', short: 'h' },
		},
		allowPositionals: false,
	});
}
