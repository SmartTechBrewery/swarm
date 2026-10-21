/**
 * Azure DevOps Services REST 7.x client with `AsyncLocalStorage`-scoped credentials
 * — the Azure DevOps twin of `../gitlab/client.ts` (issue #1089, phase 2/6).
 *
 * The personal access token is never a function argument. `withAzureDevOpsToken(pat,
 * fn)` binds it to the async context for the duration of `fn`, and every request
 * pulls it from that context via `getScopedToken()`. That keeps secrets out of call
 * signatures, stack traces, and logs (ai/CODING_STANDARDS.md "Scope credentials with
 * AsyncLocalStorage") and is what lets the implementer and reviewer personas run
 * concurrently without one leaking into the other's calls.
 *
 * Like GitLab, what gets bound is the **token string**, and requests are built per
 * call over the global `fetch` (Node 22 — no new npm dependency). A PAT goes out as
 * HTTP Basic auth with an **empty username** (`Basic base64(':' + pat)`), which is
 * the only form Azure DevOps documents for it; OAuth and Entra bearer tokens are out
 * of scope, so there is no credential-form branch.
 *
 * **Azure DevOps Services only** (`https://dev.azure.com`). Azure DevOps Server
 * (on-prem) and custom domains would need a base-URL config field this provider
 * does not add.
 *
 * **A rejected PAT does not reliably answer 401.** Depending on the endpoint, Azure
 * DevOps answers a bad or expired token with `203 Non-Authoritative Information` or
 * a `302` to its sign-in page, both carrying an HTML body. Read as data, either one
 * becomes a parse error at best and a silently empty answer at worst, so the client
 * asks `fetch` not to follow redirects and treats any redirect, any `203`, and any
 * non-JSON success body as an authentication failure ({@link AzureDevOpsApiError}
 * with status `401`).
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import { logger } from '../../../lib/logger.js';
import { SCM_REPO_COORDINATES } from '../../../scm/repo-coordinates.js';

/** Azure DevOps Services' REST base — every path below is relative to it. */
export const AZURE_DEVOPS_API_BASE = 'https://dev.azure.com';

/** The REST version every request asks for unless the caller overrides it. */
export const AZURE_DEVOPS_API_VERSION = '7.1';

/** Cap on the number of pages {@link paginateAzureDevOps} will fetch. */
export const MAX_PAGES = 100;

/** Items per page for `$top`/`$skip` pagination. */
export const PAGE_SIZE = 100;

/** The response header continuation-token pagination carries the next cursor in. */
const CONTINUATION_HEADER = 'x-ms-continuationtoken';

/** Cap on how much of a non-JSON error body is echoed into a thrown message. */
const MAX_ERROR_BODY_CHARS = 200;

const tokenStorage = new AsyncLocalStorage<string>();

/**
 * The Azure DevOps PAT bound to the current async context. Throws if called outside
 * a `withAzureDevOpsToken` scope — an operation running without a token in scope is
 * a bug (a missing wrap), not a recoverable condition.
 */
export function getScopedToken(): string {
	const scoped = tokenStorage.getStore();
	if (!scoped) {
		throw new Error(
			'No Azure DevOps token in scope. Wrap the call in withAzureDevOpsToken() (or the SCM integration’s withPersonaCredentials()).',
		);
	}
	return scoped;
}

/** Run `fn` with `pat` bound to the async context. */
export function withAzureDevOpsToken<T>(pat: string, fn: () => Promise<T>): Promise<T> {
	return tokenStorage.run(pat, fn);
}

/**
 * A failed Azure DevOps request. `status` deliberately mirrors Octokit's
 * `RequestError#status`, `BitbucketApiError#status` and `GitLabApiError#status`,
 * which is the field the other adapters' merge-outcome classifiers read — so Azure
 * DevOps' (phase 5/6) can be written the same way instead of inventing a fourth
 * error shape. A rejected credential is always `401` here, whatever Azure actually
 * answered (see the module header); `detail` names what it answered.
 */
