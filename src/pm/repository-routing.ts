/**
 * Both sides of `PMProvider.resolveItemRepository` (`./types.ts`, issue #686): the
 * 0/1/many verdict a provider answers **with** (phase 1) and the call ingress
 * reaches it **through** (phase 2).
 *
 * {@link routeByClaimTokens} is written once so the three token-routed providers —
 * Jira, Linear, Trello — share it instead of each re-deriving what "claimed by two
 * repositories" means. It is **pure and provider-blind**: it takes no project, no
 * config and no provider id, only the claim ids a card carries and the candidates
 * those may match. That is what keeps it out of ai/RULES.md §2's way — *which* ids a
 * card carries stays each provider's own read (a Jira component, a Linear label, a
 * Trello label), and this module never learns which one asked. {@link
 * routeByRepositoryValue} is its twin for a card that names its repository in plain
 * text instead (issue #1237), equally blind to which provider read the value.
 *
 * {@link repositoryRoutingCandidates} and {@link resolveCardRepository} are the
 * caller's half, equally provider-blind: they name no provider either, taking the
 * `ProjectRecord` (the only shape holding the repository list) and a factory for
 * whichever provider the project runs on.
 *
 * GitHub Projects does not come through the matcher at all: its cards claim nothing,
 * the backing Issue/PR's own repository is authoritative, and that comparison is a
 * slug match (`repoSlugsMatch`, `../scm/repo-slug.ts`) rather than a token match. It
 * is routed through {@link resolveCardRepository} like every other provider.
 */

import type { ProjectRecord } from '../config/schema.js';
import type {
	ItemRepositoryRoute,
	PMProvider,
	RepositoryClaim,
	RepositoryRoutingCandidate,
} from './types.js';

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

/**
 * Which candidate repository a card's own repository value routes it to (issue
 * #1237) — the path for a board whose card *names* its repository, as a Jira text
 * field holding `organization/project/repository` does, rather than carrying an id
 * a repository entry declares.
 *
 * The value is matched against each candidate's `repo` itself, so no entry needs a
 * `routingToken` and a repository added to the project routes the moment it is in
 * the list. Matching is **exact** on the whole slug once surrounding whitespace is
 * trimmed: the value is the repository's own path in the form `repo` states it, so
 * a bare repository name, another casing, or a URL names nothing — the refusal
 * that follows says what was read, which is cheaper to fix than a fuzzy match that
 * picks the wrong repository.
 *
 * Never `ambiguous`: one value can equal at most one repository. A blank value or
 * one naming no candidate is `unrouted`, carrying the trimmed claim so the caller
 * can show the card what it said.
 */
export function routeByRepositoryValue(
	claim: RepositoryClaim,
	candidates: readonly RepositoryRoutingCandidate[],
): ItemRepositoryRoute {
	const value = claim.value.trim();
	const match = value ? candidates.find((candidate) => candidate.repo === value) : undefined;
	if (match) return { status: 'routed', repo: match.repo };
	return { status: 'unrouted', claim: { source: claim.source, value } };
}

/**
 * The project's repositories as routing candidates — the list a caller hands
 * {@link PMProvider.resolveItemRepository}, built from the `ProjectRecord` because
 * that is the only shape carrying the list at all
 * (`scopeProjectToRepository`, `../config/project-repository.ts`).
 *
 * An entry declaring no `pmRoutingToken` still travels: a provider needs to know the
 * repository exists to report it in an `ambiguous` answer, and {@link
 * routeByClaimTokens} already treats a tokenless candidate as claiming nothing.
 */
export function repositoryRoutingCandidates(record: ProjectRecord): RepositoryRoutingCandidate[] {
	return record.repositories.map((entry) => ({
		repo: entry.repo,
		...(entry.pmRoutingToken === undefined ? {} : { routingToken: entry.pmRoutingToken }),
	}));
}

/**
 * Which of the project's repositories a board card runs against (issue #686 phase 2)
 * — the routing call ingress makes before it enqueues a `pm` job.
 *
 * A project owning exactly **one** repository short-circuits to it and the provider
 * is never even built: that is arithmetic, not a provider decision — with one
 * repository there is nothing to choose — and it is what keeps every existing
 * single-repository project running (and paying no board read at all) without
 * declaring a routing token. Hence the *factory* rather than a built provider: a
 * caller cannot accidentally pay for the provider it turns out not to need.
 *
 * A throw from the provider surfaces to the caller rather than degrading to the
 * default entry. Routing a card to a repository nobody claimed it for would push a
 * branch and open a pull request there, so an *unknown* answer must stop the
 * dispatch exactly as {@link ItemRepositoryRoute}'s two refusals do — the caller
 * retries the delivery instead.
 */
export async function resolveCardRepository(
	record: ProjectRecord,
	createProvider: () => PMProvider,
	itemId: string,
): Promise<ItemRepositoryRoute> {
	const candidates = repositoryRoutingCandidates(record);
	const [only] = candidates;
	if (only && candidates.length === 1) return { status: 'routed', repo: only.repo };
	return createProvider().resolveItemRepository(itemId, candidates);
}
