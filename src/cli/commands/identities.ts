/**
 * `swarm identities` — the operator front-door onto SWARM identity linking
 * (#130 Phase 1): which provider handle (a GitHub login, a Jira accountId)
 * belongs to which SWARM user. Without it the link table is unreachable, since
 * automatic linking (OAuth / SCM account discovery) and a dashboard UI are both
 * out of scope — the same "make the model usable" role `swarm users` plays for
 * users and `swarm members` for membership.
 *
 * A thin file/CLI shell over `userIdentitiesRepository.ts` (`node:util`
 * `parseArgs` + `_shared/output.ts`, like `commands/members.ts`), resolving
 * users by their login handle so operators work in the identifiers they know
 * rather than raw uuids. The DB pool is closed in a `finally` (`closeDb()`).
 *
 * Subcommands:
 *   swarm identities link --user <identifier> --provider <p> --handle <h>
 *   swarm identities unlink --provider <p> --handle <h>
 *   swarm identities list [--user <identifier>]
 */

import { parseArgs } from 'node:util';
import { closeDb } from '../../db/client.js';
import {
	linkIdentity,
	listIdentities,
	listIdentitiesForUser,
	unlinkIdentity,
} from '../../db/repositories/userIdentitiesRepository.js';
import { findUserByIdentifier, getUserById } from '../../db/repositories/usersRepository.js';
import * as out from '../_shared/output.js';

const USAGE = `swarm identities — link a SWARM user to the handles they own on a provider

Usage:
  swarm identities link --user <identifier> --provider <provider> --handle <handle>
  swarm identities unlink --provider <provider> --handle <handle>
  swarm identities list [--user <identifier>]

  link     Link a provider handle (e.g. a GitHub login or a Jira accountId) to a
           SWARM user, looked up by login handle. Re-linking the same pair is a
           no-op; a handle already linked to a different user is rejected.
  unlink   Remove a handle's link.
  list     List links ('<identifier>\\t<provider>\\t<handle>' per line), all of
           them or just one user's.

<provider> is the project's PM type; <handle> is the id that provider reports
for an assignee:
  github-projects  the GitHub login
  jira             the Atlassian accountId — not the email or display name. Find
                   it in the profile URL (…/jira/people/<accountId>) or with
                   GET /rest/api/3/user/search?query=<email>
  linear           the display name
  trello           the member username

Provider and handle are matched case-insensitively. Requires DATABASE_URL. Links
are read by assignee resolution (src/identity/assignee-resolver.ts) to route an
assigned item to its assignee's own workers.`;

const SUBCOMMANDS = ['link', 'unlink', 'list'];

const OPTIONS = {
	user: { type: 'string' },
	provider: { type: 'string' },
	handle: { type: 'string' },
	help: { type: 'boolean', short: 'h' },
} as const;

async function link(argv: string[]): Promise<number> {
	const { values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
	if (values.help) {
		out.info(USAGE);
		return 0;
	}
	if (
		!values.user ||
		!values.provider ||
		!values.handle ||
		!values.provider.trim() ||
		!values.handle.trim()
	) {
		out.error(
			'identities link: --user, --provider and --handle are all required and cannot be empty or whitespace-only',
		);
		out.info(USAGE);
		return 1;
	}

	const user = await findUserByIdentifier(values.user);
	if (!user) {
		out.error(`no user with identifier '${values.user}'`);
		return 1;
	}

	const identity = await linkIdentity({
		userId: user.id,
		provider: values.provider,
		handle: values.handle,
	});
	out.info(`linked '${identity.handle}' on '${identity.provider}' to '${user.identifier}'`);
	return 0;
}

async function unlink(argv: string[]): Promise<number> {
	const { values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
	if (values.help) {
		out.info(USAGE);
		return 0;
	}
	if (!values.provider || !values.handle || !values.provider.trim() || !values.handle.trim()) {
		out.error(
			'identities unlink: --provider and --handle are required and cannot be empty or whitespace-only',
		);
		out.info(USAGE);
		return 1;
	}

	const removed = await unlinkIdentity(values.provider, values.handle);
	if (!removed) {
		out.error(`'${values.handle}' is not linked on '${values.provider}'`);
		return 1;
	}
	out.info(`unlinked '${values.handle}' on '${values.provider}'`);
	return 0;
}

async function list(argv: string[]): Promise<number> {
	const { values } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
	if (values.help) {
		out.info(USAGE);
		return 0;
	}

	let identities: Awaited<ReturnType<typeof listIdentities>>;
	if (values.user) {
		const user = await findUserByIdentifier(values.user);
		if (!user) {
			out.error(`no user with identifier '${values.user}'`);
			return 1;
		}
		identities = await listIdentitiesForUser(user.id);
	} else {
		identities = await listIdentities();
	}

	if (identities.length === 0) {
		out.info(values.user ? `no identities for '${values.user}'` : 'no identities');
		return 0;
	}
	for (const identity of identities) {
		const user = await getUserById(identity.userId);
		out.info(
			`${user ? user.identifier : identity.userId}\t${identity.provider}\t${identity.handle}`,
		);
	}
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
		out.error(`unknown identities subcommand '${subcommand}'`);
		out.info(USAGE);
		return 1;
	}

	try {
		switch (subcommand) {
			case 'link':
				return await link(rest);
			case 'unlink':
				return await unlink(rest);
			default:
				return await list(rest);
		}
	} finally {
		await closeDb();
	}
}
