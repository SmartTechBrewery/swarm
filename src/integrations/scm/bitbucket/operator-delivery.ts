/**
 * An operator-credential Bitbucket `ScmDeliveryProvider` for a DB-free worker.
 *
 * Unlike `BitbucketSCMIntegration.deliveryProvider`, this builder does not read a
 * project credential: the worker already holds its operator credential. Its source
 * delivery surface mirrors the per-persona provider while leaving reviewer verdicts
 * to the control plane's delivery API.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ScmDeliveryProvider } from '../../../scm/delivery.js';
import {
	bitbucketGitBasicCredential,
	getBitbucketUserForCredential,
	getScopedBitbucketUserEmail,
	withBitbucketCredential,
} from './client.js';
import { findOpenBitbucketPullRequest } from './pull-requests.js';
import { createBitbucketPullRequest, postIdempotentBitbucketPullRequestComment } from './writes.js';

const BITBUCKET_GIT_ORIGIN = 'https://bitbucket.org/';

/** Build a delivery provider authenticated as the Bitbucket worker operator. */
export async function createBitbucketOperatorDeliveryProvider(
	repo: string,
	credential: string,
): Promise<ScmDeliveryProvider> {
	const [workspace, slug] = repo.split('/');
	const nickname = await getBitbucketUserForCredential(credential);
	if (!nickname)
		throw new Error('Could not resolve Bitbucket identity for the operator credential');
	const scoped = <T>(fn: () => Promise<T>): Promise<T> => withBitbucketCredential(credential, fn);
	const email =
		(await scoped(getScopedBitbucketUserEmail)) ?? `${nickname}@users.noreply.bitbucket.org`;

	return {
		commitIdentity: { name: nickname, email },
		findPullRequest: (branch) =>
			scoped(() => findOpenBitbucketPullRequest(workspace, slug, branch)),
		createPullRequest: (input) => scoped(() => createBitbucketPullRequest(workspace, slug, input)),
		pushBranch: async (cwd, branch, expectedSha) => {
			const authorization = Buffer.from(bitbucketGitBasicCredential(credential)).toString('base64');
			await promisify(execFile)(
				'git',
				[
					'push',
					'--no-verify',
					`${BITBUCKET_GIT_ORIGIN}${workspace}/${slug}.git`,
					`${expectedSha}:refs/heads/${branch}`,
				],
				{
					cwd,
					env: {
						...process.env,
						GIT_CONFIG_COUNT: '1',
						GIT_CONFIG_KEY_0: `http.${BITBUCKET_GIT_ORIGIN}.extraheader`,
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
			scoped(() => postIdempotentBitbucketPullRequestComment(workspace, slug, input)),
	};
}