export class AzureDevOpsApiError extends Error {
	constructor(
		readonly status: number,
		readonly method: string,
		readonly path: string,
		readonly detail: string,
	) {
		super(`Azure DevOps API ${method} ${path} failed (${status}): ${detail}`);
		this.name = 'AzureDevOpsApiError';
	}
}

/**
 * Azure DevOps' error envelope is `{ message, typeKey }` (`typeKey` names the
 * server-side exception, e.g. `GitRepositoryNotFoundException`). A proxy or sign-in
 * page answers with HTML instead, so fall back to a truncated slice of the raw body
 * rather than losing the diagnostic entirely. The response body never contains the
 * token, so echoing it is safe.
 */
function detailFromErrorBody(body: string): string {
	try {
		const parsed = JSON.parse(body) as { message?: unknown; typeKey?: unknown } | null;
		const message = typeof parsed?.message === 'string' ? parsed.message : '';
		const typeKey = typeof parsed?.typeKey === 'string' ? parsed.typeKey : '';
		if (message !== '') return typeKey !== '' ? `${message} (${typeKey})` : message;
		if (typeKey !== '') return typeKey;
	} catch {
		// Not JSON — fall through to the raw slice below.
	}
	return body.slice(0, MAX_ERROR_BODY_CHARS) || '<empty response body>';
}

function isJsonContentType(response: Response): boolean {
	return /\bjson\b/i.test(response.headers.get('content-type') ?? '');
}

/** The thrown error for a response that is a rejected credential dressed as success. */
function authFailure(method: string, path: string, observed: string): AzureDevOpsApiError {
	return new AzureDevOpsApiError(
		401,
		method,
		path,
		`Azure DevOps did not accept the personal access token (${observed}) — ` +
			'check that the PAT is valid, unexpired, and authorized for this organization',
	);
}

/**
 * Issue one authenticated request and read its body, throwing
 * {@link AzureDevOpsApiError} for a non-2xx and for a rejected credential.
 */
