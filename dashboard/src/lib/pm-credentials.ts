/**
 * Pure helpers for the Project Management tab's credential section (issue #537).
 * The stateful query/mutation logic lives in `pm-credentials-panel.tsx`; the
 * projections are factored out here so they can be unit tested without a rendered
 * component (dashboard tests run in a node env — see `dashboard/vitest.config.ts`),
 * mirroring the `board-mapping.ts`/`.test.ts` and `credentials.ts` splits.
 *
 * Everything the screen says about a credential — its name, what it must be able
 * to do, whether it is required — comes from the **provider's own** declaration
 * (`PMProviderManifest.credentialRoles`, served by `projects.credentials.listPm`),
 * not from a per-provider table in the dashboard. That is what keeps this section
 * provider-driven: a second PM provider with an email + API-token pair, or three
 * Trello secrets, renders here with no change to this file.
 */

/**
 * One role from `projects.credentials.listPm` (see `src/api/routers/credentials.ts`).
 * Mirrors that procedure's output shape; the server never sends a plaintext secret,
 * only `isConfigured` plus an opaque `maskedValue`.
 */
export interface PmCredentialEntry {
	role: string;
	label: string;
	description?: string;
	/** The provider's conventional env-var / `swarm config apply` key for this role. */
	envVarKey: string;
	/**
	 * The secret-store key this role currently resolves through — the key the screen
	 * names, since it is the only one an operator setting a value can act on (issue
	 * #630). Never a secret, and never empty: the server falls back to `envVarKey`.
	 */
	referenceKey: string;
	optional: boolean;
	/** Set when the role *is* a shared SCM credential, configured on the Source Control tab. */
	inheritsSharedCredential?: string;
	isConfigured: boolean;
	maskedValue: string;
}

/** The `projects.credentials.listPm` response. */
export interface PmCredentialsView {
	providerId: string;
	providerLabel: string;
	providerRegistered: boolean;
	roles: PmCredentialEntry[];
}

/**
 * Note for a role whose resolved store key is not the provider's declared
 * `envVarKey` — a reference this project configured for itself. Undefined when the
 * two coincide (the common case, left noise-free), and for an inherited role, which
 * this screen does not render at all (see {@link visiblePmRoles}) — the guard stays
 * so the helper cannot describe a credential that is not this tab's to describe.
 */
export function pmRoleKeyOriginNote(entry: PmCredentialEntry): string | undefined {
	if (entry.inheritsSharedCredential) return undefined;
	if (entry.referenceKey === entry.envVarKey) return undefined;
	return `This project resolves it through ${entry.referenceKey}, not the provider's default ${entry.envVarKey}.`;
}

/** Short configured/not-configured status chip text for one role. */
export function pmRoleStatusLabel(entry: PmCredentialEntry): string {
	if (entry.isConfigured) return 'Configured';
	return entry.optional ? 'Not set (optional)' : 'Required';
}

/**
 * Whether a failed discovery query failed *because the PM credential is missing*
 * — the one discovery failure the operator fixes here rather than on the provider's
 * side. Keyed on the tRPC error **code** the API assigns that condition from a typed
 * `MissingPmCredentialError` (`src/api/routers/pm.ts`), not on message text: the
 * wording is the provider's and is free to change, the code is the contract.
 */
export function isMissingPmCredentialError(error: unknown): boolean {
	const code = (error as { data?: { code?: unknown } } | null | undefined)?.data?.code;
	return code === 'PRECONDITION_FAILED';
}

/**
 * The roles that must be configured before the provider can talk to the board at
 * all — what the panel warns about, and the same set whose absence makes board
 * discovery fail with a `PRECONDITION_FAILED` (`src/api/routers/pm.ts`). An
 * inherited role is excluded: it resolves without an entry of its own.
 */
export function missingRequiredPmRoles(view: PmCredentialsView | undefined): PmCredentialEntry[] {
	return (view?.roles ?? []).filter(
		(entry) => !entry.isConfigured && !entry.optional && !entry.inheritsSharedCredential,
	);
}

/**
 * The roles this screen renders. A role that inherits a shared SCM credential *is*
 * that credential, so it is configured — and inspected — on the Source Control tab
 * alone (issue #902): rendering an inert mirror of it here was a second place an
 * operator read a secret they could only change elsewhere, and a wrong value showed
 * as "configured" on a tab that cannot fix it (issue #900). Keyed on the manifest's
 * `inheritsSharedCredential` rather than on the role name, so any future inheriting
 * role drops out the same way.
 */
export function visiblePmRoles(view: PmCredentialsView | undefined): PmCredentialEntry[] {
	return (view?.roles ?? []).filter((entry) => !entry.inheritsSharedCredential);
}
