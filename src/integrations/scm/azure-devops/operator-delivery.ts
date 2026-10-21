/**
 * Azure DevOps' `ScmDeliveryProvider` builders (issue #1089, phase 5/6) — the
 * per-persona seam `AzureDevOpsSCMIntegration.deliveryProvider` returns and the
 * operator-credential one a DB-free worker uses (ADR-003 §2 / ADR-004 §3), the
 * Azure DevOps twin of `../gitlab/operator-delivery.ts`.
 *
 * Both are one builder over a PAT: the per-persona provider hands it the persona's
 * resolved token, a worker hands it the operator token it already holds (it has no
 * secret store to resolve a persona reference against). The only difference is
 * reviewer verdicts, which a worker leaves to the control plane's delivery API.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ScmDeliveryProvider } from '../../../scm/delivery.js';
import {
	AZURE_DEVOPS_API_BASE,
	type AzureDevOpsScopedUser,
	azureRepoCoordinates,
	getScopedAzureDevOpsUser,
	withAzureDevOpsToken,
} from './client.js';
import { findActiveAzureDevOpsPullRequest } from './pull-requests.js';
import {
	createAzureDevOpsPullRequest,
	postIdempotentAzureDevOpsPullRequestThread,
	submitAzureDevOpsReview,
} from './writes.js';

/**
 * The domain of the commit-email placeholder used when the PAT's account names no
 * address. Azure DevOps has no noreply address scheme of its own, so the placeholder
 * lives under the reserved `.invalid` TLD (RFC 2606): it can never be someone
 * else's real address.
 */
export const AZURE_DEVOPS_NOREPLY_EMAIL_DOMAIN = 'users.noreply.azure-devops.invalid';

/**
 * Who a delivery commits as: the account's display name and sign-in address. An
 * account whose connection data names no address — and a service principal, which
 * has none — falls back to `<identity id>@`{@link AZURE_DEVOPS_NOREPLY_EMAIL_DOMAIN}
 * so delivery still commits. The cost matches the other providers' placeholders:
 * Azure Repos links a commit to an account by its email, so the commit keeps the
 * right name but is left unlinked.
 */
export function azureDevOpsCommitIdentity(user: AzureDevOpsScopedUser): {
	name: string;
	email: string;
} {
	return {
		name: user.displayName ?? user.id,
		email: user.email ?? `${user.id}@${AZURE_DEVOPS_NOREPLY_EMAIL_DOMAIN}`,
	};
}

/** The repository's git-over-HTTPS remote, every segment encoded. */
function azureDevOpsGitRemote(repo: string): string {
	const { organization, project, repository } = azureRepoCoordinates(repo);
	return `${AZURE_DEVOPS_API_BASE}/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}`;
}

/**
 * Push exactly `expectedSha` to `branch`. The PAT travels in a git config value,
 * never in argv — an `extraheader` keeps it out of the process listing and any git
 * error echoing the remote — as the same `Basic base64(':' + pat)` header the REST
 * client sends. The refspec pushes the *exact* commit the caller verified rather
 * than whatever HEAD happens to be, which is what makes a resumed delivery safe.
 */
async function pushAzureDevOpsBranch(
	repo: string,
	pat: string,
	cwd: string,
	branch: string,
	expectedSha: string,
): Promise<void> {
	const authorization = Buffer.from(`:${pat}`).toString('base64');
	await promisify(execFile)(
		'git',
		['push', '--no-verify', azureDevOpsGitRemote(repo), `${expectedSha}:refs/heads/${branch}`],
		{
			cwd,
			env: {
				...process.env,
				GIT_CONFIG_COUNT: '1',
				GIT_CONFIG_KEY_0: `http.${AZURE_DEVOPS_API_BASE}/.extraheader`,
				GIT_CONFIG_VALUE_0: `AUTHORIZATION: Basic ${authorization}`,
			},
		},
	);
}

/**
 * A delivery provider authenticated by `pat` for `repo`. The PAT is bound to every
 * operation, so a rotation mid-delivery can't leave one write authenticating as
 * somebody else, and the account it authenticates as is resolved once — it is both
 * the commit identity and, with `reviews`, the identity a verdict's vote is cast as.
 * Without `reviews`, `submitReview` refuses: a worker never casts a verdict.
 */
export async function createAzureDevOpsDeliveryProvider(
	repo: string,
	pat: string,
	options: { reviews: boolean },
): Promise<ScmDeliveryProvider> {
	const scoped = <T>(fn: () => Promise<T>): Promise<T> => withAzureDevOpsToken(pat, fn);
	const { organization } = azureRepoCoordinates(repo);
	const user = await scoped(() => getScopedAzureDevOpsUser(organization));

	return {
		commitIdentity: azureDevOpsCommitIdentity(user),
		findPullRequest: (branch) => scoped(() => findActiveAzureDevOpsPullRequest(repo, branch)),
		createPullRequest: (input) => scoped(() => createAzureDevOpsPullRequest(repo, input)),
		pushBranch: (cwd, branch, expectedSha) =>
			pushAzureDevOpsBranch(repo, pat, cwd, branch, expectedSha),
		submitReview: (input) => {
			if (!options.reviews) {
				throw new Error(
					'reviewer submitReview is not available on a worker; it is performed by the server delivery API',
				);
			}
			return scoped(() =>
				submitAzureDevOpsReview(repo, {
					pullRequestId: input.prNumber,
					verdict: input.verdict,
					body: input.body,
					deliveryId: input.deliveryId,
					reviewerId: user.id,
				}),
			);
		},
		postComment: (input) =>
			scoped(() =>
				postIdempotentAzureDevOpsPullRequestThread(repo, {
					pullRequestId: input.prNumber,
					body: input.body,
					deliveryId: input.deliveryId,
				}),
			),
	};
}

/** Build a delivery provider authenticated as the Azure DevOps worker operator. */
export function createAzureDevOpsOperatorDeliveryProvider(
	repo: string,
	credential: string,
): Promise<ScmDeliveryProvider> {
	return createAzureDevOpsDeliveryProvider(repo, credential, { reviews: false });
}
