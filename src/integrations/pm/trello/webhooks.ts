/**
 * Trello board-webhook administration — the three API calls behind
 * `swarm pm webhook` (`src/cli/commands/pm.ts`, issue #589).
 *
 * A Trello webhook is a **resource SWARM has to create**, which is what separates
 * it from every other provider SWARM ingests: GitHub's repo/org hook, Linear's
 * signing-secret screen, and Jira's WebHooks screen are all configured once by a
 * human in a web UI, while a Trello subscription is a REST object bound to one
 * board (`idModel`) and one `callbackURL`, owned by the token that created it. So
 * registering one is an *operation*, and these are the calls it needs.
 *
 * Deliberately **not** on `PMProvider`: the contract is what the pipeline programs
 * against, and no phase, trigger, or worker may create a webhook — this is operator
 * provisioning, run once per board from the CLI. Keeping it here rather than in the
 * command also keeps the calls unit-testable without the CLI, and keeps Trello's
 * endpoint shapes inside the provider folder (ai/RULES.md §2).
 *
 * The token in the path is the **scoped credential's** (`./credentials.ts`), never
 * an argument: Trello scopes webhook administration to the token that owns the
 * subscriptions, so `GET /tokens/{token}/webhooks` lists exactly what this
 * project's own token created and nothing can be handed a different token to
 * administer. A token in a path is also why `./client.ts` masks that segment out of
 * a failed request's error message.
 */

import type { ProjectConfig } from '../../../config/schema.js';
import { getScopedTrelloCredentials, trelloRequest } from './client.js';
import { withTrelloProjectCredentials } from './credentials.js';

/** A registered Trello webhook, normalized from the API's own model. */
export interface TrelloWebhook {
	readonly id: string;
	/** The Trello object the subscription watches — a **board** id, for SWARM's. */
	readonly idModel: string;
	/** The URL Trello delivers to, and the URL it signs every delivery over. */
	readonly callbackURL: string;
	/** Free-text marker Trello shows beside the subscription; SWARM stamps its own. */
	readonly description: string;
	/** `false` once Trello has disabled the subscription after repeated failures. */
	readonly active: boolean;
}

/** The webhook model as Trello returns it — every field optional defensively. */
interface TrelloWebhookResponse {
	id?: string;
	idModel?: string | null;
	callbackURL?: string | null;
	description?: string | null;
	active?: boolean | null;
}

/**
 * The webhook collection of the token in scope. Read inside the credential scope
 * only — `getScopedTrelloCredentials` throws outside one, which is the point:
 * there is no way to spell this path for a token that isn't the project's.
 */
function tokenWebhooksPath(): string {
	return `tokens/${encodeURIComponent(getScopedTrelloCredentials().token)}/webhooks`;
}

/**
 * The `description` a webhook SWARM creates carries. A Trello webhook has no tags
 * or metadata beyond this one free-text field, so it is the only thing that tells
 * an operator which of a token's subscriptions is SWARM's — and it names the
 * project, since one Trello token can serve several boards.
 */
export function swarmWebhookDescription(project: ProjectConfig): string {
	return `SWARM board webhook (project ${project.id})`;
}

/** Normalize one API entry, dropping anything that isn't a usable webhook. */
function toWebhook(entry: TrelloWebhookResponse | null | undefined): TrelloWebhook | undefined {
	if (!entry?.id || !entry.idModel || !entry.callbackURL) return undefined;
	return {
		id: entry.id,
		idModel: entry.idModel,
		callbackURL: entry.callbackURL,
		description: entry.description ?? '',
		// Trello sets this `false` only on a subscription it has itself disabled after
		// repeated delivery failures, so an absent flag reads as active.
		active: entry.active ?? true,
	};
}

/**
 * Every webhook this project's Trello token owns — its own board's included, plus
 * any other board it was authorized for.
 *
 * Unpaged on purpose: this collection is a token's subscriptions, of which there
 * are a handful, and Trello answers it as one bare array with no cursor.
 */
export async function listTrelloWebhooks(project: ProjectConfig): Promise<TrelloWebhook[]> {
	const entries = await withTrelloProjectCredentials(project, () =>
		trelloRequest<Array<TrelloWebhookResponse | null> | undefined>(tokenWebhooksPath()),
	);
	return (entries ?? [])
		.map(toWebhook)
		.filter((webhook): webhook is TrelloWebhook => webhook !== undefined);
}

/**
 * Register a webhook delivering `idModel`'s actions to `callbackUrl`.
 *
 * Trello **confirms the subscription before creating it**: it sends a `HEAD`
 * request to the callback URL and fails the call unless that answers 200. So a
 * rejection here is usually about reachability rather than about the request, which
 * is what the caller's error message has to say.
 */
export async function createTrelloWebhook(
	project: ProjectConfig,
	{ idModel, callbackUrl }: { idModel: string; callbackUrl: string },
): Promise<TrelloWebhook> {
	const created = await withTrelloProjectCredentials(project, () =>
		trelloRequest<TrelloWebhookResponse | undefined>(tokenWebhooksPath(), {
			method: 'POST',
			body: {
				callbackURL: callbackUrl,
				idModel,
				description: swarmWebhookDescription(project),
			},
		}),
	);

	const webhook = toWebhook(created);
	if (!webhook) {
		throw new Error(
			`Trello accepted a webhook for board '${idModel}' but returned no webhook object — ` +
				'run `swarm pm webhook list` to check whether it was created',
		);
	}
	return webhook;
}

/** Delete one webhook by id. Trello answers with an empty body. */
export async function deleteTrelloWebhook(
	project: ProjectConfig,
	webhookId: string,
): Promise<void> {
	await withTrelloProjectCredentials(project, () =>
		trelloRequest<void>(`webhooks/${encodeURIComponent(webhookId)}`, { method: 'DELETE' }),
	);
}
