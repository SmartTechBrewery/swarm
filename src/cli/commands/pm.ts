/**
 * `swarm pm webhook` — register, list, and delete a project's **Trello board
 * webhook** (issue #589), the last phase of the Trello provider (#492).
 *
 * **Why a command and not a `swarm config apply` step.** `config apply` is a local
 * file → Postgres loader (`./config.ts` → `src/config/apply.ts`) with no outbound
 * provider calls at all; making it create remote resources would give every seed
 * run a network dependency and a partial-failure mode (projects written, webhook
 * not). The operator CLI already owns the equivalent one-off provisioning verbs —
 * `swarm workers register`, `swarm identities link`, `swarm worktrees prune` — so
 * this belongs here, with the seam left obvious rather than hidden inside a
 * re-runnable loader.
 *
 * **Why Trello only.** Every other provider's webhook is configured by a human in
 * the provider's own UI (a GitHub repo/org hook, Linear's Settings → API screen,
 * Jira's WebHooks screen), so there is nothing for SWARM to create. A Trello
 * webhook is a REST resource bound to a board and a callback URL, so it has to be
 * created against the API — and this command is what makes that a supported
 * operation rather than a documented `curl`. A second provider needing the same
 * thing widens this command; the `pm.type === 'trello'` assertion stays where it
 * already lives (`requireTrelloConfig`), never a provider branch here
 * (ai/RULES.md §2).
 */

import { parseArgs } from 'node:util';
import type { ProjectConfig } from '../../config/schema.js';
import { closeDb } from '../../db/client.js';
import { findProjectByIdFromDb } from '../../db/repositories/projectsRepository.js';
// Side-effect import: registers every provider manifest, so the project loaded
// below validates its `credentials.pm` references against the roles its PM provider
// declares, and so those roles resolve at all (issue #497) — the same import
// `./config.ts` carries and for the same reason.
import '../../integrations/entrypoint.js';
import { requireTrelloConfig } from '../../integrations/pm/trello/config-schema.js';
import { trelloManifest } from '../../integrations/pm/trello/index.js';
import {
	createTrelloWebhook,
	deleteTrelloWebhook,
	listTrelloWebhooks,
} from '../../integrations/pm/trello/webhooks.js';
import { resolveWebhookCallbackBaseUrl } from '../../lib/env.js';
import * as out from '../_shared/output.js';

const USAGE = `swarm pm — operations on a project's project-management (board) provider

Usage:
  swarm pm webhook list --project <id>
  swarm pm webhook create --project <id>
  swarm pm webhook delete --project <id> --id <webhook-id>

  webhook list     List the webhooks this project's Trello token owns, with the
                   board and callback URL of each
  webhook create   Register the board webhook for this project's board and SWARM's
                   own callback URL. Idempotent: an identical subscription is
                   reported and left alone
  webhook delete   Delete one webhook by id (from 'webhook list')

Trello only. Every other provider's webhook is configured by a human in the
provider's own UI; a Trello webhook is a resource SWARM has to create against the
board, which is what this command does.

Requires DATABASE_URL (the project's config and credentials) and
WEBHOOK_CALLBACK_BASE_URL (SWARM's public base URL). The second is not optional
here: Trello signs every delivery over the raw body plus the exact callback URL the
webhook was registered with, so a webhook created against a request-derived URL
would 401 on every delivery. Changing that base URL later means 'webhook delete'
then 'webhook create' — SWARM never rewrites a subscription in place.`;

type WebhookAction = 'list' | 'create' | 'delete';

const WEBHOOK_ACTIONS: readonly WebhookAction[] = ['list', 'create', 'delete'];

const HELP_ARGS = ['--help', '-h', 'help'];

function isWebhookAction(value: string): value is WebhookAction {
	return (WEBHOOK_ACTIONS as readonly string[]).includes(value);
}

const OPTIONS = {
	project: { type: 'string' },
	id: { type: 'string' },
	help: { type: 'boolean', short: 'h' },
} as const;

/** Everything a subcommand needs, resolved once: the project, its board, our callback URL. */
interface WebhookTarget {
	readonly project: ProjectConfig;
	readonly boardId: string;
	readonly callbackUrl: string;
}

/**
 * Load the project, narrow it to Trello, and build the callback URL a webhook must
 * be registered with. Prints the reason and answers `undefined` when any of the
 * three is unavailable — every one of them is operator-fixable config.
 */
async function resolveTarget(projectId: string): Promise<WebhookTarget | undefined> {
	const project = await findProjectByIdFromDb(projectId);
	if (!project) {
		out.error(`no project with id '${projectId}'`);
		return undefined;
	}

	let boardId: string;
	try {
		boardId = requireTrelloConfig(project).boardId;
	} catch (err) {
		out.error(
			`webhook registration is only supported for Trello: ${err instanceof Error ? err.message : String(err)}`,
		);
		return undefined;
	}

	const baseUrl = resolveWebhookCallbackBaseUrl();
	if (!baseUrl) {
		out.error(
			"WEBHOOK_CALLBACK_BASE_URL is not set. Trello signs every delivery over the raw body plus the exact callback URL the webhook was registered with, so a webhook created against a request-derived URL would 401 on every delivery. Set it to SWARM's public base URL (e.g. https://swarm.example.com — the same one the tunnel serves) and re-run.",
		);
		return undefined;
	}

	// The route comes from the manifest rather than a literal: the receiver mounts
	// exactly that path, so the subscription and the served route cannot drift apart.
	return { project, boardId, callbackUrl: `${baseUrl}${trelloManifest.webhookRoute}` };
}

