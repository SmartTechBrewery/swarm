/**
 * An operator-token GitHub `ScmDeliveryProvider` — the DB-free counterpart of
 * `GitHubSCMIntegration.deliveryProvider` (`./scm-integration.ts`).
 *
 * The same-host delivery provider resolves a persona token from the secret store
 * (`getPersonaToken`) and scopes every GitHub call to it. A remote worker
 * (`../../../transport/connect-entry.ts`) has no secret store and no persona
 * references — it carries only the operator's own GitHub token
 * (`SWARM_OPERATOR_GH_TOKEN`, `../../../lib/env.ts`). This builds the identical
 * source-carrying delivery surface (commit identity, PR lookup/creation, push,
 * comment) sourced from that single token instead, per RULES §2 (GitHub
 * specifics stay under `src/integrations/scm/github/`).
 *
 * `submitReview` is intentionally unavailable: a reviewer verdict is a metadata
 * write the server owns (the Phase-2 delivery API), never something a worker
 * performs under the operator's implementer identity. The Phase-1 source-only
 * phases (`respond-to-ci`, `resolve-conflicts`) never call it.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ScmDeliveryProvider } from '../../../scm/delivery.js';
import {
	createPullRequest,
	findOpenPullRequest,
	getGitHubUserForToken,
	postIdempotentPullRequestComment,
	withGitHubToken,
} from './client.js';

/**
 * Build an `ScmDeliveryProvider` whose every operation authenticates as the
 * operator's own GitHub account. Resolves the operator login up front (as the
 * same-host provider does) so committed changes carry the operator's identity;
 * throws if the token resolves to no GitHub user, so a misconfigured token fails
 * before any delivery attempt.
 */
export async function createOperatorDeliveryProvider(
	repo: string,
	token: string,
): Promise<ScmDeliveryProvider> {
	const [owner, repoName] = repo.split('/');
	const login = await getGitHubUserForToken(token);
	if (!login) throw new Error('Could not resolve GitHub identity for the operator token');
	const scoped = <T>(fn: () => Promise<T>): Promise<T> => withGitHubToken(token, fn);
	return {
		commitIdentity: { name: login, email: `${login}@users.noreply.github.com` },
		findPullRequest: (branch) => scoped(() => findOpenPullRequest(owner, repoName, branch)),
		createPullRequest: (input) => scoped(() => createPullRequest(owner, repoName, input)),
		pushBranch: async (cwd, branch, expectedSha) => {
			const authorization = Buffer.from(`x-access-token:${token}`).toString('base64');
			await promisify(execFile)(
				'git',
				[
					'push',
					'--no-verify',
					`https://github.com/${repo}.git`,
					`${expectedSha}:refs/heads/${branch}`,
				],
				{
					cwd,
					env: {
						...process.env,
						GIT_CONFIG_COUNT: '1',
						GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
						GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authorization}`,
					},
				},
			);
		},
		submitReview: () => {
			throw new Error(
				'reviewer submitReview is not available on a worker; it is performed by the server delivery API',
			);
		},
		postComment: (input) => scoped(() => postIdempotentPullRequestComment(owner, repoName, input)),
	};
}
