/**
 * What each SCM provider calls the **worker operator's own** credential — the
 * secret one machine commits, pushes, opens pull requests and comments as
 * (issue #765). Deliberately not a {@link ScmCredentialRole}: that pair is
 * project-scoped, while this credential is per `(worker, provider)` and lives in
 * its own store.
 *
 * It sits here, beside the contract, because **two** surfaces name it and neither
 * may invent its own wording (issue #807): the worker page's operator-credential
 * card (`dashboard/src/lib/credentials.ts` → `ScmProviderCopy.operatorLabel`) and
 * the `swarm workers set-scm-credential` / `register-and-enroll` prompt
 * (`src/cli/commands/workers.ts`), which used to interpolate the bare provider id
 * and so told an operator nothing about the kind of secret it wanted.
 *
 * Like `./types.ts` this module imports nothing at runtime, which is what lets both
 * of those read it: the dashboard is a browser bundle and the operator CLI is
 * `DATABASE_URL`-free. The SCM registry — the other candidate home, and where a
 * provider's *wiring* belongs — could serve neither (the bundle does not load
 * `src/integrations/entrypoint.js`, and the CLI deliberately does not depend on
 * which provider modules a process imported; see `SCM_PROVIDER_IDS` there).
 */

import { SCM_TYPES, type ScmType } from './types.js';

export interface ScmOperatorCredentialCopy {
	/**
	 * The provider's own name for the credential, spelled out — for a reader who does
	 * not already know what that provider expects, which is the whole reason to name
	 * it. GitHub's "PAT" is Bitbucket's app password and GitLab's access token.
	 */
	credentialType: string;
	/**
	 * The same credential as a heading, shortened for a surface that already names the
	 * provider beside it ("GitHub — Operator PAT"). Held next to
	 * {@link ScmOperatorCredentialCopy.credentialType} rather than in the dashboard so
	 * the short form cannot drift into describing a different secret than the long one.
	 */
	label: string;
}

export const SCM_OPERATOR_CREDENTIAL_COPY: Record<ScmType, ScmOperatorCredentialCopy> = {
	github: { credentialType: 'Personal Access Token', label: 'Operator PAT' },
	bitbucket: { credentialType: 'App Password', label: 'Operator App Password' },
	gitlab: { credentialType: 'Access Token', label: 'Operator Access Token' },
};

/**
 * The copy for a provider id that arrived as a bare string. The operator CLI is
 * handed one by the control plane (`workers.projectScmProvider`, which resolves it
 * through the *server's* registry), so a fourth provider can reach a caller before
 * this catalogue names it. `undefined` then, so the caller says less rather than
 * saying GitHub's words about somebody else's secret.
 */
export function operatorCredentialCopyFor(
	providerId: string,
): ScmOperatorCredentialCopy | undefined {
	return (SCM_TYPES as readonly string[]).includes(providerId)
		? SCM_OPERATOR_CREDENTIAL_COPY[providerId as ScmType]
		: undefined;
}
