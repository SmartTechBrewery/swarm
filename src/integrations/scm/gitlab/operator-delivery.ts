/**
 * An operator-credential GitLab `ScmDeliveryProvider` for a DB-free worker
 * (ADR-003 §2 / ADR-004 §3) — the GitLab twin of `../bitbucket/operator-delivery.ts`.
 *
 * Unlike `GitLabSCMIntegration.deliveryProvider`, this builder does not read a
 * project credential: the worker already holds its operator token and has no
 * secret store to resolve a persona reference against. Its source delivery
 * surface mirrors the per-persona provider while leaving reviewer verdicts to
 * the control plane's delivery API.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ScmDeliveryProvider } from '../../../scm/delivery.js';
import { getScopedGitLabUser, withGitLabToken } from './client.js';
import { findOpenGitLabMergeRequest } from './merge-requests.js';
import { createGitLabMergeRequest, postIdempotentGitLabMergeRequestNote } from './writes.js';

/** GitLab.com's git-over-HTTPS host — the push remote and the `extraheader` scope. */
const GITLAB_GIT_ORIGIN = 'https://gitlab.com/';

/**
 * GitLab authenticates a git push with any token form under the reserved
 * `oauth2` user, so — unlike Bitbucket — there is no credential-form branch here
 * (`./client.ts`).
 */
function gitlabGitBasicCredential(token: string): string {
	return `oauth2:${token}`;
}

/** Build a delivery provider authenticated as the GitLab worker operator. */
export async function createGitLabOperatorDeliveryProvider(
	repo: string,
	credential: string,
): Promise<ScmDeliveryProvider> {
	const scoped = <T>(fn: () => Promise<T>): Promise<T> => withGitLabToken(credential, fn);
	const user = await scoped(getScopedGitLabUser);
	if (!user.username)
		throw new Error('Could not resolve GitLab identity for the operator credential');
	const email = user.email ?? `${user.username}@users.noreply.gitlab.com`;

	return {
		commitIdentity: { name: user.username, email },
		findPullRequest: (branch) => scoped(() => findOpenGitLabMergeRequest(repo, branch)),
		createPullRequest: (input) => scoped(() => createGitLabMergeRequest(repo, input)),
		pushBranch: async (cwd, branch, expectedSha) => {
			const authorization = Buffer.from(gitlabGitBasicCredential(credential)).toString('base64');
			await promisify(execFile)(
				'git',
				[
					'push',
					'--no-verify',
					`${GITLAB_GIT_ORIGIN}${repo}.git`,
					`${expectedSha}:refs/heads/${branch}`,
				],
				{
					cwd,
					env: {
						...process.env,
						GIT_CONFIG_COUNT: '1',
						GIT_CONFIG_KEY_0: `http.${GITLAB_GIT_ORIGIN}.extraheader`,
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
		postComment: (input) =>
			scoped(() =>
				postIdempotentGitLabMergeRequestNote(repo, {
					iid: input.prNumber,
					body: input.body,
					deliveryId: input.deliveryId,
				}),
			),
	};
}
