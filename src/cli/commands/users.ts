/**
 * `swarm users` — the operator front-door onto the SWARM user identity model
 * (#281 task 1). Without a way to create the first user the model is inert, so
 * this ships the minimal operator command that makes it usable — the analogue of
 * `swarm config apply` being the front-door onto `applyConfig`.
 *
 * A thin file/CLI shell over `usersRepository.ts` (`node:util` `parseArgs` +
 * `_shared/output.ts`, like `commands/config.ts`). The one secret it handles is
 * the login password (`set-password`, #281 task 2): it is read without echoing
 * (`_shared/secret-input.ts`), hashed via `identity/auth.ts`, and never printed or
 * logged — only the scrypt hash reaches the DB. The DB pool is closed in a
 * `finally` (`closeDb()`).
 *
 * Subcommands:
 *   swarm users add <identifier> [--name <displayName>] [--admin]
 *   swarm users list
 *   swarm users grant-admin <identifier>
 *   swarm users revoke-admin <identifier>
 *   swarm users set-password <identifier>
 */

import { parseArgs } from 'node:util';
import { closeDb } from '../../db/client.js';
import {
	createUser,
	findUserByIdentifier,
	listUsers,
	setInstanceAdmin,
	setPasswordHash,
} from '../../db/repositories/usersRepository.js';
import { hashPassword } from '../../identity/auth.js';
import * as out from '../_shared/output.js';
import { promptHidden, readStdin } from '../_shared/secret-input.js';

const USAGE = `swarm users — manage SWARM users, credentials, and the installation admin

Usage:
  swarm users add <identifier> [--name <displayName>] [--admin]
  swarm users list
  swarm users grant-admin <identifier>
  swarm users revoke-admin <identifier>
  swarm users set-password <identifier>

  add            Create a user with the given login handle (username/email).
                 --name sets the display name (defaults to the identifier);
                 --admin designates the user an installation admin.
  list           List all users, one per line.
  grant-admin    Make an existing user an installation admin.
  revoke-admin   Remove a user's installation-admin role.
  set-password   Set a user's dashboard login password. Prompts (no echo) on a
                 TTY, otherwise reads the password from stdin. Never logs it.

Requires DATABASE_URL in the environment — run via a wrapper that loads .env, or
export it yourself first.`;

const SUBCOMMANDS = ['add', 'list', 'grant-admin', 'revoke-admin', 'set-password'];

/**
 * A duplicate `identifier` surfaces the pg `23505` unique violation, which
 * drizzle-orm wraps in a `DrizzleQueryError` whose original pg error (carrying
 * `code`) is on `.cause` — mirrors the check in `api/routers/projects.ts`.
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

async function addUser(argv: string[]): Promise<number> {
	const { values, positionals } = parseArgs({
		args: argv,
		options: {
			name: { type: 'string' },
			admin: { type: 'boolean' },
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
		out.error('users add: an <identifier> is required');
		out.info(USAGE);
		return 1;
	}

	try {
		const user = await createUser({
			identifier,
			displayName: values.name ?? identifier,
			instanceAdmin: values.admin ?? false,
		});
		out.info(`created user '${user.identifier}'${user.instanceAdmin ? ' (instance admin)' : ''}`);
		return 0;
	} catch (err) {
		if (isUniqueViolation(err)) {
			out.error(`a user with identifier '${identifier}' already exists`);
			return 1;
		}
		throw err;
	}
}

async function listAllUsers(): Promise<number> {
	const users = await listUsers();
	if (users.length === 0) {
		out.info('no users');
		return 0;
	}
	for (const user of users) {
		out.info(`${user.identifier}\t${user.displayName}${user.instanceAdmin ? '\t[admin]' : ''}`);
	}
	return 0;
}

async function setAdminFlag(argv: string[], value: boolean): Promise<number> {
	const { positionals } = parseArgs({ args: argv, allowPositionals: true });
	const identifier = positionals[0];
	if (!identifier) {
		out.error(`users ${value ? 'grant-admin' : 'revoke-admin'}: an <identifier> is required`);
		out.info(USAGE);
		return 1;
	}

	const existing = await findUserByIdentifier(identifier);
	if (!existing) {
		out.error(`no user with identifier '${identifier}'`);
		return 1;
	}

	await setInstanceAdmin(existing.id, value);
	out.info(`${value ? 'granted' : 'revoked'} instance admin for '${identifier}'`);
	return 0;
}

/**
 * Set a user's dashboard login password. The plaintext is read without echo (or
 * from a stdin pipe for scripting), hashed, and stored — it is never echoed,
 * logged, or included in output. On a TTY the password is asked for twice and
 * must match; a piped password is taken as-is.
 */
async function setPassword(argv: string[]): Promise<number> {
	const { positionals } = parseArgs({ args: argv, allowPositionals: true });
	const identifier = positionals[0];
	if (!identifier) {
		out.error('users set-password: an <identifier> is required');
		out.info(USAGE);
		return 1;
	}

	const existing = await findUserByIdentifier(identifier);
	if (!existing) {
		out.error(`no user with identifier '${identifier}'`);
		return 1;
	}

	let password: string;
	if (process.stdin.isTTY) {
		password = await promptHidden('Password: ');
		const confirm = await promptHidden('Confirm password: ');
		if (password !== confirm) {
			out.error('passwords do not match');
			return 1;
		}
	} else {
		password = await readStdin();
	}

	if (password.length === 0) {
		out.error('password must not be empty');
		return 1;
	}

	await setPasswordHash(existing.id, await hashPassword(password));
	out.info(`set password for '${identifier}'`);
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
		out.error(`unknown users subcommand '${subcommand}'`);
		out.info(USAGE);
		return 1;
	}

	try {
		switch (subcommand) {
			case 'add':
				return await addUser(rest);
			case 'list':
				return await listAllUsers();
			case 'grant-admin':
				return await setAdminFlag(rest, true);
			case 'revoke-admin':
				return await setAdminFlag(rest, false);
			default:
				return await setPassword(rest);
		}
	} finally {
		await closeDb();
	}
}