async function azureDevOpsFetch(
	method: string,
	url: string,
	body?: unknown,
): Promise<{ response: Response; data: unknown }> {
	const response = await fetch(url, {
		method,
		headers: {
			authorization: `Basic ${Buffer.from(`:${getScopedToken()}`).toString('base64')}`,
			accept: 'application/json',
			...(body === undefined ? {} : { 'content-type': 'application/json' }),
		},
		redirect: 'manual',
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	// The path, not the full URL: a query string adds nothing an operator can act on
	// and is the one part of a request a future call site could put data in.
	const path = new URL(url).pathname;

	if (response.status >= 300 && response.status < 400) {
		throw authFailure(method, path, `HTTP ${response.status} redirect to a sign-in page`);
	}
	if (!response.ok) {
		throw new AzureDevOpsApiError(
			response.status,
			method,
			path,
			detailFromErrorBody(await response.text()),
		);
	}
	if (response.status === 203) {
		throw authFailure(method, path, 'HTTP 203 Non-Authoritative Information');
	}

	// A 204, or a 200 with an empty body, is an ordinary empty answer; `.json()` on it
	// would throw a bare `SyntaxError` that reads as a client bug.
	if (response.status === 204) return { response, data: undefined };
	const text = await response.text();
	if (text === '') return { response, data: undefined };
	if (!isJsonContentType(response)) {
		const contentType = response.headers.get('content-type') ?? 'no content type';
		throw authFailure(method, path, `HTTP ${response.status} with a ${contentType} body`);
	}
	return { response, data: JSON.parse(text) as unknown };
}

/** Options for {@link azureDevOpsRequest}. */
export interface AzureDevOpsRequestOptions {
	/**
	 * The `api-version` to ask for — {@link AZURE_DEVOPS_API_VERSION} by default, or
	 * `null` to send none, for the unversioned endpoints (`_apis/connectionData`).
	 */
	apiVersion?: string | null;
}

/** The request URL for `path`, with the API version appended unless the path already sets one. */
function requestUrl(path: string, options: AzureDevOpsRequestOptions = {}): URL {
	const url = new URL(`${AZURE_DEVOPS_API_BASE}${path}`);
	const apiVersion =
		options.apiVersion === undefined ? AZURE_DEVOPS_API_VERSION : options.apiVersion;
	if (apiVersion !== null && !url.searchParams.has('api-version')) {
		url.searchParams.set('api-version', apiVersion);
	}
	return url;
}

/** One Azure DevOps request against `path` (relative to {@link AZURE_DEVOPS_API_BASE}). */
export async function azureDevOpsRequest<T>(
	method: string,
	path: string,
	body?: unknown,
	options?: AzureDevOpsRequestOptions,
): Promise<T> {
	const { data } = await azureDevOpsFetch(method, requestUrl(path, options).toString(), body);
	return data as T;
}

/**
 * How a list endpoint pages: `continuation` follows the `x-ms-continuationtoken`
 * response header back as a `continuationToken` query parameter; `skip` walks
 * `$top`/`$skip` offsets until a short page. Azure DevOps uses both, per endpoint.
 */
export type AzureDevOpsPagination = 'continuation' | 'skip';

/**
 * Walk one of Azure DevOps' two pagination styles and flatten every page. A list
 * endpoint answers `{ count, value: [...] }`; a page without a `value` array
 * contributes nothing.
 *
 * Both styles append their cursor to a URL this module builds from a constant base,
 * so — as with GitLab, and unlike Bitbucket's server-supplied `next` URL — no
 * off-origin link is reachable and no same-origin assertion is needed. The
 * "don't trust the server's cursor" guards are the same {@link MAX_PAGES} bound and
 * cycle detection: a continuation token already followed, or a `$skip` page whose
 * contents repeat the previous one (a server ignoring `$skip`), throws rather than
 * looping until the cap.
 */
export async function paginateAzureDevOps<T>(
	path: string,
	style: AzureDevOpsPagination,
): Promise<T[]> {
	return style === 'continuation' ? paginateByContinuation<T>(path) : paginateBySkip<T>(path);
}

/** One page of a list endpoint, plus the response its cursor header is read from. */
async function fetchPage<T>(
	path: string,
	pages: number,
	query: Record<string, string>,
): Promise<{ response: Response; page: T[] }> {
	if (pages >= MAX_PAGES) {
		throw new Error(
			`Azure DevOps pagination exceeded maximum page count of ${MAX_PAGES} for ${path} — refusing to follow an endless cursor`,
		);
	}
	const url = requestUrl(path);
	for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
	const { response, data } = await azureDevOpsFetch('GET', url.toString());
	const value = (data as { value?: unknown } | undefined)?.value;
	return { response, page: Array.isArray(value) ? (value as T[]) : [] };
}

async function paginateByContinuation<T>(path: string): Promise<T[]> {
	const collected: T[] = [];
	const seenTokens = new Set<string>();
	let query: Record<string, string> = {};

	for (let pages = 0; ; pages++) {
		const { response, page } = await fetchPage<T>(path, pages, query);
		collected.push(...page);

		const next = response.headers.get(CONTINUATION_HEADER)?.trim() ?? '';
		if (next === '') return collected;
		if (seenTokens.has(next)) {
			throw new Error(
				`Azure DevOps pagination revisited a continuation token for ${path} — refusing to follow a cyclic ${CONTINUATION_HEADER} cursor`,
			);
		}
		seenTokens.add(next);
		query = { continuationToken: next };
	}
}

async function paginateBySkip<T>(path: string): Promise<T[]> {
	const collected: T[] = [];
	let previousPage: string | null = null;

	for (let pages = 0; ; pages++) {
		const { page } = await fetchPage<T>(path, pages, {
			$top: String(PAGE_SIZE),
			$skip: String(pages * PAGE_SIZE),
		});
		collected.push(...page);

		if (page.length < PAGE_SIZE) return collected;
		const serialized = JSON.stringify(page);
		if (serialized === previousPage) {
			throw new Error(
				`Azure DevOps pagination received the same $skip page twice for ${path} — refusing to follow a cyclic offset`,
			);
		}
		previousPage = serialized;
	}
}

/** The three coordinates Azure Repos addresses a repository by. */
export interface AzureRepoCoordinates {
	organization: string;
	project: string;
	repository: string;
}

/**
 * Split `ProjectConfig.repo` into its Azure DevOps coordinates. Phase 1 made `repo`
 * exactly `organization/project/repository` for an Azure DevOps project
 * (`SCM_REPO_COORDINATES`, `src/scm/repo-coordinates.ts`), already percent-decoded,
 * so a project name may carry a space. Any other shape throws: a two-segment repo
 * reaching this provider is a misconfiguration config validation should have caught,
 * and guessing which segment is missing would address the wrong repository.
 */
export function azureRepoCoordinates(repo: string): AzureRepoCoordinates {
	const segments = repo.split('/');
	const expected = SCM_REPO_COORDINATES['azure-devops'];
	if (segments.length !== expected.segments || segments.some((segment) => segment === '')) {
		throw new Error(
			`Azure DevOps repository '${repo}' is not in the "${expected.format}" form this provider addresses repositories by`,
		);
	}
	const [organization, project, repository] = segments as [string, string, string];
	return { organization, project, repository };
}

/**
 * A repository's Git API path, `/{organization}/{project}/_apis/git/repositories/{repository}`,
 * with every segment URL-encoded — Azure accepts the repository's name in place of its
 * GUID there, which is what lets `repo` stay operator-readable.
 */
export function repositoryApiPath(repo: string): string {
	const { organization, project, repository } = azureRepoCoordinates(repo);
	return `/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repository)}`;
}

/** The `authenticatedUser` fields of `_apis/connectionData` this provider reads. */
interface ConnectionData {
	authenticatedUser?: {
		id?: string;
		providerDisplayName?: string;
		customDisplayName?: string;
		properties?: { Account?: { $value?: string } };
	};
}

/**
 * Who a PAT authenticates as, from the **organization-scoped** connection data
 * endpoint (`https://dev.azure.com/{organization}/_apis/connectionData`).
 *
 * Organization-scoped rather than the organization-less
 * `app.vssps.visualstudio.com/_apis/connectionData`: a PAT is scoped to one
 * organization by default, and the organization-less profile endpoints accept only
 * a PAT created for "all accessible organizations". Every caller has a project — and
 * so an organization — in hand, so the scoped endpoint serves both kinds of PAT. The
 * consequence: the pre-project verify procedure (`scm.verifyAzureDevOpsToken`,
 * `src/api/routers/scm.ts`) takes the organization too, not just the token.
 *
 * The endpoint is unversioned, so no `api-version` is sent.
 */
function readConnectionData(organization: string): Promise<ConnectionData | undefined> {
	return azureDevOpsRequest<ConnectionData | undefined>(
		'GET',
		`/${encodeURIComponent(organization)}/_apis/connectionData`,
		undefined,
		{ apiVersion: null },
	);
}

/**
 * Resolve the identity id a PAT authenticates as in `organization`, or `null` when
 * the token is absent or the lookup fails — the same contract as
 * `getGitLabUserForToken`, for the same reason: one bad credential must not take
 * down persona resolution, and the caller decides whether a missing identity is
 * fatal (`./personas.ts` says yes).
 *
 * The identity is `authenticatedUser.id`, a GUID — the value Azure DevOps' service
 * hook payloads carry as `createdBy.id`, `author.id` and `reviewers[].id`, so a
 * resolved identity and an inbound actor are comparable. Display names are not
 * unique and are for logs only.
 */
export async function getAzureDevOpsUserForToken(
	pat: string | null,
	organization: string,
): Promise<string | null> {
	if (!pat) return null;
	try {
		const data = await withAzureDevOpsToken(pat, () => readConnectionData(organization));
		return data?.authenticatedUser?.id?.trim() || null;
	} catch (err) {
		// `AzureDevOpsApiError` is built from method/path/status/response body only, so
		// this can't leak the token.
		logger.warn('Failed to resolve Azure DevOps identity for token', {
			organization,
			error: String(err),
		});
		return null;
	}
}

/** The account the scoped PAT authenticates as. */
export interface AzureDevOpsScopedUser {
	/** The identity GUID — the persona login ({@link getAzureDevOpsUserForToken}). */
	id: string;
	/** For logs and commit authorship only; not unique. */
	displayName: string | null;
	/** The account's sign-in address, or `null` when connection data names none. */
	email: string | null;
}

/**
 * The account the **scoped** PAT authenticates as in `organization`, for the
 * delivery seam's commit identity (phase 5/6).
 *
 * Two divergences from {@link getAzureDevOpsUserForToken}, which reads the same
 * endpoint for persona identity: the token comes from the async context rather than
 * an argument, and a failure **throws** instead of being logged and flattened to
 * `null` — a delivery must not commit under an identity it failed to resolve.
 */
export async function getScopedAzureDevOpsUser(
	organization: string,
): Promise<AzureDevOpsScopedUser> {
	const user = (await readConnectionData(organization))?.authenticatedUser;
	const id = user?.id?.trim();
	if (!id) {
		throw new Error(
			`Azure DevOps connection data for organization '${organization}' named no authenticated user`,
		);
	}
	const account = user?.properties?.Account?.$value?.trim() ?? '';
	return {
		id,
		displayName: user?.providerDisplayName?.trim() || user?.customDisplayName?.trim() || null,
		email: account.includes('@') ? account : null,
	};
}

/** The `refs/heads/` prefix Azure DevOps reports a repository's default branch under. */
const BRANCH_REF_PREFIX = 'refs/heads/';

/**
 * The branch `repo` reports as its default when read with `pat`, or `null` when it
 * cannot be determined — the pre-project read behind the New Project dialog's Base
 * Branch pre-fill (`src/api/scm-default-branch.ts`, issue #1089 phase 6/6), the twin
 * of `getGitLabRepositoryDefaultBranch`. Like that one it takes the token as an
 * argument, because it runs before a project exists to scope one from.
 *
 * Azure reports the default as a full ref (`refs/heads/main`), so the prefix is
 * stripped to the bare branch name every other provider answers with. A repository
 * with no commits reports no `defaultBranch` at all, which reads as `null`.
 *
 * Failures flatten to `null` rather than throwing: the caller's degraded outcome is
 * "keep the branch already in the field and say the read failed", so a malformed
 * `repo`, a repository the PAT cannot see, a rejected PAT and an unreachable API are
 * all the same ordinary answer. {@link AzureDevOpsApiError} is built from
 * method/path/status/response body only, so the log cannot leak the token.
 */
export async function getAzureDevOpsRepositoryDefaultBranch(
	repo: string,
	pat: string,
): Promise<string | null> {
	try {
		const repository = await withAzureDevOpsToken(pat, () =>
			azureDevOpsRequest<{ defaultBranch?: string } | undefined>('GET', repositoryApiPath(repo)),
		);
		const ref = repository?.defaultBranch?.trim() ?? '';
		const branch = ref.startsWith(BRANCH_REF_PREFIX) ? ref.slice(BRANCH_REF_PREFIX.length) : ref;
		return branch || null;
	} catch (err) {
		logger.warn('Failed to read the Azure DevOps default branch for a repository', {
			repo,
			error: String(err),
		});
		return null;
	}
}