/** Whether this subscription is the one `create` would register for this project. */
function isProjectWebhook(
	webhook: { idModel: string; callbackURL: string },
	target: WebhookTarget,
): boolean {
	return webhook.idModel === target.boardId && webhook.callbackURL === target.callbackUrl;
}

async function listWebhooks(target: WebhookTarget): Promise<number> {
	const webhooks = await listTrelloWebhooks(target.project);
	if (webhooks.length === 0) {
		out.info("no webhooks registered on this project's Trello token");
		out.info(`expected callback URL for this project: ${target.callbackUrl}`);
		return 0;
	}

	out.info(`${webhooks.length} webhook(s) on this project's Trello token:`);
	for (const webhook of webhooks) {
		const notes = [
			isProjectWebhook(webhook, target) ? "this project's board webhook" : undefined,
			webhook.active ? undefined : 'inactive',
		].filter((note): note is string => note !== undefined);
		out.info(
			`  ${webhook.id}\tboard ${webhook.idModel}\t${webhook.callbackURL}${
				notes.length > 0 ? `\t(${notes.join(', ')})` : ''
			}`,
		);
	}
	return 0;
}

async function createWebhook(target: WebhookTarget): Promise<number> {
	out.step(`registering board ${target.boardId} at ${target.callbackUrl}…`);

	// Idempotent by lookup rather than by a Trello guarantee: Trello happily creates a
	// second identical subscription, which would double every delivery.
	const existing = (await listTrelloWebhooks(target.project)).find((webhook) =>
		isProjectWebhook(webhook, target),
	);
	if (existing) {
		out.info(`already registered as ${existing.id} — leaving it alone`);
		if (!existing.active) {
			out.warn(
				'Trello reports this webhook as inactive, which it does after repeated delivery failures — delete and re-create it once the router is reachable at that URL',
			);
		}
		return 0;
	}

	try {
		const created = await createTrelloWebhook(target.project, {
			idModel: target.boardId,
			callbackUrl: target.callbackUrl,
		});
		out.info(`created webhook ${created.id}`);
		return 0;
	} catch (err) {
		out.error(
			`Trello refused to create the webhook: ${err instanceof Error ? err.message : String(err)}`,
		);
		// Almost always reachability rather than the request: Trello confirms a
		// subscription with a HEAD probe before it will create it, so name that first.
		out.error(
			`Trello sends a HEAD request to the callback URL before accepting a webhook — confirm the router is publicly reachable at ${target.callbackUrl} (tunnel up, router running, that URL answering 200).`,
		);
		return 1;
	}
}

async function deleteWebhook(target: WebhookTarget, webhookId: string): Promise<number> {
	out.step(`deleting webhook ${webhookId}…`);
	await deleteTrelloWebhook(target.project, webhookId);
	out.info(`deleted webhook ${webhookId}`);
	return 0;
}

/**
 * A validated invocation, or the exit code to answer with when the arguments alone
 * decide the outcome (usage, an unknown action, a missing flag) — so nothing that
 * can be settled from argv opens a database connection.
 */
type Invocation =
	| { readonly exit: number }
	| { readonly action: 'list' | 'create'; readonly projectId: string }
	| { readonly action: 'delete'; readonly projectId: string; readonly webhookId: string };

/** The subcommand + action half of {@link parseInvocation}: everything before the flags. */
function parseAction(
	argv: string[],
): { readonly exit: number } | { readonly action: WebhookAction; readonly args: string[] } {
	const [subcommand, ...rest] = argv;

	if (!subcommand || HELP_ARGS.includes(subcommand)) {
		out.info(USAGE);
		// No subcommand is a usage error; an explicit --help is not.
		return { exit: subcommand ? 0 : 1 };
	}
	if (subcommand !== 'webhook') {
		out.error(`unknown pm subcommand '${subcommand}'`);
		out.info(USAGE);
		return { exit: 1 };
	}

	const [action, ...args] = rest;
	if (action && HELP_ARGS.includes(action)) {
		out.info(USAGE);
		return { exit: 0 };
	}
	if (!action || !isWebhookAction(action)) {
		out.error(
			action ? `unknown pm webhook action '${action}'` : 'pm webhook: an action is required',
		);
		out.info(USAGE);
		return { exit: 1 };
	}
	return { action, args };
}

function parseInvocation(argv: string[]): Invocation {
	const parsed = parseAction(argv);
	if ('exit' in parsed) return parsed;
	const { action } = parsed;

	const { values } = parseArgs({ args: parsed.args, options: OPTIONS, allowPositionals: true });
	if (values.help) {
		out.info(USAGE);
		return { exit: 0 };
	}

	const projectId = values.project?.trim();
	if (!projectId) {
		out.error(`pm webhook ${action}: --project <id> is required`);
		out.info(USAGE);
		return { exit: 1 };
	}

	if (action === 'delete') {
		const webhookId = values.id?.trim();
		if (!webhookId) {
			out.error(
				'pm webhook delete: --id <webhook-id> is required — run `swarm pm webhook list` to find it',
			);
			out.info(USAGE);
			return { exit: 1 };
		}
		return { action, projectId, webhookId };
	}
	return { action, projectId };
}

export async function run(argv: string[]): Promise<number> {
	const invocation = parseInvocation(argv);
	if ('exit' in invocation) return invocation.exit;

	try {
		const target = await resolveTarget(invocation.projectId);
		if (!target) return 1;

		switch (invocation.action) {
			case 'create':
				return await createWebhook(target);
			case 'delete':
				return await deleteWebhook(target, invocation.webhookId);
			default:
				return await listWebhooks(target);
		}
	} catch (err) {
		out.error(
			`pm webhook ${invocation.action} failed: ${err instanceof Error ? err.message : String(err)}`,
		);
		return 1;
	} finally {
		await closeDb();
	}
}
