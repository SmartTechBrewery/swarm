/**
 * The four installation-wide operator SCM tokens the control plane used to read
 * (`SWARM_OPERATOR_GH_TOKEN` and its Azure DevOps, GitLab and Bitbucket siblings),
 * retired by issue #1249.
 *
 * Nothing resolves a credential from them any more: the router reads as each
 * project's reviewer credential and writes for a pull request's author as the
 * stored credential of the operator whose worker produced it
 * (`src/scm/operator-credential.ts`). An upgraded host that still sets one is told
 * once, at startup, that the value is ignored — and nothing else changes. Only the
 * variable's *presence* is checked; its value is never read.
 */

import { logger } from '../lib/logger.js';

/** The retired variable names, in the order the notice lists them. */
export const RETIRED_OPERATOR_TOKEN_ENVS = [
	'SWARM_OPERATOR_GH_TOKEN',
	'SWARM_OPERATOR_AZURE_DEVOPS_TOKEN',
	'SWARM_OPERATOR_GITLAB_TOKEN',
	'SWARM_OPERATOR_BITBUCKET_TOKEN',
] as const;

let noticed = false;

/**
 * Log, once per process, which retired operator token variables this host still
 * sets. Silent when none is set.
 */
export function noticeRetiredOperatorTokens(env: NodeJS.ProcessEnv = process.env): void {
	if (noticed) return;
	noticed = true;
	const set = RETIRED_OPERATOR_TOKEN_ENVS.filter((name) => (env[name] ?? '').trim() !== '');
	if (set.length === 0) return;
	logger.info(
		`${set.join(', ')} ${set.length === 1 ? 'is' : 'are'} set but ignored: the control plane holds no operator SCM token of its own since issue #1249 — it reads as each project's reviewer credential and merges as the operator whose worker produced the pull request. Remove ${set.length === 1 ? 'it' : 'them'} from this host's environment.`,
	);
}

/** @internal Visible for testing only — lets the one-time notice fire again. */
export function _resetRetiredOperatorTokenNotice(): void {
	noticed = false;
}
