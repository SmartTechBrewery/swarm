/**
 * Which repositories this worker daemon holds a checkout of, and which checkout a
 * given assignment runs in (issue #1058).
 *
 * `SWARM_WORKER_REPO_ROOT` names one or more checkout paths (`../lib/env.ts`
 * `resolveWorkerRepoRoots`), and this module is the step between those host-local
 * paths and the only thing that travels: the `owner/repo` slug each one actually
 * is, read from its `origin` remote (`../scm/repo-slug.ts`, issue #687). Keeping
 * that here rather than in `./worker-main.ts` is what makes the two refusals below
 * testable without a daemon, a socket, or a real git checkout — the slug resolver
 * is injected.
 *
 * **Two refusals, both at startup.** A set of checkouts is only usable if each
 * member can be told apart from the others, so:
 *
 * - two checkouts resolving to the **same** repository are refused — nothing could
 *   choose between them, and an operator who pointed a daemon at one checkout twice
 *   (through two spellings `resolve` cannot collapse) meant to name two;
 * - with **more than one** checkout, one that cannot be identified is refused —
 *   with several there is no other way to pick one, so accepting it would mean
 *   routing assignments to a checkout nobody can name.
 *
 * A **single** unidentifiable checkout is deliberately not refused. That is today's
 * behaviour and it stays: the daemon declares nothing, the control plane skips
 * nothing on its behalf, and `assertRepoIdentity` (`../worker/git-worktree-manager.ts`)
 * remains its guard at provision time. A daemon on a machine whose checkout has no
 * `origin` must still be able to start.
 */

import { repoSlugsMatch, resolveDeclarableOriginRepoSlug } from '../scm/repo-slug.js';

/** One checkout this daemon holds: its host-local path, and the repository it is. */
export interface WorkerCheckout {
	/** Absolute path on this host. Never on the wire. */
	repoRoot: string;
	/**
	 * The `owner/repo` its `origin` resolves to, or `undefined` when it could not be
	 * identified — which only one checkout, holding the whole daemon, may be.
	 */
	repository?: string;
}

/**
 * A `SWARM_WORKER_REPO_ROOT` the daemon cannot serve. Carried as its own class so
 * `./worker-main.ts` can tell an operator's configuration mistake (log the reason,
 * exit 1) apart from an unexpected throw.
 */
export class WorkerCheckoutConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'WorkerCheckoutConfigError';
	}
}

/**
 * Resolve each checkout root to the repository it is, refusing the two sets no
 * daemon could route on (see the module header).
 *
 * `resolveSlug` is the `origin` read, injected only so tests need no git checkout.
 * Roots are resolved in order and the result keeps it: the first is the primary
 * one, which is what the handshake declares as `repository` for a control plane
 * predating the set.
 */
export async function resolveWorkerCheckouts(
	roots: readonly string[],
	resolveSlug: (repoRoot: string) => Promise<string | undefined> = resolveDeclarableOriginRepoSlug,
): Promise<WorkerCheckout[]> {
	const checkouts: WorkerCheckout[] = [];
	for (const repoRoot of roots) {
		const repository = await resolveSlug(repoRoot);
		if (repository === undefined && roots.length > 1) {
			throw new WorkerCheckoutConfigError(
				`the checkout at ${repoRoot} has no identifiable 'origin' remote, so it cannot be ` +
					'told apart from the other checkouts this worker was given. Give every checkout an ' +
					'`origin`, or point SWARM_WORKER_REPO_ROOT at a single checkout.',
			);
		}
		const clash = checkouts.find(
			(held) => held.repository && repository && repoSlugsMatch(held.repository, repository),
		);
		if (clash) {
			throw new WorkerCheckoutConfigError(
				`two checkouts given to this worker are both '${repository}' (${clash.repoRoot} and ` +
					`${repoRoot}). A worker holds at most one checkout per repository — drop one of them ` +
					'from SWARM_WORKER_REPO_ROOT.',
			);
		}
		checkouts.push(repository === undefined ? { repoRoot } : { repoRoot, repository });
	}
	return checkouts;
}

/**
 * The repositories these checkouts declare at handshake, primary first — the
 * `repositories` set (issue #1056). Empty when the daemon holds its one
 * unidentifiable checkout, in which case the handshake omits the key entirely.
 */
export function declaredRepositories(checkouts: readonly WorkerCheckout[]): string[] {
	return checkouts.flatMap((checkout) => (checkout.repository ? [checkout.repository] : []));
}

/**
 * The checkout an assignment for `assignedRepository` runs in, or `undefined` when
 * this worker holds none (issue #1058).
 *
 * The match is {@link repoSlugsMatch}, so a host's own casing and a trailing `.git`
 * are noise rather than a different repository. Failing that, a daemon holding
 * exactly one checkout it could not identify runs the assignment there — today's
 * behaviour for an undeclared checkout, where `assertRepoIdentity` is the backstop.
 * With several checkouts that fallback would be a guess, so there is none.
 */
export function selectCheckout(
	checkouts: readonly WorkerCheckout[],
	assignedRepository: string,
): WorkerCheckout | undefined {
	const match = checkouts.find(
		(checkout) => checkout.repository && repoSlugsMatch(checkout.repository, assignedRepository),
	);
	if (match) return match;
	const [only] = checkouts;
	return checkouts.length === 1 && only && !only.repository ? only : undefined;
}
