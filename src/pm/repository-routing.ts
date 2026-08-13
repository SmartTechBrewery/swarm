/**
 * The 0/1/many verdict behind `PMProvider.resolveItemRepository` (`./types.ts`,
 * issue #686 phase 1), written once so the three token-routed providers — Jira,
 * Linear, Trello — share it instead of each re-deriving what "claimed by two
 * repositories" means.
 *
 * It is **pure and provider-blind**: it takes no project, no config and no provider
 * id, only the claim ids a card carries and the candidates those may match. That is
 * what keeps it out of ai/RULES.md §2's way — *which* ids a card carries stays each
 * provider's own read (a Jira component, a Linear label, a Trello label), and this
 * module never learns which one asked.
 *
 * GitHub Projects does not come through here at all: its cards claim nothing, the
 * backing Issue/PR's own repository is authoritative, and that comparison is a slug
 * match (`repoSlugsMatch`, `../scm/repo-slug.ts`) rather than a token match.
 */

import type { ItemRepositoryRoute, RepositoryRoutingCandidate } from './types.js';

/**
 * Which candidate repository a card's `claimTokenIds` route it to.
 *
 * Matching is **exact string equality**, deliberately: these are opaque
 * provider-native ids, not slugs, so neither `normalizeRepoSlug` nor a
 * case-insensitive compare may be applied to them — an id that differs only in case
 * is a different id.
 *
 * A candidate with no `routingToken` claims nothing, and two candidates that both
 * name the *same* repository still route to it rather than reading as ambiguous:
 * ambiguity is about repositories, not about tokens.
 */
export function routeByClaimTokens(
	claimTokenIds: readonly string[],
	candidates: readonly RepositoryRoutingCandidate[],
): ItemRepositoryRoute {
	const claimed = new Set(claimTokenIds);
	const repos = new Set<string>();
	for (const candidate of candidates) {
		if (candidate.routingToken === undefined) continue;
		if (claimed.has(candidate.routingToken)) repos.add(candidate.repo);
	}

	const [first, ...rest] = [...repos];
	if (first === undefined) return { status: 'unrouted' };
	if (rest.length === 0) return { status: 'routed', repo: first };
	return { status: 'ambiguous', repos: [first, ...rest].sort() };
}
