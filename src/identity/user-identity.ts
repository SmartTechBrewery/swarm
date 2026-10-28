/**
 * The link between a **SWARM user** and a handle they own on an external
 * provider — the single source of truth for the shape (ai/CODING_STANDARDS.md
 * "Zod is the source of truth"). A `SwarmUser` (`./schema.ts`) is deliberately
 * provider-neutral and knows nothing about GitHub; this is the one place that
 * says "the `jkwiecien` login on `github-projects` is *this* SWARM user".
 *
 * It exists so assignee-driven routing (ADR-001's execution-affinity rule,
 * issue #130) can ask "who is this work item assigned to, in SWARM terms?"
 * without pipeline code ever pattern-matching a GitHub identity shape
 * (ai/RULES.md §2). `provider` is a provider-neutral source key — a `PMType`
 * such as `github-projects` — so the same table serves a future Jira/Linear/SCM
 * provider without a schema change.
 *
 * Links are seeded by an operator (`swarm identities link`, or Settings → Users
 * in the dashboard since issue #1167); automatic linking
 * (OAuth, SCM account discovery) is a later concern, and ADR-001 open question 5
 * — an unlinked or ambiguous handle — is answered by construction: a
 * `(provider, handle)` pair maps to at most one SWARM user (the table's unique
 * index, `src/db/schema/userIdentities.ts`), and an unlinked handle resolves to
 * nothing rather than to a guess.
 */

import { z } from 'zod';

/**
 * Normalize a provider key or handle for storage and lookup: trimmed and
 * lowercased. Handles are case-insensitive on the providers SWARM speaks to (a
 * GitHub login, an email-shaped account id), so an operator who links `Ada` must
 * still match the `ada` a webhook-sourced work item reports — otherwise the link
 * silently fails to resolve and the item looks unassigned. Normalizing on both
 * write and read also makes the unique index case-insensitive, so the same
 * handle can't be linked to two users under different casing.
 */
export function normalizeIdentityKey(value: string): string {
	return value.trim().toLowerCase();
}

/**
 * One user ↔ provider-handle link. `userId` is a `users.id` (`uuid`); `id` is the
 * link row's own generated `uuid`. Unique per `(provider, handle)` — see
 * {@link normalizeIdentityKey} for the casing rule that unique index relies on.
 * A single SWARM user may hold many links (one per provider, and several handles
 * on the same provider).
 */
export const UserIdentitySchema = z.object({
	id: z.string().uuid(),
	userId: z.string().uuid(),
	/** Provider-neutral source key — a `PMType` (`src/pm/types.ts`) such as `github-projects`. */
	provider: z.string().min(1),
	/** The handle this SWARM user owns on that provider (a GitHub login, an account id). */
	handle: z.string().min(1),
	createdAt: z.date(),
});

export type UserIdentity = z.infer<typeof UserIdentitySchema>;

export const LinkIdentityInputSchema = UserIdentitySchema.pick({
	userId: true,
	provider: true,
	handle: true,
});

export type LinkIdentityInput = z.infer<typeof LinkIdentityInputSchema>;

/**
 * A `(provider, handle)` already linked to a *different* SWARM user — the one
 * refusal `linkIdentity` makes. Typed so the API can map it to `CONFLICT` and
 * name that user (issue #1167) without matching on message text; the message is
 * the one the CLI has always printed.
 */
export class IdentityLinkConflictError extends Error {
	readonly name = 'IdentityLinkConflictError';

	constructor(
		readonly provider: string,
		readonly handle: string,
		readonly existingUserId: string,
	) {
		super(
			`Handle '${handle}' on '${provider}' is already linked to another user (${existingUserId})`,
		);
	}
}
